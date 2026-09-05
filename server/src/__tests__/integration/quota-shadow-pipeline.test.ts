import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getDb, initDb } from '../../db/index.js';
import { encrypt } from '../../lib/crypto.js';
import { routeRequest, setRoutingStrategy } from '../../services/router.js';
import { upsertQuotaPolicy } from '../../services/quota-policy.js';
import {
  setQuotaRoutingMode,
  setReservationWeights,
  getShadowAgreementStats,
  listRoutingDecisions,
} from '../../services/quota-routing.js';
import { invalidateShadowCounts } from '../../services/ratelimit.js';

// End-to-end through the real pipeline: policy -> clock -> resolver -> shadow
// scoring -> ledger -> stats. Grown from a throwaway harness that caught two
// scoring defects the unit tests could not see, because each unit test supplied
// its own usage numbers and never had a candidate with NO policy at all.
//
// The scenario is the brief's own: one logical model, four providers, where the
// question is not which model to use but which provider should spend for it.

const LOGICAL = 'nemotron 3 ultra';
const MODEL_ID = 'nemotron-3-ultra';
const PROVIDERS = ['nvidia', 'ollama', 'opencode', 'openrouter'] as const;

const keyIds: Record<string, number> = {};

function activeProfileId(): number {
  const row = getDb().prepare("SELECT value FROM settings WHERE key = 'active_profile_id'").get() as { value: string };
  return Number(row.value);
}

function seedProvider(platform: string, priority: number): void {
  const db = getDb();
  const secret = encrypt(`${platform}-pipeline-test`);
  keyIds[platform] = Number(db.prepare(
    "INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled) VALUES (?, 'pipeline', ?, ?, ?, 'healthy', 1)",
  ).run(platform, secret.encrypted, secret.iv, secret.authTag).lastInsertRowid);

  const modelDbId = Number(db.prepare(`
    INSERT INTO models (platform, model_id, display_name, intelligence_rank, speed_rank, size_label,
      rpm_limit, rpd_limit, tpm_limit, tpd_limit, monthly_token_budget, context_window, enabled,
      supports_vision, supports_tools)
    VALUES (?, ?, ?, 1, 1, 'Frontier', NULL, NULL, NULL, NULL, '~1M', 128000, 1, 0, 1)
  `).run(platform, MODEL_ID, `Nemotron 3 Ultra (${platform})`).lastInsertRowid);

  db.prepare('INSERT INTO fallback_config (model_db_id, priority, enabled) VALUES (?, ?, 1)').run(modelDbId, priority);
  db.prepare('INSERT INTO profile_models (profile_id, model_db_id, priority, enabled) VALUES (?, ?, ?, 1)')
    .run(activeProfileId(), modelDbId, priority);
}

function spend(platform: string, n: number): void {
  const stmt = getDb().prepare(
    "INSERT INTO rate_limit_usage (platform, model_id, key_id, kind, tokens, created_at_ms) VALUES (?, ?, ?, 'request', 0, ?)",
  );
  for (let i = 0; i < n; i++) stmt.run(platform, MODEL_ID, keyIds[platform], Date.now());
  invalidateShadowCounts();
}

function dailyPolicy(platform: string, limit: number): void {
  upsertQuotaPolicy({
    platform, modelId: null, scope: 'provider_account', metric: 'requests',
    limit, periodKind: 'calendar_day', periodMs: null, timezone: 'UTC', anchorDay: null,
  });
}

/** The shadow write is deferred off the selection path; wait for that turn. */
async function routeOnce(): Promise<string> {
  const routed = routeRequest(100);
  routed.release?.();
  const { promise, resolve } = Promise.withResolvers<void>();
  setImmediate(resolve);
  await promise;
  return routed.platform;
}

describe('quota shadow pipeline (end to end)', () => {
  // Neutralise the shipped provider-wide env caps. They are a real and separate
  // axis — NVIDIA's 40 RPM makes twenty requests in a minute look half-spent —
  // but this file is about DECLARED policies, and leaving them in means the
  // scenario under test is not the one being asserted.
  const ENV_CAPS = ['PROVIDER_MINUTE_REQUEST_CAP_NVIDIA', 'PROVIDER_DAILY_REQUEST_CAP_OPENROUTER'] as const;

  afterEach(() => {
    for (const name of ENV_CAPS) delete process.env[name];
  });

  beforeEach(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    for (const name of ENV_CAPS) process.env[name] = '0';
    initDb(':memory:');
    const db = getDb();
    db.prepare('DELETE FROM fallback_config').run();
    db.prepare('DELETE FROM profile_models').run();
    db.prepare('DELETE FROM models').run();
    db.prepare('DELETE FROM api_keys').run();
    db.prepare('DELETE FROM quota_policy').run();
    db.prepare('DELETE FROM routing_decision').run();
    db.prepare('DELETE FROM rate_limit_usage').run();
    db.prepare("DELETE FROM settings WHERE key IN ('quota_reservation_weights','quota_routing_mode')").run();
    invalidateShadowCounts();

    PROVIDERS.forEach((platform, i) => seedProvider(platform, i + 1));
    setRoutingStrategy('priority'); // deterministic incumbent: nvidia
    setQuotaRoutingMode('shadow');
  });

  it('records agreement while the incumbent has ample quota', async () => {
    dailyPolicy('nvidia', 2000);
    spend('nvidia', 20);

    expect(await routeOnce()).toBe('nvidia');

    const [decision] = listRoutingDecisions({ limit: 1 });
    expect(decision?.actualPlatform).toBe('nvidia');
    expect(decision?.shadowPlatform).toBe('nvidia');
    expect(decision?.agreed).toBe(true);
    expect(getShadowAgreementStats(0).agreementRate).toBe(1);
  });

  // The defect the throwaway harness caught. OpenRouter at 45/50 was preferred
  // over a provider with no published limit, because "no signal" dropped the
  // candidate from the ranking entirely and left the scarce pool winning by
  // default — exactly the outcome the design exists to prevent.
  it('does not prefer a nearly-exhausted scarce pool over an unmetered provider', async () => {
    dailyPolicy('nvidia', 2000);
    dailyPolicy('openrouter', 50);
    spend('nvidia', 1990);     // incumbent effectively spent
    spend('openrouter', 45);   // 5 of 50 left — must not be the answer
    // ollama and opencode have no policy at all: unmetered, not unrankable.

    await routeOnce();

    const [decision] = listRoutingDecisions({ limit: 1 });
    expect(decision?.shadowPlatform).not.toBe('openrouter');
    expect(['ollama', 'opencode']).toContain(decision?.shadowPlatform);
  });

  it('holds back a scarce pool the raw fraction would have picked', async () => {
    // Every provider metered, so nothing rests on the unmetered default and the
    // reservation weight is the only thing that can change the answer.
    // Fractions: nvidia 0.2, ollama 0.3, opencode 0.3, openrouter 0.5.
    dailyPolicy('nvidia', 2000);
    dailyPolicy('ollama', 1000);
    dailyPolicy('opencode', 1000);
    dailyPolicy('openrouter', 50);
    spend('nvidia', 1600);
    spend('ollama', 700);
    spend('opencode', 700);
    spend('openrouter', 25);

    // Unweighted, OpenRouter's 50% wins outright — 25 of a 50/day shared pool
    // looks exactly as cheap as any other half-full bucket.
    await routeOnce();
    expect(listRoutingDecisions({ limit: 1 })[0]?.shadowPlatform).toBe('openrouter');

    // Weighted, the same 50% is worth 0.15 and the scarce pool is held back.
    setReservationWeights({ openrouter: 0.3 });
    await routeOnce();
    const [decision] = listRoutingDecisions({ limit: 1 });
    expect(decision?.shadowPlatform).not.toBe('openrouter');
    expect(['ollama', 'opencode']).toContain(decision?.shadowPlatform);
  });

  it('surfaces divergence through the stats the API serves', async () => {
    dailyPolicy('nvidia', 100);
    dailyPolicy('ollama', 100);
    spend('nvidia', 95);   // incumbent is nearly out...
    spend('ollama', 5);    // ...and a peer is not

    await routeOnce();

    const stats = getShadowAgreementStats(0);
    expect(stats.total).toBe(1);
    expect(stats.agreed).toBe(0);
    expect(stats.byLogicalModel[0]?.logicalModel).toBe(LOGICAL);

    const diverged = listRoutingDecisions({ disagreedOnly: true });
    expect(diverged).toHaveLength(1);
    expect(diverged[0]!.actualPlatform).toBe('nvidia');
    expect(diverged[0]!.shadowPlatform).toBe('ollama');
  });

  it('serves the incumbent throughout, whatever shadow concluded', async () => {
    dailyPolicy('nvidia', 100);
    dailyPolicy('ollama', 100);
    spend('nvidia', 99);

    // Five requests, every one of which shadow wanted to send elsewhere.
    for (let i = 0; i < 5; i++) expect(await routeOnce()).toBe('nvidia');

    const stats = getShadowAgreementStats(0);
    expect(stats.total).toBe(5);
    expect(stats.agreed).toBe(0);
  });
});
