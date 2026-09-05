import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Express } from 'express';
import { createApp } from '../../app.js';
import { getDb, initDb } from '../../db/index.js';
import { mintDashboardToken } from '../helpers/auth.js';

interface JsonResponse {
  status: number;
  body: Record<string, unknown>;
}

async function call(app: Express, method: string, path: string, token?: string, payload?: unknown): Promise<JsonResponse> {
  const server = app.listen(0, '127.0.0.1');
  if (!server.listening) {
    const { promise, resolve } = Promise.withResolvers<void>();
    server.once('listening', () => resolve());
    await promise;
  }
  const address = server.address() as { port: number };
  const response = await fetch(`http://127.0.0.1:${address.port}${path}`, {
    method,
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(payload === undefined ? {} : { 'Content-Type': 'application/json' }),
    },
    body: payload === undefined ? undefined : JSON.stringify(payload),
  });
  const body = await response.json() as Record<string, unknown>;
  server.close();
  return { status: response.status, body };
}

describe('/api/quota', () => {
  let app: Express;
  let token: string;

  beforeAll(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
    app = createApp();
    token = mintDashboardToken();
  });

  beforeEach(() => {
    getDb().prepare('DELETE FROM quota_policy').run();
    getDb().prepare('DELETE FROM routing_decision').run();
    getDb().prepare("DELETE FROM settings WHERE key = 'quota_routing_mode'").run();
  });

  it('refuses every route without a dashboard session', async () => {
    for (const path of ['/api/quota/policies', '/api/quota/state?platform=groq', '/api/quota/shadow', '/api/quota/decisions', '/api/quota/mode']) {
      const res = await call(app, 'GET', path);
      expect(res.status).toBe(401);
    }
  });

  it('round-trips a policy and resolves it into effective state', async () => {
    const put = await call(app, 'PUT', '/api/quota/policies', token, {
      platform: 'openrouter', limit: 50, periodKind: 'calendar_day', timezone: 'America/Los_Angeles',
    });
    expect(put.status).toBe(200);

    const state = await call(app, 'GET', '/api/quota/state?platform=openrouter', token);
    const quotas = state.body.quotas as { limit: number; source: string; resetAt: string }[];
    const declared = quotas.find(q => q.source === 'operator');
    expect(declared?.limit).toBe(50);
    // Pacific midnight, carried through from the policy's timezone.
    expect(declared?.resetAt.endsWith('Z')).toBe(true);
  });

  it('rejects a rolling policy with no window width', async () => {
    const res = await call(app, 'PUT', '/api/quota/policies', token, {
      platform: 'groq', limit: 10, periodKind: 'rolling',
    });
    expect(res.status).toBe(400);
  });

  it('refuses a client-supplied source so a typed limit cannot pose as measured', async () => {
    const res = await call(app, 'PUT', '/api/quota/policies', token, {
      platform: 'groq', limit: 10, periodKind: 'calendar_day', source: 'provider_api',
    });
    expect(res.status).toBe(400);
  });

  it('requires a platform for effective state', async () => {
    expect((await call(app, 'GET', '/api/quota/state', token)).status).toBe(400);
  });

  it('reports shadow agreement and the current mode', async () => {
    getDb().prepare(`
      INSERT INTO routing_decision (created_at_ms, logical_model, mode, actual_platform, actual_model_id,
        shadow_platform, shadow_model_id, agreed, reason, candidates_json)
      VALUES (?, 'shared model', 'shadow', 'groq', 'm', 'nvidia', 'm', 0, 'most headroom', '[]'),
             (?, 'shared model', 'shadow', 'nvidia', 'm', 'nvidia', 'm', 1, 'most headroom', '[]')
    `).run(Date.now(), Date.now());

    const res = await call(app, 'GET', '/api/quota/shadow', token);
    const stats = res.body.stats as { total: number; agreed: number; agreementRate: number };
    expect(res.body.mode).toBe('shadow');
    expect(stats.total).toBe(2);
    expect(stats.agreementRate).toBe(0.5);
  });

  it('narrows decision history to the rows where the routers disagreed', async () => {
    getDb().prepare(`
      INSERT INTO routing_decision (created_at_ms, logical_model, mode, actual_platform, actual_model_id,
        shadow_platform, shadow_model_id, agreed, reason, candidates_json)
      VALUES (?, 'a', 'shadow', 'groq', 'm', 'nvidia', 'm', 0, 'more headroom', '[]'),
             (?, 'b', 'shadow', 'groq', 'm', 'groq', 'm', 1, 'more headroom', '[]')
    `).run(Date.now(), Date.now());

    const all = await call(app, 'GET', '/api/quota/decisions', token);
    expect((all.body.decisions as unknown[]).length).toBe(2);

    const diverged = await call(app, 'GET', '/api/quota/decisions?disagreed=1', token);
    const rows = diverged.body.decisions as { logicalModel: string; agreed: boolean }[];
    expect(rows).toHaveLength(1);
    expect(rows[0]!.logicalModel).toBe('a');
    expect(rows[0]!.agreed).toBe(false);
  });

  it('switches off → shadow → active only on an explicit call', async () => {
    // The default is shadow and no upgrade path reaches active.
    expect((await call(app, 'GET', '/api/quota/mode', token)).body.mode).toBe('shadow');

    expect((await call(app, 'PUT', '/api/quota/mode', token, { mode: 'off' })).body.mode).toBe('off');
    expect((await call(app, 'PUT', '/api/quota/mode', token, { mode: 'active' })).body.mode).toBe('active');
    expect((await call(app, 'GET', '/api/quota/mode', token)).body.mode).toBe('active');

    expect((await call(app, 'PUT', '/api/quota/mode', token, { mode: 'chaotic' })).status).toBe(400);
  });
});
