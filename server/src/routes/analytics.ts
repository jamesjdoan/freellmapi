import { Router } from 'express';
import type { Request, Response } from 'express';
import { getDb } from '../db/index.js';
import { FALLBACK_INPUT_PER_M, FALLBACK_OUTPUT_PER_M } from '../db/model-pricing.js';
import { providerIdFor, providerDisplayName } from '../lib/provider-identity.js';
import { normalizeBaseUrl } from '../lib/endpoint-scope.js';
import { readRawHorizon, windowExceedsRawHorizon } from '../services/request-retention.js';
import type { RoutingDecisionTrace } from '../lib/attempt-trace.js';

/** Decode a stored routing trace. A row from before the column existed, or one
 *  whose JSON is unreadable, yields null — a diagnostic that cannot be parsed
 *  must not take the request drill-down down with it. */
function parseRoutingTrace(raw: string | null | undefined): RoutingDecisionTrace | null {
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? (parsed as RoutingDecisionTrace) : null;
  } catch {
    return null;
  }
}

export const analyticsRouter = Router();

// The endpoint identity of a request, in SQL: the serving key's base_url, ''
// when the key is gone or carries none (every catalog key). Custom endpoints
// all share the platform id 'custom' (services/custom-endpoint.ts), so any
// view that groups by `platform` alone collapses every relay into one row and
// the operator cannot tell which endpoint did what (#889) — this expression is
// the second half of the grouping key everywhere that matters.
//
// rtrim/trim mirror lib/endpoint-scope.normalizeBaseUrl so the SQL side agrees
// with the ids providerIdFor() builds: keys.ts normalizes base_url on write,
// but rows stored before it did would otherwise split one endpoint in two.
// Requires the query to LEFT JOIN api_keys as `k`.
const ENDPOINT_ID_SQL = "COALESCE(rtrim(trim(k.base_url), '/'), '')";

// Format UTC timestamps the same way SQLite stores created_at text values.
const toSqliteDateTime = (timestamp: number) =>
    new Date(timestamp).toISOString().slice(0, 19).replace('T', ' ');

// ── The analytics window ─────────────────────────────────────────────────────
//
// Every endpoint reads the SAME half-open interval `[since, until)` in SQLite's
// 'YYYY-MM-DD HH:MM:SS' UTC form. One resolver, so no panel can quietly answer
// for a different span than its neighbour.
//
// Two ways in, and they are mutually exclusive:
//   - `range`: one of the named presets below, counting back from now.
//   - `from` + `to`: explicit dates, for any window the presets don't cover.
//
// The presets grew because the daily timeline cannot stay legible past ~90
// buckets. 1d/7d/30d/90d each keep a readable daily line; 180d/365d bucket by
// MONTH, and a custom window picks its bucket from its own span. Everything
// else — the stat cards, the breakdowns, the recent-calls list — reads the
// same window, so nothing answers a different question than the rest.
export const ANALYTICS_RANGES = ['24h', '7d', '30d', '90d', '180d', '365d'] as const;

export type AnalyticsRange = typeof ANALYTICS_RANGES[number];

/** Widest preset the UI offers. The hourly aggregate is pruned at this depth,
 *  so a range past it would silently read a short window (see
 *  services/request-retention.ts). */
export const MAX_ANALYTICS_RANGE = '365d';

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

/** A preset in milliseconds, or null for anything not on the list. */
function presetMs(range: string): number | null {
  if (range === '24h') return 24 * HOUR_MS;
  const days = /^(\d{1,4})d$/.exec(range);
  if (!days) return null;
  const n = Number(days[1]);
  if (n < 1 || n > 3650) return null;
  return n * DAY_MS;
}

/** True for the presets, so a caller can tell "the user picked 365d" from
 *  "the user typed 90d into the custom field" — both resolve the same window. */
export function isAnalyticsRange(value: string): value is AnalyticsRange {
  return (ANALYTICS_RANGES as readonly string[]).includes(value);
}

export interface AnalyticsWindow {
  /** Inclusive lower bound, SQLite UTC text. */
  since: string;
  /** Exclusive upper bound, SQLite UTC text. Equals now+1s for a rolling
 *  window, so "now" itself is inside it rather than excluded by a strict `<`. */
  until: string;
  /** Window length in ms, for picking a timeline bucket size. */
  spanMs: number;
}

// The safety clamp on CUSTOM spans, so one request cannot ask the server to
// walk decades of history. A window past it is clamped to the cap measured
// BACK FROM ITS OWN RECENT END — a fat-fingered 1900→2100 means "as much as
// you have", and keeping the 1900 end would return an empty chart. This is NOT
// the widest offered window; that is MAX_ANALYTICS_RANGE above.
const MAX_WINDOW_SPAN_MS = 5 * 365 * DAY_MS;

/** The widest window the UI OFFERS, in days — derived from the preset list so
 *  adding a preset cannot drift. The retention service imports this, and its
 *  test asserts the aggregate is never pruned shallower than it, because that
 *  exact drift is what made 90d read a 30-day window. Distinct from
 *  MAX_WINDOW_SPAN_MS above, which is the safety clamp on CUSTOM spans. */
export const MAX_ANALYTICS_RANGE_DAYS = Number(MAX_ANALYTICS_RANGE.slice(0, -1));

/** `YYYY-MM-DD` from a browser date input, or null if it isn't one.
 *  Anchored on purpose: `new Date('2026-10-04')` parses as UTC midnight and
 *  `new Date('nonsense')` as Invalid Date, and both would sail through a bare
 *  `isNaN` check on the wrong branch. */
function parseIsoDate(value: unknown): number | null {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const ms = Date.parse(`${value}T00:00:00Z`);
  return Number.isFinite(ms) ? ms : null;
}

/**
 * Resolve the analytics window from a request.
 *
 * `range` wins when it names a known preset; otherwise `from`/`to` are read as
 * a date pair. A half-specified or inverted pair falls back to the `defaultRange`
 * rather than erroring: the dashboard must render something, and the presets
 * are always a correct answer for whatever the operator typed.
 */
export function resolveWindow(
  query: Record<string, unknown>,
  defaultRange: AnalyticsRange = '7d',
  nowMs: number = Date.now(),
): AnalyticsWindow {
  const range = typeof query.range === 'string' ? query.range : '';

  // The rolling presets. A preset of `Nd` also covers every longer preset the
  // timeline buckets by month, so 365d and a custom year-long window read the
  // same interval rather than two subtly different ones.
  const span = presetMs(range);
  if (span !== null) {
    return {
      since: toSqliteDateTime(nowMs - span),
      // +1s: `until` is exclusive and the newest row can be `now` exactly.
      until: toSqliteDateTime(nowMs + 1000),
      spanMs: span,
    };
  }

  const fromMs = parseIsoDate(query.from);
  const toMs = parseIsoDate(query.to);
  if (fromMs !== null && toMs !== null) {
    const start = Math.min(fromMs, toMs);
    // A `to` date is inclusive on the UI ("Aug 1 to Aug 31"), so the requested
    // exclusive bound is the NEXT midnight. Without this the final day loses
    // every row after 00:00 and the custom window reads a day short.
    const requestedEnd = Math.max(fromMs, toMs) + DAY_MS;
    // A window entirely in the future is left alone: there is no data in it and
    // rendering nothing is the honest answer. Any window that REACHES the
    // present is capped at `now`, because a `to` of 2100 means "everything so
    // far", not "start in 1900 and stop in 2100".
    const end = start > nowMs ? requestedEnd : Math.min(requestedEnd, nowMs + 1000);
    // A same-day window still needs a real span, and the cap measures back from
    // `end` — so an over-wide pick keeps the most recent history rather than an
    // empty chart at its far end.
    const spanMs = Math.min(Math.max(end - start, HOUR_MS), MAX_WINDOW_SPAN_MS);
    return { since: toSqliteDateTime(end - spanMs), until: toSqliteDateTime(end), spanMs };
  }

  return resolveWindow({ range: defaultRange }, defaultRange, nowMs);
}

// Retained for the CLI-fleet route and its tests, which read a cutoff with no
// upper bound of their own. Same preset table, so both agree by construction.
export function getSinceTimestamp(range: string): string {
  return resolveWindow({ range }, '7d').since;
}

// Window totals read from the durable `request_hourly` aggregate. The raw
// `requests` table is pruned by REQUEST_ANALYTICS_MAX_ROWS, so any analytics
// count that depends on a long window must read the hourly table to stay
// accurate. Hourly resolution is fine for any window the dashboard exposes.
//
// The aggregate carries NO dimensions — no device, no status, no provider, no
// model. Any of those filters therefore has to fall through to the raw rows
// (readRawTotals), which makes a filtered figure subject to the raw prune in a
// way the unfiltered one is not. That is the standing trade-off, unchanged by
// this work; it is called out at the call site.
/** Totals for one analytics window, from either the hourly aggregate or the
 *  raw rows. Both readers return this shape so callers need not know which
 *  source answered. */
export interface WindowTotals {
  total_requests: number;
  success_count: number;
  error_count: number;
  total_input_tokens: number;
  total_output_tokens: number;
  first_request_at: string | null;
}

// Hour keys are created_at truncated to the hour, so they share SQLite's
// canonical 'YYYY-MM-DD HH:MM:SS' text (space separator) and the window bounds
// compare directly against them — no separator conversion, because the writer
// (logRequest) and both readers all compare on the space form.
//
// `since` is FLOORED to its hour: a rolling 24h window opens mid-hour, and
// dropping that partial hour would understate the window by up to an hour.
// `until` is NOT ceiled: a bucket is keyed by its FIRST second, so a bucket at
// exactly `until` holds only time at or past the bound and must be excluded.
// Ceiling there pulled in a whole bucket the window excludes, so a custom
// window ending at midnight counted the following hour.
const hourFloor = (sqliteUtc: string) => sqliteUtc.slice(0, 13) + ':00:00';

function readAggregateSince(window: AnalyticsWindow): WindowTotals {
  const db = getDb();
  const rows = db.prepare(`
    SELECT
      COALESCE(SUM(total_requests), 0) as total_requests,
      COALESCE(SUM(success_count), 0) as success_count,
      COALESCE(SUM(error_count), 0) as error_count,
      COALESCE(SUM(input_tokens), 0) as total_input_tokens,
      COALESCE(SUM(output_tokens), 0) as total_output_tokens,
      MIN(hour) as first_request_at
    FROM request_hourly
    WHERE hour >= ? AND hour < ?
  `).get(hourFloor(window.since), window.until) as WindowTotals;
  return rows;
}

/** One row of the /by-platform grouping: per-endpoint totals plus the derived
 *  latency and throughput aggregates, all nullable where the window held too
 *  few rows to compute them. */
interface PlatformRow {
  platform: string;
  base_url: string | null;
  requests: number;
  latency_count: number;
  success_rate: number | null;
  avg_latency_ms: number | null;
  avg_ttfb_ms: number | null;
  error_count: number | null;
  avg_tokens_per_second: number | null;
  total_input_tokens: number | null;
  total_output_tokens: number | null;
  est_cost: number | null;
}

/** One row of the /by-model grouping. */
interface ModelRow {
  platform: string;
  base_url: string | null;
  model_id: string;
  display_name: string | null;
  requests: number;
  success_rate: number | null;
  avg_latency_ms: number | null;
  total_input_tokens: number | null;
  total_output_tokens: number | null;
  pinned_requests: number | null;
  est_cost: number | null;
}

/** The remaining grouped row shapes the breakdowns read. SQLite hands back
 *  whatever the aggregate produced, so each query names its own row type
 *  rather than letting the compiler trust an untyped object. */


interface ClientRow {
  device: string;
  agents: string | null;
  requests: number;
  success_rate: number | null;
  avg_latency_ms: number | null;
  total_input_tokens: number | null;
  total_output_tokens: number | null;
  est_cost: number | null;
  last_seen_at: string | null;
}

interface KeyRow {
  key_id: number;
  label: string | null;
  platform: string | null;
  requests: number;
  success_rate: number | null;
  avg_latency_ms: number | null;
  total_input_tokens: number | null;
  total_output_tokens: number | null;
}

interface TimelineRow {
  timestamp: string | null;
  requests: number | null;
  success_count: number | null;
  failure_count: number | null;
  input_tokens: number | null;
  output_tokens: number | null;
}

interface ErrorPlatformRow {
  platform: string;
  base_url: string | null;
  count: number;
}

interface CategoryRow {
  category: string;
  count: number;
}

interface RecentErrorDbRow {
  id: number;
  platform: string;
  base_url: string | null;
  model_id: string;
  error: string | null;
  latency_ms: number | null;
  created_at: string;
}

/** One row of the recent-calls list, in its database column names. */
interface RecentCallDbRow {
  id: number;
  platform: string;
  model_id: string;
  requested_model: string | null;
  request_type: string | null;
  status: string;
  input_tokens: number | null;
  output_tokens: number | null;
  latency_ms: number | null;
  error: string | null;
  client_ip: string | null;
  client_user_agent: string | null;
  client_agent: string | null;
  created_at_iso: string;
  attempt_count: number;
  key_label: string | null;
}


function readLifetimeSettings() {
  const db = getDb();
  const row = db.prepare(`
    SELECT value FROM settings WHERE key = 'first_request_at'
  `).get() as { value: string } | undefined;
  return row?.value ?? null;
}

// ── Device dimension ────────────────────────────────────────────────────────
//
// Which physical machine made the call, derived from its User-Agent. The
// mapping and what it assumes about untagged history are documented at
// /by-client below; this is the same expression, parameterised by table alias
// so every endpoint can filter on it.
// The MacBook Pro started tagging itself `omp-mbp/…` at the boundary below.
// Every request before it came from the Mac Studio, whatever user-agent it
// carried: the bare `omp/` versions and the untagged strays alike.
//
// Operator ruling (2026-10-02): the MacBook had not been in use, so everything
// before its first tagged request is Studio traffic. This is a statement about
// history, not a claim the data can prove — hence a boundary clause rather than
// a rewrite of `client_user_agent`, so it stays inspectable and reversible by
// deleting one WHEN.
//
// Scoped to `omp%` deliberately. Only our own harness can have been the Studio
// on this install; `curl`, `node`, `Bun` and the rest are not this harness and
// keep their own rows (analytics-client.test.ts pins that).
//
// The arm sits BELOW the `omp-mbp%` test on purpose. Above it, a MacBook row
// that predates its own first tag would be filed as the Studio — which is the
// one way this rule could misattribute the MBP's traffic. There are no such
// rows, so putting it below costs nothing and removes the trap entirely.
export const MACBOOK_PRO_FIRST_TAG = '2026-09-19 16:30:46';

export function deviceSql(alias = 'r'): string {
  return `
  CASE
    WHEN ${alias}.client_user_agent LIKE 'omp-mbp%'    THEN 'MacBook Pro'
    WHEN ${alias}.created_at < '${MACBOOK_PRO_FIRST_TAG}'
     AND ${alias}.client_user_agent LIKE 'omp%' THEN 'Mac Studio'
    WHEN ${alias}.client_user_agent LIKE 'omp-studio%' THEN 'Mac Studio'
    WHEN ${alias}.client_user_agent LIKE 'omp/%'       THEN 'Mac Studio'
    ELSE COALESCE(${alias}.client_user_agent, 'unknown')
  END`;
}

// The device names the rollup can produce, as opposed to a caller that is
// simply reported under its own UA. Only these get a tab in the dashboard.
export const KNOWN_DEVICES = ['Mac Studio', 'MacBook Pro'] as const;

/** `?device=` → a SQL fragment and its parameters. Absent or 'all' filters
 *  nothing, so every existing caller keeps its current behaviour. */
function deviceFilter(raw: unknown, alias = 'r'): { sql: string; params: string[] } {
  const device = typeof raw === 'string' ? raw.trim() : '';
  if (!device || device === 'all') return { sql: '', params: [] };
  return { sql: ` AND ${deviceSql(alias)} = ?`, params: [device] };
}

// ── Page-wide filters ────────────────────────────────────────────────────────
//
// The dashboard's status / provider / model selectors sit ABOVE the cards, so
// every panel below them has to answer for the same slice of traffic. Before
// this the only filters were device-scoped, and /requests carried its own
// status+provider pair — which is why selecting a provider there moved one
// table and nothing else.
//
// These builders are the single place a filter becomes SQL. Every endpoint
// composes the same three, so "the stat card and the model breakdown disagree"
// is not expressible. Requires the query to alias `requests` as `r`, and to
// LEFT JOIN `api_keys` as `k` for the endpoint-scoped provider match.
export interface QueryFilter {
  sql: string;
  params: string[];
}

const NO_FILTER: QueryFilter = { sql: '', params: [] };

// The three statuses a request row can end in — fixed at build time, so a
// lookup table rather than a membership set that never grows.
const VALID_STATUSES: Record<string, true> = { success: true, error: true, canceled: true };

/** `?status=` → an equality fragment, or an error string when the value is not
 *  one of the three statuses a request can end in. */
function statusFilter(raw: unknown): QueryFilter | string {
  if (raw === undefined || raw === '') return NO_FILTER;
  if (typeof raw !== 'string' || !VALID_STATUSES[raw]) {
    return "invalid status filter (expected 'success', 'error' or 'canceled')";
  }
  return { sql: ' AND r.status = ?', params: [raw] };
}

/** `?provider=` → an endpoint-scoped equality fragment. The `provider` param
 *  carries the stable row id /by-platform emits: a platform slug ('groq') or
 *  'custom:<base_url>' for one relay, because every custom endpoint shares the
 *  'custom' platform id (#889). The legacy `?platform=` keeps its older,
 *  non-endpoint-scoped meaning.
 *
 *  The bare 'custom' id is the ORPHAN bucket — rows whose endpoint is unknown,
 *  because the key was deleted or carried no base_url. It must not widen to
 *  every relay, which is what filtering on the slug alone would do. */
function providerFilter(provider: unknown, platform: unknown): QueryFilter | string {
  if (typeof provider === 'string' && provider !== '') {
    if (provider.length > 256 || /[\r\n]/.test(provider)) return 'invalid provider filter';
    if (provider === 'custom') {
      return { sql: ` AND r.platform = 'custom' AND ${ENDPOINT_ID_SQL} = ''`, params: [] };
    }
    if (provider.startsWith('custom:')) {
      return {
        sql: ` AND r.platform = 'custom' AND ${ENDPOINT_ID_SQL} = ?`,
        params: [normalizeBaseUrl(provider.slice('custom:'.length))],
      };
    }
    if (/^[A-Za-z0-9_-]{1,64}$/.test(provider)) {
      return { sql: ' AND r.platform = ?', params: [provider] };
    }
    return 'invalid provider filter';
  }
  if (platform !== undefined) {
    if (typeof platform !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(platform)) {
      return 'invalid platform filter';
    }
    return { sql: ' AND r.platform = ?', params: [platform] };
  }
  return NO_FILTER;
}

/** `?model=` → an equality on the SERVED model id, so a filter chosen from the
 *  model breakdown selects that model and not merely every model on its
 *  provider. Bound as a parameter; shape-checked so a 4 KB query string can't
 *  become an unbounded comparison. */
function modelFilter(raw: unknown): QueryFilter | string {
  if (raw === undefined || raw === '') return NO_FILTER;
  if (typeof raw !== 'string' || raw.length > 256 || raw.includes('\0')) {
    return 'invalid model filter';
  }
  return { sql: ' AND r.model_id = ?', params: [raw] };
}

/** Compose the three page-wide filters. Returns the fragments on success, or
 *  the error message the endpoint should answer 400 with. */
export function pageFilters(query: {
  status?: unknown;
  provider?: unknown;
  platform?: unknown;
  model?: unknown;
}): QueryFilter | string {
  const status = statusFilter(query.status);
  if (typeof status === 'string') return status;
  const provider = providerFilter(query.provider, query.platform);
  if (typeof provider === 'string') return provider;
  const model = modelFilter(query.model);
  if (typeof model === 'string') return model;
  return {
    sql: status.sql + provider.sql + model.sql,
    params: [...status.params, ...provider.params, ...model.params],
  };
}

/** `req` → the window plus every page-wide filter, in one read. The window is
 *  [since, until) in SQLite UTC text; `until` is exclusive so `until > ?` is
 *  the upper bound everywhere. */
function readScope(req: Request): { window: AnalyticsWindow; filters: QueryFilter; device: QueryFilter } | { error: string } {
  const filters = pageFilters(req.query);
  if (typeof filters === 'string') return { error: filters };
  return {
    window: resolveWindow(req.query),
    filters,
    device: deviceFilter(req.query.device),
  };
}

/** The WHERE tail every raw-row analytics read shares: the window bounds plus
 *  the composed filters. `created_at` is indexed and its bounds are always
 *  bound parameters, never interpolated. */
function scopeSql(window: AnalyticsWindow, filters: QueryFilter, device: QueryFilter): string {
  return ' AND r.created_at < ?' + filters.sql + device.sql;
}

/** Window bounds and filter params in the order `scopeSql` emits them. */
function scopeParams(window: AnalyticsWindow, filters: QueryFilter, device: QueryFilter): string[] {
  return [window.until, ...filters.params, ...device.params];
}

// Totals for a window the hourly aggregate CANNOT answer. The aggregate buckets
// by hour and by nothing else, so any device, status, provider or model filter
// forces this reader. That makes a filtered figure subject to the
// REQUEST_ANALYTICS_MAX_ROWS prune in a way the unfiltered one is not: on an
// install old enough to be pruning, a filtered total for a long window
// undercounts where the all-caller total stays right.
function readRawTotals(window: AnalyticsWindow, filters: QueryFilter, device: QueryFilter): WindowTotals {
  return getDb().prepare(`
    SELECT
      COUNT(*) as total_requests,
      SUM(CASE WHEN r.status = 'success' THEN 1 ELSE 0 END) as success_count,
      SUM(CASE WHEN r.status = 'error' THEN 1 ELSE 0 END) as error_count,
      COALESCE(SUM(r.input_tokens), 0) as total_input_tokens,
      COALESCE(SUM(r.output_tokens), 0) as total_output_tokens,
      MIN(r.created_at) as first_request_at
    FROM requests r
    LEFT JOIN api_keys k ON k.id = r.key_id
    WHERE r.created_at >= ?${scopeSql(window, filters, device)}
  `).get(window.since, ...scopeParams(window, filters, device)) as WindowTotals;
}

// Summary stats
analyticsRouter.get('/summary', (req: Request, res: Response) => {
  const scope = readScope(req);
  if ('error' in scope) {
    res.status(400).json({ error: scope.error });
    return;
  }
  const { window, filters, device } = scope;
  const db = getDb();
  // Every raw-row query below shares this bound set: the window's upper bound
  // then the composed filters then the device filter, matching scopeSql's order.
  const rawSql = scopeSql(window, filters, device);
  const rawParams = scopeParams(window, filters, device);

  // Totals come from the durable `request_hourly` aggregate so they stay
  // accurate past the raw-row prune. The moment ANY dimension is filtered —
  // device, status, provider, model — the aggregate can no longer answer, and
  // the totals come from the raw rows instead (see readRawTotals).
  const aggregate = filters.sql !== '' || device.sql !== ''
    ? readRawTotals(window, filters, device)
    : readAggregateSince(window);
  const totalRequests = aggregate.total_requests ?? 0;
  // Success rate over success+error only: a 'canceled' request (#752 — client
  // hung up) still counts in the totals but is neither a success nor a
  // failure, so it must not dilute the rate.
  const decidedRequests = (aggregate.success_count ?? 0) + (aggregate.error_count ?? 0);
  const successRate = decidedRequests > 0 ? (aggregate.success_count / decidedRequests) * 100 : 0;

  // Latency, TTFT, savings, pin-honour and the chat/embedding split all live on
  // the raw rows: the hourly bucket keeps none of them, and any filter has
  // already forced the raw read above.
  const latencyRow = db.prepare(`
    SELECT AVG(r.latency_ms) as avg_latency_ms
    FROM requests r LEFT JOIN api_keys k ON k.id = r.key_id
    WHERE r.created_at >= ?${rawSql}
  `).get(window.since, ...rawParams) as { avg_latency_ms: number | null } | undefined;

  // Priced per request at the SERVED model's paid-equivalent rate. Endpoint-
  // scoped join for the #651 reason: (platform, model_id) alone matches one
  // model row per relay that registered it and multiplies every request by
  // that count.
  const savings = db.prepare(`
    SELECT COALESCE(SUM(
      CASE WHEN r.status = 'success' THEN
        r.input_tokens  * COALESCE(m.paid_input_per_m,  ?) / 1000000.0 +
        r.output_tokens * COALESCE(m.paid_output_per_m,  ?) / 1000000.0
      ELSE 0 END
    ), 0) as est_savings
    FROM requests r
    LEFT JOIN api_keys k ON k.id = r.key_id
    LEFT JOIN models m
      ON m.platform = r.platform AND m.model_id = r.model_id
     AND m.endpoint_scope = ${ENDPOINT_ID_SQL}
    WHERE r.created_at >= ?${rawSql}
  `).get(FALLBACK_INPUT_PER_M, FALLBACK_OUTPUT_PER_M, window.since, ...rawParams) as { est_savings: number };

  // Pin-honor stats are also raw-row scoped.
  const pinRow = db.prepare(`
    SELECT
      SUM(CASE WHEN r.requested_model IS NOT NULL THEN 1 ELSE 0 END) as pinned_count,
      SUM(CASE WHEN r.requested_model = r.model_id THEN 1 ELSE 0 END) as pin_honored_count
    FROM requests r LEFT JOIN api_keys k ON k.id = r.key_id
    WHERE r.created_at >= ?${rawSql}
  `).get(window.since, ...rawParams) as { pinned_count: number | null; pin_honored_count: number | null };

  // Percentiles use nearest-rank via ORDER BY/OFFSET over rows that recorded a
  // latency, and report null — never 0 — when that set is empty, so the UI can
  // render a placeholder instead of a misleading zero. The IS NOT NULL guard
  // must be on BOTH the denominator count and the ordered selection so they
  // range over the same set: a NULL sorts first under ORDER BY latency_ms ASC,
  // so if it were counted but not filtered the offset math would shift and a
  // NULL could be selected (rendered as 0).
  const rawCount = (db.prepare(`
    SELECT COUNT(*) as c
    FROM requests r LEFT JOIN api_keys k ON k.id = r.key_id
    WHERE r.created_at >= ? AND r.latency_ms IS NOT NULL${rawSql}
  `).get(window.since, ...rawParams) as { c: number }).c;
  const percentileAt = (fraction: number): number | null => {
    if (rawCount === 0) return null;
    const offset = Math.floor((rawCount - 1) * fraction);
    const row = db.prepare(`
      SELECT r.latency_ms FROM requests r
      LEFT JOIN api_keys k ON k.id = r.key_id
      WHERE r.created_at >= ? AND r.latency_ms IS NOT NULL${rawSql}
      ORDER BY r.latency_ms ASC
      LIMIT 1 OFFSET ?
    `).get(window.since, ...rawParams, offset) as { latency_ms: number } | undefined;
    return row ? Math.round(row.latency_ms) : null;
  };
  const p50LatencyMs = percentileAt(0.5);
  const p95LatencyMs = percentileAt(0.95);

  const ttfbRow = db.prepare(`
    SELECT AVG(r.ttfb_ms) as avg_ttfb_ms
    FROM requests r LEFT JOIN api_keys k ON k.id = r.key_id
    WHERE r.created_at >= ? AND r.ttfb_ms IS NOT NULL${rawSql}
  `).get(window.since, ...rawParams) as { avg_ttfb_ms: number | null } | undefined;
  const avgTtfbMs = ttfbRow?.avg_ttfb_ms != null ? Math.round(ttfbRow.avg_ttfb_ms) : null;

  const typeRows = db.prepare(`
    SELECT r.request_type, COUNT(*) as count
    FROM requests r LEFT JOIN api_keys k ON k.id = r.key_id
    WHERE r.created_at >= ?${rawSql}
    GROUP BY r.request_type
  `).all(window.since, ...rawParams) as Array<{ request_type: string; count: number }>;
  const requestTypeCounts = { chat: 0, embedding: 0 };
  for (const row of typeRows) {
    if (row.request_type === 'embedding') requestTypeCounts.embedding = row.count;
    else if (row.request_type === 'chat') requestTypeCounts.chat = row.count;
  }

  res.json({
    totalRequests,
    successRate: Math.round(successRate * 10) / 10,
    totalInputTokens: aggregate.total_input_tokens ?? 0,
    totalOutputTokens: aggregate.total_output_tokens ?? 0,
    avgLatencyMs: Math.round(latencyRow?.avg_latency_ms ?? 0),
    p50LatencyMs,
    p95LatencyMs,
    avgTtfbMs,
    requestTypeCounts,
    estimatedCostSavings: Math.round((savings.est_savings ?? 0) * 100) / 100,
    // Pinned = requests where the client named a specific model (not 'auto').
    // Honored = the pinned model actually served it; the difference is
    // failovers that overrode the pin.
    pinnedRequests: pinRow.pinned_count ?? 0,
    pinHonoredRequests: pinRow.pin_honored_count ?? 0,
    // First-ever request timestamp (lifetime, never pruned). Falls back to
    // the oldest row inside the current window when lifetime is not seeded.
    firstRequestAt: readLifetimeSettings() ?? aggregate.first_request_at ?? null,
    // The window actually read, so a custom span can be labelled without the
    // client recomputing it and the two can never disagree about what is shown.
    windowSince: window.since,
    windowUntil: window.until,
    // The oldest row still retained, so a horizon notice can name the real date
    // rather than the window's start. Null when nothing is retained at all.
    rawWindowOldest: readRawHorizon(db),
    // True when the window opens before that oldest row. The aggregate-backed
    // totals above stay right; latency spread, TTFT, savings and the
    // per-provider/per-model breakdowns do not, so the panel says so rather
    // than rendering a long window that silently covers less than it claims.
    rawWindowTruncated: windowExceedsRawHorizon(window.since),
    // Lifetime total since install — "all time" alongside the selected window.
    // Sourced from settings so it survives the raw-row prune entirely.
    lifetimeTotalRequests: Number((db.prepare(`SELECT value FROM settings WHERE key='total_requests'`).get() as { value?: string } | undefined)?.value ?? 0) || 0,
  });
});

// Stats grouped by model.
//
// The grouping key is (platform, endpoint, model_id), not (platform, model_id):
// the same model id served by two different custom relays is two different
// things — different latency, different failure modes — and merging them into
// one row labelled "custom" is the #889 collision in its most misleading form,
// because the merged row's numbers describe neither endpoint.
//
// The models join is endpoint-scoped for the same reason. `models` is unique on
// (platform, model_id, endpoint_scope) since #651, so joining on
// (platform, model_id) alone matches ONE row per relay that registered the
// model and multiplies every request row by that count. Adding endpoint_scope
// to the ON clause picks the row belonging to the endpoint that actually served
// the request — the only one whose display name and pricing apply.
analyticsRouter.get('/by-model', (req: Request, res: Response) => {
  const scope = readScope(req);
  if ('error' in scope) {
    res.status(400).json({ error: scope.error });
    return;
  }
  const { window, filters, device } = scope;

  const rows = getDb().prepare(`
    SELECT
      r.platform,
      ${ENDPOINT_ID_SQL} as base_url,
      r.model_id,
      m.display_name,
      COUNT(*) as requests,
      -- Rate over success+error only: 'canceled' (#752) is neither.
      SUM(CASE WHEN r.status = 'success' THEN 1 ELSE 0 END) * 100.0 / NULLIF(SUM(CASE WHEN r.status <> 'canceled' THEN 1 ELSE 0 END), 0) as success_rate,
      AVG(r.latency_ms) as avg_latency_ms,
      SUM(r.input_tokens) as total_input_tokens,
      SUM(r.output_tokens) as total_output_tokens,
      SUM(CASE WHEN r.requested_model = r.model_id THEN 1 ELSE 0 END) as pinned_requests,
      SUM(CASE WHEN r.status = 'success' THEN
        r.input_tokens  * COALESCE(m.paid_input_per_m,  ?) / 1000000.0 +
        r.output_tokens * COALESCE(m.paid_output_per_m,  ?) / 1000000.0
      ELSE 0 END) as est_cost
    FROM requests r
    LEFT JOIN api_keys k ON k.id = r.key_id
    LEFT JOIN models m
      ON m.platform = r.platform AND m.model_id = r.model_id
     AND m.endpoint_scope = ${ENDPOINT_ID_SQL}
    WHERE r.created_at >= ?${scopeSql(window, filters, device)}
    GROUP BY r.platform, ${ENDPOINT_ID_SQL}, r.model_id
    ORDER BY requests DESC
  `).all(FALLBACK_INPUT_PER_M, FALLBACK_OUTPUT_PER_M, window.since, ...scopeParams(window, filters, device)) as ModelRow[];

  res.json(rows.map(r => ({
    platform: r.platform,
    // Same row identity as /by-platform, so a model row and a provider row for
    // one endpoint carry the same id and the same operator-readable name.
    providerId: providerIdFor(r.platform, r.base_url || null),
    endpoint: providerDisplayName(r.platform, r.base_url || null),
    modelId: r.model_id,
    displayName: r.display_name ?? r.model_id,
    requests: r.requests,
    // success_rate is NULL when every row in the group was canceled.
    successRate: Math.round((r.success_rate ?? 0) * 10) / 10,
    avgLatencyMs: Math.round(r.avg_latency_ms ?? 0),
    totalInputTokens: r.total_input_tokens ?? 0,
    totalOutputTokens: r.total_output_tokens ?? 0,
    // Requests this model served because the client pinned it by name.
    pinnedRequests: r.pinned_requests ?? 0,
    estimatedCost: Math.round((r.est_cost ?? 0) * 100) / 100,
  })));
});

// Stats grouped by platform.
//
// Custom endpoints all share the platform id 'custom' (services/custom-
// endpoint.ts), so grouping by `platform` alone would collapse every custom
// relay into one row and the operator could not tell which endpoint did what
// (#889). We therefore also group by the serving key's base_url — the canonical
// endpoint identity (custom-endpoint.ts pools credentials by base_url, and the
// router treats every key sharing a base_url as one endpoint). Non-custom keys
// carry no base_url, so COALESCE(base_url,'') keeps each of them in a single
// per-platform group exactly as before.
analyticsRouter.get('/by-platform', (req: Request, res: Response) => {
  const scope = readScope(req);
  if ('error' in scope) {
    res.status(400).json({ error: scope.error });
    return;
  }
  const { window, filters, device } = scope;
  const scopeTail = scopeSql(window, filters, device);
  const scopeArgs = scopeParams(window, filters, device);
  const db = getDb();
  const rows = db.prepare(`
    SELECT
      r.platform,
      ${ENDPOINT_ID_SQL} as base_url,
      COUNT(*) as requests,
      COUNT(r.latency_ms) as latency_count,
      SUM(CASE WHEN r.status = 'success' THEN 1 ELSE 0 END) * 100.0 / NULLIF(SUM(CASE WHEN r.status <> 'canceled' THEN 1 ELSE 0 END), 0) as success_rate,
      AVG(r.latency_ms) as avg_latency_ms,
      AVG(r.ttfb_ms) as avg_ttfb_ms,
      SUM(CASE WHEN r.status = 'error' THEN 1 ELSE 0 END) as error_count,
      AVG(CASE WHEN r.output_tokens > 0 AND r.latency_ms > 0
        THEN r.output_tokens / (r.latency_ms / 1000.0) ELSE NULL END) as avg_tokens_per_second,
      SUM(r.input_tokens) as total_input_tokens,
      SUM(r.output_tokens) as total_output_tokens,
      -- Same per-request pricing as /by-model and /summary, so a provider row
      -- and the model rows under it add up. Endpoint-scoped join for the #651
      -- reason: (platform, model_id) alone matches one row per relay that
      -- registered the model and multiplies the sum by that count.
      SUM(CASE WHEN r.status = 'success' THEN
        r.input_tokens  * COALESCE(m.paid_input_per_m,  ?) / 1000000.0 +
        r.output_tokens * COALESCE(m.paid_output_per_m, ?) / 1000000.0
      ELSE 0 END) as est_cost
    FROM requests r
    LEFT JOIN api_keys k ON k.id = r.key_id
    LEFT JOIN models m
      ON m.platform = r.platform AND m.model_id = r.model_id
     AND m.endpoint_scope = ${ENDPOINT_ID_SQL}
    WHERE r.created_at >= ?${scopeTail}
    GROUP BY r.platform, ${ENDPOINT_ID_SQL}
    ORDER BY requests DESC
  `).all(FALLBACK_INPUT_PER_M, FALLBACK_OUTPUT_PER_M, window.since, ...scopeArgs) as PlatformRow[];

  // P95 latency is a per-group percentile; SQLite has no native percentile
  // aggregate, so we take the nearest-rank value per group with a small
  // ORDER BY/OFFSET query. The group count is tiny (one row per provider /
  // custom endpoint), so the extra round-trips are negligible and keep the SQL
  // readable. The WHERE must match the grouping exactly — platform AND the
  // endpoint's base_url — or a custom endpoint's p95 would bleed in latency
  // from every other custom endpoint.
  // The page filters belong here too: latency_count already counts only the
  // filtered rows, so an unfiltered percentile query would index into a
  // larger, differently-ordered set and return another slice's latency.
  const p95Stmt = db.prepare(`
    SELECT r.latency_ms FROM requests r
    LEFT JOIN api_keys k ON k.id = r.key_id
    WHERE r.created_at >= ? AND r.platform = ? AND ${ENDPOINT_ID_SQL} = ? AND r.latency_ms IS NOT NULL${scopeTail}
    ORDER BY r.latency_ms ASC
    LIMIT 1 OFFSET ?
  `);

  res.json(rows.map(r => {
    // Offset math and the ordered selection both range over the non-null
    // latency rows (latency_count), so a NULL can neither be counted into the
    // denominator nor selected as the p95 value.
    const latencyCount = r.latency_count ?? 0;
    const baseUrl: string | null = r.base_url || null;
    const p95Row = latencyCount > 0
      ? (p95Stmt.get(window.since, r.platform, r.base_url, ...scopeArgs, Math.floor((latencyCount - 1) * 0.95)) as { latency_ms: number } | undefined)
      : undefined;
    return {
      platform: r.platform,
      // Stable, unique id for this row: the platform slug for catalog providers,
      // 'custom:<base_url>' for custom endpoints (falls back to 'custom' when
      // the key is gone). The client uses this as the chart key and the
      // recent-calls filter value.
      providerId: providerIdFor(r.platform, baseUrl),
      // The short identifier the operator actually reads: the endpoint host for
      // custom rows, the platform slug otherwise.
      endpoint: providerDisplayName(r.platform, baseUrl),
      requests: r.requests,
      successRate: Math.round((r.success_rate ?? 0) * 10) / 10,
      avgLatencyMs: Math.round(r.avg_latency_ms ?? 0),
      p95LatencyMs: p95Row ? Math.round(p95Row.latency_ms) : null,
      avgTtfbMs: r.avg_ttfb_ms != null ? Math.round(r.avg_ttfb_ms) : null,
      errorCount: r.error_count ?? 0,
      avgTokensPerSecond: r.avg_tokens_per_second != null
        ? Math.round(r.avg_tokens_per_second * 10) / 10
        : null,
      totalInputTokens: r.total_input_tokens ?? 0,
      totalOutputTokens: r.total_output_tokens ?? 0,
      estimatedCost: Math.round((r.est_cost ?? 0) * 100) / 100,
    };
  }));
});

// Stats grouped by the DEVICE that called, derived from client_user_agent.
//
// `client_agent` cannot do this job: it is lib/client-classifier.ts's label and
// it only recognises harnesses that announce themselves (Claude Code's session
// header, Codex's UA, …). Every request from this fork's own harness
// classifies as 'unknown', so grouping on it collapsed every caller into one
// row. The raw UA is what separates them, and an operator sets it per machine
// through models.yml `headers: { User-Agent: … }`.
//
// Raw UAs alone are still too granular to read: one machine appears once per
// harness version it has ever run, so this install showed five rows for two
// computers. DEVICE_SQL folds them, and the untagged history with them —
// tagging arrived after most of these rows were written, so an untagged `omp/*`
// row is attributed to the Studio. That is the operator's ruling about their
// own two machines, not something the data proves: the MacBook also reported
// bare `omp/18.2.6` between its first call and the moment its tag was set.
//
// Nothing is rewritten. The raw agents are returned alongside each device so
// the mapping stays visible and auditable from the UI.
//
// The models join mirrors /by-model: endpoint-scoped so a model served by two
// relays does not multiply the row, and COALESCE'd to the documented fallback
// for any model with no paid equivalent on file.
// The mapping itself lives in deviceSql() at the top of this file, because
// every endpoint filters on it. Duplicating the CASE here would let the
// breakdown and the filters drift apart — the breakdown would name a device
// the filters could no longer select.

analyticsRouter.get('/by-client', (req: Request, res: Response) => {
  const scope = readScope(req);
  if ('error' in scope) {
    res.status(400).json({ error: scope.error });
    return;
  }
  // The page filters apply (they change what each device did), but the device
  // filter deliberately does NOT: this table IS the device breakdown, and
  // filtering it to one machine would leave a single row with no tab to leave
  // by. The tab bar above the page is what changes the device scope.
  const { window, filters } = scope;
  const rows = getDb().prepare(`
    SELECT
      ${deviceSql()} AS device,
      -- The raw UAs folded into this device, so the mapping is inspectable
      -- rather than a claim the UI makes without showing its working.
      GROUP_CONCAT(DISTINCT COALESCE(r.client_user_agent, 'unknown')) AS agents,
      COUNT(*) AS requests,
      SUM(CASE WHEN r.status = 'success' THEN 1 ELSE 0 END) * 100.0 / NULLIF(SUM(CASE WHEN r.status <> 'canceled' THEN 1 ELSE 0 END), 0) AS success_rate,
      AVG(r.latency_ms) AS avg_latency_ms,
      SUM(r.input_tokens) AS total_input_tokens,
      SUM(r.output_tokens) AS total_output_tokens,
      SUM(CASE WHEN r.status = 'success' THEN
        r.input_tokens  * COALESCE(m.paid_input_per_m,  ?) / 1000000.0 +
        r.output_tokens * COALESCE(m.paid_output_per_m, ?) / 1000000.0
      ELSE 0 END) AS est_cost,
      MAX(strftime('%Y-%m-%dT%H:%M:%SZ', r.created_at)) AS last_seen_at
    FROM requests r
    LEFT JOIN api_keys k ON k.id = r.key_id
    LEFT JOIN models m
      ON m.platform = r.platform AND m.model_id = r.model_id
     AND m.endpoint_scope = ${ENDPOINT_ID_SQL}
    WHERE r.created_at >= ?${scopeSql(window, filters, NO_FILTER)}
    GROUP BY device
    ORDER BY requests DESC
  `).all(FALLBACK_INPUT_PER_M, FALLBACK_OUTPUT_PER_M, window.since, ...scopeParams(window, filters, NO_FILTER)) as ClientRow[];

  res.json(rows.map(row => ({
    // Field name kept for the existing consumer; the value is now a device.
    clientAgent: row.device,
    // Sorted so the list reads the same on every request, whatever order
    // GROUP_CONCAT happened to aggregate in.
    agents: String(row.agents ?? '').split(',').filter(Boolean).sort(),
    // True for a real machine, false for a caller reported under its own UA
    // (curl, an unknown client). Only the former can be filtered on, so the
    // dashboard offers tabs for these and nothing else.
    isDevice: (KNOWN_DEVICES as readonly string[]).includes(row.device),
    requests: row.requests,
    successRate: Math.round((row.success_rate ?? 0) * 10) / 10,
    avgLatencyMs: Math.round(row.avg_latency_ms ?? 0),
    totalInputTokens: row.total_input_tokens ?? 0,
    totalOutputTokens: row.total_output_tokens ?? 0,
    estimatedCost: Math.round((row.est_cost ?? 0) * 100) / 100,
    lastSeenAt: row.last_seen_at,
  })));
});

// Stats grouped by API key. Raw-row scoped (the hourly aggregate has no key
// dimension), LEFT JOINed to api_keys so a request whose key was later deleted
// still shows up with a null label — the keyId is always returned.
analyticsRouter.get('/by-key', (req: Request, res: Response) => {
  const scope = readScope(req);
  if ('error' in scope) {
    res.status(400).json({ error: scope.error });
    return;
  }
  const { window, filters, device } = scope;

  const rows = getDb().prepare(`
    SELECT
      r.key_id as key_id,
      k.label as label,
      k.platform as platform,
      COUNT(*) as requests,
      SUM(CASE WHEN r.status = 'success' THEN 1 ELSE 0 END) * 100.0 / NULLIF(SUM(CASE WHEN r.status <> 'canceled' THEN 1 ELSE 0 END), 0) as success_rate,
      AVG(r.latency_ms) as avg_latency_ms,
      SUM(r.input_tokens) as total_input_tokens,
      SUM(r.output_tokens) as total_output_tokens
    FROM requests r
    LEFT JOIN api_keys k ON k.id = r.key_id
    WHERE r.key_id IS NOT NULL AND r.created_at >= ?${scopeSql(window, filters, device)}
    GROUP BY r.key_id
    ORDER BY requests DESC
    LIMIT 50
  `).all(window.since, ...scopeParams(window, filters, device)) as KeyRow[];

  res.json(rows.map(r => ({
    keyId: r.key_id,
    // Null when the key row was deleted, or the empty string when the key
    // exists but was never labelled; the client falls back to "Key #<id>".
    label: r.label ?? null,
    platform: r.platform ?? null,
    requests: r.requests,
    successRate: Math.round((r.success_rate ?? 0) * 10) / 10,
    avgLatencyMs: Math.round(r.avg_latency_ms ?? 0),
    totalInputTokens: r.total_input_tokens ?? 0,
    totalOutputTokens: r.total_output_tokens ?? 0,
  })));
});

// Timeline data
//
// The bucket size is chosen from the WINDOW'S OWN SPAN, not from the range
// string — which is the whole point of the wider windows. It used to be
// `range === '24h' ? 'hour' : 'day'`, so every window past a day drew one
// point per day: 30d and 90d came back with the SAME 31 bucket labels, so the
// chart was byte-identical between them and looked frozen. Picking by span
// gives 180d and 365d a monthly line, and a custom window whatever its length
// deserves.
const HOUR_BUCKETS_MAX_SPAN_MS = 3 * DAY_MS;
const DAY_BUCKETS_MAX_SPAN_MS = 150 * DAY_MS;

/** hour / day / month, from the window's length. */
function timelineInterval(spanMs: number): 'hour' | 'day' | 'month' {
  if (spanMs <= HOUR_BUCKETS_MAX_SPAN_MS) return 'hour';
  return spanMs <= DAY_BUCKETS_MAX_SPAN_MS ? 'day' : 'month';
}

// strftime formats are a hardcoded whitelist — never user-controlled. The month
// bucket is anchored to day 01 so the client can parse it as a plain local
// date; a bare '%Y-%m' would not survive the same Date parsing the other two do.
const BUCKET_FORMAT = {
  hour: '%Y-%m-%dT%H:00:00',
  day: '%Y-%m-%d',
  month: '%Y-%m-01',
} as const;

analyticsRouter.get('/timeline', (req: Request, res: Response) => {
  const scope = readScope(req);
  if ('error' in scope) {
    res.status(400).json({ error: scope.error });
    return;
  }
  const { window, filters, device } = scope;

  // An explicit `?interval=` still wins, so a caller can force a resolution.
  const requested = req.query.interval;
  const interval: 'hour' | 'day' | 'month' =
    requested === 'hour' || requested === 'day' || requested === 'month'
      ? requested
      : timelineInterval(window.spanMs);
  const dateFormat = BUCKET_FORMAT[interval];

  // tzOffset: viewer's local offset from UTC in minutes (480 = UTC+8), sent by
  // the browser so bucket boundaries follow the viewer's wall clock instead of
  // UTC. Whitelisted to a sane integer range; bound as a parameter, never
  // interpolated into SQL.
  const rawOffset = Number(req.query.tzOffset);
  const tzOffset = Number.isInteger(rawOffset) && rawOffset >= -720 && rawOffset <= 840 ? rawOffset : 0;
  // The single current offset applies to the whole window (SQLite has no tz
  // database), so buckets on the far side of a DST transition sit 1h off.
  const tzModifier = `${tzOffset >= 0 ? '+' : '-'}${Math.abs(tzOffset)} minutes`;

  // Read from request_hourly (hour-bucketed) for every interval. Hour and day
  // rollups come from strftime on the hour column; month comes from strftime on
  // the hour column too, truncated to the month. Keeping the aggregate for all
  // three is what lets the timeline stay accurate past the raw-row prune.
  //
  // ANY filter — device, status, provider, model — forces the raw rows instead:
  // request_hourly buckets by hour and nothing else, so it cannot answer
  // "which machine" or "which provider". Same columns either way, so the
  // response shape is one.
  const scopeTail = scopeSql(window, filters, device);
  const scopeArgs = scopeParams(window, filters, device);
  const rows = filters.sql !== '' || device.sql !== ''
    ? getDb().prepare(`
        SELECT
          strftime(?, r.created_at, ?) as timestamp,
          COUNT(*) as requests,
          SUM(CASE WHEN r.status = 'success' THEN 1 ELSE 0 END) as success_count,
          SUM(CASE WHEN r.status = 'error' THEN 1 ELSE 0 END) as failure_count,
          SUM(r.input_tokens) as input_tokens,
          SUM(r.output_tokens) as output_tokens
        FROM requests r
        LEFT JOIN api_keys k ON k.id = r.key_id
        WHERE r.created_at >= ?${scopeTail}
        GROUP BY timestamp
        ORDER BY timestamp ASC
      `).all(dateFormat, tzModifier, window.since, ...scopeArgs) as TimelineRow[]
    : getDb().prepare(`
        SELECT
          strftime(?, hour, ?) as timestamp,
          SUM(total_requests) as requests,
          SUM(success_count) as success_count,
          SUM(error_count) as failure_count,
          SUM(input_tokens) as input_tokens,
          SUM(output_tokens) as output_tokens
        FROM request_hourly
        WHERE hour >= ? AND hour < ?
        GROUP BY timestamp
        ORDER BY timestamp ASC
      `).all(dateFormat, tzModifier, hourFloor(window.since), window.until) as TimelineRow[];

  res.json(rows.map(r => ({
    timestamp: r.timestamp,
    requests: r.requests ?? 0,
    successCount: r.success_count ?? 0,
    failureCount: r.failure_count ?? 0,
    inputTokens: r.input_tokens ?? 0,
    outputTokens: r.output_tokens ?? 0,
  })));
});

// Error distribution (grouped by error type and platform)
analyticsRouter.get('/error-distribution', (req: Request, res: Response) => {
  const scope = readScope(req);
  if ('error' in scope) {
    res.status(400).json({ error: scope.error });
    return;
  }
  const { window, filters, device } = scope;
  // These three queries are all "errors in this window", so they share the
  // error predicate and the composed scope. A `status` filter composes with it
  // rather than replacing it: asking for status=success legitimately returns
  // no errors, which is the truth about that slice.
  const errTail = ` AND r.status = 'error'` + scopeSql(window, filters, device);
  const errArgs = scopeParams(window, filters, device);
  const db = getDb();

  // Group errors by category (extract the key part of the error message).
  // LOWER() first: LIKE is case-sensitive in SQLite, and the error strings we
  // persist are dominated by capitalized upstream messages ("Invalid API key",
  // "Too Many Requests", "Timeout"), which all landed in 'Other' before. The
  // old '%invalid.*key%' pattern was regex syntax pasted into LIKE, where '.'
  // and '*' are literal characters, so it matched nothing real.
  const rows = db.prepare(`
    SELECT
      r.platform,
      r.model_id,
      CASE
        WHEN lower(error) LIKE '%429%' OR lower(error) LIKE '%rate limit%' OR lower(error) LIKE '%too many%' OR lower(error) LIKE '%quota%' THEN 'Rate Limited (429)'
        WHEN lower(error) LIKE '%401%' OR lower(error) LIKE '%unauthorized%' OR lower(error) LIKE '%invalid api key%' OR lower(error) LIKE '%invalid_api_key%' OR lower(error) LIKE '%incorrect api key%' THEN 'Auth Error (401)'
        WHEN lower(error) LIKE '%403%' OR lower(error) LIKE '%forbidden%' THEN 'Forbidden (403)'
        WHEN lower(error) LIKE '%404%' OR lower(error) LIKE '%not found%' THEN 'Not Found (404)'
        WHEN lower(error) LIKE '%timeout%' OR lower(error) LIKE '%timed out%' OR lower(error) LIKE '%etimedout%' OR lower(error) LIKE '%econnrefused%' THEN 'Timeout/Connection'
        WHEN lower(error) LIKE '%500%' OR lower(error) LIKE '%internal server%' THEN 'Server Error (500)'
        WHEN lower(error) LIKE '%503%' OR lower(error) LIKE '%unavailable%' THEN 'Unavailable (503)'
        ELSE 'Other'
      END as error_category,
      COUNT(*) as count
    FROM requests r
    LEFT JOIN api_keys k ON k.id = r.key_id
    WHERE r.created_at >= ?${errTail}
    GROUP BY r.platform, error_category
    ORDER BY count DESC
  `).all(window.since, ...errArgs) as Array<{ platform: string; model_id: string; error_category: string; count: number }>;

  // Also get totals by category
  const byCategory = db.prepare(`
    SELECT
      CASE
        WHEN lower(error) LIKE '%429%' OR lower(error) LIKE '%rate limit%' OR lower(error) LIKE '%too many%' OR lower(error) LIKE '%quota%' THEN 'Rate Limited (429)'
        WHEN lower(error) LIKE '%401%' OR lower(error) LIKE '%unauthorized%' OR lower(error) LIKE '%invalid api key%' OR lower(error) LIKE '%invalid_api_key%' OR lower(error) LIKE '%incorrect api key%' THEN 'Auth Error (401)'
        WHEN lower(error) LIKE '%403%' OR lower(error) LIKE '%forbidden%' THEN 'Forbidden (403)'
        WHEN lower(error) LIKE '%404%' OR lower(error) LIKE '%not found%' THEN 'Not Found (404)'
        WHEN lower(error) LIKE '%timeout%' OR lower(error) LIKE '%timed out%' OR lower(error) LIKE '%etimedout%' OR lower(error) LIKE '%econnrefused%' THEN 'Timeout/Connection'
        WHEN lower(error) LIKE '%500%' OR lower(error) LIKE '%internal server%' THEN 'Server Error (500)'
        WHEN lower(error) LIKE '%503%' OR lower(error) LIKE '%unavailable%' THEN 'Unavailable (503)'
        ELSE 'Other'
      END as category,
      COUNT(*) as count
    FROM requests r
    LEFT JOIN api_keys k ON k.id = r.key_id
    WHERE r.created_at >= ?${errTail}
    GROUP BY category
    ORDER BY count DESC
  `).all(window.since, ...errArgs) as CategoryRow[];

  // Errors by provider. Endpoint-scoped like /by-platform: one bar per custom
  // relay, not one bar pooling every relay's failures under "custom" (#889) —
  // a bar the operator cannot act on, because it never says which endpoint is
  // the one failing.
  const byPlatformRows = db.prepare(`
    SELECT r.platform, ${ENDPOINT_ID_SQL} as base_url, COUNT(*) as count
    FROM requests r
    LEFT JOIN api_keys k ON k.id = r.key_id
    WHERE r.created_at >= ?${errTail}
    GROUP BY r.platform, ${ENDPOINT_ID_SQL}
    ORDER BY count DESC
  `).all(window.since, ...errArgs) as ErrorPlatformRow[];

  const byPlatform = byPlatformRows.map(r => {
    const baseUrl: string | null = r.base_url || null;
    return {
      // `platform` stays the raw slug: it is what the chart colors by.
      platform: r.platform,
      providerId: providerIdFor(r.platform, baseUrl),
      endpoint: providerDisplayName(r.platform, baseUrl),
      count: r.count,
    };
  });

  res.json({
    byCategory,
    byPlatform,
    detailed: rows,
  });
});

// Recent errors
analyticsRouter.get('/errors', (req: Request, res: Response) => {
  const scope = readScope(req);
  if ('error' in scope) {
    res.status(400).json({ error: scope.error });
    return;
  }
  const { window, filters, device } = scope;
  // A `status` filter that isn't 'error' composes into an empty list rather
  // than a contradiction: "errors in the success-only slice" is zero rows.
  const rows = getDb().prepare(`
    SELECT r.id, r.platform, ${ENDPOINT_ID_SQL} as base_url, r.model_id, r.error,
           r.latency_ms, r.created_at
    FROM requests r
    LEFT JOIN api_keys k ON k.id = r.key_id
    WHERE r.status = 'error' AND r.created_at >= ?${scopeSql(window, filters, device)}
    ORDER BY r.created_at DESC
    LIMIT 50
  `).all(window.since, ...scopeParams(window, filters, device)) as RecentErrorDbRow[];

  res.json(rows.map(r => {
    const baseUrl: string | null = r.base_url || null;
    return {
      id: r.id,
      platform: r.platform,
      providerId: providerIdFor(r.platform, baseUrl),
      endpoint: providerDisplayName(r.platform, baseUrl),
      modelId: r.model_id,
      error: r.error,
      latencyMs: r.latency_ms,
      createdAt: r.created_at,
    };
  }));
});

// Recent calls — one row per proxied request, newest first, with the caller's
// IP and User-Agent (all local clients share the unified key, so client_ip is
// the only per-caller discriminator; UA disambiguates tunneled loopback calls).
// Reads the raw `requests` table, so history is bounded by the retention prune.
//
// The status and provider selectors this endpoint used to own now sit above the
// page and are shared with every other panel (pageFilters), which is what makes
// "the list and the charts describe different traffic" impossible. The legacy
// `?platform=` param still works, in its older non-endpoint-scoped meaning.
analyticsRouter.get('/requests', (req: Request, res: Response) => {
  const scope = readScope(req);
  if ('error' in scope) {
    res.status(400).json({ error: scope.error });
    return;
  }
  const { window, filters, device } = scope;
  const limit = Math.min(Math.max(parseInt(req.query.limit as string, 10) || 100, 1), 500);
  const offset = Math.max(parseInt(req.query.offset as string, 10) || 0, 0);
  const db = getDb();

  // `total` counts the SAME set the rows come from — filters are shared with
  // every other panel, so the list and its count can never describe different
  // populations, and neither can describe traffic the charts don't show.
  const total = (db.prepare(
    `SELECT COUNT(*) as c FROM requests r
       LEFT JOIN api_keys k ON k.id = r.key_id
      WHERE r.created_at >= ?${scopeSql(window, filters, device)}`
  ).get(window.since, ...scopeParams(window, filters, device)) as { c: number }).c;

  const rows = db.prepare(`
    SELECT r.id, r.platform, r.model_id, r.requested_model, r.request_type, r.status,
           r.input_tokens, r.output_tokens, r.latency_ms, r.error,
           r.client_ip, r.client_user_agent, r.client_agent,
           strftime('%Y-%m-%dT%H:%M:%SZ', r.created_at) as created_at_iso,
           (SELECT COUNT(*) FROM request_attempts a WHERE a.request_id = r.id) as attempt_count,
           k.label as key_label
    FROM requests r
    LEFT JOIN api_keys k ON k.id = r.key_id
    WHERE r.created_at >= ?${scopeSql(window, filters, device)}
    ORDER BY r.created_at DESC, r.id DESC
    LIMIT ? OFFSET ?
  `).all(window.since, ...scopeParams(window, filters, device), limit, offset) as RecentCallDbRow[];

  res.json({
    total,
    rows: rows.map(r => ({
      id: r.id,
      platform: r.platform,
      modelId: r.model_id,
      requestedModel: r.requested_model,
      requestType: r.request_type,
      status: r.status,
      inputTokens: r.input_tokens,
      outputTokens: r.output_tokens,
      latencyMs: r.latency_ms,
      error: r.error,
      clientIp: r.client_ip,
      clientUserAgent: r.client_user_agent,
      clientAgent: r.client_agent,
      createdAt: r.created_at_iso,
      // #785: custom endpoints all share the generic 'custom' platform id, so
      // the user's key label ("Ollama box") rides along to name the real
      // provider in the recent-calls list. Null when the key was deleted or
      // never labelled.
      keyLabel: r.key_label ?? null,
      // Failover-ladder length for this row. Attempts hang off the TERMINAL
      // row of a proxied request; mid-ladder failure rows report 0.
      attemptCount: r.attempt_count,
    })),
  });
});

// Per-request detail: the row plus its durable failover ladder — one entry per
// dispatched attempt (including the successful final one), ordinal-ordered,
// with the failure class and timing of each hop. keyOrdinal is the per-request
// key ordinal (key1, key2…), same anonymization as X-Fallback-Trail — internal
// key ids are never exposed. Attempts are keyed to the ladder's terminal row
// (the success row, or the last failure row when it exhausted), so mid-ladder
// error rows legitimately return an empty attempts array.
analyticsRouter.get('/requests/:id', (req: Request, res: Response) => {
  const id = Number.parseInt(req.params.id as string, 10);
  if (!Number.isInteger(id) || id <= 0) {
    res.status(400).json({ error: 'invalid request id' });
    return;
  }
  const db = getDb();

  const r = db.prepare(`
    SELECT id, platform, model_id, requested_model, served_model, request_type, status,
           input_tokens, output_tokens, latency_ms, ttfb_ms, error,
           client_ip, client_user_agent, client_agent,
           strftime('%Y-%m-%dT%H:%M:%SZ', created_at) as created_at_iso
    FROM requests
    WHERE id = ?
  `).get(id) as any;
  if (!r) {
    res.status(404).json({ error: 'request not found' });
    return;
  }

  const attempts = db.prepare(`
    SELECT ordinal, platform, model_id, key_ordinal, key_label, outcome, start_offset_ms, duration_ms, error_summary, routing_json
    FROM request_attempts
    WHERE request_id = ?
    ORDER BY ordinal ASC
  `).all(id) as any[];

  res.json({
    id: r.id,
    platform: r.platform,
    modelId: r.model_id,
    requestedModel: r.requested_model,
    // Upstream-reported model when it genuinely differed from the routed
    // model_id (#534 served-model drift guard); null in the healthy case.
    servedModel: r.served_model,
    requestType: r.request_type,
    status: r.status,
    inputTokens: r.input_tokens,
    outputTokens: r.output_tokens,
    latencyMs: r.latency_ms,
    ttfbMs: r.ttfb_ms,
    error: r.error,
    clientIp: r.client_ip,
    clientUserAgent: r.client_user_agent,
    clientAgent: r.client_agent,
    createdAt: r.created_at_iso,
    attempts: attempts.map(a => ({
      ordinal: a.ordinal,
      platform: a.platform,
      modelId: a.model_id,
      keyOrdinal: a.key_ordinal,
      keyLabel: a.key_label ?? null,
      outcome: a.outcome,
      // What the router was looking at when it picked this hop. Null for rows
      // written before the trace existed, and for a route built without one.
      // Parsed here so the client gets an object rather than a JSON string;
      // a malformed row degrades to null instead of failing the whole drill-down.
      routing: parseRoutingTrace(a.routing_json),
      startOffsetMs: a.start_offset_ms,
      durationMs: a.duration_ms,
      // Short, redacted per-hop error text (null for successful hops and for
      // rows written before the error_summary migration).
      errorSummary: a.error_summary ?? null,
    })),
  });
});
