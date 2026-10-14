import { getDb } from '../db/index.js';
import type { Db } from '../db/types.js';
import { isIgnored, loadIgnoreSets, type IgnoreSets } from './catalogue-ignores.js';

// The sync-level companion to catalogue-log: one row per APPLIED catalog
// document, with what the feed changed vs the previous document and what the
// database actually did.
//
// catalogue_event answers "what happened to each MODEL"; this answers "what
// did each catalog UPDATE bring" — the date, the version, the tier, and the
// quantities. The per-model field diffs live in details_json because a sync
// can move hundreds of fields and the row must stay one row.
//
// Rows are written once and never updated, and nothing here is load-bearing
// for routing.

/** Field-level change rows are capped so one row can never grow unbounded;
 *  the counts stay exact even past the cap. */
export const DETAILS_CAP = 400;

/** The registries a catalog document carries, keyed the way the diff reports
 *  them. `models[]` splits by modality into chat and media; the other three
 *  are the document's own optional snapshots. */
export type CatalogRegistry = 'chat' | 'media' | 'stt' | 'video' | 'embedding';

export interface CatalogFieldChange {
  /** chat | media | stt | video | embedding */
  r: string;
  p: string;
  m: string;
  f: string;
  /** Feed-verbatim values; booleans arrive as booleans, arrays as JSON strings. */
  o: string | number | boolean | null;
  n: string | number | boolean | null;
}

/** Per-provider churn: added, removed, edited, switched off, switched on. */
export interface PlatformChurn { a: number; r: number; c: number; off: number; on: number }

/** One model that entered or left a registry between two documents. */
export interface CatalogMember {
  /** chat | media | stt | video | embedding */
  r: string;
  p: string;
  m: string;
  /** Display name as the document that held it gave it. */
  n: string | null;
}

/** Which models arrived and departed in one update, each list capped. */
export interface CatalogMembers {
  added: CatalogMember[];
  removed: CatalogMember[];
}

/** Document-vs-document quantities plus the per-platform rollup and the
 *  (capped) field-level detail. The vocabulary of one sync-log row. */
export interface CatalogDocDiff {
  added: number;
  removed: number;
  /** Models with a real field edit; on/off flips are counted apart. */
  changed: number;
  /** Models the feed switched off: still listed, no longer served. */
  switchedOff: number;
  switchedOn: number;
  byPlatform: Record<string, PlatformChurn>;
  details: CatalogFieldChange[];
  members: CatalogMembers;
}

export interface CatalogueSyncInput {
  version: string;
  /** Null when no previously applied document was known: a baseline. */
  previousVersion: string | null;
  tier: string;
  generatedAt: string | null;
  /** applyCatalog's counts — what the database actually did. */
  counts: {
    updated: number;
    inserted: number;
    removed: number;
    skippedUnknownPlatform: number;
    quirks: number;
  };
  /** Document-vs-document quantities, summed across every registry. */
  doc: { added: number; removed: number; changed: number; switchedOff: number; switchedOn: number };
  byPlatform: Record<string, PlatformChurn>;
  details: CatalogFieldChange[];
  members: CatalogMembers;
}

export interface CatalogueSyncRow {
  id: number;
  at: string;
  version: string;
  previousVersion: string | null;
  tier: string;
  generatedAt: string | null;
  updated: number;
  inserted: number;
  removed: number;
  skippedUnknownPlatform: number;
  quirks: number;
  docAdded: number;
  docRemoved: number;
  docChanged: number;
  docSwitchedOff: number;
  docSwitchedOn: number;
  byPlatform: Record<string, PlatformChurn>;
}

export interface CatalogueSyncDetailRow extends CatalogueSyncRow {
  details: CatalogFieldChange[];
  /** Null for a row written before model names were recorded and that the
   *  backfill could not reconstruct exactly: the counts stand, the names are
   *  unknown. */
  members: CatalogMembers | null;
}

/** Whole-log quantities, independent of the page being read. */
export interface CatalogueSyncTotals {
  syncs: number;
  added: number;
  removed: number;
  changed: number;
  switchedOff: number;
  switchedOn: number;
  /** Model changes left out because their provider or model is ignored. */
  hiddenIgnored: number;
  lastAt: string | null;
  lastVersion: string | null;
}

export interface CatalogueSyncPage {
  syncs: CatalogueSyncRow[];
  total: number;
  totals: CatalogueSyncTotals;
}

export interface CatalogueSyncQuery {
  /** Newest first, capped. */
  limit?: number;
  /** Skip this many, for paging through a long history. */
  offset?: number;
}

interface SyncDbRow {
  id: number;
  at: string;
  version: string;
  previous_version: string | null;
  tier: string;
  generated_at: string | null;
  updated: number;
  inserted: number;
  removed: number;
  skipped_unknown_platform: number;
  quirks: number;
  doc_added: number;
  doc_removed: number;
  doc_changed: number;
  doc_switched_off: number;
  doc_switched_on: number;
  by_platform_json: string | null;
  details_json?: string | null;
  members_json?: string | null;
}

const MAX_LIMIT = 200;

const ROW_COLUMNS = `id, at, version, previous_version, tier, generated_at,
           updated, inserted, removed, skipped_unknown_platform, quirks,
           doc_added, doc_removed, doc_changed, doc_switched_off, doc_switched_on, by_platform_json`;

function parseJson<T>(raw: string | null | undefined, fallback: T): T {
  if (!raw) return fallback;
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed === null ? fallback : (parsed as T);
  } catch {
    // A hand-edited or truncated value must not take the log down with it:
    // the row itself is still worth reporting without its payload.
    return fallback;
  }
}

function toRow(row: SyncDbRow): CatalogueSyncRow {
  return {
    id: row.id,
    at: row.at,
    version: row.version,
    previousVersion: row.previous_version,
    tier: row.tier,
    generatedAt: row.generated_at,
    updated: row.updated,
    inserted: row.inserted,
    removed: row.removed,
    skippedUnknownPlatform: row.skipped_unknown_platform,
    quirks: row.quirks,
    docAdded: row.doc_added,
    docRemoved: row.doc_removed,
    docChanged: row.doc_changed,
    docSwitchedOff: row.doc_switched_off,
    docSwitchedOn: row.doc_switched_on,
    byPlatform: parseJson<Record<string, PlatformChurn>>(row.by_platform_json, {}),
  };
}

/**
 * Append one sync row. Never throws into the caller: the call site sits in the
 * sync's aftermath, and losing a log row is strictly better than failing the
 * sync the row describes.
 */
export function recordCatalogueSync(db: Db, input: CatalogueSyncInput): void {
  try {
    db.prepare(`
      INSERT INTO catalogue_sync (
        version, previous_version, tier, generated_at,
        updated, inserted, removed, skipped_unknown_platform, quirks,
        doc_added, doc_removed, doc_changed, doc_switched_off, doc_switched_on,
        by_platform_json, details_json, members_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      input.version,
      input.previousVersion,
      input.tier,
      input.generatedAt,
      input.counts.updated,
      input.counts.inserted,
      input.counts.removed,
      input.counts.skippedUnknownPlatform,
      input.counts.quirks,
      input.doc.added,
      input.doc.removed,
      input.doc.changed,
      input.doc.switchedOff,
      input.doc.switchedOn,
      JSON.stringify(input.byPlatform),
      JSON.stringify(input.details.slice(0, DETAILS_CAP)),
      JSON.stringify({
        added: input.members.added.slice(0, DETAILS_CAP),
        removed: input.members.removed.slice(0, DETAILS_CAP),
      }),
    );
  } catch (error) {
    console.warn('[catalogue-sync-log] could not record sync:', error instanceof Error ? error.message : error);
  }
}

const churnWeight = (c: PlatformChurn) => c.a + c.r + c.c + (c.off ?? 0) + (c.on ?? 0);

/**
 * A sync row with ignored providers and models taken out. A provider is
 * dropped whole; an ignored model's own arrivals, departures, on/off flips and
 * edits are subtracted from its provider, using the row's stored names and
 * field changes. Counts are then re-summed from what is left.
 */
function withoutIgnored(row: SyncDbRow, sets: IgnoreSets): { row: CatalogueSyncRow; hidden: number; members: CatalogMembers | null; details: CatalogFieldChange[] } {
  const base = toRow(row);
  const members = parseJson<CatalogMembers | null>(row.members_json, null);
  const details = parseJson<CatalogFieldChange[]>(row.details_json, []);
  const before = Object.values(base.byPlatform).reduce((n, c) => n + churnWeight(c), 0);
  if (sets.providers.size === 0 && sets.models.size === 0) return { row: base, hidden: 0, members, details };

  const byPlatform: Record<string, PlatformChurn> = {};
  for (const [platform, churn] of Object.entries(base.byPlatform)) {
    if (!sets.providers.has(platform)) byPlatform[platform] = { ...churn, off: churn.off ?? 0, on: churn.on ?? 0 };
  }
  const subtract = (platform: string, k: keyof PlatformChurn) => {
    const churn = byPlatform[platform];
    if (churn && (churn[k] ?? 0) > 0) churn[k] = (churn[k] ?? 0) - 1;
  };
  for (const m of members?.added ?? []) if (!sets.providers.has(m.p) && isIgnored(sets, m.p, m.m)) subtract(m.p, 'a');
  for (const m of members?.removed ?? []) if (!sets.providers.has(m.p) && isIgnored(sets, m.p, m.m)) subtract(m.p, 'r');
  const editedIgnored = new Set<string>();
  for (const d of details) {
    if (sets.providers.has(d.p) || !isIgnored(sets, d.p, d.m)) continue;
    if (d.f !== 'enabled') {
      const key = `${d.r}:${d.p}:${d.m}`;
      if (!editedIgnored.has(key)) { editedIgnored.add(key); subtract(d.p, 'c'); }
    } else if (d.o === true && d.n === false) subtract(d.p, 'off');
    else if (d.o === false && d.n === true) subtract(d.p, 'on');
  }
  for (const [platform, churn] of Object.entries(byPlatform)) if (churnWeight(churn) === 0) delete byPlatform[platform];

  const sum = (k: keyof PlatformChurn) => Object.values(byPlatform).reduce((n, c) => n + (c[k] ?? 0), 0);
  const after = Object.values(byPlatform).reduce((n, c) => n + churnWeight(c), 0);
  return {
    row: { ...base, byPlatform, docAdded: sum('a'), docRemoved: sum('r'), docChanged: sum('c'), docSwitchedOff: sum('off'), docSwitchedOn: sum('on') },
    hidden: before - after,
    members: members && {
      added: members.added.filter(m => !isIgnored(sets, m.p, m.m)),
      removed: members.removed.filter(m => !isIgnored(sets, m.p, m.m)),
    },
    details: details.filter(d => !isIgnored(sets, d.p, d.m)),
  };
}

export function listCatalogueSyncs(query: CatalogueSyncQuery = {}, db: Db = getDb()): CatalogueSyncPage {
  const limit = Math.min(Math.max(1, query.limit ?? 50), MAX_LIMIT);
  const offset = Math.max(0, query.offset ?? 0);
  // Every row, so the totals describe the whole log after ignores are taken
  // out. The table grows by one row per applied document; this stays small.
  const rows = db.prepare(`
    SELECT ${ROW_COLUMNS}, details_json, members_json
      FROM catalogue_sync
     ORDER BY at DESC, id DESC
  `).all() as SyncDbRow[];
  const sets = loadIgnoreSets(db);
  const filtered = rows.map(r => withoutIgnored(r, sets));
  const sum = (k: 'docAdded' | 'docRemoved' | 'docChanged' | 'docSwitchedOff' | 'docSwitchedOn') =>
    filtered.reduce((n, f) => n + f.row[k], 0);

  return {
    syncs: filtered.slice(offset, offset + limit).map(f => f.row),
    total: rows.length,
    totals: {
      syncs: rows.length,
      added: sum('docAdded'),
      removed: sum('docRemoved'),
      changed: sum('docChanged'),
      switchedOff: sum('docSwitchedOff'),
      switchedOn: sum('docSwitchedOn'),
      hiddenIgnored: filtered.reduce((n, f) => n + f.hidden, 0),
      lastAt: rows[0]?.at ?? null,
      lastVersion: rows[0]?.version ?? null,
    },
  };
}

export function getCatalogueSync(id: number, db: Db = getDb()): CatalogueSyncDetailRow | null {
  const row = db.prepare(`
    SELECT ${ROW_COLUMNS}, details_json, members_json
      FROM catalogue_sync
     WHERE id = ?
  `).get(id) as SyncDbRow | undefined;
  if (!row) return null;
  const filtered = withoutIgnored(row, loadIgnoreSets(db));
  return { ...filtered.row, details: filtered.details, members: filtered.members };
}
