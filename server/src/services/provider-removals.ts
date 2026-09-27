import { getDb } from '../db/index.js';
import { recordCatalogModelTombstone, serializeChainMembership } from './model-state.js';
import { recordCustomModelTombstone } from './custom-model-tombstone.js';
import { endpointScopeOfKey } from '../lib/endpoint-scope.js';
import { pruneUnavailableSavedFusionConfig } from './fusion.js';
import type { Db } from '../db/types.js';

// A provider the operator has given up on, recorded with the reason.
//
// Three things have to be true for a provider to count as removed, and none
// of them is "the key is gone":
//
//   1. It is in `provider_removal`, with a reason the operator wrote. The row
//      is the log, and the reason is the part worth reading later.
//   2. Its models are gone from the catalogue, each tombstoned on the way out,
//      so catalog sync cannot re-insert them and the custom-model sync cannot
//      re-add a relay's models. Tombstoning is the existing per-model contract
//      (#926); this only says "do it for all of them, and record the why".
//   3. Its chain memberships are dropped, because a chain that still names a
//      deleted model is a chain the router has to skip at request time.
//
// What this does NOT do: touch the key row. A removed provider can keep its
// credential, and restoring the provider puts the models back without asking
// the operator to re-enter anything.

export interface ProviderRemoval {
  platform: string
  reason: string | null
  note: string | null
  removedAt: string
  removedBy: 'provider' | 'key'
  modelsRemoved: number
  keyIds: number[]
  restoredAt: string | null
  restoredBy: string | null
}

interface RemovalRow {
  platform: string
  reason: string | null
  note: string | null
  removed_at: string
  removed_by: string
  models_removed: number
  key_ids_json: string
  restored_at: string | null
  restored_by: string | null
}

const toRemoval = (r: RemovalRow): ProviderRemoval => ({
  platform: r.platform,
  reason: r.reason,
  note: r.note,
  removedAt: r.removed_at,
  removedBy: r.removed_by === 'key' ? 'key' : 'provider',
  modelsRemoved: Number(r.models_removed),
  keyIds: (() => { try { return JSON.parse(r.key_ids_json) as number[] } catch { return [] } })(),
  restoredAt: r.restored_at,
  restoredBy: r.restored_by,
})

/** Every removal, newest first. Restored rows are kept: the log is history. */
export function listProviderRemovals(db: Db = getDb()): ProviderRemoval[] {
  return (db.prepare('SELECT * FROM provider_removal ORDER BY removed_at DESC').all() as RemovalRow[]).map(toRemoval)
}

/** Active removals only — what the Keys page and the sync filter act on. */
export function removedPlatforms(db: Db = getDb()): Set<string> {
  return new Set(
    (db.prepare('SELECT platform FROM provider_removal WHERE restored_at IS NULL').all() as { platform: string }[])
      .map(r => r.platform),
  )
}

export function getProviderRemoval(platform: string, db: Db = getDb()): ProviderRemoval | null {
  const row = db.prepare('SELECT * FROM provider_removal WHERE platform = ?').get(platform) as RemovalRow | undefined
  return row ? toRemoval(row) : null
}

export interface RemoveProviderResult {
  platform: string
  modelsRemoved: number
  keysKept: number
}

/**
 * Remove a whole provider: its models out of the catalogue, every one
 * tombstoned, and one row saying why. The key is left alone unless the caller
 * says otherwise — a provider whose credential is still good is one the
 * operator may want back.
 */
export function removeProvider(
  platform: string,
  input: { reason: string | null; note: string | null; removedBy: 'provider' | 'key'; deleteKeys?: boolean },
  db: Db = getDb(),
): RemoveProviderResult {
  const models = db.prepare('SELECT id, model_id, key_id, source FROM models WHERE platform = ?').all(platform) as
    { id: number; model_id: string; key_id: number | null; source: string | null }[]
  const keys = db.prepare('SELECT id FROM api_keys WHERE platform = ?').all(platform) as { id: number }[]

  db.transaction(() => {
    for (const m of models) {
      const chains = serializeChainMembership(db, m.id)
      if (platform === 'custom') {
        recordCustomModelTombstone(db, endpointScopeOfKey(db, m.key_id), m.model_id)
      } else {
        // Catalogue models: the same tombstone a per-model delete leaves, with
        // the reason, so "why is this gone" survives in the model log too.
        recordCatalogModelTombstone(db, 'chat', platform, m.model_id, { source: 'user', reason: input.reason, chains })
      }
      db.prepare('DELETE FROM fallback_config WHERE model_db_id = ?').run(m.id)
      db.prepare('DELETE FROM profile_models WHERE model_db_id = ?').run(m.id)
      db.prepare('DELETE FROM models WHERE id = ?').run(m.id)
    }
    if (input.deleteKeys) {
      for (const k of keys) db.prepare('DELETE FROM api_keys WHERE id = ?').run(k.id)
    }
    db.prepare(`
      INSERT INTO provider_removal (platform, reason, note, removed_by, models_removed, key_ids_json, restored_at)
      VALUES (?, ?, ?, ?, ?, ?, NULL)
      ON CONFLICT(platform) DO UPDATE SET
        reason = excluded.reason, note = excluded.note, removed_by = excluded.removed_by,
        models_removed = excluded.models_removed, key_ids_json = excluded.key_ids_json,
        removed_at = excluded.removed_at, restored_at = NULL, restored_by = NULL
    `).run(platform, input.reason, input.note, input.removedBy, models.length, JSON.stringify(keys.map(k => k.id)))
    pruneUnavailableSavedFusionConfig()
  })()

  return { platform, modelsRemoved: models.length, keysKept: input.deleteKeys ? 0 : keys.length }
}

/**
 * Undo a removal. The models themselves are NOT resurrected — the tombstone
 * is the per-model "keep it deleted" contract, and a model the operator
 * deleted for any other reason should stay deleted. What comes back is the
 * provider: its row leaves the list, so catalog sync may list it again, and
 * the removal is marked restored rather than erased.
 */
export function restoreProvider(platform: string, db: Db = getDb()): ProviderRemoval | null {
  db.prepare(`
    UPDATE provider_removal SET restored_at = datetime('now'), restored_by = 'operator'
     WHERE platform = ? AND restored_at IS NULL
  `).run(platform)
  return getProviderRemoval(platform, db)
}
