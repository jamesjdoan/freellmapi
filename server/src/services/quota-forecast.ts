import type { QuotaObservationView } from './provider-quota.js';
import { getQuotaStateForKeys } from './provider-quota.js';
import { parseStoredUtc } from './quota-clock.js';
import { getDb } from '../db/index.js';
import { inferQuotaShape, inferAllowanceFromFraction, type InferredWindow, type InferredAllowance } from './quota-inference.js';
import { resolveEffectiveQuotas } from './quota-policy.js';
import { countPlatformUsageInWindow } from './ratelimit.js';

// Daily free-tier balance forecast (#1104). Free tiers reset on a per-account
// window (usually UTC midnight) and the only way to know how much headroom is
// left before that reset is to read what the providers themselves reported.
// This is a pure aggregation over `getQuotaStateForKeys()` — no new tables, no
// extra probes — so it costs nothing beyond the query the health view already
// runs.
//
// The value it adds over the raw rows: one number per platform that answers
// "can I keep calling this platform for the rest of today?", plus a
// low-balance warning an agent can gate on BEFORE sending a request that would
// 429.

export const LOW_BALANCE_THRESHOLD = 0.1; // <10% of the daily window left → warn
export const LOW_BALANCE_ABSOLUTE = 20; // ...or fewer than 20 requests left
// The absolute floor is a statement about big windows: "20 left" is alarming
// out of 14400/day and unremarkable out of 30/day. Below this limit the
// percentage rule alone decides, otherwise a small tier would warn from its
// first request onwards and the flag would mean nothing.
export const LOW_BALANCE_ABSOLUTE_MIN_LIMIT = 200;

export interface QuotaForecastEntry {
  /** Platform the pool belongs to, e.g. 'groq'. */
  platform: string;
  /** Human-readable pool label (platform::scope), e.g. 'groq::account'. */
  pool: string;
  /** Requests used in the current window. Null when `remaining` is unknown,
   *  since used is only ever derived from it. */
  used: number | null;
  /** Requests remaining in the current window. Null when unknown. */
  remaining: number | null;
  /** Window total. Null when the provider never reported a limit. */
  limit: number | null;
  /** 0..100 share of the window still available (best-effort). */
  remaining_pct: number | null;
  /** ISO timestamp of the window reset, or null when never observed. */
  reset_at: string | null;
  /** True when less than LOW_BALANCE_THRESHOLD of the window remains, or —
   *  on a window of at least LOW_BALANCE_ABSOLUTE_MIN_LIMIT — fewer than
   *  LOW_BALANCE_ABSOLUTE requests do. Always false when remaining is unknown. */
  low_balance: boolean;
  /** Seconds until reset_at, or null when reset_at is unknown/expired. */
  seconds_until_reset: number | null;
}

function secondsUntilReset(resetAt: string | null): number | null {
  // parseStoredUtc, not `new Date()`: reset_at is stored as a zone-less UTC
  // string, which `new Date()` reads as local time. On a UTC+10 host that made
  // every reset under ten hours away look like it had already passed.
  const at = parseStoredUtc(resetAt);
  if (at == null) return null;
  const ms = at - Date.now();
  if (ms <= 0) return null;
  return Math.floor(ms / 1000);
}

function entryFor(row: QuotaObservationView): QuotaForecastEntry | null {
  // Only request-based windows are predictable from quota headers; token pools
  // reset semantics vary too much across providers to forecast honestly.
  if (row.metric !== 'requests') return null;
  // Without a known limit there is no window to forecast — nothing to warn on.
  if (typeof row.limit !== 'number' || row.limit <= 0) return null;

  const limit = row.limit;
  const remaining = typeof row.remaining === 'number' ? row.remaining : null;

  // An unknown `remaining` says nothing about consumption: reporting the whole
  // limit as used would read as an exhausted pool when it may be untouched.
  const used = remaining === null ? null : Math.max(0, limit - remaining);
  let remainingPct: number | null = null;
  let lowBalance = false;
  if (remaining !== null) {
    remainingPct = Math.max(0, Math.min(100, Math.round((remaining / limit) * 100)));
    const absoluteApplies = limit >= LOW_BALANCE_ABSOLUTE_MIN_LIMIT;
    lowBalance = (absoluteApplies && remaining <= LOW_BALANCE_ABSOLUTE)
      || remaining / limit < LOW_BALANCE_THRESHOLD;
  }

  return {
    platform: row.platform,
    pool: row.quotaPoolKey ?? `${row.platform}::default`,
    used,
    remaining,
    limit,
    remaining_pct: remainingPct,
    reset_at: row.resetAt ?? null,
    low_balance: lowBalance,
    seconds_until_reset: secondsUntilReset(row.resetAt ?? null),
  };
}

// Dedupe to the TIGHTEST row per platform+pool: a platform with several keys
// sharing one account pool reports the same window per key, and the number that
// matters for "can I keep calling" is the least headroom left.
export function getQuotaForecast(): QuotaForecastEntry[] {
  const byKey = new Map<string, QuotaForecastEntry>();
  for (const row of getQuotaStateForKeys()) {
    const entry = entryFor(row);
    if (!entry) continue;
    // `pool` already carries its platform ("groq::account"), so it is the key.
    const key = entry.pool;
    const prev = byKey.get(key);
    if (!prev || (entry.remaining_pct ?? Infinity) < (prev.remaining_pct ?? Infinity)) {
      byKey.set(key, entry);
    }
  }
  return [...byKey.values()].sort((a, b) => {
    // Low-balance pools first — the ones the caller most needs to see.
    if (a.low_balance !== b.low_balance) return a.low_balance ? -1 : 1;
    return a.platform.localeCompare(b.platform);
  });
}

// ── Provider overview (dashboard) ───────────────────────────────────────────
// getQuotaForecast() is a WARNING feed: it drops any pool without a numeric
// limit, because you cannot warn on a number you do not have. Driving a
// provider-overview panel from it made every provider except Groq disappear —
// Groq is the only one that reports a parseable limit — which reads as "you
// have one provider" rather than "we have numbers for one provider".
//
// This returns a row for every platform with an enabled key, whether or not we
// know anything about its quota, so an unmeasured provider is visibly unknown
// instead of absent.

export interface ProviderQuotaOverviewRow {
  platform: string;
  /** Null when we have no pool identity for this platform yet. */
  pool: string | null;
  used: number | null;
  remaining: number | null;
  limit: number | null;
  remaining_pct: number | null;
  reset_at: string | null;
  seconds_until_reset: number | null;
  low_balance: boolean;
  /** Where the numbers came from: 'header', 'error_body', 'probe', or null when
   *  nothing has ever been observed for this platform. */
  source: string | null;
  confidence: number | null;
  /** False when the provider has never reported a usable limit. The panel shows
   *  these as Unknown rather than implying a healthy pool. */
  metered: boolean;
  /** Who counted the consumption. 'provider' = its own remaining figure.
   *  'local' = we hold a declared limit and counted our own requests against
   *  it, which is an estimate and must not be presented as confirmed. */
  usedSource: 'provider' | 'local' | null;
  /**
   * What the numbers COUNT. Without it a credit balance and a request
   * allowance sit in the same column looking identical: OpenRouter's
   * openrouter::credits reads 1200 (cents of balance) beside a 1000/day
   * free-model request cap, and nothing on the row says they answer different
   * questions.
   */
  metric: string | null;
  /** Denomination of the numbers: 'cents', 'per_10k', or null for a count. */
  unit: string | null;
  /**
   * What the allowance actually holds, for a pool the provider only reports as
   * a fraction. Derived by dividing our own measured usage by the fraction it
   * consumed, so the 'limit' column has something real to show instead of the
   * synthetic 100%. Null until three usable intervals exist.
   */
  derivedAllowance: InferredAllowance | null;
  /** What behaviour suggests, for providers that publish nothing. Empty when
   *  there is no evidence, or when the provider reports its own numbers and
   *  guessing would add nothing. Never merged into `limit`/`remaining` — an
   *  estimate of the window is not a measurement of the balance. */
  inferred: InferredWindowSummary[];
}

export interface InferredWindowSummary {
  period: string;
  method: string;
  samples: number;
  confidence: number;
  note: string;
}

export function getProviderQuotaOverview(now: number = Date.now()): ProviderQuotaOverviewRow[] {
  let db;
  try {
    db = getDb();
  } catch {
    return [];
  }

  const platforms = (db.prepare(
    'SELECT DISTINCT platform FROM api_keys WHERE enabled = 1 ORDER BY platform',
  ).all() as { platform: string }[]).map(r => r.platform);

  const measured = getQuotaForecast();
  const states = getQuotaStateForKeys();
  const rows: ProviderQuotaOverviewRow[] = [];

  for (const platform of platforms) {
    // 1. Pools the PROVIDER reported on. Its own remaining figure beats any
    //    local count, so these are taken as-is.
    const reported = measured.filter(m => m.platform === platform);
    const seenMeasured = new Set<string>(reported.map(r => r.pool ?? ''));
    for (const pool of reported) {
      const state = states.find(s => s.platform === platform && s.quotaPoolKey === pool.pool);
      rows.push({ ...pool, source: state?.source ?? null, confidence: state?.confidence ?? null, metered: true, usedSource: 'provider', inferred: [], metric: 'requests', unit: null, derivedAllowance: null });
    }

    // 1b. Pools the provider measured in some OTHER unit — Ollama Cloud reports
    //     credit usage, not requests. The forecast deliberately keeps only
    //     request windows, because token resets vary too much between providers
    //     to predict; but a provider handing us limit AND remaining needs no
    //     prediction, and dropping it made a measured pool read "Unknown"
    //     beside estimates that read as facts.
    for (const state of states) {
      if (state.platform !== platform) continue;
      if (state.limit == null || state.remaining == null) continue;
      if (state.source !== 'quota_api' && state.source !== 'header') continue;
      if (seenMeasured.has(state.quotaPoolKey)) continue;
      seenMeasured.add(state.quotaPoolKey);
      const remainingPct = Math.max(0, Math.min(100, Math.round((state.remaining / state.limit) * 100)));
      rows.push({
        platform,
        pool: state.quotaPoolKey,
        used: Math.max(0, state.limit - state.remaining),
        remaining: state.remaining,
        limit: state.limit,
        remaining_pct: remainingPct,
        reset_at: state.resetAt ?? null,
        seconds_until_reset: null,
        low_balance: state.remaining / state.limit < LOW_BALANCE_THRESHOLD,
        source: state.source,
        confidence: state.confidence ?? null,
        metered: true,
        usedSource: 'provider',
        inferred: [],
        metric: state.metric,
        unit: state.unit ?? null,
        derivedAllowance: state.unit === 'per_10k' ? allowanceFor(platform, state.quotaPoolKey, now) : null,
      });
    }

    // 2. Limits we KNOW but the provider never reports — an env cap, a catalog
    //    figure, an operator policy. Previously these read as Unknown despite
    //    the limit being in hand: nothing was counting local usage against it.
    //    Only request-metric axes; token windows are not reliably comparable
    //    to the request counters.
    const seenAxes = new Set(reported.map(r => r.pool));
    for (const quota of resolveEffectiveQuotas(platform, null, now)) {
      if (quota.metric !== 'requests') continue;
      if (quota.source === 'provider_header' || quota.source === 'provider_api') continue;
      const poolLabel = `${platform}::${quota.period.kind === 'rolling' ? `rolling-${Math.round(quota.period.windowMs / 1000)}s` : quota.period.kind}`;
      if (seenAxes.has(poolLabel)) continue;
      seenAxes.add(poolLabel);

      const windowMs = quota.window.periodStartMs == null
        ? (quota.period.kind === 'rolling' ? quota.period.windowMs : null)
        : Math.max(1, now - quota.window.periodStartMs);
      if (windowMs == null) continue;

      const used = countPlatformUsageInWindow(platform, 'request', windowMs, now);
      const remaining = Math.max(0, quota.limit - used);
      const secondsUntilReset = quota.window.resetAtMs == null
        ? null
        : Math.max(0, Math.floor((quota.window.resetAtMs - now) / 1000));
      const remainingPct = Math.max(0, Math.min(100, Math.round((remaining / quota.limit) * 100)));

      rows.push({
        platform,
        pool: poolLabel,
        used,
        remaining,
        limit: quota.limit,
        remaining_pct: remainingPct,
        reset_at: quota.window.resetAtMs == null ? null : new Date(quota.window.resetAtMs).toISOString(),
        seconds_until_reset: secondsUntilReset,
        low_balance: remaining / quota.limit < LOW_BALANCE_THRESHOLD,
        source: quota.source,
        confidence: quota.confidence,
        metered: true,
        // The limit is declared; the consumption is ours. Marked so the panel
        // never implies the provider confirmed this number.
        usedSource: 'local',
        inferred: [],
        metric: quota.metric,
        unit: null,
        derivedAllowance: null,
      });
    }

    // 3. Nothing measurable at all. Report the strongest observation we have,
    //    so the row says "we called it and learned nothing" instead of vanishing.
    if (!rows.some(r => r.platform === platform)) {
      const seen = states.filter(s => s.platform === platform);
      const best = seen.find(s => s.source === 'header') ?? seen.find(s => s.source === 'error_body') ?? seen[0];
      rows.push({
        platform,
        pool: best?.quotaPoolKey ?? null,
        used: null, remaining: null, limit: null, remaining_pct: null,
        reset_at: null, seconds_until_reset: null, low_balance: false,
        source: best?.source ?? null,
        confidence: best?.confidence ?? null,
        metered: false,
        usedSource: null,
        inferred: [],
        metric: null,
        unit: null,
        derivedAllowance: null,
      });
    }
  }

  // Behavioural inference, only where it adds something. A provider reporting
  // its own remaining figure needs no estimate, and running this for every
  // platform would scan the request history on every dashboard poll.
  for (const row of rows) {
    if (row.metered && row.usedSource === 'provider') continue;
    row.inferred = inferredWindowsFor(row.platform, now).map(w => ({
      period: w.period,
      method: w.method,
      samples: w.samples,
      confidence: w.confidence,
      note: w.note,
    }));
  }

  // Measured pools first, then unknowns — the rows a reader can act on lead.
  return rows.sort((a, b) => (Number(b.metered) - Number(a.metered)) || a.platform.localeCompare(b.platform));
}

/** Inference reads the whole request history for a platform, and the dashboard
 *  polls. A minute of staleness is invisible in an estimate whose own window is
 *  measured in factors. */
const INFERENCE_TTL_MS = 60_000;
const inferenceCache = new Map<string, { at: number; windows: InferredWindow[] }>();

function inferredWindowsFor(platform: string, now: number): InferredWindow[] {
  const hit = inferenceCache.get(platform);
  if (hit && now - hit.at < INFERENCE_TTL_MS) return hit.windows;
  let windows: InferredWindow[] = [];
  try {
    windows = inferQuotaShape(platform).windows;
  } catch {
    windows = [];
  }
  inferenceCache.set(platform, { at: now, windows });
  return windows;
}

/** Test seam: drop the memoised inferences. */
export function invalidateQuotaInference(): void {
  inferenceCache.clear();
}

/** Deriving an allowance walks the observation series and counts request rows,
 *  and the dashboard polls. A minute of staleness is invisible in a figure
 *  whose own error bar is tens of percent. */
const ALLOWANCE_TTL_MS = 60_000;
const allowanceCache = new Map<string, { at: number; value: InferredAllowance | null }>();

function allowanceFor(platform: string, quotaPoolKey: string, now: number): InferredAllowance | null {
  const cacheKey = `${platform}:${quotaPoolKey}`;
  const hit = allowanceCache.get(cacheKey);
  if (hit && now - hit.at < ALLOWANCE_TTL_MS) return hit.value;
  let value: InferredAllowance | null = null;
  try {
    const all = inferAllowanceFromFraction(platform, quotaPoolKey);
    // Dollars first: measured on real traffic, the token figure swung 4.9x
    // between traffic mixes while the priced one moved 1.3x, because dollars
    // are what the provider is metering. Tokens are the fallback for a mix we
    // cannot price.
    value = all.find(a => a.metric === 'credit_usd')
      ?? all.find(a => a.metric === 'total_tokens')
      ?? all[0] ?? null;
  } catch {
    value = null;
  }
  allowanceCache.set(cacheKey, { at: now, value });
  return value;
}

/** Test seam: drop the memoised allowance derivations. */
export function invalidateDerivedAllowances(): void {
  allowanceCache.clear();
}
