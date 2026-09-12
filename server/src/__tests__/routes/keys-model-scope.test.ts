import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import type { Express } from 'express';
import { createApp } from '../../app.js';
import { effectiveRouteLimits, upsertQuotaPolicy, listQuotaPolicies, invalidateQuotaPolicyCache } from '../../services/quota-policy.js';
import { initDb, getDb } from '../../db/index.js';
import { encrypt } from '../../lib/crypto.js';
import { mintDashboardToken, isGatedApiPath } from '../helpers/auth.js';

let dashToken = '';

async function request(app: Express, method: string, path: string, body?: any) {
  const server = app.listen(0, '127.0.0.1');
  if (!server.listening) await new Promise<void>(resolve => server.once('listening', () => resolve()));
  const addr = server.address() as any;
  const url = `http://127.0.0.1:${addr.port}${path}`;

  const res = await fetch(url, {
    method,
    headers: {
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...(isGatedApiPath(path) ? { Authorization: `Bearer ${dashToken}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  const data = await res.json().catch(() => null);
  server.close();
  return { status: res.status, body: data };
}

// PATCH /api/keys/:id modelScope handling (#657).
describe('Keys API — model scope', () => {
  let app: Express;

  beforeAll(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
    app = createApp();
    dashToken = mintDashboardToken();
  });

  beforeEach(() => {
    getDb().prepare("DELETE FROM models WHERE platform = 'custom'").run();
    getDb().prepare('DELETE FROM api_keys').run();
  });

  function insertKey(platform = 'groq'): number {
    const { encrypted, iv, authTag } = encrypt('sk-test');
    const result = getDb().prepare(`
      INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled)
      VALUES (?, 'test', ?, ?, ?, 'healthy', 1)
    `).run(platform, encrypted, iv, authTag);
    return Number(result.lastInsertRowid);
  }

  it('sets a scope and surfaces it on the key list', async () => {
    const id = insertKey();
    const patch = await request(app, 'PATCH', `/api/keys/${id}`, { modelScope: ['llama-3.3-70b', 'qwen-2.5'] });
    expect(patch.status).toBe(200);
    expect(patch.body.modelScope).toEqual(['llama-3.3-70b', 'qwen-2.5']);

    const list = await request(app, 'GET', '/api/keys');
    expect(list.status).toBe(200);
    expect(list.body.find((k: any) => k.id === id).modelScope).toEqual(['llama-3.3-70b', 'qwen-2.5']);
  });

  it('dedupes repeated ids', async () => {
    const id = insertKey();
    const patch = await request(app, 'PATCH', `/api/keys/${id}`, { modelScope: ['m1', 'm1', 'm2'] });
    expect(patch.status).toBe(200);
    expect(patch.body.modelScope).toEqual(['m1', 'm2']);
  });

  it('null clears the scope', async () => {
    const id = insertKey();
    await request(app, 'PATCH', `/api/keys/${id}`, { modelScope: ['m1'] });
    const patch = await request(app, 'PATCH', `/api/keys/${id}`, { modelScope: null });
    expect(patch.status).toBe(200);
    expect(patch.body.modelScope).toBeNull();

    const row = getDb().prepare('SELECT model_scope_json FROM api_keys WHERE id = ?').get(id) as any;
    expect(row.model_scope_json).toBeNull();

    const list = await request(app, 'GET', '/api/keys');
    expect(list.body.find((k: any) => k.id === id).modelScope).toBeNull();
  });

  it('an empty array clears the scope too', async () => {
    const id = insertKey();
    await request(app, 'PATCH', `/api/keys/${id}`, { modelScope: ['m1'] });
    const patch = await request(app, 'PATCH', `/api/keys/${id}`, { modelScope: [] });
    expect(patch.status).toBe(200);
    expect(patch.body.modelScope).toBeNull();
    const row = getDb().prepare('SELECT model_scope_json FROM api_keys WHERE id = ?').get(id) as any;
    expect(row.model_scope_json).toBeNull();
  });

  it('leaves the scope alone when only other fields are patched', async () => {
    const id = insertKey();
    await request(app, 'PATCH', `/api/keys/${id}`, { modelScope: ['m1'] });
    await request(app, 'PATCH', `/api/keys/${id}`, { label: 'renamed' });
    const list = await request(app, 'GET', '/api/keys');
    expect(list.body.find((k: any) => k.id === id).modelScope).toEqual(['m1']);
  });

  it('persists and surfaces per-account provider limits independently', async () => {
    const id = insertKey();
    const patch = await request(app, 'PATCH', `/api/keys/${id}`, {
      providerRpmLimit: 30,
      providerRpdLimit: 750,
      providerTpdLimit: 125000,
    });
    expect(patch.status).toBe(200);

    const list = await request(app, 'GET', '/api/keys');
    const key = list.body.find((candidate: any) => candidate.id === id);
    expect(key).toMatchObject({
      providerRpmLimit: 30,
      providerRpdLimit: 750,
      providerTpdLimit: 125000,
    });

    const clear = await request(app, 'PATCH', `/api/keys/${id}`, {
      providerRpmLimit: null,
      providerRpdLimit: 0,
      providerTpdLimit: null,
    });
    expect(clear.status).toBe(200);
    expect(clear.body).toMatchObject({ providerRpmLimit: null, providerRpdLimit: 0, providerTpdLimit: null });
  });

  it('atomically updates provider-model limits through the key settings boundary', async () => {
    const id = insertKey();
    const model = getDb().prepare("SELECT id FROM models WHERE platform = 'groq' AND model_id = 'openai/gpt-oss-120b'").get() as { id: number };

    const patch = await request(app, 'PATCH', `/api/keys/${id}`, {
      providerRpdLimit: 900,
      modelLimits: [{
        modelDbId: model.id,
        rpmLimit: 30,
        rpdLimit: 1000,
        tpmLimit: 8000,
        tpdLimit: 200000,
      }],
    });

    expect(patch.status).toBe(200);
    expect(patch.body.modelLimits).toEqual([{ modelDbId: model.id, rpmLimit: 30, rpdLimit: 1000, tpmLimit: 8000, tpdLimit: 200000 }]);
    expect(getDb().prepare('SELECT rpm_limit, rpd_limit, tpm_limit, tpd_limit FROM models WHERE id = ?').get(model.id)).toEqual({
      rpm_limit: 30,
      rpd_limit: 1000,
      tpm_limit: 8000,
      tpd_limit: 200000,
    });
    const overrides = getDb().prepare("SELECT overrides_json FROM model_overrides WHERE platform = 'groq' AND model_id = 'openai/gpt-oss-120b'").get() as { overrides_json: string };
    expect(JSON.parse(overrides.overrides_json)).toMatchObject({ rpmLimit: 30, rpdLimit: 1000, tpmLimit: 8000, tpdLimit: 200000 });
  });

  it('a typed limit outranks a measured one at the routing gate', async () => {
    // The whole point of typing it. Stored only as a catalogue column it
    // resolves BELOW an operator policy, so a measured 5/min would keep
    // gating a model the operator had just set to 30 — the number on screen
    // and the number enforced would disagree with no way to tell.
    const id = insertKey();
    const model = getDb().prepare("SELECT id FROM models WHERE platform = 'groq' AND model_id = 'openai/gpt-oss-120b'").get() as { id: number };
    upsertQuotaPolicy({
      platform: 'groq', modelId: 'openai/gpt-oss-120b', endpointScope: null, scope: 'model',
      metric: 'requests', limit: 5, periodKind: 'rolling', periodMs: 60_000, timezone: 'UTC', anchorDay: null,
    });
    invalidateQuotaPolicyCache();
    expect(effectiveRouteLimits('groq', 'openai/gpt-oss-120b').rpm).toBe(5);

    await request(app, 'PATCH', `/api/keys/${id}`, {
      modelLimits: [{ modelDbId: model.id, rpmLimit: 30, rpdLimit: 900 }],
    });
    invalidateQuotaPolicyCache();

    const limits = effectiveRouteLimits('groq', 'openai/gpt-oss-120b');
    expect([limits.rpm, limits.rpd]).toEqual([30, 900]);
  });

  it('clearing a limit removes the declaration rather than storing a zero', async () => {
    // "No limit I know of" and "a limit of nothing" are different claims, and
    // leaving a stale policy behind would keep gating on a number the operator
    // has just erased.
    const id = insertKey();
    const model = getDb().prepare("SELECT id FROM models WHERE platform = 'groq' AND model_id = 'openai/gpt-oss-120b'").get() as { id: number };
    await request(app, 'PATCH', `/api/keys/${id}`, { modelLimits: [{ modelDbId: model.id, rpmLimit: 30 }] });
    await request(app, 'PATCH', `/api/keys/${id}`, { modelLimits: [{ modelDbId: model.id, rpmLimit: null }] });
    invalidateQuotaPolicyCache();

    // Only the cleared window: this suite shares one database, and a daily
    // policy written by an earlier case is not this assertion's business.
    const perMinute = listQuotaPolicies('groq').filter(p =>
      p.modelId === 'openai/gpt-oss-120b' && p.metric === 'requests' && p.periodKind === 'rolling');
    expect(perMinute).toEqual([]);
    expect(effectiveRouteLimits('groq', 'openai/gpt-oss-120b').rpm).not.toBe(30);
  });

  it('rejects cross-provider model-limit edits without partially saving the key', async () => {
    const id = insertKey();
    const google = getDb().prepare("SELECT id FROM models WHERE platform = 'google' LIMIT 1").get() as { id: number };

    const patch = await request(app, 'PATCH', `/api/keys/${id}`, {
      providerRpdLimit: 123,
      modelLimits: [{ modelDbId: google.id, rpmLimit: 1 }],
    });

    expect(patch.status).toBe(400);
    expect(getDb().prepare('SELECT provider_rpd_limit FROM api_keys WHERE id = ?').get(id)).toEqual({ provider_rpd_limit: null });
  });

  it('rejects model-limit edits across custom endpoint identities', async () => {
    const requestingKey = insertKey('custom');
    const owningKey = insertKey('custom');
    const model = getDb().prepare(`
      INSERT INTO models (
        platform, model_id, display_name, intelligence_rank, speed_rank,
        key_id, source, endpoint_scope, rpm_limit
      )
      VALUES ('custom', 'private-model', 'Private model', 50, 50, ?, 'custom', 'http://other-endpoint.test/v1', 12)
    `).run(owningKey);

    const patch = await request(app, 'PATCH', `/api/keys/${requestingKey}`, {
      providerRpdLimit: 123,
      modelLimits: [{ modelDbId: Number(model.lastInsertRowid), rpmLimit: 1 }],
    });

    expect(patch.status).toBe(400);
    expect(getDb().prepare('SELECT provider_rpd_limit FROM api_keys WHERE id = ?').get(requestingKey)).toEqual({ provider_rpd_limit: null });
    expect(getDb().prepare('SELECT rpm_limit FROM models WHERE id = ?').get(Number(model.lastInsertRowid))).toEqual({ rpm_limit: 12 });
  });

  it('rejects malformed payloads', async () => {
    const id = insertKey();
    for (const modelScope of ['not-an-array', [''], [42], [{ id: 'x' }], ['x'.repeat(201)], Array.from({ length: 501 }, (_, i) => `m${i}`)]) {
      const patch = await request(app, 'PATCH', `/api/keys/${id}`, { modelScope });
      expect(patch.status, JSON.stringify(modelScope).slice(0, 60)).toBe(400);
    }
    // A body naming none of the updatable fields is still rejected.
    const empty = await request(app, 'PATCH', `/api/keys/${id}`, {});
    expect(empty.status).toBe(400);
  });

  it('404s on a missing key', async () => {
    const patch = await request(app, 'PATCH', '/api/keys/999999', { modelScope: ['m1'] });
    expect(patch.status).toBe(404);
  });
});
