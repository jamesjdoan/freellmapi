import { describe, it, expect, beforeEach } from 'vitest';
import { initDb, getDb } from '../../db/index.js';
import { encrypt } from '../../lib/crypto.js';
import {
  getQuotaRoutingMode,
  setQuotaRoutingMode,
  evaluateShadowDecision,
  recordRoutingDecision,
  getShadowAgreementStats,
  scoreQuotaCandidate,
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
    const exhausted = scoreQuotaCandidate([quota(100, 1000)], () => 100, Date.now());
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
