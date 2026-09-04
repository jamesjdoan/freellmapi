import type { Db } from '../db/types.js';

export type CatalogModelKind = 'chat' | 'media';

export interface ModelOverridePatch {
  displayName?: string;
  intelligenceRank?: number;
  speedRank?: number;
  sizeLabel?: string;
  rpmLimit?: number | null;
  rpdLimit?: number | null;
  tpmLimit?: number | null;
  tpdLimit?: number | null;
  monthlyTokenBudget?: string;
  contextWindow?: number | null;
  supportsVision?: boolean;
  supportsTools?: boolean;
  enabled?: boolean;
}

type StoredOverrides = Partial<ModelOverridePatch>;

const OVERRIDE_COLUMNS: Record<keyof ModelOverridePatch, string> = {
  displayName: 'display_name',
  intelligenceRank: 'intelligence_rank',
  speedRank: 'speed_rank',
  sizeLabel: 'size_label',
  rpmLimit: 'rpm_limit',
  rpdLimit: 'rpd_limit',
  tpmLimit: 'tpm_limit',
  tpdLimit: 'tpd_limit',
  monthlyTokenBudget: 'monthly_token_budget',
  contextWindow: 'context_window',
  supportsVision: 'supports_vision',
  supportsTools: 'supports_tools',
  enabled: 'enabled',
};

function parseOverrides(raw: string | undefined): StoredOverrides {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === 'object' ? parsed as StoredOverrides : {};
  } catch {
    return {};
  }
}

function toDbValue(key: keyof ModelOverridePatch, value: unknown): unknown {
  if (key === 'supportsVision' || key === 'supportsTools' || key === 'enabled') return value ? 1 : 0;
  return value;
}

function cleanPatch(patch: ModelOverridePatch): StoredOverrides {
  const cleaned: StoredOverrides = {};
  for (const key of Object.keys(OVERRIDE_COLUMNS) as Array<keyof ModelOverridePatch>) {
    if (Object.prototype.hasOwnProperty.call(patch, key)) {
      cleaned[key] = patch[key] as never;
    }
  }
  return cleaned;
}

/**
 * The fields a stored overrides blob actually overrides, for callers that
 * already selected `model_overrides.overrides_json` alongside the model row.
 * The dashboard uses this to mark individual inputs as locally overridden
 * instead of flagging the whole model (#551).
 */
export function overriddenFieldNames(overridesJson: string | null | undefined): Array<keyof ModelOverridePatch> {
  const stored = parseOverrides(overridesJson ?? undefined);
  return (Object.keys(stored) as Array<keyof ModelOverridePatch>).filter(key => key in OVERRIDE_COLUMNS);
}

export function isCatalogManagedModel(row: { platform: string; key_id?: number | null; source?: string }): boolean {
  // `source` is the authoritative provenance (models.source, 'catalog'|'user');
  // callers that select it get an exact answer. The platform/key_id fallback
  // covers callers that don't have the column in hand.
  if (row.source === 'user') return false;
  return row.platform !== 'custom' && row.key_id == null;
}

// Why a catalog model carries a tombstone:
//   'user'        — deleted in the dashboard. Stays deleted across syncs, and
//                   the row is removed from `models` on the next catalog apply.
//   'upstream_eol' — the provider reported it permanently gone (410 / end of
//                   life, issue #634). The row SURVIVES and is only disabled,
//                   so the dashboard can show "retired upstream" instead of
//                   silently losing the model.
//
// An upstream retirement is FIRST-HAND: this server asked the provider and the
// provider refused. The published catalogue is second-hand — it is built from
// the same `/models` roster that goes on advertising retired models — so a
// catalogue that still lists the model does not overturn it. That disagreement
// is recorded (`relistedAt` / `relistCount`) and surfaced until the operator
// settles it: acknowledge to leave the retirement standing, or re-enable
// routing to lift it. Nothing else lifts a retirement.
export type CatalogTombstoneSource = 'user' | 'upstream_eol';

export interface CatalogModelTombstone {
  source: CatalogTombstoneSource;
  reason: string | null;
  createdAt: string;
  /** Last time a synced catalogue re-listed this retired model as enabled. */
  relistedAt: string | null;
  relistCount: number;
  /** Set when the operator read the disagreement and kept the retirement. */
  acknowledgedAt: string | null;
}

export function getCatalogModelTombstone(
  db: Db,
  kind: CatalogModelKind,
  platform: string,
  modelId: string,
): CatalogModelTombstone | undefined {
  const row = db
    .prepare(`
      SELECT source, reason, created_at, relisted_at, relist_count, acknowledged_at
        FROM catalog_model_tombstones
       WHERE kind = ? AND platform = ? AND model_id = ?
    `)
    .get(kind, platform, modelId) as {
      source: string;
      reason: string | null;
      created_at: string;
      relisted_at: string | null;
      relist_count: number | null;
      acknowledged_at: string | null;
    } | undefined;
  if (!row) return undefined;
  return {
    source: row.source === 'upstream_eol' ? 'upstream_eol' : 'user',
    reason: row.reason ?? null,
    createdAt: row.created_at,
    relistedAt: row.relisted_at ?? null,
    relistCount: row.relist_count ?? 0,
    acknowledgedAt: row.acknowledged_at ?? null,
  };
}

/**
 * True only for models the USER deleted — the "keep it deleted" contract every
 * caller here means. An upstream-retirement tombstone deliberately does NOT
 * count: the row stays in the catalog's write path so its metadata keeps
 * tracking the catalogue while routing stays off.
 */
export function isCatalogModelTombstoned(
  db: Db,
  kind: CatalogModelKind,
  platform: string,
  modelId: string,
): boolean {
  return getCatalogModelTombstone(db, kind, platform, modelId)?.source === 'user';
}

export function recordCatalogModelTombstone(
  db: Db,
  kind: CatalogModelKind,
  platform: string,
  modelId: string,
  options: { source?: CatalogTombstoneSource; reason?: string | null } = {},
): void {
  const source: CatalogTombstoneSource = options.source ?? 'user';
  db.prepare(`
    INSERT INTO catalog_model_tombstones (kind, platform, model_id, source, reason)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(kind, platform, model_id)
    DO UPDATE SET created_at = datetime('now'), source = excluded.source, reason = excluded.reason
  `).run(kind, platform, modelId, source, options.reason ?? null);
  // A user deletion drops their local metadata edits with the row. An upstream
  // retirement keeps the row, so it keeps the overrides too — they must survive
  // if the model is reinstated.
  if (kind === 'chat' && source === 'user') {
    db.prepare('DELETE FROM model_overrides WHERE platform = ? AND model_id = ?').run(platform, modelId);
  }
}

/**
 * Auto-disable a catalog model the provider reports as permanently retired
 * (issue #634). Deliberately NOT a delete: the row stays visible in the
 * dashboard, tagged with the upstream wording, and the user can flip it back on
 * if they disagree. Turning off the chain entries (and the active profile's
 * copy) is exactly what the dashboard's own switch does, so the router stops
 * picking it while an explicitly-requested model id still resolves.
 *
 * Returns true when this call performed the retirement (false when it was
 * already retired, or the user had deleted the model outright).
 */
export function retireCatalogModelUpstream(
  db: Db,
  modelDbId: number,
  platform: string,
  modelId: string,
  reason: string,
): boolean {
  const existing = getCatalogModelTombstone(db, 'chat', platform, modelId);
  if (existing) return false;
  recordCatalogModelTombstone(db, 'chat', platform, modelId, { source: 'upstream_eol', reason });
  db.prepare('UPDATE fallback_config SET enabled = 0 WHERE model_db_id = ?').run(modelDbId);
  db.prepare('UPDATE profile_models SET enabled = 0 WHERE model_db_id = ?').run(modelDbId);
  return true;
}

/**
 * Record that a synced catalogue still lists a model this server has retired.
 *
 * This used to LIFT the retirement, on the reasoning that a fresh catalogue
 * outranks one provider response. It does not: the catalogue is generated from
 * the provider rosters that keep advertising retired models, so every sync
 * republished the same stale claim and un-retired the model, which then 410'd
 * again on the next request. Observed on this deployment against
 * nvidia/openai/gpt-oss-120b (410 "end of life") and google/gemini-2.5-flash
 * (404 "no longer available to new users"), both of which had to be pinned off
 * by hand.
 *
 * So the first-hand refusal stands and the disagreement is logged for the
 * operator. Returns true when a disagreement was recorded.
 */
export function noteCatalogRelistedRetiredModel(
  db: Db,
  platform: string,
  modelId: string,
): boolean {
  if (getCatalogModelTombstone(db, 'chat', platform, modelId)?.source !== 'upstream_eol') return false;
  db.prepare(`
    UPDATE catalog_model_tombstones
       SET relisted_at = datetime('now'), relist_count = relist_count + 1
     WHERE kind = 'chat' AND platform = ? AND model_id = ?
  `).run(platform, modelId);
  return true;
}

/**
 * Settle a disagreement by keeping the retirement: the model stays off and
 * stops being listed as unreconciled. Re-listing does NOT resurface it — the
 * operator has already ruled on this provider verdict, and the catalogue
 * republishes its claim twice a day. A fresh retirement (after an explicit
 * re-enable) starts with a clean row and can be raised again.
 */
export function acknowledgeUpstreamRetirement(
  db: Db,
  platform: string,
  modelId: string,
): boolean {
  if (getCatalogModelTombstone(db, 'chat', platform, modelId)?.source !== 'upstream_eol') return false;
  db.prepare(`
    UPDATE catalog_model_tombstones
       SET acknowledged_at = datetime('now')
     WHERE kind = 'chat' AND platform = ? AND model_id = ?
  `).run(platform, modelId);
  return true;
}

/**
 * Undo an acknowledgement, putting the disagreement back on the unreconciled
 * list. The retirement itself is untouched — this only reopens the question,
 * so a decision made in a hurry is reversible without having to route to a
 * model the provider refuses.
 */
export function unacknowledgeUpstreamRetirement(
  db: Db,
  platform: string,
  modelId: string,
): boolean {
  if (getCatalogModelTombstone(db, 'chat', platform, modelId)?.source !== 'upstream_eol') return false;
  db.prepare(`
    UPDATE catalog_model_tombstones
       SET acknowledged_at = NULL
     WHERE kind = 'chat' AND platform = ? AND model_id = ?
  `).run(platform, modelId);
  return true;
}

export interface UnreconciledRetirement {
  modelDbId: number | null;
  platform: string;
  modelId: string;
  displayName: string | null;
  reason: string | null;
  retiredAt: string;
  relistedAt: string | null;
  relistCount: number;
  acknowledgedAt: string | null;
}

/**
 * Upstream retirements the catalogue has contradicted, split by whether the
 * operator has ruled on them: `pending` drives the notice, `acknowledged` is
 * the audit trail of decisions already taken (kept out of the notice, but
 * reviewable and undoable).
 *
 * `models` is LEFT-joined: a catalogue can drop the model entirely while the
 * tombstone remains, and that row is still worth listing — it is the case
 * where provider and catalogue have finally agreed the model is gone.
 */
export function listRetirementDisagreements(db: Db): {
  pending: UnreconciledRetirement[];
  acknowledged: UnreconciledRetirement[];
} {
  const rows = db.prepare(`
    SELECT t.platform, t.model_id, t.reason, t.created_at, t.relisted_at, t.relist_count,
           t.acknowledged_at, m.id AS model_db_id, m.display_name
      FROM catalog_model_tombstones t
      LEFT JOIN models m ON m.platform = t.platform AND m.model_id = t.model_id
     WHERE t.kind = 'chat'
       AND t.source = 'upstream_eol'
       AND t.relisted_at IS NOT NULL
     ORDER BY t.relisted_at DESC
  `).all() as {
    platform: string;
    model_id: string;
    reason: string | null;
    created_at: string;
    relisted_at: string | null;
    relist_count: number | null;
    acknowledged_at: string | null;
    model_db_id: number | null;
    display_name: string | null;
  }[];
  const mapped = rows.map(row => ({
    modelDbId: row.model_db_id ?? null,
    platform: row.platform,
    modelId: row.model_id,
    displayName: row.display_name ?? null,
    reason: row.reason ?? null,
    retiredAt: row.created_at,
    relistedAt: row.relisted_at ?? null,
    relistCount: row.relist_count ?? 0,
    acknowledgedAt: row.acknowledged_at ?? null,
  }));
  return {
    pending: mapped.filter(item => item.acknowledgedAt == null),
    acknowledged: mapped.filter(item => item.acknowledgedAt != null),
  };
}

/**
 * Lift an upstream retirement. The ONLY caller is the operator re-enabling
 * routing from the dashboard: they have seen the provider's wording and
 * disagree. Clearing the tombstone also clears the reconciliation state, so a
 * later refusal can retire the model again from scratch. Returns true when a
 * retirement was actually lifted.
 */
export function reinstateUpstreamRetiredCatalogModel(
  db: Db,
  platform: string,
  modelId: string,
): boolean {
  if (getCatalogModelTombstone(db, 'chat', platform, modelId)?.source !== 'upstream_eol') return false;
  clearCatalogModelTombstone(db, 'chat', platform, modelId);
  const row = db
    .prepare('SELECT id FROM models WHERE platform = ? AND model_id = ?')
    .get(platform, modelId) as { id: number } | undefined;
  if (row) {
    db.prepare('UPDATE fallback_config SET enabled = 1 WHERE model_db_id = ?').run(row.id);
    db.prepare('UPDATE profile_models SET enabled = 1 WHERE model_db_id = ?').run(row.id);
  }
  return true;
}

export function clearCatalogModelTombstone(
  db: Db,
  kind: CatalogModelKind,
  platform: string,
  modelId: string,
): void {
  db.prepare('DELETE FROM catalog_model_tombstones WHERE kind = ? AND platform = ? AND model_id = ?')
    .run(kind, platform, modelId);
}

export function upsertModelOverrides(
  db: Db,
  platform: string,
  modelId: string,
  patch: ModelOverridePatch,
): StoredOverrides {
  const cleaned = cleanPatch(patch);
  if (Object.keys(cleaned).length === 0) return {};
  const existing = db
    .prepare('SELECT overrides_json FROM model_overrides WHERE platform = ? AND model_id = ?')
    .get(platform, modelId) as { overrides_json: string } | undefined;
  const merged: StoredOverrides = { ...parseOverrides(existing?.overrides_json), ...cleaned };
  db.prepare(`
    INSERT INTO model_overrides (platform, model_id, overrides_json, updated_at)
    VALUES (?, ?, ?, datetime('now'))
    ON CONFLICT(platform, model_id)
    DO UPDATE SET overrides_json = excluded.overrides_json, updated_at = excluded.updated_at
  `).run(platform, modelId, JSON.stringify(merged));
  return merged;
}

export function getModelOverrides(
  db: Db,
  platform: string,
  modelId: string,
): StoredOverrides {
  const row = db
    .prepare('SELECT overrides_json FROM model_overrides WHERE platform = ? AND model_id = ?')
    .get(platform, modelId) as { overrides_json: string } | undefined;
  return parseOverrides(row?.overrides_json);
}

/**
 * Every model whose stored overrides pin ONE given field, as a set of
 * "platform:model_id" keys. One query over a table that only ever holds the
 * models a user has actually touched, so callers that need "is this field
 * user-owned?" for a whole catalog don't do it per model.
 *
 * Note it keys off the field, not the row: a user who renamed a model has an
 * override row but has said nothing about its speed_rank, so a derived value
 * may still fill that column (#619).
 */
export function modelsWithOverriddenField(
  db: Db,
  field: keyof ModelOverridePatch,
): Set<string> {
  const rows = db.prepare('SELECT platform, model_id, overrides_json FROM model_overrides')
    .all() as { platform: string; model_id: string; overrides_json: string }[];
  const pinned = new Set<string>();
  for (const row of rows) {
    const overrides = parseOverrides(row.overrides_json);
    if (overrides[field] !== undefined) pinned.add(`${row.platform}:${row.model_id}`);
  }
  return pinned;
}

export function applyModelOverrides(
  db: Db,
  platform: string,
  modelId: string,
): boolean {
  const overrides = getModelOverrides(db, platform, modelId);
  const keys = (Object.keys(overrides) as Array<keyof ModelOverridePatch>).filter(k => k in OVERRIDE_COLUMNS);
  if (keys.length === 0) return false;

  const assignments: string[] = [];
  const values: unknown[] = [];
  for (const key of keys) {
    assignments.push(`${OVERRIDE_COLUMNS[key]} = ?`);
    values.push(toDbValue(key, overrides[key]));
  }
  values.push(platform, modelId);
  db.prepare(`UPDATE models SET ${assignments.join(', ')} WHERE platform = ? AND model_id = ?`).run(...values);
  return true;
}

export function applyAllModelOverrides(db: Db): number {
  const rows = db.prepare('SELECT platform, model_id FROM model_overrides').all() as { platform: string; model_id: string }[];
  let applied = 0;
  for (const row of rows) {
    if (applyModelOverrides(db, row.platform, row.model_id)) applied++;
  }
  return applied;
}

// Only USER tombstones delete rows. An upstream-retirement tombstone disables
// its model and keeps it (see retireCatalogModelUpstream), so deleting here
// would throw away both the row and the reason the dashboard shows for it.
export function deleteTombstonedCatalogModels(db: Db): number {
  const chatRows = db.prepare(`
    SELECT m.id, m.platform, m.model_id
      FROM models m
      JOIN catalog_model_tombstones t
        ON t.kind = 'chat' AND t.platform = m.platform AND t.model_id = m.model_id
     WHERE t.source = 'user' AND m.platform != 'custom' AND m.key_id IS NULL AND m.source != 'user'
  `).all() as { id: number; platform: string; model_id: string }[];
  const mediaRows = db.prepare(`
    SELECT mm.id
      FROM media_models mm
      JOIN catalog_model_tombstones t
        ON t.kind = 'media' AND t.platform = mm.platform AND t.model_id = mm.model_id
     WHERE t.source = 'user'
  `).all() as { id: number }[];

  const deleteChatFallback = db.prepare('DELETE FROM fallback_config WHERE model_db_id = ?');
  const deleteChat = db.prepare('DELETE FROM models WHERE id = ?');
  const deleteMedia = db.prepare('DELETE FROM media_models WHERE id = ?');

  for (const row of chatRows) {
    deleteChatFallback.run(row.id);
    deleteChat.run(row.id);
  }
  for (const row of mediaRows) {
    deleteMedia.run(row.id);
  }

  return chatRows.length + mediaRows.length;
}
