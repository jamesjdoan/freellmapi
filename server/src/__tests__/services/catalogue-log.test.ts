import { describe, it, expect, beforeEach } from 'vitest';
import { initDb, getDb } from '../../db/index.js';
import { listCatalogueEvents, recordCatalogueEvent } from '../../services/catalogue-log.js';
import {
  recordCatalogModelTombstone,
  clearCatalogModelTombstone,
  retireCatalogModelUpstream,
} from '../../services/model-state.js';

// The catalogue log is the only record that survives the model row. Both
// existing surfaces report current state: `first_seen_at` dies with the row,
// and a tombstone is one row per model whose date is overwritten each time it
// is re-retired. A model that came and went three times reads as one departure
// there and as three events here.

function addModel(platform: string, modelId: string, displayName = modelId): number {
  const db = getDb();
  const info = db.prepare(`
    INSERT INTO models (platform, model_id, display_name, intelligence_rank, speed_rank, size_label,
                        monthly_token_budget, enabled)
    VALUES (?, ?, ?, 50, 50, 'Medium', '', 1)
  `).run(platform, modelId, displayName);
  return Number(info.lastInsertRowid);
}

describe('catalogue event log', () => {
  beforeEach(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
    getDb().prepare('DELETE FROM catalogue_event').run();
  });

  it('records a retirement with the provider wording and the chains it cost', () => {
    const db = getDb();
    const id = addModel('google', 'gemini-x', 'Gemini X');
    const profile = db.prepare("INSERT INTO profiles (name, type) VALUES ('Vision', 'custom') RETURNING id").get() as { id: number };
    db.prepare('INSERT INTO profile_models (profile_id, model_db_id, priority, enabled) VALUES (?, ?, 1, 1)')
      .run(profile.id, id);

    retireCatalogModelUpstream(db, id, 'google', 'gemini-x', 'Google API error 404: gone');

    const { events } = listCatalogueEvents({}, db);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      kind: 'retired',
      platform: 'google',
      modelId: 'gemini-x',
      displayName: 'Gemini X',
      source: 'upstream_eol',
      reason: 'Google API error 404: gone',
    });
    // The point of capturing at retirement: afterwards the chain row is merely
    // disabled, indistinguishable from a route switched off by hand.
    expect(events[0].chains).toEqual([{ chain: 'Vision', priority: 1 }]);
  });

  it('keeps every departure of a model that came and went repeatedly', () => {
    const db = getDb();
    addModel('groq', 'flaky');
    for (const reason of ['gone once', 'gone twice', 'gone again']) {
      recordCatalogModelTombstone(db, 'chat', 'groq', 'flaky', { source: 'upstream_eol', reason });
      clearCatalogModelTombstone(db, 'chat', 'groq', 'flaky');
    }
    const { events } = listCatalogueEvents({}, db);
    // Three retirements and three relists. The tombstone table can only ever
    // show the last one, which is exactly why this log exists.
    expect(events.filter(e => e.kind === 'retired').map(e => e.reason))
      .toEqual(['gone again', 'gone twice', 'gone once']);
    expect(events.filter(e => e.kind === 'relisted')).toHaveLength(3);
  });

  it('does not invent a relist when no retirement was lifted', () => {
    const db = getDb();
    addModel('groq', 'never-retired');
    // Called defensively on paths where no tombstone exists.
    clearCatalogModelTombstone(db, 'chat', 'groq', 'never-retired');
    expect(listCatalogueEvents({}, db).events).toHaveLength(0);
  });

  it('reports newest first and pages without losing the total', () => {
    const db = getDb();
    for (let i = 0; i < 5; i++) {
      recordCatalogueEvent(db, { kind: 'arrived', platform: 'groq', modelId: `m${i}` });
    }
    const page = listCatalogueEvents({ limit: 2 }, db);
    expect(page.events).toHaveLength(2);
    expect(page.total).toBe(5);
    // Same timestamp to the second, so id breaks the tie - newest first.
    expect(page.events[0].modelId).toBe('m4');
    const second = listCatalogueEvents({ limit: 2, offset: 2 }, db);
    expect(second.events.map(e => e.modelId)).toEqual(['m2', 'm1']);
  });

  it('filters by provider and by kind', () => {
    const db = getDb();
    recordCatalogueEvent(db, { kind: 'arrived', platform: 'groq', modelId: 'a' });
    recordCatalogueEvent(db, { kind: 'removed', platform: 'groq', modelId: 'b' });
    recordCatalogueEvent(db, { kind: 'arrived', platform: 'nvidia', modelId: 'c' });

    expect(listCatalogueEvents({ platform: 'groq' }, db).events).toHaveLength(2);
    expect(listCatalogueEvents({ kind: 'arrived' }, db).events).toHaveLength(2);
    expect(listCatalogueEvents({ platform: 'groq', kind: 'removed' }, db).events.map(e => e.modelId))
      .toEqual(['b']);
  });

  it('counts per provider across the whole log, not just the filtered page', () => {
    // The filter control is built from these, so narrowing to one provider
    // must not erase the others from the picker.
    const db = getDb();
    recordCatalogueEvent(db, { kind: 'arrived', platform: 'groq', modelId: 'a' });
    recordCatalogueEvent(db, { kind: 'retired', platform: 'groq', modelId: 'b' });
    recordCatalogueEvent(db, { kind: 'removed', platform: 'nvidia', modelId: 'c' });

    const { byPlatform } = listCatalogueEvents({ platform: 'groq' }, db);
    expect(byPlatform).toEqual([
      { platform: 'groq', arrived: 1, departed: 1 },
      { platform: 'nvidia', arrived: 0, departed: 1 },
    ]);
  });

  it('survives a corrupt chains value rather than dropping the event', () => {
    const db = getDb();
    db.prepare(`
      INSERT INTO catalogue_event (kind, platform, model_id, chains_json)
      VALUES ('retired', 'groq', 'truncated', '[{"chain":"Apex"')
    `).run();
    const { events } = listCatalogueEvents({}, db);
    expect(events).toHaveLength(1);
    expect(events[0].chains).toEqual([]);
  });

  it('never fails the operation it is describing', () => {
    // Every call site sits inside a catalogue write. Losing a log row beats
    // failing a sync that is applying hundreds of models.
    const db = getDb();
    db.prepare('DROP TABLE catalogue_event').run();
    expect(() => recordCatalogueEvent(db, { kind: 'arrived', platform: 'groq', modelId: 'x' }))
      .not.toThrow();
  });
});
