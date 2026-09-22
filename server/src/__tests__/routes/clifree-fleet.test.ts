// Fleet telemetry route — delivery, replacement scoping, and the extension gate.
//
// The behaviour worth defending here is not "a POST stores rows". It is that a
// delivery replaces ONE machine's rows and leaves every other machine alone:
// the whole point of the fleet view is that the Studio and the MBP hold
// different facts about the same free accounts, and a delivery that clobbered
// both would silently destroy the comparison the panel exists to show.

import { describe, it, expect, beforeAll } from 'vitest';
import { z } from 'zod';
import type { Express } from 'express';
import { createApp } from '../../app.js';
import { initDb, getUnifiedApiKey } from '../../db/index.js';
import { mintDashboardToken } from '../helpers/auth.js';

// Validated once at the boundary, so every read below is typed rather than
// asserted. An inline cast would fabricate the shape and then trust it.
const FleetResponse = z.object({
  routes: z.array(z.object({
    machine: z.string(),
    spec: z.string(),
    provider: z.string(),
    coolingReason: z.string().nullable(),
  })),
});
const ErrorResponse = z.object({ error: z.string() });
const PostResponse = z.object({ machine: z.string(), routes: z.number() });

async function call(
  app: Express,
  method: 'GET' | 'POST',
  path: string,
  token: string,
  body?: unknown,
) {
  const server = app.listen(0, '127.0.0.1');
  if (!server.listening) await new Promise<void>(resolve => server.once('listening', () => resolve()));
  const addr = server.address() as { port: number };
  const res = await fetch(`http://127.0.0.1:${addr.port}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await res.text();
  server.close();
  let json: unknown = null;
  try { json = JSON.parse(text); } catch { /* non-JSON body stays null */ }
  return { status: res.status, body: json as unknown };
}

const route = (spec: string, extra: Record<string, unknown> = {}) => ({
  spec, class: 'below-luna', intelligence: 9.9, matchQuality: 'exact',
  reachability: 'ok', ...extra,
});

describe('clifree fleet telemetry', () => {
  let app: Express;
  let token: string;

  beforeAll(async () => {
    initDb(':memory:');
    app = await createApp();
    token = await mintDashboardToken();
  });

  it('stores a delivery and reads it back', async () => {
    const post = await call(app, 'POST', '/api/clifree-fleet', token, {
      machine: 'studio',
      observedAtMs: Date.now(),
      routes: [route('cline:cohere/north-mini-code:free')],
    });
    expect(post.status).toBe(200);
    expect(PostResponse.parse(post.body)).toEqual({ machine: 'studio', routes: 1 });

    const get = await call(app, 'GET', '/api/clifree-fleet', token);
    expect(get.status).toBe(200);
    expect(FleetResponse.parse(get.body).routes).toHaveLength(1);
  });

  it('splits provider on the FIRST colon, since Cline ids contain their own', async () => {
    await call(app, 'POST', '/api/clifree-fleet', token, {
      machine: 'studio', observedAtMs: Date.now(),
      routes: [route('cline:cohere/north-mini-code:free')],
    });
    const { body } = await call(app, 'GET', '/api/clifree-fleet', token);
    const row = FleetResponse.parse(body).routes[0];
    expect(row.provider).toBe('cline');
    expect(row.spec).toBe('cline:cohere/north-mini-code:free');
  });

  it('replaces only the reporting machine, leaving other machines intact', async () => {
    const now = Date.now();
    await call(app, 'POST', '/api/clifree-fleet', token, {
      machine: 'studio', observedAtMs: now,
      routes: [route('opencode:a-free'), route('opencode:b-free')],
    });
    await call(app, 'POST', '/api/clifree-fleet', token, {
      machine: 'mbp', observedAtMs: now,
      routes: [route('opencode:a-free', { coolingUntilMs: now + 60_000, coolingReason: 'quota' })],
    });

    // The Studio re-reports with b-free gone from its roster.
    await call(app, 'POST', '/api/clifree-fleet', token, {
      machine: 'studio', observedAtMs: now + 1, routes: [route('opencode:a-free')],
    });

    const { body } = await call(app, 'GET', '/api/clifree-fleet', token);
    const rows = FleetResponse.parse(body).routes;

    // The retired route is gone from the Studio: a roster is a statement about
    // now, not an append-only log.
    expect(rows.filter(r => r.machine === 'studio').map(r => r.spec)).toEqual(['opencode:a-free']);

    // The MBP is untouched, and still holds its own cooldown for the SAME spec.
    const mbp = rows.filter(r => r.machine === 'mbp');
    expect(mbp).toHaveLength(1);
    expect(mbp[0].coolingReason).toBe('quota');
  });

  it('rejects a spec with no provider prefix', async () => {
    const res = await call(app, 'POST', '/api/clifree-fleet', token, {
      machine: 'studio', observedAtMs: Date.now(), routes: [{ spec: 'nocolon' }],
    });
    expect(res.status).toBe(400);
    expect(ErrorResponse.parse(res.body).error).toMatch(/provider:id/);
  });

  it('rejects an unknown reachability rather than storing a guess', async () => {
    const res = await call(app, 'POST', '/api/clifree-fleet', token, {
      machine: 'studio', observedAtMs: Date.now(),
      routes: [route('opencode:a-free', { reachability: 'probably-fine' })],
    });
    expect(res.status).toBe(400);
  });

  it('requires auth', async () => {
    const server = app.listen(0, '127.0.0.1');
    if (!server.listening) await new Promise<void>(r => server.once('listening', () => r()));
    const addr = server.address() as { port: number };
    const res = await fetch(`http://127.0.0.1:${addr.port}/api/clifree-fleet`);
    server.close();
    expect(res.status).toBe(401);
  });

  it('accepts the unified API key, so an unattended reporter needs no session', async () => {
    // Why this path exists: sessions expire after 30 days, so a reporter on a
    // timer would authenticate today and fail silently next month — and the
    // panel would show its machine as stale rather than broken.
    const unified = getUnifiedApiKey();
    expect(unified).toBeTruthy();

    const res = await call(app, 'POST', '/api/clifree-fleet', unified as string, {
      machine: 'mbp-over-ssh', observedAtMs: Date.now(),
      routes: [route('cline:cohere/north-mini-code:free')],
    });
    expect(res.status).toBe(200);
    expect(PostResponse.parse(res.body).machine).toBe('mbp-over-ssh');
  });

  it('rejects a wrong credential with the same 401 as none at all', async () => {
    const res = await call(app, 'POST', '/api/clifree-fleet', 'not-the-key', {
      machine: 'x', observedAtMs: Date.now(), routes: [],
    });
    expect(res.status).toBe(401);
  });
});
