import { describe, it, expect } from 'vitest';
import { getCooldownDecisionForLimit } from '../services/ratelimit.js';

describe('getCooldownDecisionForLimit — provider-stated retry hint', () => {
  // Limits that keep the base at the transient 90 s cooldown:
  // rpd is set so dailyExhausted is false, and unknownLimits is false.
  const baseLimits = { rpd: 1000, tpd: null };

  it('uses a provider‑stated retry time (~38 s from Google body) as cooldown, overriding the 90 s base', () => {
    const decision = getCooldownDecisionForLimit(
      'google',
      'gemini-3.7-flash',
      1,
      baseLimits,
      38529.9283, // Google body "Please retry in 38.52990283s"
      { quotaSignal: true }
    );
    // The new code honors the hint regardless of comparison with base.
    expect(decision.durationMs).toBeCloseTo(38529.9283, -1);
    expect(decision.source).toBe('authoritative');
  });

  it('clamps a very short body hint up to the 5‑second floor', () => {
    const decision = getCooldownDecisionForLimit(
      'google',
      'gemini-3.7-flash',
      1,
      baseLimits,
      200, // "retry in 0.2s"
      { quotaSignal: true }
    );
    // Floor of 5 s should apply.
    expect(decision.durationMs).toBe(5_000);
    expect(decision.source).toBe('authoritative');
  });

  it('honors a 120‑second Retry‑After header over a body saying 5 s', () => {
    // Header already wins in providerHttpError, so retryAfterMs = 120 000.
    const decision = getCooldownDecisionForLimit(
      'google',
      'gemini-3.7-flash',
      1,
      baseLimits,
      120_000, // 120‑second header
      { quotaSignal: true }
    );
    expect(decision.durationMs).toBe(120_000);
    expect(decision.source).toBe('authoritative');
  });

  it('falls back to the 90 s base when retryAfterMs is absent', () => {
    const decision = getCooldownDecisionForLimit(
      'google',
      'gemini-3.7-flash',
      1,
      baseLimits,
      undefined,
      { quotaSignal: true }
    );
    // No hint → base used.
    expect(decision.durationMs).toBe(90_000);
    expect(decision.source).toBe('heuristic');
  });
});