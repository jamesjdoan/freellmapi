import { describe, it, expect, beforeEach } from 'vitest';
import type { ChatCompletionResponse, ChatMessage } from '@freellmapi/shared/types.js';
import { initDb, getDb } from '../../db/index.js';
import { encrypt } from '../../lib/crypto.js';
import { invalidateQuotaPressure } from '../../services/quota-pressure.js';
import { resetExtensionStateCache, setExtensionEnabled } from '../../services/extension-state.js';
import {
  ROUTE_PROBE_EXTENSION_ID,
  probeRouteNow,
  recordBenchImport,
  runRouteProbePass,
  selectProbeCandidates,
  type RouteProbeDeps,
} from '../../services/route-probe.js';
import { loadRouteEvidence, routeKeyOf } from '../../services/route-evidence.js';
import type { CallOptions } from '../../services/model-bench/runner.js';

// The probe spends real free quota, so its budget rules are the behaviour that
// matters: which routes it may touch, how often, and that what it learns lands
// as history without ever benching a route.

const HOUR = 3_600_000;
const NOW = Date.parse('2026-10-26T12:00:00Z');

function reset(): void {
  process.env.ENCRYPTION_KEY = '0'.repeat(64);
  initDb(':memory:');
  const db = getDb();
  for (const t of ['fallback_config', 'profile_models', 'models', 'api_keys', 'requests', 'route_probe_result', 'rate_limit_usage', 'rate_limit_cooldowns']) {
    db.prepare(`DELETE FROM ${t}`).run();
  }
  invalidateQuotaPressure();
  resetExtensionStateCache();
  setExtensionEnabled(ROUTE_PROBE_EXTENSION_ID, true);
}

function addKey(platform: string, baseUrl: string | null = null): number {
  const secret = encrypt(`${platform}-probe-test-key`);
  return Number(getDb().prepare(`
    INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled, base_url)
    VALUES (?, 'probe-test', ?, ?, ?, 'healthy', 1, ?)
  `).run(platform, secret.encrypted, secret.iv, secret.authTag, baseUrl).lastInsertRowid);
}

function addModel(platform: string, modelId: string, opts: { endpointScope?: string; keyId?: number } = {}): number {
  return Number(getDb().prepare(`
    INSERT INTO models (platform, model_id, display_name, intelligence_rank, speed_rank, size_label,
      monthly_token_budget, context_window, enabled, supports_vision, supports_tools, endpoint_scope, key_id)
    VALUES (?, ?, ?, 5, 5, 'Large', '', 128000, 1, 0, 1, ?, ?)
  `).run(platform, modelId, modelId, opts.endpointScope ?? '', opts.keyId ?? null).lastInsertRowid);
}

function addChain(name: string, members: number[]): void {
  const db = getDb();
  const profileId = Number(db.prepare("INSERT INTO profiles (name, type) VALUES (?, 'custom')").run(name).lastInsertRowid);
  members.forEach((id, i) => db.prepare('INSERT INTO profile_models (profile_id, model_db_id, priority, enabled) VALUES (?, ?, ?, 1)').run(profileId, id, i + 1));
}

function realRequest(platform: string, modelId: string, modelDbId: number, status: 'success' | 'error', at: number): void {
  getDb().prepare(`
    INSERT INTO requests (platform, model_id, model_db_id, status, latency_ms, created_at)
    VALUES (?, ?, ?, ?, 900, ?)
  `).run(platform, modelId, modelDbId, status, new Date(at).toISOString().replace('T', ' ').slice(0, 19));
}

const reply = (content: string, toolCalls: Array<{ name: string; args: object }> = []): ChatCompletionResponse => ({
  id: 'r', object: 'chat.completion', created: 0, model: 'm',
  choices: [{
    index: 0,
    message: { role: 'assistant', content, ...(toolCalls.length ? { tool_calls: toolCalls.map((t, i) => ({ id: `c${i}`, type: 'function' as const, function: { name: t.name, arguments: JSON.stringify(t.args) } })) } : {}) },
    finish_reason: toolCalls.length ? 'tool_calls' : 'stop',
  }],
  usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 },
});

/** A caller that answers A1 correctly and anything else with plain text. */
function scripted(respond?: (messages: ChatMessage[], options: CallOptions) => ChatCompletionResponse): RouteProbeDeps & { calls: number } {
  const state = { calls: 0 } as RouteProbeDeps & { calls: number };
  state.makeCaller = () => async (messages, options) => {
    state.calls++;
    if (respond) return respond(messages, options);
    if (options.tools?.some(t => t.function.name === 'convert_currency')) return reply('', [{ name: 'convert_currency', args: { amount: 250, from: 'EUR', to: 'USD' } }]);
    return reply('{"priority": "high", "component": "login"}');
  };
  return state;
}

const probeRows = () => getDb().prepare('SELECT * FROM route_probe_result ORDER BY id').all() as Array<Record<string, unknown>>;

describe('which routes a probe may spend quota on', () => {
  beforeEach(reset);

  it('probes only chain routes, and never one real traffic already measured today', async () => {
    addKey('groq');
    const quiet = addModel('groq', 'quiet-route');
    const busy = addModel('groq', 'busy-route');
    addModel('groq', 'not-in-a-chain');
    addChain('Apex', [quiet, busy]);
    realRequest('groq', 'busy-route', busy, 'success', NOW - 2 * HOUR);

    const { eligible, skipped } = selectProbeCandidates(getDb(), NOW);
    expect(eligible.map(c => c.modelId)).toEqual(['quiet-route']);
    expect(skipped).toEqual([expect.objectContaining({ modelId: 'busy-route', reason: 'served real traffic in the last 24h' })]);
  });

  it('refuses a route that would bill paid balance', () => {
    addKey('openrouter');
    addChain('Apex', [addModel('openrouter', 'anthropic/claude-sonnet-5'), addModel('openrouter', 'qwen/qwen3-coder:free')]);
    const { eligible, skipped } = selectProbeCandidates(getDb(), NOW);
    expect(eligible.map(c => c.modelId)).toEqual(['qwen/qwen3-coder:free']);
    expect(skipped[0]).toMatchObject({ modelId: 'anthropic/claude-sonnet-5', reason: 'bills paid balance' });
  });

  it('spends one probe a day on a route with no known daily limit, and rotates scenarios day to day', async () => {
    addKey('groq');
    addChain('Apex', [addModel('groq', 'r')]);
    const deps = scripted();

    const first = await runRouteProbePass({ now: NOW, deps });
    expect(first.probed.map(p => p.scenarioId)).toEqual(['A1']);
    // Same day: the allowance is spent.
    expect(selectProbeCandidates(getDb(), NOW + HOUR).skipped[0].reason).toMatch(/daily probe allowance spent \(1\/1\)/);

    // probed_at_ms is the real start time, so move "now" past it by a day.
    const firstAt = Number(probeRows()[0].probed_at_ms);
    const second = await runRouteProbePass({ now: firstAt + 25 * HOUR, deps });
    expect(second.probed.map(p => p.scenarioId)).toEqual(['A2']);
  });

  it('probes the least-evidenced route first', () => {
    addKey('groq');
    const known = addModel('groq', 'known');
    const unknown = addModel('groq', 'unknown');
    addChain('Apex', [known, unknown]);
    for (let i = 0; i < 5; i++) realRequest('groq', 'known', known, 'error', NOW - 30 * HOUR);
    expect(selectProbeCandidates(getDb(), NOW).eligible.map(c => c.modelId)).toEqual(['unknown', 'known']);
  });
});

describe('what a probe records', () => {
  beforeEach(reset);

  it('grades the answer into history and counts the call without touching cooldowns', async () => {
    const keyId = addKey('groq');
    addChain('Apex', [addModel('groq', 'r')]);
    const result = await runRouteProbePass({ now: NOW, deps: scripted() });

    expect(result.probed[0].result).toMatchObject({ ok: true, scenarioId: 'A1', outcome: 'ok', status: 'PASS' });
    expect(probeRows()[0]).toMatchObject({ platform: 'groq', model_id: 'r', key_id: keyId, scenario_id: 'A1', source: 'probe', streamed: 1, outcome: 'ok', status: 'PASS', prompt_tokens: 100, completion_tokens: 20 });
    // The provider counted the call, so the usage window must too...
    expect((getDb().prepare("SELECT COUNT(*) AS n FROM rate_limit_usage WHERE kind = 'request'").get() as { n: number }).n).toBe(1);
    // ...but a probe is a question, never a verdict.
    expect((getDb().prepare('SELECT COUNT(*) AS n FROM rate_limit_cooldowns').get() as { n: number }).n).toBe(0);
  });

  it('records an empty stream and a timeout as failures, and a 429 as quota rather than the model', async () => {
    addKey('groq');
    addChain('Apex', [addModel('groq', 'empty'), addModel('groq', 'slow'), addModel('groq', 'spent')]);
    const deps = scripted();
    deps.makeCaller = candidate => async () => {
      if (candidate.modelId === 'empty') throw new Error('empty completion from groq/empty (stream produced no content and no tool calls)');
      if (candidate.modelId === 'slow') throw Object.assign(new Error('The operation was aborted (groq, chat, 60s)'), { name: 'AbortError' });
      throw Object.assign(new Error('Groq API error 429: Rate limit reached'), { status: 429 });
    };
    await runRouteProbePass({ now: NOW, deps });

    const byModel = Object.fromEntries(probeRows().map(r => [r.model_id, r.outcome]));
    expect(byModel).toEqual({ empty: 'empty', slow: 'timeout', spent: 'rate_limited' });
    const evidence = loadRouteEvidence(getDb(), { now: NOW + HOUR });
    expect(evidence.get(routeKeyOf({ platform: 'groq', modelId: 'empty', endpointScope: '' }))!.probe).toMatchObject({ n: 1, ok: 0 });
    // A spent quota says nothing about the model, so it is not a failed sample.
    expect(evidence.get(routeKeyOf({ platform: 'groq', modelId: 'spent', endpointScope: '' }))!.probe).toMatchObject({ n: 0, ok: 0 });
  });

  it('sends nothing while the extension is off, scheduled or manual', async () => {
    addKey('groq');
    addChain('Apex', [addModel('groq', 'r')]);
    setExtensionEnabled(ROUTE_PROBE_EXTENSION_ID, false);
    const deps = scripted();
    expect((await runRouteProbePass({ now: NOW, deps })).probed).toEqual([]);
    expect(await probeRouteNow({ platform: 'groq', modelId: 'r', endpointScope: '' }, { deps })).toMatchObject({ ok: false, refused: expect.stringMatching(/switched off/) });
    expect(deps.calls).toBe(0);
  });

  it('probes a custom route only through the relay that serves it', async () => {
    const relay = addKey('custom', 'https://relay-a.example/v1');
    addKey('custom', 'https://relay-b.example/v1');
    addModel('custom', 'shared-id', { endpointScope: 'https://relay-a.example/v1', keyId: relay });
    let usedKey: number | null = null;
    const deps: RouteProbeDeps = { makeCaller: (_c, key) => { usedKey = key.id; return async () => reply('{"priority": "high"}'); } };
    await probeRouteNow({ platform: 'custom', modelId: 'shared-id', endpointScope: 'https://relay-a.example/v1' }, { deps });
    expect(usedKey).toBe(relay);
    expect(probeRows()[0]).toMatchObject({ endpoint_scope: 'https://relay-a.example/v1', key_id: relay });
  });
});

describe('imported bench runs join the route history', () => {
  beforeEach(reset);

  const run = (results: Record<string, { status: string; score?: number | null; cached?: boolean; note?: string }>) => ({
    benchVersion: '1.0.0', startedAt: '2026-10-20T00:00:00.000Z',
    config: { platform: 'custom', modelId: 'coder', endpoint: 'https://relay-a.example/v1/' }, results,
  });

  it('writes every scenario that ran, once, under the relay that served it', () => {
    const written = recordBenchImport(run({
      A1: { status: 'PASS', score: 100 },
      C1: { status: 'FAIL', score: 20 },
      C2: { status: 'NOT_TESTED', score: null },
      C3: { status: 'PASS', score: 90, cached: true },
      A2: { status: 'INCONCLUSIVE', score: null, note: 'endpoint error: Custom API error 429: rate limited' },
    }));
    expect(written).toBe(3);
    expect(probeRows().map(r => [r.scenario_id, r.outcome, r.status, r.endpoint_scope, r.source, r.streamed])).toEqual([
      ['A1', 'ok', 'PASS', 'https://relay-a.example/v1', 'import', 0],
      ['C1', 'ok', 'FAIL', 'https://relay-a.example/v1', 'import', 0],
      ['A2', 'rate_limited', 'INCONCLUSIVE', 'https://relay-a.example/v1', 'import', 0],
    ]);
    // Re-importing the same file adds nothing.
    expect(recordBenchImport(run({ A1: { status: 'PASS', score: 100 } }))).toBe(0);

    const screen = loadRouteEvidence(getDb(), { now: Date.parse('2026-10-26T00:00:00Z') })
      .get(routeKeyOf({ platform: 'custom', modelId: 'coder', endpointScope: 'https://relay-a.example/v1' }))!.screen;
    expect(screen.coding).toEqual({ mean: 20, graded: 1 });
    expect(screen.agentic).toEqual({ mean: 100, graded: 1 });
  });
});
