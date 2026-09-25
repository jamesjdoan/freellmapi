import { describe, it, expect, beforeAll } from 'vitest';
import type { Express } from 'express';
import { createApp } from '../../app.js';
import { initDb } from '../../db/index.js';
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
    // Fast-Lane is listed as reserved and never offered minimums.
    expect(first.body.requirements.find((r: { name: string }) => r.name === 'Fast-Lane').reserved).toBe(true);
    expect(first.body.doc.chains['Fast-Lane']).toBeUndefined();

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

  it('rejects scores outside the AA scale and minimums for the reserved chain', async () => {
    const { body } = await request(app, 'GET', '/api/chain-minimums');
    const chains = body.doc.chains;
    const outOfRange = await request(app, 'PUT', '/api/chain-minimums', {
      expectedRevision: body.doc.revision,
      chains: { ...chains, Coding: { ...chains.Coding, coding: 101 } },
    });
    expect(outOfRange.status).toBe(400);
    const reserved = await request(app, 'PUT', '/api/chain-minimums', {
      expectedRevision: body.doc.revision,
      chains: { ...chains, 'Fast-Lane': { general: 10, coding: null, agentic: null, acceptEstimated: false } },
    });
    expect(reserved.status).toBe(400);
  });
});
