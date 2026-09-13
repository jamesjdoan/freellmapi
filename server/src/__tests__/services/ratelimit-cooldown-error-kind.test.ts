import { describe, it, expect, beforeAll, beforeEach } from 'vitest';

// #592: the null-limits exhaustion heuristic (getCooldownDecisionForLimit) must
// only fire on an actual provider quota signal (a real 429 / rate-limit-classified
// error). Before the fix, ANY retryable failure — a timeout on a slow local
// generation, a 5xx blip — fed the "2+ hits in an hour = daily-exhausted"
// counter and escalated the bench 2m→10m→1h→24h, 429-ing every request on what
// is often the user's only route. Also covers the cooldownHits ladder decay on
// success: two back-to-back failures used to keep their ladder step for 24h
// even after successful requests proved the quota alive.

import { initDb } from '../../db/index.js';
import { cooldownDecisionForError } from '../../lib/fallback-loop.js';
import {
  getNextCooldownDuration,
  recordRequest,
  recentHitCount,
} from '../../services/ratelimit.js';
import type { RouteResult } from '../../services/router.js';

const MINUTE = 60_000;
const TRANSIENT = 90_000;

// Distinct keyId AND modelDbId per fake route: the cooldown/ladder maps are
// module-global, so shared ids would leak state across tests.
let keySeq = 640_000;
function nullLimitRoute(): RouteResult {
  const n = ++keySeq;
  return {
    provider: {} as any, modelId: `null-limit-model-${n}`, modelDbId: 592_000 + n,
    apiKey: 'k', keyId: n, platform: 'ollama', displayName: 'Null-Limit Model',
    rpdLimit: null, tpdLimit: null,
  };
}

const timeoutErr = () => Object.assign(
  new Error('Request timeout after 120000ms'), { name: 'TimeoutError' },
);
const serverErr = () => Object.assign(
  new Error('Ollama API error 500: Internal Server Error'), { status: 500 },
);
const real429 = () => Object.assign(
  new Error('429 Too Many Requests'), { status: 429 },
);

beforeAll(() => {
  process.env.ENCRYPTION_KEY = '0'.repeat(64);
  initDb(':memory:');
});

let route: RouteResult;
beforeEach(() => { route = nullLimitRoute(); });

describe('a request refused for its own size does not bench the route', () => {
  // Observed live on Groq 2026-09-13. `qwen/qwen3.8-27b` asked for 1024 output
  // tokens against a 1000/minute ceiling, and the route was benched until UTC
  // midnight — 14.5 hours — while it went on serving ordinary requests the
  // whole time (verified by calling it directly at max_tokens=16).
  //
  // The bench came out 'authoritative' because Groq STATED a retry time; its
  // formula extrapolates one even when the request can never fit. Honouring a
  // provider's retry is right in general and wrong here, which is why this is
  // classified ahead of the retry-time path rather than inside it.
  const groqRoute = (): RouteResult => ({
    provider: {} as any, modelId: 'qwen/qwen3.8-27b', modelDbId: 931_001,
    apiKey: 'k', keyId: 931_001, platform: 'groq', displayName: 'Qwen3.8 27B',
    rpdLimit: 1000, tpdLimit: null,
  });

  const tooLarge = () => Object.assign(
    new Error('Groq API error 429: Request too large for model `qwen/qwen3.8-27b` in organization '
      + '`org_01k` service tier `on_demand` on output tokens per minute (OTPM): Limit 1000, '
      + "Requested 1024. The request's expected output tokens exceed the limit."),
    { status: 429, retryAfterMs: 51_866_000 },
  );

  it('lays down no cooldown even though the provider stated a retry time', () => {
    const decision = cooldownDecisionForError(groqRoute(), tooLarge());
    expect(decision.durationMs).toBe(0);
  });

  it('holds whichever producer would have benched it', () => {
    // The live row expired at exactly UTC midnight, and two paths can produce
    // an 'authoritative' bench: the daily-quota branch (which falls back to
    // msUntilNextUtcMidnight) and the stated-retry branch in
    // getCooldownDecisionForLimit. Rather than assume which one fired on the
    // day — the stored error was truncated at 200 chars — the size check is
    // positioned ahead of BOTH, and this asserts that with no retry time on the
    // error at all, which is the input the daily branch would see.
    const noStatedRetry = Object.assign(
      new Error('Groq API error 429: Request too large for model `qwen/qwen3.8-27b` on output '
        + 'tokens per minute (OTPM): Limit 1000, Requested 1024.'),
      { status: 429 },
    );
    expect(cooldownDecisionForError(groqRoute(), noStatedRetry).durationMs).toBe(0);
  });

  it('still benches an ordinary exhaustion 429 on the same wording', () => {
    // The distinction is Requested vs Limit, not the phrase. Here the request
    // fits the ceiling and the allowance is simply spent, so the provider's
    // retry time is honoured as before.
    const spent = Object.assign(
      new Error('Groq API error 429: Request too large for model `qwen/qwen3.8-27b` on output '
        + 'tokens per minute (OTPM): Limit 1000, Used 995, Requested 10.'),
      { status: 429, retryAfterMs: 30_000 },
    );
    const decision = cooldownDecisionForError(groqRoute(), spent);
    expect(decision.durationMs).toBeGreaterThan(0);
  });
});

describe('null-limits heuristic only fires on quota signals (#592)', () => {
  it('repeated timeouts stay on the short transient bench — no ladder', () => {
    for (let i = 0; i < 4; i++) {
      const decision = cooldownDecisionForError(route, timeoutErr());
      expect(decision.durationMs).toBe(TRANSIENT);
      expect(decision.source).toBe('heuristic');
    }
    // No hits recorded → the heuristic counter never sees a timeout.
    expect(recentHitCount(route.platform, route.modelId, route.keyId, Date.now())).toBe(0);
  });

  it('repeated 5xx stay on the short transient bench — no ladder', () => {
    for (let i = 0; i < 4; i++) {
      expect(cooldownDecisionForError(route, serverErr()).durationMs).toBe(TRANSIENT);
    }
    expect(recentHitCount(route.platform, route.modelId, route.keyId, Date.now())).toBe(0);
  });

  it('a timeout does not inherit escalation started by real 429s', () => {
    expect(cooldownDecisionForError(route, real429()).durationMs).toBe(TRANSIENT);
    // 2nd real 429 crosses the heuristic threshold → ladder (2m).
    expect(cooldownDecisionForError(route, real429()).durationMs).toBe(2 * MINUTE);
    // A timeout right after must NOT climb to the next ladder step (10m):
    // it is not a quota signal, so it neither records a hit nor escalates.
    expect(cooldownDecisionForError(route, timeoutErr()).durationMs).toBe(TRANSIENT);
    // Hit count still only reflects the two genuine 429s.
    expect(recentHitCount(route.platform, route.modelId, route.keyId, Date.now())).toBe(2);
  });

  it('real 429s still escalate — the Ollama-Cloud opaque-quota protection holds', () => {
    // 1st 429 → transient (no signal yet), then the ladder: 2m, 10m. This route
    // publishes no RPD/TPD, so escalation stops at the unknown-limit 10m cap
    // rather than climbing to the 1h/24h quarantine on an inferred verdict.
    expect(cooldownDecisionForError(route, real429()).durationMs).toBe(TRANSIENT);
    expect(cooldownDecisionForError(route, real429()).durationMs).toBe(2 * MINUTE);
    expect(cooldownDecisionForError(route, real429()).durationMs).toBe(10 * MINUTE);
    expect(cooldownDecisionForError(route, real429()).durationMs).toBe(10 * MINUTE);
  });
});

describe('cooldownHits ladder decays on success (#592)', () => {
  it('a successful request resets the escalation ladder', () => {
    const { platform, modelId, keyId } = nullLimitRoute();
    expect(getNextCooldownDuration(platform, modelId, keyId)).toBe(2 * MINUTE);
    expect(getNextCooldownDuration(platform, modelId, keyId)).toBe(10 * MINUTE);
    // A served request proves the quota is alive — ladder starts over.
    recordRequest(platform, modelId, keyId);
    expect(getNextCooldownDuration(platform, modelId, keyId)).toBe(2 * MINUTE);
  });

  it('without a success the ladder keeps escalating (documented contract intact)', () => {
    const { platform, modelId, keyId } = nullLimitRoute();
    expect(getNextCooldownDuration(platform, modelId, keyId)).toBe(2 * MINUTE);
    expect(getNextCooldownDuration(platform, modelId, keyId)).toBe(10 * MINUTE);
    expect(getNextCooldownDuration(platform, modelId, keyId)).toBe(60 * MINUTE);
    expect(getNextCooldownDuration(platform, modelId, keyId)).toBe(24 * 60 * MINUTE);
  });
});
