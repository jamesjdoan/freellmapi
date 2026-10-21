import { beforeEach, describe, expect, it } from 'vitest';
import type { Express } from 'express';
import { createApp } from '../../app.js';
import { initDb, getDb } from '../../db/index.js';
import { encrypt } from '../../lib/crypto.js';
import { resolveRoutingChain, routeRequest, setRoutingStrategy } from '../../services/router.js';
import { getDefaultChainProfileId } from '../../services/profile-models.js';
import { mintDashboardToken, isGatedApiPath } from '../helpers/auth.js';

// #1409: `active_profile_id` is the chain being edited, `default_chain_profile_id`
// is the chain plain `auto` routes through. They were one setting, so selecting a
// chain to look at it silently moved live traffic — this suite pins the split:
// routing follows the default, the editor follows the active, and deleting the
// default hands routing over to the Default chain instead of pointing at nothing.
let app: Express;
let dashToken = '';

async function request(
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; body: unknown }> {
  const server = app.listen(0, '127.0.0.1');
  if (!server.listening) await new Promise<void>(resolve => server.once('listening', () => resolve()));
  const addr = server.address() as { port: number };
  const res = await fetch(`http://127.0.0.1:${addr.port}${path}`, {
    method,
    headers: {
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...(isGatedApiPath(path) ? { Authorization: `Bearer ${dashToken}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data: unknown = await res.json().catch(() => null);
  server.close();
  return { status: res.status, body: data };
}

/**
 * One numeric field off a JSON response, narrowed rather than asserted: this and
 * settingId are the whole typing surface of the suite.
 */
function numberField(body: unknown, field: string): number | null {
  if (body && typeof body === 'object' && field in body) {
    const value = body[field];
    return typeof value === 'number' ? value : null;
  }
  return null;
}

function setting(key: string): string | undefined {
  const row = getDb().prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined;
  return row?.value;
}

function defaultProfileId(): number {
  const row = getDb().prepare("SELECT id FROM profiles WHERE type = 'default' ORDER BY id ASC LIMIT 1")
    .get() as { id: number };
  return row.id;
}

function addKey(platform = 'groq'): void {
  const secret = encrypt(`${platform}-default-chain-key`);
  getDb().prepare(`
    INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled)
    VALUES (?, 'default-chain', ?, ?, ?, 'healthy', 1)
  `).run(platform, secret.encrypted, secret.iv, secret.authTag);
}

/** One model, enabled, in `fallback_config` and in the chain of `profileId`. */
function addModel(modelId: string, priority: number, profileId: number): number {
  const db = getDb();
  const inserted = db.prepare(`
    INSERT INTO models (
      platform, model_id, display_name, intelligence_rank, speed_rank, size_label,
      monthly_token_budget, context_window, enabled, supports_vision, supports_tools
    )
    VALUES ('groq', ?, ?, ?, ?, 'Small', '~1M', 128000, 1, 0, 1)
  `).run(modelId, `Default Chain ${modelId}`, priority, priority);
  const id = Number(inserted.lastInsertRowid);
  db.prepare('INSERT INTO fallback_config (model_db_id, priority, enabled) VALUES (?, ?, 1)').run(id, priority);
  db.prepare('INSERT INTO profile_models (profile_id, model_db_id, priority, enabled) VALUES (?, ?, ?, 1)')
    .run(profileId, id, priority);
  return id;
}

/** A chain created the way the dashboard creates one: custom and empty. */
async function createChain(name: string): Promise<number> {
  const created = await request('POST', '/api/profiles', { name, empty: true });
  expect(created.status).toBe(201);
  const id = numberField(created.body, 'id');
  if (id == null) throw new Error(`creating ${name} returned no id`);
  return id;
}

beforeEach(() => {
  process.env.ENCRYPTION_KEY = '0'.repeat(64);
  initDb(':memory:');
  app = createApp();
  dashToken = mintDashboardToken();
  setRoutingStrategy('priority');
});

describe('plain auto routes through the default chain (#1409)', () => {
  it('routes over the default chain while a different chain is being edited', async () => {
    addKey();
    const db = getDb();
    const fallbackId = defaultProfileId();
    // The chain the operator opened to edit, and the chain routing still uses.
    const editingId = await createChain('extra-tier');
    await request('POST', '/api/profiles/active', { profileId: editingId });
    await request('POST', '/api/profiles/default-chain', { profileId: fallbackId });

    db.prepare('DELETE FROM profile_models').run();
    const routedModel = addModel('default-chain-head', 1, fallbackId);
    // The edited chain holds something else entirely — selecting it must not be
    // able to move a plain `auto` request onto it.
    addModel('edited-chain-head', 1, editingId);

    expect(setting('active_profile_id')).toBe(String(editingId));
    const resolved = resolveRoutingChain('auto');
    expect(resolved.chain.map(row => row.model_db_id)).toEqual([routedModel]);
    expect(routeRequest(100).modelDbId).toBe(routedModel);
  });

  it('falls back to the Default-type chain when the default points at a deleted profile', async () => {
    addKey();
    const db = getDb();
    const fallbackId = defaultProfileId();
    const deletedId = await createChain('to-be-deleted');
    db.prepare('DELETE FROM profile_models').run();
    const routedModel = addModel('default-chain-head', 1, fallbackId);
    addModel('ghost-chain-head', 1, deletedId);

    // A stale pointer, the shape a hand-edited setting or an interrupted delete
    // leaves behind.
    db.prepare("UPDATE settings SET value = ? WHERE key = 'default_chain_profile_id'").run(String(deletedId));
    db.prepare('DELETE FROM profiles WHERE id = ?').run(deletedId);

    expect(getDefaultChainProfileId(db)).toBe(fallbackId);
    expect(resolveRoutingChain('auto').chain.map(row => row.model_db_id)).toEqual([routedModel]);
  });

  it('moves the setting to the Default chain when the default chain is deleted', async () => {
    addKey();
    const fallbackId = defaultProfileId();
    const chainId = await createChain('overflow');
    await request('POST', '/api/profiles/default-chain', { profileId: chainId });

    const removed = await request('DELETE', `/api/profiles/${chainId}`);
    expect(removed.status).toBe(200);

    expect(setting('default_chain_profile_id')).toBe(String(fallbackId));
    expect(getDefaultChainProfileId(getDb())).toBe(fallbackId);
  });
});

describe('the default-chain API (#1409)', () => {
  it('reports the routing chain, which the migration copied from active', async () => {
    const { status, body } = await request('GET', '/api/profiles/default-chain');
    expect(status).toBe(200);
    // Behaviour is unchanged at upgrade time: the deploy-time default is the
    // chain that was already routing.
    expect(numberField(body, 'defaultChainProfileId')).toBe(Number(setting('active_profile_id')));
  });

  it('sets the routing chain without touching the chain being edited', async () => {
    const chainId = await createChain('pinned');
    const activeBefore = setting('active_profile_id');

    const { status, body } = await request('POST', '/api/profiles/default-chain', { profileId: chainId });

    expect(status).toBe(200);
    expect(numberField(body, 'defaultChainProfileId')).toBe(chainId);
    expect(setting('default_chain_profile_id')).toBe(String(chainId));
    expect(setting('active_profile_id')).toBe(activeBefore);
  });

  it('404s on an unknown profile', async () => {
    const { status } = await request('POST', '/api/profiles/default-chain', { profileId: 9999 });
    expect(status).toBe(404);
  });

  it('400s when no profile is named', async () => {
    const { status } = await request('POST', '/api/profiles/default-chain', {});
    expect(status).toBe(400);
  });
});
