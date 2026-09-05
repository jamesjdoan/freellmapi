import { describe, it, expect } from 'vitest';
import {
  resolveQuotaWindow,
  quotaPacing,
  MINUTE_MS,
  DAY_MS,
  type QuotaPeriod,
} from '../../services/quota-clock.js';

// The clock is pure — no DB, no fake timers, no process.env.TZ. Every zone is
// passed explicitly, which is the whole point: these assertions must hold on a
// UTC CI box and on a laptop in Europe/London alike.

const iso = (ms: number | null): string | null => (ms == null ? null : new Date(ms).toISOString());

describe('quota-clock: calendar day with timezone', () => {
  it('resets at midnight Pacific, not midnight UTC', () => {
    // DST began 2026-03-08, so Los Angeles is on PDT (UTC-7) here:
    // 2026-03-10T05:00:00Z is 2026-03-09 22:00 local — still the 9th locally
    // while UTC has already rolled into the 10th.
    const now = Date.parse('2026-03-10T05:00:00Z');
    const window = resolveQuotaWindow({ kind: 'calendar_day', timezone: 'America/Los_Angeles' }, now);

    expect(iso(window.periodStartMs)).toBe('2026-03-09T07:00:00.000Z'); // local 03-09 00:00
    expect(iso(window.resetAtMs)).toBe('2026-03-10T07:00:00.000Z');     // local 03-10 00:00
    // The UTC day has already rolled over; the Pacific one has not.
    expect(window.resetAtMs).toBeGreaterThan(now);
    // ...and it is a different instant from the UTC-day answer, which is the
    // whole reason this module exists.
    const utcDay = resolveQuotaWindow({ kind: 'calendar_day', timezone: 'UTC' }, now);
    expect(window.resetAtMs).not.toBe(utcDay.resetAtMs);
  });

  it('resets at midnight UTC when the policy says UTC', () => {
    const now = Date.parse('2026-03-10T05:00:00Z');
    const window = resolveQuotaWindow({ kind: 'calendar_day', timezone: 'UTC' }, now);

    expect(iso(window.periodStartMs)).toBe('2026-03-10T00:00:00.000Z');
    expect(iso(window.resetAtMs)).toBe('2026-03-11T00:00:00.000Z');
  });

  // The reason the offset is sampled twice. US DST began 2026-03-08; a
  // single-pass calculation anchored on the naive UTC guess lands an hour out
  // for the days around the transition.
  it('survives a spring-forward DST transition', () => {
    const now = Date.parse('2026-03-08T20:00:00Z'); // 12:00 PDT on the transition day
    const window = resolveQuotaWindow({ kind: 'calendar_day', timezone: 'America/Los_Angeles' }, now);

    expect(iso(window.periodStartMs)).toBe('2026-03-08T08:00:00.000Z'); // PST midnight
    expect(iso(window.resetAtMs)).toBe('2026-03-09T07:00:00.000Z');     // PDT midnight — 23h day
    expect(window.resetAtMs! - window.periodStartMs!).toBe(23 * 60 * 60 * 1000);
  });

  it('survives a fall-back DST transition', () => {
    const now = Date.parse('2026-11-01T18:00:00Z');
    const window = resolveQuotaWindow({ kind: 'calendar_day', timezone: 'America/Los_Angeles' }, now);

    // 25-hour day: the clock goes back an hour inside it.
    expect(window.resetAtMs! - window.periodStartMs!).toBe(25 * 60 * 60 * 1000);
  });

  it('falls back to UTC on an unknown zone instead of throwing', () => {
    const now = Date.parse('2026-03-10T05:00:00Z');
    const window = resolveQuotaWindow({ kind: 'calendar_day', timezone: 'Mars/Olympus_Mons' }, now);
    expect(iso(window.resetAtMs)).toBe('2026-03-11T00:00:00.000Z');
  });
});

describe('quota-clock: rolling windows', () => {
  it('reports the lookback span and no reset without an oldest event', () => {
    const now = Date.parse('2026-03-10T05:00:00Z');
    const window = resolveQuotaWindow({ kind: 'rolling', windowMs: DAY_MS }, now);

    expect(iso(window.periodStartMs)).toBe('2026-03-09T05:00:00.000Z');
    // A rolling window's reset is a fact about usage, not the clock.
    expect(window.resetAtMs).toBeNull();
  });

  it('reports when the oldest event ages out, when one is known', () => {
    const now = Date.parse('2026-03-10T05:00:00Z');
    const oldest = Date.parse('2026-03-10T04:59:30Z');
    const window = resolveQuotaWindow({ kind: 'rolling', windowMs: MINUTE_MS, oldestEventMs: oldest }, now);

    // 30s into a 60s window → the slot frees 30s from now.
    expect(window.resetAtMs).toBe(oldest + MINUTE_MS);
    expect(window.resetAtMs! - now).toBe(30_000);
  });
});

describe('quota-clock: month and billing cycle', () => {
  it('resets a calendar month on the 1st in the policy zone', () => {
    const now = Date.parse('2026-03-15T12:00:00Z');
    const window = resolveQuotaWindow({ kind: 'calendar_month', timezone: 'UTC' }, now);

    expect(iso(window.periodStartMs)).toBe('2026-03-01T00:00:00.000Z');
    expect(iso(window.resetAtMs)).toBe('2026-04-01T00:00:00.000Z');
  });

  it('rolls a December calendar month into the next year', () => {
    const now = Date.parse('2026-12-20T12:00:00Z');
    const window = resolveQuotaWindow({ kind: 'calendar_month', timezone: 'UTC' }, now);
    expect(iso(window.resetAtMs)).toBe('2027-01-01T00:00:00.000Z');
  });

  it('anchors a billing cycle to the signup day, not the 1st', () => {
    const now = Date.parse('2026-03-20T12:00:00Z');
    const window = resolveQuotaWindow({ kind: 'billing_cycle', timezone: 'UTC', anchorDay: 17 }, now);

    expect(iso(window.periodStartMs)).toBe('2026-03-17T00:00:00.000Z');
    expect(iso(window.resetAtMs)).toBe('2026-04-17T00:00:00.000Z');
  });

  it('uses the previous cycle when now is before this month anchor', () => {
    const now = Date.parse('2026-03-05T12:00:00Z');
    const window = resolveQuotaWindow({ kind: 'billing_cycle', timezone: 'UTC', anchorDay: 17 }, now);

    expect(iso(window.periodStartMs)).toBe('2026-02-17T00:00:00.000Z');
    expect(iso(window.resetAtMs)).toBe('2026-03-17T00:00:00.000Z');
  });

  it('clamps an anchor day into a month too short to hold it', () => {
    const now = Date.parse('2026-02-15T12:00:00Z');
    const window = resolveQuotaWindow({ kind: 'billing_cycle', timezone: 'UTC', anchorDay: 31 }, now);

    // 2026 is not a leap year: the cycle anchors on the 28th, not 03-03.
    expect(iso(window.periodStartMs)).toBe('2026-01-31T00:00:00.000Z');
    expect(iso(window.resetAtMs)).toBe('2026-02-28T00:00:00.000Z');
  });
});

describe('quota-clock: provider-reported reset', () => {
  it('takes the provider instant and claims no period start', () => {
    const resetAtMs = Date.parse('2026-03-10T06:30:00Z');
    const window = resolveQuotaWindow({ kind: 'provider_reported', resetAtMs }, Date.parse('2026-03-10T05:00:00Z'));

    expect(window.resetAtMs).toBe(resetAtMs);
    // We were told when, not how long — a start would be invented.
    expect(window.periodStartMs).toBeNull();
  });
});

describe('quota-clock: pacing', () => {
  const dayWindow = (): QuotaPeriod => ({ kind: 'calendar_day', timezone: 'UTC' });

  it('reports negative pace when the allowance is going unspent', () => {
    const now = Date.parse('2026-03-10T16:48:00Z'); // 70% through the UTC day
    const window = resolveQuotaWindow(dayWindow(), now);
    const pacing = quotaPacing(window, now, 150, 1000); // 15% used

    expect(pacing.elapsedFraction).toBeCloseTo(0.7, 3);
    expect(pacing.usedFraction).toBeCloseTo(0.15, 3);
    expect(pacing.paceDelta).toBeCloseTo(-0.55, 3);
    // At this rate roughly 214 of 1000 get used — most of the pool expires.
    expect(pacing.projectedUsageAtReset).toBeCloseTo(1000 * 0.15 / 0.7, 0);
    expect(pacing.projectedUnused).toBeGreaterThan(750);
  });

  it('reports positive pace and an exhaustion time when running hot', () => {
    const now = Date.parse('2026-03-10T06:00:00Z'); // 25% through the day
    const window = resolveQuotaWindow(dayWindow(), now);
    const pacing = quotaPacing(window, now, 750, 1000); // 75% used

    expect(pacing.paceDelta).toBeCloseTo(0.5, 3);
    expect(pacing.projectedUnused).toBe(0);
    // 250 left at 750-per-6h burns out two hours from now, before reset.
    expect(pacing.projectedExhaustionMs).toBe(now + 2 * 60 * 60 * 1000);
    expect(pacing.projectedExhaustionMs!).toBeLessThan(window.resetAtMs!);
  });

  it('has no opinion when the limit is unknown', () => {
    const now = Date.parse('2026-03-10T12:00:00Z');
    const window = resolveQuotaWindow(dayWindow(), now);
    const pacing = quotaPacing(window, now, 500, null);

    // Elapsed time is still knowable; a missing limit is not a pace of zero.
    expect(pacing.elapsedFraction).toBeCloseTo(0.5, 3);
    expect(pacing.paceDelta).toBeNull();
    expect(pacing.projectedUnused).toBeNull();
  });

  it('has no opinion on a provider-reported window with no start', () => {
    const now = Date.parse('2026-03-10T12:00:00Z');
    const window = resolveQuotaWindow({ kind: 'provider_reported', resetAtMs: now + 1000 }, now);
    expect(quotaPacing(window, now, 10, 100).paceDelta).toBeNull();
  });

  it('does not project off a zero-length elapsed span', () => {
    const now = Date.parse('2026-03-10T00:00:00Z'); // exactly the period start
    const window = resolveQuotaWindow(dayWindow(), now);
    const pacing = quotaPacing(window, now, 5, 100);

    expect(pacing.elapsedFraction).toBe(0);
    expect(pacing.projectedUsageAtReset).toBeNull();
    expect(pacing.projectedExhaustionMs).toBeNull();
  });
});
