import { describe, it, expect, beforeAll } from 'vitest';
import type { Express } from 'express';
import { createApp } from '../../app.js';
import { getDb, initDb } from '../../db/index.js';
import { mintDashboardToken } from '../helpers/auth.js';

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

describe('chain minimums', () => {
  let app: Express;

  beforeAll(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
    app = createApp();
    dashToken = mintDashboardToken();
  });

  it('saves revisions in order, refuses a stale save, and keeps every revision readable', async () => {
    const first = await request(app, 'GET', '/api/chain-minimums');
    expect(first.status).toBe(200);
    // Never saved: the defaults are a draft, not a decision.
    expect(first.body.doc.revision).toBe(0);
    expect(first.body.doc.savedAt).toBeNull();
    // Fast-Lane takes minimums like every other chain.
    expect(first.body.doc.chains['Fast-Lane']).toMatchObject({ general: 15, either: [] });

    const chains = { ...first.body.doc.chains, Apex: { ...first.body.doc.chains.Apex, general: 40 } };
    const saved = await request(app, 'PUT', '/api/chain-minimums', { expectedRevision: 0, chains });
    expect(saved.status).toBe(200);
    expect(saved.body.doc.revision).toBe(1);

    // A second editor still holding revision 0 must not overwrite revision 1.
    const stale = await request(app, 'PUT', '/api/chain-minimums', {
      expectedRevision: 0,
      chains: { ...chains, Apex: { ...chains.Apex, general: 50 } },
    });
    expect(stale.status).toBe(409);
    expect(stale.body.error.current).toBe(1);

    const again = await request(app, 'PUT', '/api/chain-minimums', {
      expectedRevision: 1,
      chains: { ...chains, Apex: { ...chains.Apex, general: 42 } },
    });
    expect(again.body.doc.revision).toBe(2);

    const current = await request(app, 'GET', '/api/chain-minimums');
    expect(current.body.doc.chains.Apex.general).toBe(42);
    expect(current.body.revisions.map((r: { revision: number }) => r.revision)).toEqual([2, 1]);
    // The superseded revision still says what it said.
    expect((await request(app, 'GET', '/api/chain-minimums/revisions/1')).body.doc.chains.Apex.general).toBe(40);
  });

  it('rejects scores outside the AA scale', async () => {
    const { body } = await request(app, 'GET', '/api/chain-minimums');
    const chains = body.doc.chains;
    const outOfRange = await request(app, 'PUT', '/api/chain-minimums', {
      expectedRevision: body.doc.revision,
      chains: { ...chains, Coding: { ...chains.Coding, coding: 101 } },
    });
    expect(outOfRange.status).toBe(400);
  });

  it('reads the live revision-6 document: chains it predates default, chains it outlives are ignored', async () => {
    // The live document on 2026-10-21: seven chains, no `either`, no Fast-Lane
    // — and Frontier/Workhorse still present, merged into Apex/Default that
    // day. A stale key must not invalidate the document it rides in.
    const off = { general: null, coding: null, agentic: null, acceptEstimated: false };
    const legacy = {
      version: 1, revision: 6, savedAt: '2026-10-01T00:00:00.000Z',
      chains: {
        Apex: { ...off, general: 40 }, Frontier: off, Workhorse: off, Default: off,
        Coding: { ...off, coding: 30, agentic: 20 }, Vision: off, 'Extra-Tier': off,
      },
    };
    getDb().prepare(`INSERT INTO settings (key, value) VALUES ('imperium_chain_minimums', ?)
                     ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(JSON.stringify(legacy));

    const { body } = await request(app, 'GET', '/api/chain-minimums');
    expect(body.doc.revision).toBe(6);
    expect(body.doc.chains.Apex.general).toBe(40);
    expect(body.doc.chains.Default.general).toBeNull(); // saved value kept intact
    expect(body.doc.chains.Coding).toMatchObject({ coding: 30, agentic: 20, either: [] });
    expect(body.doc.chains['Fast-Lane']).toMatchObject({ general: 15 }); // default
    // The merged-out chains are not part of the graded set at all.
    expect(body.doc.chains.Frontier).toBeUndefined();
    expect(body.doc.chains.Workhorse).toBeUndefined();
    expect(Object.keys(body.doc.chains).sort())
      .toEqual(['Apex', 'Coding', 'Default', 'Extra-Tier', 'Fast-Lane', 'Vision']);

    // And it saves forward with Fast-Lane set.
    const saved = await request(app, 'PUT', '/api/chain-minimums', {
      expectedRevision: 6,
      chains: { ...body.doc.chains, 'Fast-Lane': { ...body.doc.chains['Fast-Lane'], general: 18 } },
    });
    expect(saved.status).toBe(200);
    expect(saved.body.doc.chains['Fast-Lane'].general).toBe(18);
  });
});
