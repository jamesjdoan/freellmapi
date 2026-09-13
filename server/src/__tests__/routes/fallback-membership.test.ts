import { describe, it, expect, beforeEach } from 'vitest';
import type { Express } from 'express';
import { createApp } from '../../app.js';
import { initDb, getDb } from '../../db/index.js';
import { mintDashboardToken } from '../helpers/auth.js';

// Editing ONE NAMED chain, as opposed to rewriting whichever chain is active.
// Compare needs this: judging a model against the rest of the catalogue and
// then placing it is one motion, and the chain being edited is usually not the
// one on screen.

async function call(app: Express, path: string, token: string, body: unknown) {
  const server = app.listen(0, '127.0.0.1');
  if (!server.listening) await new Promise<void>(resolve => server.once('listening', () => resolve()));
  const addr = server.address() as { port: number };
  const res = await fetch(`http://127.0.0.1:${addr.port}${path}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  server.close();
  let json: unknown = null;
  try { json = JSON.parse(text); } catch { /* non-JSON error body */ }
  return { status: res.status, body: json as Record<string, unknown> };
}

describe('POST /api/fallback/membership', () => {
  let app: Express;
  let token: string;
  let modelId: number;
  let otherChainId: number;

  const rowIn = (chain: string) => getDb().prepare(`
    SELECT pm.priority, pm.enabled FROM profile_models pm
      JOIN profiles p ON p.id = pm.profile_id
     WHERE p.name = ? AND pm.model_db_id = ?
  `).get(chain, modelId) as { priority: number; enabled: number } | undefined;

  beforeEach(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
    app = createApp();
    token = mintDashboardToken();
    const db = getDb();
    db.prepare(`
      INSERT INTO models (platform, model_id, display_name, intelligence_rank, speed_rank, size_label,
                          monthly_token_budget, enabled)
      VALUES ('groq', 'probe/member', 'Member Probe', 50, 50, 'Large', '', 1)
    `).run();
    modelId = (db.prepare("SELECT id FROM models WHERE model_id = 'probe/member'").get() as { id: number }).id;
    db.prepare("INSERT INTO profiles (name, emoji, color, type) VALUES ('Coding', '', '#000', 'custom')").run();
    otherChainId = (db.prepare("SELECT id FROM profiles WHERE name = 'Coding'").get() as { id: number }).id;
    // Something already in the chain, so "added at the end" is observable.
    db.prepare('INSERT INTO profile_models (profile_id, model_db_id, priority, enabled) VALUES (?, 1, 4, 1)')
      .run(otherChainId);
  });

  it('adds a model to a chain it is not looking at, at the end', async () => {
    const res = await call(app, '/api/fallback/membership', token, {
      chain: 'Coding', modelDbIds: [modelId], member: true,
    });

    expect(res.status).toBe(200);
    expect(res.body.changed).toBe(1);
    // Position is the chain editor's business; membership just appends.
    expect(rowIn('Coding')).toEqual({ priority: 5, enabled: 1 });
  });

  it('lands last among ENABLED members, not past the disabled ones', async () => {
    // Apex held a priority 9 with nothing at 6, 7 or 8: rows switched off long
    // ago still held their numbers, and counting them pushed every new member
    // further past the end. The router walks enabled rows only.
    const db = getDb();
    db.prepare(`
      INSERT INTO models (platform, model_id, display_name, intelligence_rank, speed_rank, size_label, monthly_token_budget, enabled)
      VALUES ('groq', 'probe/retired', 'Retired', 50, 50, 'Large', '', 1)
    `).run();
    const retired = (db.prepare("SELECT id FROM models WHERE model_id = 'probe/retired'").get() as { id: number }).id;
    db.prepare('INSERT INTO profile_models (profile_id, model_db_id, priority, enabled) VALUES (?, ?, 40, 0)')
      .run(otherChainId, retired);

    await call(app, '/api/fallback/membership', token, { chain: 'Coding', modelDbIds: [modelId], member: true });

    // Behind the enabled member at 4, not behind the disabled one at 40.
    expect(rowIn('Coding')).toEqual({ priority: 5, enabled: 1 });
  });

  it('lands first when nothing is enabled in the chain yet', async () => {
    const db = getDb();
    db.prepare('UPDATE profile_models SET enabled = 0 WHERE profile_id = ?').run(otherChainId);

    await call(app, '/api/fallback/membership', token, { chain: 'Coding', modelDbIds: [modelId], member: true });

    expect(rowIn('Coding')).toEqual({ priority: 1, enabled: 1 });
  });

  it('removes by clearing the flag, so putting it back keeps its place', async () => {
    await call(app, '/api/fallback/membership', token, { chain: 'Coding', modelDbIds: [modelId], member: true });

    await call(app, '/api/fallback/membership', token, { chain: 'Coding', modelDbIds: [modelId], member: false });
    expect(rowIn('Coding')).toEqual({ priority: 5, enabled: 0 });

    await call(app, '/api/fallback/membership', token, { chain: 'Coding', modelDbIds: [modelId], member: true });
    expect(rowIn('Coding')?.priority).toBe(5);
  });

  it('rejects an unknown chain rather than creating one', async () => {
    const res = await call(app, '/api/fallback/membership', token, {
      chain: 'Nonexistent', modelDbIds: [modelId], member: true,
    });

    expect(res.status).toBe(404);
    expect(getDb().prepare("SELECT COUNT(*) c FROM profiles WHERE name = 'Nonexistent'").get()).toEqual({ c: 0 });
  });

  it('ignores ids that are not models', async () => {
    const res = await call(app, '/api/fallback/membership', token, {
      chain: 'Coding', modelDbIds: [999999], member: true,
    });

    expect(res.status).toBe(200);
    expect(res.body.changed).toBe(0);
  });
});
