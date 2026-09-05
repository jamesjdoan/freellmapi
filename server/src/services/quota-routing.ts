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

/** One provider that could serve the logical model under consideration. */
export interface QuotaCandidate {
  platform: string;
  modelId: string;
  displayName: string;
}

export interface ScoredCandidate {
  platform: string;
  modelId: string;
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
  preferred: { platform: string; modelId: string } | null;
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
export function scoreQuotaCandidate(quotas: EffectiveQuota[], used: (q: EffectiveQuota) => number | null, now: number): Pick<ScoredCandidate, 'score' | 'headroom' | 'paceDelta'> {
  let worstHeadroom: number | null = null;
  let bindingPace: number | null = null;

  for (const quota of quotas) {
    const consumed = used(quota);
    if (consumed == null || quota.limit <= 0) continue;
    const headroom = Math.max(0, Math.min(1, 1 - consumed / quota.limit));
    if (worstHeadroom == null || headroom < worstHeadroom) {
      worstHeadroom = headroom;
      bindingPace = quotaPacing(quota.window, now, consumed, quota.limit).paceDelta;
    }
  }

  return { score: worstHeadroom, headroom: worstHeadroom, paceDelta: bindingPace };
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
  const scored: ScoredCandidate[] = candidates.map(candidate => {
    const quotas = resolveEffectiveQuotas(candidate.platform, candidate.modelId, now);
    const { score, headroom, paceDelta } = scoreQuotaCandidate(
      quotas,
      quota => usedFor(candidate.platform, candidate.modelId, quota),
      now,
    );
    return { platform: candidate.platform, modelId: candidate.modelId, score, headroom, paceDelta };
  });

  const withOpinion = scored.filter(c => c.score != null);
  if (withOpinion.length === 0) {
    return { logicalModel, candidates: scored, preferred: null, reason: 'no quota signal for any candidate' };
  }

  const best = withOpinion.reduce((a, b) => (b.score! > a.score! ? b : a));
  const reason = best.paceDelta != null && best.paceDelta < -0.2
    ? `most headroom (${(best.headroom! * 100).toFixed(0)}%) and behind pace — allowance on course to expire unused`
    : `most headroom (${(best.headroom! * 100).toFixed(0)}%) on its binding axis`;

  return {
    logicalModel,
    candidates: scored,
    preferred: { platform: best.platform, modelId: best.modelId },
    reason,
  };
}

export interface RecordedDecision {
  logicalModel: string;
  mode: QuotaRoutingMode;
  actualPlatform: string;
  actualModelId: string;
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
      || (preferred.platform === input.actualPlatform && preferred.modelId === input.actualModelId);
    db.prepare(`
      INSERT INTO routing_decision (
        created_at_ms, logical_model, mode, actual_platform, actual_model_id,
        shadow_platform, shadow_model_id, agreed, reason, candidates_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      Date.now(), input.decision.logicalModel, input.mode,
      input.actualPlatform, input.actualModelId,
      preferred?.platform ?? null, preferred?.modelId ?? null,
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
