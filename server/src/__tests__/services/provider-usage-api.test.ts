import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { initDb, getDb } from '../../db/index.js';
import { encrypt } from '../../lib/crypto.js';
import {
  pollProviderUsageApis,
  platformsWithUsageApi,
  parseOllamaBalance,
  parseOpenRouterKey,
  parseElectronHubMe,
  parseInferbaseCredits,
  nextWeeklyUtc,
  nextMonthUtc,
} from '../../services/provider-usage-api.js';

/**
 * Account usage read from each provider's own API. Endpoint shapes were taken
 * from the providers' docs and a live key on 2026-10-17. Ollama's
 * undocumented `/api/usage` `limits.*` fractions were withdrawn around
 * 2026-10-07 — that is why its card went ten days stale — and replaced by the
 * documented `/api/balance`.
 */
const realFetch = globalThis.fetch;
const NOW = Date.UTC(2026, 9, 17, 6, 0, 0); // a Saturday

beforeEach(() => {
  process.env.ENCRYPTION_KEY = '0'.repeat(64);
  initDb(':memory:');
  getDb().prepare('DELETE FROM provider_quota_observations').run();
  getDb().prepare('DELETE FROM provider_quota_state').run();
  getDb().prepare('DELETE FROM api_keys').run();
  const secret = encrypt('ollama-test-key');
  getDb().prepare(`
    INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled)
    VALUES ('ollama', 'k', ?, ?, ?, 'healthy', 1)
  `).run(secret.encrypted, secret.iv, secret.authTag);
});

afterEach(() => {
  globalThis.fetch = realFetch;
  vi.restoreAllMocks();
});

function stubUsage(body: unknown, ok = true): void {
  globalThis.fetch = vi.fn(async () => ({
    ok, status: ok ? 200 : 500, json: async () => body,
  })) as unknown as typeof fetch;
}

const legacy = (session: number, weekly?: number) => ({
  included: {
    session: { remaining_percent: session, resets_at: '2026-10-17T10:00:00Z' },
    ...(weekly == null ? {} : { weekly: { remaining_percent: weekly, resets_at: '2026-10-20T00:00:00Z' } }),
  },
});

describe('provider usage APIs', () => {
  const observations = () => getDb().prepare(
    'SELECT quota_pool_key, metric, unit, limit_value, remaining_value, reset_at, source, confidence FROM provider_quota_observations ORDER BY quota_pool_key',
  ).all() as { quota_pool_key: string; metric: string; unit: string | null; limit_value: number; remaining_value: number; reset_at: string | null; source: string; confidence: number }[];

  it('records the current-plan monthly credit with its period end as the reset', async () => {
    stubUsage({ included: { balance_usd: 1.75, allowance_usd: 2.5, period: { from: '2026-10-10T22:36:46Z', until: '2026-11-10T22:36:46Z' } }, purchased: { balance_usd: 0 } });
    expect(await pollProviderUsageApis()).toBe(1);
    expect(observations()).toEqual([expect.objectContaining({
      quota_pool_key: 'ollama::monthly', metric: 'credits', unit: 'cents', limit_value: 250, remaining_value: 175,
      reset_at: '2026-11-10T22:36:46Z', source: 'quota_api',
    })]);
    expect(globalThis.fetch).toHaveBeenCalledWith('https://ollama.com/api/balance', expect.anything());
  });

  it('turns legacy-plan windows into a percentage left with their own resets', async () => {
    stubUsage(legacy(87.9, 95));
    expect(await pollProviderUsageApis()).toBe(2);
    const rows = observations();
    expect(rows.map(r => r.quota_pool_key)).toEqual(['ollama::session', 'ollama::weekly']);
    expect(rows.map(r => r.remaining_value)).toEqual([8790, 9500]);
    expect(rows[0]).toMatchObject({ unit: 'per_10k', reset_at: '2026-10-17T10:00:00Z' });
    expect(rows[0]!.confidence).toBeGreaterThan(0.8);
  });

  it('records a freshly reset window rather than treating a full one as missing', async () => {
    stubUsage(legacy(100));
    expect(await pollProviderUsageApis()).toBe(1);
    expect(observations()[0]!.remaining_value).toBe(10_000);
  });

  it('writes nothing when the endpoint changes shape, errors or throws', async () => {
    // The old /api/usage history shape: no allowance anywhere in it.
    stubUsage({ range: '7d', totals: { request_count: 0, usage_usd: 0 }, buckets: [] });
    expect(await pollProviderUsageApis()).toBe(0);
    stubUsage({ error: 'nope' }, false);
    expect(await pollProviderUsageApis()).toBe(0);
    globalThis.fetch = vi.fn(async () => { throw new Error('ECONNRESET'); }) as unknown as typeof fetch;
    await expect(pollProviderUsageApis()).resolves.toBe(0);
    expect(observations()).toEqual([]);
  });

  it('skips a disabled key', async () => {
    getDb().prepare("UPDATE api_keys SET enabled = 0 WHERE platform = 'ollama'").run();
    stubUsage(legacy(50));
    expect(await pollProviderUsageApis()).toBe(0);
  });

  it('only claims the providers it can actually read', () => {
    expect(platformsWithUsageApi().sort()).toEqual(['electronhub', 'inferbase', 'ollama', 'openrouter']);
  });
});

describe('response parsers', () => {
  it('reads OpenRouter free-model daily requests as the provider counts them, resetting at UTC midnight', () => {
    const [row] = parseOpenRouterKey({ data: { is_free_tier: false, free_model_daily_requests: { used: 4, limit: 1000, remaining: 996 } } }, NOW);
    expect(row).toMatchObject({ quotaPoolKey: 'openrouter::free', metric: 'requests', limit: 1000, remaining: 996, resetAt: '2026-10-18T00:00:00.000Z' });
    expect(parseOpenRouterKey({ data: { limit: 0, limit_remaining: 0 } }, NOW)).toEqual([]);
  });

  it('reads ElectronHub weekly credit in cents, refilling Sunday 21:00 UTC', () => {
    const [row] = parseElectronHubMe({ credits: 0.2499892, weekly_credits: 0.25, subscription: 'free' }, NOW);
    expect(row).toMatchObject({ quotaPoolKey: 'electronhub::weekly-credit', unit: 'cents', limit: 25, remaining: 25, resetAt: '2026-10-18T21:00:00.000Z' });
    expect(parseElectronHubMe({ credits: 'x' }, NOW)).toEqual([]);
  });

  it('counts Inferbase requests this month against the documented free plan, at lower confidence', () => {
    const [row] = parseInferbaseCredits({ balance_micros: 0, requests_this_month: 120 }, NOW);
    expect(row).toMatchObject({ quotaPoolKey: 'inferbase::managed-free', metric: 'requests', limit: 5000, remaining: 4880, resetAt: '2026-11-01T00:00:00.000Z' });
    expect(row!.confidence).toBeLessThan(0.9);
  });

  it('does not invent an Ollama window that the response does not carry', () => {
    expect(parseOllamaBalance({ included: { balance_usd: 1 } })).toEqual([]);
  });

  it('computes calendar resets in UTC', () => {
    // Saturday 06:00 UTC -> Sunday 21:00; on Sunday after 21:00 -> next Sunday.
    expect(nextWeeklyUtc(0, 21, NOW)).toBe('2026-10-18T21:00:00.000Z');
    expect(nextWeeklyUtc(0, 21, Date.UTC(2026, 9, 18, 22))).toBe('2026-10-25T21:00:00.000Z');
    expect(nextMonthUtc(Date.UTC(2026, 11, 31, 23))).toBe('2027-01-01T00:00:00.000Z');
  });
});

/**
 * The observations table is an append-only history. Polling a usage API every
 * five minutes was appending an identical row each time — 82.6% of the rows for
 * a polled pool carried no information, and they dilute the series the reset
 * detector reads.
 */
describe('repeat observations', () => {
  const countRows = () => (getDb().prepare(
    "SELECT COUNT(*) n FROM provider_quota_observations WHERE quota_pool_key = 'ollama::session'",
  ).get() as { n: number }).n;

  it('appends nothing when a poll returns what it returned last time', async () => {
    stubUsage(legacy(87.9));
    await pollProviderUsageApis();
    await pollProviderUsageApis();
    await pollProviderUsageApis();
    expect(countRows()).toBe(1);
  });

  it('records an unchanged reading once the series has gone quiet', async () => {
    stubUsage(legacy(87.9));
    await pollProviderUsageApis();
    getDb().prepare(`
      UPDATE provider_quota_observations
         SET observed_at = datetime('now', '-20 minutes')
       WHERE quota_pool_key = 'ollama::session'
    `).run();
    await pollProviderUsageApis();
    expect(countRows()).toBe(2);
  });

  it('appends as soon as the number moves, and keeps the state row fresh', async () => {
    stubUsage(legacy(87.9));
    await pollProviderUsageApis();
    const first = (getDb().prepare("SELECT observed_at FROM provider_quota_state WHERE quota_pool_key='ollama::session'").get() as { observed_at: string }).observed_at;
    stubUsage(legacy(80));
    await pollProviderUsageApis();
    const rows = getDb().prepare(
      "SELECT remaining_value FROM provider_quota_observations WHERE quota_pool_key='ollama::session' ORDER BY observed_at",
    ).all() as { remaining_value: number }[];
    expect(rows.map(r => r.remaining_value)).toEqual([8790, 8000]);
    const state = getDb().prepare("SELECT observed_at FROM provider_quota_state WHERE quota_pool_key='ollama::session'").get() as { observed_at: string };
    expect(state.observed_at >= first).toBe(true);
  });
});
