import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { initDb, getDb } from '../../db/index.js';
import { upsertQuotaPolicy, invalidateQuotaPolicyCache } from '../../services/quota-policy.js';
import { getQuotaForecast, getProviderQuotaOverview, invalidateQuotaInference } from '../../services/quota-forecast.js';

function insertState(row: {
  platform: string;
  keyId: number;
  pool: string;
  metric: string;
  limit: number | null;
  remaining: number | null;
  resetAt: string | null;
}) {
  getDb().prepare(`
    INSERT INTO provider_quota_state
      (platform, key_id, quota_pool_key, metric, limit_value, remaining_value, reset_at, observed_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))
  `).run(row.platform, row.keyId, row.pool, row.metric, row.limit, row.remaining, row.resetAt);
}

const future = () => new Date(Date.now() + 12 * 3600 * 1000).toISOString(); // 12h ahead → within today

describe('quota-forecast: daily balance aggregation (#1104)', () => {
  beforeAll(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
  });

  beforeEach(() => {
    getDb().prepare('DELETE FROM provider_quota_state').run();
  });

  it('reports used/remaining/pct/reset for a request pool with a known limit', () => {
    insertState({ platform: 'groq', keyId: 1, pool: 'groq::account', metric: 'requests', limit: 100, remaining: 60, resetAt: future() });

    const forecast = getQuotaForecast();
    expect(forecast).toHaveLength(1);
    const e = forecast[0];
    expect(e.platform).toBe('groq');
    expect(e.pool).toBe('groq::account');
    expect(e.used).toBe(40);
    expect(e.remaining).toBe(60);
    expect(e.limit).toBe(100);
    expect(e.remaining_pct).toBe(60);
    expect(e.low_balance).toBe(false);
    expect(e.seconds_until_reset).toBeGreaterThan(0);
  });

  it('flags low_balance below the 10% threshold', () => {
    insertState({ platform: 'openai', keyId: 1, pool: 'openai::account', metric: 'requests', limit: 100, remaining: 8, resetAt: future() });

    const e = getQuotaForecast()[0];
    expect(e.remaining_pct).toBe(8);
    expect(e.low_balance).toBe(true);
  });

  it('flags low_balance on the absolute floor even when pct looks fine', () => {
    insertState({ platform: 'openrouter', keyId: 1, pool: 'openrouter::free', metric: 'requests', limit: 10000, remaining: 15, resetAt: future() });

    const e = getQuotaForecast()[0];
    expect(e.remaining_pct).toBe(0); // 15/10000 rounds to 0
    expect(e.low_balance).toBe(true);
  });

  it('dedupes multi-key shared pools to the tightest remaining', () => {
    insertState({ platform: 'groq', keyId: 1, pool: 'groq::account', metric: 'requests', limit: 100, remaining: 90, resetAt: future() });
    insertState({ platform: 'groq', keyId: 2, pool: 'groq::account', metric: 'requests', limit: 100, remaining: 20, resetAt: future() });

    const forecast = getQuotaForecast();
    expect(forecast).toHaveLength(1);
    expect(forecast[0].remaining).toBe(20); // tightest wins
    // 20 of 100 is a fifth of the window, and 100 is below the absolute
    // floor's minimum, so nothing here is low.
    expect(forecast[0].low_balance).toBe(false);
  });

  it('does not apply the absolute floor to a small window', () => {
    // A 30/day tier with 25 left has five sixths of its window: the absolute
    // floor of 20 would call that low, which is the bug this guards.
    insertState({ platform: 'cerebras', keyId: 1, pool: 'cerebras::account', metric: 'requests', limit: 30, remaining: 25, resetAt: future() });

    const e = getQuotaForecast()[0];
    expect(e.remaining_pct).toBe(83);
    expect(e.low_balance).toBe(false);
  });

  it('still warns on a small window once the percentage rule bites', () => {
    insertState({ platform: 'cerebras', keyId: 1, pool: 'cerebras::account', metric: 'requests', limit: 30, remaining: 2, resetAt: future() });

    expect(getQuotaForecast()[0].low_balance).toBe(true);
  });

  it('leaves used null when the provider reported no remaining', () => {
    insertState({ platform: 'groq', keyId: 1, pool: 'groq::account', metric: 'requests', limit: 100, remaining: null, resetAt: future() });

    const e = getQuotaForecast()[0];
    expect(e.used).toBeNull();
    expect(e.remaining).toBeNull();
    expect(e.remaining_pct).toBeNull();
    expect(e.low_balance).toBe(false);
  });

  it('keys the dedupe on the pool alone, which already names its platform', () => {
    insertState({ platform: 'groq', keyId: 1, pool: 'groq::account', metric: 'requests', limit: 1000, remaining: 900, resetAt: future() });
    insertState({ platform: 'groq', keyId: 2, pool: 'groq::batch', metric: 'requests', limit: 1000, remaining: 800, resetAt: future() });

    const pools = getQuotaForecast().map(e => e.pool);
    expect(pools).toContain('groq::account');
    expect(pools).toContain('groq::batch');
  });

  it('ignores non-request metrics and unknown limits', () => {
    insertState({ platform: 'groq', keyId: 1, pool: 'groq::account', metric: 'tokens', limit: 1000, remaining: 500, resetAt: future() });
    insertState({ platform: 'ollama', keyId: 1, pool: 'ollama::account', metric: 'requests', limit: null, remaining: null, resetAt: null });

    const forecast = getQuotaForecast();
    expect(forecast).toHaveLength(0);
  });
});

// The overview is where inference reaches an operator, so the row has to carry
// it — and has to keep it separate from anything measured.
describe('provider overview: inferred windows', () => {
  beforeEach(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
    getDb().prepare('DELETE FROM requests').run();
    getDb().prepare('DELETE FROM api_keys').run();
    invalidateQuotaInference();
  });

  function enableKey(platform: string): void {
    getDb().prepare(`
      INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled)
      VALUES (?, 'k', 'x', 'x', 'x', 'active', 1)
    `).run(platform);
  }

  function seedRefusalsAndRecovery(platform: string, recoverySeconds: number[]): void {
    const insert = getDb().prepare(`
      INSERT INTO requests (platform, model_id, status, input_tokens, output_tokens, latency_ms, error, created_at)
      VALUES (?, 'm', ?, 0, 0, 0, ?, ?)
    `);
    let at = Date.UTC(2026, 0, 1);
    const iso = (ms: number) => new Date(ms).toISOString().replace('T', ' ').replace('Z', '');
    for (const recovery of recoverySeconds) {
      insert.run(platform, 'error', 'HTTP 429 rate limited', iso(at));
      at += recovery * 1000;
      insert.run(platform, 'success', null, iso(at));
      at += 3_600_000;
    }
  }

  it('surfaces a behavioural estimate for a provider that publishes nothing', () => {
    enableKey('opencode');
    seedRefusalsAndRecovery('opencode', [5, 8, 11, 14]);
    const row = getProviderQuotaOverview().find(r => r.platform === 'opencode');
    expect(row).toBeDefined();
    expect(row!.inferred.map(w => w.period)).toContain('minute');
    // The estimate must not be mistaken for a measurement: the pool stays
    // unmetered and the balance stays unknown.
    expect(row!.metered).toBe(false);
    expect(row!.limit).toBeNull();
    expect(row!.remaining).toBeNull();
  });

  it('carries the sample count so a thin estimate can be discounted', () => {
    enableKey('opencode');
    seedRefusalsAndRecovery('opencode', [5, 8, 11]);
    const row = getProviderQuotaOverview().find(r => r.platform === 'opencode');
    expect(row!.inferred[0]!.samples).toBe(3);
    // Capped below anything published, whatever the sample count.
    expect(row!.inferred[0]!.confidence).toBeLessThanOrEqual(0.5);
  });

  it('stays empty when behaviour says nothing', () => {
    enableKey('ollama');
    const row = getProviderQuotaOverview().find(r => r.platform === 'ollama');
    expect(row!.inferred).toEqual([]);
  });
});

describe('provider overview: a pool total that is the sum of its members', () => {
  beforeEach(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
    getDb().prepare('DELETE FROM api_keys').run();
    getDb().prepare('DELETE FROM quota_policy').run();
    // The seeded catalogue routes models of its own, and they would join the
    // pool under test and make the sum unreadable.
    getDb().prepare('DELETE FROM profile_models').run();
    getDb().prepare('DELETE FROM fallback_config').run();
    getDb().prepare('DELETE FROM models').run();
    invalidateQuotaPolicyCache();
    invalidateQuotaInference();
  });

  function routedModel(platform: string, modelId: string, dailyPolicy: number | null): void {
    const id = getDb().prepare(`
      INSERT INTO models (platform, model_id, display_name, intelligence_rank, speed_rank, size_label,
                          context_window, enabled, supports_tools, supports_vision)
      VALUES (?, ?, ?, 1, 1, 'Large', 131072, 1, 1, 0) RETURNING id
    `).get(platform, modelId, modelId) as { id: number };
    const profile = getDb().prepare("SELECT id FROM profiles LIMIT 1").get() as { id: number } | undefined;
    if (profile) {
      getDb().prepare('INSERT INTO profile_models (profile_id, model_db_id, priority, enabled) VALUES (?, ?, 1, 1)')
        .run(profile.id, id.id);
    }
    if (dailyPolicy != null) {
      upsertQuotaPolicy({
        platform, modelId, endpointScope: null, scope: 'model', metric: 'requests',
        limit: dailyPolicy, periodKind: 'calendar_day', periodMs: null, timezone: 'UTC', anchorDay: null,
      });
    }
  }

  it('sums per-model allowances instead of reporting one learned account figure', () => {
    // The case that forced this. `google::calendar_day` read 45/day from a
    // learned 429 while its members each carried a measured limit — 20 for
    // Flash, 500 for Flash-Lite — and no member was ever bound by 45.
    getDb().prepare(`
      INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled)
      VALUES ('google', 'k', 'x', 'x', 'x', 'healthy', 1)
    `).run();
    routedModel('google', 'flash', 20);
    routedModel('google', 'flash-lite', 500);
    upsertQuotaPolicy({
      platform: 'google', modelId: null, endpointScope: null, scope: 'provider_account',
      metric: 'requests', limit: 45, periodKind: 'calendar_day', periodMs: null, timezone: 'UTC', anchorDay: null,
    });
    invalidateQuotaPolicyCache();

    const row = getProviderQuotaOverview().find(r => r.pool === 'google::calendar_day');
    expect(row).toBeDefined();
    expect(row!.limit).toBe(520);
    expect(row!.aggregated).toBe(true);
  });

  it('builds a provider row from its models when the account declares nothing', () => {
    // Google publishes no account quota at all. Its only account row came from
    // one learned 429, which was wrong; removing it took the provider off the
    // panel entirely, while every routed model carried a measured limit on its
    // own counter. Their sum IS the account allowance.
    getDb().prepare(`
      INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled)
      VALUES ('google', 'k', 'x', 'x', 'x', 'healthy', 1)
    `).run();
    routedModel('google', 'flash', 20);
    routedModel('google', 'flash-lite', 500);
    invalidateQuotaPolicyCache();

    const row = getProviderQuotaOverview().find(r => r.platform === 'google');
    expect(row).toBeDefined();
    expect(row!.limit).toBe(520);
    expect(row!.aggregated).toBe(true);
    expect(row!.memberModelIds.sort()).toEqual(['flash', 'flash-lite']);
  });

  it('refuses to sum models that share one counter, even when each carries a limit', () => {
    // The trap this guard exists for. Every NVIDIA model ships a 40 RPM
    // catalogue column, so "each member has its own limit" is satisfied — and
    // they all resolve to one account pool that grants 40 once. Summing them
    // reported 240 RPM that does not exist.
    getDb().prepare(`
      INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled)
      VALUES ('nvidia', 'k', 'x', 'x', 'x', 'healthy', 1)
    `).run();
    routedModel('nvidia', 'x', 40);
    routedModel('nvidia', 'y', 40);
    invalidateQuotaPolicyCache();

    const row = getProviderQuotaOverview().find(r => r.pool === 'nvidia::calendar_day');
    expect(row?.aggregated).toBeUndefined();
    expect(row?.limit).not.toBe(80);
  });

  it('leaves a genuinely shared pool alone, because summing it would invent capacity', () => {
    // NVIDIA grants one account-wide allowance that every model spends. Its
    // members hold no limits of their own, so the account figure is the
    // binding one and adding it up per model would multiply it.
    getDb().prepare(`
      INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled)
      VALUES ('nvidia', 'k', 'x', 'x', 'x', 'healthy', 1)
    `).run();
    routedModel('nvidia', 'a', null);
    routedModel('nvidia', 'b', null);
    upsertQuotaPolicy({
      platform: 'nvidia', modelId: null, endpointScope: null, scope: 'provider_account',
      metric: 'requests', limit: 40, periodKind: 'calendar_day', periodMs: null, timezone: 'UTC', anchorDay: null,
    });
    invalidateQuotaPolicyCache();

    const row = getProviderQuotaOverview().find(r => r.pool === 'nvidia::calendar_day');
    expect(row!.limit).toBe(40);
    expect(row!.aggregated).toBeUndefined();
  });
});
