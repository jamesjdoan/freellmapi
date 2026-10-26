// chain-arrange — the chain arranger: each chain's stored order, rewritten
// from evidence (ADR ARCH-20261026-chain-auto-arrange).
//
// Membership and order have different owners. The curation file and its
// applier decide WHICH routes are in a chain; this decides their ORDER, because
// with routing_strategy = priority the stored order is what decides which
// model serves. A hand-set order decays silently: routes nobody calls are
// never measured, so they keep whatever place they were given. On 2026-10-26
// Extra-Tier — the overflow of every chain — was headed by ten routes with no
// requests at all, and Coding's second route answered 37% of the time.
//
// It orders ROUTES, not models. A route is (platform, model_id,
// endpoint_scope), one `models` row. Capability scores are shared by every
// route of a model; reliability, latency, bench score and quota pool are per
// route, so a weak relay of a strong model is ranked on its own record.
//
// The ranking (`rankChain`) is pure — inputs in, an ArrangePlan out — and is
// the testing seam. Everything that reads the database or writes the order is
// around it. Per-request quota terms (scarcity, reset urgency, diversity, the
// 429 penalty) still adjust the arranged order on every request; this only
// supplies the base order they adjust.

import { z } from 'zod';
import type { Platform } from '@freellmapi/shared/types.js';
import type { Db } from '../db/types.js';
import type { Scheduler } from '../lib/scheduler.js';
import { getDb } from '../db/index.js';
import { CHAIN_CONTRACTS, type ChainName } from '../data/routing-curation.js';
import { getComparePayload, type CompareRow, type ScoreCell, type ScoreMetric } from './analysis.js';
import { getChainMinimums, type ChainMinimums, type ChainMinimumsDoc } from './chain-minimums.js';
import { renumberChain } from './chain-order.js';
import { isExtensionEnabled } from './extension-state.js';
import { inferQuotaPoolKey } from './provider-quota.js';
import { judgeMetric } from './model-bench/passport.js';
import { FAIL_BELOW, PASS_AT } from './model-bench/grade.js';
import { loadRouteEvidence, routeKeyOf, type RouteEvidence } from './route-evidence.js';

export const CHAIN_ARRANGE_EXTENSION_ID = 'chain-auto-arrange';
export const SETTING_KEY = 'imperium_chain_arrange';

const ARRANGE_INTERVAL_MS = 60 * 60_000;
const FIRST_PASS_DELAY_MS = 5 * 60_000;

// ── Settings ────────────────────────────────────────────────────────────────

const pinSchema = z.object({
  platform: z.string().min(1),
  modelId: z.string().min(1),
  endpointScope: z.string(),
  position: z.number().int().min(1),
}).strict();

const chainSettingsSchema = z.object({
  auto: z.boolean(),
  minMembers: z.number().int().min(0).max(100),
  minPools: z.number().int().min(0).max(100),
  pins: z.array(pinSchema).max(100),
}).strict();

export type ArrangeChainSettings = z.infer<typeof chainSettingsSchema>;

const CHAIN_NAMES = CHAIN_CONTRACTS.map(c => c.name) as ChainName[];

const chainsSchema = z.object(
  Object.fromEntries(CHAIN_NAMES.map(c => [c, chainSettingsSchema])) as Record<ChainName, typeof chainSettingsSchema>,
).strict();

export interface ArrangeSettingsDoc {
  version: 1;
  /** 0 = the defaults below, never saved. */
  revision: number;
  savedAt: string | null;
  tolerancePct: number;
  chains: Record<ChainName, ArrangeChainSettings>;
}

/** Approved 2026-10-26: Apex 8 across 4; the rest as suggested and accepted.
 *  Extra-Tier is the overflow and keeps no depth floor of its own. */
const DEPTH: Record<ChainName, [number, number]> = {
  Apex: [8, 4], Coding: [8, 4], Default: [8, 4], 'Fast-Lane': [6, 3], Vision: [4, 2], 'Extra-Tier': [0, 0],
};
export const DEFAULT_TOLERANCE_PCT = 10;

function defaultChains(): Record<ChainName, ArrangeChainSettings> {
  const chains = {} as Record<ChainName, ArrangeChainSettings>;
  for (const c of CHAIN_NAMES) chains[c] = { auto: true, minMembers: DEPTH[c][0], minPools: DEPTH[c][1], pins: [] };
  return chains;
}

export const saveArrangeSchema = z.object({
  expectedRevision: z.number().int().min(0),
  tolerancePct: z.number().min(0).max(50),
  chains: chainsSchema,
}).strict();

export class ArrangeRevisionConflict extends Error {
  constructor(readonly current: number) { super(`Auto-arrange settings were saved elsewhere (now revision ${current})`); }
}

export function getArrangeSettings(db: Db = getDb()): ArrangeSettingsDoc {
  const fresh: ArrangeSettingsDoc = { version: 1, revision: 0, savedAt: null, tolerancePct: DEFAULT_TOLERANCE_PCT, chains: defaultChains() };
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(SETTING_KEY) as { value: string } | undefined;
  if (!row) return fresh;
  try {
    const stored = JSON.parse(row.value) as Partial<ArrangeSettingsDoc>;
    // A chain the document predates takes its defaults; a stored chain that
    // no longer exists is dropped rather than invalidating the rest.
    const merged = { ...fresh.chains };
    for (const chain of CHAIN_NAMES) {
      const parsed = chainSettingsSchema.safeParse(stored.chains?.[chain]);
      if (parsed.success) merged[chain] = parsed.data;
    }
    const tolerance = typeof stored.tolerancePct === 'number' && stored.tolerancePct >= 0 && stored.tolerancePct <= 50 ? stored.tolerancePct : DEFAULT_TOLERANCE_PCT;
    return {
      version: 1,
      revision: Number.isInteger(stored.revision) ? stored.revision! : 0,
      savedAt: stored.savedAt ?? null,
      tolerancePct: tolerance,
      chains: merged,
    };
  } catch {
    console.warn(`[chain-arrange] ${SETTING_KEY} is unreadable; using defaults until the next save`);
    return fresh;
  }
}

export function saveArrangeSettings(db: Db, input: z.infer<typeof saveArrangeSchema>): ArrangeSettingsDoc {
  return db.transaction(() => {
    const current = getArrangeSettings(db);
    if (current.revision !== input.expectedRevision) throw new ArrangeRevisionConflict(current.revision);
    const next: ArrangeSettingsDoc = {
      version: 1,
      revision: current.revision + 1,
      savedAt: new Date().toISOString(),
      tolerancePct: input.tolerancePct,
      chains: input.chains as Record<ChainName, ArrangeChainSettings>,
    };
    db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
      .run(SETTING_KEY, JSON.stringify(next));
    return next;
  })();
}

/** Whether the arranger owns this chain's order right now. The curation
 *  applier asks before writing a priority, so the two never fight. */
export function isChainOrderManaged(chain: string, db: Db = getDb()): boolean {
  if (!isExtensionEnabled(CHAIN_ARRANGE_EXTENSION_ID)) return false;
  const settings = getArrangeSettings(db).chains[chain as ChainName];
  return settings?.auto === true;
}

/**
 * Pin one chain member at a position, replacing any pin it already had.
 * Called when an operator moves a route by hand in a chain the arranger owns:
 * the move is the override, and without a pin the next pass would undo it.
 * Returns false when the chain or model is unknown.
 */
export function pinRoute(db: Db, chain: string, modelDbId: number, position: number): boolean {
  if (!isChainName(chain)) return false;
  const route = db.prepare(`
    SELECT platform, model_id AS modelId, COALESCE(endpoint_scope, '') AS endpointScope FROM models WHERE id = ?
  `).get(modelDbId) as { platform: string; modelId: string; endpointScope: string } | undefined;
  if (!route) return false;
  const current = getArrangeSettings(db);
  const settings = current.chains[chain];
  const pins = settings.pins.filter(p => !(p.platform === route.platform && p.modelId === route.modelId && p.endpointScope === route.endpointScope));
  pins.push({ ...route, position });
  saveArrangeSettings(db, {
    expectedRevision: current.revision,
    tolerancePct: current.tolerancePct,
    chains: { ...current.chains, [chain]: { ...settings, pins } },
  });
  return true;
}

// ── Ranking (pure) ──────────────────────────────────────────────────────────

export interface RouteRef { modelDbId: number; platform: string; modelId: string; endpointScope: string }

export type Eligibility = 'fit' | 'near' | 'filler' | 'out';
export type Tier = 'proven' | 'partial' | 'unmeasured' | 'failing';

export interface ArrangeEntry extends RouteRef {
  position: number;
  from: number;
  displayName: string;
  eligibility: Eligibility;
  tier: Tier;
  pinned: boolean;
  pool: string;
  metric: { name: 'intelligence' | 'coding' | 'latency' | 'reliability'; value: number | null };
  reliability: { n: number; ok: number; lowerBound: number };
  reasons: string[];
}

export interface ArrangePlan {
  chain: ChainName;
  auto: boolean;
  computedAtMs: number;
  changed: boolean;
  before: RouteRef[];
  entries: ArrangeEntry[];
  depth: { required: number; requiredPools: number; eligible: number; pools: number; satisfied: boolean };
}

export interface ArrangeMember {
  route: RouteRef;
  displayName: string;
  /** 1-based position in the current stored order. */
  from: number;
  scores: Record<ScoreMetric, ScoreCell> | null;
  supportsTools: boolean;
  supportsVision: boolean;
  hasKey: boolean;
  evidence: RouteEvidence | null;
  pool: string;
}

export interface ArrangeInput {
  chain: ChainName;
  members: ArrangeMember[];
  minimums: ChainMinimums | null;
  requiresTools: boolean;
  requiresVision: boolean;
  settings: ArrangeChainSettings;
  tolerancePct: number;
  computedAtMs: number;
}

/** Chains whose members must call tools, where a failing agentic screen
 *  disqualifies a route. */
const TOOL_CHAINS: readonly ChainName[] = ['Apex', 'Coding', 'Default', 'Fast-Lane'];
const METRIC_OF = { general: 'intelligence', coding: 'coding', agentic: 'agentic' } as const;
const BAND: Record<Eligibility, number> = { fit: 0, near: 1, filler: 1, out: 2 };
const TIER_RANK: Record<Tier, number> = { proven: 0, partial: 1, unmeasured: 2, failing: 3 };

/** Wilson score interval, lower bound at 95%: a success rate discounted for
 *  how few samples carry it, so 3/3 does not outrank 900/1000. */
export function wilsonLowerBound(ok: number, n: number): number {
  if (n === 0) return 0;
  const z = 1.96;
  const p = ok / n;
  const z2n = (z * z) / n;
  return (p + z2n / 2 - z * Math.sqrt((p * (1 - p)) / n + z2n / (4 * n))) / (1 + z2n);
}

const pct = (ok: number, n: number) => `${Math.round((ok / n) * 100)}%`;

interface Scored {
  member: ArrangeMember;
  n: number;
  ok: number;
  lb: number;
  tier: Tier;
  eligibility: Eligibility;
  metric: ArrangeEntry['metric'];
  reasons: string[];
}

function screenVerdict(screen: { mean: number | null; graded: number } | undefined): 'pass' | 'below' | 'unknown' {
  if (!screen || screen.graded === 0 || screen.mean == null) return 'unknown';
  if (screen.mean >= PASS_AT) return 'pass';
  return screen.mean < FAIL_BELOW ? 'below' : 'unknown';
}

/** Eligibility against the chain's minimums, widened by the tolerance band.
 *  A published score nobody has measured defers to the route's own screen;
 *  failing that it is unknown, and unknown is not zero: it is near, not out. */
function eligibilityOf(m: ArrangeMember, mins: ChainMinimums | null, tolerancePct: number): { eligibility: Eligibility; reasons: string[] } {
  if (!mins) return { eligibility: 'fit', reasons: [] };
  const either = new Set(mins.either ?? []);
  const required: Array<'pass' | 'near' | 'below' | 'unknown'> = [];
  const group: Array<'pass' | 'near' | 'below' | 'unknown'> = [];
  const reasons: string[] = [];
  const empty: ScoreCell = { value: null, provenance: null, entry: null, editable: true };
  for (const key of ['general', 'coding', 'agentic'] as const) {
    const min = mins[key];
    if (min == null) continue;
    const verdict = judgeMetric(key, m.scores?.[METRIC_OF[key]] ?? empty, min, { tolerancePct, acceptEstimated: mins.acceptEstimated });
    let result = verdict.result;
    let reason = verdict.reason;
    if (result === 'unknown' && key !== 'general') {
      const screen = m.evidence?.screen[key];
      const s = screenVerdict(screen);
      if (s !== 'unknown') {
        result = s;
        reason = `${key}: no usable published score; route's own ${key} screen ${screen!.mean} over ${screen!.graded} graded`;
      }
    }
    reasons.push(reason);
    (either.has(key) ? group : required).push(result);
  }
  let eligibility: Eligibility = 'fit';
  if (required.includes('below')) eligibility = 'out';
  else if (required.includes('near') || required.includes('unknown')) eligibility = 'near';
  if (group.length > 0 && eligibility !== 'out' && !group.includes('pass')) {
    eligibility = group.includes('near') || group.includes('unknown') ? 'near' : 'out';
  }
  return { eligibility, reasons };
}

function score(input: ArrangeInput, m: ArrangeMember): Scored {
  const e = m.evidence;
  const n = (e?.real.n ?? 0) + (e?.probe.n ?? 0);
  const ok = (e?.real.ok ?? 0) + (e?.probe.ok ?? 0);
  const lb = wilsonLowerBound(ok, n);
  let tier: Tier = n === 0 ? 'unmeasured'
    : n >= 20 && ok / n < 0.55 ? 'failing'
    : n >= 50 && ok / n >= 0.8 ? 'proven' : 'partial';
  const reasons: string[] = [n === 0
    ? 'reliability: no real traffic or probes in 14 days (unmeasured)'
    : `reliability: ${pct(ok, n)} over ${n} (${e!.real.n} real, ${e!.probe.n} probe) → ${tier}`];

  // Per-route vetoes: a route that cannot do this chain's job goes to the
  // tail whatever its model's scores say.
  const vetoes: string[] = [];
  if (!m.hasKey) vetoes.push('no usable key can serve it');
  if (input.requiresTools && !m.supportsTools) vetoes.push('chain needs tools; catalogue says no tool support');
  if (input.requiresTools && e?.screen.nativeToolsUnsupported) vetoes.push('chain needs tools; newest probe found native tools refused');
  if (input.requiresVision && !m.supportsVision) vetoes.push('chain needs vision; no image input');
  const agentic = e?.screen.agentic;
  if (TOOL_CHAINS.includes(input.chain) && agentic && agentic.graded >= 2 && agentic.mean != null && agentic.mean < FAIL_BELOW) {
    vetoes.push(`agentic screen ${agentic.mean} over ${agentic.graded} graded is a fail`);
  }
  const coding = e?.screen.coding;
  if (input.chain === 'Coding' && coding && coding.graded >= 2 && coding.mean != null && coding.mean < FAIL_BELOW) {
    vetoes.push(`coding screen ${coding.mean} over ${coding.graded} graded is a fail`);
  }
  if (vetoes.length > 0) {
    tier = 'failing';
    reasons.push(...vetoes.map(v => `veto: ${v}`));
  }

  const { eligibility, reasons: why } = eligibilityOf(m, input.minimums, input.tolerancePct);
  reasons.push(...why);

  const metric: ArrangeEntry['metric'] =
    input.chain === 'Apex' ? { name: 'intelligence', value: m.scores?.intelligence.value ?? null }
    : input.chain === 'Coding' ? { name: 'coding', value: m.scores?.coding.value ?? null }
    : input.chain === 'Fast-Lane' ? { name: 'latency', value: e?.real.avgOkLatencyMs ?? e?.probe.avgOkLatencyMs ?? null }
    : { name: 'reliability', value: n === 0 ? null : Math.round(lb * 1000) / 10 };
  return { member: m, n, ok, lb, tier, eligibility, metric, reasons };
}

/** Within a band and tier: the chain's own measure of value. Nulls sort
 *  after numbers; ties fall to reliability, then capability, then id. */
function compareMetric(chain: ChainName, a: Scored, b: Scored): number {
  const nullsLast = (x: number | null, y: number | null, dir: 1 | -1) =>
    x == null && y == null ? 0 : x == null ? 1 : y == null ? -1 : dir * (x - y);
  const intelligence = (s: Scored) => s.member.scores?.intelligence.value ?? null;
  let c = 0;
  if (chain === 'Apex') c = nullsLast(a.metric.value, b.metric.value, -1);
  else if (chain === 'Coding') c = nullsLast(a.metric.value, b.metric.value, -1) || nullsLast(intelligence(a), intelligence(b), -1);
  else if (chain === 'Fast-Lane') c = nullsLast(a.metric.value, b.metric.value, 1);
  return c || b.lb - a.lb || nullsLast(intelligence(a), intelligence(b), -1) || a.member.route.modelDbId - b.member.route.modelDbId;
}

function sortScored(chain: ChainName, list: Scored[]): Scored[] {
  return [...list].sort((a, b) =>
    Number(a.tier === 'failing') - Number(b.tier === 'failing')
    || BAND[a.eligibility] - BAND[b.eligibility]
    || TIER_RANK[a.tier] - TIER_RANK[b.tier]
    || compareMetric(chain, a, b));
}

const samePin = (p: { platform: string; modelId: string; endpointScope: string }, r: RouteRef) =>
  p.platform === r.platform && p.modelId === r.modelId && p.endpointScope === r.endpointScope;

/** Rank one chain. Pure: no database, no clock. */
export function rankChain(input: ArrangeInput): ArrangePlan {
  const { chain, settings } = input;
  let ordered = sortScored(chain, input.members.map(m => score(input, m)));

  // Minimum depth: an 'out' route is promoted to filler, best first, until the
  // chain has minMembers routes above the failing tail it considers eligible.
  const eligibleCount = () => ordered.filter(s => s.tier !== 'failing' && s.eligibility !== 'out').length;
  for (const s of ordered) {
    if (eligibleCount() >= settings.minMembers) break;
    if (s.tier === 'failing' || s.eligibility !== 'out') continue;
    s.eligibility = 'filler';
    s.reasons.push(`filler: below the minimums but kept above 'out' so the chain holds ${settings.minMembers} eligible routes`);
  }
  ordered = sortScored(chain, ordered);

  // Pool spread across the head. The first two never share a pool when there
  // is an alternative, and the first minMembers span at least minPools.
  const live = ordered.filter(s => s.tier !== 'failing');
  const tail = ordered.filter(s => s.tier === 'failing');
  const pullForward = (i: number, used: Set<string>) => {
    const j = live.findIndex((s, k) => k > i && !used.has(s.member.pool));
    if (j === -1) return;
    const [moved] = live.splice(j, 1);
    moved.reasons.push(`moved up for quota-pool spread: ${moved.member.pool} is not yet in the head`);
    live.splice(i, 0, moved);
  };
  if (settings.minPools >= 2 && live.length > 2 && live[0].member.pool === live[1].member.pool) {
    pullForward(1, new Set([live[0].member.pool]));
  }
  const used = new Set<string>();
  const head = Math.min(settings.minMembers, live.length);
  for (let i = 0; i < head; i++) {
    const slotsLeft = head - i;
    if (settings.minPools - used.size >= slotsLeft && used.has(live[i].member.pool)) pullForward(i, used);
    used.add(live[i].member.pool);
  }
  ordered = [...live, ...tail];

  // Pins last, so they always win. A pin for a route that is not a member is
  // ignored, not an error: the operator may have pinned before removing it.
  const pinned = new Map<Scored, number>();
  for (const pin of [...settings.pins].sort((a, b) => a.position - b.position)) {
    const s = ordered.find(x => samePin(pin, x.member.route));
    if (s) pinned.set(s, pin.position);
  }
  const unpinned = ordered.filter(s => !pinned.has(s));
  const final = [...unpinned];
  for (const [s, position] of [...pinned].sort((a, b) => a[1] - b[1])) {
    const at = Math.min(Math.max(position, 1), final.length + 1) - 1;
    final.splice(at, 0, s);
    s.reasons.push(`pinned at ${position} by the operator`);
  }

  const entries: ArrangeEntry[] = final.map((s, i) => ({
    ...s.member.route,
    position: i + 1,
    from: s.member.from,
    displayName: s.member.displayName,
    eligibility: s.eligibility,
    tier: s.tier,
    pinned: pinned.has(s),
    pool: s.member.pool,
    metric: s.metric,
    reliability: { n: s.n, ok: s.ok, lowerBound: Math.round(s.lb * 1000) / 1000 },
    reasons: s.reasons,
  }));

  const before = [...input.members].sort((a, b) => a.from - b.from).map(m => m.route);
  const eligible = entries.filter(e => e.tier !== 'failing' && e.eligibility !== 'out').length;
  const headPools = new Set(entries.filter(e => e.tier !== 'failing').slice(0, settings.minMembers).map(e => e.pool)).size;
  return {
    chain,
    auto: settings.auto,
    computedAtMs: input.computedAtMs,
    changed: entries.some((e, i) => before[i]?.modelDbId !== e.modelDbId),
    before,
    entries,
    depth: {
      required: settings.minMembers,
      requiredPools: settings.minPools,
      eligible,
      pools: headPools,
      satisfied: eligible >= settings.minMembers && headPools >= Math.min(settings.minPools, settings.minMembers),
    },
  };
}

// ── Reading inputs, writing the order ───────────────────────────────────────

interface Context {
  db: Db;
  now: number;
  settings: ArrangeSettingsDoc;
  compare: Map<number, CompareRow>;
  evidence: Map<string, RouteEvidence>;
  minimums: ChainMinimumsDoc['chains'];
}

function context(db: Db, now: number): Context {
  return {
    db,
    now,
    settings: getArrangeSettings(db),
    compare: new Map(getComparePayload(db).rows.map(r => [r.modelDbId, r])),
    evidence: loadRouteEvidence(db, { now }),
    minimums: getChainMinimums(db).chains,
  };
}

function profileIdOf(db: Db, chain: string): number | null {
  const row = db.prepare('SELECT id FROM profiles WHERE name = ?').get(chain) as { id: number } | undefined;
  return row?.id ?? null;
}

function inputFor(ctx: Context, chain: ChainName, profileId: number): ArrangeInput {
  const rows = ctx.db.prepare(`
    SELECT pm.model_db_id AS modelDbId, m.platform, m.model_id AS modelId, COALESCE(m.endpoint_scope, '') AS endpointScope,
           m.display_name AS displayName, m.supports_tools AS supportsTools, m.supports_vision AS supportsVision
      FROM profile_models pm JOIN models m ON m.id = pm.model_db_id
     WHERE pm.profile_id = ? AND pm.enabled = 1
     ORDER BY pm.priority, pm.model_db_id
  `).all(profileId) as Array<RouteRef & { displayName: string; supportsTools: number; supportsVision: number }>;
  const contract = CHAIN_CONTRACTS.find(c => c.name === chain);
  return {
    chain,
    members: rows.map((r, i) => {
      const route: RouteRef = { modelDbId: r.modelDbId, platform: r.platform, modelId: r.modelId, endpointScope: r.endpointScope };
      const compare = ctx.compare.get(r.modelDbId);
      return {
        route,
        displayName: compare?.displayName ?? r.displayName,
        from: i + 1,
        scores: compare?.scores ?? null,
        supportsTools: compare?.supportsTools ?? r.supportsTools === 1,
        supportsVision: compare?.supportsVision ?? r.supportsVision === 1,
        hasKey: compare?.hasKey ?? true,
        evidence: ctx.evidence.get(routeKeyOf(route)) ?? null,
        pool: inferQuotaPoolKey(r.platform as Platform, r.modelId, r.endpointScope || null),
      };
    }),
    minimums: ctx.minimums[chain] ?? null,
    requiresTools: contract?.requiresTools ?? false,
    requiresVision: contract?.requiresVision ?? false,
    settings: ctx.settings.chains[chain],
    tolerancePct: ctx.settings.tolerancePct,
    computedAtMs: ctx.now,
  };
}

function isChainName(chain: string): chain is ChainName {
  return (CHAIN_NAMES as string[]).includes(chain);
}

/** What the arranger would write for one chain, without writing it. */
export function planChainArrangement(chain: string, db: Db = getDb(), now = Date.now()): ArrangePlan | null {
  if (!isChainName(chain)) return null;
  const profileId = profileIdOf(db, chain);
  if (profileId == null) return null;
  return rankChain(inputFor(context(db, now), chain, profileId));
}

export interface ApplyResult { plan: ArrangePlan; runId: number | null; changed: boolean }

function applyWith(ctx: Context, chain: ChainName, trigger: 'schedule' | 'manual'): ApplyResult | null {
  const profileId = profileIdOf(ctx.db, chain);
  if (profileId == null) return null;
  const plan = rankChain(inputFor(ctx, chain, profileId));
  if (!plan.changed) return { plan, runId: null, changed: false };
  const ref = ({ modelDbId, platform, modelId, endpointScope }: RouteRef): RouteRef => ({ modelDbId, platform, modelId, endpointScope });
  let runId: number | null = null;
  ctx.db.transaction(() => {
    renumberChain(ctx.db, profileId, plan.entries.map(e => e.modelDbId));
    runId = Number(ctx.db.prepare(`
      INSERT INTO chain_arrange_run (chain, ran_at_ms, trigger, settings_revision, before_json, after_json, moves_json)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(chain, ctx.now, trigger, ctx.settings.revision, JSON.stringify(plan.before), JSON.stringify(plan.entries.map(ref)), JSON.stringify(plan.entries)).lastInsertRowid);
  })();
  return { plan, runId, changed: true };
}

/** Rank one chain and write the order when it changed: renumber and a run
 *  record in one transaction. */
export function applyChainArrangement(chain: string, trigger: 'schedule' | 'manual', db: Db = getDb(), now = Date.now()): ApplyResult | null {
  if (!isChainName(chain)) return null;
  return applyWith(context(db, now), chain, trigger);
}

/** One scheduled pass over every chain whose order the arranger owns. */
export function runChainArrangePass(db: Db = getDb(), now = Date.now()): ApplyResult[] {
  if (!isExtensionEnabled(CHAIN_ARRANGE_EXTENSION_ID)) return [];
  const ctx = context(db, now);
  const results: ApplyResult[] = [];
  for (const chain of CHAIN_NAMES) {
    if (!ctx.settings.chains[chain].auto) continue;
    try {
      const result = applyWith(ctx, chain, 'schedule');
      if (result) results.push(result);
      if (result?.changed) console.log(`[ChainArrange] ${chain}: ${result.plan.entries.filter(e => e.from !== e.position).length} routes moved (run ${result.runId})`);
    } catch (err) {
      console.error(`[ChainArrange] ${chain} failed:`, err);
    }
  }
  return results;
}

let passRunning = false;
let cancelJob: (() => void) | null = null;

/** Start the hourly arranger. The Extensions gate and each chain's auto flag
 *  are read on every tick, so switching either takes effect on the next pass. */
export function startChainArrange(scheduler: Scheduler): void {
  if (cancelJob) return;
  const tick = () => {
    if (passRunning) return;
    passRunning = true;
    try { runChainArrangePass(); } finally { passRunning = false; }
  };
  const cancelFirst = scheduler.after(FIRST_PASS_DELAY_MS, tick);
  const cancelEvery = scheduler.every(ARRANGE_INTERVAL_MS, tick, { name: 'chain-arrange' });
  cancelJob = () => { cancelFirst(); cancelEvery(); };
}

export function stopChainArrange(): void {
  cancelJob?.();
  cancelJob = null;
}

// ── Run history ─────────────────────────────────────────────────────────────

export interface RunSummary { id: number; chain: ChainName; ranAtMs: number; trigger: 'schedule' | 'manual'; moved: number }
export interface RunDetail extends RunSummary { settingsRevision: number; before: RouteRef[]; after: RouteRef[]; entries: ArrangeEntry[] }

interface RunRow { id: number; chain: ChainName; ran_at_ms: number; trigger: 'schedule' | 'manual'; settings_revision: number; before_json: string; after_json: string; moves_json: string }

function detailOf(r: RunRow): RunDetail {
  const entries = JSON.parse(r.moves_json) as ArrangeEntry[];
  return {
    id: r.id, chain: r.chain, ranAtMs: r.ran_at_ms, trigger: r.trigger,
    moved: entries.filter(e => e.from !== e.position).length,
    settingsRevision: r.settings_revision,
    before: JSON.parse(r.before_json) as RouteRef[],
    after: JSON.parse(r.after_json) as RouteRef[],
    entries,
  };
}

export function listArrangeRuns(db: Db = getDb(), chain?: string, limit = 20): RunSummary[] {
  const rows = db.prepare(`
    SELECT * FROM chain_arrange_run ${chain ? 'WHERE chain = ?' : ''} ORDER BY ran_at_ms DESC, id DESC LIMIT ?
  `).all(...(chain ? [chain, limit] : [limit])) as RunRow[];
  return rows.map(r => {
    const { settingsRevision: _r, before: _b, after: _a, entries: _e, ...summary } = detailOf(r);
    return summary;
  });
}

export function getArrangeRun(id: number, db: Db = getDb()): RunDetail | null {
  const row = db.prepare('SELECT * FROM chain_arrange_run WHERE id = ?').get(id) as RunRow | undefined;
  return row ? detailOf(row) : null;
}

export function arrangeOverview(db: Db = getDb()) {
  const settings = getArrangeSettings(db);
  return {
    settings,
    chains: CHAIN_NAMES.map(chain => ({ chain, auto: settings.chains[chain].auto, lastRun: listArrangeRuns(db, chain, 1)[0] ?? null })),
  };
}
