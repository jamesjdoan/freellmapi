import { describe, it, expect } from 'vitest';
import { isKeyAuthError, isModelScopedAuthError } from '../../lib/error-classify.js';

/**
 * Providers return 401 for things that are not about the credential. OpenCode
 * Zen answers a model it does not serve with
 * `401: Model north-mini-code-free is not supported`.
 *
 * Read as a key rejection, that condemned a working OpenCode key in production
 * and took the whole provider out of routing over one unsupported model. It
 * only became visible once an unverifiable validate endpoint stopped silently
 * un-condemning it.
 */
describe('a 401 that names the model is not about the key', () => {
  const err = (status: number, message: string) => Object.assign(new Error(message), { status });

  it('does not read an unsupported-model 401 as a key failure', () => {
    const e = err(401, 'OpenCode Zen API error 401: Model north-mini-code-free is not supported');
    expect(isModelScopedAuthError(e)).toBe(true);
    expect(isKeyAuthError(e)).toBe(false);
  });

  it('still reads a plain 401 as a key failure', () => {
    // The Ollama case: the body says Unauthorized and nothing about a model.
    const e = err(401, 'Ollama Cloud API error 401: Unauthorized');
    expect(isModelScopedAuthError(e)).toBe(false);
    expect(isKeyAuthError(e)).toBe(true);
  });

  it('believes the credential when a message mentions both', () => {
    // Ambiguity resolves toward the key: missing a dead credential costs more
    // than skipping one model.
    const e = err(401, 'invalid api key for model gpt-4o');
    expect(isModelScopedAuthError(e)).toBe(false);
    expect(isKeyAuthError(e)).toBe(true);
  });

  it('is not fooled by a bare 401 with no body', () => {
    expect(isKeyAuthError(err(401, 'HTTP 401'))).toBe(true);
  });

  it('does not claim every error that names a model', () => {
    // A rate limit mentioning the model is neither key- nor model-fatal.
    expect(isModelScopedAuthError(err(429, 'rate limit exceeded for model gpt-4o'))).toBe(false);
  });

  it('covers the other wordings providers use for the same thing', () => {
    for (const message of [
      '401: unknown model foo-1',
      '403: model foo-1 does not exist',
      '401: unsupported model: foo-1',
      '401: model foo-1 is not available on your plan',
    ]) {
      expect(isModelScopedAuthError(err(401, message)), message).toBe(true);
    }
  });
});
