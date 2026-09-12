import { describe, it, expect, beforeEach } from 'vitest';
import { initDb, getDb } from '../../db/index.js';
import { observedRequestsForCeiling } from '../../lib/fallback-loop.js';

// A ceiling learned from a 429 is only as good as the counter it counted. These
// pin WHICH counter, because getting it wrong does not fail — it records a
// plausible number for the wrong pool and the dashboard believes it.

function seedCalls(platform: string, modelId: string, count: number): void {
  const insert = getDb().prepare(`
    INSERT INTO rate_limit_usage (platform, model_id, key_id, kind, tokens, created_at_ms)
    VALUES (?, ?, 1, 'request', 0, ?)
  `);
  for (let i = 0; i < count; i += 1) insert.run(platform, modelId, Date.now() - i * 1000);
}

describe('what a learned ceiling counts', () => {
  beforeEach(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
    getDb().prepare('DELETE FROM rate_limit_usage').run();
  });

  it('counts one model when the pool it refused is that model', () => {
    // The bug this replaces: gemini-3.8-flash was refused after 18 of its own
    // calls and recorded the PLATFORM's 58 that day, inventing a 45/day
    // account ceiling nothing was ever bound by.
    seedCalls('google', 'gemini-3.8-flash', 18);
    seedCalls('google', 'gemini-3.7-flash', 40);

    expect(observedRequestsForCeiling('google', 'gemini-3.8-flash', 'google::project-model::gemini-3.8-flash')).toBe(18);
  });

  it('is not fooled by a model id that merely appears inside the pool key', () => {
    // `nvidia::credit-pool` contains the letter `a`. A substring test read that
    // as a per-model pool and counted one model's calls against an account
    // ceiling.
    seedCalls('nvidia', 'a', 12);
    seedCalls('nvidia', 'b', 7);

    expect(observedRequestsForCeiling('nvidia', 'a', 'nvidia::credit-pool')).toBe(19);
  });

  it('counts the whole platform when every model spends one account pool', () => {
    // NVIDIA grants one allowance across its models, so the account total is
    // what was actually spent when it refused.
    seedCalls('nvidia', 'nemotron-3-super', 12);
    seedCalls('nvidia', 'nemotron-3-ultra', 7);

    expect(observedRequestsForCeiling('nvidia', 'nemotron-3-super', 'nvidia::credit-pool')).toBe(19);
  });
});
