import { getDb } from '../db/index.js';
import type { Db } from '../db/types.js';
import type { RetiredChainMembership } from './model-state.js';

// An append-only history of models entering and leaving the catalogue.
//
// Distinct from the two surfaces that already exist, both of which report
// CURRENT state:
//   - `models.first_seen_at` is an arrival date stored on the model row, so it
//     dies with the row. A model that arrived and later left leaves nothing.
//   - `catalog_model_tombstones` holds one row per model and overwrites
//     `created_at` on re-retirement, so a model that has come and gone three
//     times reads as a single departure.
//
// And one departure path recorded nothing whatsoever: catalog sync prunes
// models the upstream catalogue has stopped listing with a bare DELETE, so a
// provider dropping a model made it vanish silently. That is the gap this
// closes.
//
// Rows are written once and never updated. Nothing here is load-bearing for
// routing - it is the record you read when a chain has quietly changed shape
// and you need to know what the providers did.

export type CatalogueEventKind =
  /** Row inserted - the catalogue gained it. */
  | 'arrived'
  /** Provider reports it withdrawn. The row survives, disabled, so the id
   *  still resolves and the operator can disagree. */
  | 'retired'
  /** Row deleted: the sync prune, or the operator deleting it outright. */
  | 'removed'
  /** A retirement lifted - it is serving again. */
  | 'relisted';

export interface CatalogueEvent {
  id: number;
  at: string;
  kind: CatalogueEventKind;
  platform: string;
  modelId: string;
  displayName: string | null;
  /** `catalog`, `user` or `upstream_eol`: the difference between "the provider
   *  withdrew this" and "I deleted it". */
  source: string | null;
  /** The provider's own words for a retirement, verbatim. */
  reason: string | null;
  /** What it was serving when it left. Empty when it was routed nowhere, or
   *  when the event predates chain capture. */
  chains: RetiredChainMembership[];
}

interface EventRow {
  id: number; at: string; kind: string; platform: string; model_id: string;
  display_name: string | null; source: string | null; reason: string | null;
  chains_json: string | null;
}

function parseChains(raw: string | null): RetiredChainMembership[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed as RetiredChainMembership[] : [];
  } catch {
    // A hand-edited or truncated value must not take the whole log down with
    // it: the event itself is still worth reporting without its chain list.
    return [];
  }
}

/**
 * Append one event. Never throws into the caller: every call site sits inside
 * a catalogue write (a sync applying hundreds of models, a key registering its
 * own), and losing a log row is strictly better than failing the operation the
 * log is describing.
 */
export function recordCatalogueEvent(
  db: Db,
  event: {
    kind: CatalogueEventKind;
    platform: string;
    modelId: string;
    displayName?: string | null;
    source?: string | null;
    reason?: string | null;
    /** Pre-serialised, matching what the tombstone stores. */
    chainsJson?: string | null;
  },
): void {
  try {
    db.prepare(`
      INSERT INTO catalogue_event (kind, platform, model_id, display_name, source, reason, chains_json)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      event.kind, event.platform, event.modelId,
      event.displayName ?? null, event.source ?? null,
      event.reason ?? null, event.chainsJson ?? null,
    );
  } catch (error) {
    console.warn('[catalogue-log] could not record event:', error instanceof Error ? error.message : error);
  }
}

export interface CatalogueLogQuery {
  /** One provider, or every provider when absent. */
  platform?: string;
  kind?: CatalogueEventKind;
  /** Newest first, capped. */
  limit?: number;
  /** Skip this many, for paging through a long history. */
  offset?: number;
}

export interface CatalogueLogPage {
  events: CatalogueEvent[];
  /** Total matching the filter, so a caller can tell a full page from the end
   *  of the history without asking for one more row. */
  total: number;
  /** Per-provider counts across the WHOLE log, unfiltered by platform, so the
   *  filter control can be built without a second request. */
  byPlatform: { platform: string; arrived: number; departed: number }[];
}

const MAX_LIMIT = 500;

export function listCatalogueEvents(query: CatalogueLogQuery = {}, db: Db = getDb()): CatalogueLogPage {
  const limit = Math.min(Math.max(query.limit ?? 100, 1), MAX_LIMIT);
  const offset = Math.max(query.offset ?? 0, 0);

  const where: string[] = [];
  const params: unknown[] = [];
  if (query.platform) { where.push('platform = ?'); params.push(query.platform); }
  if (query.kind) { where.push('kind = ?'); params.push(query.kind); }
  const clause = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';

  const rows = db.prepare(`
    SELECT id, at, kind, platform, model_id, display_name, source, reason, chains_json
      FROM catalogue_event
      ${clause}
     ORDER BY at DESC, id DESC
     LIMIT ? OFFSET ?
  `).all(...params, limit, offset) as EventRow[];

  const total = (db.prepare(`SELECT COUNT(*) AS c FROM catalogue_event ${clause}`)
    .get(...params) as { c: number }).c;

  // `removed` counts as a departure alongside `retired`: from the operator's
  // side both mean the model is no longer there to route to.
  const byPlatform = db.prepare(`
    SELECT platform,
           SUM(CASE WHEN kind IN ('arrived', 'relisted') THEN 1 ELSE 0 END) AS arrived,
           SUM(CASE WHEN kind IN ('retired', 'removed') THEN 1 ELSE 0 END) AS departed
      FROM catalogue_event
     GROUP BY platform
     ORDER BY COUNT(*) DESC, platform
  `).all() as { platform: string; arrived: number; departed: number }[];

  return {
    events: rows.map(r => ({
      id: r.id,
      at: r.at,
      kind: r.kind as CatalogueEventKind,
      platform: r.platform,
      modelId: r.model_id,
      displayName: r.display_name,
      source: r.source,
      reason: r.reason,
      chains: parseChains(r.chains_json),
    })),
    total,
    byPlatform,
  };
}
