import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { initDb, getDb } from '../../db/index.js';
import { applyCatalog } from '../../services/catalog-sync.js';
import {
  ignoreInCatalogue,
  listCatalogueIgnores,
  previewIgnore,
  unignoreInCatalogue,
} from '../../services/catalogue-ignores.js';
import { getCatalogueChanges } from '../../services/catalogue-changes.js';
import { listCatalogueEvents, recordCatalogueEvent } from '../../services/catalogue-log.js';
import { getCatalogueSync, listCatalogueSyncs, recordCatalogueSync } from '../../services/catalogue-sync-log.js';

// Ignoring is the operator saying "never use this, free or not". The contract:
//   - it switches the provider's keys and the models off — the flags routing
//     gates on — and records what it switched off;
//   - a catalog sync cannot switch an ignored model back on, and an ignored
//     provider's new arrivals land off;
//   - un-ignoring restores exactly what the ignore switched off, nothing more;
//   - ignored providers and models drop out of the catalogue views, with the
//     update-log counts recomputed rather than merely hidden.

type AnyCatalog = Parameters<typeof applyCatalog>[1];
type AnyModel = AnyCatalog['models'][number];

const db = () => getDb();
const enabledOf = (platform: string, modelId: string) =>
  (db().prepare('SELECT enabled FROM models WHERE platform = ? AND model_id = ?').get(platform, modelId) as { enabled: number } | undefined)?.enabled;
const keyEnabled = (id: number) => (db().prepare('SELECT enabled FROM api_keys WHERE id = ?').get(id) as { enabled: number }).enabled;

function addModel(platform: string, modelId: string, enabled = 1): number {
  return Number(db().prepare(`
    INSERT INTO models (platform, model_id, display_name, intelligence_rank, speed_rank, enabled, source, first_seen_at)
    VALUES (?, ?, ?, 10, 5, ?, 'catalog', datetime('now'))
  `).run(platform, modelId, modelId.toUpperCase(), enabled).lastInsertRowid);
}

function addKey(platform: string, enabled = 1): number {
  return Number(db().prepare(`
    INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled)
    VALUES (?, 'k', 'x', 'x', 'x', 'healthy', ?)
  `).run(platform, enabled).lastInsertRowid);
}

/** Every catalog-managed row as a catalog entry, so applyCatalog keeps them. */
function catalogOfExisting(extra: AnyModel[] = []): AnyCatalog {
  const rows = db().prepare(`
    SELECT platform, model_id, display_name, enabled FROM models
     WHERE platform != 'custom' AND key_id IS NULL AND source = 'catalog'
  `).all() as Array<{ platform: string; model_id: string; display_name: string; enabled: number }>;
  const entry = (platform: string, modelId: string, displayName: string): AnyModel => ({
    platform, modelId, displayName, intelligenceRank: 10, speedRank: 5, sizeLabel: 'Medium',
    limits: { rpm: 30, rpd: 1000, tpm: 6000, tpd: null }, monthlyTokenBudget: '~1M', contextWindow: 8192,
    enabled: true, supportsVision: false, supportsTools: true,
  });
  return {
    version: '2099.05.01', generatedAt: new Date().toISOString(), tier: 'live', quirks: [],
    models: [...rows.map(r => entry(r.platform, r.model_id, r.display_name)), ...extra],
  };
}

beforeAll(() => {
  process.env.ENCRYPTION_KEY = '0'.repeat(64);
  initDb(':memory:');
});

beforeEach(() => {
  db().prepare('DELETE FROM catalogue_ignores').run();
  const testModels = "SELECT id FROM models WHERE platform IN ('groq', 'mistral') AND model_id LIKE 'ig-%'"
  db().prepare(`DELETE FROM fallback_config WHERE model_db_id IN (${testModels})`).run();
  db().prepare(`DELETE FROM profile_models WHERE model_db_id IN (${testModels})`).run();
  db().prepare("DELETE FROM models WHERE platform IN ('groq', 'mistral') AND model_id LIKE 'ig-%'").run();
  db().prepare("DELETE FROM api_keys WHERE platform IN ('groq', 'mistral')").run();
});

describe('ignoring a provider', () => {
  it('switches its keys and models off and restores exactly those on un-ignore', () => {
    const on = addModel('groq', 'ig-on');
    addModel('groq', 'ig-already-off', 0);
    const key = addKey('groq');
    const offKey = addKey('groq', 0);

    const impact = ignoreInCatalogue('groq', null);
    expect(impact.keys).toBe(1);
    expect(enabledOf('groq', 'ig-on')).toBe(0);
    expect(keyEnabled(key)).toBe(0);
    expect(listCatalogueIgnores()[0]).toMatchObject({ platform: 'groq', modelId: null, switchedOff: { keys: 1 } });

    const restored = unignoreInCatalogue('groq', null)!;
    expect(restored.keys).toBe(1);
    expect(enabledOf('groq', 'ig-on')).toBe(1);
    expect(enabledOf('groq', 'ig-already-off')).toBe(0);
    expect(keyEnabled(key)).toBe(1);
    expect(keyEnabled(offKey)).toBe(0);
    expect(on).toBeGreaterThan(0);
  });

  it('keeps its new arrivals and new keys off through a catalog sync', () => {
    ignoreInCatalogue('groq', null);
    const lateKey = addKey('groq');
    applyCatalog(db(), catalogOfExisting([{ ...catalogOfExisting().models[0], platform: 'groq', modelId: 'ig-arrival', displayName: 'Arrival' }]));
    expect(enabledOf('groq', 'ig-arrival')).toBe(0);
    expect(keyEnabled(lateKey)).toBe(0);
  });
});

describe('ignoring a model', () => {
  it('switches only that model off and keeps it off when the feed lists it enabled', () => {
    addModel('groq', 'ig-target');
    addModel('groq', 'ig-neighbour');
    const key = addKey('groq');
    ignoreInCatalogue('groq', 'ig-target');
    expect(enabledOf('groq', 'ig-target')).toBe(0);
    expect(enabledOf('groq', 'ig-neighbour')).toBe(1);
    expect(keyEnabled(key)).toBe(1);

    applyCatalog(db(), catalogOfExisting());
    expect(enabledOf('groq', 'ig-target')).toBe(0);
  });

  it('stays off when its provider is un-ignored around it', () => {
    addModel('groq', 'ig-target');
    addModel('groq', 'ig-neighbour');
    ignoreInCatalogue('groq', 'ig-target');
    ignoreInCatalogue('groq', null);
    unignoreInCatalogue('groq', null);
    expect(enabledOf('groq', 'ig-neighbour')).toBe(1);
    expect(enabledOf('groq', 'ig-target')).toBe(0);
  });

  it('previews the switch-off, chains included, without changing anything', () => {
    const id = addModel('groq', 'ig-target');
    const profile = db().prepare('SELECT id, name FROM profiles ORDER BY id LIMIT 1').get() as { id: number; name: string };
    db().prepare('INSERT INTO profile_models (profile_id, model_db_id, priority, enabled) VALUES (?, ?, 1, 1)').run(profile.id, id);
    expect(previewIgnore('groq', 'ig-target')).toEqual({ keys: 0, models: 1, chains: [profile.name] });
    expect(enabledOf('groq', 'ig-target')).toBe(1);
  });

  it('answers null when un-ignoring something not ignored', () => {
    expect(unignoreInCatalogue('groq', 'ig-nothing')).toBeNull();
  });
});

describe('the catalogue views leave ignored items out', () => {
  it('drops ignored arrivals from the changes list and ignored events from the history', () => {
    addModel('mistral', 'ig-visible');
    addModel('groq', 'ig-hidden');
    recordCatalogueEvent(db(), { kind: 'arrived', platform: 'groq', modelId: 'ig-hidden', source: 'catalog' });
    recordCatalogueEvent(db(), { kind: 'arrived', platform: 'mistral', modelId: 'ig-visible', source: 'catalog' });
    ignoreInCatalogue('groq', null);

    const arrived = getCatalogueChanges(30).arrived.map(a => a.modelId);
    expect(arrived).toContain('ig-visible');
    expect(arrived).not.toContain('ig-hidden');
    const history = listCatalogueEvents({ limit: 500 });
    expect(history.events.some(e => e.platform === 'groq')).toBe(false);
    expect(history.byPlatform.some(p => p.platform === 'groq')).toBe(false);
  });

  it('recounts update totals without ignored providers and models', () => {
    recordCatalogueSync(db(), {
      version: 'ig-v1', previousVersion: 'ig-v0', tier: 'live', generatedAt: null,
      counts: { updated: 0, inserted: 0, removed: 0, skippedUnknownPlatform: 0, quirks: 0 },
      doc: { added: 3, removed: 0, changed: 1, switchedOff: 2, switchedOn: 0 },
      byPlatform: { inferbase: { a: 2, r: 0, c: 0, off: 0, on: 0 }, sail: { a: 1, r: 0, c: 1, off: 2, on: 0 } },
      details: [
        { r: 'chat', p: 'sail', m: 'ig-dead', f: 'enabled', o: true, n: false },
        { r: 'chat', p: 'sail', m: 'ig-dead-2', f: 'enabled', o: true, n: false },
        { r: 'chat', p: 'sail', m: 'ig-kept', f: 'rpd', o: 10, n: 5 },
      ],
      members: {
        added: [
          { r: 'chat', p: 'inferbase', m: 'ig-a', n: null },
          { r: 'chat', p: 'inferbase', m: 'ig-b', n: null },
          { r: 'chat', p: 'sail', m: 'ig-new', n: null },
        ],
        removed: [],
      },
    });
    const id = (db().prepare("SELECT id FROM catalogue_sync WHERE version = 'ig-v1'").get() as { id: number }).id;
    db().prepare("INSERT INTO catalogue_ignores (platform, model_id) VALUES ('inferbase', ''), ('sail', 'ig-dead')").run();

    const row = listCatalogueSyncs({ limit: 200 }).syncs.find(s => s.id === id)!;
    expect(row.byPlatform).toEqual({ sail: { a: 1, r: 0, c: 1, off: 1, on: 0 } });
    expect(row).toMatchObject({ docAdded: 1, docChanged: 1, docSwitchedOff: 1 });

    const detail = getCatalogueSync(id)!;
    expect(detail.members!.added.map(m => m.m)).toEqual(['ig-new']);
    expect(detail.details.map(d => d.m)).toEqual(['ig-dead-2', 'ig-kept']);
    expect(listCatalogueSyncs({}).totals.hiddenIgnored).toBe(3);
  });
});
