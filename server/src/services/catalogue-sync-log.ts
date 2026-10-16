import { getDb } from '../db/index.js';
import { removedPlatforms } from './provider-removals.js';
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

/** One local day of catalog updates, merged into a single net change. */
export interface CatalogueSyncDay extends CatalogueSyncRow {
  /** YYYY-MM-DD in the requested time zone. */
  day: string;
  /** The logged documents merged into this entry, oldest first. */
  ids: number[];
  /**
   * False when a merged document's names or field edits were capped, so the
   * day's counts are summed per document instead of netted per model: a model
   * added in the morning and removed at night then counts both ways.
   */
  netted: boolean;
}

export interface CatalogueSyncDetailRow extends CatalogueSyncDay {
  details: CatalogFieldChange[];
  /** Null for a row written before model names were recorded and that the
   *  backfill could not reconstruct exactly: the counts stand, the names are
   *  unknown. */
  members: CatalogMembers | null;
}

/** Whole-log quantities, independent of the page being read. */
export interface CatalogueSyncTotals {
  /** Days with a visible change. */
  syncs: number;
  added: number;
  removed: number;
  changed: number;
  switchedOff: number;
  switchedOn: number;
  /** Model changes left out because their provider or model is ignored. */
  hiddenIgnored: number;
  /** Model changes left out because no key exists for their provider. */
  hiddenUnkeyed: number;
  lastAt: string | null;
  lastVersion: string | null;
}

export interface CatalogueSyncPage {
  syncs: CatalogueSyncDay[];
  total: number;
  totals: CatalogueSyncTotals;
}

export interface CatalogueSyncQuery {
  /** Newest first, capped. */
  limit?: number;
  /** Skip this many, for paging through a long history. */
  offset?: number;
  hideIgnored?: boolean;
  /** Only providers this install holds a key for. Default true. */
  keyedOnly?: boolean;
  status?: 'all' | 'enabled' | 'disabled';
  /** IANA zone whose calendar days updates are merged by. Default UTC. */
  timeZone?: string;
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
 * Append one sync row, but only for a document that changed something against
 * the one before it. A republish with nothing moved is not an update anyone
 * needs to read, and the applied version is tracked in settings regardless.
 * Never throws into the caller: the call site sits in the sync's aftermath,
 * and losing a log row is strictly better than failing the sync it describes.
 */
export function recordCatalogueSync(db: Db, input: CatalogueSyncInput): void {
  const { added, removed, changed, switchedOff, switchedOn } = input.doc;
  if (added + removed + changed + switchedOff + switchedOn === 0) return;
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

/** Ignore sets plus the providers an active removal has vetted out: their
 *  churn is unreadable noise, and their tombstones mean no future document
 *  can bring them back. */
function withRemovedPlatforms(sets: IgnoreSets, db: Db): IgnoreSets {
  for (const platform of removedPlatforms(db)) sets.providers.add(platform);
  return sets;
}

/**
 * A sync row with ignored providers and models taken out. A provider is
 * dropped whole; an ignored model's own arrivals, departures, on/off flips and
 * edits are subtracted from its provider, using the row's stored names and
 * field changes. Counts are then re-summed from what is left.
 */
function withoutIgnored(row: SyncDbRow, sets: IgnoreSets, status: CatalogueSyncQuery['status'] = 'all', enabledModels?: Set<string>): { row: CatalogueSyncRow; hidden: number; members: CatalogMembers | null; details: CatalogFieldChange[] } {
  const base = toRow(row);
  const members = parseJson<CatalogMembers | null>(row.members_json, null);
  const details = parseJson<CatalogFieldChange[]>(row.details_json, []);
  const excluded = (r: string, p: string, m: string) => isIgnored(sets, p, m)
    || (status !== 'all' && enabledModels?.has(`${r}\0${p}\0${m}`) !== (status === 'enabled'));
  const before = Object.values(base.byPlatform).reduce((n, c) => n + churnWeight(c), 0);
  if (status === 'all' && sets.providers.size === 0 && sets.models.size === 0) return { row: base, hidden: 0, members, details };

  const byPlatform: Record<string, PlatformChurn> = {};
  for (const [platform, churn] of Object.entries(base.byPlatform)) {
    if (!sets.providers.has(platform)) byPlatform[platform] = { ...churn, off: churn.off ?? 0, on: churn.on ?? 0 };
  }
  const subtract = (platform: string, k: keyof PlatformChurn) => {
    const churn = byPlatform[platform];
    if (churn && (churn[k] ?? 0) > 0) churn[k] = (churn[k] ?? 0) - 1;
  };
  for (const m of members?.added ?? []) if (!sets.providers.has(m.p) && excluded(m.r, m.p, m.m)) subtract(m.p, 'a');
  for (const m of members?.removed ?? []) if (!sets.providers.has(m.p) && excluded(m.r, m.p, m.m)) subtract(m.p, 'r');
  const editedIgnored = new Set<string>();
  for (const d of details) {
    if (sets.providers.has(d.p) || !excluded(d.r, d.p, d.m)) continue;
    if (d.f !== 'enabled') {
      const key = `${d.r}:${d.p}:${d.m}`;
      if (!editedIgnored.has(key)) { editedIgnored.add(key); subtract(d.p, 'c'); }
    } else if (d.o === true && d.n === false) subtract(d.p, 'off');
    else if (d.o === false && d.n === true) subtract(d.p, 'on');
  }
  // Current-state filters can classify only the named, recorded changes.
  if (status !== 'all') {
    for (const platform of Object.keys(byPlatform)) delete byPlatform[platform];
    for (const m of members?.added ?? []) {
      if (excluded(m.r, m.p, m.m)) continue;
      (byPlatform[m.p] ??= { a: 0, r: 0, c: 0, off: 0, on: 0 }).a++;
    }
    for (const m of members?.removed ?? []) {
      if (excluded(m.r, m.p, m.m)) continue;
      (byPlatform[m.p] ??= { a: 0, r: 0, c: 0, off: 0, on: 0 }).r++;
    }
    const edited = new Set<string>();
    for (const d of details) {
      if (excluded(d.r, d.p, d.m)) continue;
      const churn = byPlatform[d.p] ??= { a: 0, r: 0, c: 0, off: 0, on: 0 };
      if (d.f === 'enabled') {
        if (d.o === true && d.n === false) churn.off++;
        else if (d.o === false && d.n === true) churn.on++;
      } else {
        const key = `${d.r}\0${d.p}\0${d.m}`;
        if (!edited.has(key)) { edited.add(key); churn.c++; }
      }
    }
  }
  for (const [platform, churn] of Object.entries(byPlatform)) if (churnWeight(churn) === 0) delete byPlatform[platform];

  const sum = (k: keyof PlatformChurn) => Object.values(byPlatform).reduce((n, c) => n + (c[k] ?? 0), 0);
  const after = Object.values(byPlatform).reduce((n, c) => n + churnWeight(c), 0);
  return {
    row: { ...base, byPlatform, docAdded: sum('a'), docRemoved: sum('r'), docChanged: sum('c'), docSwitchedOff: sum('off'), docSwitchedOn: sum('on') },
    hidden: before - after,
    members: members && {
      added: members.added.filter(m => !excluded(m.r, m.p, m.m)),
      removed: members.removed.filter(m => !excluded(m.r, m.p, m.m)),
    },
    details: details.filter(d => !excluded(d.r, d.p, d.m)),
  };
}

/** Current local enablement, not the feed's historical enabled flag. */
function enabledCatalogueModels(db: Db): Set<string> {
  const rows = db.prepare(`
    SELECT 'chat' AS registry, platform, model_id FROM models WHERE enabled = 1
    UNION ALL
    SELECT CASE modality WHEN 'transcription' THEN 'stt' WHEN 'video' THEN 'video' ELSE 'media' END,
           platform, model_id FROM media_models WHERE enabled = 1
    UNION ALL
    SELECT 'embedding', platform, model_id FROM embedding_models WHERE enabled = 1
  `).all() as Array<{ registry: string; platform: string; model_id: string }>;
  return new Set(rows.map(row => `${row.registry}\0${row.platform}\0${row.model_id}`));
}

/** Platforms this install holds at least one key for, in any state. */
function keyedPlatforms(db: Db): Set<string> {
  return new Set((db.prepare('SELECT DISTINCT platform FROM api_keys').all() as Array<{ platform: string }>).map(r => r.platform));
}

/** Every provider a row mentions, counts or names alike. */
function platformsIn(row: SyncDbRow): string[] {
  const out = new Set(Object.keys(parseJson<Record<string, PlatformChurn>>(row.by_platform_json, {})));
  const members = parseJson<CatalogMembers | null>(row.members_json, null);
  for (const m of [...(members?.added ?? []), ...(members?.removed ?? [])]) out.add(m.p);
  for (const d of parseJson<CatalogFieldChange[]>(row.details_json, [])) out.add(d.p);
  return [...out];
}

interface Filters {
  /** What the list hides: ignores (when asked), removals, and unkeyed providers (when asked). */
  sets: IgnoreSets;
  /** The same, without the unkeyed providers: what "hidden because ignored" counts against. */
  ignoreOnly: IgnoreSets;
  status: NonNullable<CatalogueSyncQuery['status']>;
  enabled: Set<string> | undefined;
  timeZone: string;
}

function filtersFor(query: CatalogueSyncQuery, rows: SyncDbRow[], db: Db): Filters {
  const ignoreOnly = query.hideIgnored === false
    ? { providers: new Set<string>(), models: new Set<string>() }
    : withRemovedPlatforms(loadIgnoreSets(db), db);
  const sets = { providers: new Set(ignoreOnly.providers), models: new Set(ignoreOnly.models) };
  if (query.keyedOnly !== false) {
    const keyed = keyedPlatforms(db);
    for (const row of rows) for (const p of platformsIn(row)) if (!keyed.has(p)) sets.providers.add(p);
  }
  const status = query.status ?? 'all';
  let timeZone = 'UTC';
  try {
    if (query.timeZone) { new Intl.DateTimeFormat('en-CA', { timeZone: query.timeZone }); timeZone = query.timeZone; }
  } catch {
    // An unknown zone groups by UTC rather than failing the page.
  }
  return { sets, ignoreOnly, status, enabled: status !== 'all' ? enabledCatalogueModels(db) : undefined, timeZone };
}

interface Part {
  row: CatalogueSyncRow;
  members: CatalogMembers | null;
  details: CatalogFieldChange[];
  /** Names and field edits were stored in full, so they can be netted. */
  complete: boolean;
}

function partOf(raw: SyncDbRow, f: Filters): Part {
  const filtered = withoutIgnored(raw, f.sets, f.status, f.enabled);
  const rawMembers = parseJson<CatalogMembers | null>(raw.members_json, null);
  const rawDetails = parseJson<CatalogFieldChange[]>(raw.details_json, []);
  const complete = rawMembers !== null
    && rawMembers.added.length === raw.doc_added
    && rawMembers.removed.length === raw.doc_removed
    && rawDetails.length < DETAILS_CAP;
  return { row: filtered.row, members: filtered.members, details: filtered.details, complete };
}

function dayOf(at: string, timeZone: string): string {
  const ms = Date.parse(`${at.replace(' ', 'T')}Z`);
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(ms);
}

const emptyChurn = (): PlatformChurn => ({ a: 0, r: 0, c: 0, off: 0, on: 0 });

/**
 * Merge one day's documents, oldest first, into a single net change. A model
 * added then removed the same day cancels out, a field edited twice reports
 * its first old value and last new one, and a value that ends where it began
 * drops out. Capped documents cannot be netted, so their counts are summed.
 */
interface MergedDay { row: CatalogueSyncDay; members: CatalogMembers | null; details: CatalogFieldChange[] }

function mergeDay(day: string, parts: Part[]): MergedDay {
  const first = parts[0];
  const last = parts[parts.length - 1];
  const total = (k: 'updated' | 'inserted' | 'removed' | 'skippedUnknownPlatform' | 'quirks') => parts.reduce((n, p) => n + p.row[k], 0);
  const header = {
    ...last.row,
    previousVersion: first.row.previousVersion,
    updated: total('updated'),
    inserted: total('inserted'),
    removed: total('removed'),
    skippedUnknownPlatform: total('skippedUnknownPlatform'),
    quirks: total('quirks'),
    day,
    ids: parts.map(p => p.row.id),
  };
  const finish = (byPlatform: Record<string, PlatformChurn>, netted: boolean) => {
    for (const [p, c] of Object.entries(byPlatform)) if (churnWeight(c) === 0) delete byPlatform[p];
    const sum = (k: keyof PlatformChurn) => Object.values(byPlatform).reduce((n, c) => n + (c[k] ?? 0), 0);
    return { ...header, byPlatform, netted, docAdded: sum('a'), docRemoved: sum('r'), docChanged: sum('c'), docSwitchedOff: sum('off'), docSwitchedOn: sum('on') };
  };

  if (parts.length === 1) {
    return { row: finish({ ...first.row.byPlatform }, true), members: first.members, details: first.details };
  }
  if (!parts.every(p => p.complete && p.members)) {
    const byPlatform: Record<string, PlatformChurn> = {};
    for (const p of parts) {
      for (const [platform, c] of Object.entries(p.row.byPlatform)) {
        const t = byPlatform[platform] ??= emptyChurn();
        t.a += c.a; t.r += c.r; t.c += c.c; t.off += c.off ?? 0; t.on += c.on ?? 0;
      }
    }
    const members = parts.every(p => p.members)
      ? { added: parts.flatMap(p => p.members!.added), removed: parts.flatMap(p => p.members!.removed) }
      : null;
    return { row: finish(byPlatform, false), members, details: parts.flatMap(p => p.details) };
  }

  const key = (r: string, p: string, m: string) => `${r}\0${p}\0${m}`;
  const added = new Map<string, CatalogMember>();
  const removed = new Map<string, CatalogMember>();
  const fields = new Map<string, CatalogFieldChange>();
  for (const part of parts) {
    for (const m of part.members!.added) {
      const k = key(m.r, m.p, m.m);
      if (removed.has(k)) removed.delete(k); else added.set(k, m);
    }
    for (const m of part.members!.removed) {
      const k = key(m.r, m.p, m.m);
      if (added.has(k)) added.delete(k); else removed.set(k, m);
    }
    for (const d of part.details) {
      const k = `${key(d.r, d.p, d.m)}\0${d.f}`;
      const seen = fields.get(k);
      fields.set(k, seen ? { ...seen, n: d.n } : { ...d });
    }
  }
  // An edit to a model that arrived or left the same day is part of that
  // arrival or departure, not a change of its own.
  const details = [...fields.values()].filter(d =>
    JSON.stringify(d.o) !== JSON.stringify(d.n) && !added.has(key(d.r, d.p, d.m)) && !removed.has(key(d.r, d.p, d.m)));

  const byPlatform: Record<string, PlatformChurn> = {};
  for (const m of added.values()) (byPlatform[m.p] ??= emptyChurn()).a++;
  for (const m of removed.values()) (byPlatform[m.p] ??= emptyChurn()).r++;
  const edited = new Set<string>();
  for (const d of details) {
    const churn = byPlatform[d.p] ??= emptyChurn();
    if (d.f === 'enabled') {
      if (d.o === true && d.n === false) churn.off++;
      else if (d.o === false && d.n === true) churn.on++;
    } else if (!edited.has(key(d.r, d.p, d.m))) {
      edited.add(key(d.r, d.p, d.m));
      churn.c++;
    }
  }
  return { row: finish(byPlatform, true), members: { added: [...added.values()], removed: [...removed.values()] }, details };
}

/** Every logged row, newest first, merged per day with the filters applied.
 *  Days left with no visible change are dropped. */
function days(rows: SyncDbRow[], f: Filters): MergedDay[] {
  const byDay = new Map<string, SyncDbRow[]>();
  for (const row of rows) {
    const d = dayOf(row.at, f.timeZone);
    (byDay.get(d) ?? byDay.set(d, []).get(d)!).push(row);
  }
  const out: MergedDay[] = [];
  for (const [d, dayRows] of byDay) {
    const oldestFirst = [...dayRows].sort((a, b) => a.at.localeCompare(b.at) || a.id - b.id);
    const merged = mergeDay(d, oldestFirst.map(r => partOf(r, f)));
    if (Object.keys(merged.row.byPlatform).length > 0) out.push(merged);
  }
  return out.sort((a, b) => b.row.day.localeCompare(a.row.day));
}

function loadRows(db: Db, ids?: number[]): SyncDbRow[] {
  if (ids && ids.length === 0) return [];
  return db.prepare(`
    SELECT ${ROW_COLUMNS}, details_json, members_json
      FROM catalogue_sync
     ${ids ? `WHERE id IN (${ids.map(() => '?').join(', ')})` : ''}
     ORDER BY at DESC, id DESC
  `).all(...(ids ?? [])) as SyncDbRow[];
}

export function listCatalogueSyncs(query: CatalogueSyncQuery = {}, db: Db = getDb()): CatalogueSyncPage {
  const limit = Math.min(Math.max(1, query.limit ?? 50), MAX_LIMIT);
  const offset = Math.max(0, query.offset ?? 0);
  // Every row, so the totals describe the whole log after the filters. The
  // table grows by one row per changed document; this stays small.
  const rows = loadRows(db);
  const f = filtersFor(query, rows, db);
  const merged = days(rows, f);
  const sum = (k: 'docAdded' | 'docRemoved' | 'docChanged' | 'docSwitchedOff' | 'docSwitchedOn') =>
    merged.reduce((n, d) => n + d.row[k], 0);
  const hiddenIgnored = rows.reduce((n, row) => n + withoutIgnored(row, f.ignoreOnly).hidden, 0);
  const hiddenAll = rows.reduce((n, row) => n + withoutIgnored(row, f.sets).hidden, 0);

  return {
    syncs: merged.slice(offset, offset + limit).map(d => d.row),
    total: merged.length,
    totals: {
      syncs: merged.length,
      added: sum('docAdded'),
      removed: sum('docRemoved'),
      changed: sum('docChanged'),
      switchedOff: sum('docSwitchedOff'),
      switchedOn: sum('docSwitchedOn'),
      hiddenIgnored,
      hiddenUnkeyed: hiddenAll - hiddenIgnored,
      lastAt: rows[0]?.at ?? null,
      lastVersion: rows[0]?.version ?? null,
    },
  };
}

/** The merged detail behind one day entry, by the ids it listed, with the
 *  same filters as the list. Null when none of the ids is recorded. */
export function getCatalogueSyncDay(ids: number[], db: Db = getDb(), query: CatalogueSyncQuery = {}): CatalogueSyncDetailRow | null {
  const rows = loadRows(db, ids);
  if (rows.length === 0) return null;
  const f = filtersFor(query, rows, db);
  const oldestFirst = [...rows].sort((a, b) => a.at.localeCompare(b.at) || a.id - b.id);
  const merged = mergeDay(dayOf(oldestFirst[oldestFirst.length - 1].at, f.timeZone), oldestFirst.map(r => partOf(r, f)));
  return { ...merged.row, details: merged.details, members: merged.members };
}
