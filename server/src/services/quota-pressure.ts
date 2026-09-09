import {
  poolPressureParts,
  diversityFactor,
  UNKNOWN_POOL_PRESSURE,
  type HeadroomThresholds,
} from './scoring.js';
import { resolveEffectiveQuotas, type EffectiveQuota } from './quota-policy.js';
import { getReservationWeights, UNKNOWN_HEADROOM } from './quota-routing.js';
import { quotaPacing } from './quota-clock.js';
import {
  countRequestsInWindow,
  countTokensInWindow,
  countPlatformUsageInWindow,
  hasActiveCooldown,
  inFlightRoutes,
} from './ratelimit.js';
import { resolveQuotaPolicy } from './provider-quota.js';
import type { Platform } from '@freellmapi/shared/types.js';

// Quota-domain pressure as a routing rank (ADR ARCH-20260905 W4).
//
// The hard gates already answer "may this route go at all" — cooldown, observed
// pool exhaustion, provider daily/minute caps, per-model rpm/rpd/tpm/tpd. They
// are binary and they fire at 100%, which is exactly one request too late: a
// pool at 97% is still permitted, still ranks first, and still 429s.
//
// This module answers the ranking question the gates cannot: given every quota
// domain that governs a route — the provider account pool, the per-model pool,
// daily and weekly windows, a credit balance — how attractive is it to spend
// here right now?
//
// It reuses the resolver rather than re-deriving limits. `resolveEffectiveQuotas`
// already ranks live headers above provider APIs above operator config above
// the catalog above env caps above a ceiling learned from a 429, and already
// returns EVERY binding axis rather than one. Taking the worst of those axes is
// what "available only if all governing domains permit it" becomes once it is a
// rank instead of a gate — and it is the same reduction `scoreQuotaCandidate`
// performs for the shadow ledger, so live routing and the shadow comparison
// cannot drift apart in their reading of the same pools.
//
// Everything here is best-effort. A quota read that throws must never fail a
// request, so every entry point falls back to "no opinion" (factor 1) rather
// than to an exception.

export interface PoolPressure {
  /** [0,1] GUARDRAIL. Joins the `min` over the other quota meters — the
   *  binding constraint decides, and only ever downward. */
  scarcity: number;
  /** [1, 1+HARVEST_MAX_BOOST] PREFERENCE. Kept out of that `min`, or a boost
   *  would be clipped back to 1 by the meters that have no opinion. */
  harvest: number;
  /** Both together, for callers that rank on one number (priority mode). */
  factor: number;
  /** Remaining fraction on the binding axis, null when nothing published one. */
  headroom: number | null;
  /** The pool key that bound, for the operator-facing diagnostic. */
  poolKey: string | null;
  /** True when the binding axis had no measurable limit from any source. */
  unknown: boolean;
}

// Deliberately NO availability field. This struct is memoised for ranking, and
// a gate served from a cache is a gate with a hole in it: the second request
// inside the TTL sees the first one's pre-write number. Admission lives in
// `quotaDomainsAdmit` below, which reads fresh and counts leases.
const NO_OPINION: PoolPressure = {
  scarcity: 1, harvest: 1, factor: 1, headroom: null, poolKey: null, unknown: true,
};

/**
 * Resolving a route's quota domains means a handful of SQLite reads, and
 * `scoreChainEntry` runs once per chain member per request — on a fifteen-model
 * chain under parallel load that is a few hundred queries a second for numbers
 * that move on the scale of whole requests.
 *
 * Cached per (platform, model, endpoint) for a window short enough that a pool
 * crossing a threshold is reflected within one or two requests, and long enough
 * that a burst of concurrent workers scoring the same chain pays for it once.
 * Deliberately not longer: the diversity signal below is what handles
 * within-burst spreading, and stale scarcity is what this cache must not cause.
 */
const PRESSURE_TTL_MS = 5_000;
interface CacheEntry { at: number; value: PoolPressure }
const pressureCache = new Map<string, CacheEntry>();

/** Test seam — module-global caches outlive individual cases. */
export function invalidateQuotaPressure(): void {
  pressureCache.clear();

}

/** Which local counter, if any, can express this metric.
 *
 *  `credits` deliberately has none. A credit balance is money, priced per model
 *  and per token by the provider; counting raw tokens against it produced an
 *  Ollama account with a stated 166-credit ceiling reading as millions spent
 *  and would have closed the platform outright. When no provider figure and no
 *  derived figure is available for a credit axis, the honest answer is that we
 *  do not know — which is what null means everywhere else here. */
function counterFor(metric: EffectiveQuota['metric']): 'request' | 'tokens' | null {
  if (metric === 'requests') return 'request';
  return metric === 'credits' ? null : 'tokens';
}

/**
 * Local consumption of one quota axis, counted over the axis's own window AND
 * on the axis's own subject.
 *
 * The subject is the part that is easy to get wrong and expensive when it is:
 * an account-wide or shared-pool limit is spent by every model on the platform
 * together, so counting only this model's requests against it reports a pool as
 * untouched no matter how hard its siblings are hammering it. That is exactly
 * the failure the shared-domain work exists to fix — NVIDIA's one credit pool
 * read as full while three chain members drew it down — so the counter has to
 * follow the scope rather than defaulting to the per-model one.
 *
 * A provider-reported window has no period start — there is no span to count
 * over — and the caller already prefers the provider's own remaining figure in
 * that case, so null here is correct rather than lossy.
 *
 * `fresh` bypasses the 5s memo. Ranking is happy with a stale count; ADMISSION
 * is not, because a gate that answers from a five-second-old number is a gate
 * that lets five seconds of traffic past the limit it is enforcing.
 */
function usedOnAxis(
  platform: string,
  modelId: string,
  quota: EffectiveQuota,
  now: number,
  fresh = false,
): number | null {
  const start = quota.window.periodStartMs;
  if (start == null) return null;
  const kind = counterFor(quota.metric);
  if (kind === null) return null;
  const windowMs = Math.max(1, now - start);
  // 'model' and 'provider_key' bind one model's own meter; the other two are
  // one allowance behind everything the platform serves.
  if (quota.scope === 'provider_account' || quota.scope === 'shared_pool') {
    return countPlatformUsageInWindow(platform, kind, windowMs, now, fresh);
  }
  return kind === 'request'
    ? countRequestsInWindow(platform, modelId, windowMs, now, fresh)
    : countTokensInWindow(platform, modelId, windowMs, now, fresh);
}

/**
 * What this axis has ALREADY promised to attempts that are still in the air.
 *
 * Usage is only recorded after an attempt succeeds, so between key selection
 * and that write the counters read as if nothing were happening. N concurrent
 * requests therefore all pass the same pre-check and collectively blow through
 * the limit — the check-then-act race the lease map exists to close, and which
 * the router's other gates already close by counting leases. A gate that skips
 * this is not enforcing a limit, it is enforcing a limit per five seconds.
 */
function provisionalOnAxis(platform: string, modelId: string, quota: EffectiveQuota, now: number): number {
  const kind = counterFor(quota.metric);
  if (kind === null) return 0;
  const platformWide = quota.scope === 'provider_account' || quota.scope === 'shared_pool';
  let total = 0;
  for (const lease of inFlightRoutes(now)) {
    if (lease.platform !== platform) continue;
    if (!platformWide && lease.modelId !== modelId) continue;
    total += kind === 'request' ? 1 : lease.tokens;
  }
  return total;
}

/** Sources whose zero is something the provider measured, not something we
 *  inferred against a limit we may have guessed. Mirrors quota-routing.ts. */
const MEASURED_SOURCES: Record<string, true> = { provider_header: true, provider_api: true };

/**
 * Sources whose exhaustion BLOCKS a route rather than merely demoting it.
 *
 * "Available only if all governing domains permit it" is a gate, and ranking
 * alone does not satisfy it: a demoted route is still served the moment its
 * alternatives run out, which is precisely when an exhausted account pool is
 * guaranteed to 429. Scarcity scoring spends the last of an allowance
 * gracefully; this is what stops the request after it is gone.
 *
 * Three sources qualify and the rest deliberately do not:
 *
 *   provider_header / provider_api  the provider measured it and said so
 *   operator                        a human typed this limit into quota_policy
 *                                   for this account. Treating their stated
 *                                   ceiling as advisory is not caution, it is
 *                                   ignoring the one person who knows the plan
 *
 * Excluded: `catalog` and `documentation` are shipped guesses, `provider_cap_env`
 * is already enforced by canUseProvider on its own counters, and `learned_429`
 * is a lower bound inferred from a single refusal — blocking on any of those
 * would suppress capacity that is really there, which is the expensive
 * direction of this error.
 */
const ENFORCEABLE_SOURCES: Record<string, true> = { provider_header: true, provider_api: true, operator: true };

interface BindingAxis {
  headroom: number;
  paceDelta: number | null;
  msToReset: number | null;
  /** Length of this axis's period, so "about to reset" can be judged against
   *  the pool's own clock rather than a fixed number of minutes. */
  windowMs: number | null;
}

/**
 * The binding axis across every governing quota domain: lowest remaining
 * fraction wins, because a route is only as available as its tightest pool.
 */
function bindingAxis(
  platform: string,
  modelId: string,
  quotas: EffectiveQuota[],
  now: number,
  exhaustionConfirmed: boolean,
): BindingAxis | null {
  let binding: BindingAxis | null = null;
  for (const quota of quotas) {
    const consumed = quota.reportedRemaining != null
      ? quota.limit - quota.reportedRemaining
      : quota.derivedUsed != null
        ? quota.derivedUsed
        : usedOnAxis(platform, modelId, quota, now);
    if (consumed == null || quota.limit <= 0) continue;

    let headroom = Math.max(0, Math.min(1, 1 - consumed / quota.limit));
    // Spend the last of an allowance before believing it is gone. A computed
    // zero against an estimated ceiling is a guess; diverting on it means never
    // finding out whether the allowance was really spent. A measured zero, or a
    // refusal on record, is a fact. Same rule as the shadow scorer.
    if (headroom === 0 && !exhaustionConfirmed && !MEASURED_SOURCES[quota.source]) {
      headroom = UNKNOWN_HEADROOM;
    }
    if (binding === null || headroom < binding.headroom) {
      const pacing = quotaPacing(quota.window, now, consumed, quota.limit);
      const { resetAtMs, periodStartMs } = quota.window;
      binding = {
        headroom,
        paceDelta: pacing.paceDelta,
        msToReset: resetAtMs == null ? null : Math.max(0, resetAtMs - now),
        windowMs: resetAtMs == null || periodStartMs == null ? null : resetAtMs - periodStartMs,
      };
    }
  }
  return binding;
}

/**
 * How attractive this route's quota domains make it right now.
 *
 * `reservationWeight` comes from the operator's `quota_reservation_weights`
 * setting, keyed by platform: two pools at 50% remaining are not equally cheap
 * to spend when one of them is a 50/day free allowance, and no formula over
 * absolute counts can tell requests from tokens from credits well enough to
 * infer that. The operator declares it.
 */
export function quotaPressure(
  platform: string,
  modelId: string,
  endpointScope: string,
  opts?: HeadroomThresholds,
  now: number = Date.now(),
): PoolPressure {
  const key = `${platform}\u0000${modelId}\u0000${endpointScope}`;
  const hit = pressureCache.get(key);
  if (hit && now - hit.at < PRESSURE_TTL_MS) return hit.value;

  let value: PoolPressure;
  try {
    const quotas = resolveEffectiveQuotas(platform, modelId, now, endpointScope || null);
    const weight = getReservationWeights()[platform.toLowerCase()] ?? 1;
    const axis = bindingAxis(platform, modelId, quotas, now, hasActiveCooldown(platform, modelId, now));

    let poolKey: string | null = null;
    try {
      poolKey = resolveQuotaPolicy(platform as Platform, modelId).poolKey;
    } catch {
      poolKey = null;
    }

    const parts = poolPressureParts({
      headroom: axis?.headroom ?? null,
      paceDelta: axis?.paceDelta ?? null,
      msToReset: axis?.msToReset ?? null,
      windowMs: axis?.windowMs ?? null,
      reservationWeight: weight,
    }, opts);

    value = {
      scarcity: parts.scarcity,
      harvest: parts.harvest,
      factor: parts.scarcity * parts.harvest,
      headroom: axis?.headroom ?? null,
      poolKey,
      unknown: axis === null,
    };
  } catch {
    // A quota read that fails is not a reason to demote a route, and certainly
    // not a reason to fail a request.
    value = NO_OPINION;
  }

  pressureCache.set(key, { at: now, value });
  return value;
}

// ── Provider diversity across concurrent work ───────────────────────────────
//
// Parallel workers with no skip state between them all see the same scored
// chain and all pick its head, so three subagents launched together contend for
// one allowance while two comparable pools sit idle.
//
// Contention is measured over the requests actually IN FLIGHT, not over recent
// ones. The lease map already tracks exactly that — it exists so parallel
// streams stop landing on one key — and reading it means a sequential caller,
// which never has two attempts open at once, is never spread and never pays for
// a preference it cannot benefit from. A recency window cannot tell a burst of
// three concurrent workers from three sequential requests and would tax the
// second case to serve the first.
//
// It also needs no correlation id: parallel subagents arrive as unrelated
// requests with nothing linking them, and "how many attempts are open on this
// pool right now" answers the question without inventing a protocol between the
// harness and this server.
//
// Grouped by QUOTA DOMAIN, not provider name, because contention is a property
// of the allowance: Kimi and DeepSeek on NVIDIA share one pool and spreading
// across them buys nothing, while the same model on Groq and on OVH are two
// pools and spreading across them buys everything.

/** Below two attempts in the air there is no concurrency to spread. */
const DIVERSITY_MIN_IN_FLIGHT = 2;

/**
 * This pool's share of the attempts currently in flight, or null when there is
 * no concurrency to reason about.
 */
export function inFlightPoolShare(platform: string, modelId: string, now = Date.now()): number | null {
  try {
    const open = inFlightRoutes(now);
    if (open.length < DIVERSITY_MIN_IN_FLIGHT) return null;

    const poolKey = resolveQuotaPolicy(platform as Platform, modelId).poolKey;
    let hits = 0;
    for (const route of open) {
      if (resolveQuotaPolicy(route.platform as Platform, route.modelId).poolKey === poolKey) hits++;
    }
    return hits / open.length;
  } catch {
    // A pool we cannot name is a pool we cannot spread across.
    return null;
  }
}

/** Diversity multiplier for one route. See DIVERSITY_MAX_DAMP for why it is
 *  deliberately too weak to override a real capability difference. */
export function poolDiversityFactor(platform: string, modelId: string, now = Date.now()): number {
  return diversityFactor(inFlightPoolShare(platform, modelId, now));
}

export { UNKNOWN_POOL_PRESSURE };

// ── Admission: does every governing domain actually permit this route? ───────
//
// Separate from `quotaPressure` on purpose, and separate in all three ways that
// matter:
//
//   cached   → fresh.        A gate answered from a 5s memo is not enforcing a
//                            limit, it is enforcing one limit per 5 seconds.
//   lease-blind → lease-aware. Usage is written only after an attempt succeeds,
//                            so N concurrent requests all read the same
//                            pre-write count and all pass. Counting in-flight
//                            leases is how the router's other gates close that
//                            race, and this one has to close it the same way.
//   worst-axis → every axis. Ranking wants the tightest constraint; admission
//                            wants ANY exhausted one, or a spent account pool
//                            hides behind a model meter with a lower fraction.
//
// It is the last resort, not the first: scarcity ranking already steers traffic
// away from a pool long before it gets here. This is what stops the request
// once the allowance is genuinely gone, which ranking alone never does — a
// demoted route is still served the moment its alternatives run out, and that
// is exactly when a spent pool is guaranteed to refuse.

export interface AdmissionDecision {
  ok: boolean;
  /** `scope:metric:source` of the domain that closed it, for the diagnostic. */
  blockedBy: string | null;
}

const ADMITTED: AdmissionDecision = { ok: true, blockedBy: null };

export function quotaDomainsAdmit(
  platform: string,
  modelId: string,
  endpointScope: string,
  estimatedTokens = 0,
  now: number = Date.now(),
): AdmissionDecision {
  try {
    const quotas = resolveEffectiveQuotas(platform, modelId, now, endpointScope || null);
    for (const quota of quotas) {
      if (quota.limit <= 0 || !ENFORCEABLE_SOURCES[quota.source]) continue;

      const measured = quota.reportedRemaining != null
        ? quota.limit - quota.reportedRemaining
        : quota.derivedUsed != null
          ? quota.derivedUsed
          : usedOnAxis(platform, modelId, quota, now, true);
      // No countable figure — a window with no start, or a credit balance with
      // nothing reported. Unknown must not close a route.
      if (measured == null) continue;

      const blocked = { ok: false, blockedBy: `${quota.scope}:${quota.metric}:${quota.source}` };
      const counter = counterFor(quota.metric);

      // Credits are money and this request's cost in them is NOT its token
      // count. Ollama Cloud prices per model — a million nemotron-3-ultra
      // tokens costs roughly eight times a million gpt-oss:20b tokens — so
      // there is no conversion here to make. Adding raw tokens instead was the
      // same category error as counting them as usage: a 1000-token request
      // would have "spent" 1000 of a stated 166-credit balance and closed the
      // live Ollama account on its first call.
      //
      // So a credit axis admits on what is actually known: it closes when the
      // balance is already gone, and reserves nothing for a cost it cannot
      // price. Until a real pricing conversion exists, over-admitting by one
      // request is the correct side to err on — the provider's own reported
      // remaining is what closes it a moment later.
      if (counter === null) {
        if (measured >= quota.limit) return blocked;
        continue;
      }

      // Requests and tokens are countable, so the request being admitted counts
      // against the axis too, alongside everything already in the air on it.
      const pending = provisionalOnAxis(platform, modelId, quota, now);
      const thisRequest = counter === 'request' ? 1 : estimatedTokens;
      if (measured + pending + thisRequest > quota.limit) return blocked;
    }
    return ADMITTED;
  } catch {
    // A quota read that fails is not a reason to refuse a request.
    return ADMITTED;
  }
}
