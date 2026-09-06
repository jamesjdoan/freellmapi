import type { EffectiveQuota, EffectiveQuotaSource } from '../../services/quota-policy.js';
import { describe, it, expect, beforeEach } from 'vitest';
import { initDb, getDb } from '../../db/index.js';
import { encrypt } from '../../lib/crypto.js';
import {
  getQuotaRoutingMode,
  setQuotaRoutingMode,
  evaluateShadowDecision,
  invalidateLiveness,
  recordRoutingDecision,
  getShadowAgreementStats,
  listRoutingDecisions,
  scoreQuotaCandidate,
  UNKNOWN_HEADROOM,
  DEFAULT_QUOTA_ROUTING_MODE,
  UNKNOWN_HEADROOM,
} from '../../services/quota-routing.js';
import { upsertQuotaPolicy } from '../../services/quota-policy.js';
import { routeRequest, setRoutingStrategy } from '../../services/router.js';
import { invalidateShadowCounts } from '../../services/ratelimit.js';
import type { EffectiveQuota } from '../../services/quota-policy.js';

function reset(): void {
  process.env.ENCRYPTION_KEY = '0'.repeat(64);
  initDb(':memory:');
  const db = getDb();
  db.prepare('DELETE FROM fallback_config').run();
  db.prepare('DELETE FROM profile_models').run();
  db.prepare('DELETE FROM models').run();
  db.prepare('DELETE FROM api_keys').run();
  db.prepare('DELETE FROM quota_policy').run();
  db.prepare('DELETE FROM routing_decision').run();
  db.prepare('DELETE FROM rate_limit_usage').run();
  invalidateShadowCounts();
}

function activeProfileId(): number {
  // The active profile is a settings row, not a column on `profiles`.
  const row = getDb().prepare("SELECT value FROM settings WHERE key = 'active_profile_id'").get() as { value: string };
  return Number(row.value);
}
function addKey(platform: string): number {
  const secret = encrypt(`${platform}-shadow-test-key`);
  const inserted = getDb().prepare(`
    INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled)
    VALUES (?, 'shadow-test', ?, ?, ?, 'healthy', 1)
  `).run(platform, secret.encrypted, secret.iv, secret.authTag);
  return Number(inserted.lastInsertRowid);
}

/** Two providers serving the SAME logical model — "(Groq)" and "(NV)" strip to
 *  one group key, which is the situation quota-aware provider choice exists for. */
function addPeer(platform: string, modelId: string, priority: number): number {
  const db = getDb();
  const info = db.prepare(`
    INSERT INTO models (platform, model_id, display_name, intelligence_rank, speed_rank, size_label,
      rpm_limit, rpd_limit, tpm_limit, tpd_limit, monthly_token_budget, context_window, enabled,
      supports_vision, supports_tools)
    VALUES (?, ?, ?, 1, 1, 'Large', NULL, NULL, NULL, NULL, '~1M', 128000, 1, 0, 1)
  `).run(platform, modelId, `Shared Model (${platform})`);
  const id = Number(info.lastInsertRowid);
  db.prepare('INSERT INTO fallback_config (model_db_id, priority, enabled) VALUES (?, ?, 1)').run(id, priority);
  db.prepare('INSERT INTO profile_models (profile_id, model_db_id, priority, enabled) VALUES (?, ?, ?, 1)')
    .run(activeProfileId(), id, priority);
  return id;
}

function spendRequests(platform: string, modelId: string, keyId: number, n: number): void {
  const stmt = getDb().prepare(
    "INSERT INTO rate_limit_usage (platform, model_id, key_id, kind, tokens, created_at_ms) VALUES (?, ?, ?, 'request', 0, ?)",
  );
  for (let i = 0; i < n; i++) stmt.run(platform, modelId, keyId, Date.now());
  invalidateShadowCounts();
}

describe('quota routing mode', () => {
  beforeEach(reset);

  it('defaults to shadow, never active', () => {
    expect(DEFAULT_QUOTA_ROUTING_MODE).toBe('shadow');
    expect(getQuotaRoutingMode()).toBe('shadow');
  });

  it('round-trips off / shadow / active and rejects anything else', () => {
    for (const mode of ['off', 'shadow', 'active'] as const) {
      setQuotaRoutingMode(mode);
      expect(getQuotaRoutingMode()).toBe(mode);
    }
    expect(() => setQuotaRoutingMode('chaotic' as never)).toThrow(/Unknown quota routing mode/);
  });

  it('falls back to the default when the stored value is corrupt', () => {
    getDb().prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('quota_routing_mode', 'nonsense')").run();
    expect(getQuotaRoutingMode()).toBe('shadow');
  });
});

describe('quota candidate scoring', () => {
  const quota = (limit: number, resetInMs: number): EffectiveQuota => ({
    platform: 'groq', modelId: 'm', metric: 'requests', scope: 'provider_account', limit,
    period: { kind: 'calendar_day', timezone: 'UTC' },
    window: { periodStartMs: Date.now() - resetInMs, resetAtMs: Date.now() + resetInMs },
    source: 'operator', confidence: 0.8,
  });

  it('scores on the binding axis — the worst one, not an average', () => {
    const roomy = quota(1000, 3_600_000);
    const tight = { ...quota(10, 3_600_000), metric: 'total_tokens' as const };
    // 50/1000 requests is comfortable; 9/10 tokens is not. The tighter axis is
    // what will actually 429, so it decides.
    const scored = scoreQuotaCandidate([roomy, tight], q => (q.metric === 'requests' ? 50 : 9), Date.now());
    expect(scored.headroom).toBeCloseTo(0.1, 3);
  });

  // Changed deliberately: this used to return null, which dropped the candidate
  // from the ranking and let the only metered provider win by default — even at
  // 10% of a 50-request pool. Unmetered is neutral, not unrankable.
  it('scores an unmetered candidate neutrally instead of excluding it', () => {
    const scored = scoreQuotaCandidate([quota(100, 1000)], () => null, Date.now());
    expect(scored.score).toBe(UNKNOWN_HEADROOM);
    // ...but it does not claim to know the headroom it never measured.
    expect(scored.headroom).toBeNull();
  });

  it('ranks a known-exhausted pool below an unmetered one', () => {
    // "Known" now has to mean measured. An operator-declared limit is a
    // declaration, and reaching it is arithmetic against someone's estimate -
    // that case is covered under "confirming exhaustion before diverting",
    // where it earns one more attempt. A provider reporting the pool spent is
    // knowledge, and ranks below a provider we know nothing about.
    const measured: EffectiveQuota = { ...quota(100, 1000), source: 'provider_header' };
    const exhausted = scoreQuotaCandidate([measured], () => 100, Date.now());
    const unmetered = scoreQuotaCandidate([quota(100, 1000)], () => null, Date.now());
    expect(exhausted.score).toBe(0);
    expect(unmetered.score!).toBeGreaterThan(exhausted.score!);
  });

  it('applies the reservation weight to hold a scarce pool back', () => {
    const plain = scoreQuotaCandidate([quota(100, 1000)], () => 50, Date.now());
    const held = scoreQuotaCandidate([quota(100, 1000)], () => 50, Date.now(), 0.3);
    expect(plain.score).toBeCloseTo(0.5, 3);
    expect(held.score).toBeCloseTo(0.15, 3);
    // The weight changes the ranking, never the reported measurement.
    expect(held.headroom).toBeCloseTo(0.5, 3);
  });
});

describe('shadow decision', () => {
  beforeEach(reset);

  const peers = [
    { platform: 'groq', modelId: 'shared', displayName: 'Shared Model (Groq)' },
    { platform: 'nvidia', modelId: 'shared', displayName: 'Shared Model (NV)' },
  ];

  it('has no opinion when there is only one provider to choose from', () => {
    expect(evaluateShadowDecision([peers[0]!], () => 0)).toBeNull();
  });

  it('prefers the provider with more headroom on its binding axis', () => {
    upsertQuotaPolicy({ platform: 'groq', modelId: null, scope: 'provider_account', metric: 'requests', limit: 100, periodKind: 'calendar_day', periodMs: null, timezone: 'UTC', anchorDay: null });
    upsertQuotaPolicy({ platform: 'nvidia', modelId: null, scope: 'provider_account', metric: 'requests', limit: 100, periodKind: 'calendar_day', periodMs: null, timezone: 'UTC', anchorDay: null });

    const decision = evaluateShadowDecision(peers, platform => (platform === 'groq' ? 90 : 10));
    expect(decision?.preferred?.platform).toBe('nvidia');
    expect(decision?.logicalModel).toBe('shared model');
  });

  it('still picks when nothing is metered, and says so', () => {
    // Platforms with no policy, no catalog row and no shipped env cap. Real
    // platforms would not do: NVIDIA ships a 40 RPM default and OpenRouter a
    // 1000/day one, so both DO have a signal even at zero usage.
    const unknownPeers = [
      { platform: 'unmetered-a', modelId: 'shared', displayName: 'Shared Model (A)' },
      { platform: 'unmetered-b', modelId: 'shared', displayName: 'Shared Model (B)' },
    ];
    const decision = evaluateShadowDecision(unknownPeers, () => 0);

    // All neutral, so one is chosen and the reason refuses to imply headroom
    // was measured — the alternative was excluding both and letting any
    // metered rival win by default however little it had left.
    expect(decision?.preferred).not.toBeNull();
    expect(decision?.reason).toMatch(/no published limit/);
    expect(decision?.candidates.every(c => c.headroom === null)).toBe(true);
  });
});

describe('shadow ledger', () => {
  beforeEach(reset);

  const decision = {
    logicalModel: 'shared model',
    candidates: [{ platform: 'nvidia', modelId: 'shared', score: 0.9, headroom: 0.9, paceDelta: -0.3 }],
    preferred: { platform: 'nvidia', modelId: 'shared' },
    reason: 'most headroom',
  };

  it('writes nothing in off mode', () => {
    recordRoutingDecision({ ...decision, mode: 'off', actualPlatform: 'groq', actualModelId: 'shared', decision });
    expect(getShadowAgreementStats(0).total).toBe(0);
  });

  it('counts a divergence as disagreement and a match as agreement', () => {
    recordRoutingDecision({ logicalModel: 'x', mode: 'shadow', actualPlatform: 'groq', actualModelId: 'shared', decision });
    recordRoutingDecision({ logicalModel: 'x', mode: 'shadow', actualPlatform: 'nvidia', actualModelId: 'shared', decision });

    const stats = getShadowAgreementStats(0);
    expect(stats.total).toBe(2);
    expect(stats.agreed).toBe(1);
    expect(stats.agreementRate).toBe(0.5);
  });

  // Two relays behind one platform name. Before the endpoint columns, both
  // sides recorded platform 'custom' with the same model id, so `agreed` was
  // true whichever endpoint each router had actually picked — the flag could
  // not be false. Found by driving real traffic through two stub relays.
  it('tells two relay endpoints apart instead of agreeing by default', () => {
    const relayDecision = {
      logicalModel: 'shared model',
      candidates: [],
      preferred: { platform: 'custom', modelId: 'm', endpointScope: 'custom:beta' },
      reason: 'most headroom',
    };
    recordRoutingDecision({
      logicalModel: 'shared model', mode: 'shadow',
      actualPlatform: 'custom', actualModelId: 'm', actualEndpointScope: 'custom:alpha',
      decision: relayDecision,
    });

    const [row] = listRoutingDecisions({});
    expect(row?.actualEndpoint).toBe('custom:alpha');
    expect(row?.shadowEndpoint).toBe('custom:beta');
    // Same platform and model on both sides, different endpoint: a real
    // disagreement that used to be invisible.
    expect(row?.agreed).toBe(false);
  });

  it('still agrees when both sides name the same endpoint', () => {
    recordRoutingDecision({
      logicalModel: 'shared model', mode: 'shadow',
      actualPlatform: 'custom', actualModelId: 'm', actualEndpointScope: 'custom:alpha',
      decision: {
        logicalModel: 'shared model', candidates: [],
        preferred: { platform: 'custom', modelId: 'm', endpointScope: 'custom:alpha' },
        reason: 'most headroom',
      },
    });
    expect(listRoutingDecisions({})[0]?.agreed).toBe(true);
  });

  it('never leaks key material into the ledger', () => {
    recordRoutingDecision({ logicalModel: 'x', mode: 'shadow', actualPlatform: 'groq', actualModelId: 'shared', decision });
    const row = getDb().prepare('SELECT * FROM routing_decision LIMIT 1').get() as Record<string, unknown>;
    const serialized = JSON.stringify(row);
    expect(serialized).not.toContain('sk-');
    expect(Object.keys(row)).not.toContain('api_key');
  });
});

// The single property the whole shadow phase rests on.
describe('shadow mode never alters selection', () => {
  beforeEach(() => {
    reset();
    setRoutingStrategy('priority');
  });

  // The shadow write is deferred past the current turn so it adds no latency
  // to selection. Tests wait for that turn rather than pretending it is
  // synchronous — the wait IS the behaviour under test.

  const settled = (): Promise<void> => {
    const { promise, resolve } = Promise.withResolvers<void>();
    setImmediate(resolve);
    return promise;
  };
  it('serves the incumbent choice even when quota scoring prefers the other provider', async () => {
    const groqKey = addKey('groq');
    addKey('nvidia');
    addPeer('groq', 'shared', 1);    // priority 1 — the incumbent's pick
    addPeer('nvidia', 'shared', 2);

    // Make Groq look terrible on quota and NVIDIA pristine.
    upsertQuotaPolicy({ platform: 'groq', modelId: null, scope: 'provider_account', metric: 'requests', limit: 10, periodKind: 'calendar_day', periodMs: null, timezone: 'UTC', anchorDay: null });
    upsertQuotaPolicy({ platform: 'nvidia', modelId: null, scope: 'provider_account', metric: 'requests', limit: 10000, periodKind: 'calendar_day', periodMs: null, timezone: 'UTC', anchorDay: null });
    spendRequests('groq', 'shared', groqKey, 9);

    setQuotaRoutingMode('shadow');
    const routed = routeRequest(100);
    routed.release?.();

    // Selection must not pay for measurement: nothing is written yet.
    const before = getDb().prepare('SELECT COUNT(*) AS n FROM routing_decision').get() as { n: number };
    expect(before.n).toBe(0);

    await settled();

    // Shadow disagreed and was ignored — that is the contract.
    expect(routed.platform).toBe('groq');

    const row = getDb().prepare('SELECT * FROM routing_decision ORDER BY id DESC LIMIT 1').get() as
      { actual_platform: string; shadow_platform: string | null; agreed: number } | undefined;
    expect(row?.actual_platform).toBe('groq');
    expect(row?.shadow_platform).toBe('nvidia');
    expect(row?.agreed).toBe(0);
  });

  it('picks the same route with the mode off as with it on', async () => {
    const groqKey = addKey('groq');
    addKey('nvidia');
    addPeer('groq', 'shared', 1);
    addPeer('nvidia', 'shared', 2);
    upsertQuotaPolicy({ platform: 'groq', modelId: null, scope: 'provider_account', metric: 'requests', limit: 10, periodKind: 'calendar_day', periodMs: null, timezone: 'UTC', anchorDay: null });
    spendRequests('groq', 'shared', groqKey, 9);

    setQuotaRoutingMode('off');
    const withOff = routeRequest(100);
    withOff.release?.();
    setQuotaRoutingMode('shadow');
    const withShadow = routeRequest(100);
    withShadow.release?.();
    await settled();

    expect(withShadow.platform).toBe(withOff.platform);
    expect(withShadow.modelDbId).toBe(withOff.modelDbId);
    // ...and off wrote nothing at all.
    expect(getShadowAgreementStats(0).total).toBe(1);
  });

  it('still routes when the quota service throws', async () => {
    addKey('groq');
    addPeer('groq', 'shared', 1);
    addPeer('nvidia', 'shared', 2);
    setQuotaRoutingMode('shadow');

    // A corrupt policy table is the realistic version of this: the shadow path
    // must swallow it, not turn it into a failed request.
    getDb().prepare('DROP TABLE quota_policy').run();
    const routed = routeRequest(100);
    routed.release?.();
    expect(routed.platform).toBe('groq');
  });
});

/**
 * Quota headroom says nothing about whether a route works, and a dead route's
 * allowance stays untouched — so headroom rates it perfect. Observed in
 * production: NVIDIA's openai/gpt-oss-120b returned "410: reached its end of
 * life" on every attempt, and shadow recommended it 8 times out of 8 while the
 * live router had already routed around it.
 */
describe('liveness gate', () => {
  beforeEach(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
    getDb().prepare('DELETE FROM requests').run();
    invalidateLiveness();
  });

  const noQuota = () => null;
  const peers = (): QuotaCandidate[] => ([
    { platform: 'nvidia', modelId: 'openai/gpt-oss-120b', displayName: 'GPT OSS 120B' },
    { platform: 'groq', modelId: 'openai/gpt-oss-120b', displayName: 'GPT OSS 120B' },
  ]);

  function seed(platform: string, modelId: string, outcome: 'success' | 'error', n: number, ageMinutes = 1): void {
    const at = new Date(Date.now() - ageMinutes * 60_000).toISOString().replace('T', ' ').replace('Z', '');
    const stmt = getDb().prepare(`
      INSERT INTO requests (platform, model_id, status, input_tokens, output_tokens, latency_ms, error, created_at)
      VALUES (?, ?, ?, 0, 0, 10, ?, ?)
    `);
    for (let i = 0; i < n; i++) stmt.run(platform, modelId, outcome, outcome === 'error' ? 'HTTP 410 end of life' : null, at);
  }

  it('excludes a route that is only producing errors', () => {
    seed('nvidia', 'openai/gpt-oss-120b', 'error', 5);
    seed('groq', 'openai/gpt-oss-120b', 'success', 3);
    const decision = evaluateShadowDecision(peers(), noQuota);
    expect(decision!.preferred!.platform).toBe('groq');
    // The dead route is not merely outranked, it is not a candidate.
    expect(decision!.candidates.map(c => c.platform)).toEqual(['groq']);
  });

  it('keeps a route that is failing but still serving', () => {
    // Flaky is not dead, and reliability ranking belongs to the incumbent
    // router — this gate only removes routes producing nothing at all.
    seed('nvidia', 'openai/gpt-oss-120b', 'error', 5);
    seed('nvidia', 'openai/gpt-oss-120b', 'success', 1);
    seed('groq', 'openai/gpt-oss-120b', 'success', 3);
    const platforms = evaluateShadowDecision(peers(), noQuota)!.candidates.map(c => c.platform).sort();
    expect(platforms).toEqual(['groq', 'nvidia']);
  });

  it('treats silence as unknown, not as death', () => {
    // No traffic at all for either. Gating on absence would exclude every
    // candidate during a quiet spell.
    const platforms = evaluateShadowDecision(peers(), noQuota)!.candidates.map(c => c.platform).sort();
    expect(platforms).toEqual(['groq', 'nvidia']);
  });

  it('ignores failures older than the window', () => {
    seed('nvidia', 'openai/gpt-oss-120b', 'error', 9, 120);
    const platforms = evaluateShadowDecision(peers(), noQuota)!.candidates.map(c => c.platform).sort();
    expect(platforms).toEqual(['groq', 'nvidia']);
  });

  it('does not read burn-test traffic as death', () => {
    // A burn run reaches the limit on purpose; its refusals say nothing about
    // whether the route works.
    const at = new Date().toISOString().replace('T', ' ').replace('Z', '');
    const stmt = getDb().prepare(`
      INSERT INTO requests (platform, model_id, status, input_tokens, output_tokens, latency_ms, error, request_type, created_at)
      VALUES ('nvidia', 'openai/gpt-oss-120b', 'error', 0, 0, 10, 'HTTP 429', 'burn_test', ?)
    `);
    for (let i = 0; i < 9; i++) stmt.run(at);
    const platforms = evaluateShadowDecision(peers(), noQuota)!.candidates.map(c => c.platform).sort();
    expect(platforms).toEqual(['groq', 'nvidia']);
  });

  it('declines to have an opinion when nothing is serving', () => {
    seed('nvidia', 'openai/gpt-oss-120b', 'error', 5);
    seed('groq', 'openai/gpt-oss-120b', 'error', 5);
    // Naming a favourite among dead routes is the failure this gate exists to
    // prevent.
    expect(evaluateShadowDecision(peers(), noQuota)).toBeNull();
  });
});

/**
 * "Always run one extra prompt to ensure it's used before divert."
 *
 * A headroom of zero computed against an estimated ceiling is arithmetic, not
 * knowledge. Diverting on it means the last of a free allowance is never spent
 * — and the estimate is never corrected, because nothing ever reaches the
 * provider to be refused. A real 429 lays down a cooldown; that is the proof,
 * and it also benches the route, so the extra attempt is self-limiting to one.
 */
describe('confirming exhaustion before diverting', () => {
  const spentQuota = (source: EffectiveQuotaSource): EffectiveQuota => ({
    platform: 'nvidia', modelId: 'm', endpointScope: null,
    metric: 'requests', scope: 'model', limit: 40,
    reportedRemaining: null, derivedUsed: null,
    period: { kind: 'rolling', windowMs: 60_000 },
    window: { periodStartMs: Date.now() - 60_000, resetAtMs: Date.now() + 60_000 },
    source, confidence: 0.5,
  });

  it('keeps an unconfirmed zero in play rather than writing it off', () => {
    // 40 of 40 counted locally against an env cap: we believe it is spent.
    const scored = scoreQuotaCandidate([spentQuota('provider_cap_env')], () => 40, Date.now());
    expect(scored.headroom).toBe(UNKNOWN_HEADROOM);
    // Enough to still beat a scarce alternative held back at 0.3, so the next
    // request goes there and finds out.
    expect(scored.score!).toBeGreaterThan(0.3);
  });

  it('believes a zero the provider itself reported', () => {
    const scored = scoreQuotaCandidate([spentQuota('provider_header')], () => 40, Date.now());
    expect(scored.headroom).toBe(0);
    expect(scored.score).toBe(0);
  });

  it('believes an estimated zero once a refusal is on record', () => {
    // The cooldown from a real 429 is the confirmation.
    const scored = scoreQuotaCandidate([spentQuota('catalog')], () => 40, Date.now(), 1, true);
    expect(scored.headroom).toBe(0);
  });

  it('leaves a partially-spent allowance alone', () => {
    // The rule is about zero specifically; ordinary headroom must not move.
    const scored = scoreQuotaCandidate([spentQuota('catalog')], () => 10, Date.now());
    expect(scored.headroom).toBeCloseTo(0.75, 3);
  });
});
