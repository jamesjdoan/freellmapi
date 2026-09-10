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
// This is the "before it routes" view. `scripts/apply-routing-curation.ts`
// already answers the same question afterwards — it reports anything routed
// that the curated spec does not name — but by then the requests have gone.
//
// Deliberately read-only and deliberately NOT a reassignment tool. Chain
// membership belongs to a reviewed source file; a panel that edited it would
// recreate `auto_include_new_models` in a new place, which is the exact failure
// this exists to make visible.

export interface ArrivedModel {
  platform: string;
  modelId: string;
  displayName: string;
  firstSeenAt: string;
  /** Whether it is already serving. A new model that auto-entered a chain is
   *  the urgent row on this panel; one sitting in the catalogue is not. */
  routed: boolean;
  chains: string[];
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

  const arrivedRows = db.prepare(`
    SELECT m.platform, m.model_id, m.display_name, m.first_seen_at,
           m.supports_tools, m.supports_vision, m.context_window,
           (SELECT GROUP_CONCAT(p.name, '\u0001')
              FROM profile_models pm
              JOIN profiles p ON p.id = pm.profile_id
             WHERE pm.model_db_id = m.id AND pm.enabled = 1) AS chains
      FROM models m
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
