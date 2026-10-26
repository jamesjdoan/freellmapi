// route-probe — keep a measured record of routes that real traffic does not
// reach, so the chain arranger ranks them on evidence instead of on whatever
// position they were given (ADR ARCH-20261026-chain-auto-arrange).
//
// Every probe is one graded screening-benchmark scenario rather than a ping,
// so one call answers two questions: did the route answer (latency, failure
// class) and how well (the bench's 0-100 score). The agentic scenarios rotate
// A1 -> A2 -> A3 per route, giving each a full agentic screen within a week.
// The coding scenarios grade by running Python in an OS sandbox the container
// does not have, so they stay a host-side CLI job (scripts/model-bench.ts)
// whose imports land in the same history table.
//
// It probes the way agents call: STREAMED, with native tools, straight to the
// provider adapter through the route's own key. No router and no fallback: a
// failure is this route's failure. nvidia/stepfun-ai/step-5-preview passed a
// non-streamed tool call and failed every routed streamed attempt; this is the
// probe that would have seen it.
//
// Budget — a probe must never take quota a real call needed:
//   - only routes in a chain, and never one that served real traffic in the
//     last 24 hours (real success is stronger evidence than any probe);
//   - at most 2 probes per route per day (1 where the daily limit is unknown
//     or under 200), at least 8 hours apart;
//   - no more than 1% of a provider's account-wide daily cap where one is set;
//   - nothing into a cooldown, a closed quota domain, or a pool under half
//     full — unless that pool is under-spent near its reset, where the quota
//     would expire unused anyway; those are probed first;
//   - never a route that bills paid balance.
// Probe traffic counts toward the usage windows (the provider counts it) but
// never feeds cooldowns, penalties or their recovery — a probe is a question,
// not a verdict, the same rule as upstream's model-probe.ts.

import type { Platform } from '@freellmapi/shared/types.js';
import type { Db } from '../db/types.js';
import type { Scheduler } from '../lib/scheduler.js';
import type { CompletionOptions } from '../providers/base.js';
import { getDb } from '../db/index.js';
import { resolveProvider } from '../providers/index.js';
import { decrypt } from '../lib/crypto.js';
import { decryptProxyUrl } from '../lib/key-proxy.js';
import { withKeyProxy } from '../lib/proxy.js';
import { sanitizeProviderErrorMessage } from '../lib/error-redaction.js';
import { providerLog } from '../lib/server-logs.js';
import { CHAIN_CONTRACTS } from '../data/routing-curation.js';
import { isExtensionEnabled } from './extension-state.js';
import { consumesPaidBalance, inferQuotaPoolKey } from './provider-quota.js';
import { effectiveRouteLimits } from './quota-policy.js';
import { quotaDomainsAdmit, quotaPressure } from './quota-pressure.js';
import { getProviderDailyRequestCap, hasActiveCooldown, isOnCooldown, recordProbeUsage } from './ratelimit.js';
import { BENCH_VERSION, SCENARIOS, estimatePromptTokens, type ScenarioId } from './model-bench/fixtures.js';
import { runScenarioOnce, type Caller } from './model-bench/runner.js';
import { collectStream } from './model-bench/stream.js';
import { pickRouteKey, type RouteKeyRow } from './model-bench/route-key.js';
import { loadRouteEvidence, routeKeyOf, type RouteKey } from './route-evidence.js';
import { endpointScopeForBaseUrl } from '../lib/endpoint-scope.js';

export const ROUTE_PROBE_EXTENSION_ID = 'route-bench-probe';

export const ROUTE_PROBE_INTERVAL_MS = 15 * 60_000;
const FIRST_PASS_DELAY_MS = 3 * 60_000;
const MAX_PROBES_PER_PASS = 4;
const MIN_SPACING_MS = 8 * 3_600_000;
const REAL_TRAFFIC_SKIP_MS = 24 * 3_600_000;
const DAY_MS = 86_400_000;
/** A probe is one short scenario; anything slower than this is a timeout,
 *  the same bound real traffic gets from the fallback loop's 45s ceiling plus
 *  headroom for a multi-turn A3. */
const PROBE_CALL_TIMEOUT_MS = 60_000;
/** Below this daily request limit one probe is already a visible share. */
const TWO_PROBES_MIN_RPD = 200;
/** Spend a pool only while at least this fraction of it is left. */
const MIN_HEADROOM = 0.5;
const PROVIDER_CAP_SHARE = 0.01;

const AGENTIC: readonly ScenarioId[] = ['A1', 'A2', 'A3'];

export interface ProbeCandidate extends RouteKey {
  modelDbId: number;
  /** The catalogue row's key binding: required for custom relays. */
  boundKeyId: number | null;
}

export interface CandidateSelection {
  /** In probing order: expiring quota first, then the least-evidenced. */
  eligible: Array<ProbeCandidate & { scenarioId: ScenarioId }>;
  skipped: Array<ProbeCandidate & { reason: string }>;
}

export type ProbeOutcome = 'ok' | 'empty' | 'timeout' | 'rate_limited' | 'refused' | 'error';

export interface ProbeRunOutcome {
  ok: boolean;
  /** Why no call was made, when none was. */
  refused?: string;
  scenarioId?: ScenarioId;
  outcome?: ProbeOutcome;
  status?: string;
  score?: number | null;
  latencyMs?: number | null;
}

export interface RouteProbeDeps {
  /** Test seam: the wire call for one scenario turn. Production streams
   *  through the route's own provider adapter and key. */
  makeCaller?: (candidate: ProbeCandidate, key: RouteKeyRow, timing: { ttfbMs: number | null }) => Caller;
}

const SKIP_PAID = 'bills paid balance';

/** The probe's own daily allowance for one route. */
function dailyProbeCap(platform: string, modelId: string, now: number): number {
  const rpd = effectiveRouteLimits(platform, modelId, {}, now).rpd;
  return rpd != null && rpd >= TWO_PROBES_MIN_RPD ? 2 : 1;
}

/** The agentic scenario after the route's last probed one, so each route
 *  cycles A1 -> A2 -> A3 and has a full agentic screen within a week. */
function nextAgenticScenario(db: Db, route: RouteKey): ScenarioId {
  const last = db.prepare(`
    SELECT scenario_id FROM route_probe_result
     WHERE platform = ? AND model_id = ? AND endpoint_scope = ? AND source = 'probe' AND scenario_id IN ('A1','A2','A3')
     ORDER BY probed_at_ms DESC, id DESC LIMIT 1
  `).get(route.platform, route.modelId, route.endpointScope) as { scenario_id: ScenarioId } | undefined;
  return last ? AGENTIC[(AGENTIC.indexOf(last.scenario_id) + 1) % AGENTIC.length] : AGENTIC[0];
}

/**
 * Which chain routes may be probed now, and why the rest may not.
 *
 * Pure apart from reads: no call is made and nothing is written, so the
 * dashboard and tests can ask the same question the scheduler does.
 */
export function selectProbeCandidates(db: Db = getDb(), now = Date.now()): CandidateSelection {
  const chainNames = CHAIN_CONTRACTS.map(c => c.name);
  const routes = db.prepare(`
    SELECT DISTINCT m.id AS modelDbId, m.platform, m.model_id AS modelId,
           COALESCE(m.endpoint_scope, '') AS endpointScope, m.key_id AS boundKeyId
      FROM profile_models pm
      JOIN profiles p ON p.id = pm.profile_id
      JOIN models m ON m.id = pm.model_db_id
     WHERE pm.enabled = 1 AND m.enabled = 1
       AND p.name IN (${chainNames.map(() => '?').join(',')})
     ORDER BY m.id
  `).all(...chainNames) as ProbeCandidate[];

  const evidence = loadRouteEvidence(db, { now });
  const realSince = new Date(now - REAL_TRAFFIC_SKIP_MS).toISOString().replace('T', ' ').slice(0, 19);
  const servedRecently = db.prepare(`
    SELECT 1 FROM requests r
      LEFT JOIN models m ON m.id = r.model_db_id
     WHERE r.platform = ? AND r.model_id = ? AND COALESCE(m.endpoint_scope, '') = ?
       AND r.status = 'success' AND r.created_at >= ?
     LIMIT 1
  `);
  const recentProbes = db.prepare(`
    SELECT COUNT(*) AS n, MAX(probed_at_ms) AS lastAt FROM route_probe_result
     WHERE platform = ? AND model_id = ? AND endpoint_scope = ? AND source = 'probe' AND probed_at_ms >= ?
  `);
  const providerProbesToday = db.prepare(`
    SELECT COUNT(*) AS n FROM route_probe_result WHERE platform = ? AND source = 'probe' AND probed_at_ms >= ?
  `);

  const eligible: Array<ProbeCandidate & { scenarioId: ScenarioId; harvest: boolean; samples: number; lastAt: number }> = [];
  const skipped: CandidateSelection['skipped'] = [];
  const providerBudget = new Map<string, number>();

  for (const route of routes) {
    const skip = (reason: string) => { skipped.push({ ...route, reason }); };
    if (consumesPaidBalance(route.platform as Platform, route.modelId)) { skip(SKIP_PAID); continue; }
    if (servedRecently.get(route.platform, route.modelId, route.endpointScope, realSince)) { skip('served real traffic in the last 24h'); continue; }
    const recent = recentProbes.get(route.platform, route.modelId, route.endpointScope, now - DAY_MS) as { n: number; lastAt: number | null };
    const cap = dailyProbeCap(route.platform, route.modelId, now);
    if (recent.n >= cap) { skip(`daily probe allowance spent (${recent.n}/${cap})`); continue; }
    if (recent.lastAt != null && now - recent.lastAt < MIN_SPACING_MS) { skip('probed within the last 8h'); continue; }
    if (hasActiveCooldown(route.platform, route.modelId, now)) { skip('on cooldown'); continue; }

    // Account-wide daily cap, where one is declared: probes take at most 1%.
    if (!providerBudget.has(route.platform)) {
      const accountCap = getProviderDailyRequestCap(route.platform);
      const usedToday = providerProbesToday.get(route.platform, now - DAY_MS) as { n: number };
      const used = usedToday.n;
      providerBudget.set(route.platform, accountCap == null ? Infinity : Math.max(1, Math.floor(accountCap * PROVIDER_CAP_SHARE)) - used);
    }
    if ((providerBudget.get(route.platform) ?? 0) <= 0) { skip('provider probe share spent'); continue; }

    const scenarioId = nextAgenticScenario(db, route);

    const admit = quotaDomainsAdmit(route.platform, route.modelId, route.endpointScope, estimatePromptTokens(SCENARIOS[scenarioId]) + SCENARIOS[scenarioId].maxTokens, now);
    if (!admit.ok) { skip(`quota closed (${admit.blockedBy ?? 'unknown domain'})`); continue; }
    const pressure = quotaPressure(route.platform, route.modelId, route.endpointScope, undefined, now);
    const harvest = pressure.harvest > 1;
    if (!pressure.unknown && pressure.headroom != null && pressure.headroom < MIN_HEADROOM && !harvest) {
      skip(`pool ${Math.round(pressure.headroom * 100)}% left; reserved for real traffic`);
      continue;
    }

    const e = evidence.get(routeKeyOf(route));
    providerBudget.set(route.platform, (providerBudget.get(route.platform) ?? 0) - 1);
    eligible.push({ ...route, scenarioId, harvest, samples: (e?.real.n ?? 0) + (e?.probe.n ?? 0), lastAt: recent.lastAt ?? e?.probe.lastAtMs ?? 0 });
  }

  // Quota that would expire unused first; then whatever is least known; then
  // whoever was probed longest ago.
  eligible.sort((a, b) => Number(b.harvest) - Number(a.harvest) || a.samples - b.samples || a.lastAt - b.lastAt || a.modelDbId - b.modelDbId);
  return { eligible: eligible.map(({ harvest: _h, samples: _s, lastAt: _l, ...c }) => c), skipped };
}

/** What a failed scenario's error says about the route. */
function classifyError(message: string): ProbeOutcome {
  if (/empty completion/i.test(message)) return 'empty';
  if (/abort|timed? ?out|timeout/i.test(message)) return 'timeout';
  if (/\b429\b|rate.?limit|too many requests|quota|exhaust/i.test(message)) return 'rate_limited';
  if (/\b40[1234]\b|unauthori[sz]ed|forbidden|not found|payment required/i.test(message)) return 'refused';
  return 'error';
}

function streamingCaller(candidate: ProbeCandidate, key: RouteKeyRow, timing: { ttfbMs: number | null }): Caller {
  const provider = resolveProvider(candidate.platform as Platform, key.base_url);
  if (!provider) throw new Error(`no provider adapter for ${candidate.platform}`);
  const apiKey = decrypt(key.encrypted_key, key.iv, key.auth_tag);
  const label = `${candidate.platform}/${candidate.modelId}`;
  return (messages, options) => withKeyProxy(decryptProxyUrl(key), async () => {
    const startedAtMs = Date.now();
    const collected = await collectStream(provider.streamChatCompletion(apiKey, messages, candidate.modelId, {
      ...options,
      timeoutMs: PROBE_CALL_TIMEOUT_MS,
      stream_options: { include_usage: true },
    } as CompletionOptions, {
      platform: candidate.platform as Platform,
      keyId: key.id,
      modelId: candidate.modelId,
      quotaPoolKey: inferQuotaPoolKey(candidate.platform as Platform, candidate.modelId, candidate.endpointScope || null),
      endpoint: 'chat',
      origin: 'probe',
    }), { label, toolNames: new Set((options.tools ?? []).map(t => t.function.name)), startedAtMs });
    timing.ttfbMs ??= collected.ttfbMs;
    return collected.response;
  });
}

async function probeCandidate(
  db: Db,
  candidate: ProbeCandidate,
  scenarioId: ScenarioId,
  deps: RouteProbeDeps,
): Promise<ProbeRunOutcome> {
  let key: RouteKeyRow;
  try {
    key = pickRouteKey(db, { platform: candidate.platform, model_id: candidate.modelId, key_id: candidate.boundKeyId });
  } catch (err) {
    return { ok: false, refused: err instanceof Error ? err.message : String(err) };
  }
  if (isOnCooldown(candidate.platform, candidate.modelId, key.id)) return { ok: false, refused: `key ${key.id} is on cooldown for this model` };

  const timing = { ttfbMs: null as number | null };
  const call = (deps.makeCaller ?? streamingCaller)(candidate, key, timing);
  const started = Date.now();
  const run = await runScenarioOnce(call, scenarioId, { temperature: 0, seed: 7 });
  const latencyMs = Date.now() - started;
  const t = run.transcript;
  const answered = t.turns.length > 0;
  const outcome: ProbeOutcome = answered || t.toolsUnsupported ? 'ok' : classifyError(t.error ?? '');
  const status = run.grade.status === 'NOT_TESTED' ? 'INCONCLUSIVE' : run.grade.status;
  const error = t.error ? sanitizeProviderErrorMessage(t.error).slice(0, 300) : null;

  // The provider counted every call that reached it; the windows must too.
  const reached = run.usage.calls - run.usage.failedCalls;
  for (let i = 0; i < reached; i++) {
    recordProbeUsage(candidate.platform, candidate.modelId, key.id, i === 0 ? run.usage.promptTokens + run.usage.completionTokens : 0);
  }

  db.prepare(`
    INSERT INTO route_probe_result
      (platform, model_id, endpoint_scope, key_id, scenario_id, bench_version, source, streamed,
       outcome, status, score, mode, latency_ms, ttfb_ms, prompt_tokens, completion_tokens, error, probed_at_ms)
    VALUES (?, ?, ?, ?, ?, ?, 'probe', 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    candidate.platform, candidate.modelId, candidate.endpointScope, key.id, scenarioId, BENCH_VERSION,
    outcome, status, run.grade.score, t.mode, answered ? latencyMs : null, timing.ttfbMs,
    run.usage.promptTokens, run.usage.completionTokens, error, started,
  );

  const label = `${candidate.platform}/${candidate.modelId}${candidate.endpointScope ? ` @ ${candidate.endpointScope}` : ''}`;
  if (outcome === 'ok') {
    providerLog('info', `[RouteProbe] ${label} ${scenarioId} ${status}${run.grade.score != null ? ` (${run.grade.score})` : ''} in ${latencyMs}ms`, { provider: candidate.platform, model: candidate.modelId, event: 'route_probe_ok' });
  } else {
    providerLog('warn', `[RouteProbe] ${label} ${scenarioId} ${outcome}: ${error ?? 'no detail'}`, { provider: candidate.platform, model: candidate.modelId, event: 'route_probe_failed' });
  }
  return { ok: outcome === 'ok', scenarioId, outcome, status, score: run.grade.score, latencyMs: answered ? latencyMs : null };
}

export interface ProbePassResult {
  probed: Array<ProbeCandidate & { scenarioId: ScenarioId; result: ProbeRunOutcome }>;
  skipped: CandidateSelection['skipped'];
}

/** One scheduled pass. Exported for tests; production runs it from startRouteProbe. */
export async function runRouteProbePass(
  opts: { db?: Db; now?: number; maxProbes?: number; deps?: RouteProbeDeps } = {},
): Promise<ProbePassResult> {
  if (!isExtensionEnabled(ROUTE_PROBE_EXTENSION_ID)) return { probed: [], skipped: [] };
  const db = opts.db ?? getDb();
  const { eligible, skipped } = selectProbeCandidates(db, opts.now ?? Date.now());
  const probed: ProbePassResult['probed'] = [];
  for (const candidate of eligible.slice(0, opts.maxProbes ?? MAX_PROBES_PER_PASS)) {
    const result = await probeCandidate(db, candidate, candidate.scenarioId, opts.deps ?? {});
    probed.push({ ...candidate, result });
  }
  return { probed, skipped };
}

/**
 * Probe one route now, for the dashboard's "Probe now". An explicit operator
 * action, so the daily allowance and spacing do not apply — but nothing is
 * sent into a paid route, a cooldown or a closed quota domain, and nothing at
 * all while the extension is off.
 */
export async function probeRouteNow(route: RouteKey, opts: { db?: Db; deps?: RouteProbeDeps } = {}): Promise<ProbeRunOutcome> {
  if (!isExtensionEnabled(ROUTE_PROBE_EXTENSION_ID)) return { ok: false, refused: 'route bench probes are switched off in Extensions' };
  const db = opts.db ?? getDb();
  const row = db.prepare(`
    SELECT id AS modelDbId, platform, model_id AS modelId, COALESCE(endpoint_scope, '') AS endpointScope, key_id AS boundKeyId
      FROM models WHERE platform = ? AND model_id = ? AND COALESCE(endpoint_scope, '') = ?
  `).get(route.platform, route.modelId, route.endpointScope) as ProbeCandidate | undefined;
  if (!row) return { ok: false, refused: 'no such route in the catalogue' };
  if (consumesPaidBalance(row.platform as Platform, row.modelId)) return { ok: false, refused: SKIP_PAID };
  if (hasActiveCooldown(row.platform, row.modelId)) return { ok: false, refused: 'on cooldown' };
  const scenarioId = nextAgenticScenario(db, row);
  const admit = quotaDomainsAdmit(row.platform, row.modelId, row.endpointScope, estimatePromptTokens(SCENARIOS[scenarioId]) + SCENARIOS[scenarioId].maxTokens);
  if (!admit.ok) return { ok: false, refused: `quota closed (${admit.blockedBy ?? 'unknown domain'})` };
  return probeCandidate(db, row, scenarioId, opts.deps ?? {});
}

export interface ImportedBenchRun {
  benchVersion: string;
  config: { platform: string; modelId: string; endpoint?: string | null };
  results: Record<string, { status: string; score?: number | null; mode?: string; cached?: boolean; note?: string }>;
  startedAt: string;
}

const GRADED_STATUSES: Record<string, true> = { PASS: true, FAIL: true, INCONCLUSIVE: true, UNSUPPORTED: true };

/**
 * Append an imported CLI bench run to the route's history, one row per
 * scenario that ran.
 *
 * This is how the coding scenarios get a history at all: they are graded by
 * executing Python in a sandbox the container lacks, so they only ever run on
 * the host and arrive here. Scenarios answered from the CLI's cache were
 * imported with the run that produced them and are skipped, and re-importing
 * the same file adds nothing (same route, scenario and start time).
 *
 * Returns the number of rows written.
 */
export function recordBenchImport(run: ImportedBenchRun, db: Db = getDb()): number {
  const { platform, modelId } = run.config;
  // A catalogue route's scope is '' whatever base URL its key carries; only a
  // custom relay is identified by its endpoint.
  const endpointScope = platform === 'custom' ? endpointScopeForBaseUrl(run.config.endpoint) : '';
  const at = Date.parse(run.startedAt);
  if (!Number.isFinite(at)) return 0;
  const exists = db.prepare(`
    SELECT 1 FROM route_probe_result
     WHERE platform = ? AND model_id = ? AND endpoint_scope = ? AND scenario_id = ? AND source = 'import' AND probed_at_ms = ?
  `);
  const insert = db.prepare(`
    INSERT INTO route_probe_result
      (platform, model_id, endpoint_scope, key_id, scenario_id, bench_version, source, streamed,
       outcome, status, score, mode, latency_ms, ttfb_ms, prompt_tokens, completion_tokens, error, probed_at_ms)
    VALUES (?, ?, ?, NULL, ?, ?, 'import', 0, ?, ?, ?, ?, NULL, NULL, 0, 0, ?, ?)
  `);
  let written = 0;
  db.transaction(() => {
    for (const [scenarioId, r] of Object.entries(run.results)) {
      if (!(scenarioId in SCENARIOS) || !GRADED_STATUSES[r.status] || r.cached) continue;
      if (exists.get(platform, modelId, endpointScope, scenarioId, at)) continue;
      // The grader notes an endpoint that never answered as "endpoint error: …".
      const endpointError = r.status === 'INCONCLUSIVE' && r.score == null && r.note?.startsWith('endpoint error') ? r.note : null;
      insert.run(
        platform, modelId, endpointScope, scenarioId, run.benchVersion,
        endpointError ? classifyError(endpointError) : 'ok', r.status, r.score ?? null, r.mode ?? 'none',
        endpointError ? sanitizeProviderErrorMessage(endpointError).slice(0, 300) : null, at,
      );
      written++;
    }
  })();
  return written;
}

let passInFlight: Promise<ProbePassResult> | null = null;
let cancelJob: (() => void) | null = null;

function guardedPass(): Promise<ProbePassResult> {
  passInFlight ??= runRouteProbePass().finally(() => { passInFlight = null; });
  return passInFlight;
}

/** Start the scheduled probe. The extension gate is read on every tick, so
 *  switching it in Extensions takes effect on the next pass without a restart. */
export function startRouteProbe(scheduler: Scheduler): void {
  if (cancelJob) return;
  const tick = async () => {
    await guardedPass().catch(err => console.error('[RouteProbe] pass failed:', err));
  };
  const cancelFirst = scheduler.after(FIRST_PASS_DELAY_MS, tick);
  const cancelEvery = scheduler.every(ROUTE_PROBE_INTERVAL_MS, tick, { name: 'route-probe' });
  cancelJob = () => { cancelFirst(); cancelEvery(); };
}

export function stopRouteProbe(): void {
  cancelJob?.();
  cancelJob = null;
}
