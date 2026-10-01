import { getDb } from '../db/index.js';
import type { Db } from '../db/types.js';
import type { RetiredChainMembership } from './model-state.js';

// What the catalogue gained and lost, per provider.
//
// The two halves were tracked very differently. Departures had a table —
// provider's own words, date, relist history — while arrivals had nothing at
// all, and the asymmetry cost real routing: two `nex-agi/nex-n2.5:free` models
// arrived in a sync, the Default profile auto-included them, and they served
// traffic before anyone knew they existed. They were found by accident.
//
// Deliberately read-only and deliberately NOT a reassignment tool. Chain
// membership belongs to a reviewed source file; a panel that edited it would
// recreate `auto_include_new_models` in a new place, which is the exact failure
// this exists to make visible.
//
// The one write is an ACKNOWLEDGEMENT: recording that the operator has read a
// change, so it stops repeating. It moves nothing, routes nothing and deletes
// nothing — every row here survives it, and the full record is still in
// `catalogue_event`. What it changes is whether this panel lists the row, and
// that filtering happens in the CLIENT, because this response is shared with
// the Keys page's provider chips and must keep counting acknowledged rows.

export interface ArrivedModel {
  platform: string;
  modelId: string;
  displayName: string;
  firstSeenAt: string;
  routed: boolean;
  chains: string[];
  /** The operator has read this arrival. Read from `catalogue_ack`, which is
   *  arrivals only: a departure's marker lives on its tombstone, so a
   *  re-retirement after a relist is unread again. */
  acknowledged: boolean;
  supportsTools: boolean;
  supportsVision: boolean;
  contextWindow: number | null;
}

export interface DepartedModel {
  platform: string;
  modelId: string;
  retiredAt: string;
  /** The provider's own words, verbatim. */
  reason: string | null;
  /** What it was serving when it left — the capability actually lost. Empty
   *  when it was routed nowhere, or when it retired before this was captured. */
  lostFrom: RetiredChainMembership[];
  acknowledgedAt: string | null;
  /** The same field the panel filters on, under the name arrivals use, so the
   *  client can treat both lists with one rule. */
  acknowledged: boolean;
}
// `relisted_at` / `relist_count` are deliberately absent. Those columns exist in
// some deployed databases, carried in from a sibling EOL branch, but nothing on
// THIS branch ever writes them — reporting a field that is always null would be
// worse than not reporting it.

export interface CatalogueChanges {
  /** ISO cutoff the arrivals were selected against, echoed so the caller can
   *  render "since ..." without recomputing it. */
  since: string;
  arrived: ArrivedModel[];
  departed: DepartedModel[];
  /**
   * Models with no `first_seen_at`. They predate arrival tracking, and are
   * reported as a COUNT rather than folded into `arrived` — dating them to the
   * migration would read exactly like a measurement.
   */
  untrackedArrivals: number;
}

function parseChains(raw: string | null): RetiredChainMembership[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed as RetiredChainMembership[] : [];
  } catch {
    return [];
  }
}

interface ArrivedRow {
  platform: string; model_id: string; display_name: string; first_seen_at: string;
  supports_tools: number; supports_vision: number; context_window: number | null;
  chains: string | null;
  acknowledged: 0 | 1;
}

interface DepartedRow {
  platform: string; model_id: string; created_at: string; reason: string | null;
  chains_json: string | null; acknowledged_at: string | null;
}

/**
 * @param sinceDays how far back an arrival still counts as news. Departures are
 *   NOT windowed: an unacknowledged retirement stays on the panel until it is
 *   dealt with, because the gap it left does not heal on its own.
 */
export function getCatalogueChanges(sinceDays = 30, db: Db = getDb()): CatalogueChanges {
  const since = new Date(Date.now() - sinceDays * 86_400_000).toISOString().replace('T', ' ').slice(0, 19);

  // LEFT JOIN, never an inner one and never a WHERE: an acknowledged arrival is
  // still an arrival, and the Keys page's churn chips count these rows
  // independently of whether anyone has read them. Filtering belongs to the
  // panel, in the client.
  const arrivedRows = db.prepare(`
    SELECT m.platform, m.model_id, m.display_name, m.first_seen_at,
           m.supports_tools, m.supports_vision, m.context_window,
           (a.model_id IS NOT NULL) AS acknowledged,
           (SELECT GROUP_CONCAT(p.name, '\u0001')
              FROM profile_models pm
              JOIN profiles p ON p.id = pm.profile_id
             WHERE pm.model_db_id = m.id AND pm.enabled = 1) AS chains
      FROM models m
      LEFT JOIN catalogue_ack a
             ON a.platform = m.platform AND a.model_id = m.model_id
     WHERE m.first_seen_at IS NOT NULL AND m.first_seen_at >= ?
     ORDER BY m.first_seen_at DESC, m.platform, m.model_id
  `).all(since) as ArrivedRow[];

  const departedRows = db.prepare(`
    SELECT platform, model_id, created_at, reason, chains_json,
           acknowledged_at
      FROM catalog_model_tombstones
     WHERE kind = 'chat' AND source = 'upstream_eol'
     ORDER BY created_at DESC
  `).all() as DepartedRow[];

  const untracked = db.prepare(
    'SELECT COUNT(*) AS c FROM models WHERE first_seen_at IS NULL',
  ).get() as { c: number };

  return {
    since,
    arrived: arrivedRows.map(r => {
      const chains = r.chains ? r.chains.split('\u0001') : [];
      return {
        platform: r.platform,
        modelId: r.model_id,
        displayName: r.display_name,
        firstSeenAt: r.first_seen_at,
        routed: chains.length > 0,
        chains,
        acknowledged: r.acknowledged === 1,
        supportsTools: r.supports_tools === 1,
        supportsVision: r.supports_vision === 1,
        contextWindow: r.context_window,
      };
    }),
    departed: departedRows.map(r => ({
      platform: r.platform,
      modelId: r.model_id,
      retiredAt: r.created_at,
      reason: r.reason,
      lostFrom: parseChains(r.chains_json),
      acknowledgedAt: r.acknowledged_at,
      acknowledged: r.acknowledged_at !== null,
    })),
    untrackedArrivals: untracked.c,
  };
}

/**
 * Mark a retirement as dealt with.
 *
 * The column has existed since the tombstone table gained provenance and
 * nothing ever set it, which is why it matters now: without an acknowledgement
 * every retirement stays "new" forever, the panel fills with departures from
 * months ago, and an operator stops reading the one surface meant to tell them
 * something broke.
 */
export function acknowledgeDeparture(platform: string, modelId: string, db: Db = getDb()): boolean {
  const info = db.prepare(`
    UPDATE catalog_model_tombstones SET acknowledged_at = datetime('now')
     WHERE kind = 'chat' AND platform = ? AND model_id = ? AND source = 'upstream_eol'
  `).run(platform, modelId);
  return Number(info.changes) > 0;
}

/**
 * Mark a batch of retirements as dealt with, for the panel's one OK button.
 *
 * Same column, same predicate as the single-row path, which is the point: this
 * is the same acknowledgement, written many at a time. It is deliberately NOT
 * `catalogue_ack`, because relisting deletes the tombstone and that marker
 * lives on it — a second retirement of the same model is a new incident and
 * must read as unread again.
 */
export function acknowledgeDepartures(
  models: readonly { platform: string; modelId: string }[],
  db: Db = getDb(),
): number {
  if (models.length === 0) return 0;
  const update = db.prepare(`
    UPDATE catalog_model_tombstones SET acknowledged_at = datetime('now')
     WHERE kind = 'chat' AND platform = ? AND model_id = ? AND source = 'upstream_eol'
  `);
  const run = db.transaction(() => {
    let changed = 0;
    for (const m of models) changed += Number(update.run(m.platform, m.modelId).changes);
    return changed;
  });
  return run();
}

/**
 * Mark a batch of arrivals as read.
 *
 * `INSERT OR IGNORE` rather than an upsert: the table has no timestamp, so a
 * second acknowledgement of the same arrival has nothing to update and must
 * not overwrite the first. The primary key makes the repeat a no-op, which is
 * what keeps a double-clicked OK button harmless.
 */
export function acknowledgeArrivals(
  models: readonly { platform: string; modelId: string }[],
  db: Db = getDb(),
): number {
  if (models.length === 0) return 0;
  const insert = db.prepare(
    'INSERT OR IGNORE INTO catalogue_ack (platform, model_id) VALUES (?, ?)',
  );
  const run = db.transaction(() => {
    let changed = 0;
    for (const m of models) changed += Number(insert.run(m.platform, m.modelId).changes);
    return changed;
  });
  return run();
}
