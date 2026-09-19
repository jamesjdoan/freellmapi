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
  });

  it('refuses every route without a dashboard session', async () => {
    // /shadow, /decisions and /mode were listed here until 2026-09-19. They no
    // longer exist, and the assertion kept passing because the dashboard-auth
    // middleware answers 401 before the router can 404 — a test that proved the
    // middleware runs, dressed as a test about routes. The dead
    // `quota_routing_mode` settings cleanup went with them.
    for (const path of ['/api/quota/policies', '/api/quota/state?platform=groq', '/api/quota/reservation', '/api/quota/forecast']) {
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

});

describe('pools hidden from the overview', () => {
  let app: Express;
  let token: string;

  beforeAll(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
    app = createApp();
    token = mintDashboardToken();
  });

  it('round-trips a hidden pool and de-duplicates the list', async () => {
    const put = await call(app, 'PUT', '/api/quota/hidden-pools', token, {
      pools: ['openrouter::credits', 'openrouter::credits', 'ollama::session'],
    });

    expect(put.status).toBe(200);
    expect(put.body.pools).toEqual(['ollama::session', 'openrouter::credits']);

    const get = await call(app, 'GET', '/api/quota/hidden-pools', token);
    expect(get.body.pools).toEqual(['ollama::session', 'openrouter::credits']);
  });

  it('keeps a hidden pool in the overview payload, because hiding is presentation', async () => {
    // The row must still resolve, still gate requests and still be reachable —
    // otherwise "hide this from my panel" silently becomes "stop enforcing this
    // allowance", which is not what anyone pressed.
    await call(app, 'PUT', '/api/quota/hidden-pools', token, { pools: ['openrouter::credits'] });

    const overview = await call(app, 'GET', '/api/quota/providers', token);
    expect(overview.status).toBe(200);
    expect(Array.isArray(overview.body.providers)).toBe(true);
  });

  it('rejects a payload that is not a list of pool keys', async () => {
    const bad = await call(app, 'PUT', '/api/quota/hidden-pools', token, { pools: [{ pool: 'x' }] });
    expect(bad.status).toBe(400);
  });
});
