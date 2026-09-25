import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import { initDb, getDb } from '../../db/index.js';
import {
  recordQuotaObservation,
  getQuotaStateForKeys,
  parseQuotaObservationsFromResponse,
  inferQuotaPoolKey,
  consumesPaidBalance,
  resolveQuotaPolicy,
  isQuotaPoolAvailable,
  getKeyQuotaHeadroom,
  invalidateKeyQuotaHeadroom,
} from '../../services/provider-quota.js';
import { pruneQuotaObservations } from '../../services/request-retention.js';

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
      (platform, key_id, quota_pool_key, metric, limit_value, remaining_value, reset_at, source, confidence)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'header', 1)
  `).run(row.platform, row.keyId, row.pool, row.metric, row.limit, row.remaining, row.resetAt);
  // Production writes go through recordQuotaObservation, which performs this
  // invalidation. Direct fixture inserts must preserve the same boundary.
  invalidateKeyQuotaHeadroom(row.platform as any);
}

function readState(platform: string, keyId: number, pool: string, metric: string) {
  return getDb().prepare(`
    SELECT limit_value AS lim, remaining_value AS remaining, reset_at AS resetAt
      FROM provider_quota_state
     WHERE platform = ? AND key_id = ? AND quota_pool_key = ? AND metric = ?
  `).get(platform, keyId, pool, metric) as { lim: number | null; remaining: number | null; resetAt: string | null } | undefined;
}

describe('provider-quota: pool inference', () => {
  beforeAll(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
  });

  it('distinguishes shared pools from independent model pools', () => {
    expect(inferQuotaPoolKey('groq', 'openai/gpt-oss-120b')).toBe('groq::model::openai/gpt-oss-120b');
    expect(inferQuotaPoolKey('groq', 'qwen/qwen3-32b')).toBe('groq::model::qwen/qwen3-32b');
    expect(inferQuotaPoolKey('google', 'gemini-2.5-flash')).toBe('google::project-model::gemini-2.5-flash');
    expect(inferQuotaPoolKey('groq')).toBe('groq::account');
    expect(inferQuotaPoolKey('electronhub', 'qwen3.8-flash')).toBe('electronhub::weekly-credit');
    expect(inferQuotaPoolKey('electronhub', 'gpt-oss-120b')).toBe('electronhub::weekly-credit');
    expect(inferQuotaPoolKey('electronhub', 'some-model:free')).toBe('electronhub::daily-free');
    expect(inferQuotaPoolKey('experiential', 'glm-5.3')).toBe('experiential::monthly-credit');
    expect(inferQuotaPoolKey('experiential', 'gpt-5.6-sol')).toBe('experiential::monthly-credit');
    expect(inferQuotaPoolKey('router9', 'minimax/minimax-m3')).toBe('router9::monthly-credit');
    expect(inferQuotaPoolKey('router9', 'another-model')).toBe('router9::monthly-credit');
    expect(inferQuotaPoolKey('septor', 'qwen3-coder-free')).toBe('septor::daily-free');
    expect(inferQuotaPoolKey('septor', 'minimax-m2.5-free')).toBe('septor::daily-free');
    for (const model of ['first-model', 'another-model']) {
      expect(inferQuotaPoolKey('aclide', model)).toBe('aclide::monthly-credit');
      expect(inferQuotaPoolKey('speka', model)).toBe('speka::monthly-credit');
      expect(inferQuotaPoolKey('clod', model)).toBe('clod::daily-free');
      expect(inferQuotaPoolKey('blaze', model)).toBe('blaze::daily-free');
      expect(inferQuotaPoolKey('speechify', model)).toBe('speechify::monthly-characters');
      expect(inferQuotaPoolKey('lucidity', model)).toBe('lucidity::daily-free');
      expect(inferQuotaPoolKey('airforce', model)).toBe('airforce::daily-free');
      expect(inferQuotaPoolKey('dreamprompting', model)).toBe('dreamprompting::daily-free');
      expect(inferQuotaPoolKey('waterfall', model)).toBe('waterfall::community-free');
      expect(inferQuotaPoolKey('logfare', model)).toBe('logfare::fair-use');
    }
    expect(inferQuotaPoolKey('openrouter', 'meta-llama/llama-3.1-8b-instruct:free')).toBe('openrouter::free');
    expect(inferQuotaPoolKey('openrouter', 'qwen/qwen3:free')).toBe('openrouter::free');
    expect(inferQuotaPoolKey('openrouter', 'openai/gpt-4o')).toBe('openrouter::account');
    expect(inferQuotaPoolKey('huggingface', 'openai/gpt-oss-120b')).toBe('huggingface::router');
    expect(inferQuotaPoolKey('custom', 'remote-model', 'https://relay.example/v1')).toBe('custom::remote-model');
    // AnyAPI's 100K tokens/day is one account-wide budget, so every model on
    // the platform shares a single pool.
    expect(inferQuotaPoolKey('anyapi')).toBe('anyapi::free');
    expect(inferQuotaPoolKey('anyapi', 'qwen/qwen3-coder:free')).toBe('anyapi::free');
    expect(inferQuotaPoolKey('radeon', 'DeepSeek-V4-Flash')).toBe('radeon::daily-free');
    expect(inferQuotaPoolKey('radeon', 'Qwen3.8-Flash-Next')).toBe('radeon::daily-free');
    // Unknown platform falls back to platform::model or platform::account.
    expect(inferQuotaPoolKey('acme' as any, 'x')).toBe('acme::x');
    expect(inferQuotaPoolKey('acme' as any)).toBe('acme::account');
  });

  it('gives each Mistral model its own pool, except the two names Codestral answers to', () => {
    // Measured 2026-09-14 on a live free key: three models called back to back
    // reported three different allowances and three counters that moved
    // independently — ministral-8b 188/min, voxtral-small 60/min on a 50k token
    // minute, codestral 125/min on a 625k one. One platform-wide pool read all
    // of that as a single bucket.
    expect(inferQuotaPoolKey('mistral', 'ministral-8b-latest')).toBe('mistral::model::ministral-8b-latest');
    expect(inferQuotaPoolKey('mistral', 'voxtral-small-latest')).toBe('mistral::model::voxtral-small-latest');
    expect(resolveQuotaPolicy('mistral', 'ministral-8b-latest')).toMatchObject({ scope: 'model' });

    // And the exception, which is measured too: codestral-latest went 123 -> 122
    // and mistral-code-latest then reported 121 — the same counter under a
    // second name. Splitting these would invent a second 125/min allowance.
    expect(inferQuotaPoolKey('mistral', 'codestral-latest')).toBe('mistral::codestral');
    expect(inferQuotaPoolKey('mistral', 'codestral-2508')).toBe('mistral::codestral');
    expect(inferQuotaPoolKey('mistral', 'mistral-code-latest')).toBe('mistral::codestral');
    expect(inferQuotaPoolKey('mistral', 'mistral-code-fim-latest')).toBe('mistral::codestral');
    // The prefix must not swallow the rest of the platform: mistral-medium is
    // a different model with a different (here, zero) allowance.
    expect(inferQuotaPoolKey('mistral', 'mistral-medium-latest')).toBe('mistral::model::mistral-medium-latest');
  });

  it('bars AnyAPI paid routes from free chains, the same as OpenRouter', () => {
    // Measured 2026-09-15: openai/gpt-4o-mini, anthropic/claude-sonnet-4.6 and
    // google/gemini-2.5-flash all returned 200 on the free-tier AnyAPI key.
    // That account can pay — 278 of its 288 ids bill, and only the ten carrying
    // `:free` do not. The guard covered OpenRouter alone, so a seeded AnyAPI
    // route would have been eligible for auto chains and billed silently.
    expect(consumesPaidBalance('anyapi', 'openai/gpt-4o-mini')).toBe(true);
    expect(consumesPaidBalance('anyapi', 'anthropic/claude-sonnet-4.6')).toBe(true);
    expect(consumesPaidBalance('anyapi', 'dots-studio/dots-3-note-preview:free')).toBe(false);
    // Unchanged for OpenRouter, and still false for providers with no paid tier
    // reachable on the same credential.
    expect(consumesPaidBalance('openrouter', 'openai/gpt-4o')).toBe(true);
    expect(consumesPaidBalance('openrouter', 'qwen/qwen3:free')).toBe(false);
    expect(consumesPaidBalance('groq', 'openai/gpt-oss-120b')).toBe(false);

    // unorouter, 2026-09-16. It states the hazard in its own refusal: "Your
    // plan's paid allowance is separate — switch to a paid model to keep
    // going." 124 of its 261 ids carry no :free suffix and it exposes no
    // pricing field at all, so the suffix is the only signal there is.
    expect(consumesPaidBalance('unorouter', 'claude-fable-5')).toBe(true);
    expect(consumesPaidBalance('unorouter', 'claude-haiku-4-5-20251001')).toBe(true);
    expect(consumesPaidBalance('unorouter', 'glm-5.3:free')).toBe(false);
  });

  it('reads AnyAPI team token budget from the headers it sends', () => {
    // Measured 2026-09-15 on a live free key: every response carries the team
    // budget and what is left of it. One shared pool across models, in TOKENS
    // — so a per-model request window would be the wrong shape entirely.
    const res = new Response(null, {
      status: 200,
      headers: {
        'x-ratelimit-team-limit-tokens': '100000',
        'x-ratelimit-team-remaining-tokens': '99982',
      },
    });
    const obs = parseQuotaObservationsFromResponse(res, { platform: 'anyapi', keyId: 1 });
    expect(obs.find(o => o.metric === 'tokens')).toMatchObject({ limit: 100_000, remaining: 99_982 });
    // Shared, not per model: two models spend one budget.
    expect(inferQuotaPoolKey('anyapi', 'dots-studio/dots-3-note-preview:free')).toBe('anyapi::free');
    expect(inferQuotaPoolKey('anyapi', 'nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free')).toBe('anyapi::free');
  });

  it('reads a Mistral zero allowance as zero rather than as absent', () => {
    // Mistral answers a model this tier cannot call with 429 and
    // `limit-req-minute: 0`. That is the provider stating there is no
    // allowance, not asking us to retry — and 0 must survive parsing, because
    // a falsy limit dropped on the floor is indistinguishable from a provider
    // that sent no headers at all.
    const refused = new Response(null, {
      status: 429,
      headers: { 'x-ratelimit-limit-req-minute': '0', 'x-ratelimit-remaining-req-minute': '0' },
    });
    const obs = parseQuotaObservationsFromResponse(refused, { platform: 'mistral', keyId: 1 });
    const requests = obs.find(o => o.metric === 'requests');
    expect(requests).toBeDefined();
    expect(requests!.limit).toBe(0);
    expect(requests!.remaining).toBe(0);

    // A serving model on the same key reports its real minute.
    const served = new Response(null, {
      status: 200,
      headers: {
        'x-ratelimit-limit-req-minute': '125',
        'x-ratelimit-remaining-req-minute': '123',
        'x-ratelimit-limit-tokens-minute': '625000',
        'x-ratelimit-remaining-tokens-minute': '624984',
      },
    });
    const ok = parseQuotaObservationsFromResponse(served, { platform: 'mistral', keyId: 1 });
    expect(ok.find(o => o.metric === 'requests')).toMatchObject({ limit: 125, remaining: 123 });
    expect(ok.find(o => o.metric === 'tokens')).toMatchObject({ limit: 625_000, remaining: 624_984 });
  });

  it('describes quota economics without conflating scope and accounting', () => {
    expect(resolveQuotaPolicy('openrouter', 'qwen/qwen3:free')).toMatchObject({
      scope: 'shared_pool', accounting: 'metered', metrics: ['requests'],
    });
    expect(resolveQuotaPolicy('groq', 'openai/gpt-oss-120b')).toMatchObject({
      scope: 'model', accounting: 'metered', metrics: ['requests', 'tokens'],
    });
    expect(resolveQuotaPolicy('google', 'gemini-2.5-flash')).toMatchObject({
      scope: 'project', accounting: 'metered', metrics: ['requests', 'tokens'],
    });
    expect(resolveQuotaPolicy('huggingface', 'openai/gpt-oss-120b')).toMatchObject({
      scope: 'shared_pool', accounting: 'metered', metrics: ['credits'],
    });
    expect(resolveQuotaPolicy('sail', 'zai-org/GLM-5.2-FP8')).toMatchObject({
      poolKey: 'sail::monthly-credit',
      scope: 'shared_pool',
      accounting: 'metered',
      metrics: ['credits'],
      reset: { strategy: 'fixed_calendar', period: 'month' },
    });
    expect(resolveQuotaPolicy('opencode', 'nemotron-3-ultra-free')).toMatchObject({
      accounting: 'unknown', reset: { strategy: 'unknown' },
    });
    expect(resolveQuotaPolicy('custom', 'llama3', 'http://127.0.0.1:11434/v1')).toMatchObject({
      accounting: 'unmetered', metrics: [],
    });
  });
});

describe('provider-quota: routing eligibility', () => {
  beforeAll(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
  });

  beforeEach(() => {
    getDb().prepare('DELETE FROM provider_quota_state').run();
    getDb().prepare('DELETE FROM provider_quota_observations').run();
  });

  it('shared OpenRouter exhaustion applies to every free model on the credential', () => {
    const resetAt = new Date(Date.now() + 60_000).toISOString();
    insertState({ platform: 'openrouter', keyId: 8, pool: 'openrouter::free', metric: 'requests', limit: 50, remaining: 0, resetAt });

    expect(isQuotaPoolAvailable('openrouter', 8, 'qwen/qwen3:free')).toBe(false);
    expect(isQuotaPoolAvailable('openrouter', 8, 'nvidia/nemotron:free')).toBe(false);
  });

  it('Groq model exhaustion does not suppress another model on the same credential', () => {
    const resetAt = new Date(Date.now() + 60_000).toISOString();
    insertState({ platform: 'groq', keyId: 9, pool: 'groq::model::model-a', metric: 'requests', limit: 100, remaining: 0, resetAt });

    expect(isQuotaPoolAvailable('groq', 9, 'model-a')).toBe(false);
    expect(isQuotaPoolAvailable('groq', 9, 'model-b')).toBe(true);
  });

  it('headroom is calculated for the applicable pool rather than the provider-wide worst pool', () => {
    const resetAt = new Date(Date.now() + 60_000).toISOString();
    insertState({ platform: 'groq', keyId: 10, pool: 'groq::model::model-a', metric: 'requests', limit: 100, remaining: 0, resetAt });
    insertState({ platform: 'groq', keyId: 10, pool: 'groq::model::model-b', metric: 'requests', limit: 100, remaining: 80, resetAt });

    expect(getKeyQuotaHeadroom('groq', 'groq::model::model-a').get(10)).toBe(0);
    expect(getKeyQuotaHeadroom('groq', 'groq::model::model-b').get(10)).toBe(0.8);
  });

  it('reads legacy Groq account observations until exact model-pool data arrives', () => {
    const resetAt = new Date(Date.now() + 60_000).toISOString();
    insertState({ platform: 'groq', keyId: 11, pool: 'groq::account', metric: 'requests', limit: 100, remaining: 0, resetAt });

    expect(isQuotaPoolAvailable('groq', 11, 'model-a')).toBe(false);
    expect(getKeyQuotaHeadroom('groq', 'groq::model::model-a').get(11)).toBe(0);

    insertState({ platform: 'groq', keyId: 11, pool: 'groq::model::model-a', metric: 'requests', limit: 100, remaining: 75, resetAt });
    expect(isQuotaPoolAvailable('groq', 11, 'model-a')).toBe(true);
    expect(getKeyQuotaHeadroom('groq', 'groq::model::model-a').get(11)).toBe(0.75);
  });

  it('reads legacy Google project exhaustion for a project/model pool', () => {
    const resetAt = new Date(Date.now() + 60_000).toISOString();
    insertState({ platform: 'google', keyId: 12, pool: 'google::project', metric: 'requests', limit: 20, remaining: 0, resetAt });

    expect(isQuotaPoolAvailable('google', 12, 'gemini-2.5-flash')).toBe(false);
  });
});

describe('provider-quota: record + read round-trip', () => {
  beforeAll(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
  });

  beforeEach(() => {
    getDb().prepare('DELETE FROM provider_quota_state').run();
    getDb().prepare('DELETE FROM provider_quota_observations').run();
  });

  it('surfaces the newest observation per pool when the log holds many', () => {
    // Older rows for the same pool must never win, and rows for a sibling pool
    // must never bleed across. Mirrors the dashboard poll on a long-lived
    // install whose log holds hundreds of thousands of rows per pool.
    for (let i = 0; i < 25; i++) {
      recordQuotaObservation({
        platform: 'groq', keyId: 7, quotaPoolKey: 'groq::account', metric: 'tokens',
        limit: 1000, remaining: 1000 - i, modelId: `old-${i}`, source: 'header',
        observedAt: new Date(Date.UTC(2026, 0, 1, 0, i)).toISOString(),
      });
    }
    recordQuotaObservation({
      platform: 'groq', keyId: 7, quotaPoolKey: 'groq::account', metric: 'tokens',
      limit: 1000, remaining: 5, modelId: 'newest', source: 'header',
      observedAt: new Date(Date.UTC(2026, 0, 2)).toISOString(),
    });
    recordQuotaObservation({
      platform: 'groq', keyId: 7, quotaPoolKey: 'groq::account', metric: 'requests',
      limit: 30, remaining: 1, modelId: 'other-metric', source: 'header',
      observedAt: new Date(Date.UTC(2026, 0, 3)).toISOString(),
    });
    const rows = getQuotaStateForKeys().filter(r => r.platform === 'groq' && r.keyId === 7);
    expect(rows).toHaveLength(2);
    expect(rows.find(r => r.metric === 'tokens')?.modelId).toBe('newest');
    expect(rows.find(r => r.metric === 'tokens')?.remaining).toBe(5);
    expect(rows.find(r => r.metric === 'requests')?.modelId).toBe('other-metric');
  });

  it('prunes the observation log by age and count without touching state', () => {
    const db = getDb();
    const insert = db.prepare(`
      INSERT INTO provider_quota_observations
        (id, platform, key_id, quota_pool_key, metric, observed_at, created_at)
      VALUES (?, 'groq', 7, 'groq::account', 'tokens', ?, ?)
    `);
    const now = Date.UTC(2026, 8, 1);
    const stamp = (ms: number) => new Date(ms).toISOString().slice(0, 19).replace('T', ' ');
    for (let i = 0; i < 10; i++) {
      // 5 rows older than 30 days, 5 fresh ones.
      const at = stamp(now - (i < 5 ? 40 : 1) * 86_400_000 - i * 1000);
      insert.run(`obs-${i}`, at, at);
    }
    insertState({ platform: 'groq', keyId: 7, pool: 'groq::account', metric: 'tokens', limit: 1000, remaining: 10, resetAt: null });

    expect(pruneQuotaObservations(db, now)).toEqual({ deleted: 5, done: true });
    expect(db.prepare('SELECT COUNT(*) AS n FROM provider_quota_observations').get()).toEqual({ n: 5 });

    process.env.QUOTA_OBSERVATIONS_MAX_ROWS = '2';
    try {
      expect(pruneQuotaObservations(db, now)).toEqual({ deleted: 3, done: true });
    } finally {
      delete process.env.QUOTA_OBSERVATIONS_MAX_ROWS;
    }
    const left = db.prepare('SELECT id FROM provider_quota_observations ORDER BY created_at DESC').all() as { id: string }[];
    expect(left.map(r => r.id)).toEqual(['obs-5', 'obs-6']);
    expect(readState('groq', 7, 'groq::account', 'tokens')?.remaining).toBe(10);
  });

  it('stops a large sweep at its time budget and reports it unfinished', () => {
    const db = getDb();
    const insert = db.prepare(`
      INSERT INTO provider_quota_observations
        (id, platform, key_id, quota_pool_key, metric, observed_at, created_at)
      VALUES (?, 'groq', 7, 'groq::account', 'tokens', ?, ?)
    `);
    const now = Date.UTC(2026, 8, 1);
    const old = new Date(now - 60 * 86_400_000).toISOString().slice(0, 19).replace('T', ' ');
    const tx = db.transaction(() => { for (let i = 0; i < 45_000; i++) insert.run(`o-${i}`, old, old); });
    tx();
    // A zero budget allows exactly one chunk before the check trips.
    const first = pruneQuotaObservations(db, now, 0);
    expect(first.done).toBe(false);
    expect(first.deleted).toBe(5_000);
    const rest = pruneQuotaObservations(db, now, 60_000);
    expect(rest).toEqual({ deleted: 40_000, done: true });
  });

  it('records an observation and surfaces it via getQuotaStateForKeys', () => {
    const rec = recordQuotaObservation({
      platform: 'groq',
      keyId: 7,
      quotaPoolKey: 'groq::account',
      metric: 'requests',
      limit: 1000,
      remaining: 950,
      source: 'header',
    });
    expect(rec).not.toBeNull();

    const states = getQuotaStateForKeys();
    const row = states.find(s => s.platform === 'groq' && s.keyId === 7 && s.metric === 'requests');
    expect(row).toBeDefined();
    expect(row!.limit).toBe(1000);
    expect(row!.remaining).toBe(950);
  });

  // #705: the panel rendered a bare "key #7", which names nothing an operator
  // recognises once a provider holds several keys.
  it('carries the label of the key the state belongs to', () => {
    const db = getDb();
    db.prepare(`
      INSERT INTO api_keys (id, platform, label, encrypted_key, iv, auth_tag, status, enabled)
      VALUES (41, 'groq', 'Work account', 'x', 'y', 'z', 'unknown', 1)
    `).run();
    recordQuotaObservation({
      platform: 'groq', keyId: 41, quotaPoolKey: 'groq::account',
      metric: 'requests', limit: 10, remaining: 1, source: 'header',
    });

    const row = getQuotaStateForKeys().find(s => s.keyId === 41);
    expect(row!.keyLabel).toBe('Work account');
  });

  it('leaves the label null when the key row is gone', () => {
    recordQuotaObservation({
      platform: 'groq', keyId: 4242, quotaPoolKey: 'groq::account',
      metric: 'requests', limit: 10, remaining: 1, source: 'header',
    });

    const row = getQuotaStateForKeys().find(s => s.keyId === 4242);
    expect(row).toBeDefined();
    expect(row!.keyLabel).toBeNull();
  });
});

describe('provider-quota: parse from response headers (shared parseRetryAfterMs)', () => {
  it('records Blaze token headers without fabricating a reset or per-model grant', () => {
    const obs = parseQuotaObservationsFromResponse(new Response(null, { headers: {
      'x-ratelimit-limit-tokens': '200000', 'x-ratelimit-remaining-tokens': '199499',
    } }), { platform: 'blaze', modelId: 'test-model' });
    expect(obs).toHaveLength(1);
    expect(obs[0]).toMatchObject({ metric: 'tokens', limit: 200000, remaining: 199499, resetAt: null, quotaPoolKey: 'blaze::daily-free' });
  });

  it('records only CLōD\'s observed request window, not an invented daily token quota', () => {
    const obs = parseQuotaObservationsFromResponse(new Response(null, { headers: {
      'x-ratelimit-limit': '5', 'x-ratelimit-remaining': '4', 'x-ratelimit-reset': '1789230900',
    } }), { platform: 'clod', modelId: 'test-model' });
    expect(obs).toHaveLength(1);
    expect(obs[0]).toMatchObject({ metric: 'requests', limit: 5, remaining: 4, quotaPoolKey: 'clod::daily-free' });
    const speech = parseQuotaObservationsFromResponse(new Response(null), { platform: 'speechify' });
    expect(speech.every(o => o.limit == null && o.remaining == null)).toBe(true);
  });
  beforeAll(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
  });

  it('parses Groq ratelimit headers into a requests observation', () => {
    const resp = new Response(null, {
      status: 200,
      headers: {
        'x-ratelimit-limit-requests': '100',
        'x-ratelimit-remaining-requests': '90',
        'x-ratelimit-reset-requests': '60',
      },
    });
    const obs = parseQuotaObservationsFromResponse(resp, { platform: 'groq', keyId: 1 });
    const requests = obs.find(o => o.metric === 'requests');
    expect(requests).toBeDefined();
    expect(requests!.limit).toBe(100);
    expect(requests!.remaining).toBe(90);
  });

  it('reads Retry-After on a 429 via the shared parser (dedup of base.ts)', () => {
    const resp = new Response(null, { status: 429, headers: { 'retry-after': '30' } });
    const obs = parseQuotaObservationsFromResponse(resp, { platform: 'groq', keyId: 1 });
    // The shared parseRetryAfterMs turns "30" seconds into 30000 ms.
    expect(obs.some(o => o.retryAfterMs === 30_000)).toBe(true);
    // A 429 always marks the pool as remaining 0.
    expect(obs.some(o => o.remaining === 0)).toBe(true);
  });

  it('parses Radeon Cloud RPM and recurring daily allowance headers', () => {
    const resp = new Response(null, {
      status: 200,
      headers: {
        'x-ratelimit-limit-user-rpm': '30',
        'x-ratelimit-remaining-user-rpm': '29',
        'x-ratelimit-reset': '60',
        'x-ratelimit-limit-user-daily-usd': '10',
        'x-ratelimit-used-user-daily-usd': '2.5',
        'x-ratelimit-remaining-user-daily-usd': '7.5',
        'x-ratelimit-reset-user-daily-usd': '86400',
      },
    });
    const obs = parseQuotaObservationsFromResponse(resp, { platform: 'radeon', keyId: 9 });
    expect(obs.find(o => o.metric === 'requests')).toMatchObject({
      quotaPoolKey: 'radeon::daily-free', limit: 30, remaining: 29, unit: null,
    });
    // Radeon denominates its allowance in whole USD. It is recorded in cents,
    // the denomination OpenRouter's balance already uses, so the two are
    // comparable and the dashboard renders $7.50 rather than a bare 7.5.
    expect(obs.find(o => o.metric === 'credits')).toMatchObject({
      quotaPoolKey: 'radeon::daily-free', limit: 1000, remaining: 750, unit: 'cents',
    });
  });

  // ADR ARCH-20260905, F3: the reset parser takes numerics only, so Groq's
  // documented duration form ("2m59.56s") produced no reset_at AND left no
  // trace of what arrived — making "the provider omits it" indistinguishable
  // from "we could not read it". The raw value must survive the parse failure.
  // ADR ARCH-20260905, F3: the reset parser now handles duration strings, so Groq's
  // documented duration form ("2m59.56s") is parsed and retained in rawJson.
  it('parses a duration reset header and retains the raw value', () => {
    const resp = new Response(null, {
      status: 200,
      headers: {
        'x-ratelimit-limit-requests': '1000',
        'x-ratelimit-remaining-requests': '999',
        'x-ratelimit-reset-requests': '2m59.56s',
      },
    });
    const obs = parseQuotaObservationsFromResponse(resp, { platform: 'groq', keyId: 1 });
    const requests = obs.find(o => o.metric === 'requests');
    expect(requests).toBeDefined();
    // Now parsed: resetAt should be set to approximately now + 2m59.56s.
    const resetAt = requests!.resetAt;
    expect(resetAt).not.toBeNull();
    const resetDate = new Date(resetAt);
    const now = Date.now();
    const expected = now + 2 * 60 * 1000 + 59.56 * 1000; // 2 minutes, 59.56 seconds in ms
    expect(Math.abs(resetDate.getTime() - expected)).toBeLessThan(2000); // within 2 seconds
    // The raw value is still retained for auditing.
    expect(requests!.rawJson).toBeTruthy();
    expect(JSON.parse(requests!.rawJson!)['x-ratelimit-reset-requests']).toBe('2m59.56s');
  });

  // A platform with no HEADER_SPECS entry currently records "no quota headers
  // exposed" on every 200. That claim is only checkable if the quota-shaped
  // headers the provider DID send are captured.
  it('discovers quota-shaped headers on a platform with no spec', () => {
    const resp = new Response(null, {
      status: 200,
      headers: { 'x-nvidia-quota-remaining': '37', 'content-type': 'application/json' },
    });
    const obs = parseQuotaObservationsFromResponse(resp, { platform: 'nvidia', keyId: 1 });
    const probe = obs.find(o => o.source === 'probe');
    expect(probe).toBeDefined();
    const raw = JSON.parse(probe!.rawJson!);
    expect(raw['x-nvidia-quota-remaining']).toBe('37');
    // Non-quota headers are not swept up.
    expect(raw['content-type']).toBeUndefined();
  });

  it('never captures credential-bearing headers', () => {
    const resp = new Response(null, {
      status: 429,
      headers: {
        'retry-after': '30',
        'set-cookie': 'session=super-secret-value',
        'x-ratelimit-reset-token': 'quota-shaped-but-a-token',
      },
    });
    const obs = parseQuotaObservationsFromResponse(resp, { platform: 'groq', keyId: 1 });
    const serialized = JSON.stringify(obs);
    expect(serialized).not.toContain('super-secret-value');
    expect(serialized).not.toContain('quota-shaped-but-a-token');
    // The legitimate signal still lands.
    expect(obs.some(o => o.retryAfterMs === 30_000)).toBe(true);
  });

  // F3's intent: a platform outside the shared-pool list that returns textbook
  // x-ratelimit-* headers must not be ignored. The fork could only record
  // "unrecognised quota-shaped headers present", because it had no spec for
  // such a platform; v0.11.0's generic requests/tokens fallback PARSES them, so
  // the same call now yields a real measurement. Asserting the parsed values,
  // not the old placeholder note.
  it('captures quota headers from a platform that is not a shared pool', () => {
    const resp = new Response(null, {
      status: 200,
      headers: {
        'x-ratelimit-limit-requests': '1000',
        'x-ratelimit-remaining-requests': '997',
        'x-ratelimit-reset-requests': '2m59.56s',
      },
    });
    const obs = parseQuotaObservationsFromResponse(resp, { platform: 'custom', keyId: 1 });
    expect(obs).toHaveLength(1);
    expect(obs[0]!.metric).toBe('requests');
    expect(obs[0]!.limit).toBe(1000);
    expect(obs[0]!.remaining).toBe(997);
    // The duration grammar still resolves, and the raw header is retained so
    // the parse stays auditable.
    expect(obs[0]!.resetAt).toBeTruthy();
    expect(JSON.parse(obs[0]!.rawJson!)['x-ratelimit-reset-requests']).toBe('2m59.56s');
  });

  it('stays silent for an unpooled platform that reports nothing', () => {
    const resp = new Response(null, { status: 200, headers: { 'content-type': 'application/json' } });
    expect(parseQuotaObservationsFromResponse(resp, { platform: 'custom', keyId: 1 })).toHaveLength(0);
  });
  // The reset grammar is one pure function, so it is exercised as a table
  // rather than as one 20-line Response per case: same coverage, and a new
  // accepted form is one row instead of a copied block.
  const RESET_CASES: { header: string; expectedMs: number | null }[] = [
    { header: '2m59.56s', expectedMs: 179_560 },
    { header: '59.56s', expectedMs: 59_560 },
    { header: '1h2m3s', expectedMs: 3_723_000 },
    { header: '750ms', expectedMs: 750 },
    { header: '1m', expectedMs: 60_000 },
    { header: '45s', expectedMs: 45_000 },
    // Existing numeric behaviour, unchanged: a bare number is seconds from now.
    { header: '30', expectedMs: 30_000 },
    // Anything it cannot read with certainty stays null. A wrong reset silently
    // corrupts pacing; a null one is already handled and observable.
    { header: 'soon', expectedMs: null },
    { header: '2 minutes', expectedMs: null },
    { header: '-5s', expectedMs: null },
    { header: '', expectedMs: null },
  ];

  it.each(RESET_CASES)('reads reset header $header', ({ header, expectedMs }) => {
    const before = Date.now();
    const resp = new Response(null, {
      status: 200,
      headers: { 'x-ratelimit-limit-requests': '1000', 'x-ratelimit-reset-requests': header },
    });
    const requests = parseQuotaObservationsFromResponse(resp, { platform: 'groq', keyId: 1 })
      .find(o => o.metric === 'requests');
    expect(requests).toBeDefined();

    if (expectedMs === null) {
      expect(requests!.resetAt).toBeNull();
      return;
    }
    expect(requests!.resetAt).not.toBeNull();
    const offset = Date.parse(requests!.resetAt!) - before;
    expect(offset).toBeGreaterThanOrEqual(expectedMs - 50);
    expect(offset).toBeLessThanOrEqual(expectedMs + 1000);
  });

  it('retains the raw reset value whether or not it parsed', () => {
    const resp = new Response(null, {
      status: 200,
      headers: {
        'x-ratelimit-limit-requests': '1000',
        'x-ratelimit-remaining-requests': '999',
        'x-ratelimit-reset-requests': '2m59.56s',
      },
    });
    const requests = parseQuotaObservationsFromResponse(resp, { platform: 'groq', keyId: 1 })
      .find(o => o.metric === 'requests');
    // Retention is the property that makes parsing safe to attempt at all: a
    // wrong grammar stays auditable against what the provider actually sent.
    expect(JSON.parse(requests!.rawJson!)['x-ratelimit-reset-requests']).toBe('2m59.56s');
  });

  it('still reads an epoch-seconds reset as an absolute instant', () => {
    const epochSeconds = Math.floor((Date.now() + 3_600_000) / 1000);
    const resp = new Response(null, {
      status: 200,
      headers: { 'x-ratelimit-limit-requests': '1000', 'x-ratelimit-reset-requests': String(epochSeconds) },
    });
    const requests = parseQuotaObservationsFromResponse(resp, { platform: 'groq', keyId: 1 })
      .find(o => o.metric === 'requests');
    expect(Date.parse(requests!.resetAt!)).toBe(epochSeconds * 1000);
  });



  it('uses ElectronHub account headers without inventing per-model credit limits', () => {
    const response = new Response(null, { headers: {
      'x-ratelimit-limit': '5', 'x-ratelimit-remaining': '4', 'x-ratelimit-reset': '1788690000',
    } });
    const observations = parseQuotaObservationsFromResponse(response, {
      platform: 'electronhub', keyId: 9, modelId: 'qwen3.8-flash',
    });
    expect(observations.find(o => o.metric === 'requests')).toMatchObject({
      quotaPoolKey: 'electronhub::weekly-credit', limit: 5, remaining: 4,
      resetAt: new Date(1788690000000).toISOString(),
    });
    expect(observations.some(o => o.metric === 'credits')).toBe(false);
  });

  it('keeps Router9 decimal credit observations separate from tokens and undocumented request windows', () => {
    const obs = parseQuotaObservationsFromResponse(new Response(null, { headers: {
      'x-credits-limit': '50000', 'x-credits-remaining': '49998.4484',
      'x-ratelimit-limit-4h': '1000', 'x-ratelimit-limit-weekly': '100',
    } }), { platform: 'router9', modelId: 'minimax/minimax-m3' });
    expect(obs).toHaveLength(1);
    expect(obs[0]).toMatchObject({ metric: 'credits', quotaPoolKey: 'router9::monthly-credit', limit: 50000, remaining: 49998.4484, resetAt: null });
  });

  it('observes Septor reported limits without treating signup credits as a monthly grant', () => {
    const obs = parseQuotaObservationsFromResponse(new Response(null, { headers: {
      'x-ratelimit-limit': '60', 'x-ratelimit-remaining': '53', 'x-ratelimit-reset': '1789074787',
    } }), { platform: 'septor', modelId: 'qwen3-coder-free' });
    expect(obs[0]).toMatchObject({ metric: 'requests', quotaPoolKey: 'septor::daily-free', limit: 60, remaining: 53 });
    expect(obs.some(o => o.metric === 'credits')).toBe(false);
  });
});

describe('provider-quota: reset headroom without overwriting observations', () => {
  beforeAll(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
  });

  beforeEach(() => {
    getDb().prepare('DELETE FROM provider_quota_state').run();
    getDb().prepare('DELETE FROM provider_quota_observations').run();
  });

  const past = () => new Date(Date.now() - 60 * 60 * 1000).toISOString();
  const future = () => new Date(Date.now() + 60 * 60 * 1000).toISOString();

  it('displays replenished headroom without rewriting the reported balance', () => {
    insertState({ platform: 'groq', keyId: 1, pool: 'groq::account', metric: 'requests', limit: 100, remaining: 0, resetAt: past() });

    const states = getQuotaStateForKeys();
    const row = states.find(s => s.platform === 'groq' && s.keyId === 1);
    expect(row!.remaining).toBe(100);      // replenished to the limit
    expect(row!.resetAt).toBeNull();        // stale reset dropped

    // Forecast readers retain the actual reported zero and its original reset.
    const persisted = readState('groq', 1, 'groq::account', 'requests');
    expect(persisted!.remaining).toBe(0);
    expect(persisted!.resetAt).not.toBeNull();
  });

  it('clears remaining to unknown when the limit is unknown and reset_at passed', () => {
    insertState({ platform: 'ollama', keyId: 2, pool: 'ollama::cloud', metric: 'requests', limit: null, remaining: 0, resetAt: past() });

    const states = getQuotaStateForKeys();
    const row = states.find(s => s.platform === 'ollama' && s.keyId === 2);
    expect(row!.remaining).toBeNull();      // no known limit → clear the 0
    expect(row!.resetAt).toBeNull();

    const persisted = readState('ollama', 2, 'ollama::cloud', 'requests');
    expect(persisted!.remaining).toBe(0);
  });

  it('leaves a still-active window (reset_at in the future) untouched', () => {
    insertState({ platform: 'groq', keyId: 3, pool: 'groq::account', metric: 'requests', limit: 100, remaining: 0, resetAt: future() });

    const states = getQuotaStateForKeys();
    const row = states.find(s => s.platform === 'groq' && s.keyId === 3);
    expect(row!.remaining).toBe(0);         // still exhausted until it resets
    expect(row!.resetAt).not.toBeNull();
  });
});


describe('provider quota snapshot reliability', () => {
  const now = Date.parse('2026-09-15T12:00:00Z');
  beforeEach(() => { initDb(':memory:'); vi.spyOn(Date, 'now').mockReturnValue(now); });
  afterEach(() => vi.restoreAllMocks());

  it.each([
    ['2m59.56s', 179560], ['7.66s', 7660], ['1h2m3s500ms', 3723500],
    ['1d', 86400000], ['0s', 0], ['179.56', 179560],
    [String(now / 1000 + 60), 60000], [String(now + 60000), 60000],
    ['2026-09-15T12:01:00Z', 60000], ['2026-09-15T14:01:00+02:00', 60000],
  ])('parses reset %s without dropping provider data', (reset, delay) => {
    const response = new Response(null, {headers:{'x-ratelimit-limit-requests':'100','x-ratelimit-remaining-requests':'75','x-ratelimit-reset-requests':reset}});
    expect(parseQuotaObservationsFromResponse(response,{platform:'groq'})[0].resetAt).toBe(new Date(now + delay).toISOString());
  });

  it.each(['', 'nonsense', '-5', 'Infinity', '1e99', '9999999999999999999', '2m invalid', 'NaNs'])('rejects invalid reset %j without throwing', reset => {
    const response = new Response(null, {headers:{'x-ratelimit-limit-requests':'100','x-ratelimit-reset-requests':reset}});
    expect(parseQuotaObservationsFromResponse(response,{platform:'groq'})[0].resetAt).toBeNull();
  });

  it('collects explicit compatible headers without a provider-specific mapping or fabricated limits', () => {
    const response = new Response(null,{headers:{'x-ratelimit-limit-requests':'20','x-ratelimit-remaining-requests':'18','x-ratelimit-reset-requests':'1m'}});
    expect(parseQuotaObservationsFromResponse(response,{platform:'kilo',keyId:4})[0]).toMatchObject({limit:20,remaining:18,resetAt:'2026-09-15T12:01:00.000Z'});
    expect(parseQuotaObservationsFromResponse(new Response(null),{platform:'kilo'})[0]).toMatchObject({limit:null,remaining:null,resetAt:null});
  });

  it('does not replace valid quota headers with a generic 429 or mistake a 200 retry header for exhaustion', () => {
    const headers={'x-ratelimit-limit-requests':'100','x-ratelimit-remaining-requests':'75','x-ratelimit-reset-requests':'2m','retry-after':'5'};
    const rows=parseQuotaObservationsFromResponse(new Response(null,{status:429,headers}),{platform:'groq'});
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({remaining:75,source:'header',confidence:1,resetAt:'2026-09-15T12:02:00.000Z',retryAfterMs:5000});
    expect(parseQuotaObservationsFromResponse(new Response(null,{headers:{'retry-after':'5'}}),{platform:'groq'}).some(row=>row.remaining===0)).toBe(false);
  });

  it('empty and limit-only probes cannot refresh a balance timestamp or borrow its confidence', () => {
    const base={platform:'groq' as const,keyId:4};
    recordQuotaObservation({...base,limit:100,remaining:50,resetAt:'2026-09-15T13:00:00Z',source:'header',observedAt:'2026-09-15T11:00:00Z'});
    const before=getQuotaStateForKeys({normalizeExpired:false})[0];
    const probe=recordQuotaObservation({...base,source:'probe',confidence:0.1,observedAt:'2026-09-15T12:00:00Z'});
    recordQuotaObservation({...base,source:'header',limit:200,observedAt:'2026-09-15T12:01:00Z'});
    expect(probe?.confidence).toBe(0.1);
    expect(getQuotaStateForKeys({normalizeExpired:false})[0]).toMatchObject({limit:100,remaining:50,resetAt:before.resetAt,observedAt:before.observedAt,source:'header',confidence:1});
    expect(getDb().prepare("SELECT confidence FROM provider_quota_observations WHERE source='probe'").get()).toEqual({confidence:0.1});
  });

  it('new balances replace the complete snapshot, including lower confidence and missing reset or limit', () => {
    const base={platform:'groq' as const,keyId:4};
    recordQuotaObservation({...base,limit:100,remaining:50,resetAt:'2026-09-15T13:00:00Z',source:'header',observedAt:'2026-09-15T11:00:00Z'});
    recordQuotaObservation({...base,remaining:0,source:'error_body',confidence:0.55,observedAt:'2026-09-15T12:00:00Z'});
    expect(getQuotaStateForKeys({normalizeExpired:false})[0]).toMatchObject({remaining:0,limit:null,resetAt:null,confidence:0.55,source:'error_body'});
    recordQuotaObservation({...base,remaining:100,limit:100,source:'header',observedAt:'2026-09-15T10:00:00Z'});
    expect(getQuotaStateForKeys({normalizeExpired:false})[0].remaining).toBe(0);
  });
});
