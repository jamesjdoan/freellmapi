import { describe, it, expect, beforeAll, afterEach } from 'vitest';

// OpenRouter's stealth "Space Bunny" is free with no meter, but its id has no
// ":free", so the paid-balance guard and every local limit treated it as a
// paid, metered route. An operator can now flag it unlimited - effective only
// while OpenRouter's own listing prices it at $0.

import { initDb, getDb } from '../../db/index.js';
import { encrypt } from '../../lib/crypto.js';
import { routePinnedModel } from '../../services/router.js';
import { recordRequest, countRequestsInWindow } from '../../services/ratelimit.js';
import { invalidateUnlimitedCache, isUnlimitedModel, refreshUnlimitedPrices } from '../../services/unlimited-models.js';
import { logRequest } from '../../lib/request-log.js';

const monthlyRequests = (): number => {
  const row = getDb().prepare('SELECT COALESCE(SUM(requests), 0) AS n FROM key_monthly_usage WHERE key_id = ?').get(keyId) as { n: number };
  return row.n;
};

const MODEL = 'stealth/space-bunny-alpha';
let modelDbId = 0;
let keyId = 0;

const listing = (price: string | null): typeof fetch => (async () => new Response(JSON.stringify({
  data: price == null ? [] : [{ id: MODEL, pricing: { prompt: price, completion: price } }],
}), { status: 200 })) as unknown as typeof fetch;
const failing: typeof fetch = (async () => { throw new Error('network down') }) as unknown as typeof fetch;

describe('unlimited models', () => {
  beforeAll(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
    const db = getDb();
    const { encrypted, iv, authTag } = encrypt('sk-test');
    keyId = Number(db.prepare(`INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled)
                               VALUES ('openrouter', 'or', ?, ?, ?, 'healthy', 1)`).run(encrypted, iv, authTag).lastInsertRowid);
    // A per-model limit of one request a minute, so "past a limit" is one call.
    modelDbId = Number(db.prepare(`INSERT INTO models (platform, model_id, display_name, intelligence_rank, speed_rank, size_label, rpm_limit, enabled, supports_tools, source)
                                   VALUES ('openrouter', ?, 'Space Bunny', 1, 1, 'Large', 1, 1, 1, 'user')`).run(MODEL).lastInsertRowid);
  });
  afterEach(() => invalidateUnlimitedCache());

  it('is in force only while the provider prices it at $0, and a failed check changes nothing', async () => {
    const db = getDb();
    db.prepare('UPDATE models SET unlimited = 1 WHERE id = ?').run(modelDbId);
    // Flagged but never price-checked: a guarded platform stays guarded.
    expect(isUnlimitedModel('openrouter', MODEL)).toBe(false);

    await refreshUnlimitedPrices(db, listing('0'));
    expect(isUnlimitedModel('openrouter', MODEL)).toBe(true);

    // The listing is unreachable: the last known $0 stands.
    await refreshUnlimitedPrices(db, failing);
    expect(isUnlimitedModel('openrouter', MODEL)).toBe(true);

    // The stealth period ends and it starts charging: the exemption lapses by itself.
    await refreshUnlimitedPrices(db, listing('0.000001'));
    expect(isUnlimitedModel('openrouter', MODEL)).toBe(false);

    // Delisted: no stated price is not a $0 price.
    await refreshUnlimitedPrices(db, listing('0'));
    await refreshUnlimitedPrices(db, listing(null));
    expect(isUnlimitedModel('openrouter', MODEL)).toBe(false);
  });

  it('is served past its limits and counted toward none, and counted again once it charges', async () => {
    const db = getDb();
    db.prepare('UPDATE models SET unlimited = 1 WHERE id = ?').run(modelDbId);
    await refreshUnlimitedPrices(db, listing('0'));

    for (let i = 0; i < 3; i++) {
      const route = routePinnedModel(modelDbId);
      expect(route?.modelId).toBe(MODEL);
      route?.release?.();
      recordRequest('openrouter', MODEL, keyId);
    }
    // Three calls against rpm_limit 1, and nothing recorded against any window.
    expect(countRequestsInWindow('openrouter', MODEL, 60_000, Date.now(), true)).toBe(0);
    // The monthly usage trigger skipped its log rows too.
    logRequest('openrouter', MODEL, keyId, 'success', 10, 10, 5, null);
    expect(monthlyRequests()).toBe(0);

    await refreshUnlimitedPrices(db, listing('0.000001'));
    recordRequest('openrouter', MODEL, keyId);
    expect(countRequestsInWindow('openrouter', MODEL, 60_000, Date.now(), true)).toBe(1);
    // Now at its one-a-minute limit: refused like any other metered route.
    expect(routePinnedModel(modelDbId)).toBeNull();
    logRequest('openrouter', MODEL, keyId, 'success', 10, 10, 5, null);
    expect(monthlyRequests()).toBe(1);
  });
});
