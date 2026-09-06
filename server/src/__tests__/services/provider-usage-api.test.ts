import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { initDb, getDb } from '../../db/index.js';
import { encrypt } from '../../lib/crypto.js';
import { pollProviderUsageApis, platformsWithUsageApi } from '../../services/provider-usage-api.js';

/**
 * Ollama Cloud publishes no figure for its free allowance and sends no
 * rate-limit headers, so the ledger was carrying the low end of a documented
 * token range at confidence 0.25. Its undocumented /api/usage endpoint answers
 * directly, in fractions of the real allowance per window:
 *
 *   "limits": { "session": { "usage": 0.121 }, "weekly": { "usage": 0.05 } }
 *
 * These pin the conversion and, more importantly, what happens when an
 * undocumented endpoint changes shape.
 */
const realFetch = globalThis.fetch;

beforeEach(() => {
  process.env.ENCRYPTION_KEY = '0'.repeat(64);
  initDb(':memory:');
  getDb().prepare('DELETE FROM provider_quota_observations').run();
  getDb().prepare('DELETE FROM provider_quota_state').run();
  getDb().prepare("DELETE FROM api_keys WHERE platform = 'ollama'").run();
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

describe('provider usage APIs', () => {
  const observations = () => getDb().prepare(
    'SELECT quota_pool_key, metric, limit_value, remaining_value, source, confidence FROM provider_quota_observations ORDER BY quota_pool_key',
  ).all() as { quota_pool_key: string; metric: string; limit_value: number; remaining_value: number; source: string; confidence: number }[];

  it('turns reported usage fractions into measured remaining quota', async () => {
    stubUsage({ limits: { session: { usage: 0.121 }, weekly: { usage: 0.05 } } });
    expect(await pollProviderUsageApis()).toBe(2);

    const rows = observations();
    expect(rows.map(r => r.quota_pool_key)).toEqual(['ollama::session', 'ollama::weekly']);
    // 12.1% spent leaves 87.9% — carried at 0.01% resolution.
    expect(rows[0]!.remaining_value).toBe(8790);
    expect(rows[1]!.remaining_value).toBe(9500);
    // The allowance is credit, not requests or tokens: Ollama meters dollars
    // of usage at per-model token rates.
    expect(rows[0]!.metric).toBe('credits');
    // quota_api is a measured source, so it outranks every estimate.
    expect(rows[0]!.source).toBe('quota_api');
    expect(rows[0]!.confidence).toBeGreaterThan(0.8);
  });

  it('records a freshly reset window rather than treating zero as missing', async () => {
    stubUsage({ limits: { session: { usage: 0 }, weekly: { usage: 0 } } });
    expect(await pollProviderUsageApis()).toBe(2);
    expect(observations()[0]!.remaining_value).toBe(10_000);
  });

  it('writes nothing when the endpoint changes shape', async () => {
    // Undocumented: it is allowed to disappear or be rewritten. Losing it must
    // cost the measurement, not the request path.
    stubUsage({ limits: { session: { usage: 'lots' } }, unexpected: true });
    expect(await pollProviderUsageApis()).toBe(0);
    expect(observations()).toEqual([]);
  });

  it('writes nothing on an error response', async () => {
    stubUsage({ error: 'nope' }, false);
    expect(await pollProviderUsageApis()).toBe(0);
  });

  it('survives a thrown request', async () => {
    globalThis.fetch = vi.fn(async () => { throw new Error('ECONNRESET'); }) as unknown as typeof fetch;
    await expect(pollProviderUsageApis()).resolves.toBe(0);
  });

  it('skips a disabled key', async () => {
    getDb().prepare("UPDATE api_keys SET enabled = 0 WHERE platform = 'ollama'").run();
    stubUsage({ limits: { session: { usage: 0.5 } } });
    expect(await pollProviderUsageApis()).toBe(0);
  });

  it('only claims the providers it can actually read', () => {
    // A registry, so adding one is a reader and nothing else. Both of these
    // were found by probing: Ollama's /api/usage is undocumented, OpenRouter's
    // /api/v1/credits is not.
    expect(platformsWithUsageApi().sort()).toEqual(['ollama', 'openrouter']);
  });
});

/**
 * Two providers report the metric 'credits' in units that are not comparable:
 * OpenRouter in cents of account balance, Ollama in ten-thousandths of an
 * allowance it never sizes. Formatting on the metric alone rendered Ollama's
 * 82.9% remaining as "$82.90" against an invented $100.00 limit — worse than a
 * bare integer, because it looked like a fact. The unit is what makes either
 * displayable.
 */
describe('units', () => {
  const unitOf = (pool: string) => (getDb().prepare(
    'SELECT unit FROM provider_quota_state WHERE quota_pool_key = ?',
  ).get(pool) as { unit: string | null } | undefined)?.unit;

  it('marks a fraction-of-allowance reading as such', async () => {
    stubUsage({ limits: { session: { usage: 0.121 } } });
    await pollProviderUsageApis();
    expect(unitOf('ollama::session')).toBe('per_10k');
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
    stubUsage({ limits: { session: { usage: 0.121 } } });
    await pollProviderUsageApis();
    await pollProviderUsageApis();
    await pollProviderUsageApis();
    expect(countRows()).toBe(1);
  });

  it('appends as soon as the number moves', async () => {
    stubUsage({ limits: { session: { usage: 0.121 } } });
    await pollProviderUsageApis();
    stubUsage({ limits: { session: { usage: 0.2 } } });
    await pollProviderUsageApis();
    expect(countRows()).toBe(2);
    // The changed row keeps its own timestamp, so the history loses no
    // resolution about WHEN it moved.
    const rows = getDb().prepare(
      "SELECT remaining_value FROM provider_quota_observations WHERE quota_pool_key='ollama::session' ORDER BY observed_at",
    ).all() as { remaining_value: number }[];
    expect(rows.map(r => r.remaining_value)).toEqual([8790, 8000]);
  });

  it('keeps the state row fresh even when it appends nothing', async () => {
    stubUsage({ limits: { session: { usage: 0.121 } } });
    await pollProviderUsageApis();
    const first = (getDb().prepare("SELECT observed_at FROM provider_quota_state WHERE quota_pool_key='ollama::session'").get() as { observed_at: string }).observed_at;
    await pollProviderUsageApis();
    const state = getDb().prepare("SELECT observed_at, remaining_value FROM provider_quota_state WHERE quota_pool_key='ollama::session'").get() as { observed_at: string; remaining_value: number };
    // "Last seen" must not go stale just because the value held steady.
    expect(state.remaining_value).toBe(8790);
    expect(state.observed_at >= first).toBe(true);
    expect(countRows()).toBe(1);
  });
});
