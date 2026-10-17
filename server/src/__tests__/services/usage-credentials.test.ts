import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { generateKeyPairSync, createVerify } from 'node:crypto';
import type { Express } from 'express';
import { createApp } from '../../app.js';
import { initDb, getDb } from '../../db/index.js';
import { encrypt } from '../../lib/crypto.js';
import { pollProviderUsageApis, parseRadeonUsage, parseUnoRouterSelf } from '../../services/provider-usage-api.js';
import {
  normalizeUsageCredential,
  setUsageCredential,
  listUsageCredentials,
  readUsageCredential,
  UsageCredentialError,
} from '../../services/usage-credentials.js';
import { mintDashboardToken } from '../helpers/auth.js';

/**
 * UnoRouter, AMD and Google report account usage only to a credential other
 * than the inference key. These pin what the stored credential unlocks, that a
 * refusal is kept for the operator to see, and that the secret never leaves.
 */
const realFetch = globalThis.fetch;

type Route = (url: string, init?: RequestInit) => { status?: number; body: unknown } | undefined;

/** Provider calls answered by `route`; calls to the test server go through. */
function stubProviders(route: Route) {
  const calls: string[] = [];
  globalThis.fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.startsWith('http://127.0.0.1:')) return realFetch(input, init);
    calls.push(url);
    const reply = route(url, init) ?? { status: 404, body: {} };
    const status = reply.status ?? 200;
    return { ok: status < 400, status, json: async () => reply.body } as Response;
  }) as unknown as typeof fetch;
  return calls;
}

function addKey(platform: string): number {
  const s = encrypt(`${platform}-inference-key`);
  return Number(getDb().prepare(`
    INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled)
    VALUES (?, 'k', ?, ?, ?, 'healthy', 1)
  `).run(platform, s.encrypted, s.iv, s.authTag).lastInsertRowid);
}

const state = (pool: string) => getDb().prepare(
  'SELECT limit_value, remaining_value, unit, metric, reset_at, source FROM provider_quota_state WHERE quota_pool_key = ?',
).get(pool) as { limit_value: number; remaining_value: number; unit: string | null; metric: string; reset_at: string | null; source: string } | undefined;

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const serviceAccount = JSON.stringify({
  type: 'service_account', project_id: 'my-proj', client_email: 'usage@my-proj.iam.gserviceaccount.com',
  private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
});

beforeEach(() => {
  process.env.ENCRYPTION_KEY = '0'.repeat(64);
  initDb(':memory:');
  for (const t of ['provider_usage_credentials', 'provider_quota_observations', 'provider_quota_state', 'api_keys']) {
    getDb().prepare(`DELETE FROM ${t}`).run();
  }
});

afterEach(() => {
  globalThis.fetch = realFetch;
  vi.restoreAllMocks();
});

describe('credential input', () => {
  it('strips pasted prefixes and refuses what the provider would refuse', () => {
    expect(normalizeUsageCredential('unorouter', { userId: ' 42 ', accessToken: 'Bearer abc' })).toEqual({ userId: '42', accessToken: 'abc' });
    expect(normalizeUsageCredential('radeon', { cookie: 'Cookie: session=x' })).toEqual({ cookie: 'session=x' });
    expect(() => normalizeUsageCredential('unorouter', { userId: 'me', accessToken: 'abc' })).toThrow(UsageCredentialError);
    expect(() => normalizeUsageCredential('google', { serviceAccountJson: '{"type":"service_account"}' })).toThrow(/client_email/);
    expect(() => normalizeUsageCredential('google', { serviceAccountJson: serviceAccount.replace('BEGIN PRIVATE KEY', 'BEGIN NOTHING') })).toThrow(/does not parse/);
    expect(normalizeUsageCredential('google', { serviceAccountJson: serviceAccount }).serviceAccountJson).toBe(serviceAccount);
  });

  it('goes with its key', () => {
    const key = addKey('unorouter');
    setUsageCredential(key, { userId: '1', accessToken: 't' });
    getDb().prepare('DELETE FROM api_keys WHERE id = ?').run(key);
    expect(readUsageCredential(key)).toBeNull();
    expect(listUsageCredentials()).toEqual([]);
  });
});

describe('UnoRouter', () => {
  it('reads the account balance with the access token and user id, in the rate /api/status publishes', async () => {
    const key = addKey('unorouter');
    setUsageCredential(key, { userId: '42', accessToken: 'tok' });
    let headers: Record<string, string> = {};
    stubProviders((url, init) => {
      if (url.endsWith('/api/status')) return { body: { data: { quota_per_unit: 500000 } } };
      if (url.endsWith('/api/user/self')) {
        headers = init?.headers as Record<string, string>;
        return { body: { success: true, data: { quota: 1_600_000, used_quota: 900_000 } } };
      }
      return undefined;
    });
    expect(await pollProviderUsageApis()).toBe(1);
    expect(headers).toMatchObject({ Authorization: 'Bearer tok', 'New-Api-User': '42' });
    expect(state('unorouter::credits')).toMatchObject({ unit: 'cents', limit_value: 500, remaining_value: 320, source: 'quota_api' });
    expect(listUsageCredentials()[0]).toMatchObject({ lastStatus: 'ok', lastMessage: 'balance $3.20 of $5.00' });
  });

  it('keeps a refusal for the operator and records no balance', async () => {
    const key = addKey('unorouter');
    setUsageCredential(key, { userId: '42', accessToken: 'stale' });
    // new-api answers a bad access token with HTTP 200 and success:false.
    stubProviders(url => (url.endsWith('/api/user/self') ? { body: { success: false, message: 'access token invalid' } } : undefined));
    expect(await pollProviderUsageApis()).toBe(0);
    expect(state('unorouter::credits')).toBeUndefined();
    expect(listUsageCredentials()[0]).toMatchObject({ lastStatus: 'error', lastMessage: expect.stringContaining('access token invalid') });
  });

  it('does not call a credential-only provider for a key without one', async () => {
    addKey('unorouter');
    const calls = stubProviders(() => undefined);
    expect(await pollProviderUsageApis()).toBe(0);
    expect(calls).toEqual([]);
  });

  it('says a zero balance plainly instead of recording an empty pool', () => {
    expect(parseUnoRouterSelf({ success: true, data: { quota: 0, used_quota: 0 } }, 500000))
      .toEqual({ observations: [], note: 'balance $0.00 — free models only' });
  });
});

describe('AMD', () => {
  it('reads the daily spend cap with its Shanghai reset', () => {
    const { observations, note } = parseRadeonUsage({
      daily_cost_limit_usd: 1, daily_cost_used_usd: 0.25, daily_cost_remaining_usd: 0.75,
      daily_reset_at: '2026-10-18T00:00:00+08:00', today: { requests: 12 },
    });
    expect(observations[0]).toMatchObject({ quotaPoolKey: 'radeon::daily-cost', unit: 'cents', limit: 100, remaining: 75, resetAt: '2026-10-18T00:00:00+08:00' });
    expect(note).toBe('$0.25 of $1.00 today, 12 requests');
  });

  it('tells the operator when the console session has expired', async () => {
    const key = addKey('radeon');
    setUsageCredential(key, { cookie: 'session=old' });
    stubProviders(url => (url.includes('/radeon/api/profile/model-usage') ? { status: 401, body: { detail: 'Login required' } } : undefined));
    await pollProviderUsageApis();
    expect(listUsageCredentials()[0]).toMatchObject({ lastStatus: 'error', lastMessage: expect.stringContaining('session expired') });
  });
});

describe('Google', () => {
  const quotaInfos = {
    quotaInfos: [
      { quotaId: 'GenerateRequestsPerDayPerProjectPerModel-FreeTier', dimensionsInfos: [
        { dimensions: { model: 'gemini-2.5-flash' }, details: { value: '250' } },
        { dimensions: { model: 'gemini-2.5-pro' }, details: { value: '100' } },
      ] },
      { quotaId: 'GenerateRequestsPerMinutePerProjectPerModel-FreeTier', dimensionsInfos: [
        { dimensions: { model: 'gemini-2.5-flash' }, details: { value: '10' } },
      ] },
    ],
  };

  function google(series: unknown[]) {
    let assertion = '';
    const calls = stubProviders((url, init) => {
      if (url === 'https://oauth2.googleapis.com/token') {
        assertion = new URLSearchParams(String(init?.body)).get('assertion') ?? '';
        return { body: { access_token: 'ya29.x', expires_in: 3600 } };
      }
      if (url.startsWith('https://cloudquotas.googleapis.com/v1/projects/my-proj/')) return { body: quotaInfos };
      if (url.startsWith('https://monitoring.googleapis.com/v3/projects/my-proj/timeSeries')) return { body: { timeSeries: series } };
      return undefined;
    });
    return { calls, assertion: () => assertion };
  }

  it('signs a service-account assertion and records per-model use against each daily limit', async () => {
    const key = addKey('google');
    setUsageCredential(key, { serviceAccountJson: serviceAccount });
    const g = google([
      { metric: { labels: { quota_metric: 'generativelanguage.googleapis.com/generate_content_free_tier_requests', model: 'gemini-2.5-flash' } }, points: [{ value: { int64Value: '40' } }] },
    ]);
    expect(await pollProviderUsageApis()).toBe(1);

    const [head, claims, signature] = g.assertion().split('.');
    expect(createVerify('RSA-SHA256').update(`${head}.${claims}`).verify(publicKey, signature!, 'base64url')).toBe(true);
    expect(JSON.parse(Buffer.from(claims!, 'base64url').toString())).toMatchObject({
      iss: 'usage@my-proj.iam.gserviceaccount.com', aud: 'https://oauth2.googleapis.com/token', scope: 'https://www.googleapis.com/auth/cloud-platform',
    });
    const row = getDb().prepare(
      "SELECT quota_pool_key, limit_value, remaining_value, reset_at FROM provider_quota_state WHERE platform = 'google'",
    ).get() as { quota_pool_key: string; limit_value: number; remaining_value: number; reset_at: string };
    expect(row).toMatchObject({ quota_pool_key: 'google::project-model::gemini-2.5-flash', limit_value: 250, remaining_value: 210 });
    expect([7, 8]).toContain(new Date(row.reset_at).getUTCHours());
    expect(listUsageCredentials()[0]!.lastMessage).toBe('2 model daily limits; 40 free-tier requests today, 1 models measured');
  });

  it('records no model it cannot attribute usage to, and reuses the access token', async () => {
    const key = addKey('google');
    setUsageCredential(key, { serviceAccountJson: serviceAccount });
    const g = google([{ metric: { labels: { quota_metric: 'x' } }, points: [{ value: { int64Value: '7' } }, { value: { int64Value: '5' } }] }]);
    expect(await pollProviderUsageApis()).toBe(0);
    const exchanges = () => g.calls.filter(u => u.includes('oauth2')).length;
    const afterFirst = exchanges();
    await pollProviderUsageApis();
    // The hour-long token is reused, not exchanged on every five-minute poll.
    expect(exchanges()).toBe(afterFirst);
    expect(g.calls.filter(u => u.includes('monitoring')).length).toBe(2);
    expect(listUsageCredentials()[0]!.lastMessage).toBe('2 model daily limits; 12 free-tier requests today, not split by model');
  });

  it('names the missing role when a Google API refuses', async () => {
    const key = addKey('google');
    setUsageCredential(key, { serviceAccountJson: serviceAccount });
    stubProviders(url => {
      if (url.includes('oauth2')) return { body: { access_token: 'ya29.y', expires_in: 3600 } };
      if (url.includes('cloudquotas')) return { status: 403, body: { error: { message: 'Permission denied' } } };
      return undefined;
    });
    await pollProviderUsageApis();
    expect(listUsageCredentials()[0]!.lastMessage).toMatch(/Cloud Quotas refused \(HTTP 403: Permission denied\).*roles\/cloudquotas\.viewer/);
  });
});

describe('usage credential API', () => {
  let app: Express;
  let token: string;

  async function call(method: string, path: string, body?: unknown) {
    const server = app.listen(0, '127.0.0.1');
    if (!server.listening) await new Promise<void>(resolve => server.once('listening', () => resolve()));
    const { port } = server.address() as { port: number };
    try {
      const res = await fetch(`http://127.0.0.1:${port}${path}`, {
        method,
        headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
        body: body ? JSON.stringify(body) : undefined,
      });
      return { status: res.status, text: await res.text() };
    } finally {
      server.close();
    }
  }

  beforeEach(() => {
    app = createApp();
    token = mintDashboardToken();
  });

  it('stores, reads at once, never returns the secret, and removes', async () => {
    const key = addKey('unorouter');
    stubProviders(url => (url.endsWith('/api/user/self') ? { body: { success: true, data: { quota: 500_000, used_quota: 0 } } } : undefined));
    const put = await call('PUT', `/api/quota/usage-credentials/${key}`, { fields: { userId: '7', accessToken: 'very-secret-token' } });
    expect(put.status).toBe(200);
    expect(JSON.parse(put.text).credential).toMatchObject({ keyId: key, lastStatus: 'ok', lastMessage: 'balance $1.00 of $1.00' });

    const list = await call('GET', '/api/quota/usage-credentials');
    expect(list.text).not.toContain('very-secret-token');
    expect(JSON.parse(list.text).supported.unorouter).toEqual(['userId', 'accessToken']);

    expect((await call('DELETE', `/api/quota/usage-credentials/${key}`)).status).toBe(200);
    expect(listUsageCredentials()).toEqual([]);
  });

  it('refuses bad input with 400 and a provider without a usage credential with 404', async () => {
    const uno = addKey('unorouter');
    const groq = addKey('groq');
    expect((await call('PUT', `/api/quota/usage-credentials/${uno}`, { fields: { userId: 'abc', accessToken: 't' } })).status).toBe(400);
    expect((await call('PUT', `/api/quota/usage-credentials/${groq}`, { fields: { x: 'y' } })).status).toBe(404);
    expect(listUsageCredentials()).toEqual([]);
  });
});
