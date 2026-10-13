import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { initDb, getDb } from '../../db/index.js';
import { requireAuth } from '../../middleware/requireAuth.js';
import { modelsRouter } from '../../routes/models.js';
import { mintDashboardToken } from '../helpers/auth.js';

// The discovery API is what an agent writes to, so its contract is the one an
// unattended caller depends on: re-posting the same finding must update rather
// than duplicate, status counts cover the whole table, bad input is a 400 that
// writes nothing, and an unknown id is a 404 rather than a silent success.

describe('discovery leads API', () => {
  let server: Server;
  let url: string;
  let token: string;

  beforeAll(async () => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
    token = mintDashboardToken();
    const app = express();
    app.use(express.json());
    app.use('/api/models', requireAuth, modelsRouter);
    server = app.listen(0, '127.0.0.1');
    await new Promise<void>(resolve => { server.once('listening', resolve); });
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) => { server.close(error => (error ? reject(error) : resolve())); });
  });

  const call = (path: string, init: RequestInit = {}) => fetch(`${url}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' },
  });
  const count = () => (getDb().prepare('SELECT COUNT(*) AS n FROM external_model_leads').get() as { n: number }).n;

  it('upserts on (source, modelId) so an agent can re-run without duplicating', async () => {
    const lead = { source: 'https://opencode.ai/docs/zen', modelId: 'big-pickle', notes: 'Free in stealth', addedBy: 'agent' };
    const first = await call('/api/models/discovery/leads', { method: 'POST', body: JSON.stringify(lead) });
    expect(first.status).toBe(200);
    const again = await call('/api/models/discovery/leads', {
      method: 'POST',
      body: JSON.stringify({ ...lead, status: 'testing', notes: 'Probe pending' }),
    });
    const body = await again.json() as { id: number; status: string; notes: string; addedBy: string };
    expect(count()).toBe(1);
    expect(body).toMatchObject({ status: 'testing', notes: 'Probe pending', addedBy: 'agent' });
  });

  it('lists leads with status counts over the whole table, not the page', async () => {
    await call('/api/models/discovery/leads', {
      method: 'POST',
      body: JSON.stringify({ source: 'OpenRouter stealth page', modelId: 'space-bunny-alpha', status: 'rejected' }),
    });
    const res = await call('/api/models/discovery/leads?limit=1');
    const page = await res.json() as { leads: unknown[]; total: number; byStatus: Record<string, number> };
    expect(page.leads).toHaveLength(1);
    expect(page.total).toBe(2);
    expect(page.byStatus).toMatchObject({ testing: 1, rejected: 1, candidate: 0 });
  });

  it('rejects a lead without a model id and writes nothing', async () => {
    const before = count();
    const res = await call('/api/models/discovery/leads', { method: 'POST', body: JSON.stringify({ source: 'x' }) });
    expect(res.status).toBe(400);
    expect(count()).toBe(before);
  });

  it('rejects a status outside the lifecycle', async () => {
    const res = await call('/api/models/discovery/leads/1', { method: 'PATCH', body: JSON.stringify({ status: 'shipped' }) });
    expect(res.status).toBe(400);
  });

  it('patches only the fields sent', async () => {
    const res = await call('/api/models/discovery/leads/1', { method: 'PATCH', body: JSON.stringify({ status: 'verified' }) });
    const lead = await res.json() as { status: string; notes: string };
    expect(lead).toMatchObject({ status: 'verified', notes: 'Probe pending' });
  });

  it('answers 404 for an id that does not exist, on both patch and delete', async () => {
    expect((await call('/api/models/discovery/leads/9999', { method: 'PATCH', body: JSON.stringify({ status: 'added' }) })).status).toBe(404);
    expect((await call('/api/models/discovery/leads/9999', { method: 'DELETE' })).status).toBe(404);
  });

  it('deletes a lead', async () => {
    const before = count();
    const res = await call('/api/models/discovery/leads/1', { method: 'DELETE' });
    expect(res.status).toBe(200);
    expect(count()).toBe(before - 1);
  });
});
