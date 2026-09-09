import { describe, it, expect, beforeEach } from 'vitest';
import { initDb, getDb } from '../../db/index.js';
import { encrypt } from '../../lib/crypto.js';
import {
  poolPressureFactor,
  diversityFactor,
  pressurePenaltyPositions,
  UNKNOWN_POOL_PRESSURE,
  HARVEST_MAX_BOOST,
  poolPressureParts,
  DIVERSITY_MAX_DAMP,
  MAX_PENALTY,
} from '../../services/scoring.js';
import {
  quotaPressure,

  inFlightPoolShare,
  poolDiversityFactor,
  invalidateQuotaPressure,
} from '../../services/quota-pressure.js';
import { upsertQuotaPolicy } from '../../services/quota-policy.js';
import { DAY_MS } from '../../services/quota-clock.js';
import { invalidateShadowCounts, setCooldown, acquireLease, releaseLease, resetLeases } from '../../services/ratelimit.js';

function reset(): void {
  process.env.ENCRYPTION_KEY = '0'.repeat(64);
  initDb(':memory:');
  const db = getDb();
  db.prepare('DELETE FROM fallback_config').run();
  db.prepare('DELETE FROM profile_models').run();
  db.prepare('DELETE FROM models').run();
  db.prepare('DELETE FROM api_keys').run();
  db.prepare('DELETE FROM quota_policy').run();
  db.prepare('DELETE FROM provider_quota_state').run();
  db.prepare('DELETE FROM rate_limit_usage').run();
  db.prepare("DELETE FROM settings WHERE key = 'quota_reservation_weights'").run();
  invalidateShadowCounts();
  invalidateQuotaPressure();
}

function addKey(platform: string): number {
  const secret = encrypt(`${platform}-pressure-test-key`);
  const info = getDb().prepare(`
    INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled)
    VALUES (?, 'pressure-test', ?, ?, ?, 'healthy', 1)
  `).run(platform, secret.encrypted, secret.iv, secret.authTag);
  return Number(info.lastInsertRowid);
}

function spendRequests(platform: string, modelId: string, keyId: number, n: number): void {
  const stmt = getDb().prepare(
    "INSERT INTO rate_limit_usage (platform, model_id, key_id, kind, tokens, created_at_ms) VALUES (?, ?, ?, 'request', 0, ?)",
  );
  for (let i = 0; i < n; i++) stmt.run(platform, modelId, keyId, Date.now());
  invalidateShadowCounts();
  invalidateQuotaPressure();
}

describe('pool pressure: unknown quota is not unlimited quota', () => {
  it('ranks an unmeasured pool between exhausted and fresh', () => {
    const unknown = poolPressureFactor({ headroom: null, paceDelta: null, msToReset: null });
    const fresh = poolPressureFactor({ headroom: 1, paceDelta: null, msToReset: null });
    const spent = poolPressureFactor({ headroom: 0, paceDelta: null, msToReset: null });

    expect(unknown).toBe(UNKNOWN_POOL_PRESSURE);
    expect(unknown).toBeLessThan(fresh);
    expect(unknown).toBeGreaterThan(spent);
  });

  it('does not let an unknown pool harvest its way out of the penalty', () => {
    // An unknown reset must never read as imminent: without this an unmeasured
    // provider would be relaxed back to full score on no evidence at all.
    const withoutReset = poolPressureFactor({ headroom: null, paceDelta: -0.9, msToReset: null, windowMs: null });
    expect(withoutReset).toBe(UNKNOWN_POOL_PRESSURE);
  });
});

describe('pool pressure: scarcity', () => {
  it('leaves a comfortable pool alone and demotes one that is nearly spent', () => {
    const comfortable = poolPressureFactor({ headroom: 0.8, paceDelta: null, msToReset: null });
    const tight = poolPressureFactor({ headroom: 0.1, paceDelta: null, msToReset: null });
    const nearlyGone = poolPressureFactor({ headroom: 0.02, paceDelta: null, msToReset: null });

    expect(comfortable).toBe(1);
    expect(tight).toBeLessThan(1);
    expect(nearlyGone).toBeLessThan(tight);
  });

  it('holds back a reserved pool harder than an unreserved one at the same headroom', () => {
    const open = poolPressureFactor({ headroom: 0.5, paceDelta: null, msToReset: null, reservationWeight: 1 });
    const held = poolPressureFactor({ headroom: 0.5, paceDelta: null, msToReset: null, reservationWeight: 0.25 });
    expect(held).toBeLessThan(open);
  });

  it('never lets the SCARCITY half exceed 1, so a guardrail can only demote', () => {
    // The guardrail invariant is about scarcity specifically. Harvesting is a
    // preference and is deliberately allowed above 1 — see the next block —
    // which is why the two are returned separately and only scarcity joins the
    // `min` over the other quota meters.
    const generous = poolPressureParts({ headroom: 1, paceDelta: -0.95, msToReset: 60_000, windowMs: DAY_MS });
    expect(generous.scarcity).toBeLessThanOrEqual(1);
    expect(generous.harvest).toBeGreaterThan(1);
  });
});

describe('pool pressure: reset-urgency harvesting', () => {
  it('prefers a healthy pool whose unspent allowance is about to expire', () => {
    // The brief's own case, and the one the first implementation could not
    // express: 80% of a daily allowance still there, 45 minutes before it is
    // wiped. There is no scarcity penalty at 80% headroom, so expressing
    // harvesting as relief from one meant this produced no effect at all.
    const expiring = poolPressureParts({
      headroom: 0.8, paceDelta: -0.74, msToReset: 45 * 60_000, windowMs: DAY_MS,
    });
    expect(expiring.scarcity).toBe(1);
    expect(expiring.harvest).toBeGreaterThan(1);
  });

  it('judges imminence against the pool period, not a fixed number of minutes', () => {
    // Twelve hours out is nowhere near the end of a DAILY window — its harvest
    // zone is the last six hours — but it is well inside a WEEKLY one, whose
    // zone is the last forty-two. A fixed horizon cannot express that, and got
    // the daily case (the brief's own) wrong in the direction that matters.
    const input = { headroom: 0.8, paceDelta: -0.74, msToReset: 12 * 60 * 60_000 };
    const daily = poolPressureParts({ ...input, windowMs: DAY_MS });
    const weekly = poolPressureParts({ ...input, windowMs: 7 * DAY_MS });
    expect(daily.harvest).toBe(1);
    expect(weekly.harvest).toBeGreaterThan(1);
  });

  it('also relaxes the penalty on a scarce pool about to reset', () => {
    const input = { headroom: 0.05, paceDelta: -0.8, windowMs: DAY_MS };
    const farOff = poolPressureFactor({ ...input, msToReset: 12 * 60 * 60_000 });
    const imminent = poolPressureFactor({ ...input, msToReset: 5 * 60_000 });
    expect(imminent).toBeGreaterThan(farOff);
  });

  it('does not harvest a pool that spent its allowance on schedule', () => {
    // Time alone must not trigger it: steering more traffic at a pool that is
    // on pace to run out just brings the refusal forward.
    const onPace = poolPressureParts({ headroom: 0.5, paceDelta: 0, msToReset: 5 * 60_000, windowMs: DAY_MS });
    expect(onPace.harvest).toBe(1);
  });

  it('does not harvest a rolling window, which has no deadline to beat', () => {
    const rolling = poolPressureParts({ headroom: 0.5, paceDelta: -0.9, msToReset: null, windowMs: null });
    expect(rolling.harvest).toBe(1);
  });

  it('caps the preference so it cannot outrank a materially better route', () => {
    const maxed = poolPressureParts({ headroom: 1, paceDelta: -1, msToReset: 1, windowMs: DAY_MS });
    expect(maxed.harvest).toBeLessThanOrEqual(1 + HARVEST_MAX_BOOST);
  });
});

describe('pool pressure: every governing domain must permit the route', () => {
  beforeEach(reset);

  it('takes the worst axis, so a spent account pool sinks a model with capacity left', () => {
    const keyId = addKey('groq');
    // The model's own daily allowance is barely touched…
    upsertQuotaPolicy({
      platform: 'groq', modelId: 'openai/gpt-oss-120b', endpointScope: null,
      scope: 'model', metric: 'requests', limit: 1000,
      periodKind: 'rolling', periodMs: 86_400_000, timezone: null, anchorDay: null,
      source: 'operator',
    });
    spendRequests('groq', 'openai/gpt-oss-120b', keyId, 10);

    const roomy = quotaPressure('groq', 'openai/gpt-oss-120b', '');
    expect(roomy.factor).toBe(1);
    expect(roomy.headroom).toBeGreaterThan(0.9);

    // …but the account-wide pool the same requests also consumed is nearly gone.
    upsertQuotaPolicy({
      platform: 'groq', modelId: null, endpointScope: null,
      scope: 'provider_account', metric: 'requests', limit: 11,
      periodKind: 'rolling', periodMs: 86_400_000, timezone: null, anchorDay: null,
      source: 'operator',
    });
    invalidateQuotaPressure();

    const bound = quotaPressure('groq', 'openai/gpt-oss-120b', '');
    expect(bound.headroom).toBeLessThan(0.2);
    expect(bound.factor).toBeLessThan(roomy.factor);
  });

  it('keeps an independent model pool available when a sibling model is spent', () => {
    const keyId = addKey('groq');
    for (const modelId of ['openai/gpt-oss-120b', 'openai/gpt-oss-20b']) {
      upsertQuotaPolicy({
        platform: 'groq', modelId, endpointScope: null,
        scope: 'model', metric: 'requests', limit: 20,
        periodKind: 'rolling', periodMs: 86_400_000, timezone: null, anchorDay: null,
        source: 'operator',
      });
    }
    // Burn one model's own pool to the floor; Groq meters per model. The
    // provider then refuses it, which is what turns a computed zero into a fact
    // — until that refusal lands the router deliberately spends the last of an
    // allowance rather than diverting on its own arithmetic.
    spendRequests('groq', 'openai/gpt-oss-120b', keyId, 20);
    setCooldown('groq', 'openai/gpt-oss-120b', keyId, 60_000);
    invalidateQuotaPressure();

    const spent = quotaPressure('groq', 'openai/gpt-oss-120b', '');
    const sibling = quotaPressure('groq', 'openai/gpt-oss-20b', '');

    expect(spent.headroom).toBe(0);
    expect(sibling.headroom).toBe(1);
    expect(sibling.factor).toBe(1);
    expect(spent.factor).toBeLessThan(sibling.factor);
  });

  it('sinks every model behind one shared pool together', () => {
    const keyId = addKey('nvidia');
    // NVIDIA meters one credit pool for the whole platform, so consumption on
    // one model must be visible to its siblings — otherwise a chain holding
    // three NVIDIA models reads as three allowances.
    upsertQuotaPolicy({
      platform: 'nvidia', modelId: null, endpointScope: null,
      scope: 'provider_account', metric: 'requests', limit: 40,
      periodKind: 'rolling', periodMs: 86_400_000, timezone: null, anchorDay: null,
      source: 'operator',
    });
    spendRequests('nvidia', 'moonshotai/kimi-k3', keyId, 39);

    const untouched = quotaPressure('nvidia', 'deepseek-ai/deepseek-v4-pro-0813', '');
    expect(untouched.headroom).toBeLessThan(0.2);
    expect(untouched.factor).toBeLessThan(1);
  });

  it('has no opinion when no domain published a limit', () => {
    addKey('opencode');
    const unmeasured = quotaPressure('opencode', 'muse-spark-1.3-contributor-free', '');
    expect(unmeasured.unknown).toBe(true);
    expect(unmeasured.factor).toBe(UNKNOWN_POOL_PRESSURE);
  });
});

describe('provider diversity', () => {
  beforeEach(() => { reset(); resetLeases(); });

  it('has no opinion for a caller with nothing else in the air', () => {
    // A sequential caller can gain nothing from spreading, so it must never pay
    // for it: one open attempt is not concurrency.
    expect(inFlightPoolShare('groq', 'openai/gpt-oss-20b')).toBeNull();
    acquireLease('groq', 'openai/gpt-oss-20b', 1, 100);
    expect(inFlightPoolShare('groq', 'openai/gpt-oss-20b')).toBeNull();
  });

  it('damps a pool that is serving every attempt currently in flight', () => {
    acquireLease('groq', 'openai/gpt-oss-20b', 1, 100);
    acquireLease('groq', 'openai/gpt-oss-120b', 1, 100);
    // Groq meters per model, so these are two pools, each holding half.
    expect(inFlightPoolShare('groq', 'openai/gpt-oss-20b')).toBe(0.5);
    // An idle pool is untouched and outranks both.
    expect(inFlightPoolShare('nvidia', 'openai/gpt-oss-20b')).toBe(0);
    expect(poolDiversityFactor('nvidia', 'openai/gpt-oss-20b')).toBe(1);
    expect(poolDiversityFactor('groq', 'openai/gpt-oss-20b')).toBeLessThan(1);
  });

  it('counts contention per quota domain, not per model name', () => {
    // Three different NVIDIA models are one allowance, so spreading across them
    // must buy nothing: a fourth NVIDIA route sees the pool fully contended.
    acquireLease('nvidia', 'moonshotai/kimi-k3', 1, 100);
    acquireLease('nvidia', 'deepseek-ai/deepseek-v4-pro-0813', 1, 100);
    acquireLease('nvidia', 'nvidia/nemotron-3-ultra-550b-a55b', 1, 100);
    expect(inFlightPoolShare('nvidia', 'minimaxai/minimax-m3')).toBe(1);
    expect(poolDiversityFactor('nvidia', 'minimaxai/minimax-m3')).toBe(1 - DIVERSITY_MAX_DAMP);
  });

  it('releases its opinion when the concurrent work finishes', () => {
    const a = acquireLease('groq', 'openai/gpt-oss-20b', 1, 100);
    const b = acquireLease('groq', 'openai/gpt-oss-20b', 1, 100);
    expect(inFlightPoolShare('groq', 'openai/gpt-oss-20b')).toBe(1);
    releaseLease(a);
    releaseLease(b);
    expect(inFlightPoolShare('groq', 'openai/gpt-oss-20b')).toBeNull();
  });

  it('is too weak to move a route past a materially better one', () => {
    // A fully contended route keeps almost all of its score. Diversity shades a
    // close call and must never hand difficult work to a worse model.
    expect(diversityFactor(1)).toBe(1 - DIVERSITY_MAX_DAMP);
    expect(diversityFactor(1)).toBeGreaterThan(0.85);
    expect(diversityFactor(null)).toBe(1);
    expect(diversityFactor(0)).toBe(1);
  });
});
describe('priority mode speaks the same currency as the 429 penalty', () => {
  it('costs nothing at full headroom and a full penalty when exhausted', () => {
    expect(pressurePenaltyPositions(1)).toBe(0);
    expect(pressurePenaltyPositions(0)).toBe(MAX_PENALTY);
    expect(pressurePenaltyPositions(0.5)).toBeCloseTo(MAX_PENALTY / 2);
  });
});
