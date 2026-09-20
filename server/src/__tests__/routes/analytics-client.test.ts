import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Express } from 'express';
import { createApp } from '../../app.js';
import { getDb, initDb } from '../../db/index.js';
import { mintDashboardToken } from '../helpers/auth.js';

async function get(app: Express, path: string, token: string) {
  const server = app.listen(0, '127.0.0.1');
  if (!server.listening) await new Promise<void>(resolve => server.once('listening', () => resolve()));
  const address = server.address() as { port: number };
  const response = await fetch(`http://127.0.0.1:${address.port}${path}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const body = await response.json();
  server.close();
  return { status: response.status, body: body as any };
}

describe('GET /api/analytics/by-client', () => {
  let app: Express;
  let token: string;

  beforeAll(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
    app = createApp();
    token = mintDashboardToken();
  });

  beforeEach(() => {
    getDb().prepare('DELETE FROM requests').run();
    const insert = getDb().prepare(`
      INSERT INTO requests
        (platform, model_id, status, input_tokens, output_tokens, latency_ms, client_agent, client_user_agent)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    // Two machines running the SAME harness. The classifier has no rule for it,
    // so `client_agent` is the identical label on every row and only the
    // operator-set User-Agent tells them apart.
    insert.run('groq', 'coder', 'success', 10, 5, 100, 'unknown', 'omp-studio/1');
    insert.run('groq', 'coder', 'error', 8, 0, 300, 'unknown', 'omp-studio/1');
    insert.run('google', 'flash', 'success', 4, 2, 80, 'unknown', 'omp-mbp/1');
  });

  // The bug this pins: grouping on `client_agent` collapsed every caller into
  // one 'unknown' row, because that column only labels harnesses the classifier
  // recognises. Two machines must stay two rows.
  it('separates callers by their User-Agent, not the classifier label', async () => {
    const response = await get(app, '/api/analytics/by-client?range=7d', token);
    expect(response.status).toBe(200);
    expect(response.body).toHaveLength(2);
    expect(response.body[0]).toMatchObject({
      clientAgent: 'omp-studio/1',
      requests: 2,
      successRate: 50,
      avgLatencyMs: 200,
    });
    expect(response.body[1]).toMatchObject({
      clientAgent: 'omp-mbp/1',
      requests: 1,
      successRate: 100,
    });
  });

  // Savings are per-caller so an operator can see what each machine's traffic
  // would have cost. Token counts are deliberately in the millions: at a few
  // tokens every expectation rounds to $0.00 and would hold even if failed
  // requests were charged, or if pricing returned zero for everything.
  it('prices each caller, counting only its successful requests', async () => {
    getDb().prepare('DELETE FROM requests').run();
    const insert = getDb().prepare(`
      INSERT INTO requests
        (platform, model_id, status, input_tokens, output_tokens, latency_ms, client_agent, client_user_agent)
      VALUES (?, ?, ?, ?, ?, ?, 'unknown', ?)
    `);
    // Seeded models carry no paid equivalent, so both rows price at the
    // documented fallback: $0.20/M in, $0.80/M out.
    // 10M in + 5M out -> 2.00 + 4.00 = $6.00
    insert.run('groq', 'coder', 'success', 10_000_000, 5_000_000, 100, 'omp-studio/1');
    // An identical FAILED request must add nothing. If it were counted the
    // studio row would read $12.00.
    insert.run('groq', 'coder', 'error', 10_000_000, 5_000_000, 300, 'omp-studio/1');
    // 1M in + 1M out -> 0.20 + 0.80 = $1.00
    insert.run('google', 'flash', 'success', 1_000_000, 1_000_000, 80, 'omp-mbp/1');

    const response = await get(app, '/api/analytics/by-client?range=7d', token);
    const studio = response.body.find((r: any) => r.clientAgent === 'omp-studio/1');
    const mbp = response.body.find((r: any) => r.clientAgent === 'omp-mbp/1');

    expect(studio.estimatedCost).toBe(6);
    expect(mbp.estimatedCost).toBe(1);
    // Token totals still count every request, successful or not — only the
    // pricing is success-scoped.
    expect(studio.totalInputTokens).toBe(20_000_000);
    expect(mbp.totalInputTokens).toBe(1_000_000);
  });

  it('keeps an untagged caller visible instead of dropping it', async () => {
    getDb().prepare(`
      INSERT INTO requests (platform, model_id, status, input_tokens, output_tokens, latency_ms)
      VALUES ('groq', 'coder', 'success', 1, 1, 10)
    `).run();

    const response = await get(app, '/api/analytics/by-client?range=7d', token);
    expect(response.body.map((r: any) => r.clientAgent)).toContain('unknown');
  });
});
