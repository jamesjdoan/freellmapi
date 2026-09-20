import { describe, it, expect, beforeEach } from 'vitest';
import { initDb, getDb } from '../../db/index.js';
import { encrypt } from '../../lib/crypto.js';
import { diagnoseProviders, adviceFor, recordDiagnosisTransitions, listDiagnosisHistory } from '../../services/provider-diagnosis.js';

/**
 * One verdict per provider, and whose fault it is.
 *
 * Written for the OpenCode case: eleven models each answering 403 or 404 read
 * as eleven unrelated route failures when the truth is one sentence — the free
 * tier ended. The first version of this service called OpenCode `healthy`
 * because successes from before it died were still inside the window, which is
 * the bug these tests exist to keep fixed.
 */

function reset(): void {
  process.env.ENCRYPTION_KEY = '0'.repeat(64);
  initDb(':memory:');
  const db = getDb();
  for (const table of ['requests', 'rate_limit_cooldowns', 'api_keys', 'profile_models', 'fallback_config', 'provider_diagnosis_history']) {
    try { db.prepare(`DELETE FROM ${table}`).run(); } catch { /* absent in this schema */ }
  }
  db.prepare('DELETE FROM models').run();
}

function addKey(platform: string, opts: { enabled?: number; status?: string } = {}): number {
  const secret = encrypt(`${platform}-diagnosis-test`);
  return Number(getDb().prepare(`
    INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled)
    VALUES (?, 'diag', ?, ?, ?, ?, ?)
  `).run(platform, secret.encrypted, secret.iv, secret.authTag,
    opts.status ?? 'healthy', opts.enabled ?? 1).lastInsertRowid);
}

function addModel(platform: string, modelId: string, enabled = 1): void {
  getDb().prepare(`
    INSERT INTO models (platform, model_id, display_name, intelligence_rank, speed_rank, size_label,
                        monthly_token_budget, context_window, enabled, supports_vision, supports_tools)
    VALUES (?, ?, ?, 10, 10, 'Medium', 0, 131072, ?, 0, 1)
  `).run(platform, modelId, modelId, enabled);
}

/** One recorded attempt. `error` null means it served. */
function attempt(platform: string, modelId: string, keyId: number, error: string | null, agoMs = 0): void {
  const at = new Date(Date.now() - agoMs).toISOString().replace('T', ' ').slice(0, 19);
  getDb().prepare(`
    INSERT INTO requests (platform, model_id, key_id, status, input_tokens, output_tokens, latency_ms, error, created_at)
    VALUES (?, ?, ?, ?, 1, 1, 100, ?, ?)
  `).run(platform, modelId, keyId, error ? 'error' : 'success', error, at);
}

function verdictFor(platform: string) {
  return diagnoseProviders(getDb()).find(p => p.platform === platform)!;
}

describe('provider diagnosis', () => {
  beforeEach(reset);

  it('reads the OpenCode case as one blocked account, not eleven broken models', () => {
    const keyId = addKey('opencode');
    for (let i = 0; i < 6; i++) {
      addModel('opencode', `m${i}`);
      attempt('opencode', `m${i}`, keyId, 'OpenCode Zen API error 403: OpenCode\'s free tier has ended');
    }
    for (let i = 6; i < 11; i++) {
      addModel('opencode', `m${i}`);
      attempt('opencode', `m${i}`, keyId, `OpenCode Zen API error 401: Model m${i} is not supported`);
    }
    const d = verdictFor('opencode');
    expect(d.verdict).toBe('access_denied');
    expect(d.dominantCode).toBe('E403');
    expect(d.okModels).toBe(0);
    expect(d.failingModels).toBe(11);
    // The provider's own words survive the rollup, or the verdict is a colour.
    expect(d.sample).toContain('free tier');
  });

  it('judges the latest attempt, so last week\'s successes cannot outvote today\'s refusals', () => {
    // The defect this service shipped with: a provider that died on Tuesday
    // read healthy because it worked on Monday and both were in the window.
    const keyId = addKey('opencode');
    addModel('opencode', 'a');
    addModel('opencode', 'b');
    attempt('opencode', 'a', keyId, null, 6 * 86_400_000);
    attempt('opencode', 'b', keyId, null, 6 * 86_400_000);
    attempt('opencode', 'a', keyId, 'API error 403: free tier ended', 60_000);
    attempt('opencode', 'b', keyId, 'API error 403: free tier ended', 60_000);

    const d = verdictFor('opencode');
    expect(d.verdict).toBe('access_denied');
    expect(d.okModels).toBe(0);
  });

  it('separates a rate limit from a block, because one heals itself', () => {
    const keyId = addKey('groq');
    addModel('groq', 'a');
    addModel('groq', 'b');
    attempt('groq', 'a', keyId, 'Groq API error 429: rate limit reached');
    attempt('groq', 'b', keyId, 'Groq API error 429: rate limit reached');
    expect(verdictFor('groq').verdict).toBe('rate_limited');
  });

  it('calls a rejected credential a key problem, not a model problem', () => {
    // A 401 outranks everything: every other symptom is downstream of it.
    const keyId = addKey('nvidia');
    addModel('nvidia', 'a');
    addModel('nvidia', 'b');
    attempt('nvidia', 'a', keyId, 'NVIDIA API error 401: invalid api key');
    attempt('nvidia', 'b', keyId, 'NVIDIA API error 429: rate limit');
    expect(verdictFor('nvidia').verdict).toBe('key_rejected');
  });

  it('leaves a mostly-working provider healthy despite one bad route', () => {
    // One dead model among many is a model problem. Escalating it to a provider
    // verdict would make this view cry wolf, and an alarm that is always on is
    // not read.
    const keyId = addKey('google');
    for (let i = 0; i < 5; i++) { addModel('google', `m${i}`); attempt('google', `m${i}`, keyId, null); }
    addModel('google', 'broken');
    attempt('google', 'broken', keyId, 'Google API error 404: model not found');
    const d = verdictFor('google');
    expect(d.verdict).toBe('healthy');
    expect(d.okModels).toBe(5);
    expect(d.failingModels).toBe(1);
  });

  it('distinguishes no credential from one held but switched off', () => {
    // Different repairs: obtain a key, versus enable the one you have.
    addModel('cloudflare', 'a');
    expect(verdictFor('cloudflare').verdict).toBe('no_key');

    addKey('huggingface', { enabled: 0 });
    addModel('huggingface', 'a');
    expect(verdictFor('huggingface').verdict).toBe('key_unusable');
  });

  it('says untested rather than healthy when a key has never been called', () => {
    // Silence is not evidence of health, the same rule the quota ledger keeps.
    addKey('mistral');
    addModel('mistral', 'a');
    expect(verdictFor('mistral').verdict).toBe('untested');
  });

  it('keeps a keyed provider visible when every one of its models is switched off', () => {
    // b.ai: promo over, both models disabled. A provider you hold a credential
    // for must not vanish from the view that explains credentials.
    addKey('bai');
    addModel('bai', 'a', 0);
    expect(diagnoseProviders(getDb()).some(p => p.platform === 'bai')).toBe(true);
  });

  it('orders worst first, so the provider needing a decision is at the top', () => {
    addKey('opencode'); addModel('opencode', 'a');
    attempt('opencode', 'a', addKey('opencode'), 'API error 403: free tier ended');
    addKey('groq'); addModel('groq', 'g');
    attempt('groq', 'g', addKey('groq'), null);
    const order = diagnoseProviders(getDb()).map(p => p.platform);
    expect(order.indexOf('opencode')).toBeLessThan(order.indexOf('groq'));
  });
});

describe('what to do about it', () => {
  beforeEach(reset);

  it('separates what waiting fixes from what it does not', () => {
    // The distinction the whole advice layer exists for: a 429 clears itself
    // and a 403 never will, and those demand opposite responses.
    const limited = adviceFor({ verdict: 'rate_limited', dominantCode: 'E429', activeCooldowns: 2, failingModels: 2, okModels: 0 });
    const blocked = adviceFor({ verdict: 'access_denied', dominantCode: 'E403', activeCooldowns: 0, failingModels: 11, okModels: 0 });
    expect(limited.selfHealing).toBe(true);
    expect(blocked.selfHealing).toBe(false);
    expect(blocked.action).toContain('Waiting will not fix this');
  });

  it('counts the cooldowns it is telling you about', () => {
    const held = adviceFor({ verdict: 'rate_limited', dominantCode: 'E429', activeCooldowns: 3, failingModels: 3, okModels: 1 });
    expect(held.cause).toContain('3 route(s)');
  });
});

describe('state changes over time', () => {
  beforeEach(reset);

  function opencodeFailing(): void {
    const keyId = addKey('opencode');
    addModel('opencode', 'a');
    attempt('opencode', 'a', keyId, 'API error 403: free tier ended');
  }

  it('writes a row when the state changes and nothing when it holds', () => {
    opencodeFailing();
    expect(recordDiagnosisTransitions(diagnoseProviders(getDb()), getDb()).changed).toContain('opencode');
    const first = listDiagnosisHistory('opencode', 50, getDb());
    expect(first).toHaveLength(1);

    // Same state again: extends the existing row rather than adding one.
    const second = recordDiagnosisTransitions(diagnoseProviders(getDb()), getDb(), Date.now() + 60_000);
    expect(second.changed).not.toContain('opencode');
    expect(listDiagnosisHistory('opencode', 50, getDb())).toHaveLength(1);
    expect(listDiagnosisHistory('opencode', 50, getDb())[0]!.lastSeenAtMs)
      .toBeGreaterThan(first[0]!.startedAtMs);
  });

  it('records the recovery as its own transition, so a trend is readable', () => {
    opencodeFailing();
    recordDiagnosisTransitions(diagnoseProviders(getDb()), getDb());

    // The provider comes back: newest attempt succeeds.
    const keyId = addKey('opencode');
    attempt('opencode', 'a', keyId, null);
    recordDiagnosisTransitions(diagnoseProviders(getDb()), getDb(), Date.now() + 120_000);

    const history = listDiagnosisHistory('opencode', 50, getDb());
    expect(history).toHaveLength(2);
    expect(history[0]!.verdict).toBe('healthy');
    expect(history[1]!.verdict).toBe('access_denied');
  });

  it('keeps the provider\'s own words after the failing traffic ages out', () => {
    // The requests window is 14 days. The reason a key died must outlive it,
    // or in a fortnight the history says "access_denied" and cannot say why.
    opencodeFailing();
    recordDiagnosisTransitions(diagnoseProviders(getDb()), getDb());
    expect(listDiagnosisHistory('opencode', 50, getDb())[0]!.sample).toContain('free tier ended');
  });
});
