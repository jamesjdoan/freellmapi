import { describe, it, expect, beforeEach } from 'vitest';
import type { Express } from 'express';
import { createApp } from '../../app.js';
import { initDb, getDb } from '../../db/index.js';
import { mintDashboardToken } from '../helpers/auth.js';

// Membership says WHETHER a model is tried; position says WHEN. Placing a model
// used to mean rewriting the whole active chain, so ranking a route in a chain
// you were not looking at had no control at all.

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

describe('POST /api/fallback/position', () => {
  let app: Express;
  let token: string;
  let chainId: number;
  const ids: Record<string, number> = {};

  /** The chain as the router would walk it. */
  const order = () => (getDb().prepare(`
    SELECT m.model_id, pm.priority FROM profile_models pm
      JOIN models m ON m.id = pm.model_db_id
     WHERE pm.profile_id = ? AND pm.enabled = 1
     ORDER BY pm.priority, pm.model_db_id
  `).all(chainId) as { model_id: string; priority: number }[]).map(r => `${r.priority}:${r.model_id}`);

  beforeEach(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
    app = createApp();
    token = mintDashboardToken();
    const db = getDb();
    db.prepare("INSERT INTO profiles (name, emoji, color, type) VALUES ('Coding', '', '#000', 'custom')").run();
    chainId = (db.prepare("SELECT id FROM profiles WHERE name = 'Coding'").get() as { id: number }).id;

    // Deliberately sparse AND tied: chains built by different paths have
    // produced duplicate priorities on this install, and a tie makes "which
    // runs first" a coin toss.
    const seed = (slug: string, priority: number) => {
      db.prepare(`
        INSERT INTO models (platform, model_id, display_name, intelligence_rank, speed_rank, size_label, monthly_token_budget, enabled)
        VALUES ('groq', ?, ?, 50, 50, 'Large', '', 1)
      `).run(slug, slug);
      ids[slug] = (db.prepare('SELECT id FROM models WHERE model_id = ?').get(slug) as { id: number }).id;
      db.prepare('INSERT INTO profile_models (profile_id, model_db_id, priority, enabled) VALUES (?, ?, ?, 1)')
        .run(chainId, ids[slug], priority);
    };
    seed('alpha', 1);
    seed('bravo', 3);
    seed('charlie', 3);
    seed('delta', 9);
  });

  it('moves a model to the named position and shifts the rest down', async () => {
    const res = await call(app, '/api/fallback/position', token, {
      chain: 'Coding', modelDbId: ids.delta, position: 1,
    });

    expect(res.status).toBe(200);
    expect(order()).toEqual(['1:delta', '2:alpha', '3:bravo', '4:charlie']);
  });

  it('renumbers to a dense, tie-free order, because a tie is a coin toss', async () => {
    // bravo and charlie both sat at 3, and delta at 9 with nothing at 2 or 4.
    await call(app, '/api/fallback/position', token, { chain: 'Coding', modelDbId: ids.alpha, position: 2 });

    expect(order()).toEqual(['1:bravo', '2:alpha', '3:charlie', '4:delta']);
  });

  it('clamps past the end rather than erroring: "put it last" needs no length', async () => {
    const res = await call(app, '/api/fallback/position', token, {
      chain: 'Coding', modelDbId: ids.alpha, position: 99,
    });

    expect(res.status).toBe(200);
    expect(res.body.position).toBe(4);
    expect(order()).toEqual(['1:bravo', '2:charlie', '3:delta', '4:alpha']);
  });

  it('refuses a model that is not an enabled member, rather than adding it', async () => {
    const db = getDb();
    db.prepare(`
      INSERT INTO models (platform, model_id, display_name, intelligence_rank, speed_rank, size_label, monthly_token_budget, enabled)
      VALUES ('groq', 'outsider', 'outsider', 50, 50, 'Large', '', 1)
    `).run();
    const outsider = (db.prepare("SELECT id FROM models WHERE model_id = 'outsider'").get() as { id: number }).id;

    const res = await call(app, '/api/fallback/position', token, {
      chain: 'Coding', modelDbId: outsider, position: 1,
    });

    expect(res.status).toBe(404);
    expect(order()).toEqual(['1:alpha', '3:bravo', '3:charlie', '9:delta']);
  });

  it('rejects an unknown chain rather than creating one', async () => {
    const res = await call(app, '/api/fallback/position', token, {
      chain: 'Nope', modelDbId: ids.alpha, position: 1,
    });
    expect(res.status).toBe(404);
  });
});
