import { describe, it, expect, beforeAll } from 'vitest';
import type { Express } from 'express';
import { createApp } from '../../app.js';
import { initDb, getDb } from '../../db/index.js';
import { mintDashboardToken } from '../helpers/auth.js';

// AIHubMix, 2026-09-25: registered as https://api.inferera.com without /v1.
// That URL's /models answers the marketing site's HTML, so the endpoint could
// never serve, and correcting it meant deleting it and losing its models.

let dashToken = '';
async function request(app: Express, method: string, path: string, body?: unknown) {
  const server = app.listen(0, '127.0.0.1');
  if (!server.listening) await new Promise<void>(resolve => server.once('listening', () => resolve()));
  const { port } = server.address() as { port: number };
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    headers: { Authorization: `Bearer ${dashToken}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => null);
  server.close();
  return { status: res.status, body: data };
}

describe('correcting a custom endpoint base URL', () => {
  let app: Express;
  beforeAll(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
    app = createApp();
    dashToken = mintDashboardToken();
  });

  it('moves the key and everything recorded against its endpoint, and refuses clashes and catalogue keys', async () => {
    // Loopback endpoints pass the URL guard, which is what makes this testable offline.
    const wrong = 'http://127.0.0.1:6201';
    const right = 'http://127.0.0.1:6201/v1';
    const reg = await request(app, 'POST', '/api/keys/custom', { baseUrl: wrong, model: 'hub-model-free' });
    expect(reg.status).toBe(201);
    const db = getDb();
    const keyId = Number(db.prepare("SELECT key_id FROM models WHERE platform = 'custom' AND model_id = 'hub-model-free'").pluck().get());
    db.prepare(`INSERT INTO quota_policy (platform, model_id, endpoint_scope, scope, metric, limit_value, period_kind, source)
                VALUES ('custom', 'hub-model-free', ?, 'model', 'requests', 5, 'calendar_day', 'operator')`).run(wrong);

    const moved = await request(app, 'POST', `/api/keys/${keyId}/base-url`, { baseUrl: `${right}/` });
    expect(moved.status).toBe(200);
    // Normalised: the trailing slash is not part of the endpoint's identity.
    expect(moved.body).toEqual({ success: true, baseUrl: right, moved: 1 });
    expect(db.prepare('SELECT base_url FROM api_keys WHERE id = ?').pluck().get(keyId)).toBe(right);
    expect(db.prepare("SELECT endpoint_scope FROM models WHERE model_id = 'hub-model-free'").pluck().get()).toBe(right);
    // The limit followed the endpoint instead of being stranded on the old address.
    expect(db.prepare('SELECT COUNT(*) FROM quota_policy WHERE endpoint_scope = ?').pluck().get(wrong)).toBe(0);
    expect(db.prepare('SELECT COUNT(*) FROM quota_policy WHERE endpoint_scope = ?').pluck().get(right)).toBe(1);

    // A second endpoint may not take an address the first already uses.
    const other = await request(app, 'POST', '/api/keys/custom', { baseUrl: 'http://127.0.0.1:6202/v1', model: 'other-model' });
    const otherKey = Number(db.prepare("SELECT key_id FROM models WHERE model_id = 'other-model'").pluck().get());
    expect(other.status).toBe(201);
    expect((await request(app, 'POST', `/api/keys/${otherKey}/base-url`, { baseUrl: right })).status).toBe(409);

    // A catalogue provider has no base URL to edit.
    const groq = Number(db.prepare(`INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled)
                                    VALUES ('groq', 'g', 'x', 'x', 'x', 'healthy', 1)`).run().lastInsertRowid);
    expect((await request(app, 'POST', `/api/keys/${groq}/base-url`, { baseUrl: right })).status).toBe(400);
  });
});
