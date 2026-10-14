import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { initDb, getDb } from '../../db/index.js';
import { requireAuth } from '../../middleware/requireAuth.js';
import { modelsRouter } from '../../routes/models.js';
import { mintDashboardToken } from '../helpers/auth.js';

// The HTTP side of ignoring: preview changes nothing, ignore and un-ignore
// round-trip with an exact restore, and an unknown un-ignore is a 404.

describe('catalogue ignore routes', () => {
  let server: Server;
  let url: string;
  let session: string;

  beforeAll(async () => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
    session = mintDashboardToken();
    getDb().prepare(`
      INSERT INTO models (platform, model_id, display_name, intelligence_rank, speed_rank, enabled, source)
      VALUES ('groq', 'ig-route', 'Route', 10, 5, 1, 'catalog')
    `).run();
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

  const call = (path: string, init: RequestInit = {}) => fetch(`${url}/api/models${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${session}`, 'content-type': 'application/json' },
  });
  const enabled = () => (getDb().prepare("SELECT enabled FROM models WHERE model_id = 'ig-route'").get() as { enabled: number }).enabled;

  it('previews without changing anything', async () => {
    const res = await call('/catalogue-ignores/preview?platform=groq&modelId=ig-route');
    expect(await res.json()).toMatchObject({ keys: 0, models: 1 });
    expect(enabled()).toBe(1);
  });

  it('ignores and un-ignores', async () => {
    const res = await call('/catalogue-ignores', { method: 'POST', body: JSON.stringify({ platform: 'groq', modelId: 'ig-route' }) });
    expect(await res.json()).toMatchObject({ ignored: true, switchedOff: { models: 1 } });
    expect(enabled()).toBe(0);
    const ignores = await (await call('/catalogue-ignores')).json() as { ignores: Array<{ platform: string; modelId: string }> };
    expect(ignores.ignores).toEqual([expect.objectContaining({ platform: 'groq', modelId: 'ig-route' })]);

    const lifted = await call('/catalogue-ignores?platform=groq&modelId=ig-route', { method: 'DELETE' });
    expect(await lifted.json()).toEqual({ ignored: false, restored: { keys: 0, models: 1 } });
    expect(enabled()).toBe(1);
  });

  it('answers 404 for an un-ignore of something not ignored, and 400 without a platform', async () => {
    expect((await call('/catalogue-ignores?platform=groq&modelId=nope', { method: 'DELETE' })).status).toBe(404);
    expect((await call('/catalogue-ignores', { method: 'POST', body: JSON.stringify({}) })).status).toBe(400);
  });
});
