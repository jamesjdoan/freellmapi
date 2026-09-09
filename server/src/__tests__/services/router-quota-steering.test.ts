import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { initDb, getDb } from '../../db/index.js';
import { encrypt } from '../../lib/crypto.js';
import { routeRequest, setRoutingStrategy } from '../../services/router.js';
import { upsertQuotaPolicy } from '../../services/quota-policy.js';
import {
  invalidateShadowCounts,
  acquireLease,
  resetLeases,
  canMakeRequest,
  hasActiveCooldown,
} from '../../services/ratelimit.js';
import { invalidateQuotaPressure, quotaPressure, quotaDomainsAdmit } from '../../services/quota-pressure.js';
import { routingExhaustionBody } from '../../lib/fallback-loop.js';
import { pressurePenaltyPositions, harvestPromotionPositions } from '../../services/scoring.js';

// End-to-end through routeRequest, not through the scoring helpers.
//
// The helpers are unit-tested next door, but a helper that returns the right
// number and is then clipped, dropped or never called changes nothing about
// which model serves a request. Both effects below were exactly that at one
// point: harvesting was computed and then flattened by the guardrail `min`, and
// spreading was computed and then skipped entirely in the 'priority' branch —
// the strategy this deployment actually runs. These tests fail if either
// regresses, because they only look at what routeRequest returned.

function reset(): void {
  process.env.ENCRYPTION_KEY = '0'.repeat(64);
  initDb(':memory:');
  const db = getDb();
  db.prepare('DELETE FROM fallback_config').run();
  db.prepare('DELETE FROM profile_models').run();
  db.prepare('DELETE FROM models').run();
  db.prepare('DELETE FROM api_keys').run();
  db.prepare('DELETE FROM quota_policy').run();
  db.prepare('DELETE FROM rate_limit_usage').run();
  invalidateShadowCounts();
  invalidateQuotaPressure();
  resetLeases();
}

function activeProfileId(): number {
  const row = getDb().prepare("SELECT value FROM settings WHERE key = 'active_profile_id'").get() as { value: string };
  return Number(row.value);
}

function addKey(platform: string): number {
  const secret = encrypt(`${platform}-steering-test`);
  return Number(getDb().prepare(
    "INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled) VALUES (?, 'steering', ?, ?, ?, 'healthy', 1)",
  ).run(platform, secret.encrypted, secret.iv, secret.authTag).lastInsertRowid);
}

/** Two routes identical on every axis the scorer reads, so the only thing that
 *  can separate them is the effect under test. */
function addRoute(platform: string, modelId: string, priority: number): number {
  const db = getDb();
  const id = Number(db.prepare(`
    INSERT INTO models (platform, model_id, display_name, intelligence_rank, speed_rank, size_label,
      rpm_limit, rpd_limit, tpm_limit, tpd_limit, monthly_token_budget, context_window, enabled,
      supports_vision, supports_tools)
    VALUES (?, ?, ?, 1, 1, 'Frontier', NULL, NULL, NULL, NULL, '', 128000, 1, 0, 1)
  `).run(platform, modelId, `Twin Model (${platform})`).lastInsertRowid);
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

/** A calendar-day pool: it has a real reset instant, which is what harvesting
 *  needs. A rolling window has none and is deliberately never harvested. */
function dailyPolicy(platform: string, limit: number): void {
  upsertQuotaPolicy({
    platform, modelId: null, endpointScope: null,
    scope: 'provider_account', metric: 'requests', limit,
    periodKind: 'calendar_day', periodMs: null, timezone: 'UTC', anchorDay: null,
    source: 'operator',
  });
}

describe('reset urgency reaches the chosen route', () => {
  beforeEach(reset);

  it('prefers the pool whose unspent daily allowance is about to expire', () => {
    // The brief's own case, verbatim: a daily pool ~80% unused with its window
    // about to turn over, against an identical pool that has no deadline.
    //
    // The first draft scored both at exactly 1.0. Harvesting was expressed only
    // as relief from the scarcity penalty, and at 80% headroom there is no
    // penalty to relax — so the one example the feature exists for produced no
    // effect whatsoever. This test is what makes that regression visible,
    // because it looks at the platform routeRequest actually returned.
    //
    // The clock is pinned rather than read: "45 minutes before the UTC day
    // rolls over" is the whole premise, and a test that only asserts it between
    // 23:00 and midnight is a test that passes by not running.
    vi.useFakeTimers();
    try {
      const dayStart = Date.UTC(2026, 8, 9);
      vi.setSystemTime(new Date(dayStart + 86_400_000 - 45 * 60_000)); // 23:15 UTC

      const groqKey = addKey('groq');
      addKey('nvidia');
      addRoute('groq', 'twin', 2);   // deliberately BEHIND nvidia in the chain
      addRoute('nvidia', 'twin', 1);

      // Groq: 1000/day, 200 spent — 80% of the allowance is still there and it
      // expires in 45 minutes. 94% of the day has elapsed against 20% of the
      // pool, so paceDelta is about -0.74.
      dailyPolicy('groq', 1000);
      spend('groq', 'twin', groqKey, 200);
      // NVIDIA: a generous pool with no reset instant. Nothing expires, so
      // there is nothing to harvest — the correct answer for a rolling window.
      dailyPolicy('nvidia', 10_000);

      const groq = quotaPressure('groq', 'twin', '');
      const nvidia = quotaPressure('nvidia', 'twin', '');

      // Both are comfortable on scarcity: this is not a penalty being relaxed.
      expect(groq.scarcity).toBe(1);
      expect(nvidia.scarcity).toBe(1);
      // Only the expiring one is preferred.
      expect(groq.harvest).toBeGreaterThan(1);
      expect(nvidia.harvest).toBe(1);

      // And it reaches the decision, from behind in the manual order.
      setRoutingStrategy('priority');
      const routed = routeRequest(100);
      routed.release?.();
      expect(routed.platform).toBe('groq');
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not harvest the same pool earlier in the day', () => {
    // Same allowance, same 80% unused, hours of window left: nothing is about
    // to be wasted, so there is nothing to prefer. Time and unspent allowance
    // are both required, and this is the half that proves it.
    vi.useFakeTimers();
    try {
      const dayStart = Date.UTC(2026, 8, 9);
      vi.setSystemTime(new Date(dayStart + 6 * 60 * 60_000)); // 06:00 UTC

      const groqKey = addKey('groq');
      addRoute('groq', 'twin', 1);
      dailyPolicy('groq', 1000);
      spend('groq', 'twin', groqKey, 200);

      expect(quotaPressure('groq', 'twin', '').harvest).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('carries the boost into priority mode, where it is a promotion', () => {
    // Priority mode never reaches combineScore, so the boost has to be
    // expressed in positions there or it is silently dropped in the strategy
    // this deployment runs.
    // Scarcity costs positions; harvesting earns them back, on its own scale
    // so the promotion is large enough to actually move a route.
    expect(pressurePenaltyPositions(1)).toBe(0);
    expect(pressurePenaltyPositions(0.5)).toBeGreaterThan(0);
    expect(harvestPromotionPositions(1)).toBe(0);
    expect(harvestPromotionPositions(1.08)).toBeLessThan(-1);
  });

  it('does not prefer a pool that spent its allowance on schedule', () => {
    const groqKey = addKey('groq');
    addKey('nvidia');
    addRoute('groq', 'twin', 1);
    addRoute('nvidia', 'twin', 2);
    dailyPolicy('groq', 100);
    // Fully spent: nothing left to harvest however soon the window turns over,
    // and steering more traffic here would just bring the refusal forward.
    spend('groq', 'twin', groqKey, 100);

    expect(quotaPressure('groq', 'twin', '').harvest).toBe(1);
  });
});

describe('provider diversity reaches the chosen route', () => {
  beforeEach(reset);
  // Pinned mid-morning UTC on purpose. These cases are about SPREADING and
  // about what the trace records; leaving the wall clock free let reset-urgency
  // harvesting fire whenever the suite happened to run late in the UTC day,
  // which changed `harvest` from 1 to 1.068 and moved the very ranks under
  // test. A test whose result depends on the hour it runs is a test that
  // sometimes passes by not exercising anything.
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date(Date.UTC(2026, 8, 9, 9, 0, 0))); });
  afterEach(() => { vi.useRealTimers(); });

  it('spreads a concurrent worker onto the idle pool under the priority strategy', () => {
    addKey('groq');
    addKey('nvidia');
    addRoute('groq', 'twin', 1);    // the operator's first choice
    addRoute('nvidia', 'twin', 2);
    // Identical, generous, MEASURED pools on both sides. Without a published
    // limit a pool scores UNKNOWN_POOL_PRESSURE rather than 1, and NVIDIA ships
    // a default minute cap while Groq does not — so leaving them unmetered
    // would have the unknown-quota rule deciding this test instead of spreading.
    dailyPolicy('groq', 10_000);
    dailyPolicy('nvidia', 10_000);
    setRoutingStrategy('priority');

    // With nothing in flight, the manual order stands — spreading must not
    // touch a sequential caller.
    const alone = routeRequest(100);
    alone.release?.();
    expect(alone.platform).toBe('groq');

    // Two workers already in the air on Groq's pool. A third arriving now has
    // an identical NVIDIA route sitting idle, and piling onto one allowance
    // while an equivalent one goes unused is throughput thrown away.
    resetLeases();
    acquireLease('groq', 'twin', 1, 100);
    acquireLease('groq', 'twin', 1, 100);
    invalidateQuotaPressure();

    const contended = routeRequest(100);
    contended.release?.();
    expect(contended.platform).toBe('nvidia');
  });

  it('spreads under a bandit strategy too', () => {
    addKey('groq');
    addKey('nvidia');
    addRoute('groq', 'twin', 1);
    addRoute('nvidia', 'twin', 2);
    dailyPolicy('groq', 10_000);
    dailyPolicy('nvidia', 10_000);
    setRoutingStrategy('balanced');

    acquireLease('groq', 'twin', 1, 100);
    acquireLease('groq', 'twin', 1, 100);
    invalidateQuotaPressure();

    // Thompson sampling makes any single draw a coin flip, so assert the
    // distribution: the idle pool must win the clear majority rather than the
    // even split two identical routes would otherwise produce.
    let nvidia = 0;
    for (let i = 0; i < 200; i++) {
      const routed = routeRequest(100);
      routed.release?.();
      if (routed.platform === 'nvidia') nvidia++;
    }
    expect(nvidia).toBeGreaterThan(110);
  });

  it('moves a contended route past one neighbour, never past two', () => {
    addKey('groq');
    addKey('nvidia');
    addKey('google');
    addRoute('groq', 'twin', 1);
    addRoute('nvidia', 'twin', 2);
    addRoute('google', 'twin', 3);
    dailyPolicy('groq', 10_000);
    dailyPolicy('nvidia', 10_000);
    dailyPolicy('google', 10_000);
    setRoutingStrategy('priority');

    acquireLease('groq', 'twin', 1, 100);
    acquireLease('groq', 'twin', 1, 100);
    invalidateQuotaPressure();

    // Demoted by just over one position: the immediate neighbour takes the
    // request, and the operator's ordering still decides everything else.
    const routed = routeRequest(100);
    routed.release?.();
    expect(routed.platform).toBe('nvidia');
  });
});

describe('an exhausted quota domain closes the route, not just its rank', () => {
  beforeEach(reset);

  it('refuses a model whose own meter is healthy but whose account pool is spent', () => {
    // §6's case exactly. Nothing is on cooldown, no provider header has reported
    // a zero, and the model's own rpm/rpd counters are untouched — so every hard
    // gate the router already had says yes. The only thing that knows the
    // account is finished is the operator's own quota_policy row, and until this
    // gate existed that knowledge could only lower a score.
    //
    // Lower is not unavailable. A demoted route is still served the instant its
    // alternatives run out, which is precisely when a spent account pool is
    // guaranteed to refuse.
    const groqKey = addKey('groq');
    addRoute('groq', 'twin', 1);
    upsertQuotaPolicy({
      platform: 'groq', modelId: null, endpointScope: null,
      scope: 'provider_account', metric: 'requests', limit: 25,
      periodKind: 'calendar_day', periodMs: null, timezone: 'UTC', anchorDay: null,
      source: 'operator',
    });
    spend('groq', 'twin', groqKey, 25);
    setRoutingStrategy('priority');

    // The model's own meter has no complaint, and nothing has refused us.
    expect(canMakeRequest('groq', 'twin', groqKey, { rpm: null, rpd: null, tpm: null, tpd: null })).toBe(true);
    expect(hasActiveCooldown('groq', 'twin')).toBe(false);

    // With no alternative at all, routing must FAIL rather than fall through.
    expect(() => routeRequest(100)).toThrow();
  });

  it('names the domain that closed it, for the routing diagnostic', () => {
    const groqKey = addKey('groq');
    addRoute('groq', 'twin', 1);
    upsertQuotaPolicy({
      platform: 'groq', modelId: null, endpointScope: null,
      scope: 'provider_account', metric: 'requests', limit: 5,
      periodKind: 'calendar_day', periodMs: null, timezone: 'UTC', anchorDay: null,
      source: 'operator',
    });
    spend('groq', 'twin', groqKey, 5);

    const decision = quotaDomainsAdmit('groq', 'twin', '');
    expect(decision.ok).toBe(false);
    expect(decision.blockedBy).toContain('provider_account');
    expect(decision.blockedBy).toContain('operator');
  });

  it('lets a sibling on an independent pool keep serving', () => {
    // The gate closes one domain, not the platform. Groq meters per model, so
    // exhausting one model's stated allowance says nothing about another's.
    const groqKey = addKey('groq');
    addRoute('groq', 'spent', 1);
    addRoute('groq', 'fresh', 2);
    for (const modelId of ['spent', 'fresh']) {
      upsertQuotaPolicy({
        platform: 'groq', modelId, endpointScope: null,
        scope: 'model', metric: 'requests', limit: 10,
        periodKind: 'calendar_day', periodMs: null, timezone: 'UTC', anchorDay: null,
        source: 'operator',
      });
    }
    spend('groq', 'spent', groqKey, 10);
    setRoutingStrategy('priority');

    const routed = routeRequest(100);
    routed.release?.();
    expect(routed.modelId).toBe('fresh');
  });

  it('does not close a route on a shipped catalogue guess', () => {
    // Blocking on a limit nobody stated suppresses capacity that is really
    // there, which is the expensive direction of this error. A catalogue
    // default demotes and nothing more.
    const groqKey = addKey('groq');
    addRoute('groq', 'twin', 1);
    upsertQuotaPolicy({
      platform: 'groq', modelId: null, endpointScope: null,
      scope: 'provider_account', metric: 'requests', limit: 5,
      periodKind: 'calendar_day', periodMs: null, timezone: 'UTC', anchorDay: null,
      source: 'catalog',
    });
    spend('groq', 'twin', groqKey, 5);
    setRoutingStrategy('priority');

    expect(quotaDomainsAdmit('groq', 'twin', '').ok).toBe(true);
    const routed = routeRequest(100);
    routed.release?.();
    expect(routed.platform).toBe('groq');
  });

  it('reopens the route once the window rolls over', () => {
    // Recovery needs no bookkeeping: usage is counted inside the axis's own
    // window, so yesterday's spend is simply outside today's period.
    vi.useFakeTimers();
    try {
      const dayStart = Date.UTC(2026, 8, 9);
      vi.setSystemTime(new Date(dayStart + 12 * 60 * 60_000));

      const groqKey = addKey('groq');
      addRoute('groq', 'twin', 1);
      upsertQuotaPolicy({
        platform: 'groq', modelId: null, endpointScope: null,
        scope: 'provider_account', metric: 'requests', limit: 4,
        periodKind: 'calendar_day', periodMs: null, timezone: 'UTC', anchorDay: null,
        source: 'operator',
      });
      spend('groq', 'twin', groqKey, 4);
      expect(quotaDomainsAdmit('groq', 'twin', '').ok).toBe(false);

      // No cache invalidation here on purpose: admission reads fresh, so the
      // window rolling over is enough on its own.
      vi.setSystemTime(new Date(dayStart + 86_400_000 + 60_000)); // next UTC day
      expect(quotaDomainsAdmit('groq', 'twin', '').ok).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('the gate is not answered from a cache or blind to in-flight work', () => {
  beforeEach(reset);

  /** Record a served request exactly as the router's own accounting does. */
  function recordServed(platform: string, modelId: string, keyId: number): void {
    getDb().prepare(
      "INSERT INTO rate_limit_usage (platform, model_id, key_id, kind, tokens, created_at_ms) VALUES (?, ?, ?, 'request', 0, ?)",
    ).run(platform, modelId, keyId, Date.now());
  }

  it('closes on the very next request, inside the ranking cache TTL', () => {
    // The reproduction the reviewer named. A limit of 1, the gate warmed at
    // zero usage, one request served, and the next attempt arriving well inside
    // the 5s memo. Nothing invalidates a cache here — a gate that needs a test
    // to clear a cache for it is a gate that does not hold in production.
    const groqKey = addKey('groq');
    addRoute('groq', 'twin', 1);
    upsertQuotaPolicy({
      platform: 'groq', modelId: null, endpointScope: null,
      scope: 'provider_account', metric: 'requests', limit: 1,
      periodKind: 'calendar_day', periodMs: null, timezone: 'UTC', anchorDay: null,
      source: 'operator',
    });
    setRoutingStrategy('priority');

    // Warm every cache in the path at zero usage.
    expect(quotaDomainsAdmit('groq', 'twin', '').ok).toBe(true);
    quotaPressure('groq', 'twin', '');

    const first = routeRequest(100);
    first.release?.();
    recordServed('groq', 'twin', groqKey);

    // Immediately, with the memo still warm and no invalidation of any kind.
    expect(quotaDomainsAdmit('groq', 'twin', '').ok).toBe(false);
    expect(() => routeRequest(100)).toThrow();
  });

  it('counts attempts still in the air, not only those already written', () => {
    // Usage is written after an attempt succeeds. Two overlapping requests
    // therefore both read zero and both pass — the check-then-act race the
    // lease map exists to close. The first route holds its lease here exactly
    // as an in-flight request does.
    addKey('groq');
    addRoute('groq', 'twin', 1);
    upsertQuotaPolicy({
      platform: 'groq', modelId: null, endpointScope: null,
      scope: 'provider_account', metric: 'requests', limit: 1,
      periodKind: 'calendar_day', periodMs: null, timezone: 'UTC', anchorDay: null,
      source: 'operator',
    });
    setRoutingStrategy('priority');

    const inFlight = routeRequest(100); // lease deliberately NOT released
    expect(quotaDomainsAdmit('groq', 'twin', '').ok).toBe(false);
    expect(() => routeRequest(100)).toThrow();

    // Releasing it hands the allowance back — nothing was actually spent.
    inFlight.release?.();
    expect(quotaDomainsAdmit('groq', 'twin', '').ok).toBe(true);
  });

  it('reserves estimated tokens against a token-metered domain', () => {
    addKey('groq');
    addRoute('groq', 'twin', 1);
    upsertQuotaPolicy({
      platform: 'groq', modelId: null, endpointScope: null,
      scope: 'provider_account', metric: 'total_tokens', limit: 1000,
      periodKind: 'calendar_day', periodMs: null, timezone: 'UTC', anchorDay: null,
      source: 'operator',
    });

    // A request that fits.
    expect(quotaDomainsAdmit('groq', 'twin', '', 900).ok).toBe(true);
    // One that does not, on an otherwise untouched pool.
    expect(quotaDomainsAdmit('groq', 'twin', '', 1200).ok).toBe(false);
  });

  it('never counts tokens against a credit balance', () => {
    // A credit limit is money, priced per model and per token by the provider.
    // Counting raw tokens against it read an Ollama account with a stated
    // 166-credit ceiling as millions spent and would have closed the platform.
    const ollamaKey = addKey('ollama');
    addRoute('ollama', 'twin', 1);
    upsertQuotaPolicy({
      platform: 'ollama', modelId: null, endpointScope: null,
      scope: 'provider_account', metric: 'credits', limit: 166,
      periodKind: 'calendar_day', periodMs: null, timezone: 'UTC', anchorDay: null,
      source: 'operator',
    });
    getDb().prepare(
      "INSERT INTO rate_limit_usage (platform, model_id, key_id, kind, tokens, created_at_ms) VALUES ('ollama', 'twin', ?, 'tokens', 5000000, ?)",
    ).run(ollamaKey, Date.now());

    expect(quotaDomainsAdmit('ollama', 'twin', '', 1000).ok).toBe(true);
  });
});

describe('a credit balance is money, not a token count', () => {
  beforeEach(reset);

  /** Ollama Cloud's shape: the provider reports what is left on the balance. */
  function reportCreditsRemaining(platform: string, keyId: number, poolKey: string, limit: number, remaining: number): void {
    getDb().prepare(`
      INSERT INTO provider_quota_state
        (platform, key_id, quota_pool_key, metric, limit_value, remaining_value, unit, source, confidence, observed_at)
      VALUES (?, ?, ?, 'credits', ?, ?, 'per_10k', 'quota_api', 0.9, datetime('now'))
      ON CONFLICT(platform, key_id, quota_pool_key, metric) DO UPDATE SET
        limit_value = excluded.limit_value, remaining_value = excluded.remaining_value
    `).run(platform, keyId, poolKey, limit, remaining);
  }

  it('admits an ordinary request against a healthy credit balance, however many tokens it carries', () => {
    // The bug this pins: `estimatedTokens` was reserved against ANY axis that
    // was not counting requests, so a 200,000-token request "spent" 200,000 of
    // a 166-credit balance and closed the account on its first call. Tokens and
    // credits are different units and Ollama prices per model — a million
    // ultra tokens costs about eight times a million 20b tokens — so there is
    // no conversion to make and none is invented.
    const ollamaKey = addKey('ollama');
    addRoute('ollama', 'twin', 1);
    upsertQuotaPolicy({
      platform: 'ollama', modelId: null, endpointScope: null,
      scope: 'provider_account', metric: 'credits', limit: 166,
      periodKind: 'calendar_day', periodMs: null, timezone: 'UTC', anchorDay: null,
      source: 'operator',
    });
    // A measured figure exists and the balance is comfortable: 150 of 166 left.
    reportCreditsRemaining('ollama', ollamaKey, 'ollama::cloud', 166, 150);
    setRoutingStrategy('priority');

    // Estimated tokens dwarf the numeric credit limit, which is exactly the
    // ordinary case — 200k tokens against a 166-credit ceiling.
    expect(quotaDomainsAdmit('ollama', 'twin', '', 200_000).ok).toBe(true);
    // Routed with a smaller estimate only because the fixture's context window
    // is 128K and the separate max-tokens gate would reject 200K first. Still
    // two orders of magnitude above the 166-credit ceiling, which is the point.
    const routed = routeRequest(20_000);
    routed.release?.();
    expect(routed.platform).toBe('ollama');
  });

  it('still closes the route when the balance is measurably gone', () => {
    // Known exhaustion is the one thing a credit axis can act on, and it must.
    const ollamaKey = addKey('ollama');
    addRoute('ollama', 'twin', 1);
    upsertQuotaPolicy({
      platform: 'ollama', modelId: null, endpointScope: null,
      scope: 'provider_account', metric: 'credits', limit: 166,
      periodKind: 'calendar_day', periodMs: null, timezone: 'UTC', anchorDay: null,
      source: 'operator',
    });
    reportCreditsRemaining('ollama', ollamaKey, 'ollama::cloud', 166, 0);
    setRoutingStrategy('priority');

    const decision = quotaDomainsAdmit('ollama', 'twin', '', 100);
    expect(decision.ok).toBe(false);
    expect(decision.blockedBy).toContain('credits');
    expect(() => routeRequest(100)).toThrow();
  });
});

describe('the decision is recorded when it is made, not reconstructed later', () => {
  beforeEach(reset);
  // Pinned mid-morning UTC on purpose. These cases are about SPREADING and
  // about what the trace records; leaving the wall clock free let reset-urgency
  // harvesting fire whenever the suite happened to run late in the UTC day,
  // which changed `harvest` from 1 to 1.068 and moved the very ranks under
  // test. A test whose result depends on the hour it runs is a test that
  // sometimes passes by not exercising anything.
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date(Date.UTC(2026, 8, 9, 9, 0, 0))); });
  afterEach(() => { vi.useRealTimers(); });

  it('stamps the served route with the signals that chose it', () => {
    // A `/api/fallback/routing` snapshot cannot answer "why did THIS request go
    // to Groq" — it reports scores as they are now, on quota that has moved and
    // with a different set of requests in flight. The trace has to be captured
    // at the decision or the question is permanently unanswerable.
    addKey('groq');
    addKey('nvidia');
    addRoute('groq', 'twin', 1);
    addRoute('nvidia', 'twin', 2);
    dailyPolicy('groq', 10_000);
    dailyPolicy('nvidia', 10_000);
    setRoutingStrategy('priority');

    const routed = routeRequest(100);
    routed.release?.();

    const trace = routed.routingTrace;
    expect(trace).toBeDefined();
    expect(trace!.strategy).toBe('priority');
    expect(trace!.poolKey).toBe('groq::model::twin');
    expect(trace!.scarcity).toBe(1);
    expect(trace!.harvest).toBe(1);
    expect(trace!.diversity).toBe(1);
    // Nothing else in flight: the spreading term is inert, and saying so is the
    // point — it is why "run three curls and watch them differ" proves nothing.
    expect(trace!.inFlightShare).toBeNull();
    expect(trace!.scoringRank).toBe(1);
    expect(trace!.scoringRankWithoutQuotaTerms).toBe(1);
    expect(trace!.selectionRank).toBe(1);
    expect(trace!.selectionOverride).toBeNull();
  });

  it('records the rank spreading moved, not just the multiplier it produced', () => {
    // A multiplier that changed no ordering is a different fact from one that
    // changed the answer. Only the counterfactual rank distinguishes them, and
    // it exists solely inside the ordering pass.
    addKey('groq');
    addKey('nvidia');
    addRoute('groq', 'twin', 1);
    addRoute('nvidia', 'twin', 2);
    dailyPolicy('groq', 10_000);
    dailyPolicy('nvidia', 10_000);
    setRoutingStrategy('priority');

    acquireLease('groq', 'twin', 1, 100);
    acquireLease('groq', 'twin', 1, 100);
    invalidateQuotaPressure();

    const routed = routeRequest(100);
    routed.release?.();

    expect(routed.platform).toBe('nvidia');
    const trace = routed.routingTrace!;
    // The trace belongs to the route that SERVED, so these are NVIDIA's own
    // numbers: its pool was idle, so it was not damped at all.
    expect(trace.inFlightShare).toBe(0);
    expect(trace.diversity).toBe(1);
    // The move is what proves the mechanism ran. The operator's manual order
    // put NVIDIA second; with two attempts open on Groq's pool it served first.
    // Without the rank pair this record could not distinguish "spreading chose
    // this" from "spreading was computed and changed nothing".
    expect(trace.scoringRankWithoutQuotaTerms).toBe(2);
    expect(trace.scoringRank).toBe(1);
    // And it was reached first in the walk, with nothing overriding the score.
    expect(trace.selectionRank).toBe(1);
    expect(trace.selectionOverride).toBeNull();
  });

  it('describes the route that served, not the one ordering ranked first', () => {
    // A higher-ranked candidate benched by a gate must not lend its trace to
    // the route that actually ran.
    const groqKey = addKey('groq');
    addKey('nvidia');
    addRoute('groq', 'twin', 1);
    addRoute('nvidia', 'twin', 2);
    dailyPolicy('nvidia', 10_000);
    // Groq's stated allowance is spent, so the admission gate closes it.
    upsertQuotaPolicy({
      platform: 'groq', modelId: null, endpointScope: null,
      scope: 'provider_account', metric: 'requests', limit: 3,
      periodKind: 'calendar_day', periodMs: null, timezone: 'UTC', anchorDay: null,
      source: 'operator',
    });
    spend('groq', 'twin', groqKey, 3);
    setRoutingStrategy('priority');

    const routed = routeRequest(100);
    routed.release?.();

    expect(routed.platform).toBe('nvidia');
    expect(routed.routingTrace!.poolKey).toBe('nvidia::credit-pool');
  });
});

describe('an admission block is legible to the caller', () => {
  beforeEach(reset);

  function exhaust(): unknown {
    const groqKey = addKey('groq');
    addRoute('groq', 'twin', 1);
    upsertQuotaPolicy({
      platform: 'groq', modelId: null, endpointScope: null,
      scope: 'provider_account', metric: 'requests', limit: 2,
      periodKind: 'calendar_day', periodMs: null, timezone: 'UTC', anchorDay: null,
      source: 'operator',
    });
    spend('groq', 'twin', groqKey, 2);
    setRoutingStrategy('priority');
    try {
      routeRequest(100).release?.();
      return null;
    } catch (e) {
      return e;
    }
  }

  it('names a spent allowance in the error rather than burying it in "unavailable"', () => {
    // The gate's diagnostic is `quota-domain-exhausted(...)`, which contains
    // "domain-exhausted" and not "quota-exhausted" — so it matched none of the
    // existing patterns and fell into the least informative bucket. An operator
    // seeing "1 unavailable" cannot tell correct enforcement from a misfire.
    const err = exhaust() as { message?: string; diagnostics?: string[] };
    expect(err).not.toBeNull();
    expect(err.message).toContain('quota allowance spent');
    expect(err.message).not.toContain('unavailable');
    // The verbatim cause, naming the scope, metric and which source stated it.
    expect(err.diagnostics?.join(' ')).toContain('quota-domain-exhausted(provider_account:requests:operator)');
  });

  it('renders as a retryable rate limit, not a generic routing failure', () => {
    // A spent allowance is time-bound: the window resets. Classifying it as
    // 'other' handed the caller `routing_exhausted` with no retry hint, when
    // waiting is exactly the right response.
    const err = exhaust();
    const body = routingExhaustionBody(err);
    expect(body.kind).toBe('rate_limit');
    expect(body.status).toBe(429);
    expect(body.code).toBe('rate_limit_exceeded');
  });
});
