import { describe, it, expect, beforeEach } from 'vitest';
import type { Express } from 'express';
import { createApp } from '../../app.js';
import { initDb, getDb } from '../../db/index.js';
import { encrypt } from '../../lib/crypto.js';
import { routeRequest } from '../../services/router.js';
import { invalidateShadowCounts, resetLeases } from '../../services/ratelimit.js';
import { invalidateQuotaPressure } from '../../services/quota-pressure.js';
import { setExtensionEnabled, resetExtensionStateCache } from '../../services/extension-state.js';
import { PAID_BALANCE_GUARD_ID, PAID_SPEND_CONFIRMATION } from '../../data/extension-registry.js';
import {
  evaluatePaidCredit,
  holdPaidCredit,
  releasePaidCredit,
  openPaidCreditWindow,
  closePaidCreditWindow,
  paidCreditOverview,
  paidModelOptions,
  setPaidModelSelected,
  resetPaidCreditState,
  resetPaidModelListing,
  SETTLE_DELAY_MS,
} from '../../services/paid-credit.js';
import { mintDashboardToken } from '../helpers/auth.js';

// Paid credit windows end to end: selection, the typed-confirmation window,
// measured spend, one-attempt-at-a-time admission and last-resort routing.

const PAID = 'anthropic/claude-sonnet-5';
const FREE = 'qwen/qwen3:free';

const listing = {
  data: [
    { id: PAID, name: 'Claude Sonnet 5', context_length: 200_000, pricing: { prompt: '0.000003', completion: '0.000015' },
      supported_parameters: ['tools'], architecture: { input_modalities: ['text', 'image'] } },
    { id: FREE, name: 'Qwen free', pricing: { prompt: '0', completion: '0' } },
    { id: 'zero/priced', name: 'Zero', pricing: { prompt: '0', completion: '0' } },
    { id: 'no/pricing', name: 'Unpriced' },
  ],
};
const fakeFetch = (async () => new Response(JSON.stringify(listing), { status: 200 })) as unknown as typeof fetch;

function reset(): void {
  process.env.ENCRYPTION_KEY = '0'.repeat(64);
  initDb(':memory:');
  const db = getDb();
  for (const table of ['fallback_config', 'profile_models', 'models', 'api_keys', 'quota_policy', 'rate_limit_usage', 'provider_quota_state']) {
    db.prepare(`DELETE FROM ${table}`).run();
  }
  resetExtensionStateCache();
  invalidateShadowCounts();
  invalidateQuotaPressure();
  resetLeases();
  resetPaidCreditState();
  resetPaidModelListing();
}

function addKey(platform: string): number {
  const secret = encrypt(`${platform}-paid-credit-test`);
  return Number(getDb().prepare(
    "INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled) VALUES (?, 'paid', ?, ?, ?, 'healthy', 1)",
  ).run(platform, secret.encrypted, secret.iv, secret.authTag).lastInsertRowid);
}

function addChainRoute(platform: string, modelId: string): void {
  const db = getDb();
  const id = Number(db.prepare(`
    INSERT INTO models (platform, model_id, display_name, intelligence_rank, speed_rank, size_label,
      context_window, enabled, supports_vision, supports_tools)
    VALUES (?, ?, ?, 1, 1, 'Frontier', 128000, 1, 0, 1)
  `).run(platform, modelId, modelId).lastInsertRowid);
  const profile = Number((db.prepare("SELECT value FROM settings WHERE key = 'active_profile_id'").get() as { value: string }).value);
  db.prepare('INSERT INTO fallback_config (model_db_id, priority, enabled) VALUES (?, 1, 1)').run(id);
  db.prepare('INSERT INTO profile_models (profile_id, model_db_id, priority, enabled) VALUES (?, ?, 1, 1)').run(profile, id);
}

/** What the OpenRouter usage poll writes: limit and remaining in cents. */
function observe(keyId: number, limit: number, remaining: number, atMs: number): void {
  getDb().prepare(`
    INSERT OR REPLACE INTO provider_quota_state (platform, key_id, quota_pool_key, metric, unit, limit_value, remaining_value,
      reset_strategy, source, confidence, observed_at)
    VALUES ('openrouter', ?, 'openrouter::credits', 'credits', 'cents', ?, ?, 'rolling_window', 'quota_api', 0.9, ?)
  `).run(keyId, limit, remaining, new Date(atMs).toISOString());
}

async function openWindow(keyId: number, quantity: number, hours = 24, used = 200): Promise<number> {
  const view = await openPaidCreditWindow(
    { platform: 'openrouter', keyId, quantity, durationHours: hours, confirmation: PAID_SPEND_CONFIRMATION },
    Date.now(), getDb(), async () => observe(keyId, 1_200, 1_200 - used, Date.now()),
  );
  return view.window!.id;
}

function routes(): string | null {
  try {
    const r = routeRequest(500);
    r.release?.();
    return r.modelId;
  } catch {
    return null;
  }
}

describe('paid credit windows', () => {
  let key: number;

  beforeEach(async () => {
    reset();
    key = addKey('openrouter');
    await setPaidModelSelected('openrouter', PAID, true, getDb(), fakeFetch);
  });

  it('lists only priced models and records a selection as a routable model row', async () => {
    const options = await paidModelOptions('openrouter', getDb(), fakeFetch);
    expect(options.map(o => o.modelId)).toEqual([PAID]);
    expect(options[0]).toMatchObject({ selected: true, supportsTools: true, supportsVision: true, contextLength: 200_000, promptPerM: 3, completionPerM: 15 });
    expect(getDb().prepare('SELECT source, enabled FROM models WHERE model_id = ?').get(PAID)).toEqual({ source: 'user', enabled: 1 });

    await setPaidModelSelected('openrouter', PAID, false, getDb(), fakeFetch);
    expect((await paidModelOptions('openrouter', getDb(), fakeFetch))[0].selected).toBe(false);
    await expect(setPaidModelSelected('groq', 'x', true, getDb(), fakeFetch)).rejects.toThrow(/cannot hold a credit window/);
  });

  it('opens a window only with the typed confirmation and a fresh balance', async () => {
    const open = (over: Record<string, unknown>, readNow = async () => observe(key, 1_200, 1_000, Date.now())) =>
      openPaidCreditWindow({ platform: 'openrouter', keyId: key, quantity: 100, durationHours: 1, confirmation: PAID_SPEND_CONFIRMATION, ...over }, Date.now(), getDb(), readNow);

    await expect(open({ confirmation: 'yes' })).rejects.toThrow(/ALLOW PAID SPEND/);
    await expect(open({}, async () => observe(key, 1_200, 1_000, Date.now() - 10 * 60_000))).rejects.toThrow(/current credit balance/);
    await expect(open({ quantity: 1_001 })).rejects.toThrow(/larger than the balance left/);

    const view = await open({});
    expect(view.window).toMatchObject({ quantity: 100, spent: 0, unit: 'cents', status: 'active' });
    expect(view.balance).toMatchObject({ used: 200, remaining: 1_000 });
  });

  it('admits one measured attempt at a time and stops when measured spend reaches the window', async () => {
    expect(evaluatePaidCredit('openrouter', key)).toMatchObject({ admitted: false, reason: 'no-credit-window' });
    const windowId = await openWindow(key, 100);
    expect(evaluatePaidCredit('openrouter', key)).toMatchObject({ admitted: true, windowId });

    const t0 = Date.now();
    holdPaidCredit(1, windowId, key, t0);
    expect(evaluatePaidCredit('openrouter', key)).toMatchObject({ admitted: false, reason: 'credit-attempt-in-flight' });
    releasePaidCredit(1, t0);
    // A reading taken before the charge could be booked does not count.
    observe(key, 1_200, 960, t0 + 1_000);
    expect(evaluatePaidCredit('openrouter', key)).toMatchObject({ admitted: false, reason: 'credit-awaiting-reading' });

    // Measured: 40 of 100 cents spent since the window opened.
    observe(key, 1_200, 960, t0 + SETTLE_DELAY_MS + 1);
    expect(evaluatePaidCredit('openrouter', key).admitted).toBe(true);
    expect(paidCreditOverview().keys[0].window).toMatchObject({ spent: 40, remaining: 60, awaitingReading: false });

    // Other spend on the account counts too: the window stops early, never late.
    observe(key, 1_200, 900, t0 + SETTLE_DELAY_MS + 2);
    expect(evaluatePaidCredit('openrouter', key)).toMatchObject({ admitted: false, reason: 'credit-window-exhausted' });
  });

  it('refuses once the window expires or is closed', async () => {
    const windowId = await openWindow(key, 100, 1);
    expect(evaluatePaidCredit('openrouter', key, Date.now() + 3_600_001)).toMatchObject({ reason: 'credit-window-expired' });
    closePaidCreditWindow(windowId);
    expect(evaluatePaidCredit('openrouter', key)).toMatchObject({ reason: 'credit-window-cancelled' });
  });

  it('tries the selected paid model only after every free route, and only through a window', async () => {
    addChainRoute('openrouter', FREE);
    expect(routes()).toBe(FREE);

    // Take the free route away: the paid tier is all that is left.
    getDb().prepare('UPDATE models SET enabled = 0 WHERE model_id = ?').run(FREE);
    expect(routes()).toBeNull();
    await openWindow(key, 100);
    expect(routes()).toBe(PAID);

    // With the free route back, it wins again.
    getDb().prepare('UPDATE models SET enabled = 1 WHERE model_id = ?').run(FREE);
    resetPaidCreditState();
    expect(routes()).toBe(FREE);
  });

  it('adds nothing while the extension is off, and leaves an off guard to its own acknowledged decision', async () => {
    await openWindow(key, 100);
    setExtensionEnabled('paid-credit-windows', false);
    expect(routes()).toBeNull();
    expect(evaluatePaidCredit('openrouter', key)).toMatchObject({ reason: 'paid-credit-off' });
    setExtensionEnabled('paid-credit-windows', true);
    expect(routes()).toBe(PAID);

    setExtensionEnabled(PAID_BALANCE_GUARD_ID, false, { confirmation: PAID_SPEND_CONFIRMATION });
    expect(evaluatePaidCredit('openrouter', key)).toMatchObject({ reason: 'paid-credit-off' });
    expect(paidCreditOverview().guardActive).toBe(false);
  });
});

describe('paid credit API', () => {
  let app: Express;

  beforeEach(() => {
    reset();
    app = createApp();
  });

  it('refuses a window without the confirmation', async () => {
    const key = addKey('openrouter');
    const token = mintDashboardToken();
    const server = app.listen(0, '127.0.0.1');
    if (!server.listening) await new Promise<void>(resolve => server.once('listening', () => resolve()));
    const { port } = server.address() as { port: number };
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/quota/paid-credit/windows`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ platform: 'openrouter', keyId: key, quantity: 100, durationHours: 1, confirmation: 'ok' }),
      });
      expect(res.status).toBe(400);
      const overview = await fetch(`http://127.0.0.1:${port}/api/quota/paid-credit`, { headers: { Authorization: `Bearer ${token}` } });
      const body: { platforms: string[]; keys: Array<{ keyId: number; window: unknown }> } = await overview.json();
      expect(body.platforms).toEqual(['openrouter']);
      expect(body.keys).toEqual([expect.objectContaining({ keyId: key, window: null })]);
    } finally {
      server.close();
    }
  });
});
