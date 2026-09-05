/**
 * Quota shadow harness — drives REAL HTTP traffic through the full proxy path
 * against stub providers, then prints what the shadow router concluded.
 *
 *   cd server && npm run quota:harness
 *
 * Why this exists as a script rather than a test. Every quota defect found so
 * far was found by running the system, not by the suite: the discovery capture
 * gated on pooling semantics, the scoring that preferred a nearly-exhausted
 * scarce pool, the ledger that could not tell two relays apart, and a partial
 * status_code fix. Each unit test supplied inputs that avoided the broken case.
 * This exercises the wiring they cannot: the HTTP surface, the fallback loop,
 * request logging, metering, header capture and the shadow ledger, end to end.
 *
 * It is destructive to NOTHING: FREEAPI_DB_PATH points at a temp directory that
 * is deleted on exit. The env var matters — DATA_DIR does not exist, and a run
 * pointed at it writes to the live server/data/freeapi.db.
 */
import { createServer } from 'node:http';
import type { Server } from 'node:http';
import { once } from 'node:events';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const workDir = mkdtempSync(path.join(tmpdir(), 'fla-harness-'));
process.env.FREEAPI_DB_PATH = path.join(workDir, 'freeapi.db');
process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY ?? '0'.repeat(64);
// The stubs are on loopback; the safety check that normally refuses private
// base URLs would reject them.
process.env.ALLOW_PRIVATE_BASE_URL = '1';

// Static, like routing-sim.ts: nothing here connects at import time, and
// getDefaultDbPath() reads FREEAPI_DB_PATH when initDb() runs inside main().
import { initDb, getDb } from '../db/index.js';
import { createApp } from '../app.js';
const MODEL = 'nemotron-3-ultra';
/** Ephemeral ports: a fixed pair collides with anything else on the box, and a
 *  harness that fails on a busy port teaches nothing about the system. */
const STUB_COUNT = 2;

/** An OpenAI-compatible provider that reports quota headers, including the
 *  duration reset format our parser cannot read — so the capture path is
 *  exercised for real rather than assumed. */
function startStub(label: string, remaining: number): Server {
  const server = createServer((req, res) => {
    const json = (code: number, body: unknown, headers: Record<string, string> = {}): void => {
      res.writeHead(code, { 'content-type': 'application/json', ...headers });
      res.end(JSON.stringify(body));
    };
    if (req.url?.startsWith('/v1/models')) {
      json(200, { object: 'list', data: [{ id: MODEL, object: 'model' }] });
      return;
    }
    if (req.url?.startsWith('/v1/chat/completions')) {
      json(200, {
        id: `chatcmpl-${label}`,
        object: 'chat.completion',
        model: MODEL,
        choices: [{ index: 0, message: { role: 'assistant', content: `hello from ${label}` }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 },
      }, {
        'x-ratelimit-limit-requests': '1000',
        'x-ratelimit-remaining-requests': String(remaining),
        'x-ratelimit-reset-requests': '2m59.56s',
      });
      return;
    }
    json(404, { error: 'not found' });
  });
  server.listen(0, '127.0.0.1');
  return server;
}

function portOf(server: Server): number {
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('stub server has no TCP port');
  return address.port;
}

async function main(): Promise<void> {
  const stubs = Array.from({ length: STUB_COUNT }, (_, i) => startStub(`stub${i + 1}`, 997 - i * 400));
  await Promise.all(stubs.map(stub => once(stub, 'listening')));

  initDb();
  const app = createApp();
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = portOf(server);
  const base = `http://127.0.0.1:${port}`;

  const call = async (method: string, url: string, token: string | null, body?: unknown): Promise<Record<string, unknown>> => {
    const res = await fetch(`${base}${url}`, {
      method,
      headers: {
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return await res.json() as Record<string, unknown>;
  };

  const setup = await call('POST', '/api/auth/setup', null, { email: 'harness@harness.test', password: 'HarnessTest12345!' });
  if (typeof setup.token !== 'string') throw new Error(`setup failed: ${JSON.stringify(setup)}`);
  const token = setup.token;

  for (const [i, stub] of stubs.entries()) {
    const stubPort = portOf(stub);
    const registered = await call('POST', '/api/keys/custom', token, {
      baseUrl: `http://127.0.0.1:${stubPort}/v1`,
      label: `stub-${i + 1}`,
      apiKey: 'sk-stub',
      models: [{ model: MODEL, displayName: `Nemotron 3 Ultra (stub${i + 1})` }],
    });
    if (registered.success !== true) throw new Error(`register stub${i + 1} failed: ${JSON.stringify(registered)}`);
  }

  // Narrow the chain to the two stubs so the router faces exactly the choice
  // under study: one logical model, two providers.
  const db = getDb();
  const ids = (db.prepare("SELECT id FROM models WHERE platform = 'custom' AND model_id = ?").all(MODEL) as { id: number }[]).map(r => r.id);
  db.prepare('UPDATE profile_models SET enabled = 0').run();
  db.prepare('UPDATE fallback_config SET enabled = 0').run();
  for (const [i, id] of ids.entries()) {
    db.prepare('UPDATE profile_models SET enabled = 1, priority = ? WHERE model_db_id = ?').run(i + 1, id);
    db.prepare('UPDATE fallback_config SET enabled = 1, priority = ? WHERE model_db_id = ?').run(i + 1, id);
  }

  const unifiedKey = (db.prepare("SELECT value FROM settings WHERE key = 'unified_api_key'").get() as { value: string }).value;
  console.log(`\nDriving 5 requests through ${base}/v1/chat/completions\n`);
  for (let i = 0; i < 5; i++) {
    const reply = await call('POST', '/v1/chat/completions', unifiedKey, {
      model: 'auto',
      messages: [{ role: 'user', content: 'hi' }],
    });
    const choices = reply.choices as { message: { content: string } }[] | undefined;
    console.log(`  ${i + 1}. ${choices?.[0]?.message.content ?? JSON.stringify(reply).slice(0, 120)}`);
  }

  // The shadow write is deferred off the response path.
  await nextTurn();

  console.log('\n── shadow ─────────────────────────────────────────────');
  console.log(JSON.stringify(await call('GET', '/api/quota/shadow', token), null, 2));

  console.log('\n── decisions ──────────────────────────────────────────');
  const decisions = (await call('GET', '/api/quota/decisions?limit=5', token)).decisions as Record<string, unknown>[];
  for (const d of decisions) {
    console.log(`  served ${d.actualPlatform}[${d.actualEndpoint ?? '-'}] · shadow ${d.shadowPlatform}[${d.shadowEndpoint ?? '-'}] · agreed=${d.agreed}`);
    console.log(`    ${d.reason}`);
  }

  console.log('\n── metering + capture ─────────────────────────────────');
  const counts = db.prepare(`
    SELECT (SELECT COUNT(*) FROM requests) AS requests,
           (SELECT COUNT(*) FROM rate_limit_usage) AS usage,
           (SELECT COUNT(*) FROM routing_decision) AS decisions,
           (SELECT COUNT(*) FROM provider_quota_observations WHERE raw_json IS NOT NULL) AS captured
  `).get();
  console.log(' ', JSON.stringify(counts));
  const sample = db.prepare("SELECT raw_json FROM provider_quota_observations WHERE raw_json IS NOT NULL LIMIT 1").get() as { raw_json: string } | undefined;
  console.log('  captured headers:', sample?.raw_json ?? '(none)');

  server.close();
  for (const stub of stubs) stub.close();
}

main()
  .catch(err => {
    console.error('harness failed:', err);
    process.exitCode = 1;
  })
  .finally(() => {
    rmSync(workDir, { recursive: true, force: true });
    // Stub servers and the app keep handles open; nothing here is worth waiting on.
    process.exit(process.exitCode ?? 0);
  });
