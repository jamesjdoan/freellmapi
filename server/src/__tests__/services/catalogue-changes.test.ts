import { describe, it, expect, beforeEach } from 'vitest';
import { initDb, getDb } from '../../db/index.js';
import { getCatalogueChanges, acknowledgeDeparture } from '../../services/catalogue-changes.js';
import { retireCatalogModelUpstream } from '../../services/model-state.js';

// The catalogue's two halves used to be tracked very differently: departures
// had a table, arrivals had nothing. That asymmetry cost real routing — two
// `nex-agi/nex-n2.5:free` models arrived in a sync, the Default profile
// auto-included them, and they served traffic before anyone knew they existed.

function reset(): void {
  process.env.ENCRYPTION_KEY = '0'.repeat(64);
  initDb(':memory:');
  const db = getDb();
  db.prepare('DELETE FROM fallback_config').run();
  db.prepare('DELETE FROM profile_models').run();
  db.prepare('DELETE FROM models').run();
  db.prepare('DELETE FROM catalog_model_tombstones').run();
}

/** `firstSeenAt` null models a row that predates arrival tracking. */
function addModel(platform: string, modelId: string, firstSeenAt: string | null): number {
  return Number(getDb().prepare(`
    INSERT INTO models (platform, model_id, display_name, intelligence_rank, speed_rank, size_label,
      monthly_token_budget, context_window, enabled, supports_vision, supports_tools, first_seen_at)
    VALUES (?, ?, ?, 1, 1, 'Large', '', 128000, 1, 0, 1, ?)
  `).run(platform, modelId, `${modelId} (${platform})`, firstSeenAt).lastInsertRowid);
}

function addToChain(modelDbId: number, chainName: string, priority: number): void {
  const db = getDb();
  let row = db.prepare('SELECT id FROM profiles WHERE name = ?').get(chainName) as { id: number } | undefined;
  if (!row) {
    const info = db.prepare("INSERT INTO profiles (name, type) VALUES (?, 'custom')").run(chainName);
    row = { id: Number(info.lastInsertRowid) };
  }
  db.prepare('INSERT INTO profile_models (profile_id, model_db_id, priority, enabled) VALUES (?, ?, ?, 1)')
    .run(row.id, modelDbId, priority);
}

const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString().replace('T', ' ').slice(0, 19);

describe('arrivals', () => {
  beforeEach(reset);

  it('reports a new model and whether it is already serving', () => {
    // The urgent row on this panel is a model that arrived AND auto-entered a
    // chain — it is answering requests before anyone chose it. One sitting
    // unrouted in the catalogue is information, not an incident.
    const routed = addModel('openrouter', 'nex-agi/nex-n2.5-pro:free', daysAgo(1));
    addToChain(routed, 'Default', 751);
    addModel('openrouter', 'nex-agi/nex-n2.5-mini:free', daysAgo(1));

    const { arrived } = getCatalogueChanges(30);
    expect(arrived).toHaveLength(2);

    const pro = arrived.find(a => a.modelId.endsWith('pro:free'))!;
    expect(pro.routed).toBe(true);
    expect(pro.chains).toEqual(['Default']);

    const mini = arrived.find(a => a.modelId.endsWith('mini:free'))!;
    expect(mini.routed).toBe(false);
    expect(mini.chains).toEqual([]);
  });

  it('honours the window', () => {
    addModel('groq', 'recent', daysAgo(2));
    addModel('groq', 'old-news', daysAgo(90));

    expect(getCatalogueChanges(30).arrived.map(a => a.modelId)).toEqual(['recent']);
    expect(getCatalogueChanges(365).arrived.map(a => a.modelId).sort()).toEqual(['old-news', 'recent']);
  });

  it('counts models that predate tracking instead of dating them', () => {
    // Backfilling `now` would date every pre-existing model to the migration
    // and read exactly like a measurement. They are counted, not listed.
    addModel('groq', 'always-been-here', null);
    addModel('groq', 'arrived-today', daysAgo(0));

    const changes = getCatalogueChanges(30);
    expect(changes.arrived.map(a => a.modelId)).toEqual(['arrived-today']);
    expect(changes.untrackedArrivals).toBe(1);
  });
});

describe('departures name what was lost', () => {
  beforeEach(reset);

  it('records the chains a retired model was serving', () => {
    // "gemini-2.5-pro retired" and "gemini-2.5-pro retired, it was Vision #1
    // and Frontier #3" are the same event and completely different problems.
    const id = addModel('google', 'gemini-2.5-pro', daysAgo(40));
    addToChain(id, 'Vision', 1);
    addToChain(id, 'Frontier', 3);

    retireCatalogModelUpstream(getDb(), id, 'google', 'gemini-2.5-pro', '404: no longer available to new users');

    const [departed] = getCatalogueChanges(30).departed;
    expect(departed.modelId).toBe('gemini-2.5-pro');
    expect(departed.reason).toContain('no longer available');
    expect(departed.lostFrom.map(c => `${c.chain}#${c.priority}`).sort()).toEqual(['Frontier#3', 'Vision#1']);
  });

  it('captures membership at retirement, because it cannot be read back after', () => {
    // The retirement disables the chain rows, leaving them indistinguishable
    // from a route the operator switched off themselves. Reading membership
    // afterwards would report nothing.
    const id = addModel('google', 'gemini-2.5-pro', daysAgo(40));
    addToChain(id, 'Vision', 1);
    retireCatalogModelUpstream(getDb(), id, 'google', 'gemini-2.5-pro', 'gone');

    const stillEnabled = getDb().prepare(
      'SELECT COUNT(*) AS c FROM profile_models WHERE model_db_id = ? AND enabled = 1',
    ).get(id) as { c: number };
    expect(stillEnabled.c).toBe(0);
    // …and yet the record survives.
    expect(getCatalogueChanges(30).departed[0]!.lostFrom).toHaveLength(1);
  });

  it('says nothing was lost when the model was routed nowhere', () => {
    const id = addModel('navy', 'unrouted', daysAgo(40));
    retireCatalogModelUpstream(getDb(), id, 'navy', 'unrouted', 'gone');
    expect(getCatalogueChanges(30).departed[0]!.lostFrom).toEqual([]);
  });

  it('keeps reporting a departure regardless of age until it is acknowledged', () => {
    // Arrivals age out of the window; a gap in the stack does not heal on its
    // own, so departures are not windowed.
    const id = addModel('google', 'ancient', daysAgo(300));
    retireCatalogModelUpstream(getDb(), id, 'google', 'ancient', 'gone');
    getDb().prepare("UPDATE catalog_model_tombstones SET created_at = datetime('now', '-300 days')").run();

    expect(getCatalogueChanges(30).departed).toHaveLength(1);
  });
});

describe('acknowledgement', () => {
  beforeEach(reset);

  it('stamps a departure so the panel can stop calling it news', () => {
    // The column has existed since the tombstone table gained provenance and
    // nothing ever set it. Unacknowledged forever means the surface meant to
    // say "something broke" fills with months-old rows and stops being read.
    const id = addModel('google', 'gemini-2.5-pro', daysAgo(5));
    retireCatalogModelUpstream(getDb(), id, 'google', 'gemini-2.5-pro', 'gone');
    expect(getCatalogueChanges(30).departed[0]!.acknowledgedAt).toBeNull();

    expect(acknowledgeDeparture('google', 'gemini-2.5-pro')).toBe(true);
    expect(getCatalogueChanges(30).departed[0]!.acknowledgedAt).not.toBeNull();
  });

  it('reports a miss rather than silently succeeding', () => {
    expect(acknowledgeDeparture('google', 'never-retired')).toBe(false);
  });
});
