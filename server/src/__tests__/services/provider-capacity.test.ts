import { once } from 'node:events';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { initDb, getDb } from '../../db/index.js';
import { createApp } from '../../app.js';
import { encrypt } from '../../lib/crypto.js';
import { getProvider } from '../../providers/index.js';
import { RadeonProvider } from '../../providers/radeon.js';
import { getProviderCapacity } from '../../services/provider-capacity.js';
import { recordQuotaObservation } from '../../services/provider-quota.js';
import { setCooldown } from '../../services/ratelimit.js';
import { mintDashboardToken } from '../helpers/auth.js';

const NOW = Date.parse('2026-10-14T09:00:00Z');

function key(scope: string[] | null = null, enabled = true, status = 'healthy'): number {
  const secret = encrypt('capacity-test');
  return Number(getDb().prepare(`INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled, model_scope_json)
    VALUES ('radeon', 'Capacity key', ?, ?, ?, ?, ?, ?)`).run(secret.encrypted, secret.iv, secret.authTag, status, enabled ? 1 : 0,
      scope ? JSON.stringify(scope) : null).lastInsertRowid);
}

function observe(keyId: number, options: { remaining?: number; observedAt?: number; resetAt?: number; metric?: 'credits' | 'requests'; confidence?: number } = {}) {
  const metric = options.metric ?? 'credits';
  recordQuotaObservation({
    platform: 'radeon', keyId, quotaPoolKey: 'radeon::daily-free', metric,
    unit: metric === 'credits' ? 'cents' : null,
    limit: metric === 'credits' ? 100 : 20,
    remaining: options.remaining ?? (metric === 'credits' ? 99.995531 : 19),
    source: 'header', confidence: options.confidence ?? 1,
    observedAt: new Date(options.observedAt ?? NOW).toISOString(),
    resetAt: options.resetAt == null ? null : new Date(options.resetAt).toISOString(),
  });
}

beforeAll(() => {
  process.env.ENCRYPTION_KEY = '0'.repeat(64);
  initDb(':memory:');
  getDb().prepare(`INSERT INTO models (platform, model_id, display_name, intelligence_rank, speed_rank, enabled)
    VALUES ('radeon', 'model-a', 'Model A', 1, 1, 1), ('radeon', 'model-b', 'Model B', 2, 2, 1)`).run();
});
beforeEach(() => {
  const db = getDb();
  db.prepare('DELETE FROM provider_quota_observations').run();
  db.prepare('DELETE FROM provider_quota_state').run();
  db.prepare('DELETE FROM rate_limit_cooldowns').run();
  db.prepare('DELETE FROM api_keys').run();
  vi.spyOn(Date, 'now').mockReturnValue(NOW);
  const provider = getProvider('radeon');
  if (!(provider instanceof RadeonProvider)) throw new Error('Missing Radeon provider');
  vi.spyOn(provider, 'getModelPressure').mockReturnValue({
    models: { 'model-a': { state: 'full', utilization: 100 }, 'model-b': { state: 'idle', utilization: 0 } },
    observedAt: new Date(NOW).toISOString(), freshness: 'fresh',
  });
});
afterEach(() => { vi.restoreAllMocks(); });

describe('provider-model capacity facts', () => {
  it('references one precise shared allowance from two models without blending it with pressure', async () => {
    const id = key();
    observe(id);
    const snapshot = await getProviderCapacity();
    expect(snapshot.pools.map(pool => pool.keyId)).toEqual([id]);
    expect(snapshot.pools[0].allocation.remaining).toBeCloseTo(0.99995531, 8);
    expect(snapshot.pools[0].allocation.used).toBeCloseTo(0.00004469, 8);
    expect(snapshot.pools[0].allocation.remainingPct).toBeLessThan(100);
    expect(snapshot.models.map(model => model.keyIds)).toEqual([[id], [id]]);
    expect(snapshot.models[0].pressure).toMatchObject({ state: 'full', utilizationPct: 100, freshness: 'fresh' });
    expect(snapshot.models[1].pressure).toMatchObject({ state: 'idle', utilizationPct: 0, freshness: 'fresh' });
  });

  it('excludes anonymous and deleted credentials and respects actual scopes and key eligibility', async () => {
    const on = key(['model-a']);
    const off = key(['model-b'], false);
    observe(on);
    observe(0);
    observe(999999);
    const snapshot = await getProviderCapacity();
    expect(snapshot.pools.map(pool => pool.keyId)).toEqual([on, off]);
    expect(snapshot.pools[1].allocation).toMatchObject({ remaining: null, limit: null, freshness: 'unknown' });
    expect(snapshot.models[0]).toMatchObject({ keyIds: [on], usableKeyIds: [on] });
    expect(snapshot.models[1]).toMatchObject({ keyIds: [off], usableKeyIds: [] });
  });

  it('renders a missing model observation as unknown, not zero-pressure idle', async () => {
    key();
    const provider = getProvider('radeon');
    if (!(provider instanceof RadeonProvider)) throw new Error('Missing Radeon provider');
    vi.mocked(provider.getModelPressure).mockReturnValue({
      models: { 'model-a': { state: 'busy', utilization: 75 } },
      observedAt: new Date(NOW).toISOString(), freshness: 'fresh',
    });
    const snapshot = await getProviderCapacity();
    expect(snapshot.models[1].pressure).toMatchObject({
      state: null, utilizationPct: null, observedAt: null, freshness: 'unknown',
    });
  });

  it('marks a minute gate stale independently of a still-recent allocation', async () => {
    const id = key();
    observe(id, { observedAt: NOW - 120_000 });
    observe(id, { metric: 'requests', observedAt: NOW - 120_000 });
    const pool = (await getProviderCapacity()).pools[0];
    expect(pool.allocation.freshness).toBe('fresh');
    expect(pool.rpm).toMatchObject({ freshness: 'stale', remaining: 19, limit: 20 });
  });

  it('retains an expired or old allocation as last reported instead of inventing a refill', async () => {
    const first = key();
    const second = key();
    observe(first, { remaining: 25, resetAt: NOW - 1 });
    observe(second, { remaining: 10, observedAt: NOW - 16 * 60_000 });
    const snapshot = await getProviderCapacity();
    expect(snapshot.pools.map(pool => [pool.allocation.freshness, pool.allocation.remaining])).toEqual([
      ['stale', 0.25], ['stale', 0.1],
    ]);
  });

  it('reuses active model/key cooldowns without reducing the account allowance', async () => {
    const id = key();
    observe(id);
    setCooldown('radeon', 'model-a', id, 5_000);
    const snapshot = await getProviderCapacity();
    expect(snapshot.pools[0].cooldowns).toEqual([{ modelId: 'model-a', expiresAtMs: NOW + 5_000 }]);
    expect(snapshot.pools[0].allocation.remaining).toBeCloseTo(0.99995531, 8);
    expect(snapshot.models[0].keyIds).toEqual([id]);
  });

  it('does not promote low-confidence or future-dated quota into a fresh reading', async () => {
    const first = key();
    const second = key();
    observe(first, { confidence: 0.35 });
    observe(second, { observedAt: NOW + 60_000 });
    expect((await getProviderCapacity()).pools.map(pool => pool.allocation.freshness)).toEqual(['unknown', 'unknown']);
  });

  it('requires dashboard authentication on the new capacity endpoint', async () => {
    const id = key();
    observe(id);
    const token = mintDashboardToken('capacity-api@example.com');
    const server = createApp().listen(0, '127.0.0.1');
    if (!server.listening) await once(server, 'listening');
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('No listening address');
    try {
      const url = `http://127.0.0.1:${address.port}/api/quota/capacity`;
      expect((await fetch(url)).status).toBe(401);
      const response = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
      expect(response.status).toBe(200);
      const body = z.object({ pools: z.array(z.object({ keyId: z.number() })), models: z.array(z.object({ modelId: z.string() })) }).parse(await response.json());
      expect(body.pools.map(pool => pool.keyId)).toEqual([id]);
      expect(body.models.map(model => model.modelId)).toEqual(['model-a', 'model-b']);
    } finally {
      server.close();
    }
  });
});
