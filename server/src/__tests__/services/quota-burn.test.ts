import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createServer, type Server } from 'node:http';
import { initDb, getDb } from '../../db/index.js';
import { encrypt } from '../../lib/crypto.js';
import { refreshStatsCache, getRoutingScores } from '../../services/router.js';
import { inferWindowsFromRecovery } from '../../services/quota-inference.js';
import {
  startBurnRun,
  cancelBurnRun,
  listBurnRuns,
  getBurnRun,
  activeBurnRun,
  pollBurnRecovery,
  classifyRecovery,
  BurnStartError,
  BURN_LIMITS,
  burnRunSettled,
} from '../../services/quota-burn.js';

// A burn run spends real allowance, so it is verified against a stub provider
// that refuses after a known number of requests: the run has to discover that
// number. Nothing here mocks the burn service itself — the requests are real
// HTTP against a real OpenAI-compatible endpoint.

/** Succeeds `allowance` times, then refuses like a rate-limited provider. */
function startStub(allowance: number, opts: { retryAfter?: string } = {}): { server: Server; port: number; served: () => number } {
  let served = 0;
  const server = createServer((req, res) => {
    const json = (code: number, body: unknown, headers: Record<string, string> = {}) => {
      res.writeHead(code, { 'content-type': 'application/json', ...headers });
      res.end(JSON.stringify(body));
    };
    if (req.url?.startsWith('/v1/models')) {
      json(200, { object: 'list', data: [{ id: 'stub-model', object: 'model' }] });
      return;
    }
    if (req.url?.startsWith('/v1/chat/completions')) {
      if (served >= allowance) {
        json(429, { error: { message: 'rate limit exceeded' } },
          opts.retryAfter ? { 'retry-after': opts.retryAfter } : {});
        return;
      }
      served++;
      json(200, {
        id: 'chatcmpl-stub',
        object: 'chat.completion',
        model: 'stub-model',
        choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 },
      });
      return;
    }
    json(404, { error: 'not found' });
  });
  server.listen(0, '127.0.0.1');
  const port = () => (server.address() as { port: number }).port;
  return { server, get port() { return port(); }, served: () => served };
}

async function listening(server: Server): Promise<void> {
  if (server.listening) return;
  await new Promise<void>(resolve => server.once('listening', () => resolve()));
}

/** The burn loop is detached so the HTTP caller is not held open; the service
 *  keeps its promise, so a test awaits the real completion rather than sleeping
 *  and hoping. */
const settle = (id: string): Promise<void> => burnRunSettled(id);

function seedCustomKey(baseUrl: string): number {
  const secret = encrypt('sk-stub');
  const info = getDb().prepare(`
    INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled, base_url)
    VALUES ('custom', 'stub', ?, ?, ?, 'active', 1, ?)
  `).run(secret.encrypted, secret.iv, secret.authTag, baseUrl);
  const keyId = Number(info.lastInsertRowid);
  getDb().prepare(`
    INSERT INTO models (platform, model_id, display_name, intelligence_rank, speed_rank, key_id, enabled)
    VALUES ('custom', 'stub-model', 'Stub Model', 50, 50, ?, 1)
  `).run(keyId);
  return keyId;
}

describe('quota burn', () => {
  let stub: ReturnType<typeof startStub> | null = null;

  beforeEach(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
    // A fresh in-memory DB per test, so the only cleanup needed is the seeded
    // catalogue rows that `models` FKs hang off (fallback_config, profile_models
    // reference models — deleting models first violates them).
    const db = getDb();
    db.prepare('DELETE FROM quota_burn_run').run();
    db.prepare('DELETE FROM requests').run();
  });

  afterEach(() => {
    stub?.server.close();
    stub = null;
  });

  it('discovers the limit by reaching it', async () => {
    stub = startStub(7);
    await listening(stub.server);
    seedCustomKey(`http://127.0.0.1:${stub.port}/v1`);

    const run = startBurnRun({ platform: 'custom', maxRequests: 50, maxSeconds: 30 });
    await settle(run.id);

    const done = getBurnRun(run.id)!;
    // The measurement: seven succeeded, the eighth was refused.
    expect(done.requestsSucceeded).toBe(7);
    expect(done.requestsSent).toBe(8);
    expect(done.refusalStatus).toBe(429);
    // Refusal is not the end of the experiment — the window is still unknown
    // until the provider comes back.
    expect(done.phase).toBe('recovering');
  });

  it('stops at its own request cap without claiming a limit', async () => {
    // A provider more generous than the cap must not be reported as having a
    // ceiling of `maxRequests` — that number is ours, not theirs.
    stub = startStub(1000);
    await listening(stub.server);
    seedCustomKey(`http://127.0.0.1:${stub.port}/v1`);

    const run = startBurnRun({ platform: 'custom', maxRequests: 5, maxSeconds: 30 });
    await settle(run.id);

    const done = getBurnRun(run.id)!;
    expect(done.requestsSent).toBe(5);
    expect(done.phase).toBe('complete');
    expect(done.refusedAt).toBeNull();
    expect(done.observedPeriod).toBeNull();
  });

  it('records the spend as real usage, tagged so it cannot poison scoring', async () => {
    stub = startStub(3);
    await listening(stub.server);
    seedCustomKey(`http://127.0.0.1:${stub.port}/v1`);

    const run = startBurnRun({ platform: 'custom', maxRequests: 20, maxSeconds: 30 });
    await settle(run.id);

    // The allowance was genuinely consumed, so the rows exist...
    const rows = getDb().prepare(
      "SELECT request_type, COUNT(*) n FROM requests GROUP BY request_type",
    ).all() as { request_type: string; n: number }[];
    expect(rows).toHaveLength(1);
    expect(rows[0]!.request_type).toBe('burn_test');
    expect(rows[0]!.n).toBe(4);
    // ...and nothing untagged leaked in, which is what keeps reliability
    // scoring and organic inference clear of a deliberate 429 storm.
    const untagged = getDb().prepare(
      "SELECT COUNT(*) n FROM requests WHERE request_type <> 'burn_test'",
    ).get() as { n: number };
    expect(untagged.n).toBe(0);
  });

  it('reports a broken experiment as failed, not as a discovered limit', async () => {
    // 404 on every call: the model does not exist. Recording that as a ceiling
    // would invent a limit out of a configuration error.
    stub = startStub(0);
    await listening(stub.server);
    const port = stub.port;
    stub.server.removeAllListeners('request');
    stub.server.on('request', (_req, res) => {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'no such model' } }));
    });
    seedCustomKey(`http://127.0.0.1:${port}/v1`);

    const run = startBurnRun({ platform: 'custom', maxRequests: 10, maxSeconds: 30 });
    await settle(run.id);

    const done = getBurnRun(run.id)!;
    expect(done.phase).toBe('failed');
    expect(done.refusedAt).toBeNull();
    expect(done.failureError).toContain('404');
  });

  it('refuses a second concurrent run on the same platform', async () => {
    stub = startStub(1000);
    await listening(stub.server);
    seedCustomKey(`http://127.0.0.1:${stub.port}/v1`);

    // Both calls are synchronous and the loop's first request has not resolved,
    // so the first run is provably still burning here.
    const first = startBurnRun({ platform: 'custom', maxRequests: 50, maxSeconds: 30 });
    // Two burns on one account cannot attribute the refusal, and each would be
    // wrong by the other's traffic.
    expect(() => startBurnRun({ platform: 'custom', maxRequests: 5, maxSeconds: 30 }))
      .toThrow(BurnStartError);
    cancelBurnRun(first.id);
    await settle(first.id);
  });

  it('refuses to start without a usable key', () => {
    expect(() => startBurnRun({ platform: 'custom', maxRequests: 5, maxSeconds: 30 }))
      .toThrow(/No usable enabled key/);
  });

  it('cancels cooperatively, mid-run', async () => {
    // The stub cancels the run itself on its third request: a real event at a
    // known point in the loop, rather than a sleep long enough to hope for one.
    let runId: string | null = null;
    let served = 0;
    const server = createServer((_req, res) => {
      served++;
      if (served === 3 && runId) cancelBurnRun(runId);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        id: 'x', object: 'chat.completion', model: 'stub-model',
        choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 },
      }));
    });
    server.listen(0, '127.0.0.1');
    await listening(server);
    try {
      seedCustomKey(`http://127.0.0.1:${(server.address() as { port: number }).port}/v1`);
      const run = startBurnRun({ platform: 'custom', maxRequests: 200, maxSeconds: 60 });
      runId = run.id;
      await settle(run.id);

      const done = getBurnRun(run.id)!;
      expect(done.phase).toBe('cancelled');
      // Stopped at the cancellation point, nowhere near the cap.
      expect(done.requestsSent).toBe(3);
      expect(activeBurnRun('custom')).toBeNull();
    } finally {
      server.close();
    }
  });

  it('clamps a request beyond the hard ceiling instead of honouring it', () => {
    stub = startStub(1000);
    seedCustomKey('http://127.0.0.1:1/v1');
    const run = startBurnRun({ platform: 'custom', maxRequests: 99_999, maxSeconds: 99_999 });
    expect(run.maxRequests).toBe(BURN_LIMITS.maxRequests);
    expect(run.maxSeconds).toBe(BURN_LIMITS.maxSeconds);
    cancelBurnRun(run.id);
  });

  describe('recovery', () => {
    it('dates the window when the provider comes back', async () => {
      stub = startStub(2);
      await listening(stub.server);
      const keyId = seedCustomKey(`http://127.0.0.1:${stub.port}/v1`);

      const run = startBurnRun({ platform: 'custom', maxRequests: 20, maxSeconds: 30 });
      await settle(run.id);
      expect(getBurnRun(run.id)!.phase).toBe('recovering');

      // Backdate the refusal by two hours and let the provider serve again:
      // that is what a real reset looks like to the poller.
      getDb().prepare(
        "UPDATE quota_burn_run SET refused_at = datetime('now', '-2 hours') WHERE id = ?",
      ).run(run.id);
      stub.server.removeAllListeners('request');
      stub.server.on('request', (_req, res) => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({
          id: 'x', object: 'chat.completion', model: 'stub-model',
          choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 },
        }));
      });

      await pollBurnRecovery();
      const done = getBurnRun(run.id)!;
      expect(done.phase).toBe('complete');
      expect(done.recoveredAt).not.toBeNull();
      expect(done.observedPeriod).toBe('hour');
      expect(keyId).toBeGreaterThan(0);
    });

    it('leaves a run recovering while the provider is still refusing', async () => {
      stub = startStub(1);
      await listening(stub.server);
      seedCustomKey(`http://127.0.0.1:${stub.port}/v1`);

      const run = startBurnRun({ platform: 'custom', maxRequests: 20, maxSeconds: 30 });
      await settle(run.id);
      await pollBurnRecovery();
      expect(getBurnRun(run.id)!.phase).toBe('recovering');
    });

    it('gives up at the agreed horizon rather than reporting a guessed period', async () => {
      stub = startStub(1);
      await listening(stub.server);
      seedCustomKey(`http://127.0.0.1:${stub.port}/v1`);

      const run = startBurnRun({ platform: 'custom', maxRequests: 20, maxSeconds: 30, maxPeriod: 'day' });
      await settle(run.id);
      getDb().prepare(
        "UPDATE quota_burn_run SET refused_at = datetime('now', '-40 hours') WHERE id = ?",
      ).run(run.id);

      await pollBurnRecovery();
      const done = getBurnRun(run.id)!;
      expect(done.phase).toBe('complete');
      // A day-scoped run that never recovered says nothing about a month.
      expect(done.observedPeriod).toBeNull();
    });

    it('maps elapsed time onto the window a reader cares about', () => {
      expect(classifyRecovery(30_000)).toBe('minute');
      expect(classifyRecovery(45 * 60_000)).toBe('hour');
      expect(classifyRecovery(20 * 3_600_000)).toBe('day');
      expect(classifyRecovery(5 * 86_400_000)).toBe('week');
      expect(classifyRecovery(20 * 86_400_000)).toBe('month');
    });
  });

  it('lists runs newest first, scoped by platform', async () => {
    stub = startStub(1);
    await listening(stub.server);
    seedCustomKey(`http://127.0.0.1:${stub.port}/v1`);
    const run = startBurnRun({ platform: 'custom', maxRequests: 5, maxSeconds: 30 });
    await settle(run.id);
    expect(listBurnRuns('custom').map(r => r.id)).toEqual([run.id]);
    expect(listBurnRuns('groq')).toEqual([]);
  });
});

// The design rests on one split: burn traffic counts as quota spend but not as
// evidence of provider quality. Tagging the rows was the easy half; these pin
// that the two readers actually skip them, because a refactor could quietly
// drop either filter and nothing else would fail.
describe('burn traffic isolation', () => {
  beforeEach(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
    getDb().prepare('DELETE FROM requests').run();
  });

  function seedModel(): { keyId: number; modelDbId: number } {
    const secret = encrypt('sk-x');
    const keyId = Number(getDb().prepare(`
      INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled)
      VALUES ('groq', 'k', ?, ?, ?, 'active', 1)
    `).run(secret.encrypted, secret.iv, secret.authTag).lastInsertRowid);
    const modelDbId = Number(getDb().prepare(`
      INSERT INTO models (platform, model_id, display_name, intelligence_rank, speed_rank, key_id, enabled)
      VALUES ('groq', 'iso-model', 'Iso Model', 50, 50, ?, 1)
    `).run(keyId).lastInsertRowid);
    return { keyId, modelDbId };
  }

  function insertFailures(keyId: number, requestType: string, n: number): void {
    const stmt = getDb().prepare(`
      INSERT INTO requests (platform, model_id, key_id, status, input_tokens, output_tokens, latency_ms, error, request_type)
      VALUES ('groq', 'iso-model', ?, 'error', 0, 0, 10, 'HTTP 429 rate limited', ?)
    `);
    for (let i = 0; i < n; i++) stmt.run(keyId, requestType);
  }

  function statsFor(modelDbId: number): { reliability: number; totalRequests: number } {
    refreshStatsCache(getDb(), true);
    const row = getRoutingScores().scores.find(s => s.modelDbId === modelDbId);
    if (!row) throw new Error('model missing from routing scores');
    return { reliability: row.reliability, totalRequests: row.totalRequests };
  }

  it('does not let a burn run demote the provider it measured', () => {
    const { keyId, modelDbId } = seedModel();
    const clean = statsFor(modelDbId);

    insertFailures(keyId, 'burn_test', 25);
    const afterBurn = statsFor(modelDbId);
    // Twenty-five deliberate refusals, and the router has not observed a thing.
    expect(afterBurn.totalRequests).toBe(clean.totalRequests);
    expect(afterBurn.reliability).toBe(clean.reliability);

    // The same rows untagged DO demote it — which is what makes the assertion
    // above meaningful rather than a test of an empty table.
    insertFailures(keyId, 'chat', 25);
    const afterReal = statsFor(modelDbId);
    expect(afterReal.totalRequests).toBeGreaterThan(0);
    expect(afterReal.reliability).toBeLessThan(clean.reliability);
  });

  it('keeps a deliberate exhaustion out of the organic window estimate', () => {
    const { keyId } = seedModel();
    const insert = getDb().prepare(`
      INSERT INTO requests (platform, model_id, key_id, status, input_tokens, output_tokens, latency_ms, error, request_type, created_at)
      VALUES ('groq', 'iso-model', ?, ?, 0, 0, 10, ?, ?, ?)
    `);
    const iso = (ms: number) => new Date(ms).toISOString().replace('T', ' ').replace('Z', '');
    let at = Date.UTC(2026, 0, 1);
    // Refusal-then-recovery pairs: exactly the shape inference reads.
    for (let i = 0; i < 6; i++) {
      insert.run(keyId, 'error', 'HTTP 429 rate limited', 'burn_test', iso(at));
      at += 9_000;
      insert.run(keyId, 'success', null, 'burn_test', iso(at));
      at += 3_600_000;
    }
    expect(inferWindowsFromRecovery('groq')).toEqual([]);

    // Untagged, the identical pattern is evidence — so the emptiness above is
    // the filter working, not the estimator failing to see anything.
    at = Date.UTC(2026, 1, 1);
    for (let i = 0; i < 6; i++) {
      insert.run(keyId, 'error', 'HTTP 429 rate limited', 'chat', iso(at));
      at += 9_000;
      insert.run(keyId, 'success', null, 'chat', iso(at));
      at += 3_600_000;
    }
    expect(inferWindowsFromRecovery('groq').map(w => w.period)).toContain('minute');
  });
});
