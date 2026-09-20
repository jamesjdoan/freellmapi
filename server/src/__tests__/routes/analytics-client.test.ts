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
  it('separates devices by their User-Agent, not the classifier label', async () => {
    const response = await get(app, '/api/analytics/by-client?range=7d', token);
    expect(response.status).toBe(200);
    expect(response.body).toHaveLength(2);
    expect(response.body[0]).toMatchObject({
      clientAgent: 'Mac Studio',
      requests: 2,
      successRate: 50,
      avgLatencyMs: 200,
    });
    expect(response.body[1]).toMatchObject({
      clientAgent: 'MacBook Pro',
      requests: 1,
      successRate: 100,
    });
  });

  // One machine reports a new User-Agent every time its harness updates. Left
  // ungrouped that is a fresh row per version — five rows for two computers on
  // the install this was written against — so versions fold into the device,
  // and the raw agents come back with it so the fold can be audited.
  it('folds one device\'s harness versions into a single row', async () => {
    getDb().prepare(`
      INSERT INTO requests (platform, model_id, status, input_tokens, output_tokens, latency_ms, client_user_agent)
      VALUES ('groq', 'coder', 'success', 1, 1, 50, 'omp-studio/2')
    `).run();

    const response = await get(app, '/api/analytics/by-client?range=7d', token);
    const studio = response.body.find((r: any) => r.clientAgent === 'Mac Studio');
    expect(studio.requests).toBe(3);
    expect(studio.agents).toEqual(['omp-studio/1', 'omp-studio/2']);
    // Still two devices, not three rows.
    expect(response.body).toHaveLength(2);
  });

  // Tagging arrived after most rows were written, so a bare `omp/*` row is
  // attributed to the Studio. That is the operator's ruling about their own
  // machines rather than something the data proves, and it is the one mapping
  // rule a future reader is most likely to want to find.
  it('attributes untagged omp history to the Studio', async () => {
    getDb().prepare(`
      INSERT INTO requests (platform, model_id, status, input_tokens, output_tokens, latency_ms, client_user_agent)
      VALUES ('groq', 'coder', 'success', 1, 1, 50, 'omp/18.1.16')
    `).run();
    // A caller that is not this harness at all, seeded so the final assertion
    // can actually fail: it must survive as itself, not be folded anywhere.
    getDb().prepare(`
      INSERT INTO requests (platform, model_id, status, input_tokens, output_tokens, latency_ms, client_user_agent)
      VALUES ('groq', 'coder', 'success', 1, 1, 50, 'curl/8.7.1')
    `).run();

    const response = await get(app, '/api/analytics/by-client?range=7d', token);
    const studio = response.body.find((r: any) => r.clientAgent === 'Mac Studio');
    expect(studio.requests).toBe(3);
    expect(studio.agents).toContain('omp/18.1.16');
    expect(studio.agents).not.toContain('curl/8.7.1');
    // The non-omp caller stands alone rather than being swept into a device.
    expect(response.body.map((r: any) => r.clientAgent)).toContain('curl/8.7.1');
  });

  // Savings are per-caller so an operator can see what each machine's traffic
  // would have cost. Token counts are deliberately in the millions: at a few
  // tokens every expectation rounds to $0.00 and would hold even if failed
  // requests were charged, or if pricing returned zero for everything.
  it('prices each device, counting only its successful requests', async () => {
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
    const studio = response.body.find((r: any) => r.clientAgent === 'Mac Studio');
    const mbp = response.body.find((r: any) => r.clientAgent === 'MacBook Pro');

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

// The page-wide device tabs. Every panel takes `?device=`, so the filter has
// to reach each endpoint's own query — including the ones that normally read
// the hourly aggregate, which has no device dimension and silently answers for
// every machine if it is left in place.
describe('device filtering (?device=)', () => {
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
    getDb().prepare('DELETE FROM request_hourly').run();
    const insert = getDb().prepare(`
      INSERT INTO requests
        (platform, model_id, status, input_tokens, output_tokens, latency_ms, client_user_agent, error)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    // Studio: two successes on groq, one error.
    insert.run('groq', 'coder', 'success', 1_000_000, 0, 100, 'omp-studio/1', null);
    insert.run('groq', 'coder', 'success', 1_000_000, 0, 100, 'omp/18.1.16', null);
    insert.run('groq', 'coder', 'error', 0, 0, 100, 'omp-studio/1', 'rate limit');
    // MacBook: one success on google.
    insert.run('google', 'flash', 'success', 1_000_000, 0, 900, 'omp-mbp/1', null);

    // The UNFILTERED summary reads request_hourly, which real traffic updates
    // in the same transaction as the raw row (lib/request-log.ts). Seeding only
    // `requests` would leave the all-devices totals at zero and make a filtered
    // view look larger than the whole — so mirror the writer here, one bucket
    // row per request, as logRequest does.
    const hour = new Date().toISOString().slice(0, 13).replace('T', ' ') + ':00:00';
    getDb().prepare(`
      INSERT INTO request_hourly (hour, total_requests, success_count, error_count, input_tokens, output_tokens)
      VALUES (?, 4, 3, 1, 3000000, 0)
    `).run(hour);
  });

  it('scopes the summary to one device', async () => {
    const all = await get(app, '/api/analytics/summary?range=7d', token);
    const mbp = await get(app, '/api/analytics/summary?range=7d&device=MacBook%20Pro', token);

    expect(all.body.totalRequests).toBe(4);
    expect(mbp.body.totalRequests).toBe(1);
    // Latency is the MacBook's alone, not the mean of every machine.
    expect(mbp.body.avgLatencyMs).toBe(900);
    // $0.20/M fallback on 1M input tokens.
    expect(mbp.body.estimatedCostSavings).toBe(0.2);
  });

  it('scopes the provider and model breakdowns', async () => {
    const platforms = await get(app, '/api/analytics/by-platform?range=7d&device=MacBook%20Pro', token);
    expect(platforms.body.map((r: any) => r.platform)).toEqual(['google']);

    const models = await get(app, '/api/analytics/by-model?range=7d&device=Mac%20Studio', token);
    expect(models.body.map((r: any) => r.modelId)).toEqual(['coder']);
  });

  it('scopes errors, and a device with none gets an empty list', async () => {
    const studio = await get(app, '/api/analytics/errors?range=7d&device=Mac%20Studio', token);
    expect(studio.body).toHaveLength(1);

    const mbp = await get(app, '/api/analytics/errors?range=7d&device=MacBook%20Pro', token);
    expect(mbp.body).toHaveLength(0);
  });

  it('keeps the recent-calls total and rows describing the same set', async () => {
    const { body } = await get(app, '/api/analytics/requests?range=7d&device=Mac%20Studio', token);
    expect(body.total).toBe(3);
    expect(body.rows).toHaveLength(3);
  });

  // The timeline normally reads request_hourly, which buckets by hour and
  // nothing else. Filtering has to switch it to the raw rows or it answers for
  // every machine while the rest of the page is scoped to one.
  it('scopes the timeline rather than falling back to the hourly aggregate', async () => {
    const { body } = await get(app, '/api/analytics/timeline?range=7d&device=MacBook%20Pro', token);
    const total = body.reduce((sum: number, b: any) => sum + b.requests, 0);
    expect(total).toBe(1);
  });

  it('treats a missing or "all" device as unfiltered', async () => {
    const bare = await get(app, '/api/analytics/summary?range=7d', token);
    const all = await get(app, '/api/analytics/summary?range=7d&device=all', token);
    expect(all.body.totalRequests).toBe(bare.body.totalRequests);
    expect(all.body.totalRequests).toBe(4);
  });

  it('returns an empty view for a device name nothing matches', async () => {
    const { body } = await get(app, '/api/analytics/summary?range=7d&device=Nonexistent', token);
    expect(body.totalRequests).toBe(0);
    expect(body.estimatedCostSavings).toBe(0);
  });
});
