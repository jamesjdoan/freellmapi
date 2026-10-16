import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { initDb, getDb } from '../../db/index.js';
import { setExtensionEnabled, resetExtensionStateCache } from '../../services/extension-state.js';
import {
  evaluateBonusAdmission,
  reserveBonusLease,
  releaseBonusLease,
  settleBonusUsage,
  createBonusGrant,
  updateBonusGrant,
  openBonusAllowance,
  closeBonusAllowance,
  listBonusGrants,
  resetBonusReservations,
  bonusCoversExhaustion,
  type BonusAdmission,
} from '../../services/bonus.js';
import type { CreateBonusGrantInput } from '@freellmapi/shared/bonus-types.js';

// Temporary bonus grants, through the same calls routing makes: admit, hold,
// write usage, settle. Clock values are explicit so day boundaries are exact.

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const NOW = Date.UTC(2026, 9, 16, 12, 0, 0);

let nextLease = 1;

function addKey(platform: string): number {
  return Number(getDb().prepare(
    "INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled) VALUES (?, 'bonus', 'x', 'x', 'x', 'healthy', 1)",
  ).run(platform).lastInsertRowid);
}

function writeUsage(platform: string, keyId: number, tokens: number, at: number): void {
  const ins = getDb().prepare(
    'INSERT INTO rate_limit_usage (platform, model_id, key_id, kind, tokens, created_at_ms) VALUES (?, ?, ?, ?, ?, ?)',
  );
  ins.run(platform, 'm', keyId, 'request', 0, at);
  if (tokens > 0) ins.run(platform, 'm', keyId, 'tokens', tokens, at);
}

/** Admit, hold, write usage and settle one request, as the fallback loop does. */
function serve(keyId: number, tokens: number, at: number, actualTokens = tokens): BonusAdmission {
  const admission = evaluateBonusAdmission('xkiro', keyId, tokens, at);
  if (!admission.admitted) return admission;
  const lease = nextLease++;
  reserveBonusLease(lease, admission, at);
  writeUsage('xkiro', keyId, actualTokens, at);
  settleBonusUsage({ leaseId: lease, modelId: 'm', keyId, requests: 1, tokens: actualTokens }, at);
  releaseBonusLease(lease);
  return admission;
}

function grantInput(keyId: number, over: Partial<CreateBonusGrantInput> = {}): CreateBonusGrantInput {
  return {
    platform: 'xkiro', keyIds: [keyId], metric: 'total_tokens',
    quantity: 5_000, durationHours: 72, normalLimit: 1_000, timezone: 'UTC', ...over,
  };
}

function view(id: number, at: number) {
  const grant = listBonusGrants(at).find(g => g.id === id);
  if (!grant) throw new Error(`grant ${id} missing`);
  return grant;
}

interface LedgerRow { grant_id: number; allowance_id: number | null; amount: number }

function ledger(): LedgerRow[] {
  return getDb().prepare('SELECT grant_id, allowance_id, amount FROM bonus_usage ORDER BY id').all() as LedgerRow[];
}

describe('bonus grant accounting', () => {
  let key: number;

  beforeEach(() => {
    initDb(':memory:');
    resetExtensionStateCache();
    resetBonusReservations();
    key = addKey('xkiro');
  });

  it('spends the normal allowance first and debits only the excess, once, from window and pool', () => {
    const grant = createBonusGrant(grantInput(key), NOW);
    openBonusAllowance(grant.id, { quantity: 1_000, durationHours: 24 }, NOW);
    writeUsage('xkiro', key, 900, NOW - HOUR);

    const admission = serve(key, 300, NOW);

    expect(admission.admitted).toBe(true);
    expect(admission.funded).toEqual([{ metric: 'total_tokens', normalResetMs: Date.UTC(2026, 9, 17) }]);
    const v = view(grant.id, NOW);
    expect(v.used).toBe(200);
    expect(v.allowance?.used).toBe(200);
    expect(v.normal).toMatchObject({ limit: 1_000, limitSource: 'operator', used: 1_200, remaining: 0 });
    expect(ledger()).toHaveLength(1);
  });

  it('holds a covered key to the normal allowance when no window is open', () => {
    const grant = createBonusGrant(grantInput(key), NOW);
    writeUsage('xkiro', key, 900, NOW - HOUR);

    const within = evaluateBonusAdmission('xkiro', key, 100, NOW);
    expect(within).toMatchObject({ admitted: true, funded: [] });
    expect(evaluateBonusAdmission('xkiro', key, 101, NOW)).toMatchObject({ admitted: false, reason: 'no-spending-window' });

    openBonusAllowance(grant.id, { quantity: 500, durationHours: 1 }, NOW);
    closeBonusAllowance(grant.id, NOW + 1);
    expect(evaluateBonusAdmission('xkiro', key, 101, NOW + 2)).toMatchObject({ admitted: false, reason: 'no-spending-window' });
    expect(view(grant.id, NOW + 2).allowance?.status).toBe('cancelled');
  });

  it('stops at the window even when the pool has plenty left', () => {
    const grant = createBonusGrant(grantInput(key), NOW);
    openBonusAllowance(grant.id, { quantity: 250, durationHours: 24 }, NOW);
    writeUsage('xkiro', key, 1_000, NOW - HOUR);

    expect(serve(key, 200, NOW).admitted).toBe(true);
    expect(evaluateBonusAdmission('xkiro', key, 100, NOW)).toMatchObject({ admitted: false, reason: 'spending-window-spent' });
    expect(evaluateBonusAdmission('xkiro', key, 50, NOW).admitted).toBe(true);
    expect(view(grant.id, NOW)).toMatchObject({ used: 200, remaining: 4_800 });
  });

  it('returns to the normal allowance after the window or the grant expires', () => {
    const grant = createBonusGrant(grantInput(key, { durationHours: 6 }), NOW);
    openBonusAllowance(grant.id, { quantity: 1_000, durationHours: 1 }, NOW);
    writeUsage('xkiro', key, 1_000, NOW - HOUR);

    expect(evaluateBonusAdmission('xkiro', key, 100, NOW + HOUR - 1).admitted).toBe(true);
    expect(evaluateBonusAdmission('xkiro', key, 100, NOW + HOUR)).toMatchObject({ admitted: false, reason: 'no-spending-window' });
    expect(view(grant.id, NOW + HOUR).allowance?.status).toBe('expired');

    // An expired grant applies to nothing: the ordinary gates govern again,
    // and it no longer funds any exhausted allowance.
    const after = evaluateBonusAdmission('xkiro', key, 100, NOW + 6 * HOUR);
    expect(after).toMatchObject({ admitted: true, holds: [], funded: [] });
    expect(view(grant.id, NOW + 6 * HOUR).status).toBe('expired');
  });

  it('refuses beyond normal once the pool is spent, whatever the window says', () => {
    const grant = createBonusGrant(grantInput(key, { quantity: 300 }), NOW);
    openBonusAllowance(grant.id, { quantity: 300, durationHours: 24 }, NOW);
    writeUsage('xkiro', key, 1_000, NOW - HOUR);
    serve(key, 300, NOW);

    expect(view(grant.id, NOW)).toMatchObject({ used: 300, remaining: 0, status: 'exhausted' });
    expect(evaluateBonusAdmission('xkiro', key, 1, NOW)).toMatchObject({ admitted: false, reason: 'bonus-pool-spent' });
  });

  it('gives a fresh normal allowance each reset and never refills the pool', () => {
    const grant = createBonusGrant(grantInput(key), NOW);
    openBonusAllowance(grant.id, { quantity: 2_000, durationHours: 48 }, NOW);
    writeUsage('xkiro', key, 1_000, NOW - HOUR);
    serve(key, 400, NOW);
    expect(view(grant.id, NOW).used).toBe(400);

    // Next UTC day: 900 tokens fit in the new normal allowance.
    const tomorrow = Date.UTC(2026, 9, 17, 1);
    expect(serve(key, 900, tomorrow).funded).toEqual([]);
    expect(view(grant.id, tomorrow)).toMatchObject({ used: 400, normal: { used: 900, remaining: 100 } });

    // A new window draws on what is left; it does not refill the pool or move expiry.
    const replaced = openBonusAllowance(grant.id, { quantity: 4_600, durationHours: 12 }, tomorrow);
    expect(replaced).toMatchObject({ used: 400, remaining: 4_600, expiresAt: new Date(NOW + 72 * HOUR).toISOString() });
    expect(() => openBonusAllowance(grant.id, { quantity: 4_601, durationHours: 12 }, tomorrow)).toThrow(/larger than what the pool has left/);
  });

  it('counts requests in flight so concurrent requests cannot share the same headroom', () => {
    const grant = createBonusGrant(grantInput(key), NOW);
    openBonusAllowance(grant.id, { quantity: 250, durationHours: 24 }, NOW);
    writeUsage('xkiro', key, 900, NOW - HOUR);

    const first = evaluateBonusAdmission('xkiro', key, 200, NOW);
    expect(first.holds[0]).toMatchObject({ cost: 200, excess: 100 });
    reserveBonusLease(1, first, NOW);

    // 900 used + 200 in flight: all 200 of the second request is excess, and
    // only 150 of the window is unclaimed.
    expect(evaluateBonusAdmission('xkiro', key, 200, NOW)).toMatchObject({ admitted: false, reason: 'spending-window-spent' });
    expect(view(grant.id, NOW)).toMatchObject({ reserved: 100, allowance: { reserved: 100, remaining: 150 } });

    releaseBonusLease(1);
    expect(evaluateBonusAdmission('xkiro', key, 200, NOW).admitted).toBe(true);
  });

  it('settles against the window that admitted the request after it is replaced or the grant expires', () => {
    const grant = createBonusGrant(grantInput(key, { durationHours: 2 }), NOW);
    const first = openBonusAllowance(grant.id, { quantity: 500, durationHours: 1 }, NOW).allowance!;
    writeUsage('xkiro', key, 1_000, NOW - HOUR);

    const admission = evaluateBonusAdmission('xkiro', key, 100, NOW);
    reserveBonusLease(7, admission, NOW);
    const second = openBonusAllowance(grant.id, { quantity: 500, durationHours: 1 }, NOW + 1).allowance!;

    // Settles after both the replacement and the grant's own expiry.
    const late = NOW + 3 * HOUR;
    writeUsage('xkiro', key, 100, late);
    settleBonusUsage({ leaseId: 7, modelId: 'm', keyId: key, requests: 1, tokens: 100 }, late);

    expect(ledger()).toEqual([{ grant_id: grant.id, allowance_id: first.id, amount: 100 }]);
    expect(first.id).not.toBe(second.id);
    expect(view(grant.id, late)).toMatchObject({ used: 100, status: 'expired', allowance: { id: second.id, used: 0 } });
  });

  it('debits an attempt admitted on the normal allowance that ran past it', () => {
    const grant = createBonusGrant(grantInput(key), NOW);
    openBonusAllowance(grant.id, { quantity: 1_000, durationHours: 24 }, NOW);
    writeUsage('xkiro', key, 900, NOW - HOUR);

    const admission = serve(key, 50, NOW, 250);
    expect(admission.funded).toEqual([]);
    expect(view(grant.id, NOW)).toMatchObject({ used: 150, allowance: { used: 150 } });
  });

  it('charges nothing for an attempt no grant admitted', () => {
    const grant = createBonusGrant(grantInput(key), NOW);
    writeUsage('xkiro', key, 2_000, NOW);
    settleBonusUsage({ leaseId: 999, modelId: 'm', keyId: key, requests: 1, tokens: 500 }, NOW);
    settleBonusUsage({ modelId: 'm', keyId: key, requests: 1, tokens: 500 }, NOW);
    expect(view(grant.id, NOW).used).toBe(0);
  });

  it('counts requests, not tokens, on a request grant', () => {
    const grant = createBonusGrant(grantInput(key, { metric: 'requests', normalLimit: 2, quantity: 10 }), NOW);
    serve(key, 5_000, NOW);
    serve(key, 5_000, NOW);
    expect(evaluateBonusAdmission('xkiro', key, 1, NOW)).toMatchObject({ admitted: false, reason: 'no-spending-window' });

    openBonusAllowance(grant.id, { quantity: 3, durationHours: 1 }, NOW);
    expect(serve(key, 5_000, NOW).funded).toEqual([{ metric: 'requests', normalResetMs: Date.UTC(2026, 9, 17) }]);
    expect(view(grant.id, NOW)).toMatchObject({ used: 1, normal: { used: 3 }, allowance: { used: 1, remaining: 2 } });
  });

  it('uses a provider observation taken today for usage, letting its limit only lower the normal allowance', () => {
    const grant = createBonusGrant(grantInput(key), NOW);
    const observe = (limit: number, remaining: number, at: number) => getDb().prepare(`
      INSERT OR REPLACE INTO provider_quota_state (platform, key_id, quota_pool_key, metric, limit_value, remaining_value, source, confidence, observed_at)
      VALUES ('xkiro', ?, 'xkiro', 'tokens', ?, ?, 'quota_api', 0.9, ?)
    `).run(key, limit, remaining, new Date(at).toISOString());

    // Yesterday's observation says nothing about today.
    observe(800, 0, NOW - DAY);
    expect(view(grant.id, NOW).normal).toMatchObject({ limit: 1_000, limitSource: 'operator', used: 0 });

    // A provider folding the bonus into its daily figure must not widen
    // "normal": the operator's 1,000 holds. Other clients' usage still counts.
    observe(31_000, 30_100, NOW - 2 * HOUR);
    writeUsage('xkiro', key, 50, NOW - HOUR);
    expect(view(grant.id, NOW).normal).toMatchObject({ limit: 1_000, limitSource: 'operator', used: 950, remaining: 50 });
    expect(evaluateBonusAdmission('xkiro', key, 51, NOW)).toMatchObject({ admitted: false, reason: 'no-spending-window' });

    // A lower provider limit is what it enforces, so it wins.
    observe(800, 100, NOW - 2 * HOUR);
    expect(view(grant.id, NOW).normal).toMatchObject({ limit: 800, limitSource: 'provider', used: 750, remaining: 50 });
  });

  it('keeps consumption through edits and refuses shrinking below it', () => {
    const grant = createBonusGrant(grantInput(key), NOW);
    openBonusAllowance(grant.id, { quantity: 1_000, durationHours: 24 }, NOW);
    writeUsage('xkiro', key, 1_000, NOW - HOUR);
    serve(key, 300, NOW);

    const edited = updateBonusGrant(grant.id, { label: 'promo', quantity: 6_000, durationHours: 96, normalLimit: 1_000 }, NOW);
    expect(edited).toMatchObject({ label: 'promo', used: 300, remaining: 5_700, expiresAt: new Date(NOW + 96 * HOUR).toISOString() });
    expect(edited.allowance?.used).toBe(300);
    expect(() => updateBonusGrant(grant.id, { quantity: 299 }, NOW)).toThrow(/cannot drop below/);
  });

  it('routes a covered key as if it had no grant while the extension is off, keeping its rows', () => {
    const grant = createBonusGrant(grantInput(key), NOW);
    openBonusAllowance(grant.id, { quantity: 1_000, durationHours: 24 }, NOW);
    writeUsage('xkiro', key, 1_000, NOW - HOUR);
    serve(key, 300, NOW);

    setExtensionEnabled('bonus-grants', false);
    try {
      expect(evaluateBonusAdmission('xkiro', key, 300, NOW)).toMatchObject({ admitted: true, holds: [], funded: [] });
      expect(view(grant.id, NOW)).toMatchObject({ used: 300, allowance: { used: 300 } });
    } finally {
      setExtensionEnabled('bonus-grants', true);
    }
    expect(evaluateBonusAdmission('xkiro', key, 300, NOW).funded).toHaveLength(1);
  });

  it('refuses grants it cannot enforce or that would double-count an allowance', () => {
    const other = addKey('groq');
    expect(() => createBonusGrant({ ...grantInput(key), metric: 'credits' as never }, NOW)).toThrow(/per-request cost metering/);
    expect(() => createBonusGrant(grantInput(other), NOW)).toThrow(/belongs to groq/);
    expect(() => createBonusGrant(grantInput(key, { timezone: 'Mars/Olympus' }), NOW)).toThrow(/Unknown timezone/);

    const grant = createBonusGrant(grantInput(key), NOW);
    expect(() => createBonusGrant(grantInput(key), NOW)).toThrow(/already covers/);
    expect(createBonusGrant(grantInput(key, { metric: 'requests' }), NOW).metric).toBe('requests');
    expect(() => openBonusAllowance(grant.id, { quantity: 10, durationHours: 73 }, NOW)).toThrow(/outlast the grant/);
  });

  it('enforces every grant on the key, one per metric', () => {
    const tokens = createBonusGrant(grantInput(key), NOW);
    createBonusGrant(grantInput(key, { metric: 'requests', normalLimit: 1, quantity: 5 }), NOW);
    openBonusAllowance(tokens.id, { quantity: 1_000, durationHours: 1 }, NOW);
    writeUsage('xkiro', key, 0, NOW - HOUR); // the one normal request

    // Tokens fit, but the request axis is spent with no window open.
    expect(evaluateBonusAdmission('xkiro', key, 10, NOW)).toMatchObject({ admitted: false, reason: 'no-spending-window' });
  });

  it('funds only the daily allowance it extends', () => {
    const funded = [{ metric: 'total_tokens' as const, normalResetMs: Date.UTC(2026, 9, 17) }];
    expect(bonusCoversExhaustion(funded, 'tokens', Date.UTC(2026, 9, 17))).toBe(true);
    expect(bonusCoversExhaustion(funded, 'total_tokens', Date.UTC(2026, 9, 17, 0, 30))).toBe(true);
    expect(bonusCoversExhaustion(funded, 'requests', Date.UTC(2026, 9, 17))).toBe(false);
    expect(bonusCoversExhaustion(funded, 'tokens', NOW + 60_000)).toBe(false);
    expect(bonusCoversExhaustion(funded, 'tokens', null)).toBe(false);
  });
});

describe('bonus grant persistence', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'bonus-'));
  });

  afterEach(() => {
    initDb(':memory:');
    rmSync(dir, { recursive: true, force: true });
  });

  it('keeps grant, window and consumption across a restart, and drops in-flight holds', () => {
    const file = path.join(dir, 'data.db');
    initDb(file);
    resetBonusReservations();
    const key = addKey('xkiro');
    const grant = createBonusGrant(grantInput(key), NOW);
    openBonusAllowance(grant.id, { quantity: 1_000, durationHours: 24 }, NOW);
    writeUsage('xkiro', key, 1_000, NOW - HOUR);
    serve(key, 300, NOW);
    reserveBonusLease(42, evaluateBonusAdmission('xkiro', key, 100, NOW), NOW);
    expect(view(grant.id, NOW).reserved).toBe(100);

    // Restart: new connection to the same file, process memory gone.
    resetBonusReservations();
    initDb(file);
    expect(view(grant.id, NOW)).toMatchObject({ used: 300, reserved: 0, allowance: { used: 300, status: 'active' } });
  });
});
