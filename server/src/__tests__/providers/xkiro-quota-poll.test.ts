import { describe, it, expect, vi, beforeEach, beforeAll } from 'vitest';
import { EventEmitter } from 'events';
import https from 'https';
import { resolveProvider } from '../../providers/index.js';
import { initDb, getDb } from '../../db/index.js';
import { pollKeyQuota, supportsQuotaPolling } from '../../services/health.js';
import { encrypt } from '../../lib/crypto.js';
import { encryptProxyUrl } from '../../lib/key-proxy.js';
import { applyProxyBypass, applyProxyEnabled, applyProxyUrl } from '../../lib/proxy.js';
import { getQuotaStateForKeys } from '../../services/provider-quota.js';

beforeAll(() => {
  process.env.ENCRYPTION_KEY = '0'.repeat(64);
  initDb(':memory:');
});

function insertTestKey(platform: string, key = 'sk-xkiro-test', proxyUrl = ''): number {
  const enc = encrypt(key);
  const proxy = encryptProxyUrl(proxyUrl);
  const row = getDb().prepare(
    `INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag,
      proxy_encrypted, proxy_iv, proxy_auth_tag, status, enabled)
     VALUES (?, 'test-key', ?, ?, ?, ?, ?, ?, 'healthy', 1)`
  ).run(platform, enc.encrypted, enc.iv, enc.authTag,
    proxy.encrypted, proxy.iv, proxy.authTag);
  return Number(row.lastInsertRowid);
}

function clearTables() {
  getDb().prepare('DELETE FROM provider_quota_state').run();
  getDb().prepare('DELETE FROM provider_quota_observations').run();
  getDb().prepare('DELETE FROM api_keys').run();
}

describe('xKiro quota polling and observation pipeline', () => {
  beforeEach(() => {
    clearTables();
    vi.restoreAllMocks();
  });

  it('xKiro provider is registered with hasQuotaProbe=true', () => {
    const provider = resolveProvider('xkiro');
    expect(provider).toBeDefined();
    expect(provider?.hasQuotaProbe).toBe(true);
    expect(supportsQuotaPolling(provider!)).toBe(true);
  });

  it('parses authenticated free_tokens usage and stamps next 00:00 UTC fixed_calendar reset', async () => {
    const provider = resolveProvider('xkiro')!;
    const fetchSpy = vi.spyOn(global, 'fetch').mockImplementation(async (url: unknown) => {
      expect(String(url)).toBe('https://api.xkiro.com/v1/usage');
      return new Response(JSON.stringify({
        object: 'usage',
        plan: null,
        windows: [],
        free_tokens: {
          used_today: 308,
          limit_per_day: 1000000,
          remaining: 999692,
        },
        wallet: {
          balance_usd: '0.000000',
          held_usd: '0.000000',
        },
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    });

    const recorded = await provider.fetchQuota('sk-test-xkiro', {
      platform: 'xkiro',
      keyId: 101,
      quotaPoolKey: 'xkiro::free',
    });

    expect(recorded).toBe(true);
    expect(fetchSpy).toHaveBeenCalled();

    const state = getDb().prepare(
      'SELECT platform, key_id, quota_pool_key, metric, limit_value, remaining_value, reset_at, reset_strategy, source, confidence FROM provider_quota_state WHERE platform = ?',
    ).all('xkiro') as Array<{
      platform: string;
      key_id: number;
      quota_pool_key: string;
      metric: string;
      limit_value: number;
      remaining_value: number;
      reset_at: string;
      reset_strategy: string;
      source: string;
      confidence: number;
    }>;

    expect(state).toHaveLength(1);
    expect(state[0]).toMatchObject({
      platform: 'xkiro',
      key_id: 101,
      metric: 'tokens',
      limit_value: 1000000,
      remaining_value: 999692,
      reset_strategy: 'fixed_calendar',
      source: 'quota_api',
      confidence: 1,
    });
    // Check reset_at is a valid ISO string at 00:00:00.000Z
    expect(state[0].reset_at).toMatch(/^\d{4}-\d{2}-\d{2}T00:00:00\.000Z$/);

    // Verify observations table has an observation record
    const obs = getDb().prepare(
      'SELECT * FROM provider_quota_observations WHERE platform = ?',
    ).all('xkiro') as Array<Record<string, unknown>>;
    expect(obs).toHaveLength(1);
    expect(obs[0].limit_value).toBe(1000000);
    expect(obs[0].remaining_value).toBe(999692);
  });

  it('handles genuine 0 remaining tokens', async () => {
    const provider = resolveProvider('xkiro')!;
    vi.spyOn(global, 'fetch').mockImplementation(async () => {
      return new Response(JSON.stringify({
        object: 'usage',
        plan: null,
        windows: [],
        free_tokens: {
          used_today: 1000000,
          limit_per_day: 1000000,
          remaining: 0,
        },
        wallet: { balance_usd: '0.000000', held_usd: '0.000000' },
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    });

    const recorded = await provider.fetchQuota('sk-test-xkiro', {
      platform: 'xkiro',
      keyId: 102,
      quotaPoolKey: 'xkiro::free',
    });

    expect(recorded).toBe(true);

    const row = getDb().prepare(
      'SELECT limit_value, remaining_value FROM provider_quota_state WHERE platform = ? AND key_id = ?',
    ).get('xkiro', 102) as { limit_value: number; remaining_value: number };

    expect(row.limit_value).toBe(1000000);
    expect(row.remaining_value).toBe(0);
  });

  it('records nothing when limit and remaining are null or missing', async () => {
    const provider = resolveProvider('xkiro')!;
    vi.spyOn(global, 'fetch').mockImplementation(async () => {
      return new Response(JSON.stringify({
        object: 'usage',
        plan: null,
        windows: [],
        free_tokens: {
          used_today: 0,
          limit_per_day: null,
          remaining: null,
        },
        wallet: { balance_usd: '0.000000', held_usd: '0.000000' },
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    });

    const recorded = await provider.fetchQuota('sk-test-xkiro', {
      platform: 'xkiro',
      keyId: 103,
      quotaPoolKey: 'xkiro::free',
    });

    expect(recorded).toBe(false);
    const rows = getDb().prepare('SELECT * FROM provider_quota_state WHERE platform = ?').all('xkiro');
    expect(rows).toHaveLength(0);
  });

  it('handles invalid / non-numeric values gracefully without throwing', async () => {
    const provider = resolveProvider('xkiro')!;
    vi.spyOn(global, 'fetch').mockImplementation(async () => {
      return new Response(JSON.stringify({
        object: 'usage',
        free_tokens: {
          limit_per_day: 'not-a-number',
          remaining: null,
        },
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    });

    const recorded = await provider.fetchQuota('sk-test-xkiro', {
      platform: 'xkiro',
      keyId: 104,
      quotaPoolKey: 'xkiro::free',
    });

    expect(recorded).toBe(false);
  });

  it('handles upstream 401 unauthorized gracefully', async () => {
    const provider = resolveProvider('xkiro')!;
    vi.spyOn(global, 'fetch').mockImplementation(async () => {
      return new Response(JSON.stringify({
        error: { message: 'Invalid or disabled ClientApiKey' },
      }), {
        status: 401,
        headers: { 'Content-Type': 'application/json' },
      });
    });

    const recorded = await provider.fetchQuota('sk-bad-key', {
      platform: 'xkiro',
      keyId: 105,
      quotaPoolKey: 'xkiro::free',
    });

    expect(recorded).toBe(false);
  });

  it('routes the usage query through the key proxy', async () => {
    applyProxyEnabled(true);
    applyProxyBypass('');
    applyProxyUrl('');
    const keyId = insertTestKey('xkiro', 'sk-proxied', 'socks5h://127.0.0.1:1094');
    const row = getDb().prepare('SELECT * FROM api_keys WHERE id = ?').get(keyId) as Record<string, unknown>;
    const provider = resolveProvider('xkiro')!;
    const reqSpy = vi.spyOn(https, 'request').mockImplementation(((_opts: unknown, cb: (res: EventEmitter & {
      statusCode: number; statusMessage: string; headers: Record<string, string>; destroy: () => void;
    }) => void) => {
      const req = new EventEmitter() as EventEmitter & { write: () => void; destroy: () => void; end: () => void };
      req.write = () => {};
      req.destroy = () => {};
      req.end = () => {
        const res = Object.assign(new EventEmitter(), {
          statusCode: 200, statusMessage: 'OK', headers: { 'content-type': 'application/json' }, destroy: () => {},
        });
        cb(res);
        setImmediate(() => {
          res.emit('data', Buffer.from(JSON.stringify({ free_tokens: { used_today: 100, limit_per_day: 1000000, remaining: 999900 } })));
          res.emit('end');
        });
      };
      return req;
    }) as typeof https.request);

    const recorded = await pollKeyQuota(keyId, row, provider);
    expect(recorded).toBe(true);
    const options = reqSpy.mock.calls[0]?.[0] as { agent?: { proxy?: { port?: number } }; headers?: Record<string, string> } | undefined;
    expect(options?.agent?.proxy?.port).toBe(1094);
    expect(options?.headers?.Authorization ?? options?.headers?.authorization).toBe('Bearer sk-proxied');
  });

  it('pollKeyQuota populates getQuotaStateForKeys consumed by dashboard', async () => {
    const keyId = insertTestKey('xkiro', 'sk-xkiro-dash');
    const row = getDb().prepare('SELECT * FROM api_keys WHERE id = ?').get(keyId) as Record<string, unknown>;
    const provider = resolveProvider('xkiro')!;

    vi.spyOn(global, 'fetch').mockImplementation(async () => {
      return new Response(JSON.stringify({
        free_tokens: { used_today: 500, limit_per_day: 1000000, remaining: 999500 },
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    });

    await pollKeyQuota(keyId, row, provider);

    const states = getQuotaStateForKeys();
    const xkiroState = states.find(s => s.platform === 'xkiro' && s.keyId === keyId);

    expect(xkiroState).toBeDefined();
    expect(xkiroState?.limit).toBe(1000000);
    expect(xkiroState?.remaining).toBe(999500);
    expect(xkiroState?.metric).toBe('tokens');
    expect(xkiroState?.source).toBe('quota_api');
    expect(xkiroState?.resetStrategy).toBe('fixed_calendar');
    expect(xkiroState?.quotaPoolKey).toBe('xkiro::free');
  });

  it('safe key validation against validateUrl (/v1/usage) accurately validates key', async () => {
    insertTestKey('xkiro', 'sk-valid-key');
    const provider = resolveProvider('xkiro')!;

    vi.spyOn(global, 'fetch').mockImplementation(async (_url: unknown, init: unknown) => {
      const headers = new Headers((init as RequestInit)?.headers);
      const auth = headers.get('authorization');
      if (auth === 'Bearer sk-valid-key') {
        return new Response(JSON.stringify({
          object: 'usage',
          free_tokens: { used_today: 0, limit_per_day: 1000000, remaining: 1000000 },
        }), { status: 200 });
      }
      return new Response(JSON.stringify({
        error: { message: 'Invalid or disabled ClientApiKey' },
      }), { status: 401 });
    });

    const validResult = await provider.validateKey('sk-valid-key');
    expect(validResult).toBe(true);

    const invalidResult = await provider.validateKey('sk-invalid-key');
    // The provider's own reason reaches the operator.
    expect(invalidResult).toMatchObject({ valid: false, error: expect.stringContaining('Invalid or disabled ClientApiKey') });
  });
});
