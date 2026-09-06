import { getDb, getSetting, setSetting } from '../db/index.js';
import type { Db } from '../db/types.js';
import { normalizeGroupKey } from './model-groups.js';
import { resolveEffectiveQuotas, type EffectiveQuota } from './quota-policy.js';
import { quotaPacing } from './quota-clock.js';

// Quota-aware provider selection, in shadow (ADR ARCH-20260905, W3).
//
// Layering, kept deliberately separate: the existing bandit decides WHICH
// LOGICAL MODEL to serve. This decides, among the providers serving THAT model,
// which one should spend its quota. Mixing the two would let a quota signal
// silently substitute a weaker model, which is not what quota awareness is for.
//
// In shadow mode the answer is recorded and thrown away. It cannot alter
// selection: the incumbent's choice is passed in already made, and the only
// side effect here is one insert.
//
// Every entry point is failure-swallowing on purpose. Quota awareness is an
// enhancement; if the policy table is missing, the clock throws, or the
// database is mid-restore, routing must continue exactly as it did before.

export type QuotaRoutingMode = 'off' | 'shadow' | 'active';

const QUOTA_ROUTING_MODE_KEY = 'quota_routing_mode';
const VALID_MODES: readonly QuotaRoutingMode[] = ['off', 'shadow', 'active'];

/**
 * Shadow by default, never active. Recording what a change WOULD do is safe;
 * making the change is a decision the operator has to take deliberately, and a
 * default that silently rerouted traffic on upgrade would be exactly the
 * "silently replace existing routing" failure this design exists to avoid.
 */
export const DEFAULT_QUOTA_ROUTING_MODE: QuotaRoutingMode = 'shadow';

export function getQuotaRoutingMode(): QuotaRoutingMode {
  try {
    const raw = getSetting(QUOTA_ROUTING_MODE_KEY);
    return VALID_MODES.includes(raw as QuotaRoutingMode)
      ? (raw as QuotaRoutingMode)
      : DEFAULT_QUOTA_ROUTING_MODE;
  } catch {
    return DEFAULT_QUOTA_ROUTING_MODE;
  }
}

export function setQuotaRoutingMode(mode: QuotaRoutingMode): void {
  if (!VALID_MODES.includes(mode)) throw new Error(`Unknown quota routing mode: ${mode}`);
  setSetting(QUOTA_ROUTING_MODE_KEY, mode);
}


// ── Reservation weights (scarcity, ADR W3) ──────────────────────────────────
// A multiplier per platform, 0..1, where lower means "hold this pool back".
// Deliberately EMPTY by default: shipping weights would bake a routing opinion
// into the code, and the brief's own numbers ("OpenRouter: high scarcity") are
// initial assumptions about one account, not facts about the provider. The
// operator declares them; the recommended starting point is documented rather
// than defaulted.
const RESERVATION_WEIGHTS_KEY = 'quota_reservation_weights';

export function getReservationWeights(): Record<string, number> {
  try {
    const raw = getSetting(RESERVATION_WEIGHTS_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const out: Record<string, number> = {};
    for (const [platform, weight] of Object.entries(parsed as Record<string, unknown>)) {
      // A corrupt entry is skipped rather than defaulting to 0, which would
      // silently bench a provider instead of leaving it unweighted.
      if (typeof weight === 'number' && Number.isFinite(weight) && weight >= 0 && weight <= 1) {
        out[platform.toLowerCase()] = weight;
      }
    }
    return out;
  } catch {
    return {};
  }
}

export function setReservationWeights(weights: Record<string, number>): Record<string, number> {
  const clean: Record<string, number> = {};
  for (const [platform, weight] of Object.entries(weights)) {
    if (!Number.isFinite(weight) || weight < 0 || weight > 1) {
      throw new Error(`Reservation weight for ${platform} must be between 0 and 1`);
    }
    clean[platform.trim().toLowerCase()] = weight;
  }
  setSetting(RESERVATION_WEIGHTS_KEY, JSON.stringify(clean));
  return clean;
}
/** One provider that could serve the logical model under consideration. */
export interface QuotaCandidate {
  platform: string;
  modelId: string;
  displayName: string;
  /** '' for a catalog platform, 'custom:<hash>' for a relay. For a relay model
   *  the platform is always 'custom', so this is what actually names the
   *  provider — without it two endpoints serving one model id are one row. */
  endpointScope?: string;
}

export interface ScoredCandidate {
  platform: string;
  modelId: string;
  endpointScope?: string;
  /** 0..1, higher is a better place to spend. Null when no quota is known —
   *  distinct from 0, which means "known and exhausted". */
  score: number | null;
  /** The binding axis's remaining fraction, for the operator-facing reason. */
  headroom: number | null;
  /** usage% - elapsed%: negative means the allowance is going unspent. */
  paceDelta: number | null;
}

export interface ShadowDecision {
  logicalModel: string;
  candidates: ScoredCandidate[];
  /** Null when scoring had no opinion — one candidate, or no quota signal. */
  preferred: { platform: string; modelId: string; endpointScope?: string } | null;
  reason: string;
}

/**
 * How attractive a provider is to spend on, 0..1, from the axis closest to
 * binding. Deliberately NOT a blend of many terms with tuned constants: with no
 * shadow data yet, an elaborate formula would be false precision. Headroom on
 * the worst axis is the one signal we can currently defend, and pacing is
 * reported alongside so the weighting question can be answered from recorded
 * data rather than guessed at now.
 */
/**
 * An unmetered provider is not an unrankable one. The same value and the same
 * reasoning as `UNKNOWN_QUOTA_HEADROOM` in the router (#919): an unobserved
 * budget is no reason to prefer a provider (it could be drained) and no reason
 * to avoid one (it could be untouched), so it sorts between an exhausted
 * provider and a fresh one.
 *
 * Treating it as "no opinion" instead — which this did until an end-to-end run
 * showed it — meant the ONLY candidate with a signal won by default, so a
 * provider at 10% of a 50-request pool beat one with no known cap at all. That
 * is precisely the "burn the last five OpenRouter requests" outcome the design
 * exists to prevent.
 */
export const UNKNOWN_HEADROOM = 0.5;

export function scoreQuotaCandidate(
  quotas: EffectiveQuota[],
  used: (q: EffectiveQuota) => number | null,
  now: number,
  reservationWeight = 1,
): Pick<ScoredCandidate, 'score' | 'headroom' | 'paceDelta'> {
  let worstHeadroom: number | null = null;
  let bindingPace: number | null = null;
  for (const quota of quotas) {
    // A provider that reported its own remaining beats any local count, and is
    // often the ONLY usable figure: a provider_reported window has no period
    // start, so there is no span to count usage over. Skipping those meant the
    // highest-confidence source we have was ignored entirely.
    // Provider-measured first, then a figure the policy computed itself (a pool
    // shared across differently-priced models cannot be read off one counter),
    // then the generic per-subject count.
    const consumed = quota.reportedRemaining != null
      ? quota.limit - quota.reportedRemaining
      : quota.derivedUsed != null
        ? quota.derivedUsed
        : used(quota);
    if (consumed == null || quota.limit <= 0) continue;
    const headroom = Math.max(0, Math.min(1, 1 - consumed / quota.limit));
    if (worstHeadroom == null || headroom < worstHeadroom) {
      worstHeadroom = headroom;
      bindingPace = quotaPacing(quota.window, now, consumed, quota.limit).paceDelta;
    }
  }

  const headroom = worstHeadroom ?? UNKNOWN_HEADROOM;
  // Reservation weight separates two pools that look identical as fractions:
  // half of OpenRouter's 50/day and half of a 1000/day pool are both 0.5, and
  // spending the first is far more costly. The operator declares which pools
  // to hold back; inferring it from absolute counts would conflate requests
  // with tokens and bake in a constant nobody chose.
  return {
    score: headroom * reservationWeight,
    headroom: worstHeadroom,
    paceDelta: bindingPace,
  };
}

/** Operator-readable justification. Says which of the three things decided it:
 *  measured headroom, an absent limit, or the pool being held back. */
function describePreference(best: ScoredCandidate, weight: number): string {
  if (best.headroom == null) {
    return 'no published limit — treated as neutral, not as unlimited';
  }
  const pct = `${(best.headroom * 100).toFixed(0)}%`;
  const held = weight < 1 ? ` (reservation weight ${weight})` : '';
  return best.paceDelta != null && best.paceDelta < -0.2
    ? `most headroom (${pct}) and behind pace — allowance on course to expire unused${held}`
    : `most headroom (${pct}) on its binding axis${held}`;
}

/**
 * Is this provider/model actually serving right now?
 *
 * Quota headroom says nothing about whether a route works. NVIDIA's
 * openai/gpt-oss-120b served 415 requests, then returned
 * "410: reached its end of life" on every attempt afterwards — and because its
 * allowance was consequently untouched, headroom scoring rated it a perfect 1.0
 * and shadow recommended it 8 times out of 8 while the live router had already
 * routed around it.
 *
 * Deliberately a GATE and not a reliability score. The incumbent router already
 * owns reliability ranking with its own decay-weighted stats and weights; a
 * second, differently-shaped reliability model here would duplicate it and
 * could disagree with it. What quota-aware selection needs is narrower: choose
 * between providers that are VIABLE, and a route returning nothing but errors
 * is not one.
 */
const LIVENESS_WINDOW_MS = 30 * 60_000;
/** Below this, "no successes" is a quiet period rather than evidence of death. */
const LIVENESS_MIN_FAILURES = 3;
const LIVENESS_TTL_MS = 30_000;

interface LivenessEntry { at: number; serving: boolean }
const livenessCache = new Map<string, LivenessEntry>();

function isServing(platform: string, modelId: string, now: number): boolean {
  const cacheKey = `${platform}:${modelId}`;
  const hit = livenessCache.get(cacheKey);
  if (hit && now - hit.at < LIVENESS_TTL_MS) return hit.serving;

  let serving = true;
  try {
    const since = new Date(now - LIVENESS_WINDOW_MS).toISOString().replace('T', ' ').replace('Z', '');
    const row = getDb().prepare(`
      SELECT SUM(status = 'success') AS ok, SUM(status = 'error') AS bad
        FROM requests
       WHERE platform = ? AND model_id = ? AND created_at >= ?
         AND request_type <> 'burn_test'
    `).get(platform, modelId, since) as { ok: number | null; bad: number | null };
    const ok = row?.ok ?? 0;
    const bad = row?.bad ?? 0;
    // Silence is not evidence: a model nobody has called is unknown, not dead,
    // and gating it would quietly exclude every provider during a quiet spell.
    serving = ok > 0 || bad < LIVENESS_MIN_FAILURES;
  } catch {
    // No signal is not a reason to exclude a candidate.
    serving = true;
  }
  livenessCache.set(cacheKey, { at: now, serving });
  return serving;
}

/** Test seam: drop the memoised liveness reads. */
export function invalidateLiveness(): void {
  livenessCache.clear();
}

/**
 * Which provider quota-aware scoring would prefer among candidates serving one
 * logical model. Pure apart from the quota reads; makes no routing change.
 */
export function evaluateShadowDecision(
  candidates: QuotaCandidate[],
  usedFor: (platform: string, modelId: string, quota: EffectiveQuota) => number | null,
  now: number = Date.now(),
): ShadowDecision | null {
  if (candidates.length < 2) return null; // Nothing to choose between.

  const logicalModel = normalizeGroupKey(candidates[0]!.displayName);
  const weights = getReservationWeights();

  // Viability before economy. A route that is only producing errors must not be
  // preferred for having an untouched allowance.
  const viable = candidates.filter(candidate => isServing(candidate.platform, candidate.modelId, now));
  if (viable.length === 0) {
    // Nothing here is serving. Naming a favourite among dead routes is exactly
    // the failure this gate exists to prevent, so decline to have an opinion.
    return null;
  }

  const scored: ScoredCandidate[] = viable.map(candidate => {
    const quotas = resolveEffectiveQuotas(candidate.platform, candidate.modelId, now, candidate.endpointScope ?? null);
    const { score, headroom, paceDelta } = scoreQuotaCandidate(
      quotas,
      quota => usedFor(candidate.platform, candidate.modelId, quota),
      now,
      weights[candidate.platform.toLowerCase()] ?? 1,
    );
    return { platform: candidate.platform, modelId: candidate.modelId, endpointScope: candidate.endpointScope, score, headroom, paceDelta };
  });

  // Every candidate now scores: an unmetered one takes UNKNOWN_HEADROOM rather
  // than dropping out, so the only remaining null case is an empty list.
  const withOpinion = scored.filter(c => c.score != null);
  if (withOpinion.length === 0) {
    return { logicalModel, candidates: scored, preferred: null, reason: 'no quota signal for any candidate' };
  }

  const best = withOpinion.reduce((a, b) => (b.score! > a.score! ? b : a));
  const reason = describePreference(best, weights[best.platform.toLowerCase()] ?? 1);

  return {
    logicalModel,
    candidates: scored,
    preferred: { platform: best.platform, modelId: best.modelId, endpointScope: best.endpointScope },
    reason,
  };
}

export interface RecordedDecision {
  logicalModel: string;
  mode: QuotaRoutingMode;
  actualPlatform: string;
  actualModelId: string;
  /** The endpoint that actually served, so `agreed` can distinguish two relays
   *  behind one platform name rather than reading true by default. */
  actualEndpointScope?: string;
  decision: ShadowDecision;
}

/**
 * Persist one comparison. Swallows every failure: a routing decision that
 * cannot be logged is not a request that should fail.
 */
export function recordRoutingDecision(input: RecordedDecision): void {
  if (input.mode === 'off') return;
  try {
    const db: Db = getDb();
    const preferred = input.decision.preferred;
    const agreed = preferred == null
      // No opinion is not a disagreement — the incumbent's choice stands
      // unchallenged, which is agreement for the purpose of the rate.
      || (preferred.platform === input.actualPlatform
        && preferred.modelId === input.actualModelId
        // Compare endpoints only when both sides name one. Rows written before
        // the endpoint columns existed carry undefined on both sides and must
        // keep comparing equal rather than all flipping to disagreement.
        && (preferred.endpointScope ?? '') === (input.actualEndpointScope ?? ''));
    db.prepare(`
      INSERT INTO routing_decision (
        created_at_ms, logical_model, mode, actual_platform, actual_model_id, actual_endpoint,
        shadow_platform, shadow_model_id, shadow_endpoint, agreed, reason, candidates_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      Date.now(), input.decision.logicalModel, input.mode,
      input.actualPlatform, input.actualModelId, input.actualEndpointScope ?? null,
      preferred?.platform ?? null, preferred?.modelId ?? null, preferred?.endpointScope ?? null,
      agreed ? 1 : 0, input.decision.reason,
      JSON.stringify(input.decision.candidates),
    );
  } catch {
    // Intentionally silent — see the module header.
  }
}

export interface ShadowAgreementStats {
  total: number;
  agreed: number;
  agreementRate: number | null;
  byLogicalModel: { logicalModel: string; total: number; agreed: number }[];
}

/** Shadow-mode summary for the operator: how often the two routers differ. */
export function getShadowAgreementStats(sinceMs?: number): ShadowAgreementStats {
  try {
    const db = getDb();
    const since = sinceMs ?? Date.now() - 7 * 86_400_000;
    const totals = db.prepare(
      'SELECT COUNT(*) AS total, SUM(agreed) AS agreed FROM routing_decision WHERE created_at_ms >= ?',
    ).get(since) as { total: number; agreed: number | null };
    const perModel = db.prepare(`
      SELECT logical_model AS logicalModel, COUNT(*) AS total, SUM(agreed) AS agreed
        FROM routing_decision WHERE created_at_ms >= ?
       GROUP BY logical_model ORDER BY total DESC LIMIT 50
    `).all(since) as { logicalModel: string; total: number; agreed: number }[];
    return {
      total: totals.total,
      agreed: totals.agreed ?? 0,
      agreementRate: totals.total > 0 ? (totals.agreed ?? 0) / totals.total : null,
      byLogicalModel: perModel,
    };
  } catch {
    return { total: 0, agreed: 0, agreementRate: null, byLogicalModel: [] };
  }
}

export interface RoutingDecisionRow {
  id: number;
  createdAt: string;
  logicalModel: string;
  mode: string;
  actualPlatform: string;
  actualModelId: string;
  shadowPlatform: string | null;
  shadowModelId: string | null;
  actualEndpoint: string | null;
  shadowEndpoint: string | null;
  agreed: boolean;
  reason: string | null;
  candidates: unknown;
}

export interface RoutingDecisionQuery {
  /** Only decisions where the two routers differed — the rows worth reading. */
  disagreedOnly?: boolean;
  logicalModel?: string;
  sinceMs?: number;
  limit?: number;
}

interface RawDecisionRow {
  id: number;
  created_at_ms: number;
  logical_model: string;
  mode: string;
  actual_platform: string;
  actual_model_id: string;
  shadow_platform: string | null;
  shadow_model_id: string | null;
  actual_endpoint: string | null;
  shadow_endpoint: string | null;
  agreed: number;
  reason: string | null;
  candidates_json: string | null;
}

/** Recent routing decisions, newest first. Read-only inspection of the shadow
 *  ledger; returns [] rather than throwing when the table is unreachable. */
export function listRoutingDecisions(query: RoutingDecisionQuery = {}): RoutingDecisionRow[] {
  try {
    const db = getDb();
    const limit = Math.min(Math.max(query.limit ?? 100, 1), 500);
    const since = query.sinceMs ?? 0;
    const clauses = ['created_at_ms >= ?'];
    const params: (string | number)[] = [since];
    if (query.disagreedOnly) clauses.push('agreed = 0');
    if (query.logicalModel) { clauses.push('logical_model = ?'); params.push(query.logicalModel); }

    const rows = db.prepare(`
      SELECT id, created_at_ms, logical_model, mode, actual_platform, actual_model_id,
             shadow_platform, shadow_model_id, actual_endpoint, shadow_endpoint,
             agreed, reason, candidates_json
        FROM routing_decision
       WHERE ${clauses.join(' AND ')}
       ORDER BY created_at_ms DESC, id DESC
       LIMIT ?
    `).all(...params, limit) as RawDecisionRow[];

    return rows.map(row => ({
      id: row.id,
      createdAt: new Date(row.created_at_ms).toISOString(),
      logicalModel: row.logical_model,
      mode: row.mode,
      actualPlatform: row.actual_platform,
      actualModelId: row.actual_model_id,
      shadowPlatform: row.shadow_platform,
      shadowModelId: row.shadow_model_id,
      actualEndpoint: row.actual_endpoint,
      shadowEndpoint: row.shadow_endpoint,
      agreed: row.agreed === 1,
      reason: row.reason,
      // Stored as JSON text; a malformed blob must not take the endpoint down.
      candidates: row.candidates_json ? safeParse(row.candidates_json) : null,
    }));
  } catch {
    return [];
  }
}

function safeParse(json: string): unknown {
  try {
    return JSON.parse(json);
  } catch {
    return null;
  }
}
