import { describe, it, expect, beforeAll } from 'vitest';
import type { Express } from 'express';
import { createApp } from '../../app.js';
import { initDb, getDb } from '../../db/index.js';
import { mintDashboardToken } from '../helpers/auth.js';

// Mapping a logical model to a benchmark is ONE decision about the model, and a
// model on the Compare page is however many provider routes the router unified.
// The endpoint therefore takes a set of routes: sending them one at a time let
// the copies of one model disagree about which benchmark they are.

async function call(app: Express, method: string, path: string, token: string, body?: unknown) {
  const server = app.listen(0, '127.0.0.1');
  if (!server.listening) await new Promise<void>(resolve => server.once('listening', () => resolve()));
  const addr = server.address() as { port: number };
  const res = await fetch(`http://127.0.0.1:${addr.port}${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  server.close();
  let json: unknown = null;
  try { json = JSON.parse(text); } catch { /* non-JSON error body */ }
  return { status: res.status, body: json as Record<string, unknown> };
}

const links = () =>
  getDb().prepare('SELECT platform, model_id, aa_slug, source FROM aa_model_link ORDER BY platform').all() as {
    platform: string; model_id: string; aa_slug: string | null; source: string;
  }[];

describe('PUT/DELETE /api/analysis/link', () => {
  let app: Express;
  let token: string;

  const routes = [
    { platform: 'nvidia', modelId: 'nvidia/nemotron-3-ultra-550b-a55b' },
    { platform: 'ollama', modelId: 'nemotron-3-ultra' },
  ];

  beforeAll(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
    app = createApp();
    token = mintDashboardToken();
  });

  it('maps every route of a merged model in one write', async () => {
    const res = await call(app, 'PUT', '/api/analysis/link', token, { models: routes, aaSlug: 'kimi-k3' });

    expect(res.status).toBe(200);
    expect(res.body.linked).toBe(2);
    expect(links().map(l => [l.platform, l.aa_slug, l.source])).toEqual([
      ['nvidia', 'kimi-k3', 'manual'],
      ['ollama', 'kimi-k3', 'manual'],
    ]);
  });

  it('records "no counterpart" for the whole model, which is not the same as unmapped', async () => {
    // A null slug stops the matcher proposing something on every sync, so it
    // must persist as a row rather than delete one.
    const res = await call(app, 'PUT', '/api/analysis/link', token, { models: routes, aaSlug: null });

    expect(res.status).toBe(200);
    expect(links().every(l => l.aa_slug === null)).toBe(true);
    expect(links()).toHaveLength(2);
  });

  it('hands every route back to the matcher on delete', async () => {
    const res = await call(app, 'DELETE', '/api/analysis/link', token, { models: routes });

    expect(res.status).toBe(200);
    expect(res.body.cleared).toBe(2);
    expect(links()).toHaveLength(0);
  });

  it('rejects an empty set rather than silently writing nothing', async () => {
    const res = await call(app, 'PUT', '/api/analysis/link', token, { models: [], aaSlug: 'kimi-k3' });

    expect(res.status).toBe(400);
    expect(links()).toHaveLength(0);
  });
});
