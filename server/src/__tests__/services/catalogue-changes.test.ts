import { describe, it, expect, beforeEach } from 'vitest';
import { initDb, getDb } from '../../db/index.js';
import { retireCatalogModelUpstream, reinstateUpstreamRetiredCatalogModel } from '../../services/model-state.js';
import { getCatalogueChanges, acknowledgeDeparture, acknowledgeArrivals, acknowledgeDepartures } from '../../services/catalogue-changes.js';

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

describe('the unread worklist', () => {
  beforeEach(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
  });

  it('reports an acknowledged arrival as still present, only flagged', () => {
    // The response is shared with the Keys page's churn chips, which count
    // these rows whether or not anyone has read them. Filtering server-side
    // would empty those counts; so the flag rides along and the client decides.
    addModel('groq', 'read-one', daysAgo(1));
    expect(getCatalogueChanges(30).arrived[0]!.acknowledged).toBe(false);

    expect(acknowledgeArrivals([{ platform: 'groq', modelId: 'read-one' }])).toBe(1);
    const after = getCatalogueChanges(30);
    expect(after.arrived).toHaveLength(1);
    expect(after.arrived[0]!.acknowledged).toBe(true);
  });

  it('counts a repeat acknowledgement as nothing, so a double click is harmless', () => {
    // The table has no timestamp, so there is nothing for a second write to
    // update — the primary key has to make it a no-op instead of an overwrite.
    addModel('groq', 'read-one', daysAgo(1));
    expect(acknowledgeArrivals([{ platform: 'groq', modelId: 'read-one' }])).toBe(1);
    expect(acknowledgeArrivals([{ platform: 'groq', modelId: 'read-one' }])).toBe(0);
  });

  it('reports a re-retirement as unread again, because relisting deletes the tombstone', () => {
    // The reason departures are NOT stored in catalogue_ack: an identity-only
    // mark would survive the relist and hide a second loss of routing forever.
    const id = addModel('google', 'twice-gone', daysAgo(5));
    retireCatalogModelUpstream(getDb(), id, 'google', 'twice-gone', 'first');
    acknowledgeArrivals([{ platform: 'google', modelId: 'twice-gone' }]);
    acknowledgeDepartures([{ platform: 'google', modelId: 'twice-gone' }]);
    expect(getCatalogueChanges(30).departed[0]!.acknowledged).toBe(true);

    // Relist through the real path — it deletes the tombstone and restores the
    // model row — then the provider drops it a second time.
    reinstateUpstreamRetiredCatalogModel(getDb(), 'google', 'twice-gone');
    const row = getDb().prepare('SELECT id FROM models WHERE platform = ? AND model_id = ?')
      .get('google', 'twice-gone') as { id: number } | undefined;
    expect(row).toBeDefined();
    retireCatalogModelUpstream(getDb(), row!.id, 'google', 'twice-gone', 'second');
    expect(getCatalogueChanges(30).departed[0]!.acknowledged).toBe(false);
  });

  it('marks a whole batch of both kinds in one call', () => {
    // The panel's one button, which is the only place both stores are written.
    addModel('groq', 'a1', daysAgo(1));
    addModel('groq', 'a2', daysAgo(2));
    const gone = addModel('google', 'd1', daysAgo(40));
    retireCatalogModelUpstream(getDb(), gone, 'google', 'd1', 'gone');

    expect(acknowledgeArrivals([{ platform: 'groq', modelId: 'a1' }, { platform: 'groq', modelId: 'a2' }])).toBe(2);
    expect(acknowledgeDepartures([{ platform: 'google', modelId: 'd1' }])).toBe(1);

    const after = getCatalogueChanges(30);
    expect(after.arrived.every(a => a.acknowledged)).toBe(true);
    expect(after.departed.every(d => d.acknowledged)).toBe(true);
    // Marked, not deleted: the rows are still there for the log and the chips.
    expect(after.arrived).toHaveLength(2);
    expect(after.departed).toHaveLength(1);
  });

  it('acknowledges nothing without complaint', () => {
    expect(acknowledgeArrivals([])).toBe(0);
    expect(acknowledgeDepartures([])).toBe(0);
  });
});
