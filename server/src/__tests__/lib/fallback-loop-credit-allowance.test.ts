import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';

// Mistral, 2026-09-24: $10 of usage a month, resetting on the 1st. Once spent,
// every call is a 402, and the fixed 24h credit bench re-tried the same empty
// wallet daily until the reset. With the allowance declared, the bench lasts
// until the reset instead.

vi.mock('../../services/health.js', () => ({
  checkKeyHealth: vi.fn(),
  markKeyHealthyFromRequest: vi.fn(),
}));

import { initDb } from '../../db/index.js';
import { cooldownDecisionForError } from '../../lib/fallback-loop.js';
import { getPaymentRequiredCooldownMs } from '../../services/ratelimit.js';
import { deleteQuotaPolicy, upsertQuotaPolicy } from '../../services/quota-policy.js';
import type { RouteResult } from '../../services/router.js';

const route: RouteResult = {
  provider: {} as RouteResult['provider'], modelId: 'mistral-small-latest', modelDbId: 1, apiKey: 'k', keyId: 1, keyLabel: null,
  platform: 'mistral', displayName: 'Mistral Small', rpdLimit: null, tpdLimit: null, contextWindow: null, endpointScope: '',
};
const MISTRAL_402 = () => Object.assign(new Error('Mistral API error 402: Payment Required'), { status: 402 });

describe('402 against a declared monthly credit allowance', () => {
  beforeAll(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
  });
  afterEach(() => { vi.useRealTimers() });

  it('benches until the allowance resets, and falls back to the fixed bench without one', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-25T12:00:00Z'));

    // No allowance declared: today's behaviour, unchanged.
    expect(cooldownDecisionForError(route, MISTRAL_402())).toEqual({ durationMs: getPaymentRequiredCooldownMs(), source: 'credit' });

    const policy = upsertQuotaPolicy({
      platform: 'mistral', modelId: null, endpointScope: null, scope: 'provider_account', metric: 'credits',
      limit: 1000, unit: 'usd_cents', periodKind: 'calendar_month', periodMs: null, timezone: 'UTC', anchorDay: null,
    });
    const decision = cooldownDecisionForError(route, MISTRAL_402());
    expect(decision.source).toBe('credit');
    // Six and a half days to 1 October 00:00 UTC - longer than any heuristic
    // bench may be, which is the point: this is a stated reset, not a guess.
    expect(decision.durationMs).toBe(Date.parse('2026-10-01T00:00:00Z') - Date.now());
    expect(decision.durationMs).toBeGreaterThan(getPaymentRequiredCooldownMs());

    deleteQuotaPolicy(policy.id);
    expect(cooldownDecisionForError(route, MISTRAL_402()).durationMs).toBe(getPaymentRequiredCooldownMs());
  });
});
