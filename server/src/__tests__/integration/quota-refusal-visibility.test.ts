import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Express } from 'express';
import { createApp } from '../../app.js';
import { getDb, initDb, getSetting, setSetting } from '../../db/index.js';
import { encrypt } from '../../lib/crypto.js';
import { mintDashboardToken } from '../helpers/auth.js';
import { upsertQuotaPolicy } from '../../services/quota-policy.js';
import { setRoutingStrategy, routeRequest } from '../../services/router.js';
import { invalidateShadowCounts, resetLeases } from '../../services/ratelimit.js';
import { invalidateQuotaPressure } from '../../services/quota-pressure.js';
import { getProviderQuotaOverview, invalidateQuotaInference } from '../../services/quota-forecast.js';
import {
  setFallbackHeaders,
  EXPOSE_FALLBACK_DETAIL_SETTING,
} from '../../lib/fallback-loop.js';
import { newRequestTrace, noteSkippedCandidates, runWithRequestTrace } from '../../lib/attempt-trace.js';

// A request the quota gate refuses, followed end to end: HTTP in, persistence,
// then back out through the Analytics API an operator actually reads.
//
// The gap this closes: a refusal decided before any upstream was tried wrote NO
// `requests` row and no attempts. The verbatim per-candidate disposition — the
// only thing that names the scope, the metric and WHICH SOURCE stated the limit
// — existed solely as a console line inside the container. So a request the
// gate correctly turned away and one it wrongly turned away were
// indistinguishable from the dashboard: both were simply absent.
//
// Renaming a bucket in the error message does not fix that, which is why this
// test asserts the durable row and the API payload rather than the string.

let dashToken = '';

async function call(app: Express, path: string, init?: RequestInit) {
  const server = app.listen(0, '127.0.0.1');
  if (!server.listening) await new Promise<void>(resolve => server.once('listening', () => resolve()));
  const addr = server.address() as { port: number };
  const res = await fetch(`http://127.0.0.1:${addr.port}${path}`, init);
  const body = await res.json().catch(() => null);
  server.close();
  return { status: res.status, body };
}

function reset(): void {
  process.env.ENCRYPTION_KEY = '0'.repeat(64);
  initDb(':memory:');
  const db = getDb();
  db.prepare('DELETE FROM request_attempts').run();
  db.prepare('DELETE FROM requests').run();
  db.prepare('DELETE FROM fallback_config').run();
  db.prepare('DELETE FROM profile_models').run();
  db.prepare('DELETE FROM models').run();
  db.prepare('DELETE FROM api_keys').run();
  db.prepare('DELETE FROM quota_policy').run();
  db.prepare('DELETE FROM rate_limit_usage').run();
  invalidateShadowCounts();
  invalidateQuotaPressure();
  resetLeases();
  invalidateQuotaInference();
  dashToken = mintDashboardToken();
}

function activeProfileId(): number {
  const row = getDb().prepare("SELECT value FROM settings WHERE key = 'active_profile_id'").get() as { value: string };
  return Number(row.value);
}

function addKey(platform: string): number {
  const secret = encrypt(`${platform}-refusal-test`);
  return Number(getDb().prepare(
    "INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled) VALUES (?, 'refusal', ?, ?, ?, 'healthy', 1)",
  ).run(platform, secret.encrypted, secret.iv, secret.authTag).lastInsertRowid);
}

function addRoute(platform: string, modelId: string, priority: number): number {
  const db = getDb();
  const id = Number(db.prepare(`
    INSERT INTO models (platform, model_id, display_name, intelligence_rank, speed_rank, size_label,
      rpm_limit, rpd_limit, tpm_limit, tpd_limit, monthly_token_budget, context_window, enabled,
      supports_vision, supports_tools)
    VALUES (?, ?, ?, 1, 1, 'Frontier', NULL, NULL, NULL, NULL, '', 128000, 1, 0, 1)
  `).run(platform, modelId, `${modelId} (${platform})`).lastInsertRowid);
  db.prepare('INSERT INTO fallback_config (model_db_id, priority, enabled) VALUES (?, ?, 1)').run(id, priority);
  db.prepare('INSERT INTO profile_models (profile_id, model_db_id, priority, enabled) VALUES (?, ?, ?, 1)')
    .run(activeProfileId(), id, priority);
  return id;
}

function spend(platform: string, modelId: string, keyId: number, n: number): void {
  const stmt = getDb().prepare(
    "INSERT INTO rate_limit_usage (platform, model_id, key_id, kind, tokens, created_at_ms) VALUES (?, ?, ?, 'request', 0, ?)",
  );
  for (let i = 0; i < n; i++) stmt.run(platform, modelId, keyId, Date.now());
  invalidateShadowCounts();
  invalidateQuotaPressure();
}

function spendOperatorAllowance(platform: string, limit: number): void {
  upsertQuotaPolicy({
    platform, modelId: null, endpointScope: null,
    scope: 'provider_account', metric: 'requests', limit,
    periodKind: 'calendar_day', periodMs: null, timezone: 'UTC', anchorDay: null,
    source: 'operator',
  });
}

describe('a quota-refused request is visible to the operator', () => {
  let app: Express;
  beforeAll(() => { reset(); app = createApp(); });
  beforeEach(reset);

  async function chat(model: string) {
    const key = getSetting('unified_api_key') ?? '';
    return call(app, '/v1/chat/completions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, max_tokens: 5, messages: [{ role: 'user', content: 'hi' }] }),
    });
  }

  it('answers 429 rate_limit_exceeded rather than a generic routing failure', async () => {
    const keyId = addKey('groq');
    addRoute('groq', 'only', 1);
    spendOperatorAllowance('groq', 2);
    spend('groq', 'only', keyId, 2);
    setRoutingStrategy('priority');

    const res = await chat('auto');
    expect(res.status).toBe(429);
    // A spent allowance resets, so waiting is the right advice. Before this the
    // gate's diagnostic matched no classifier and produced `routing_exhausted`
    // with no retry hint at all.
    expect(res.body.error.code).toBe('rate_limit_exceeded');
    expect(res.body.error.message).toContain('quota allowance spent');
  });

  it('persists a row naming the scope, metric and source that closed it', async () => {
    const keyId = addKey('groq');
    addRoute('groq', 'only', 1);
    spendOperatorAllowance('groq', 2);
    spend('groq', 'only', keyId, 2);
    setRoutingStrategy('priority');

    await chat('auto:default');

    const row = getDb().prepare(
      "SELECT platform, model_id, requested_model, status, error FROM requests ORDER BY id DESC LIMIT 1",
    ).get() as { platform: string; model_id: string; requested_model: string; status: string; error: string } | undefined;

    expect(row).toBeDefined();
    // No provider was involved, so none is invented.
    expect(row!.platform).toBe('routing');
    expect(row!.requested_model).toBe('auto:default');
    expect(row!.status).toBe('error');
    // The part that makes the difference between correct enforcement and a
    // misfiring gate legible: which limit, at what scope, stated by whom.
    expect(row!.error).toContain('quota-domain-exhausted(provider_account:requests:operator)');
    expect(row!.error).toContain('groq/only');
  });

  it('surfaces that row through the Analytics API', async () => {
    const keyId = addKey('groq');
    addRoute('groq', 'only', 1);
    spendOperatorAllowance('groq', 2);
    spend('groq', 'only', keyId, 2);
    setRoutingStrategy('priority');

    await chat('auto');

    const list = await call(app, '/api/analytics/requests?limit=5', {
      headers: { Authorization: `Bearer ${dashToken}` },
    });
    expect(list.status).toBe(200);
    const refusal = (list.body.rows as { platform: string; error: string | null }[])
      .find(r => r.platform === 'routing');
    expect(refusal).toBeDefined();
    expect(refusal!.error).toContain('quota-domain-exhausted');
  });

  it('records why a candidate was passed over even when the request SUCCEEDS', async () => {
    // The harder half. A 200 that failed over past a quota-blocked route looks
    // identical to one that never met a gate, so the skipped dispositions ride
    // on the served hop's trace.
    const groqKey = addKey('groq');
    addKey('nvidia');
    addRoute('groq', 'blocked', 1);
    addRoute('nvidia', 'serves', 2);
    spendOperatorAllowance('groq', 2);
    spend('groq', 'blocked', groqKey, 2);
    setRoutingStrategy('priority');

    // routeRequest is what records this; the upstream call is irrelevant here
    // and would need a live provider, so assert on the route it returned.
    const routed = routeRequest(100);
    routed.release?.();

    expect(routed.platform).toBe('nvidia');
    const trace = routed.routingTrace!;
    // Reached second in the walk, because the first candidate was refused.
    expect(trace.selectionRank).toBe(2);
    expect(trace.selectionOverride).toBeNull();
    expect(trace.skipped.join(' ')).toContain('quota-domain-exhausted(provider_account:requests:operator)');
    expect(trace.skipped.join(' ')).toContain('groq/blocked');
  });
});

describe('the caller of a SUCCESSFUL request can see what was skipped', () => {
  beforeEach(() => { reset(); setSetting(EXPOSE_FALLBACK_DETAIL_SETTING, '1'); });

  it('stamps X-Fallback-Skipped, which the trail structurally cannot carry', () => {
    // X-Fallback-Trail lists hops that were DISPATCHED and failed. A candidate
    // the quota gate refused is never dispatched, so it can never appear there
    // — and a request that then succeeded returned 200 with no failed attempts
    // and no hint that a gate had fired at all.
    const groqKey = addKey('groq');
    addKey('nvidia');
    addRoute('groq', 'blocked', 1);
    addRoute('nvidia', 'serves', 2);
    spendOperatorAllowance('groq', 2);
    spend('groq', 'blocked', groqKey, 2);
    setRoutingStrategy('priority');

    const headers = new Map<string, string>();
    const res = { setHeader: (name: string, value: string) => { headers.set(name, value); } };

    const trace = newRequestTrace();
    runWithRequestTrace(trace, () => {
      const routed = routeRequest(100);
      routed.release?.();
      // What the loop does with a route in hand, before dispatch.
      noteSkippedCandidates(routed.routingTrace?.skipped ?? []);
      // Zero failed attempts: this is the successful-request case.
      setFallbackHeaders(res, 0, []);
    });

    // No hop failed, so neither of the attempt-shaped headers is set.
    expect(headers.has('X-Fallback-Attempts')).toBe(false);
    expect(headers.has('X-Fallback-Trail')).toBe(false);

    const skipped = headers.get('X-Fallback-Skipped');
    expect(skipped).toBeDefined();
    expect(skipped).toContain('groq/blocked');
    expect(skipped).toContain('quota-domain-exhausted(provider_account:requests:operator)');
    // Readable in a header: safeHeaderValue percent-escapes non-ASCII, so the
    // diagnostics' em-dash would otherwise ship as `%E2%80%94` mid-line.
    expect(skipped).not.toContain('%E2%80%94');
    expect(skipped).not.toContain('\u2014');
  });

  it('stays silent when nothing was skipped', () => {
    addKey('nvidia');
    addRoute('nvidia', 'serves', 1);
    setRoutingStrategy('priority');

    const headers = new Map<string, string>();
    const res = { setHeader: (name: string, value: string) => { headers.set(name, value); } };
    const trace = newRequestTrace();
    runWithRequestTrace(trace, () => {
      const routed = routeRequest(100);
      routed.release?.();
      noteSkippedCandidates(routed.routingTrace?.skipped ?? []);
      setFallbackHeaders(res, 0, []);
    });

    expect(headers.has('X-Fallback-Skipped')).toBe(false);
  });

  it('withholds it unless the operator opted in', () => {
    // The lines name quota scope, metric and which source stated the limit.
    // That is operator diagnostics, not something every API client is handed.
    setSetting(EXPOSE_FALLBACK_DETAIL_SETTING, '0');
    const groqKey = addKey('groq');
    addKey('nvidia');
    addRoute('groq', 'blocked', 1);
    addRoute('nvidia', 'serves', 2);
    spendOperatorAllowance('groq', 2);
    spend('groq', 'blocked', groqKey, 2);
    setRoutingStrategy('priority');

    const headers = new Map<string, string>();
    const res = { setHeader: (name: string, value: string) => { headers.set(name, value); } };
    const trace = newRequestTrace();
    runWithRequestTrace(trace, () => {
      const routed = routeRequest(100);
      routed.release?.();
      noteSkippedCandidates(routed.routingTrace?.skipped ?? []);
      setFallbackHeaders(res, 0, []);
    });

    expect(headers.has('X-Fallback-Skipped')).toBe(false);
  });
});

describe('the quota panel says who spends each pool', () => {
  beforeEach(reset);

  it('names every routed model on a shared account allowance', () => {
    // The reason the panel needed this: `nvidia::credit-pool 540/10000` told a
    // reader nothing about whether one overflow route or four chain heads were
    // draining it. An account-scoped axis is spent by every routed model on the
    // platform, and listing them on the one row is what stops a shared
    // allowance reading as depth.
    addKey('nvidia');
    addRoute('nvidia', 'kimi', 1);
    addRoute('nvidia', 'deepseek', 2);
    addRoute('nvidia', 'nemotron', 3);
    spendOperatorAllowance('nvidia', 100);

    const rows = getProviderQuotaOverview().filter(r => r.platform === 'nvidia' && r.metered);
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row.members).toHaveLength(3);
      expect(row.members.join(' ')).toContain('kimi');
    }
  });

  it('keeps a provider-reported per-model pool to its own model', () => {
    // Groq meters per model, so two routes are two allowances and must not be
    // collapsed. Membership comes from resolveQuotaPolicy rather than the
    // pool-key string, which has already changed shape once (Groq moved from
    // `groq::account` to `groq::model::<id>`).
    const keyId = addKey('groq');
    addRoute('groq', 'a', 1);
    addRoute('groq', 'b', 2);
    const report = getDb().prepare(`
      INSERT INTO provider_quota_state
        (platform, key_id, quota_pool_key, metric, limit_value, remaining_value, source, confidence, observed_at)
      VALUES ('groq', ?, ?, 'requests', 1000, 900, 'quota_api', 0.9, datetime('now'))
    `);
    report.run(keyId, 'groq::model::a');
    report.run(keyId, 'groq::model::b');

    const reported = getProviderQuotaOverview()
      .filter(r => r.platform === 'groq' && r.pool?.startsWith('groq::model::'));
    expect(reported).toHaveLength(2);
    for (const row of reported) {
      expect(row.members).toHaveLength(1);
      // The pool names the model, and so does its single member.
      const modelId = row.members[0]!.split(' ')[0]!;
      expect(row.pool).toBe(`groq::model::${modelId}`);
    }
  });

  it('names no members for a pool nothing routes to', () => {
    // A catalogue model nobody routes to cannot drain anything, so listing it
    // under a pool would overstate the pressure on that pool.
    addKey('groq');
    const id = addRoute('groq', 'shelved', 1);
    getDb().prepare('UPDATE profile_models SET enabled = 0 WHERE model_db_id = ?').run(id);
    spendOperatorAllowance('groq', 100);

    for (const row of getProviderQuotaOverview().filter(r => r.platform === 'groq')) {
      expect(row.members).toEqual([]);
    }
  });
});

describe('a paid credit balance names only the routes that can bill it', () => {
  beforeEach(reset);

  it('excludes :free OpenRouter routes from openrouter::credits', () => {
    // Found by looking at the live panel: the paid balance listed six `:free`
    // routes as its spenders. None of them can touch it — OpenRouter serves
    // free and paid through one credential, told apart only by the model id —
    // and this is the same free/paid conflation the admission gate had to be
    // corrected for twice.
    const keyId = addKey('openrouter');
    addRoute('openrouter', 'poolside/laguna-s-2.1:free', 1);
    addRoute('openrouter', 'cohere/north-mini-code:free', 2);
    getDb().prepare(`
      INSERT INTO provider_quota_state
        (platform, key_id, quota_pool_key, metric, limit_value, remaining_value, unit, source, confidence, observed_at)
      VALUES ('openrouter', ?, 'openrouter::credits', 'credits', 1200, 1200, 'cents', 'quota_api', 0.9, datetime('now'))
    `).run(keyId);

    const credits = getProviderQuotaOverview().find(r => r.pool === 'openrouter::credits');
    expect(credits).toBeDefined();
    expect(credits!.members).toEqual([]);
  });

  it('still names every model on a credit balance with no free/paid split', () => {
    // Ollama's weekly balance is also denominated in credits, and every Ollama
    // model spends it. A broader rule would have emptied the very row that
    // motivated showing membership in the first place.
    const keyId = addKey('ollama');
    addRoute('ollama', 'nemotron-3-ultra', 1);
    addRoute('ollama', 'nemotron-3-super', 2);
    getDb().prepare(`
      INSERT INTO provider_quota_state
        (platform, key_id, quota_pool_key, metric, limit_value, remaining_value, unit, source, confidence, observed_at)
      VALUES ('ollama', ?, 'ollama::weekly', 'credits', 10000, 540, 'per_10k', 'quota_api', 0.9, datetime('now'))
    `).run(keyId);

    const weekly = getProviderQuotaOverview().find(r => r.pool === 'ollama::weekly');
    expect(weekly).toBeDefined();
    expect(weekly!.members).toHaveLength(2);
  });
});

describe('a pool retired by a later split is not shown as a live cap', () => {
  beforeEach(reset);

  function observe(platform: string, keyId: number, pool: string, limit: number, remaining: number): void {
    getDb().prepare(`
      INSERT INTO provider_quota_state
        (platform, key_id, quota_pool_key, metric, limit_value, remaining_value, source, confidence, observed_at)
      VALUES (?, ?, ?, 'requests', ?, ?, 'header', 1.0, datetime('now'))
    `).run(platform, keyId, pool, limit, remaining);
  }

  it('drops groq::account once per-model pools have been observed', () => {
    // Groq meters per model and always did; `groq::account` is what those same
    // per-model headers were filed under BEFORE the split. Shown beside the
    // live rows it asserts an account-wide ceiling that does not exist, and the
    // membership fallback then names every routed model under it — which reads
    // as "one cap over all models" and is wrong.
    const keyId = addKey('groq');
    addRoute('groq', 'openai/gpt-oss-20b', 1);
    addRoute('groq', 'openai/gpt-oss-120b', 2);
    observe('groq', keyId, 'groq::account', 1000, 999);
    observe('groq', keyId, 'groq::model::openai/gpt-oss-20b', 1000, 1000);
    observe('groq', keyId, 'groq::model::openai/gpt-oss-120b', 1000, 1000);

    const pools = getProviderQuotaOverview().filter(r => r.platform === 'groq').map(r => r.pool);
    expect(pools).not.toContain('groq::account');
    expect(pools).toEqual(expect.arrayContaining([
      'groq::model::openai/gpt-oss-20b',
      'groq::model::openai/gpt-oss-120b',
    ]));
  });

  it('keeps the legacy pool while it is the only figure in hand', () => {
    // The read-compat path is deliberate: an install that has not yet recorded
    // a per-model row still has a real number under the old key, and hiding it
    // would leave the panel emptier than the evidence.
    const keyId = addKey('groq');
    addRoute('groq', 'openai/gpt-oss-20b', 1);
    observe('groq', keyId, 'groq::account', 1000, 999);

    const pools = getProviderQuotaOverview().filter(r => r.platform === 'groq').map(r => r.pool);
    expect(pools).toContain('groq::account');
  });

  it('leaves google::account alone — it is not the retired key', () => {
    // Only `google::project` is superseded by `google::project-model::<id>`.
    // `google::account` is a different pool and still written today; a blanket
    // "hide account-scoped keys" rule would have taken it out with the phantom.
    const keyId = addKey('google');
    addRoute('google', 'gemini-3.7-flash', 1);
    observe('google', keyId, 'google::project', 100, 90);
    observe('google', keyId, 'google::account', 200, 180);
    observe('google', keyId, 'google::project-model::gemini-3.7-flash', 20, 19);

    const pools = getProviderQuotaOverview().filter(r => r.platform === 'google').map(r => r.pool);
    expect(pools).not.toContain('google::project');
    expect(pools).toContain('google::account');
  });
});
