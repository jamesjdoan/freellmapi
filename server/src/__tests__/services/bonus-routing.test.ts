import { describe, it, expect, beforeEach } from 'vitest';
import type { Express } from 'express';
import { createApp } from '../../app.js';
import { initDb, getDb } from '../../db/index.js';
import { encrypt } from '../../lib/crypto.js';
import { routeRequest } from '../../services/router.js';
import { resolveQuotaPolicy } from '../../services/provider-quota.js';
import { invalidateShadowCounts, resetLeases } from '../../services/ratelimit.js';
import { invalidateQuotaPressure } from '../../services/quota-pressure.js';
import { createBonusGrant, openBonusAllowance, resetBonusReservations } from '../../services/bonus.js';
import { mintDashboardToken } from '../helpers/auth.js';
import type { BonusGrantView } from '@freellmapi/shared/bonus-types.js';

// Through routeRequest: a provider-reported exhausted daily pool closes the
// route until a grant's open spending window funds the excess.

function reset(): void {
  process.env.ENCRYPTION_KEY = '0'.repeat(64);
  initDb(':memory:');
  const db = getDb();
  for (const table of ['fallback_config', 'profile_models', 'models', 'api_keys', 'quota_policy', 'rate_limit_usage', 'provider_quota_state']) {
    db.prepare(`DELETE FROM ${table}`).run();
  }
  invalidateShadowCounts();
  invalidateQuotaPressure();
  resetLeases();
  resetBonusReservations();
}

function addKey(platform: string): number {
  const secret = encrypt(`${platform}-bonus-test`);
  return Number(getDb().prepare(
    "INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled) VALUES (?, 'bonus', ?, ?, ?, 'healthy', 1)",
  ).run(platform, secret.encrypted, secret.iv, secret.authTag).lastInsertRowid);
}

function addRoute(platform: string, modelId: string): void {
  const db = getDb();
  const id = Number(db.prepare(`
    INSERT INTO models (platform, model_id, display_name, intelligence_rank, speed_rank, size_label,
      rpm_limit, rpd_limit, tpm_limit, tpd_limit, monthly_token_budget, context_window, enabled,
      supports_vision, supports_tools)
    VALUES (?, ?, 'Bonus Model', 1, 1, 'Frontier', NULL, NULL, NULL, NULL, '', 128000, 1, 0, 1)
  `).run(platform, modelId).lastInsertRowid);
  const profile = Number((db.prepare("SELECT value FROM settings WHERE key = 'active_profile_id'").get() as { value: string }).value);
  db.prepare('INSERT INTO fallback_config (model_db_id, priority, enabled) VALUES (?, 1, 1)').run(id);
  db.prepare('INSERT INTO profile_models (profile_id, model_db_id, priority, enabled) VALUES (?, ?, 1, 1)').run(profile, id);
}

/** What the xKiro usage poll writes once the daily free tokens are gone. */
function observeDailyExhausted(keyId: number, modelId: string): void {
  const now = Date.now();
  const midnight = new Date(now);
  midnight.setUTCHours(24, 0, 0, 0);
  const pool = resolveQuotaPolicy('xkiro', modelId, null).poolKey;
  getDb().prepare(`
    INSERT INTO provider_quota_state (platform, key_id, quota_pool_key, metric, limit_value, remaining_value,
      reset_at, reset_strategy, source, confidence, observed_at)
    VALUES ('xkiro', ?, ?, 'tokens', 1000000, 0, ?, 'fixed_calendar', 'quota_api', 0.9, ?)
  `).run(keyId, pool, midnight.toISOString(), new Date(now - 60_000).toISOString());
  invalidateQuotaPressure();
}

function routes(): boolean {
  try {
    routeRequest(500).release?.();
    return true;
  } catch {
    return false;
  }
}

describe('bonus grants in routing', () => {
  let key: number;

  beforeEach(() => {
    reset();
    key = addKey('xkiro');
    addRoute('xkiro', 'qwen/qwen3.8-max:free');
  });

  it('serves past an exhausted daily pool only while a window is open', () => {
    observeDailyExhausted(key, 'qwen/qwen3.8-max:free');
    expect(routes()).toBe(false);

    const grant = createBonusGrant({
      platform: 'xkiro', keyIds: [key], metric: 'total_tokens',
      quantity: 30_000_000, durationHours: 720, normalLimit: 1_000_000, timezone: 'UTC',
    });
    // A grant without a window adds nothing.
    expect(routes()).toBe(false);

    openBonusAllowance(grant.id, { quantity: 2_000_000, durationHours: 24 });
    const routed = routeRequest(500);
    routed.release?.();
    expect(routed.platform).toBe('xkiro');
    expect(routed.leaseId).toEqual(expect.any(Number));
  });

  it('leaves routing untouched for keys no grant covers', () => {
    expect(routes()).toBe(true);
    observeDailyExhausted(key, 'qwen/qwen3.8-max:free');
    expect(routes()).toBe(false);
  });
});

interface ApiReply {
  grant: BonusGrantView;
  grants: BonusGrantView[];
  error?: { message: string };
}

async function call(app: Express, token: string, method: string, path: string, body?: unknown): Promise<{ status: number; body: ApiReply }> {
  const server = app.listen(0, '127.0.0.1');
  if (!server.listening) await new Promise<void>(resolve => server.once('listening', () => resolve()));
  const { port } = server.address() as { port: number };
  try {
    const res = await fetch(`http://127.0.0.1:${port}${path}`, {
      method,
      headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const reply: ApiReply = await res.json();
    return { status: res.status, body: reply };
  } finally {
    server.close();
  }
}

describe('bonus grant API', () => {
  let app: Express;
  let token: string;
  let key: number;

  beforeEach(() => {
    reset();
    app = createApp();
    token = mintDashboardToken();
    key = addKey('xkiro');
  });

  it('creates, edits, opens and closes a window, and reports errors as 4xx', async () => {
    const created = await call(app, token, 'POST', '/api/quota/bonuses', {
      platform: 'xkiro', keyIds: [key], metric: 'total_tokens',
      quantity: 30_000_000, durationHours: 720, normalLimit: 1_000_000, timezone: 'UTC', label: 'Promo',
    });
    expect(created.status).toBe(201);
    const id = created.body.grant.id;

    expect((await call(app, token, 'PATCH', `/api/quota/bonuses/${id}`, { label: 'October promo' })).body.grant.label).toBe('October promo');
    const opened = await call(app, token, 'POST', `/api/quota/bonuses/${id}/allowance`, { quantity: 2_000_000, durationHours: 24 });
    expect(opened.body.grant.allowance).toMatchObject({ quantity: 2_000_000, status: 'active' });
    const closed = await call(app, token, 'DELETE', `/api/quota/bonuses/${id}/allowance`);
    expect(closed.body.grant.allowance.status).toBe('cancelled');

    const listed = await call(app, token, 'GET', '/api/quota/bonuses');
    expect(listed.body.grants).toHaveLength(1);
    expect(listed.body.grants[0]).toMatchObject({ label: 'October promo', accounting: 'local', used: 0 });

    const credits = await call(app, token, 'POST', '/api/quota/bonuses', {
      platform: 'xkiro', keyIds: [key], metric: 'credits', quantity: 5, durationHours: 24, normalLimit: 1,
    });
    expect(credits.status).toBe(400);
    expect((await call(app, token, 'POST', `/api/quota/bonuses/${id}/allowance`, { quantity: 40_000_000, durationHours: 1 })).status).toBe(400);
    expect((await call(app, token, 'PATCH', '/api/quota/bonuses/9999', { label: 'x' })).status).toBe(404);
    expect((await call(app, token, 'POST', '/api/quota/bonuses', {
      platform: 'xkiro', keyIds: [key], metric: 'total_tokens', quantity: 1, durationHours: 1, normalLimit: 1,
    })).status).toBe(409);
  });
});
