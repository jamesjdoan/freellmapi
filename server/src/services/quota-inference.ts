import { getDb } from '../db/index.js';
import { parseStoredUtc } from './quota-clock.js';

// Estimating quota shape from behaviour, for the providers that state nothing.
//
// Most providers in the catalogue publish no limit, no reset and no remaining.
// For those the only evidence is how they behave: how fast an allowance
// refills, and how long a refusal lasts. Neither is precise. Both are precise
// enough to classify the SCALE of a window, and once the scale is known the
// calendar does the rest — which is why nothing here predicts a reset instant
// directly.
//
// Validated against 18,384 real observations and 7,860 real requests before
// being written; the accuracy figures in each function are measured, not hoped
// for. Everything degrades to null rather than guessing when samples are thin.

/** The window scales worth distinguishing. Anything between them snaps to the
 *  nearest on a log scale — the estimators are accurate to a factor, not a
 *  percentage, so log distance is the honest metric. */
const STANDARD_PERIODS = [
  { period: 'minute' as const, seconds: 60 },
  { period: 'hour' as const, seconds: 3600 },
  { period: 'day' as const, seconds: 86_400 },
  { period: 'week' as const, seconds: 604_800 },
  { period: 'month' as const, seconds: 2_592_000 },
];

export type InferredPeriod = (typeof STANDARD_PERIODS)[number]['period'] | 'provider_defined';
export type InferenceMethod = 'refill_rate' | 'recovery_time' | 'reset_interval';

export interface InferredWindow {
  period: InferredPeriod;
  /** Nominal length of the classified period. */
  seconds: number;
  /** What the raw measurement implied, before snapping. Kept so an operator can
   *  see how far the estimate had to move — a large gap is a reason to doubt. */
  impliedSeconds: number;
  method: InferenceMethod;
  samples: number;
  /** Deliberately capped well below anything stated. These are inferences. */
  confidence: number;
  note: string;
}

/** How far a measurement may sit from a standard window and still be called it.
 *  A factor of two either way; beyond that the provider has picked its own. */
const SNAP_TOLERANCE = Math.log(2);

/**
 * Like snapToPeriod, but for a DIRECT measurement rather than a rate estimate.
 * A 5-hour session window is nearly equidistant from 'hour' and 'day' in log
 * space and is neither; rounding it to one would state something false, so it
 * comes back as provider_defined with the measured length intact.
 */
function classifyMeasuredWindow(seconds: number): { period: InferredPeriod; seconds: number } {
  const snapped = snapToPeriod(seconds);
  return Math.abs(Math.log(seconds / snapped.seconds)) <= SNAP_TOLERANCE
    ? snapped
    : { period: 'provider_defined', seconds: Math.round(seconds) };
}

function snapToPeriod(seconds: number): { period: (typeof STANDARD_PERIODS)[number]['period']; seconds: number } {
  let best = STANDARD_PERIODS[0]!;
  let bestDistance = Infinity;
  for (const candidate of STANDARD_PERIODS) {
    const distance = Math.abs(Math.log(seconds / candidate.seconds));
    if (distance < bestDistance) {
      bestDistance = distance;
      best = candidate;
    }
  }
  return { period: best.period, seconds: best.seconds };
}

/** More samples, more trust — but never past 0.5. A behavioural estimate must
 *  not outrank a number someone actually published. */
function confidenceFor(samples: number, floor: number): number {
  return Math.min(0.5, floor + Math.min(samples, 50) / 200);
}

interface RemainingPoint { at: number; remaining: number; limit: number }

/**
 * Infer the window from how fast the allowance refills.
 *
 * Requires a provider that reports `remaining` — Groq and OpenRouter today.
 * The estimator is the 95th percentile of positive gain rates, guarded against
 * jumps larger than half the bucket (a jump that big is a pool-key change or a
 * second key reporting, not a refill).
 *
 * Measured accuracy on real Groq history: 0.77x on an 8000/min token bucket and
 * 0.88x on a 1000/day request pool. Both wrong by tens of percent, both snap to
 * the correct period — which is the only claim made here. The raw max was worse
 * (1.45x) and a long-gap filter was worse still, because a fast bucket
 * saturates within the gap and stops revealing its rate.
 */
export function inferWindowFromRefill(
  platform: string,
  quotaPoolKey: string,
  metric: string,
): InferredWindow | null {
  let points: RemainingPoint[];
  try {
    const rows = getDb().prepare(`
      SELECT observed_at, remaining_value, limit_value
        FROM provider_quota_observations
       WHERE platform = ? AND quota_pool_key = ? AND metric = ?
         AND remaining_value IS NOT NULL AND limit_value IS NOT NULL AND limit_value > 0
       ORDER BY observed_at
    `).all(platform, quotaPoolKey, metric) as { observed_at: string; remaining_value: number; limit_value: number }[];
    points = rows.flatMap(r => {
      const at = parseStoredUtc(r.observed_at);
      return at == null ? [] : [{ at, remaining: r.remaining_value, limit: r.limit_value }];
    });
  } catch {
    return null;
  }
  if (points.length < 6) return null;

  const limit = points[points.length - 1]!.limit;
  const gains: number[] = [];
  for (let i = 1; i < points.length; i++) {
    const previous = points[i - 1]!;
    const current = points[i]!;
    const dt = (current.at - previous.at) / 1000;
    const dr = current.remaining - previous.remaining;
    // dt >= 2s discards same-second artefacts; the half-limit guard discards
    // pool-identity changes masquerading as an enormous refill.
    if (dr > 0 && dt >= 2 && dr <= limit * 0.5) gains.push(dr / dt);
  }
  if (gains.length < 5) return null;

  gains.sort((a, b) => a - b);
  const rate = gains[Math.min(gains.length - 1, Math.floor(gains.length * 0.95))]!;
  if (!(rate > 0)) return null;

  const impliedSeconds = limit / rate;
  const snapped = snapToPeriod(impliedSeconds);
  return {
    ...snapped,
    impliedSeconds,
    method: 'refill_rate',
    samples: gains.length,
    confidence: confidenceFor(gains.length, 0.2),
    note: `refill ~${rate.toPrecision(3)}/s against a limit of ${limit}`,
  };
}

/**
 * Infer the window by timing the gaps between resets.
 *
 * For a pool that refills continuously, the rate identifies the window
 * (inferWindowFromRefill). For one that resets in a step — Ollama Cloud's
 * session and weekly allowances, read from its usage API — the rate says
 * nothing: a jump of 1450 units observed across a 5-minute poll implies a
 * 34-minute window for one that is really hours long. What identifies THAT
 * window is how often the step happens.
 *
 * A reset is a jump to at least RESET_FLOOR of the limit from below
 * RESET_CEILING of it — a step back to full, not a trickle upward, so a leaky
 * bucket recovering while idle is not mistaken for a period boundary.
 */
const RESET_FLOOR = 0.9;
const RESET_CEILING = 0.7;

export function inferWindowFromResets(
  platform: string,
  quotaPoolKey: string,
  metric: string,
): InferredWindow | null {
  let points: RemainingPoint[];
  try {
    const rows = getDb().prepare(`
      SELECT observed_at, remaining_value, limit_value
        FROM provider_quota_observations
       WHERE platform = ? AND quota_pool_key = ? AND metric = ?
         AND remaining_value IS NOT NULL AND limit_value IS NOT NULL AND limit_value > 0
       ORDER BY observed_at
    `).all(platform, quotaPoolKey, metric) as { observed_at: string; remaining_value: number; limit_value: number }[];
    points = rows.flatMap(r => {
      const at = parseStoredUtc(r.observed_at);
      return at == null ? [] : [{ at, remaining: r.remaining_value, limit: r.limit_value }];
    });
  } catch {
    return null;
  }

  const resetAt: number[] = [];
  for (let i = 1; i < points.length; i++) {
    const previous = points[i - 1]!;
    const current = points[i]!;
    if (previous.remaining < RESET_CEILING * previous.limit
      && current.remaining >= RESET_FLOOR * current.limit) {
      resetAt.push(current.at);
    }
  }
  // One reset gives a boundary but no period. Two give one interval, which is
  // the fewest that can measure anything.
  if (resetAt.length < 2) return null;

  const intervals: number[] = [];
  for (let i = 1; i < resetAt.length; i++) intervals.push((resetAt[i]! - resetAt[i - 1]!) / 1000);
  intervals.sort((a, b) => a - b);
  const median = intervals[Math.floor(intervals.length / 2)]!;
  if (!(median > 0)) return null;

  const classified = classifyMeasuredWindow(median);
  return {
    ...classified,
    impliedSeconds: median,
    method: 'reset_interval',
    samples: intervals.length,
    // A timed boundary is direct evidence, unlike a rate extrapolated from
    // consumption — so it earns the top of the inference band.
    confidence: confidenceFor(intervals.length, 0.3),
    note: `${resetAt.length} resets observed, median ${Math.round(median)}s apart`,
  };
}

/**
 * Infer the window from how long a refusal lasts.
 *
 * Needs nothing from the provider but a 429 and a later success, so this is the
 * only method available for the providers that publish nothing — NVIDIA,
 * OpenCode Zen, Ollama.
 *
 * Recovery times cluster by which limit was hit, so this returns one window per
 * populated band rather than an average. Measured on real history: NVIDIA
 * recovers with a median of 24s (its 40 RPM cap, correctly minute-scale), while
 * Google is bimodal — a 16s median with a 49-minute p90 and an 18-hour tail,
 * which is exactly a provider enforcing an RPM limit and a daily one at once.
 * Averaging those would have described neither.
 */
export function inferWindowsFromRecovery(platform: string): InferredWindow[] {
  interface RequestRow { created_at: string; status: string; error: string | null }
  let rows: RequestRow[];
  try {
    // Burn-test traffic is excluded. A burn run reaches the limit on purpose
    // and records its own recovery on the run row, so folding it in here would
    // let a deliberate experiment masquerade as organic evidence — and one
    // burn's exhaustion would dominate the estimate for everything else.
    rows = getDb().prepare(`
      SELECT created_at, status, error FROM requests
       WHERE platform = ? AND request_type <> 'burn_test' ORDER BY created_at
    `).all(platform) as RequestRow[];
  } catch {
    return [];
  }

  const gaps: number[] = [];
  let refusedAt: number | null = null;
  for (const row of rows) {
    const at = parseStoredUtc(row.created_at);
    if (at == null) continue;
    if ((row.error ?? '').includes('429')) {
      refusedAt = at;
      continue;
    }
    if (row.status === 'success' && refusedAt !== null) {
      gaps.push((at - refusedAt) / 1000);
      refusedAt = null;
    }
  }
  if (gaps.length < 3) return [];
  gaps.sort((a, b) => a - b);

  // The MINIMUM recovery is the informative statistic, not the median. Recovery
  // time is bounded below by the provider's window but padded above by our own
  // retry cadence — we back off, or simply had nothing to send. Classifying on
  // the median labelled NVIDIA's 40 RPM cap as an hourly limit purely because
  // some retries came two minutes later.
  const percentile = (fraction: number): number => gaps[Math.min(gaps.length - 1, Math.floor(gaps.length * fraction))]!;
  const fastest = percentile(0.1);
  const slowest = percentile(0.9);

  const windows: InferredWindow[] = [{
    ...snapToPeriod(Math.max(fastest, 1)),
    impliedSeconds: fastest,
    method: 'recovery_time',
    samples: gaps.length,
    confidence: confidenceFor(gaps.length, 0.15),
    note: `${gaps.length} refusals, fastest recovery ~${Math.round(fastest)}s`,
  }];

  // A second constraint only when the slow tail is an order of magnitude away.
  // Anything closer is the same limit plus our own backoff, and calling it a
  // separate window would invent a quota the provider does not have.
  const SEPARATION = 20;
  if (slowest >= fastest * SEPARATION) {
    const second = snapToPeriod(slowest);
    if (second.period !== windows[0]!.period) {
      windows.push({
        ...second,
        impliedSeconds: slowest,
        method: 'recovery_time',
        samples: gaps.length,
        confidence: confidenceFor(gaps.length, 0.1),
        note: `slow tail ~${Math.round(slowest)}s suggests a second, longer limit`,
      });
    }
  }
  return windows;
}

export interface QuotaShape {
  platform: string;
  windows: InferredWindow[];
}

/**
 * Everything behaviour can tell us about one platform's quota shape. Refill
 * evidence first — it comes from the provider's own counter — then recovery
 * bands it does not already cover.
 */
export function inferQuotaShape(platform: string): QuotaShape {
  const windows: InferredWindow[] = [];
  try {
    const pools = getDb().prepare(`
      SELECT DISTINCT quota_pool_key, metric FROM provider_quota_observations
       WHERE platform = ? AND remaining_value IS NOT NULL AND limit_value IS NOT NULL
    `).all(platform) as { quota_pool_key: string; metric: string }[];
    for (const pool of pools) {
      // A timed reset boundary beats a rate extrapolated from consumption, and
      // is the only estimator that works for a pool resetting in a step.
      const inferred = inferWindowFromResets(platform, pool.quota_pool_key, pool.metric)
        ?? inferWindowFromRefill(platform, pool.quota_pool_key, pool.metric);
      if (inferred) windows.push(inferred);
    }
  } catch {
    // fall through to recovery-only inference
  }

  for (const recovered of inferWindowsFromRecovery(platform)) {
    if (windows.some(w => w.period === recovered.period)) continue;
    windows.push(recovered);
  }
  return { platform, windows };
}
