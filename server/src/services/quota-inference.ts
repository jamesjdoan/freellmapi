import { getDb } from '../db/index.js';
import { parseStoredUtc } from './quota-clock.js';
import { ollamaCallCostUsd } from '../data/ollama-model-rates.js';

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
  /**
   * When the window is predicted to turn over next, for an estimator that
   * measured actual boundaries rather than a rate.
   *
   * Two observed resets give a period AND a phase, so the next one follows.
   * Ollama's session resets landed at 07:02:23 and 12:02:49 UTC - 5.01h apart,
   * both at two minutes past - which is a countdown the provider itself never
   * sends: its 429 carries no reset time and its retry-after header is empty.
   *
   * Null for the rate-based estimators, which can size a window without ever
   * seeing one end.
   */
  nextResetAtMs?: number | null;
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
/** A run has to move a real part of the pool before dividing by it means
 *  anything: below 5%, the provider's 0.01% reporting granularity and the
 *  attribution of calls to polls both matter more than the signal. */
const MIN_RUN_FRACTION = 0.05;

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
  // Phase, from the most recent boundary. Each boundary is only known to
  // within the polling gap, so the prediction inherits that error - which is
  // minutes against a five-hour window.
  const lastReset = resetAt[resetAt.length - 1]!;
  let nextReset = lastReset + median * 1000;
  const now = Date.now();
  while (nextReset <= now) nextReset += median * 1000;
  return {
    ...classified,
    impliedSeconds: median,
    method: 'reset_interval',
    samples: intervals.length,
    nextResetAtMs: nextReset,
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

export interface InferredAllowance {
  quotaPoolKey: string;
  /** 'credit_usd' is the only one of these that holds still across traffic
   *  mixes; see the note on inferAllowanceFromFraction. */
  metric: 'requests' | 'total_tokens' | 'credit_usd';
  /** Median implied size of the allowance, in `metric` units. */
  limit: number;
  /** Range across the sampled intervals — the honest error bar. */
  low: number;
  high: number;
  samples: number;
  confidence: number;
  note: string;
}

/**
 * Work out how big an allowance really is, when the provider only says what
 * FRACTION of it is left.
 *
 * Ollama Cloud reports `limits.session.usage = 0.212` and never states the
 * size. But we know what we spent between two readings, so the arithmetic is
 * direct: consume f of the pool with t tokens and the pool holds t/f tokens.
 * Repeat over several intervals and the spread says how much to trust it.
 *
 * Measured on real traffic across five intervals: a median of 25.1M tokens per
 * session window, spread 18.7M-27.7M. Tight enough to be a measurement.
 *
 * Two things it must get right:
 *
 * FAILED REQUESTS COUNT. Ten calls to nemotron-3-super returned "stream
 * produced no content" while sending ~215k input tokens each, and the session
 * fraction dropped for every one. The provider ran the model; that it returned
 * nothing is our problem, not a refund. Counting successes only would have
 * inflated the implied allowance without bound.
 *
 * THE UNIT IS MODEL-SPECIFIC. Ollama meters GPU time, so a token is not a
 * fixed cost - 1M tokens of a 120b model spends more than 1M of a 20b. The
 * figure is therefore only valid for the traffic mix that produced it, which is
 * why the note carries the mix and the confidence stays low.
 */
export function inferAllowanceFromFraction(
  platform: string,
  quotaPoolKey: string,
): InferredAllowance[] {
  interface Row { observed_at: string; remaining_value: number; limit_value: number }
  let rows: Row[];
  try {
    rows = getDb().prepare(`
      SELECT observed_at, remaining_value, limit_value
        FROM provider_quota_observations
       WHERE platform = ? AND quota_pool_key = ?
         AND remaining_value IS NOT NULL AND limit_value IS NOT NULL AND limit_value > 0
       ORDER BY observed_at
    `).all(platform, quotaPoolKey) as Row[];
  } catch {
    return [];
  }
  if (rows.length < 2) return [];

  // Aggregated over whole RUNS between resets, not per polling interval.
  //
  // Per-interval division looked reasonable and was not: with a 5-minute poll,
  // a call landing either side of a boundary is attributed to the wrong
  // interval, and dividing a misattributed spend by a 0.9% fraction swings the
  // implied pool wildly. On real data that produced a $0.75-$7.65 range on a
  // pool independently measured at $1.53-$2.00. Summing spend and fraction
  // across a run first cancels the boundary error, because a call misplaced
  // between two intervals is still inside the same run.
  interface Run { requests: number; tokens: number; dollars: number | null; fraction: number }
  const runs: Run[] = [];
  let run: Run = { requests: 0, tokens: 0, dollars: 0, fraction: 0 };
  const closeRun = (): void => {
    if (run.fraction >= MIN_RUN_FRACTION) runs.push(run);
    run = { requests: 0, tokens: 0, dollars: 0, fraction: 0 };
  };

  const countUsage = getDb().prepare(`
    SELECT COUNT(*) AS requests,
           COALESCE(SUM(input_tokens + output_tokens), 0) AS tokens
      FROM requests
     WHERE platform = ? AND created_at > ? AND created_at <= ?
       AND request_type <> 'burn_test'
  `);
  const priceInterval = getDb().prepare(`
    SELECT model_id,
           COALESCE(SUM(input_tokens), 0) AS input_tokens,
           COALESCE(SUM(output_tokens), 0) AS output_tokens
      FROM requests
     WHERE platform = ? AND created_at > ? AND created_at <= ?
       AND request_type <> 'burn_test'
     GROUP BY model_id
  `);

  for (let i = 1; i < rows.length; i++) {
    const before = rows[i - 1]!;
    const after = rows[i]!;
    const consumed = (before.remaining_value - after.remaining_value) / before.limit_value;
    // A rise is a reset: the run ends and a new one starts.
    if (consumed < 0) { closeRun(); continue; }
    if (consumed === 0) continue;

    let usage: { requests: number; tokens: number };
    try {
      usage = countUsage.get(platform, before.observed_at, after.observed_at) as { requests: number; tokens: number };
    } catch {
      continue;
    }
    run.fraction += consumed;
    run.requests += usage.requests;
    run.tokens += usage.tokens;

    if (platform === 'ollama' && run.dollars != null) {
      try {
        const perModel = priceInterval.all(platform, before.observed_at, after.observed_at) as
          { model_id: string; input_tokens: number; output_tokens: number }[];
        let dollars = 0;
        for (const modelRow of perModel) {
          const cost = ollamaCallCostUsd(modelRow.model_id, modelRow.input_tokens, modelRow.output_tokens,
            new Date(parseStoredUtc(after.observed_at) ?? Date.now()));
          // One unpriced model makes the run's total wrong rather than merely
          // incomplete, so the run forfeits its dollar figure and keeps tokens.
          if (cost == null) { run.dollars = null; break; }
          dollars += cost;
        }
        if (run.dollars != null) run.dollars += dollars;
      } catch {
        run.dollars = null;
      }
    } else if (platform !== 'ollama') {
      run.dollars = null;
    }
  }
  closeRun();
  if (runs.length === 0) return [];

  const estimates = (pick: (r: Run) => number | null): number[] =>
    runs.flatMap(r => {
      const spent = pick(r);
      return spent == null || spent <= 0 ? [] : [spent / r.fraction];
    });
  const median = (values: number[]): number => {
    const sorted = [...values].sort((a, b) => a - b);
    return sorted[Math.floor(sorted.length / 2)]!;
  };

  const out: InferredAllowance[] = [];
  for (const [metric, values] of [
    ['credit_usd', estimates(r => r.dollars)],
    ['total_tokens', estimates(r => r.tokens)],
    ['requests', estimates(r => r.requests)],
  ] as const) {
    if (values.length === 0) continue;
    const scale = (value: number): number =>
      metric === 'credit_usd' ? Math.round(value * 100) : Math.round(value);
    out.push({
      quotaPoolKey,
      metric,
      limit: scale(median(values)),
      low: scale(Math.min(...values)),
      high: scale(Math.max(...values)),
      samples: values.length,
      // One run is a real measurement over a long span, not a thin sample, so
      // the floor is higher than a per-interval count would justify - but it
      // is still an inference from our own counting.
      confidence: confidenceFor(values.length * 10, 0.2),
      note: metric === 'credit_usd'
        ? `${values.length} run(s), implied $${median(values).toFixed(2)} of credit`
        : `${values.length} run(s), implied ${Math.round(median(values)).toLocaleString()} ${metric} at the sampled traffic mix`,
    });
  }
  return out;
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
