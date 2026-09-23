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
import { initDb, getDb, getUnifiedApiKey } from '../../db/index.js';
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

// What the fleet was GIVEN, priced at the benchmark equivalent's published
// rates. The figure is not our spend — a free route costs us nothing, which is
// the point — so the behaviour worth defending is that it is priced from
// aa_model, that an unpriced route reads as unknown rather than zero, and that
// a route billing money is reported apart from the value rather than inside it.
describe('clifree fleet value', () => {
  let app: Express;
  let token: string;

  const ValueResponse = z.object({
    value: z.array(z.object({
      machine: z.string(),
      requests: z.number(),
      inputTokens: z.number(),
      outputTokens: z.number(),
      valueUsd: z.number().nullable(),
      unpricedSpecs: z.number(),
      reportedCostUsd: z.number(),
    })),
  });

  /** An AA row with published per-million rates, as benchmark sync would leave it. */
  function seedBenchmark(slug: string, priceIn: number | null, priceOut: number | null): void {
    getDb().prepare(
      `INSERT INTO aa_model (slug, name, price_1m_input, price_1m_output)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(slug) DO UPDATE SET price_1m_input = excluded.price_1m_input,
                                       price_1m_output = excluded.price_1m_output`,
    ).run(slug, slug, priceIn, priceOut);
  }

  const today = new Date().toISOString().slice(0, 10);
  const usage = (spec: string, inputTokens: number, outputTokens: number, reportedCostUsd = 0, day = today) =>
    ({ spec, day, requests: 1, inputTokens, outputTokens, reportedCostUsd });

  const valueFor = async (machine: string) => {
    const { body } = await call(app, 'GET', '/api/clifree-fleet', token);
    return ValueResponse.parse(body).value.find(v => v.machine === machine);
  };

  beforeAll(async () => {
    initDb(':memory:');
    app = await createApp();
    token = await mintDashboardToken();
  });

  it('prices delivered inference at the benchmark equivalent\'s published rates', async () => {
    // $3/M in, $15/M out on 2M in + 1M out = 6.00 + 15.00 = $21.00 of inference
    // we were handed for nothing.
    seedBenchmark('priced-model', 3, 15);
    await call(app, 'POST', '/api/clifree-fleet', token, {
      machine: 'studio', observedAtMs: Date.now(),
      routes: [route('opencode:priced-free', { benchmarkSlug: 'priced-model' })],
      usage: [usage('opencode:priced-free', 2_000_000, 1_000_000)],
    });

    expect((await valueFor('studio'))?.valueUsd).toBe(21);
  });

  it('reads unknown, not zero, when no route maps to a priced benchmark', async () => {
    // An unrated route did real work whose value we cannot state. Reporting $0
    // would claim the work was worthless, which is a different assertion.
    await call(app, 'POST', '/api/clifree-fleet', token, {
      machine: 'unrated-box', observedAtMs: Date.now(),
      routes: [route('opencode:unrated-free', { benchmarkSlug: null })],
      usage: [usage('opencode:unrated-free', 500_000, 10_000)],
    });

    const row = await valueFor('unrated-box');
    expect(row?.valueUsd).toBeNull();
    // The tokens are still counted: the consumption is known, only its price is not.
    expect(row?.inputTokens).toBe(500_000);
    expect(row?.unpricedSpecs).toBe(1);
  });

  it('values what it can and says how much it could not', async () => {
    seedBenchmark('half-priced', 1, 2);
    await call(app, 'POST', '/api/clifree-fleet', token, {
      machine: 'mixed', observedAtMs: Date.now(),
      routes: [
        route('opencode:known-free', { benchmarkSlug: 'half-priced' }),
        route('opencode:mystery-free', { benchmarkSlug: null }),
      ],
      usage: [
        usage('opencode:known-free', 1_000_000, 0),
        usage('opencode:mystery-free', 9_000_000, 0),
      ],
    });

    const row = await valueFor('mixed');
    // Only the priced half is valued...
    expect(row?.valueUsd).toBe(1);
    // ...and the partial figure is labelled as partial, so it is never read as
    // the machine's whole contribution.
    expect(row?.unpricedSpecs).toBe(1);
  });

  it('keeps what an agent billed out of the value figure', async () => {
    seedBenchmark('billed-model', 10, 10);
    await call(app, 'POST', '/api/clifree-fleet', token, {
      machine: 'billed-box', observedAtMs: Date.now(),
      routes: [route('cline:vendor/billed:free', { benchmarkSlug: 'billed-model' })],
      usage: [usage('cline:vendor/billed:free', 1_000_000, 0, 0.42)],
    });

    const row = await valueFor('billed-box');
    // Value is the inference's worth; the 0.42 the agent charged is an alarm
    // reported beside it. Summing them would net a real cost against a notional
    // benefit and produce a number that is neither.
    expect(row?.valueUsd).toBe(10);
    expect(row?.reportedCostUsd).toBe(0.42);
  });

  it('reprices when the operator remaps a route to another benchmark', async () => {
    seedBenchmark('cheap-model', 1, 1);
    seedBenchmark('dear-model', 100, 100);
    await call(app, 'POST', '/api/clifree-fleet', token, {
      machine: 'remap-box', observedAtMs: Date.now(),
      routes: [route('opencode:remap-free', { benchmarkSlug: 'cheap-model' })],
      usage: [usage('opencode:remap-free', 1_000_000, 0)],
    });
    expect((await valueFor('remap-box'))?.valueUsd).toBe(1);

    // The operator says this route is really the dearer model. The panel's
    // mapping and its value must not disagree.
    await call(app, 'PUT', '/api/clifree-fleet/link', token, {
      spec: 'opencode:remap-free', aaSlug: 'dear-model',
    });
    expect((await valueFor('remap-box'))?.valueUsd).toBe(100);
  });

  it('leaves stored usage alone when an older reporter sends none', async () => {
    // A reporter that predates usage reporting still delivers a roster. Treating
    // its silence as "this machine has done nothing" would wipe a real figure on
    // the next timer tick.
    seedBenchmark('kept-model', 2, 2);
    await call(app, 'POST', '/api/clifree-fleet', token, {
      machine: 'old-reporter', observedAtMs: Date.now(),
      routes: [route('opencode:kept-free', { benchmarkSlug: 'kept-model' })],
      usage: [usage('opencode:kept-free', 1_000_000, 0)],
    });
    expect((await valueFor('old-reporter'))?.valueUsd).toBe(2);

    await call(app, 'POST', '/api/clifree-fleet', token, {
      machine: 'old-reporter', observedAtMs: Date.now() + 1,
      routes: [route('opencode:kept-free', { benchmarkSlug: 'kept-model' })],
    });
    expect((await valueFor('old-reporter'))?.valueUsd).toBe(2);
  });

  it('rejects a usage row whose spec has no provider prefix', async () => {
    const res = await call(app, 'POST', '/api/clifree-fleet', token, {
      machine: 'studio', observedAtMs: Date.now(), routes: [],
      usage: [{ spec: 'nocolon', day: today, requests: 1, inputTokens: 1, outputTokens: 1 }],
    });
    expect(res.status).toBe(400);
    expect(ErrorResponse.parse(res.body).error).toMatch(/provider:id/);
  });

  it('rejects a malformed day rather than filing tokens under a date it cannot read', async () => {
    const res = await call(app, 'POST', '/api/clifree-fleet', token, {
      machine: 'studio', observedAtMs: Date.now(), routes: [],
      usage: [{ ...usage('opencode:x-free', 1, 1), day: '23/09/2026' }],
    });
    expect(res.status).toBe(400);
    expect(ErrorResponse.parse(res.body).error).toMatch(/YYYY-MM-DD/);
  });

  it('windows usage by the analytics range, and covers all history without one', async () => {
    // The offloaded-inference card adds this to the proxy's own figures for ONE
    // range. A bucket outside the window leaking in would overstate the total.
    seedBenchmark('window-model', 1, 0);
    const old = new Date(Date.now() - 100 * 86_400_000).toISOString().slice(0, 10);
    await call(app, 'POST', '/api/clifree-fleet', token, {
      machine: 'window-box', observedAtMs: Date.now(),
      routes: [route('opencode:window-free', { benchmarkSlug: 'window-model' })],
      usage: [usage('opencode:window-free', 1_000_000, 0), usage('opencode:window-free', 5_000_000, 0, 0, old)],
    });

    const inRange = await call(app, 'GET', '/api/clifree-fleet?range=30d', token);
    const row30 = ValueResponse.parse(inRange.body).value.find(v => v.machine === 'window-box');
    expect(row30?.inputTokens).toBe(1_000_000);
    expect(row30?.valueUsd).toBe(1);
    expect((await valueFor('window-box'))?.inputTokens).toBe(6_000_000);
  });

  it('sets undated lifetime totals aside instead of filing them under one day', async () => {
    // An older reporter sends lifetime totals with no day. Folding them into
    // today would inflate every window that includes today; they are ignored,
    // the roster is still taken, and the machine's dated history survives.
    seedBenchmark('lifetime-model', 1, 0);
    await call(app, 'POST', '/api/clifree-fleet', token, {
      machine: 'upgrading-box', observedAtMs: Date.now(),
      routes: [route('opencode:life-free', { benchmarkSlug: 'lifetime-model' })],
      usage: [usage('opencode:life-free', 1_000_000, 0)],
    });

    const res = await call(app, 'POST', '/api/clifree-fleet', token, {
      machine: 'upgrading-box', observedAtMs: Date.now() + 1,
      routes: [route('opencode:life-free', { benchmarkSlug: 'lifetime-model' })],
      usage: [{ spec: 'opencode:life-free', requests: 9, inputTokens: 9_000_000, outputTokens: 0 }],
    });
    expect(res.status).toBe(200);
    expect(z.object({ usageIgnored: z.string() }).parse(res.body).usageIgnored).toMatch(/older reporter/);
    expect((await valueFor('upgrading-box'))?.inputTokens).toBe(1_000_000);
  });

  it('maps each machine to the device the Analytics tabs use', async () => {
    // The proxy's device comes from its user agent; the fleet's from a hostname.
    // Both must land on one label or a tab mixes two machines.
    const Device = z.object({ value: z.array(z.object({ machine: z.string(), device: z.string() })) });
    for (const machine of ['Jamess-MacBook-Pro', 'Mac-Studio-2']) {
      await call(app, 'POST', '/api/clifree-fleet', token, {
        machine, observedAtMs: Date.now(), routes: [],
        usage: [usage('cline:vendor/dev:free', 10, 1)],
      });
    }
    const { body } = await call(app, 'GET', '/api/clifree-fleet', token);
    const device = (m: string) => Device.parse(body).value.find(v => v.machine === m)?.device;
    expect(device('Jamess-MacBook-Pro')).toBe('MacBook Pro');
    expect(device('Mac-Studio-2')).toBe('Mac Studio');
  });

  it('reports each route with the class and score its machine gives it, priced or not', async () => {
    seedBenchmark('route-model', 2, 10);
    await call(app, 'POST', '/api/clifree-fleet', token, {
      machine: 'route-box', observedAtMs: Date.now(),
      routes: [
        route('opencode:good-free', { benchmarkSlug: 'route-model', class: 'sol-class', intelligence: 48.1 }),
        route('cline:vendor/odd:free', { benchmarkSlug: null }),
      ],
      usage: [usage('opencode:good-free', 1_000, 100), usage('cline:vendor/odd:free', 50, 5)],
    });
    const Usage = z.object({ usage: z.array(z.object({
      machine: z.string(), spec: z.string(), class: z.string().nullable(),
      intelligence: z.number().nullable(), valueUsd: z.number().nullable(),
    })) });
    const { body } = await call(app, 'GET', '/api/clifree-fleet', token);
    const rows = Usage.parse(body).usage.filter(u => u.machine === 'route-box');
    const good = rows.find(r => r.spec === 'opencode:good-free');
    expect(good).toMatchObject({ class: 'sol-class', intelligence: 48.1 });
    // 1,000 × $2/M + 100 × $10/M = $0.003 — kept to four places, not rounded to $0.00.
    expect(good?.valueUsd).toBe(0.003);
    expect(rows.find(r => r.spec === 'cline:vendor/odd:free')?.valueUsd).toBeNull();
  });
});
