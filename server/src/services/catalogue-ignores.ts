import { getDb } from '../db/index.js';
import type { Db } from '../db/types.js';

// Providers and models the operator never wants to use, free or not.
//
// Ignoring is a routing decision first: it switches off the provider's keys
// and models (api_keys.enabled / models.enabled, the flags the router already
// gates on), and catalog sync keeps them off — a feed update cannot bring an
// ignored model back, and a provider's new arrivals land switched off. It is a
// noise filter second: ignored items drop out of Catalog updates, Model history
// and the Models-page changes list. The Models chain lists only enabled
// models, so an ignored model leaves it too.
//
// One ignore can name several targets at once — the Models page ignores a
// logical model by ignoring every provider route that serves it — and they are
// previewed and applied together, in one transaction.
//
// Un-ignoring restores exactly what the ignore switched off, from a snapshot
// taken at the time; anything already off stays off.

export interface CatalogueIgnore {
  platform: string;
  /** Null when the whole provider is ignored. */
  modelId: string | null;
  at: string;
  /** How many keys and models the ignore switched off (what un-ignore restores). */
  switchedOff: { keys: number; models: number };
}

export interface IgnoreImpact {
  /** Keys currently on that ignoring would switch off. */
  keys: number;
  /** Models currently on that ignoring would switch off. */
  models: number;
  /** Chains (profiles) that currently route to any of those models. */
  chains: string[];
}

export interface IgnoreSets {
  providers: Set<string>;
  /** `${platform}\0${modelId}` */
  models: Set<string>;
}

/** A whole provider (modelId null) or one of its models. */
export interface IgnoreTarget {
  platform: string;
  modelId: string | null;
}

interface Snapshot { keys: number[]; models: number[] }

const modelKey = (platform: string, modelId: string) => `${platform}\u0000${modelId}`;

/** SQL predicate: the row at `alias` (with platform and model_id) is ignored. */
export const ignoredSql = (alias: string) => `EXISTS (
  SELECT 1 FROM catalogue_ignores ci
   WHERE ci.platform = ${alias}.platform AND (ci.model_id = '' OR ci.model_id = ${alias}.model_id)
)`;

export function loadIgnoreSets(db: Db = getDb()): IgnoreSets {
  const rows = db.prepare('SELECT platform, model_id FROM catalogue_ignores').all() as Array<{ platform: string; model_id: string }>;
  const sets: IgnoreSets = { providers: new Set(), models: new Set() };
  for (const r of rows) {
    if (r.model_id === '') sets.providers.add(r.platform);
    else sets.models.add(modelKey(r.platform, r.model_id));
  }
  return sets;
}

export function isIgnored(sets: IgnoreSets, platform: string, modelId: string): boolean {
  return sets.providers.has(platform) || sets.models.has(modelKey(platform, modelId));
}

export function listCatalogueIgnores(db: Db = getDb()): CatalogueIgnore[] {
  const rows = db.prepare('SELECT platform, model_id, at, restore_json FROM catalogue_ignores ORDER BY at DESC')
    .all() as Array<{ platform: string; model_id: string; at: string; restore_json: string }>;
  return rows.map(r => {
    const snap = parseSnapshot(r.restore_json);
    return {
      platform: r.platform,
      modelId: r.model_id || null,
      at: r.at,
      switchedOff: { keys: snap.keys.length, models: snap.models.length },
    };
  });
}

function parseSnapshot(raw: string): Snapshot {
  try {
    const parsed = JSON.parse(raw) as Partial<Snapshot>;
    return { keys: Array.isArray(parsed.keys) ? parsed.keys : [], models: Array.isArray(parsed.models) ? parsed.models : [] };
  } catch {
    return { keys: [], models: [] };
  }
}

/** The key and model ids an ignore of (platform, modelId) would switch off. */
function targets(db: Db, platform: string, modelId: string | null): Snapshot {
  const models = modelId === null
    ? db.prepare('SELECT id FROM models WHERE platform = ? AND enabled = 1').all(platform)
    : db.prepare('SELECT id FROM models WHERE platform = ? AND model_id = ? AND enabled = 1').all(platform, modelId);
  const keys = modelId === null
    ? db.prepare('SELECT id FROM api_keys WHERE platform = ? AND enabled = 1').all(platform)
    : [];
  return {
    keys: (keys as Array<{ id: number }>).map(k => k.id),
    models: (models as Array<{ id: number }>).map(m => m.id),
  };
}

export function previewIgnore(list: IgnoreTarget[], db: Db = getDb()): IgnoreImpact {
  // A Set per kind: two targets can reach the same row (a provider and one of
  // its models), and the count is of rows that switch off, not of targets.
  const keySet = new Set<number>();
  const modelSet = new Set<number>();
  for (const { platform, modelId } of list) {
    const snap = targets(db, platform, modelId);
    for (const id of snap.keys) keySet.add(id);
    for (const id of snap.models) modelSet.add(id);
  }
  const keys = [...keySet];
  const models = [...modelSet];
  const chains = models.length === 0 ? [] : (db.prepare(`
    SELECT DISTINCT p.name
      FROM profile_models pm
      JOIN profiles p ON p.id = pm.profile_id
     WHERE pm.enabled = 1 AND pm.model_db_id IN (${models.map(() => '?').join(',')})
     ORDER BY p.name
  `).all(...models) as Array<{ name: string }>).map(r => r.name);
  return { keys: keys.length, models: models.length, chains };
}

/**
 * Ignore providers (modelId null) and models: switch their keys and models
 * off, remember per target which were on, and keep them off from here. A
 * target already ignored is skipped. All targets land together or none do.
 */
export function ignoreInCatalogue(list: IgnoreTarget[], db: Db = getDb()): IgnoreImpact {
  return db.transaction(() => {
    const impact = previewIgnore(list, db);
    const exists = db.prepare('SELECT 1 FROM catalogue_ignores WHERE platform = ? AND model_id = ?');
    const insert = db.prepare('INSERT INTO catalogue_ignores (platform, model_id, restore_json) VALUES (?, ?, ?)');
    const offModel = db.prepare('UPDATE models SET enabled = 0 WHERE id = ?');
    const offKey = db.prepare('UPDATE api_keys SET enabled = 0 WHERE id = ?');
    for (const { platform, modelId } of list) {
      if (exists.get(platform, modelId ?? '')) continue;
      const snap = targets(db, platform, modelId);
      insert.run(platform, modelId ?? '', JSON.stringify(snap));
      for (const id of snap.models) offModel.run(id);
      for (const id of snap.keys) offKey.run(id);
    }
    return impact;
  })();
}

/** Lift an ignore and switch back on exactly what it switched off. Null when
 *  nothing was ignored under that name. */
export function unignoreInCatalogue(platform: string, modelId: string | null, db: Db = getDb()): { keys: number; models: number } | null {
  return db.transaction(() => {
    const row = db.prepare('SELECT restore_json FROM catalogue_ignores WHERE platform = ? AND model_id = ?')
      .get(platform, modelId ?? '') as { restore_json: string } | undefined;
    if (!row) return null;
    db.prepare('DELETE FROM catalogue_ignores WHERE platform = ? AND model_id = ?').run(platform, modelId ?? '');
    const snap = parseSnapshot(row.restore_json);
    const onModel = db.prepare('UPDATE models SET enabled = 1 WHERE id = ?');
    let models = 0;
    for (const id of snap.models) models += onModel.run(id).changes;
    const onKey = db.prepare('UPDATE api_keys SET enabled = 1 WHERE id = ?');
    let keys = 0;
    for (const id of snap.keys) keys += onKey.run(id).changes;
    // A model inside a provider that is still ignored (or ignored on its own)
    // must not come back on through this restore.
    enforceCatalogueIgnores(db);
    return { keys, models };
  })();
}

/**
 * Keep ignored things off. Run after every catalog apply (inside its
 * transaction) and after an un-ignore: a provider's new arrivals land on, and
 * a key added for an ignored provider would route; this switches them off.
 * Returns how many rows it switched off.
 */
export function enforceCatalogueIgnores(db: Db = getDb()): number {
  const models = db.prepare(`UPDATE models SET enabled = 0 WHERE enabled = 1 AND ${ignoredSql('models')}`).run().changes;
  const keys = db.prepare(`
    UPDATE api_keys SET enabled = 0
     WHERE enabled = 1 AND platform IN (SELECT platform FROM catalogue_ignores WHERE model_id = '')
  `).run().changes;
  return models + keys;
}
