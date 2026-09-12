import { describe, it, expect, beforeEach } from 'vitest';
import { initDb, getDb } from '../../db/index.js';
import { listModelHealth, verdictForError } from '../../services/model-health.js';

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

  it('classifies a live error object the same way as stored history', () => {
    expect(verdictForError(Object.assign(new Error('blocked'), { status: 403 }))).toBe('dead');
    expect(verdictForError(Object.assign(new Error('nope'), { status: 404 }))).toBe('dead');
    expect(verdictForError(Object.assign(new Error('slow down'), { status: 429 }))).toBe('limited');
    // A transport wobble is not a dead model.
    expect(verdictForError(Object.assign(new Error('fetch failed'), { code: 'UND_ERR_SOCKET' }))).toBe('limited');
  });
});
