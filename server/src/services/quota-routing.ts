import { getDb, getSetting, setSetting } from '../db/index.js';
import type { Db } from '../db/types.js';
import { normalizeGroupKey } from './model-groups.js';
import { resolveEffectiveQuotas, type EffectiveQuota, type EffectiveQuotaSource } from './quota-policy.js';
import { quotaPacing } from './quota-clock.js';
import { hasActiveCooldown } from './ratelimit.js';

// Operator-declared inputs to quota-aware scoring.
//
// This file used to hold the shadow router (ADR ARCH-20260905, W3): a second
// provider-picker that ran on every request, recorded what it WOULD have
// chosen, and changed nothing. It was removed 2026-09-19 after 3,943 recorded
// decisions. See docs/adr/ARCH-20260905 and the removal commit for the
// evidence; the short version is that a comparison which never runs the route
// it prefers cannot show that the preference was right, and 167 of its
// disagreements preferred a provider that turned out to be dead upstream.
//
// What survives is what the LIVE scorer reads: reservation weights, and the
// headroom constant used when a pool's remaining allowance is unknown. Both are
// consumed by quota-pressure.ts, which does steer real traffic.

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

/**
 * Headroom assumed for a pool whose remaining allowance is unknown.
 *
 * Deliberately 0.5 rather than 1: unknown is not "empty", and it is not "free
 * capacity" either. Kept in step with the same constant in scoring.ts.
 */
export const UNKNOWN_HEADROOM = 0.5;
