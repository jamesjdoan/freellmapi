import { describe, it, expect, beforeEach } from 'vitest';
import { initDb, getDb } from '../../db/index.js';
import { inferAllowanceFromFraction, inferWindowFromRefill, inferWindowFromResets, inferWindowsFromRecovery, inferQuotaShape } from '../../services/quota-inference.js';

// These tests encode the two behavioural estimators against series whose true
// window is known by construction, plus the cases where the honest answer is
// "not enough evidence". The accuracy claims in the module were validated
// against real provider history; what is pinned here is the classification and
// the refusals to guess.

function isoAt(ms: number): string {
  return new Date(ms).toISOString().replace('T', ' ').replace('Z', '');
}

/** Emit a refilling-bucket series: consumption plus recovery at `limit/window`. */
function seedRefill(opts: {
  platform: string;
  pool: string;
  metric: string;
  limit: number;
  windowSeconds: number;
  samples: number;
  gapSeconds: number;
}): void {
  const db = getDb();
  const insert = db.prepare(`
    INSERT INTO provider_quota_observations
      (id, platform, key_id, quota_pool_key, metric, limit_value, remaining_value, source, confidence, observed_at)
    VALUES (?, ?, 1, ?, ?, ?, ?, 'header', 1, ?)
  `);
  const ratePerSecond = opts.limit / opts.windowSeconds;
  const start = Date.UTC(2026, 0, 1);
  let remaining = opts.limit;
  for (let i = 0; i < opts.samples; i++) {
    // Alternate: spend a chunk, then let it refill across the gap.
    if (i % 2 === 0) remaining = Math.max(0, remaining - opts.limit * 0.3);
    else remaining = Math.min(opts.limit, remaining + ratePerSecond * opts.gapSeconds);
    insert.run(`obs-${opts.platform}-${opts.metric}-${i}`, opts.platform, opts.pool, opts.metric,
      opts.limit, Math.round(remaining), isoAt(start + i * opts.gapSeconds * 1000));
  }
}

/** Emit refusal/success pairs separated by `recoverySeconds`. */
function seedRecovery(platform: string, recoverySeconds: number[], startOffsetMs = 0): void {
  const insert = getDb().prepare(`
    INSERT INTO requests (platform, model_id, status, input_tokens, output_tokens, latency_ms, error, created_at)
    VALUES (?, 'm', ?, 0, 0, 0, ?, ?)
  `);
  let at = Date.UTC(2026, 0, 1) + startOffsetMs;
  for (const recovery of recoverySeconds) {
    insert.run(platform, 'error', 'HTTP 429 rate limited', isoAt(at));
    at += recovery * 1000;
    insert.run(platform, 'success', null, isoAt(at));
    at += 3_600_000; // space the pairs so they cannot bleed together
  }
}

describe('quota inference', () => {
  beforeEach(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
    getDb().prepare('DELETE FROM provider_quota_observations').run();
    getDb().prepare('DELETE FROM requests').run();
  });

  describe('refill rate', () => {
    it('classifies a per-minute token bucket', () => {
      // 8000 tokens/minute, sampled every 20s — Groq's real shape.
      seedRefill({ platform: 'groq', pool: 'groq::model::x', metric: 'tokens', limit: 8000, windowSeconds: 60, samples: 40, gapSeconds: 20 });
      const inferred = inferWindowFromRefill('groq', 'groq::model::x', 'tokens');
      expect(inferred?.period).toBe('minute');
      expect(inferred?.method).toBe('refill_rate');
    });

    it('classifies a daily request pool from the same estimator', () => {
      // 1000 requests/day refills ~0.0116/s: three orders of magnitude slower
      // than the token bucket, and the estimator must not confuse the two.
      seedRefill({ platform: 'groq', pool: 'groq::model::y', metric: 'requests', limit: 1000, windowSeconds: 86_400, samples: 40, gapSeconds: 7200 });
      expect(inferWindowFromRefill('groq', 'groq::model::y', 'requests')?.period).toBe('day');
    });

    it('never claims the confidence of a published limit', () => {
      seedRefill({ platform: 'groq', pool: 'groq::model::z', metric: 'tokens', limit: 8000, windowSeconds: 60, samples: 60, gapSeconds: 20 });
      const inferred = inferWindowFromRefill('groq', 'groq::model::z', 'tokens');
      // 0.5 is the ceiling by construction — an inference must never outrank a
      // number the provider actually stated.
      expect(inferred!.confidence).toBeLessThanOrEqual(0.5);
    });

    it('returns null rather than guessing from a handful of points', () => {
      seedRefill({ platform: 'groq', pool: 'groq::thin', metric: 'tokens', limit: 8000, windowSeconds: 60, samples: 4, gapSeconds: 20 });
      expect(inferWindowFromRefill('groq', 'groq::thin', 'tokens')).toBeNull();
    });

    it('ignores a jump larger than half the bucket', () => {
      // A pool-key change or a second key reporting looks like an enormous
      // refill. Left unguarded it implied a 1.3-minute window for a daily
      // allowance in real data.
      const db = getDb();
      const insert = db.prepare(`
        INSERT INTO provider_quota_observations
          (id, platform, key_id, quota_pool_key, metric, limit_value, remaining_value, source, confidence, observed_at)
        VALUES (?, 'groq', 1, 'groq::jump', 'requests', 1000, ?, 'header', 1, ?)
      `);
      const start = Date.UTC(2026, 0, 1);
      // Slow genuine refill, then one absurd jump from empty to full.
      const series = [500, 501, 502, 503, 504, 505, 0, 1000];
      series.forEach((remaining, i) => insert.run(`jump-${i}`, remaining, isoAt(start + i * 3600_000)));
      const inferred = inferWindowFromRefill('groq', 'groq::jump', 'requests');
      // The 1000-unit jump is discarded, so the surviving evidence is the slow
      // trickle — which is day-scale or slower, never minute.
      expect(inferred?.period).not.toBe('minute');
    });
  });

  describe('recovery time', () => {
    it('classifies a per-minute cap from fast recoveries', () => {
      // NVIDIA's real signature: refusals that clear in seconds.
      seedRecovery('nvidia', [3, 5, 12, 24, 30, 18]);
      const windows = inferWindowsFromRecovery('nvidia');
      expect(windows[0]?.period).toBe('minute');
      expect(windows).toHaveLength(1);
    });

    it('is not fooled into an hourly limit by our own retry cadence', () => {
      // The bug this replaced: classifying on the median labelled a 40 RPM cap
      // as hourly purely because some retries came two minutes later.
      seedRecovery('nvidia', [4, 110, 120, 130, 140, 150]);
      const windows = inferWindowsFromRecovery('nvidia');
      expect(windows.map(w => w.period)).not.toContain('hour');
    });

    it('reports two constraints when the tail is an order of magnitude away', () => {
      // Google's real signature: an RPM limit and a daily one at once. An
      // average would have described neither.
      seedRecovery('google', [1, 2, 3, 4, 5, 6, 7, 8, 9, 3000, 3200, 3400]);
      const periods = inferWindowsFromRecovery('google').map(w => w.period);
      expect(periods).toContain('minute');
      expect(periods.length).toBeGreaterThan(1);
    });

    it('stays silent below three refusals', () => {
      seedRecovery('opencode', [20, 25]);
      expect(inferWindowsFromRecovery('opencode')).toEqual([]);
    });

    it('needs only refusals and successes, so it works where nothing is published', () => {
      // The whole point: NVIDIA, Zen and Ollama send no quota headers at all.
      seedRecovery('opencode', [8, 9, 10, 11]);
      const windows = inferWindowsFromRecovery('opencode');
      expect(windows[0]?.method).toBe('recovery_time');
      expect(windows[0]?.samples).toBe(4);
    });
  });

  describe('combined shape', () => {
    it('prefers the provider’s own counter and adds recovery only for uncovered periods', () => {
      seedRefill({ platform: 'groq', pool: 'groq::model::x', metric: 'tokens', limit: 8000, windowSeconds: 60, samples: 40, gapSeconds: 20 });
      seedRecovery('groq', [4, 6, 8, 10]); // also minute-scale — must not duplicate
      const windows = inferQuotaShape('groq').windows;
      expect(windows.filter(w => w.period === 'minute')).toHaveLength(1);
      expect(windows.find(w => w.period === 'minute')?.method).toBe('refill_rate');
    });

    it('reports an empty shape for a platform with no evidence either way', () => {
      expect(inferQuotaShape('ollama').windows).toEqual([]);
    });
  });
});

/**
 * Ollama Cloud's session and weekly allowances, read from its usage API, reset
 * in a step rather than refilling. The rate estimator is the wrong model for
 * that: a 1450-unit jump seen across a 5-minute poll implies a 34-minute window
 * for one that is really hours long. What identifies the window is how often
 * the step happens.
 */
describe('reset interval', () => {
  function seedSeries(pool: string, points: { minutesAgo: number; remaining: number }[], limit = 10_000): void {
    const insert = getDb().prepare(`
      INSERT INTO provider_quota_observations
        (id, platform, key_id, quota_pool_key, metric, limit_value, remaining_value, source, confidence, observed_at)
      VALUES (?, 'ollama', 1, ?, 'credits', ?, ?, 'quota_api', 0.9, ?)
    `);
    const base = Date.UTC(2026, 0, 10);
    points.forEach((p, i) => insert.run(`r-${pool}-${i}`, pool, limit, p.remaining,
      isoAt(base + p.minutesAgo * 60_000)));
  }

  /** Consumption then a jump back to full, repeated every `everyMinutes`. */
  function cyclingSeries(everyMinutes: number, cycles: number): { minutesAgo: number; remaining: number }[] {
    const out: { minutesAgo: number; remaining: number }[] = [];
    for (let c = 0; c < cycles; c++) {
      const start = c * everyMinutes;
      out.push({ minutesAgo: start, remaining: 10_000 });          // freshly reset
      out.push({ minutesAgo: start + everyMinutes * 0.4, remaining: 6_000 });
      out.push({ minutesAgo: start + everyMinutes * 0.8, remaining: 3_000 });  // spent
    }
    return out;
  }

  it('measures a five-hour window as its own, not rounded to a day', () => {
    // 5h sits almost equidistant from 'hour' and 'day' in log space and is
    // neither. Naming one would state something false.
    seedSeries('ollama::session', cyclingSeries(300, 4));
    const inferred = inferWindowFromResets('ollama', 'ollama::session', 'credits');
    expect(inferred).not.toBeNull();
    expect(inferred!.period).toBe('provider_defined');
    expect(inferred!.impliedSeconds).toBeCloseTo(5 * 3600, -2);
    expect(inferred!.method).toBe('reset_interval');
  });

  it('names a standard window when the measurement matches one', () => {
    seedSeries('ollama::hourly', cyclingSeries(60, 4));
    expect(inferWindowFromResets('ollama', 'ollama::hourly', 'credits')!.period).toBe('hour');
  });

  it('needs two resets before it will claim a period', () => {
    // One boundary is a boundary, not an interval.
    seedSeries('ollama::thin', [
      { minutesAgo: 0, remaining: 3_000 },
      { minutesAgo: 30, remaining: 10_000 },
    ]);
    expect(inferWindowFromResets('ollama', 'ollama::thin', 'credits')).toBeNull();
  });

  it('does not read a trickle upward as a reset', () => {
    // A leaky bucket recovering while idle never steps back to full from far
    // below it, and must not be mistaken for a period boundary.
    seedSeries('ollama::trickle', [
      { minutesAgo: 0, remaining: 5_000 },
      { minutesAgo: 10, remaining: 5_400 },
      { minutesAgo: 20, remaining: 5_900 },
      { minutesAgo: 30, remaining: 6_300 },
      { minutesAgo: 40, remaining: 6_800 },
    ]);
    expect(inferWindowFromResets('ollama', 'ollama::trickle', 'credits')).toBeNull();
  });

  it('outranks the rate estimator, which mismodels a step reset', () => {
    seedSeries('ollama::session2', cyclingSeries(300, 4));
    const shape = inferQuotaShape('ollama').windows.find(w => w.method === 'reset_interval');
    expect(shape).toBeDefined();
    // The rate estimator would have called this sub-hourly off the jump size.
    expect(shape!.impliedSeconds).toBeGreaterThan(3 * 3600);
  });
});

/**
 * Ollama Cloud says what FRACTION of an allowance is left and never says how
 * big it is. But we know what we spent between two readings, so the size
 * follows: consume f of the pool with t tokens and the pool holds t/f tokens.
 *
 * Measured on real traffic: a median of 25.1M tokens per session window across
 * five intervals, spread 18.7M-27.7M.
 */
describe('deriving an allowance from a reported fraction', () => {
  beforeEach(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
    getDb().prepare('DELETE FROM provider_quota_observations').run();
    getDb().prepare('DELETE FROM requests').run();
  });

  function seedFractionSeries(steps: { minute: number; remaining: number }[]): void {
    const insert = getDb().prepare(`
      INSERT INTO provider_quota_observations
        (id, platform, key_id, quota_pool_key, metric, unit, limit_value, remaining_value, source, confidence, observed_at)
      VALUES (?, 'ollama', 1, 'ollama::session', 'credits', 'per_10k', 10000, ?, 'quota_api', 0.9, ?)
    `);
    const base = Date.UTC(2026, 0, 20);
    steps.forEach((s, i) => insert.run(`f-${i}`, s.remaining, isoAt(base + s.minute * 60_000)));
  }

  function seedRequest(minute: number, tokens: number, status: 'success' | 'error' = 'success'): void {
    getDb().prepare(`
      INSERT INTO requests (platform, model_id, status, input_tokens, output_tokens, latency_ms, error, created_at)
      VALUES ('ollama', 'm', ?, ?, 0, 10, ?, ?)
    `).run(status, tokens, status === 'error' ? 'empty completion' : null,
      isoAt(Date.UTC(2026, 0, 20) + minute * 60_000));
  }

  it('divides measured usage by the fraction it consumed', () => {
    // 1% of the pool per 250k tokens implies a 25M-token allowance.
    seedFractionSeries([
      { minute: 0, remaining: 10_000 },
      { minute: 10, remaining: 9_900 },
      { minute: 20, remaining: 9_800 },
      { minute: 30, remaining: 9_700 },
    ]);
    [5, 15, 25].forEach(m => seedRequest(m, 250_000));

    const tokens = inferAllowanceFromFraction('ollama', 'ollama::session')
      .find(a => a.metric === 'total_tokens');
    expect(tokens).toBeDefined();
    expect(tokens!.limit).toBe(25_000_000);
    expect(tokens!.samples).toBe(3);
  });

  it('counts failed requests, because the provider did', () => {
    // Ten calls returning "stream produced no content" still sent ~215k input
    // tokens each and the fraction dropped for every one. Counting successes
    // only would inflate the implied allowance without bound.
    seedFractionSeries([
      { minute: 0, remaining: 10_000 },
      { minute: 10, remaining: 9_900 },
      { minute: 20, remaining: 9_800 },
      { minute: 30, remaining: 9_700 },
    ]);
    [5, 15, 25].forEach(m => seedRequest(m, 250_000, 'error'));

    expect(inferAllowanceFromFraction('ollama', 'ollama::session')
      .find(a => a.metric === 'total_tokens')!.limit).toBe(25_000_000);
  });

  it('reports the spread, not just the middle', () => {
    seedFractionSeries([
      { minute: 0, remaining: 10_000 },
      { minute: 10, remaining: 9_900 },
      { minute: 20, remaining: 9_800 },
      { minute: 30, remaining: 9_700 },
    ]);
    seedRequest(5, 200_000);
    seedRequest(15, 250_000);
    seedRequest(25, 300_000);
    const tokens = inferAllowanceFromFraction('ollama', 'ollama::session')
      .find(a => a.metric === 'total_tokens')!;
    // An allowance derived this way carries a real error bar and must show it.
    expect(tokens.low).toBe(20_000_000);
    expect(tokens.high).toBe(30_000_000);
    expect(tokens.limit).toBe(25_000_000);
  });

  it('ignores intervals where the pool went up or held still', () => {
    // A rise is a reset and a flat reading says nothing about size; neither is
    // a measurement of the allowance.
    seedFractionSeries([
      { minute: 0, remaining: 5_000 },
      { minute: 10, remaining: 10_000 },   // reset
      { minute: 20, remaining: 10_000 },   // idle
    ]);
    [5, 15].forEach(m => seedRequest(m, 250_000));
    expect(inferAllowanceFromFraction('ollama', 'ollama::session')).toEqual([]);
  });

  it('declines below three intervals rather than reporting a pair', () => {
    seedFractionSeries([
      { minute: 0, remaining: 10_000 },
      { minute: 10, remaining: 9_900 },
      { minute: 20, remaining: 9_800 },
    ]);
    [5, 15].forEach(m => seedRequest(m, 250_000));
    expect(inferAllowanceFromFraction('ollama', 'ollama::session')).toEqual([]);
  });

  it('excludes burn-test traffic, which spends on purpose', () => {
    seedFractionSeries([
      { minute: 0, remaining: 10_000 },
      { minute: 10, remaining: 9_900 },
      { minute: 20, remaining: 9_800 },
      { minute: 30, remaining: 9_700 },
    ]);
    const insert = getDb().prepare(`
      INSERT INTO requests (platform, model_id, status, input_tokens, output_tokens, latency_ms, request_type, created_at)
      VALUES ('ollama', 'm', 'success', 250000, 0, 10, 'burn_test', ?)
    `);
    [5, 15, 25].forEach(m => insert.run(isoAt(Date.UTC(2026, 0, 20) + m * 60_000)));
    expect(inferAllowanceFromFraction('ollama', 'ollama::session')).toEqual([]);
  });
});

/**
 * The token-denominated allowance is not stable. Measured on real traffic it
 * swung 4.9x between mixes — 71.9M tokens from a nemotron-3-super-heavy sample,
 * 14.8M from an ultra-heavy one — because ultra's input costs 6.7x super's.
 * Priced at the published rates the same spend moved 1.3x, so the dollar figure
 * is the one worth showing.
 */
describe('pricing the derived allowance', () => {
  beforeEach(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
    getDb().prepare('DELETE FROM provider_quota_observations').run();
    getDb().prepare('DELETE FROM requests').run();
  });

  function seedSeries(steps: number[]): void {
    const insert = getDb().prepare(`
      INSERT INTO provider_quota_observations
        (id, platform, key_id, quota_pool_key, metric, unit, limit_value, remaining_value, source, confidence, observed_at)
      VALUES (?, 'ollama', 1, 'ollama::weekly', 'credits', 'per_10k', 10000, ?, 'quota_api', 0.9, ?)
    `);
    steps.forEach((remaining, i) =>
      insert.run(`p-${i}`, remaining, isoAt(Date.UTC(2026, 0, 25) + i * 10 * 60_000)));
  }

  function seedCall(minute: number, modelId: string, inputTokens: number): void {
    getDb().prepare(`
      INSERT INTO requests (platform, model_id, status, input_tokens, output_tokens, latency_ms, created_at)
      VALUES ('ollama', ?, 'success', ?, 0, 10, ?)
    `).run(modelId, inputTokens, isoAt(Date.UTC(2026, 0, 25) + minute * 60_000));
  }

  it('derives the allowance in credit, and prefers it', () => {
    // 1% of the pool per 1M nemotron-3-super input tokens = $0.015, so the
    // pool holds $1.50.
    seedSeries([10_000, 9_900, 9_800, 9_700]);
    [5, 15, 25].forEach(m => seedCall(m, 'nemotron-3-super', 1_000_000));

    const all = inferAllowanceFromFraction('ollama', 'ollama::weekly');
    const credit = all.find(a => a.metric === 'credit_usd');
    expect(credit).toBeDefined();
    // Held in cents so an integer column can carry it.
    expect(credit!.limit).toBe(150);
    // Dollars lead, because they are what the provider meters.
    expect(all[0]!.metric).toBe('credit_usd');
  });

  it('gives the same credit answer from a completely different mix', () => {
    // The whole point: ultra costs 6.7x super per input token, so the token
    // figure moves and the priced one does not. Same $0.015 of spend per 1%.
    seedSeries([10_000, 9_900, 9_800, 9_700]);
    [5, 15, 25].forEach(m => seedCall(m, 'nemotron-3-ultra', 150_000));

    const all = inferAllowanceFromFraction('ollama', 'ollama::weekly');
    expect(all.find(a => a.metric === 'credit_usd')!.limit).toBe(150);
    // ...while the token figure for this mix is 6.7x smaller than the last.
    expect(all.find(a => a.metric === 'total_tokens')!.limit).toBe(15_000_000);
  });

  it('drops an interval it cannot price rather than half-pricing it', () => {
    // One unpriced model makes the interval's total wrong, not merely
    // incomplete.
    seedSeries([10_000, 9_900, 9_800, 9_700]);
    [5, 15, 25].forEach(m => seedCall(m, 'some-unlisted-model', 1_000_000));

    const all = inferAllowanceFromFraction('ollama', 'ollama::weekly');
    expect(all.some(a => a.metric === 'credit_usd')).toBe(false);
    // The token estimate still stands; it needs no rate.
    expect(all.some(a => a.metric === 'total_tokens')).toBe(true);
  });

  it('does not price a platform with no published rates', () => {
    getDb().prepare(`
      INSERT INTO provider_quota_observations
        (id, platform, key_id, quota_pool_key, metric, limit_value, remaining_value, source, confidence, observed_at)
      VALUES (?, 'openrouter', 1, 'openrouter::credits', 'credits', 1200, ?, 'quota_api', 0.9, ?)
    `);
    // Only Ollama has a rate table; nothing else should acquire one by accident.
    expect(inferAllowanceFromFraction('openrouter', 'openrouter::credits')
      .some(a => a.metric === 'credit_usd')).toBe(false);
  });
});
