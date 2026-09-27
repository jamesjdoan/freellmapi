import { describe, it, expect, beforeEach } from 'vitest';
import type { Express } from 'express';
import { createApp } from '../../app.js';
import { initDb, getDb } from '../../db/index.js';
import { encrypt } from '../../lib/crypto.js';
import { mintDashboardToken } from '../helpers/auth.js';

// A provider the operator gives up on must leave the catalogue for good, say
// why, and leave the keys page. The models being tombstoned is the part that
// decides whether a refresh brings them back, so that is what this pins.

let app: Express;
let token = '';

async function call(method: string, path: string, body?: unknown) {
  const server = app.listen(0, '127.0.0.1');
  if (!server.listening) await new Promise<void>(resolve => server.once('listening', () => resolve()));
  const { port } = server.address() as { port: number };
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => null);
  server.close();
  return { status: res.status, body: json };
}

function addKey(platform: string, label: string): number {
  const { encrypted, iv, authTag } = encrypt(`${platform}-${label}-secret`);
  return Number(getDb().prepare(`
    INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled)
    VALUES (?, ?, ?, ?, ?, 'healthy', 1)
  `).run(platform, label, encrypted, iv, authTag).lastInsertRowid);
}

function addModel(platform: string, modelId: string, enabled = 1): number {
  return Number(getDb().prepare(`
    INSERT INTO models (platform, model_id, display_name, intelligence_rank, speed_rank, size_label, enabled, source, key_id)
    VALUES (?, ?, ?, 1, 1, 'Large', ?, 'catalog', NULL)
  `).run(platform, modelId, modelId, enabled).lastInsertRowid);
}

const modelIds = (platform: string) =>
  (getDb().prepare('SELECT model_id FROM models WHERE platform = ? ORDER BY model_id').all(platform) as { model_id: string }[])
    .map(r => r.model_id);
const chainRows = (modelDbId: number) =>
  getDb().prepare('SELECT COUNT(*) AS n FROM profile_models WHERE model_db_id = ?').get(modelDbId) as { n: number };
const tombstones = (platform: string) =>
  (getDb().prepare('SELECT model_id, source, reason FROM catalog_model_tombstones WHERE platform = ? ORDER BY model_id').all(platform) as
    { model_id: string; source: string; reason: string | null }[]);

describe('provider removals', () => {
  beforeEach(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
    app = createApp();
    token = mintDashboardToken();
  });

  it('removes the models, tombstones them with the reason, keeps the key, and refuses a blank reason', async () => {
    const keyId = addKey('cerebras', 'cerebras');
    const alpha = addModel('cerebras', 'llama-3.3-70b');
    const beta = addModel('cerebras', 'llama-3.1-8b');
    getDb().prepare('INSERT INTO profile_models (profile_id, model_db_id, priority, enabled) VALUES (1, ?, 1, 1)').run(alpha);
    getDb().prepare('INSERT INTO fallback_config (model_db_id, priority, enabled) VALUES (?, 1, 1)').run(alpha);

    // A blank reason is refused: the row is the log, and the reason is the
    // only part of it worth reading a month later.
    expect((await call('POST', '/api/keys/provider-removals/cerebras', { reason: '   ' })).status).toBe(400);

    const res = await call('POST', '/api/keys/provider-removals/cerebras', { reason: 'Credit card dropped; replaced by Groq' });
    expect(res.status).toBe(200);
    // At least the two we added; the seeded catalogue may hold more for this platform.
    expect(res.body.platform).toBe('cerebras');
    expect(res.body.keysKept).toBe(1);
    expect(res.body.modelsRemoved).toBeGreaterThanOrEqual(2);

    // Out of the catalogue, out of every chain, out of the default auto list.
    expect(modelIds('cerebras')).toEqual([]);
    expect(chainRows(alpha).n).toBe(0);
    expect(chainRows(beta).n).toBe(0);
    expect(getDb().prepare('SELECT COUNT(*) AS n FROM fallback_config WHERE model_db_id = ?').get(alpha)).toEqual({ n: 0 });

    // Tombstoned, so a catalog refresh cannot re-insert either model. This is
    // the whole point: without it the provider's models come straight back.
    const marks = tombstones('cerebras');
    for (const id of ['llama-3.1-8b', 'llama-3.3-70b']) {
      expect(marks).toContainEqual({ model_id: id, source: 'user', reason: 'Credit card dropped; replaced by Groq' });
    }
    // Every model the provider had is tombstoned, not just the two we named.
    expect(marks).toHaveLength(res.body.modelsRemoved);

    // The credential is untouched: restoring is a click, not a re-entry.
    expect(getDb().prepare('SELECT id FROM api_keys WHERE id = ?').get(keyId)).toBeDefined();

    // Recorded once, with the reason, and listed as the history.
    const list = await call('GET', '/api/keys/provider-removals');
    expect(list.body.removals).toHaveLength(1);
    expect(list.body.removals[0]).toMatchObject({ platform: 'cerebras', reason: 'Credit card dropped; replaced by Groq', restoredAt: null });

    // Restoring marks it done and clears it from the active set, while the
    // log row stays.
    const back = await call('POST', '/api/keys/provider-removals/cerebras/restore');
    expect(back.status).toBe(200);
    expect(back.body.restored.restoredAt).toBeTruthy();
    const after = await call('GET', '/api/keys/provider-removals');
    expect(after.body.removals).toHaveLength(1);
    expect(after.body.removals[0].restoredAt).toBeTruthy();
  });

  it('records a removal when the last key for a provider is deleted by hand', async () => {
    const keyId = addKey('moondream', 'moondream');
    addModel('moondream', 'moondream-v2');
    expect((await call('DELETE', `/api/keys/${keyId}`)).status).toBe(200);
    const list = await call('GET', '/api/keys/provider-removals');
    expect(list.body.removals).toMatchObject([{ platform: 'moondream', removedBy: 'key', reason: 'Last key removed' }]);
  });

  it('does not record a removal when another key for the same provider remains', async () => {
    addKey('groq', 'groq-a');
    const b = addKey('groq', 'groq-b');
    expect((await call('DELETE', `/api/keys/${b}`)).status).toBe(200);
    const list = await call('GET', '/api/keys/provider-removals');
    expect(list.body.removals).toEqual([]);
  });
});
