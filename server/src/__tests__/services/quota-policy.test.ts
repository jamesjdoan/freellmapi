import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { invalidateShadowCounts } from '../../services/ratelimit.js';


import { initDb, getDb } from '../../db/index.js';
import {
  effectiveRouteLimits,
  invalidateQuotaPolicyCache,
  listQuotaPolicies,
  upsertQuotaPolicy,
  deleteQuotaPolicy,
  resolveEffectiveQuotas,
  conservativeMonthlyBudget,
  invalidateSharedPoolCache,
  periodForPolicy,
  type EffectiveQuota,
} from '../../services/quota-policy.js';
import { MINUTE_MS, DAY_MS, resolveQuotaWindow } from '../../services/quota-clock.js';
import { recordLearnedCeiling, getLearnedCeiling } from '../../services/provider-quota.js';

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

  // Third instance of the subject-identity defect (ADR F8): two relays behind
  // platform='custom' with the same model id were one policy subject, so no
  // limit could apply to one without applying to the other.
  it('lets a per-endpoint policy override the platform-wide one', () => {
    upsertQuotaPolicy({
      platform: 'custom', modelId: null, endpointScope: null, scope: 'provider_account', metric: 'requests',
      limit: 1000, periodKind: 'calendar_day', periodMs: null, timezone: 'UTC', anchorDay: null,
    });
    upsertQuotaPolicy({
      platform: 'custom', modelId: null, endpointScope: 'custom:alpha', scope: 'provider_account', metric: 'requests',
      limit: 25, periodKind: 'calendar_day', periodMs: null, timezone: 'UTC', anchorDay: null,
    });

    const alpha = axis(resolveEffectiveQuotas('custom', 'm', Date.now(), 'custom:alpha'), 'requests', 'calendar_day');
    const beta = axis(resolveEffectiveQuotas('custom', 'm', Date.now(), 'custom:beta'), 'requests', 'calendar_day');

    expect(alpha?.limit).toBe(25);
    // The other relay is untouched by a limit that names its sibling.
    expect(beta?.limit).toBe(1000);
  });

  it('keeps both policies rather than treating them as one subject', () => {
    upsertQuotaPolicy({
      platform: 'custom', modelId: null, endpointScope: 'custom:alpha', scope: 'provider_account', metric: 'requests',
      limit: 25, periodKind: 'calendar_day', periodMs: null, timezone: 'UTC', anchorDay: null,
    });
    upsertQuotaPolicy({
      platform: 'custom', modelId: null, endpointScope: 'custom:beta', scope: 'provider_account', metric: 'requests',
      limit: 900, periodKind: 'calendar_day', periodMs: null, timezone: 'UTC', anchorDay: null,
    });
    // Before the endpoint column these collided on the unique index and the
    // second silently replaced the first.
    expect(listQuotaPolicies('custom')).toHaveLength(2);
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

  it('describes a refilling bucket: capacity, and one unit back every interval', () => {
    // Groq measured 2026-09-12: `reset` grows 86.4s per request spent and
    // `remaining` never climbs while idle — 86,400 ÷ 1,000. A rolling day would
    // say "nothing back for 24h" after a burst; the bucket says 86 seconds, and
    // the difference decides whether the route is usable this afternoon.
    upsertQuotaPolicy({
      platform: 'groq', modelId: 'openai/gpt-oss-20b', endpointScope: null, scope: 'model',
      metric: 'requests', limit: 1000, periodKind: 'bucket', periodMs: 86_400,
      timezone: null, anchorDay: null,
    });
    invalidateQuotaPolicyCache();

    const policy = listQuotaPolicies('groq').find(p => p.periodKind === 'bucket')!;
    const period = periodForPolicy(policy);
    expect(period).toEqual({ kind: 'bucket', refillMs: 86_400, capacity: 1000 });

    const now = Date.UTC(2026, 8, 12, 12, 0, 0);
    const window = resolveQuotaWindow(period, now);
    // One unit back in 86.4s, and usage counted over a full refill.
    expect(window.resetAtMs).toBe(now + 86_400);
    expect(window.periodStartMs).toBe(now - 86_400 * 1000);
  });

  it('holds a per-minute and a per-day limit for one subject at once', () => {
    // Google states both in the same refusal, on the same metric, telling them
    // apart only by value: `limit: 5` per minute and `limit: 20` per day for
    // gemini-3.8-flash. Keyed without the period, writing the second silently
    // replaced the first and the limit that binds intraday disappeared.
    const base = {
      platform: 'google', modelId: 'gemini-3.8-flash', scope: 'model' as const,
      metric: 'requests' as const, timezone: 'UTC', anchorDay: null,
    };
    upsertQuotaPolicy({ ...base, limit: 5, periodKind: 'rolling', periodMs: 60_000 });
    upsertQuotaPolicy({ ...base, limit: 20, periodKind: 'calendar_day', periodMs: null });

    const policies = listQuotaPolicies('google');
    expect(policies.map(p => [p.periodKind, p.limit]).sort()).toEqual([['calendar_day', 20], ['rolling', 5]]);
  });

  it('still replaces a policy for the same subject AND period', () => {
    const base = {
      platform: 'google', modelId: 'gemini-3.8-flash', scope: 'model' as const,
      metric: 'requests' as const, periodKind: 'rolling' as const, periodMs: 60_000,
      timezone: 'UTC', anchorDay: null,
    };
    upsertQuotaPolicy({ ...base, limit: 5 });
    upsertQuotaPolicy({ ...base, limit: 10 });

    const policies = listQuotaPolicies('google');
    expect(policies).toHaveLength(1);
    expect(policies[0]!.limit).toBe(10);
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

// "For Zen we keep count and track and work out the details": some providers
// publish nothing and only ever say no. The point at which they refused is the
// only evidence of a ceiling there is.
describe('the limits the router gates on', () => {
  beforeEach(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
    getDb().prepare('DELETE FROM quota_policy').run();
    invalidateQuotaPolicyCache();
  });

  const addModel = (rpm: number | null, rpd: number | null) => {
    getDb().prepare(`INSERT INTO models (platform, model_id, display_name, intelligence_rank, speed_rank,
                                         size_label, context_window, rpm_limit, rpd_limit, enabled, supports_tools, supports_vision)
                     VALUES ('google', 'gemini-3.5-flash-lite', 'Flash-Lite', 1, 1, 'Large', 1048576, ?, ?, 1, 1, 1)`)
      .run(rpm, rpd);
  };

  it('prefers a measured operator limit over the shipped catalogue column', () => {
    // The reason this function exists. The catalogue ships 20/day; Google was
    // observed allowing 500 and that was recorded as an operator policy. Gating
    // on the column throttled the route to a number already proven wrong.
    addModel(15, 20);
    upsertQuotaPolicy({
      platform: 'google', modelId: 'gemini-3.5-flash-lite', endpointScope: null, scope: 'model',
      metric: 'requests', limit: 500, periodKind: 'calendar_day', periodMs: null, timezone: 'UTC', anchorDay: null,
    });
    invalidateQuotaPolicyCache();

    expect(effectiveRouteLimits('google', 'gemini-3.5-flash-lite').rpd).toBe(500);
  });

  it('lets a measured refill rate outrank the catalogue day column', () => {
    // Groq, measured 2026-09-12: reset grows 86.4s per request spent, so its
    // 1,000 is a bucket refilling continuously — not 1,000 before midnight.
    // The catalogue ships 500/day for the same model; the measurement wins.
    // The model ships in the seeded catalogue, so set its columns rather than
    // inserting beside it — the point is a catalogue row losing to a measurement.
    getDb().prepare(`UPDATE models SET rpm_limit = 30, rpd_limit = 500 WHERE platform = 'groq' AND model_id = 'openai/gpt-oss-20b'`).run();
    upsertQuotaPolicy({
      platform: 'groq', modelId: 'openai/gpt-oss-20b', endpointScope: null, scope: 'model',
      metric: 'requests', limit: 1000, periodKind: 'bucket', periodMs: 86_400,
      timezone: null, anchorDay: null, source: 'provider_api', confidence: 0.95,
    });

    expect(effectiveRouteLimits('groq', 'openai/gpt-oss-20b').rpd).toBe(1000);
  });

  it('does not read a bucket as a limit on some other window', () => {
    // 1,000 at one per 86.4s is a day's worth. It says nothing about a minute,
    // and reading it as one would hand a burst 1,000 slots it does not have.
    // The model ships in the seeded catalogue, so set its columns rather than
    // inserting beside it — the point is a catalogue row losing to a measurement.
    getDb().prepare(`UPDATE models SET rpm_limit = 30, rpd_limit = 500 WHERE platform = 'groq' AND model_id = 'openai/gpt-oss-20b'`).run();
    upsertQuotaPolicy({
      platform: 'groq', modelId: 'openai/gpt-oss-20b', endpointScope: null, scope: 'model',
      metric: 'requests', limit: 1000, periodKind: 'bucket', periodMs: 86_400,
      timezone: null, anchorDay: null, source: 'provider_api', confidence: 0.95,
    });

    expect(effectiveRouteLimits('groq', 'openai/gpt-oss-20b').rpm).toBe(30);
  });

  it('keeps the catalogue limit when no policy speaks to it', () => {
    addModel(15, 20);
    const limits = effectiveRouteLimits('google', 'gemini-3.5-flash-lite');
    expect([limits.rpm, limits.rpd]).toEqual([15, 20]);
  });

  it('falls back to the row rather than reporting no limit at all', () => {
    // A resolver that cannot answer must not turn a metered route into an
    // unmetered one: silence here would remove the gate entirely.
    const limits = effectiveRouteLimits('google', 'not-in-catalogue', { rpm: 5, rpd: 20 });
    expect([limits.rpm, limits.rpd]).toEqual([5, 20]);
  });
});

describe('learned ceilings from refusals', () => {
  beforeEach(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
    getDb().prepare('DELETE FROM quota_policy').run();
    getDb().prepare('DELETE FROM provider_quota_observations').run();
  });

  it('surfaces a ceiling inferred from a 429 when nothing else is known', () => {
    recordLearnedCeiling({ platform: 'opencode', keyId: 1, quotaPoolKey: 'opencode::promo', observedRequests: 120 });

    const quota = resolveEffectiveQuotas('opencode', null)
      .find(q => q.metric === 'requests' && q.source === 'learned_429');
    expect(quota?.limit).toBe(120);
    // Weak evidence, and labelled as such.
    expect(quota?.confidence).toBeCloseTo(0.3, 2);
  });

  it('takes the highest refusal, not the most recent', () => {
    // A lower refusal is explained by a narrower window inside the same pool;
    // the largest observed spend is the tightest honest lower bound.
    recordLearnedCeiling({ platform: 'opencode', keyId: 1, quotaPoolKey: 'opencode::promo', observedRequests: 120 });
    recordLearnedCeiling({ platform: 'opencode', keyId: 1, quotaPoolKey: 'opencode::promo', observedRequests: 45 });

    expect(getLearnedCeiling('opencode')?.limit).toBe(120);
  });

  it('never outranks a stated limit', () => {
    recordLearnedCeiling({ platform: 'opencode', keyId: 1, quotaPoolKey: 'opencode::promo', observedRequests: 120 });
    upsertQuotaPolicy({
      platform: 'opencode', modelId: null, endpointScope: null, scope: 'provider_account', metric: 'requests',
      limit: 500, periodKind: 'calendar_day', periodMs: null, timezone: 'UTC', anchorDay: null,
    });

    const daily = resolveEffectiveQuotas('opencode', null).find(q => q.period.kind === 'calendar_day');
    expect(daily?.limit).toBe(500);
    expect(daily?.source).toBe('operator');
  });

  it('ignores a refusal on an untouched window', () => {
    // Refused at zero spend means the ceiling is somewhere else entirely — a
    // minute window, another key, a stale cooldown. Recording 0 would claim a
    // limit of nothing.
    recordLearnedCeiling({ platform: 'opencode', keyId: 1, quotaPoolKey: 'opencode::promo', observedRequests: 0 });
    expect(getLearnedCeiling('opencode')).toBeNull();
  });
});

/**
 * `models.monthly_token_budget` is prose: real values are '~10-20M', '~5-10M',
 * 'unlimited'. Without reading it, Ollama Cloud had no numeric quota at all and
 * shadow scoring pinned it at UNKNOWN_HEADROOM on every request — it could
 * never be seen filling up, which for a monthly pool is the one thing worth
 * knowing. Observed as 23 of 23 disagreements on one logical model.
 */
describe('documented monthly token pools', () => {
  it('reads the low end of a range, not the high one', () => {
    // profiles.ts takes the MAX for ranking. As a ceiling that over-promises:
    // claiming 20M when the allowance may be 10M reports headroom that does
    // not exist.
    expect(conservativeMonthlyBudget('~10-20M')).toBe(10_000_000);
    expect(conservativeMonthlyBudget('~5-10M')).toBe(5_000_000);
  });

  it('handles single values and other magnitudes', () => {
    expect(conservativeMonthlyBudget('500K')).toBe(500_000);
    expect(conservativeMonthlyBudget('2B')).toBe(2_000_000_000);
    expect(conservativeMonthlyBudget('750000')).toBe(750_000);
  });

  it('declines to turn "unlimited" into a limit', () => {
    // An unbounded ceiling makes headroom permanently 100%, which is worse
    // than having no opinion.
    expect(conservativeMonthlyBudget('unlimited')).toBeNull();
    expect(conservativeMonthlyBudget('∞')).toBeNull();
  });

  it('ignores trailing notes in parentheses', () => {
    expect(conservativeMonthlyBudget('~10-20M (shared across models)')).toBe(10_000_000);
  });

  it('returns null for anything it cannot read', () => {
    for (const raw of [null, undefined, '', 'see docs', 'n/a']) {
      expect(conservativeMonthlyBudget(raw)).toBeNull();
    }
  });

  it('becomes a monthly quota the scorer can actually use', () => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
    getDb().prepare(`
      INSERT INTO models (platform, model_id, display_name, intelligence_rank, speed_rank, monthly_token_budget, enabled)
      VALUES ('ollama', 'monthly-pool-test', 'Monthly Pool Test', 50, 50, '~10-20M', 1)
    `).run();
    const quotas = resolveEffectiveQuotas('ollama', 'monthly-pool-test', Date.parse('2026-03-10T05:00:00Z'));
    const monthly = quotas.find(q => q.metric === 'total_tokens' && q.period.kind === 'calendar_month');
    expect(monthly).toBeDefined();
    expect(monthly!.limit).toBe(10_000_000);
    // A range is not a measurement, and must never outrank one.
    expect(monthly!.confidence).toBeLessThan(0.4);
  });
});

/**
 * Ollama Cloud bills ONE dollar balance at per-model token rates
 * (ollama.com/pricing), so the catalogue's six per-model budgets are six
 * descriptions of one allowance, not six allowances. Cross-checking those
 * ranges against the published rates puts them all at roughly $3-5 of starter
 * credit, which is what makes them the same pool.
 *
 * Tokens are not additive across models priced differently — 1M
 * nemotron-3-ultra tokens cost about eight times 1M gpt-oss:20b tokens — so
 * the only correct reduction is the sum of per-model fractions.
 */
describe('a credit pool shared across models', () => {
  beforeEach(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
    // 'testpool' has no seeded catalogue rows, so nothing FK-bound to unpick —
    // deleting seeded models violates fallback_config and profile_models.
    getDb().prepare('DELETE FROM rate_limit_usage').run();
    invalidateSharedPoolCache();
    invalidateShadowCounts();
  });

  function seedModel(modelId: string, budget: string): void {
    getDb().prepare(`
      INSERT INTO models (platform, model_id, display_name, intelligence_rank, speed_rank, monthly_token_budget, enabled)
      VALUES ('testpool', ?, ?, 50, 50, ?, 1)
    `).run(modelId, modelId, budget);
  }

  function spendTokens(modelId: string, tokens: number): void {
    getDb().prepare(`
      INSERT INTO rate_limit_usage (platform, model_id, key_id, kind, tokens, created_at_ms, created_at)
      VALUES ('testpool', ?, 1, 'tokens', ?, ?, datetime('now'))
    `).run(modelId, tokens, Date.now());
    invalidateSharedPoolCache();
    invalidateShadowCounts();
  }

  // The monthly quota carries the POOL's consumption, expressed in this
  // model's tokens — one allowance, several descriptions of it.
  const poolOf = (modelId: string) => resolveEffectiveQuotas('testpool', modelId, Date.now())
    .find(q => q.metric === 'total_tokens' && q.period.kind === 'calendar_month');

  it('charges one model’s spend against the pool every model draws on', () => {
    seedModel('cheap-model', '~20-30M');   // 20M low end
    seedModel('dear-model', '~5-10M');     //  5M low end
    // Half of the cheap model's budget is half the pool.
    spendTokens('cheap-model', 10_000_000);

    const pool = poolOf('dear-model');
    expect(pool).toBeDefined();
    // The dear model has spent nothing itself, yet only half the pool is left —
    // which is the whole point.
    expect(pool!.derivedUsed! / pool!.limit).toBeCloseTo(0.5, 2);
  });

  it('sums fractions rather than raw tokens', () => {
    seedModel('cheap-model', '~20-30M');
    seedModel('dear-model', '~5-10M');
    spendTokens('cheap-model', 5_000_000);   // 0.25 of the pool
    spendTokens('dear-model', 1_000_000);    // 0.20 of the pool
    // Raw tokens would say 6M of 25M = 24%. Fractions say 45%, and the dear
    // model's tokens are the expensive ones.
    const cheap = poolOf('cheap-model')!;
    expect(cheap.derivedUsed! / cheap.limit).toBeCloseTo(0.45, 2);
  });

  it('never reports more than the pool as spent', () => {
    seedModel('cheap-model', '~20-30M');
    seedModel('dear-model', '~5-10M');
    spendTokens('cheap-model', 40_000_000);
    spendTokens('dear-model', 40_000_000);
    const capped = poolOf('cheap-model')!;
    expect(capped.derivedUsed).toBe(capped.limit);
  });

  it('leaves a single budgeted model to the ordinary counter', () => {
    // One model is not a pool worth reducing: derivedUsed stays null and the
    // generic per-model count applies, which says the same thing.
    seedModel('only-model', '~10-20M');
    const quota = poolOf('only-model');
    expect(quota).toBeDefined();
    expect(quota!.derivedUsed).toBeNull();
  });

  it('produces no monthly quota when no model documents a budget', () => {
    seedModel('a', '');
    seedModel('b', '');
    expect(poolOf('a')).toBeUndefined();
  });
});
