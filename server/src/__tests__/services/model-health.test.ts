import { describe, it, expect, beforeEach } from 'vitest';
import { initDb, getDb } from '../../db/index.js';
import { listModelHealth, verdictForError, PROBE_MAX_TOKENS, PROBE_IMAGE_DATA_URL } from '../../services/model-health.js';

// Dead routes were being enabled by hand because nothing on the Keys pane told
// them apart from working ones. Every case below is one this install actually
// served up in a single afternoon.
describe('model health', () => {
  beforeEach(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
    getDb().prepare('DELETE FROM requests').run();
  });

  function attempt(modelId: string, status: string, error: string | null, minutesAgo = 1): void {
    getDb().prepare(`
      INSERT INTO requests (platform, model_id, status, input_tokens, output_tokens, latency_ms, error, created_at)
      VALUES ('groq', ?, ?, 1, 1, 10, ?, datetime('now', ?))
    `).run(modelId, status, error, `-${minutesAgo} minutes`);
  }

  const find = (modelId: string) => listModelHealth('groq').find(r => r.modelId === modelId);

  it('does not call a route dead because the provider had a bad minute', () => {
    // gemma-4-31b-it was marked dead off "500 Internal error encountered".
    // Measured 2026-09-14 at an identical token budget it served 3 of 5
    // consecutive calls — an upstream failing ~40% of the time is a bad route,
    // not a missing one, and 'dead' is the verdict that means never enable it.
    attempt('flaky', 'error', 'Google API error 500: Internal error encountered.');
    expect(find('flaky')?.verdict).toBe('limited');
    // The code still says which kind of trouble it is.
    expect(find('flaky')?.code).toBe('E5XX');
  });

  it('still calls a route dead when the provider says the model is not there', () => {
    // The contrast that keeps 'limited' meaningful: an id the provider does
    // not serve never becomes healthy by waiting.
    attempt('gone', 'error', 'OpenCode Zen API error 401: Model hy3-free is not supported');
    expect(find('gone')?.verdict).toBe('dead');
  });

  it('gives a probe enough budget to outlast a model thinking', () => {
    // Gemma 4 31B was recorded dead off "empty completion". It is a reasoning
    // model: measured 2026-09-14 it spends 13-29 tokens on thoughts before its
    // first answer token, so the old 4-token probe could only ever come back
    // empty — a verdict about our own cap, not the route. At 2048 the same
    // model answers with finishReason STOP.
    //
    // The floor is what matters, not the exact number: below the thinking cost
    // every reasoning model on the install reports dead.
    expect(PROBE_MAX_TOKENS).toBeGreaterThanOrEqual(32);
  });

  it('separates a permanent refusal from a rate limit', () => {
    // The distinction the whole feature turns on: one is a reason never to
    // enable the route, the other is a reason to wait.
    attempt('blocked', 'error', 'Groq API error 403: The model is blocked at the organization level.');
    attempt('busy', 'rate_limited', 'Groq API error 429: rate limit reached');

    expect(find('blocked')?.verdict).toBe('dead');
    expect(find('busy')?.verdict).toBe('limited');
  });

  it('does not call a route dead because we stopped waiting for it', () => {
    // Live: big-pickle was marked dead off "The operation was aborted
    // (opencode, chat, 60s)" and then served a direct probe seconds later. A
    // timeout is a statement about the minute, not the model.
    attempt('slow', 'error', 'The operation was aborted (opencode, chat, 60s)');
    expect(find('slow')?.verdict).toBe('limited');
  });

  it('lets one success outrank any number of failures', () => {
    // A route that has served is not dead; what follows is a quota story, and
    // the quota panel owns that.
    for (let i = 0; i < 5; i++) attempt('flaky', 'error', 'upstream 500', i + 2);
    attempt('flaky', 'success', null, 1);

    expect(find('flaky')?.verdict).toBe('ok');
    expect(find('flaky')?.detail).toBeNull();
  });

  it('reports never-called as untested, not as healthy', () => {
    // Same rule the quota ledger keeps: unknown is not zero, and it is not
    // green either.
    expect(find('never-touched')).toBeUndefined();
    attempt('touched', 'success', null);
    expect(find('touched')?.verdict).toBe('ok');
  });

  it("carries the provider's own words, so the reason is actionable", () => {
    attempt('gone', 'error', 'OpenCode Zen API error 401: Model hy3-free is not supported');
    expect(find('gone')?.detail).toContain('is not supported');
  });

  it('groups failures under a code an operator can scan', () => {
    // Forty rows of prose cannot be scanned; eight codes can. Each of these is
    // a refusal this install actually received.
    attempt('org-blocked', 'error', 'Groq API error 403: The model `qwen/qwen3.8-27b` is blocked at the organization level.');
    attempt('gone', 'error', 'OpenCode Zen API error 401: Model north-mini-code-free is not supported');
    attempt('broken', 'error', 'OpenCode Zen API error 500: Internal server error');
    attempt('slow', 'error', 'The operation was aborted (opencode, chat, 60s)');
    attempt('busy', 'rate_limited', 'FreeUsageLimitError: Rate limit exceeded. Please try again later.');

    expect(find('org-blocked')?.code).toBe('E403');
    // Named the MODEL, so it is a missing model rather than a bad credential —
    // which is the distinction that decides whether to touch the key at all.
    expect(find('gone')?.code).toBe('E404');
    expect(find('broken')?.code).toBe('E5XX');
    // A 400 that names the model is a missing model, not a provider outage —
    // "Upstream request failed: Model is unavailable" read as E5XX until the
    // word "upstream" stopped outranking the rest of the sentence.
    attempt('unavailable', 'error', 'OpenCode Zen API error 400: Error from provider (Console): Upstream request failed: Model is unavailable.');
    expect(find('unavailable')?.code).toBe('E404');
    expect(find('slow')?.code).toBe('ETIME');
    expect(find('busy')?.code).toBe('E429');
  });

  it('marks a working route OK and leaves an uncalled one without a code', () => {
    attempt('works', 'success', null);
    expect(find('works')?.code).toBe('OK');
    expect(find('never-called')).toBeUndefined();
  });

  it('classifies a live error object the same way as stored history', () => {
    expect(verdictForError(Object.assign(new Error('blocked'), { status: 403 }))).toBe('dead');
    expect(verdictForError(Object.assign(new Error('nope'), { status: 404 }))).toBe('dead');
    expect(verdictForError(Object.assign(new Error('slow down'), { status: 429 }))).toBe('limited');
    // A transport wobble is not a dead model.
    expect(verdictForError(Object.assign(new Error('fetch failed'), { code: 'UND_ERR_SOCKET' }))).toBe('limited');
  });

  it('the vision probe image clears the 32px floor providers enforce', () => {
    // Measured on the live instance 2026-09-20: Groq answers an 8x8 with
    // HTTP 400 'Image must have at least 32 pixels in each dimension'. That is
    // not recorded as a capability failure - correctly, it says nothing about
    // the model - so shrinking this image does not break a test or fail a
    // probe. It silently makes every Groq vision route UNVERIFIABLE. This
    // decodes the constant rather than pinning its text, so the dimensions are
    // what is asserted and not the base64.
    const bytes = Buffer.from(PROBE_IMAGE_DATA_URL.split(',')[1], 'base64');
    expect(bytes.subarray(0, 8)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    expect(bytes.readUInt32BE(16)).toBeGreaterThanOrEqual(32);
    expect(bytes.readUInt32BE(20)).toBeGreaterThanOrEqual(32);
    // Small enough that it stays a rounding error against a token-metered pool.
    expect(bytes.length).toBeLessThan(512);
  });
});
