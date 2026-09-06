import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';

const validateKey = vi.fn();
vi.mock('../../providers/index.js', async (importOriginal) => {
  const actual = await importOriginal() as any;
  return {
    ...actual,
    resolveProvider: () => ({ name: 'fake', validateKey }),
  };
});

const { initDb, getDb } = await import('../../db/index.js');
const { encrypt } = await import('../../lib/crypto.js');
const { checkKeyHealth } = await import('../../services/health.js');

/**
 * Some providers serve their model list to anyone — Ollama Cloud and NVIDIA NIM
 * both return 200 with no Authorization header. Key validation against such an
 * endpoint cannot fail, so it must report that rather than returning "valid".
 *
 * Found in production: a revoked Ollama key sat at status='healthy',
 * last_health_error=NULL, while every completion returned 401. The 401 called
 * for an immediate revalidation, and the revalidation certified the dead key —
 * so the authoritative signal triggered its own erasure.
 */
describe('unverifiable key validation', () => {
  let nextId = 9000;

  beforeAll(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
  });

  beforeEach(() => {
    validateKey.mockReset();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  function seedKey(status: string, lastError: string | null = null): number {
    const id = ++nextId;
    const enc = encrypt(`unverifiable-${id}`);
    getDb().prepare(`
      INSERT INTO api_keys (id, platform, label, encrypted_key, iv, auth_tag, enabled, status, last_health_error)
      VALUES (?, 'ollama', ?, ?, ?, ?, 1, ?, ?)
    `).run(id, `k${id}`, enc.encrypted, enc.iv, enc.authTag, status, lastError);
    return id;
  }

  function keyRow(id: number): { status: string; last_health_error: string | null; enabled: number } {
    return getDb().prepare('SELECT status, last_health_error, enabled FROM api_keys WHERE id = ?')
      .get(id) as { status: string; last_health_error: string | null; enabled: number };
  }

  const unverifiable = { valid: null, reason: 'Ollama Cloud returns 200 for an unauthenticated request' };

  it('does not certify a key the check cannot judge', async () => {
    const id = seedKey('unknown');
    validateKey.mockResolvedValue(unverifiable);
    await checkKeyHealth(id);
    // 'healthy' here is the manufactured confidence that hid a revoked key.
    expect(keyRow(id).status).toBe('unknown');
  });

  it('leaves a recorded rejection standing instead of wiping it', async () => {
    const id = seedKey('invalid', 'Ollama Cloud API error 401: Unauthorized');
    validateKey.mockResolvedValue(unverifiable);
    await checkKeyHealth(id);
    const row = keyRow(id);
    expect(row.status).toBe('invalid');
    expect(row.last_health_error).toContain('401');
  });

  it('condemns the key when a live completion rejected it and the check cannot say otherwise', async () => {
    const id = seedKey('healthy');
    validateKey.mockResolvedValue(unverifiable);
    // What recordAuthFailure now passes through: the 401 from a real inference
    // call. A provider refusing to generate is better evidence about the
    // credential than a public catalogue GET.
    const status = await checkKeyHealth(id, { upstreamRejection: 'Ollama Cloud API error 401: Unauthorized' });
    expect(status).toBe('invalid');
    const row = keyRow(id);
    expect(row.status).toBe('invalid');
    expect(row.last_health_error).toContain('401');
  });

  it('still trusts a conclusive rejection from the check itself', async () => {
    const id = seedKey('healthy');
    validateKey.mockResolvedValue({ valid: false, error: 'Groq key validation failed (HTTP 401)' });
    expect(await checkKeyHealth(id)).toBe('invalid');
  });

  it('still trusts a conclusive pass', async () => {
    // The whole point is not to break validation for the providers whose
    // endpoints do read the header.
    const id = seedKey('invalid', 'stale error');
    validateKey.mockResolvedValue(true);
    expect(await checkKeyHealth(id)).toBe('healthy');
    expect(keyRow(id).last_health_error).toBeNull();
  });

  it('counts the upstream rejection toward auto-disable', async () => {
    const id = seedKey('healthy');
    validateKey.mockResolvedValue(unverifiable);
    // A key that keeps being refused has to leave the rotation eventually, or
    // every request pays its latency forever.
    for (let i = 0; i < 5; i++) {
      await checkKeyHealth(id, { upstreamRejection: 'Ollama Cloud API error 401: Unauthorized' });
    }
    expect(keyRow(id).enabled).toBe(0);
  });

  it('does not count a plain unverifiable check toward auto-disable', async () => {
    const id = seedKey('healthy');
    validateKey.mockResolvedValue(unverifiable);
    for (let i = 0; i < 5; i++) await checkKeyHealth(id);
    // No evidence of a problem — a provider with a public model list must not
    // lose its keys just for having one.
    expect(keyRow(id).enabled).toBe(1);
  });
});

/**
 * The mirror of the unverifiable path. Where validation can never conclude, a
 * completed inference is the only thing that can, so it has to be able to
 * promote a key — otherwise a working Ollama or NVIDIA key reads 'unknown'
 * forever. Observed with a real key: six models answering, status still
 * 'unknown', because promotion only looked at 'error'.
 */
describe('a served request promotes a key the check cannot judge', () => {
  let nextId = 9500;

  beforeAll(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
  });

  function seed(status: string, lastError: string | null = null): number {
    const id = ++nextId;
    const enc = encrypt(`promote-${id}`);
    getDb().prepare(`
      INSERT INTO api_keys (id, platform, label, encrypted_key, iv, auth_tag, enabled, status, last_health_error)
      VALUES (?, 'ollama', ?, ?, ?, ?, 1, ?, ?)
    `).run(id, `k${id}`, enc.encrypted, enc.iv, enc.authTag, status, lastError);
    return id;
  }

  const statusOf = (id: number) => (getDb()
    .prepare('SELECT status FROM api_keys WHERE id = ?').get(id) as { status: string }).status;

  it('promotes unknown, so an unverifiable provider is not stuck there', async () => {
    const { markKeyHealthyFromRequest } = await import('../../services/health.js');
    const id = seed('unknown');
    markKeyHealthyFromRequest(id);
    expect(statusOf(id)).toBe('healthy');
  });

  it('still promotes a key stranded by a transport blip', async () => {
    const { markKeyHealthyFromRequest } = await import('../../services/health.js');
    const id = seed('error', 'ECONNRESET');
    markKeyHealthyFromRequest(id);
    expect(statusOf(id)).toBe('healthy');
  });

  it('does not resurrect a credential the provider explicitly rejected', async () => {
    const { markKeyHealthyFromRequest } = await import('../../services/health.js');
    const id = seed('invalid', 'HTTP 401 Unauthorized');
    markKeyHealthyFromRequest(id);
    // Routing never selects an invalid key, so this cannot fire in practice —
    // but widening it to 'invalid' would let one stray success undo a
    // confirmed rejection.
    expect(statusOf(id)).toBe('invalid');
  });
});
