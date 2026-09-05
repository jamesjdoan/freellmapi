import { isValidTimezone } from './scoring.js';

// Quota reset clock (ADR ARCH-20260905, F5).
//
// Two clocks already exist and disagree: per-model RPD/TPD are a rolling 24h
// lookback (`canMakeRequest` passes a fixed DAY width, ratelimit.ts:328) while
// provider-wide caps bucket on UTC midnight (`msSinceUtcMidnight`, :38).
// Neither can express "resets at midnight Pacific", which is how Google's free
// tier actually behaves, and the architecture doc asserted the wrong one of the
// two for years.
//
// This module answers ONE question — given a period description and an instant,
// where does the current window start and when does it reset — with no database,
// no I/O and no ambient timezone. Every zone is passed explicitly; nothing here
// reads `process.env.TZ` or `Date#getHours`, both of which make the answer
// depend on where the server happens to be running.
//
// Nullable on purpose: a rolling window has no reset instant without knowing
// the oldest event in it, and a provider-reported reset has no period start.
// Returning 0 or `now` for those would be a fabricated number that reads
// exactly like a measured one downstream.

/** Milliseconds in the fixed-width windows the rate limiter already uses. */
export const MINUTE_MS = 60_000;
export const HOUR_MS = 3_600_000;
export const DAY_MS = 86_400_000;

/**
 * Parse a timestamp as written by `toSqliteUtc` — `YYYY-MM-DD HH:MM:SS[.mmm]`,
 * a UTC instant with no zone marker.
 *
 * `new Date()` and `Date.parse()` read that shape as LOCAL time, so on a UTC+10
 * host every stored reset came back ten hours early and anything less than ten
 * hours away read as already-past. Found on a dashboard showing "—" for a reset
 * two hours out. Values that already carry a zone (ISO with `Z` or an offset)
 * are passed through untouched.
 */
export function parseStoredUtc(value: string | null | undefined): number | null {
  if (!value) return null;
  const trimmed = value.trim();
  const bare = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(\.\d+)?$/.test(trimmed);
  const ms = Date.parse(bare ? `${trimmed.replace(' ', 'T')}Z` : trimmed);
  return Number.isNaN(ms) ? null : ms;
}


export type QuotaPeriod =
  /** Fixed-width lookback: the window is always [now - windowMs, now]. This is
   *  what the per-model RPM/RPD/TPM/TPD gates enforce today. */
  | { kind: 'rolling'; windowMs: number; oldestEventMs?: number | null }
  /** Local calendar day in `timezone`, resetting at local midnight. */
  | { kind: 'calendar_day'; timezone: string }
  /** ISO week (Monday start) in `timezone`. */
  | { kind: 'calendar_week'; timezone: string }
  /** Local calendar month in `timezone`, resetting on the 1st. */
  | { kind: 'calendar_month'; timezone: string }
  /** Monthly cycle anchored to a signup/billing day rather than the 1st.
   *  `anchorDay` is clamped into any month too short to contain it. */
  | { kind: 'billing_cycle'; timezone: string; anchorDay: number }
  /** The provider stated its own reset instant; we do not model the period. */
  | { kind: 'provider_reported'; resetAtMs: number };

export interface QuotaWindow {
  /** Start of the current window, or null when the period does not define one. */
  periodStartMs: number | null;
  /** When the allowance replenishes, or null when that is not knowable. */
  resetAtMs: number | null;
}

interface ZonedDateParts {
  year: number;
  month: number;
  day: number;
  weekday: number;
}

/** An unknown zone falls back to UTC rather than throwing: a stale settings row
 *  must not be able to break quota accounting. Callers that care record the
 *  policy's own confidence; this function has no opinion to record. */
function safeZone(timezone: string): string {
  return isValidTimezone(timezone) ? timezone : 'UTC';
}

/**
 * Offset of `timeZone` from UTC at `instantMs`, in milliseconds.
 *
 * Derived by formatting the instant in the zone and reading it back as though
 * the wall-clock fields were UTC; the difference is the offset in force at that
 * instant, DST included. There is no `Date` API that gives this directly.
 */
function zoneOffsetMs(instantMs: number, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(instantMs);
  const field = (type: string): number => Number(parts.find(p => p.type === type)?.value ?? '0');
  const asUtc = Date.UTC(
    field('year'), field('month') - 1, field('day'),
    field('hour'), field('minute'), field('second'),
  );
  // Compare whole seconds: formatToParts has no millisecond field, so the
  // sub-second remainder would otherwise leak into the offset.
  return asUtc - (instantMs - (((instantMs % 1000) + 1000) % 1000));
}

function zonedParts(instantMs: number, timeZone: string): ZonedDateParts {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric', month: '2-digit', day: '2-digit', weekday: 'short',
  }).formatToParts(instantMs);
  const field = (type: string): string => parts.find(p => p.type === type)?.value ?? '';
  const WEEKDAYS: Record<string, number> = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 };
  return {
    year: Number(field('year')),
    month: Number(field('month')),
    day: Number(field('day')),
    weekday: WEEKDAYS[field('weekday')] ?? 1,
  };
}

/**
 * The UTC instant of local midnight on `year-month-day` in `timeZone`.
 *
 * Two passes: the offset must be sampled at the instant we are solving for, not
 * at the naive UTC guess, or a boundary that crosses a DST transition lands an
 * hour out. The second pass re-samples at the first pass's answer, which is
 * within an hour of the truth and therefore on the correct side of the
 * transition. Month/day overflow (day 32, month 13) normalises through
 * `Date.UTC`, so callers can add freely.
 */
function zonedMidnightMs(year: number, month: number, day: number, timeZone: string): number {
  const naiveUtc = Date.UTC(year, month - 1, day);
  const firstPass = naiveUtc - zoneOffsetMs(naiveUtc, timeZone);
  return naiveUtc - zoneOffsetMs(firstPass, timeZone);
}

/** Days in a month, so a billing anchor of 31 clamps to the 28th in February
 *  instead of silently rolling into March. */
function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function billingAnchorMs(year: number, month: number, anchorDay: number, timeZone: string): number {
  const clamped = Math.min(Math.max(Math.trunc(anchorDay), 1), daysInMonth(year, month));
  return zonedMidnightMs(year, month, clamped, timeZone);
}

/**
 * Where the current quota window starts and when it resets.
 *
 * Pure: same inputs, same answer, on any host in any zone.
 */
export function resolveQuotaWindow(period: QuotaPeriod, now: number): QuotaWindow {
  switch (period.kind) {
    case 'rolling': {
      const width = period.windowMs > 0 ? period.windowMs : 0;
      // A rolling window frees capacity when its OLDEST event ages out, which
      // is a fact about usage, not about the clock. Without that event there is
      // no reset instant to report, and `now + width` would be a guess that
      // only happens to be right when the window is full.
      const oldest = period.oldestEventMs;
      return {
        periodStartMs: now - width,
        resetAtMs: oldest == null ? null : oldest + width,
      };
    }
    case 'calendar_day': {
      const zone = safeZone(period.timezone);
      const { year, month, day } = zonedParts(now, zone);
      return {
        periodStartMs: zonedMidnightMs(year, month, day, zone),
        resetAtMs: zonedMidnightMs(year, month, day + 1, zone),
      };
    }
    case 'calendar_week': {
      const zone = safeZone(period.timezone);
      const { year, month, day, weekday } = zonedParts(now, zone);
      // ISO: Monday is day 1, so Monday subtracts nothing and Sunday subtracts 6.
      return {
        periodStartMs: zonedMidnightMs(year, month, day - (weekday - 1), zone),
        resetAtMs: zonedMidnightMs(year, month, day - (weekday - 1) + 7, zone),
      };
    }
    case 'calendar_month': {
      const zone = safeZone(period.timezone);
      const { year, month } = zonedParts(now, zone);
      return {
        periodStartMs: zonedMidnightMs(year, month, 1, zone),
        resetAtMs: zonedMidnightMs(year, month + 1, 1, zone),
      };
    }
    case 'billing_cycle': {
      const zone = safeZone(period.timezone);
      const { year, month } = zonedParts(now, zone);
      const thisMonth = billingAnchorMs(year, month, period.anchorDay, zone);
      // Before this month's anchor day, the live cycle is the previous one.
      if (now < thisMonth) {
        const prev = month === 1 ? { y: year - 1, m: 12 } : { y: year, m: month - 1 };
        return {
          periodStartMs: billingAnchorMs(prev.y, prev.m, period.anchorDay, zone),
          resetAtMs: thisMonth,
        };
      }
      const next = month === 12 ? { y: year + 1, m: 1 } : { y: year, m: month + 1 };
      return {
        periodStartMs: thisMonth,
        resetAtMs: billingAnchorMs(next.y, next.m, period.anchorDay, zone),
      };
    }
    case 'provider_reported':
      // The provider told us when, not how long — inventing a start would let a
      // pacing calculation divide by a made-up period length.
      return { periodStartMs: null, resetAtMs: period.resetAtMs };
  }
}

export interface QuotaPacing {
  /** How far through the period we are, 0..1. Null when the period has no
   *  measurable span (provider-reported reset, or an unknown start). */
  elapsedFraction: number | null;
  /** How much of the allowance is spent, 0..1. Null when limit/used unknown. */
  usedFraction: number | null;
  /**
   * `usedFraction - elapsedFraction`. Negative means consumption is behind the
   * clock and the allowance is on course to expire partly unused; positive
   * means it is on course to run out early. Null when either input is unknown —
   * a missing limit is not a pace of zero.
   */
  paceDelta: number | null;
  /** Straight-line projection of total usage by reset, at the current rate. */
  projectedUsageAtReset: number | null;
  /** Allowance projected to go unspent, floored at 0. */
  projectedUnused: number | null;
  /** When usage would hit the limit at the current rate, or null if never
   *  (or not before reset — the caller can compare against `resetAtMs`). */
  projectedExhaustionMs: number | null;
}

const EMPTY_PACING: QuotaPacing = {
  elapsedFraction: null,
  usedFraction: null,
  paceDelta: null,
  projectedUsageAtReset: null,
  projectedUnused: null,
  projectedExhaustionMs: null,
};

/**
 * Pacing for one quota pool. Straight-line extrapolation from the period start,
 * which is the honest model when the only inputs are "how much is spent" and
 * "how far through the window we are" — anything smarter would need a usage
 * time series this does not have.
 */
export function quotaPacing(
  window: QuotaWindow,
  now: number,
  used: number | null,
  limit: number | null,
): QuotaPacing {
  const { periodStartMs, resetAtMs } = window;
  if (periodStartMs == null || resetAtMs == null || resetAtMs <= periodStartMs) return EMPTY_PACING;

  const span = resetAtMs - periodStartMs;
  const elapsed = Math.min(Math.max(now - periodStartMs, 0), span);
  const elapsedFraction = elapsed / span;

  if (used == null || limit == null || limit <= 0) {
    return { ...EMPTY_PACING, elapsedFraction };
  }

  const usedFraction = used / limit;
  // Before any time has passed there is no rate to extrapolate from, and
  // dividing by zero elapsed would project infinity off the first request.
  if (elapsed <= 0) {
    return { ...EMPTY_PACING, elapsedFraction, usedFraction, paceDelta: usedFraction };
  }

  const ratePerMs = used / elapsed;
  const projectedUsageAtReset = used + ratePerMs * (span - elapsed);
  const remaining = limit - used;

  return {
    elapsedFraction,
    usedFraction,
    paceDelta: usedFraction - elapsedFraction,
    projectedUsageAtReset,
    projectedUnused: Math.max(0, limit - projectedUsageAtReset),
    projectedExhaustionMs: ratePerMs > 0 && remaining > 0
      ? now + remaining / ratePerMs
      : ratePerMs > 0 ? now : null,
  };
}
