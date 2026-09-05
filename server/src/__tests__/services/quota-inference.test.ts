import { describe, it, expect, beforeEach } from 'vitest';
import { initDb, getDb } from '../../db/index.js';
import { inferWindowFromRefill, inferWindowsFromRecovery, inferQuotaShape } from '../../services/quota-inference.js';

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
