// route-evidence — what is known about one route, from real traffic and from
// probes, in one shape the chain arranger can rank on.
//
// A route is (platform, model_id, endpoint_scope): one `models` row, which is
// what a chain position points at. Two routes of the same model are ranked
// apart on purpose — nvidia glm-5.3-flash at 91% and radeon GLM-5.3-Flash at
// 41% are one model and two very different routes (ADR
// ARCH-20261026-chain-auto-arrange).
//
// Three sources, kept apart until the caller combines them:
//   real    `requests` rows: what actually happened when the router sent
//           traffic. Canceled requests (the client hung up) say nothing about
//           the route and are not counted.
//   probe   `route_probe_result` rows with source 'probe': did it answer.
//           rate_limited and refused outcomes are excluded from the count —
//           a spent quota or a missing grant is not the model failing.
//   screen  graded bench scenarios from either source: how well it answered,
//           per capability, over a longer window so a weekly rotation of three
//           agentic scenarios always has something to say.

import type { Db } from '../db/types.js';
import { getDb } from '../db/index.js';

export interface RouteKey {
  platform: string;
  modelId: string;
  endpointScope: string;
}

export interface CapabilityScreen {
  /** Mean score (0-100, the bench's internal scale) of graded scenarios. */
  mean: number | null;
  /** Graded scenarios behind the mean. */
  graded: number;
}

export interface RouteEvidence extends RouteKey {
  real: { n: number; ok: number; avgOkLatencyMs: number | null };
  probe: { n: number; ok: number; avgOkLatencyMs: number | null; lastAtMs: number | null };
  screen: {
    agentic: CapabilityScreen;
    coding: CapabilityScreen;
    /** The newest probe that offered native tools found them refused. */
    nativeToolsUnsupported: boolean;
  };
}

export const RELIABILITY_WINDOW_DAYS = 14;
export const SCREEN_WINDOW_DAYS = 30;

export function routeKeyOf(r: RouteKey): string {
  return `${r.platform}\u0000${r.modelId}\u0000${r.endpointScope}`;
}

function empty(key: RouteKey): RouteEvidence {
  return {
    ...key,
    real: { n: 0, ok: 0, avgOkLatencyMs: null },
    probe: { n: 0, ok: 0, avgOkLatencyMs: null, lastAtMs: null },
    screen: { agentic: { mean: null, graded: 0 }, coding: { mean: null, graded: 0 }, nativeToolsUnsupported: false },
  };
}

/** SQLite's datetime('now') text for an instant, which is how `requests.created_at` is stored. */
function sqliteUtc(ms: number): string {
  return new Date(ms).toISOString().replace('T', ' ').slice(0, 19);
}

/**
 * Evidence for every route that has any, keyed by `routeKeyOf`.
 *
 * A route absent from the map has no evidence at all — "unmeasured", which is
 * a state of its own and not a zero.
 */
export function loadRouteEvidence(
  db: Db = getDb(),
  opts: { now?: number; reliabilityDays?: number; screenDays?: number } = {},
): Map<string, RouteEvidence> {
  const now = opts.now ?? Date.now();
  const reliabilitySince = now - (opts.reliabilityDays ?? RELIABILITY_WINDOW_DAYS) * 86_400_000;
  const screenSince = now - (opts.screenDays ?? SCREEN_WINDOW_DAYS) * 86_400_000;
  const out = new Map<string, RouteEvidence>();
  const at = (key: RouteKey) => {
    const k = routeKeyOf(key);
    let e = out.get(k);
    if (!e) { e = empty(key); out.set(k, e); }
    return e;
  };

  // A request row names its route through model_db_id. Rows written before
  // that column existed fall back to the catalogue identity ('' scope).
  const real = db.prepare(`
    SELECT r.platform AS platform, r.model_id AS modelId,
           COALESCE(m.endpoint_scope, '') AS endpointScope,
           COUNT(*) AS n,
           SUM(r.status = 'success') AS ok,
           AVG(CASE WHEN r.status = 'success' THEN r.latency_ms END) AS avgOk
      FROM requests r
      LEFT JOIN models m ON m.id = r.model_db_id
     WHERE r.created_at >= ?
       AND r.status IN ('success', 'error')
       AND r.platform <> 'routing'
     GROUP BY r.platform, r.model_id, COALESCE(m.endpoint_scope, '')
  `).all(sqliteUtc(reliabilitySince)) as Array<RouteKey & { n: number; ok: number; avgOk: number | null }>;
  for (const row of real) {
    at(row).real = { n: row.n, ok: row.ok ?? 0, avgOkLatencyMs: row.avgOk == null ? null : Math.round(row.avgOk) };
  }

  const probes = db.prepare(`
    SELECT platform, model_id AS modelId, endpoint_scope AS endpointScope,
           SUM(outcome IN ('ok', 'empty', 'timeout', 'error')) AS n,
           SUM(outcome = 'ok') AS ok,
           AVG(CASE WHEN outcome = 'ok' THEN latency_ms END) AS avgOk,
           MAX(probed_at_ms) AS lastAt
      FROM route_probe_result
     WHERE source = 'probe' AND probed_at_ms >= ?
     GROUP BY platform, model_id, endpoint_scope
  `).all(reliabilitySince) as Array<RouteKey & { n: number; ok: number; avgOk: number | null; lastAt: number }>;
  for (const row of probes) {
    at(row).probe = { n: row.n ?? 0, ok: row.ok ?? 0, avgOkLatencyMs: row.avgOk == null ? null : Math.round(row.avgOk), lastAtMs: row.lastAt };
  }

  const screen = db.prepare(`
    SELECT platform, model_id AS modelId, endpoint_scope AS endpointScope,
           CASE WHEN scenario_id LIKE 'A%' THEN 'agentic' ELSE 'coding' END AS capability,
           AVG(score) AS mean, COUNT(*) AS graded
      FROM route_probe_result
     WHERE probed_at_ms >= ? AND score IS NOT NULL
     GROUP BY platform, model_id, endpoint_scope, capability
  `).all(screenSince) as Array<RouteKey & { capability: 'agentic' | 'coding'; mean: number; graded: number }>;
  for (const row of screen) {
    at(row).screen[row.capability] = { mean: Math.round(row.mean * 10) / 10, graded: row.graded };
  }

  // Native tools refused is a property of the endpoint's current interface,
  // so only the newest tool-offering probe decides it.
  const unsupported = db.prepare(`
    SELECT p.platform, p.model_id AS modelId, p.endpoint_scope AS endpointScope, p.status
      FROM route_probe_result p
      JOIN (SELECT platform, model_id, endpoint_scope, MAX(probed_at_ms) AS at
              FROM route_probe_result
             WHERE scenario_id IN ('A1', 'A2', 'A3') AND probed_at_ms >= ? AND outcome = 'ok'
             GROUP BY platform, model_id, endpoint_scope) last
        ON last.platform = p.platform AND last.model_id = p.model_id
       AND last.endpoint_scope = p.endpoint_scope AND last.at = p.probed_at_ms
     WHERE p.scenario_id IN ('A1', 'A2', 'A3')
  `).all(screenSince) as Array<RouteKey & { status: string }>;
  for (const row of unsupported) {
    if (row.status === 'UNSUPPORTED') at(row).screen.nativeToolsUnsupported = true;
  }

  return out;
}

export interface RouteProbeRow {
  id: number;
  keyId: number | null;
  scenarioId: string;
  benchVersion: string;
  source: 'probe' | 'import';
  streamed: boolean;
  outcome: string;
  status: string;
  score: number | null;
  mode: string;
  latencyMs: number | null;
  ttfbMs: number | null;
  promptTokens: number;
  completionTokens: number;
  error: string | null;
  probedAtMs: number;
}

export interface RouteHistoryDay {
  /** UTC day, YYYY-MM-DD. */
  day: string;
  realN: number;
  realOk: number;
  probeN: number;
  probeOk: number;
  agenticMean: number | null;
  codingMean: number | null;
}

export interface RouteHistory {
  route: RouteKey;
  probes: RouteProbeRow[];
  daily: RouteHistoryDay[];
}

/** One route's history over `days`, newest probe first and days oldest first:
 *  the drill-in for a route whose scores have drifted. */
export function listRouteHistory(route: RouteKey, days = 90, db: Db = getDb(), now = Date.now()): RouteHistory {
  const since = now - days * 86_400_000;
  const probes = (db.prepare(`
    SELECT id, key_id, scenario_id, bench_version, source, streamed, outcome, status, score, mode,
           latency_ms, ttfb_ms, prompt_tokens, completion_tokens, error, probed_at_ms
      FROM route_probe_result
     WHERE platform = ? AND model_id = ? AND endpoint_scope = ? AND probed_at_ms >= ?
     ORDER BY probed_at_ms DESC, id DESC
  `).all(route.platform, route.modelId, route.endpointScope, since) as Array<Record<string, unknown>>).map(r => ({
    id: Number(r.id),
    keyId: r.key_id == null ? null : Number(r.key_id),
    scenarioId: String(r.scenario_id),
    benchVersion: String(r.bench_version),
    source: r.source as 'probe' | 'import',
    streamed: Number(r.streamed) === 1,
    outcome: String(r.outcome),
    status: String(r.status),
    score: r.score == null ? null : Number(r.score),
    mode: String(r.mode),
    latencyMs: r.latency_ms == null ? null : Number(r.latency_ms),
    ttfbMs: r.ttfb_ms == null ? null : Number(r.ttfb_ms),
    promptTokens: Number(r.prompt_tokens),
    completionTokens: Number(r.completion_tokens),
    error: r.error == null ? null : String(r.error),
    probedAtMs: Number(r.probed_at_ms),
  }));

  const days_ = new Map<string, RouteHistoryDay>();
  const dayOf = (day: string) => {
    let d = days_.get(day);
    if (!d) { d = { day, realN: 0, realOk: 0, probeN: 0, probeOk: 0, agenticMean: null, codingMean: null }; days_.set(day, d); }
    return d;
  };

  const real = db.prepare(`
    SELECT substr(r.created_at, 1, 10) AS day, COUNT(*) AS n, SUM(r.status = 'success') AS ok
      FROM requests r
      LEFT JOIN models m ON m.id = r.model_db_id
     WHERE r.platform = ? AND r.model_id = ? AND COALESCE(m.endpoint_scope, '') = ?
       AND r.created_at >= ? AND r.status IN ('success', 'error')
     GROUP BY day
  `).all(route.platform, route.modelId, route.endpointScope, sqliteUtc(since)) as Array<{ day: string; n: number; ok: number }>;
  for (const r of real) Object.assign(dayOf(r.day), { realN: r.n, realOk: r.ok ?? 0 });

  const graded = new Map<string, { agentic: number[]; coding: number[] }>();
  for (const p of probes) {
    const day = new Date(p.probedAtMs).toISOString().slice(0, 10);
    const d = dayOf(day);
    if (p.source === 'probe' && p.outcome !== 'rate_limited' && p.outcome !== 'refused') {
      d.probeN++;
      if (p.outcome === 'ok') d.probeOk++;
    }
    if (p.score != null) {
      let g = graded.get(day);
      if (!g) { g = { agentic: [], coding: [] }; graded.set(day, g); }
      (p.scenarioId.startsWith('A') ? g.agentic : g.coding).push(p.score);
    }
  }
  const mean = (xs: number[]) => xs.length ? Math.round(xs.reduce((a, b) => a + b, 0) / xs.length * 10) / 10 : null;
  for (const [day, g] of graded) Object.assign(dayOf(day), { agenticMean: mean(g.agentic), codingMean: mean(g.coding) });

  return { route, probes, daily: [...days_.values()].sort((a, b) => a.day.localeCompare(b.day)) };
}
