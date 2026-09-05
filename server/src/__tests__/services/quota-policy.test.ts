import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { initDb, getDb } from '../../db/index.js';
import {
  listQuotaPolicies,
  upsertQuotaPolicy,
  deleteQuotaPolicy,
  resolveEffectiveQuotas,
  periodForPolicy,
  type EffectiveQuota,
} from '../../services/quota-policy.js';
import { MINUTE_MS, DAY_MS } from '../../services/quota-clock.js';

// The resolver's whole job is ranking four sources that disagree. These pin the
// ranking and the axis separation, not the plumbing.

const CAP_ENV = 'PROVIDER_DAILY_REQUEST_CAP_GROQ';

function seedModel(platform: string, modelId: string, limits: Partial<Record<'rpm' | 'rpd' | 'tpm' | 'tpd', number>>): void {
  getDb().prepare(`
    INSERT INTO models (platform, model_id, display_name, intelligence_rank, speed_rank, size_label,
      rpm_limit, rpd_limit, tpm_limit, tpd_limit, monthly_token_budget, context_window, enabled)
    VALUES (?, ?, ?, 1, 1, 'Small', ?, ?, ?, ?, '~1M', 128000, 1)
  `).run(platform, modelId, `Test ${modelId}`, limits.rpm ?? null, limits.rpd ?? null, limits.tpm ?? null, limits.tpd ?? null);
}

function observeHeader(platform: string, metric: string, limit: number, resetAt: string | null): void {
  getDb().prepare(`
    INSERT INTO provider_quota_state
      (platform, key_id, quota_pool_key, metric, limit_value, remaining_value, reset_at, reset_strategy, source, confidence)
    VALUES (?, 1, ?, ?, ?, NULL, ?, 'provider_reported', 'header', 1.0)
  `).run(platform, `${platform}::account`, metric, limit, resetAt);
}

const axis = (quotas: EffectiveQuota[], metric: string, kind: string): EffectiveQuota | undefined =>
  quotas.find(q => q.metric === metric && q.period.kind === kind);

describe('quota-policy resolver', () => {
  beforeEach(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    delete process.env[CAP_ENV];
    initDb(':memory:');
    // fallback_config and profile_models reference models — same order the
    // routing tests use.
    getDb().prepare('DELETE FROM fallback_config').run();
    getDb().prepare('DELETE FROM profile_models').run();
    getDb().prepare('DELETE FROM models').run();
    getDb().prepare('DELETE FROM quota_policy').run();
    getDb().prepare('DELETE FROM provider_quota_state').run();
  });

  afterEach(() => {
    delete process.env[CAP_ENV];
  });

  it('reports every binding axis separately, not one blended number', () => {
    seedModel('groq', 'gpt-oss-120b', { rpm: 30, rpd: 1000, tpm: 8000 });

    const quotas = resolveEffectiveQuotas('groq', 'gpt-oss-120b');

    // Requests-per-minute and requests-per-day are different limits that bind
    // at the same time; collapsing them is how a panel reads 999/1000 while
    // the request is actually being rejected on tokens.
    expect(axis(quotas, 'requests', 'rolling')).toBeDefined();
    expect(quotas.filter(q => q.metric === 'requests')).toHaveLength(2);
    expect(quotas.find(q => q.metric === 'total_tokens')?.limit).toBe(8000);
  });

  it('prefers an operator policy over the shipped catalog default', () => {
    seedModel('openrouter', 'some/model:free', { rpd: 1000 });
    upsertQuotaPolicy({
      platform: 'openrouter', modelId: null, scope: 'provider_account', metric: 'requests',
      limit: 50, periodKind: 'calendar_day', periodMs: null, timezone: 'Europe/London', anchorDay: null,
    });

    const quotas = resolveEffectiveQuotas('openrouter', 'some/model:free');
    const daily = axis(quotas, 'requests', 'calendar_day');

    // The operator knows their account; the catalog shipped a guess.
    expect(daily?.limit).toBe(50);
    expect(daily?.source).toBe('operator');
    // The catalog's rolling-day limit is a different axis and survives.
    expect(axis(quotas, 'requests', 'rolling')?.limit).toBe(1000);
  });

  it('lets a measured provider header outrank the operator on the same axis', () => {
    upsertQuotaPolicy({
      platform: 'groq', modelId: null, scope: 'provider_account', metric: 'requests',
      limit: 50, periodKind: 'calendar_day', periodMs: null, timezone: 'UTC', anchorDay: null,
    });
    const resetAt = new Date(Date.now() + 3_600_000).toISOString();
    observeHeader('groq', 'requests', 1000, resetAt);

    const quotas = resolveEffectiveQuotas('groq', null);
    const reported = quotas.find(q => q.source === 'provider_header');

    expect(reported?.limit).toBe(1000);
    // The provider stated its own reset, which beats any period we model.
    expect(reported?.period.kind).toBe('provider_reported');
    expect(reported?.window.resetAtMs).toBe(Date.parse(resetAt));
  });

  it('ranks the env provider cap below everything that is declared', () => {
    process.env[CAP_ENV] = '2000';
    upsertQuotaPolicy({
      platform: 'groq', modelId: null, scope: 'provider_account', metric: 'requests',
      limit: 50, periodKind: 'calendar_day', periodMs: null, timezone: 'UTC', anchorDay: null,
    });

    const daily = axis(resolveEffectiveQuotas('groq', null), 'requests', 'calendar_day');
    expect(daily?.limit).toBe(50);
    expect(daily?.source).toBe('operator');
  });

  it('uses the env cap when nothing better claims the axis', () => {
    process.env[CAP_ENV] = '2000';
    const daily = axis(resolveEffectiveQuotas('groq', null), 'requests', 'calendar_day');
    expect(daily?.limit).toBe(2000);
    expect(daily?.source).toBe('provider_cap_env');
  });

  it('applies a platform-wide policy to a model that has no policy of its own', () => {
    upsertQuotaPolicy({
      platform: 'openrouter', modelId: null, scope: 'provider_account', metric: 'requests',
      limit: 50, periodKind: 'calendar_day', periodMs: null, timezone: 'UTC', anchorDay: null,
    });
    const quotas = resolveEffectiveQuotas('openrouter', 'never/seen-before');
    expect(axis(quotas, 'requests', 'calendar_day')?.limit).toBe(50);
  });

  it('ignores a per-model policy belonging to a different model', () => {
    upsertQuotaPolicy({
      platform: 'groq', modelId: 'other-model', scope: 'model', metric: 'requests',
      limit: 7, periodKind: 'calendar_day', periodMs: null, timezone: 'UTC', anchorDay: null,
    });
    expect(resolveEffectiveQuotas('groq', 'gpt-oss-120b')).toHaveLength(0);
  });

  it('ignores a disabled policy', () => {
    upsertQuotaPolicy({
      platform: 'groq', modelId: null, scope: 'provider_account', metric: 'requests',
      limit: 50, periodKind: 'calendar_day', periodMs: null, timezone: 'UTC', anchorDay: null,
      enabled: false,
    });
    expect(resolveEffectiveQuotas('groq', null)).toHaveLength(0);
  });

  it('carries the policy timezone into the resolved window', () => {
    upsertQuotaPolicy({
      platform: 'google', modelId: null, scope: 'provider_account', metric: 'requests',
      limit: 20, periodKind: 'calendar_day', periodMs: null, timezone: 'America/Los_Angeles', anchorDay: null,
    });
    const now = Date.parse('2026-03-10T05:00:00Z');
    const daily = axis(resolveEffectiveQuotas('google', null, now), 'requests', 'calendar_day');

    // Pacific midnight, not UTC midnight — the reason the clock exists.
    expect(new Date(daily!.window.resetAtMs!).toISOString()).toBe('2026-03-10T07:00:00.000Z');
  });
});

describe('quota-policy storage', () => {
  beforeEach(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
    getDb().prepare('DELETE FROM quota_policy').run();
  });

  it('replaces rather than duplicates a policy for the same subject', () => {
    const base = {
      platform: 'openrouter', modelId: null, scope: 'provider_account' as const, metric: 'requests' as const,
      periodKind: 'calendar_day' as const, periodMs: null, timezone: 'UTC', anchorDay: null,
    };
    upsertQuotaPolicy({ ...base, limit: 50 });
    upsertQuotaPolicy({ ...base, limit: 1000 });

    const policies = listQuotaPolicies('openrouter');
    // Editing the account allowance means changing the number, not accruing a
    // second opinion the resolver would then have to arbitrate.
    expect(policies).toHaveLength(1);
    expect(policies[0]!.limit).toBe(1000);
  });

  it('rejects a limit the schema forbids', () => {
    expect(() => upsertQuotaPolicy({
      platform: 'groq', modelId: null, scope: 'provider_account', metric: 'requests',
      limit: 0, periodKind: 'calendar_day', periodMs: null, timezone: 'UTC', anchorDay: null,
    })).toThrow();
  });

  it('deletes by id and reports a miss', () => {
    const policy = upsertQuotaPolicy({
      platform: 'groq', modelId: null, scope: 'provider_account', metric: 'requests',
      limit: 50, periodKind: 'calendar_day', periodMs: null, timezone: 'UTC', anchorDay: null,
    });
    expect(deleteQuotaPolicy(policy.id)).toBe(true);
    expect(deleteQuotaPolicy(policy.id)).toBe(false);
  });

  it('defaults an absent timezone to UTC rather than the host zone', () => {
    const period = periodForPolicy({ periodKind: 'calendar_day', periodMs: null, timezone: null, anchorDay: null });
    expect(period).toEqual({ kind: 'calendar_day', timezone: 'UTC' });
  });

  it('defaults a rolling policy width to a day and a cycle anchor to the 1st', () => {
    expect(periodForPolicy({ periodKind: 'rolling', periodMs: null, timezone: null, anchorDay: null }))
      .toEqual({ kind: 'rolling', windowMs: DAY_MS });
    expect(periodForPolicy({ periodKind: 'rolling', periodMs: MINUTE_MS, timezone: null, anchorDay: null }))
      .toEqual({ kind: 'rolling', windowMs: MINUTE_MS });
    expect(periodForPolicy({ periodKind: 'billing_cycle', periodMs: null, timezone: 'UTC', anchorDay: null }))
      .toEqual({ kind: 'billing_cycle', timezone: 'UTC', anchorDay: 1 });
  });
});
