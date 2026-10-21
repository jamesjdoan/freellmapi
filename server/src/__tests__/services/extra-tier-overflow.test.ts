import { describe, it, expect, beforeEach, vi } from 'vitest';

// ADR ARCH-20261022-extra-tier-overflow: when a chain runs out of routes, try
// Extra-Tier's routes before returning an error.
//
// The seams this suite pins:
//   - a chain whose members are all cooling down routes to an Extra-Tier member
//   - appended rows that break the chain's tools/vision contract are never used
//   - Extra-Tier itself gets no tail
//   - with the extension off, behaviour is unchanged
//   - the fallback loop records an overflow attempt with `overflow: true`

const { mockCheckKeyHealth } = vi.hoisted(() => ({ mockCheckKeyHealth: vi.fn() }));
vi.mock('../../services/health.js', () => ({
  checkKeyHealth: mockCheckKeyHealth,
  markKeyHealthyFromRequest: vi.fn(),
}));

import { initDb, getDb } from '../../db/index.js';
import { encrypt } from '../../lib/crypto.js';
import { resolveModelGroupCandidates, resolveRoutingChain, routeRequest, setRoutingStrategy } from '../../services/router.js';
import { getDefaultChainProfileId } from '../../services/profile-models.js';
import { setExtensionEnabled, resetExtensionStateCache } from '../../services/extension-state.js';
import { EXTRA_TIER_OVERFLOW_ID } from '../../data/extension-registry.js';
import { setCooldown } from '../../services/ratelimit.js';
import { invalidateQuotaPressure } from '../../services/quota-pressure.js';
import { runFallbackLoop, newFallbackState, type FallbackHooks } from '../../lib/fallback-loop.js';
import { logRequest } from '../../lib/request-log.js';
import type { RouteResult } from '../../services/router.js';

function reset(): void {
  process.env.ENCRYPTION_KEY = '0'.repeat(64);
  initDb(':memory:');
  const db = getDb();
  db.prepare('DELETE FROM fallback_config').run();
  db.prepare('DELETE FROM profile_models').run();
  db.prepare('DELETE FROM models').run();
  db.prepare('DELETE FROM api_keys').run();
  db.prepare('DELETE FROM rate_limit_cooldowns').run();
  invalidateQuotaPressure();
  resetExtensionStateCache();
  setRoutingStrategy('priority');
}

function addKey(platform: string): number {
  const secret = encrypt(`${platform}-overflow-test-key`);
  const info = getDb().prepare(`
    INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled)
    VALUES (?, 'overflow-test', ?, ?, ?, 'healthy', 1)
  `).run(platform, secret.encrypted, secret.iv, secret.authTag);
  return Number(info.lastInsertRowid);
}

interface ModelOpts {
  tools?: boolean;
  vision?: boolean;
  contextWindow?: number;
}

function addModel(platform: string, modelId: string, opts: ModelOpts = {}): number {
  const info = getDb().prepare(`
    INSERT INTO models (platform, model_id, display_name, intelligence_rank, speed_rank, size_label,
      monthly_token_budget, context_window, enabled, supports_vision, supports_tools)
    VALUES (?, ?, ?, 5, 5, 'Large', '', ?, 1, ?, ?)
  `).run(
    platform, modelId, `${modelId} (${platform})`,
    opts.contextWindow ?? 128000,
    opts.vision ? 1 : 0,
    opts.tools === false ? 0 : 1,
  );
  return Number(info.lastInsertRowid);
}

/** A chain, created the way the dashboard creates one: custom and empty. */
function addChain(name: string, members: number[]): number {
  const db = getDb();
  const info = db.prepare("INSERT INTO profiles (name, type) VALUES (?, 'custom')").run(name);
  const profileId = Number(info.lastInsertRowid);
  const insert = db.prepare('INSERT INTO profile_models (profile_id, model_db_id, priority, enabled) VALUES (?, ?, ?, 1)');
  members.forEach((id, i) => insert.run(profileId, id, i + 1));
  return profileId;
}

/** The chain plain `auto` routes over. */
function setDefaultChain(profileId: number): void {
  getDb().prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)')
    .run('default_chain_profile_id', String(profileId));
}

/** The chain being edited — separate from the routing default since #1409. */
function setActiveChain(profileId: number): void {
  getDb().prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run('active_profile_id', String(profileId));
}

beforeEach(reset);

describe('the Extra-Tier overflow tail', () => {
  it('appends Extra-Tier members to a chain, in Extra-Tier order, after the chain own rows', () => {
    const chainModel = addModel('groq', 'chain-model');
    const overflowFirst = addModel('google', 'overflow-first');
    const overflowSecond = addModel('cerebras', 'overflow-second');
    addChain('Work-Chain', [chainModel]);
    addChain('Extra-Tier', [overflowFirst, overflowSecond]);
    setDefaultChain(defaultProfileId('Work-Chain'));
    setActiveChain(defaultProfileId('Work-Chain'));

    const resolved = resolveRoutingChain('auto');
    expect(resolved.chain.map(r => r.model_id)).toEqual(['chain-model', 'overflow-first', 'overflow-second']);
    // The tail rows carry the flag the downstream code identifies them by.
    expect(resolved.chain.filter(r => r.overflow).map(r => r.model_id)).toEqual(['overflow-first', 'overflow-second']);
    expect(resolved.chain[0].overflow).toBeUndefined();
  });

  it('serves a cooled-out chain from Extra-Tier instead of refusing the request', () => {
    const chainModel = addModel('groq', 'chain-model');
    const overflowModel = addModel('google', 'overflow-model');
    addKey('groq');
    addKey('google');
    addChain('Work-Chain', [chainModel]);
    addChain('Extra-Tier', [overflowModel]);
    setDefaultChain(defaultProfileId('Work-Chain'));
    setActiveChain(defaultProfileId('Work-Chain'));

    // The chain's only member is cooling down, so the request must walk on.
    const chainKeyId = keyId('groq');
    setCooldown('groq', 'chain-model', chainKeyId, 60_000);

    const resolved = resolveRoutingChain('auto');
    const route = routeRequest(1000, undefined, undefined, false, false, undefined, resolved.chain);
    expect(route.modelId).toBe('overflow-model');
    expect(route.overflow).toBe(true);
  });

  it('keeps the chain contract: a tools chain never overflows onto a model without tools', () => {
    const chainModel = addModel('groq', 'chain-model');
    const noTools = addModel('google', 'overflow-no-tools', { tools: false });
    const withTools = addModel('cerebras', 'overflow-with-tools', { tools: true });
    addKey('groq');
    addKey('google');
    addKey('cerebras');
    addChain('Coding', [chainModel]);
    addChain('Extra-Tier', [noTools, withTools]);
    setDefaultChain(defaultProfileId('Coding'));
    setActiveChain(defaultProfileId('Coding'));

    const resolved = resolveRoutingChain('auto:coding');
    // The tool-less Extra-Tier member is not appended at all.
    expect(resolved.chain.map(r => r.model_id)).toEqual(['chain-model', 'overflow-with-tools']);

    // And when the chain's own member is cooling down, the request still lands
    // on a tool-capable route.
    setCooldown('groq', 'chain-model', keyId('groq'), 60_000);
    const route = routeRequest(1000, undefined, undefined, false, true, undefined, resolved.chain);
    expect(route.modelId).toBe('overflow-with-tools');
  });

  it('keeps the chain contract for vision too', () => {
    const chainModel = addModel('groq', 'chain-model', { vision: true });
    const blind = addModel('google', 'overflow-blind', { vision: false });
    const seeing = addModel('cerebras', 'overflow-seeing', { vision: true });
    addChain('Vision', [chainModel]);
    addChain('Extra-Tier', [blind, seeing]);
    setDefaultChain(defaultProfileId('Vision'));
    setActiveChain(defaultProfileId('Vision'));

    const resolved = resolveRoutingChain('auto:vision');
    expect(resolved.chain.map(r => r.model_id)).toEqual(['chain-model', 'overflow-seeing']);
  });

  it('gives Extra-Tier itself no tail', () => {
    const overflowFirst = addModel('google', 'overflow-first');
    const overflowSecond = addModel('cerebras', 'overflow-second');
    addChain('Extra-Tier', [overflowFirst, overflowSecond]);
    setDefaultChain(defaultProfileId('Extra-Tier'));
    setActiveChain(defaultProfileId('Extra-Tier'));

    const resolved = resolveRoutingChain('auto:extra-tier');
    expect(resolved.chain.map(r => r.model_id)).toEqual(['overflow-first', 'overflow-second']);
    expect(resolved.chain.some(r => r.overflow)).toBe(false);
  });

  it('leaves a global sort alone', () => {
    const chainModel = addModel('groq', 'chain-model');
    const overflowModel = addModel('google', 'overflow-model');
    addChain('Work-Chain', [chainModel]);
    addChain('Extra-Tier', [overflowModel]);
    setDefaultChain(defaultProfileId('Work-Chain'));
    setActiveChain(defaultProfileId('Work-Chain'));

    // `auto:smart` already spans the whole catalogue, so Extra-Tier would only
    // add rows the sort already walks.
    const resolved = resolveRoutingChain('auto:smart');
    expect(resolved.chain.some(r => r.overflow)).toBe(false);
  });

  it('changes nothing when the extension is off', () => {
    const chainModel = addModel('groq', 'chain-model');
    const overflowModel = addModel('google', 'overflow-model');
    addChain('Work-Chain', [chainModel]);
    addChain('Extra-Tier', [overflowModel]);
    setDefaultChain(defaultProfileId('Work-Chain'));
    setActiveChain(defaultProfileId('Work-Chain'));

    setExtensionEnabled(EXTRA_TIER_OVERFLOW_ID, false);
    const resolved = resolveRoutingChain('auto');
    expect(resolved.chain.map(r => r.model_id)).toEqual(['chain-model']);
    expect(resolved.chain.some(r => r.overflow)).toBe(false);
  });

  it('never overflows an explicit model id', () => {
    const chainModel = addModel('groq', 'chain-model');
    const overflowModel = addModel('google', 'overflow-model');
    addChain('Work-Chain', [chainModel]);
    addChain('Extra-Tier', [overflowModel]);
    setDefaultChain(defaultProfileId('Work-Chain'));
    setActiveChain(defaultProfileId('Work-Chain'));

    // An explicit model id is the client's own instruction: it never resolves
    // through the chain, so it never gains an overflow tail.
    const candidates = resolveModelGroupCandidates([overflowModel]);
    expect(candidates.some(r => r.overflow)).toBe(false);
  });

  it('never duplicates a model the chain already holds', () => {
    const shared = addModel('groq', 'shared-model');
    const overflowOnly = addModel('google', 'overflow-only');
    addChain('Work-Chain', [shared]);
    addChain('Extra-Tier', [shared, overflowOnly]);
    setDefaultChain(defaultProfileId('Work-Chain'));
    setActiveChain(defaultProfileId('Work-Chain'));

    const resolved = resolveRoutingChain('auto');
    expect(resolved.chain.map(r => r.model_id)).toEqual(['shared-model', 'overflow-only']);
  });

  it('skips an Extra-Tier member the operator switched off', () => {
    const chainModel = addModel('groq', 'chain-model');
    const offModel = addModel('google', 'overflow-off');
    const onModel = addModel('cerebras', 'overflow-on');
    addChain('Work-Chain', [chainModel]);
    addChain('Extra-Tier', [offModel, onModel]);
    setDefaultChain(defaultProfileId('Work-Chain'));
    setActiveChain(defaultProfileId('Work-Chain'));
    getDb().prepare('UPDATE profile_models SET enabled = 0 WHERE model_db_id = ?').run(offModel);

    const resolved = resolveRoutingChain('auto');
    expect(resolved.chain.map(r => r.model_id)).toEqual(['chain-model', 'overflow-on']);
  });
});

describe('the fallback loop records the overflow', () => {
  it('marks an overflow attempt with overflow: true, and the request row with the same mark', async () => {
    // Distinct keyId AND modelDbId per fake route: the router's penalty map and
    // the cooldown store are module-global, so shared ids would leak state.
    let seq = 9500;
    const fakeRoute = (overrides: Partial<RouteResult>): RouteResult => {
      const n = ++seq;
      return {
        provider: {} as unknown as RouteResult['provider'],
        modelId: 'fake-model', modelDbId: 787000 + n, apiKey: 'k',
        keyId: n, keyLabel: null, platform: 'fake', displayName: 'Fake Model',
        rpdLimit: null, tpdLimit: null,
        ...overrides,
      };
    };

    const overflowRoute = fakeRoute({ modelId: 'overflow-model', overflow: true });
    const ownRoute = fakeRoute({ modelId: 'own-model' });

    const hooks: FallbackHooks = {
      state: newFallbackState(),
      timeBudgetMs: 0,
      route: (attempt: number) => (attempt === 0 ? ownRoute : overflowRoute),
      dispatch: async (route: RouteResult, attempt: number) => {
        // The chain's own member fails first, so the request fails over into
        // the Extra-Tier tail.
        if (attempt === 0) throw Object.assign(new Error('429 Too Many Requests'), { status: 429 });
        // The surface's own logRequest call happens inside the dispatch, so the
        // overflow mark has to be on the trace before it runs.
        logRequest(route.platform, route.modelId, route.keyId, 'success', 10, 5, 7, null);
        return 'done';
      },
      logFailure: () => {},
      onFatal: () => { throw new Error('unexpected onFatal'); },
      onRoutingExhausted: () => { throw new Error('unexpected onRoutingExhausted'); },
      onExhausted: () => { throw new Error('unexpected onExhausted'); },
    };

    await runFallbackLoop(hooks);

    const attemptRows = getDb().prepare(
      'SELECT ordinal, model_id, overflow FROM request_attempts ORDER BY ordinal',
    ).all() as { ordinal: number; model_id: string; overflow: number }[];
    // Two hops: the chain's own member (not an overflow) and then the
    // Extra-Tier member that served the request.
    expect(attemptRows.map(r => r.model_id)).toEqual(['own-model', 'overflow-model']);
    expect(attemptRows.map(r => r.overflow)).toEqual([0, 1]);

    // The request row carries the same mark, so the dashboard can count how
    // often a chain leaned on Extra-Tier.
    const requestRows = getDb().prepare('SELECT overflow FROM requests').all() as { overflow: number }[];
    expect(requestRows).toHaveLength(1);
    expect(requestRows[0].overflow).toBe(1);
  });

  it('leaves the request row unmarked when no attempt overflowed', async () => {
    let seq = 9700;
    const fakeRoute = (): RouteResult => {
      const n = ++seq;
      return {
        provider: {} as unknown as RouteResult['provider'],
        modelId: 'own-model', modelDbId: 797000 + n, apiKey: 'k',
        keyId: n, keyLabel: null, platform: 'fake', displayName: 'Fake Model',
        rpdLimit: null, tpdLimit: null,
      };
    };

    const hooks: FallbackHooks = {
      state: newFallbackState(),
      timeBudgetMs: 0,
      route: () => fakeRoute(),
      dispatch: async (route: RouteResult) => {
        logRequest(route.platform, route.modelId, route.keyId, 'success', 10, 5, 7, null);
        return 'done';
      },
      logFailure: () => {},
      onFatal: () => { throw new Error('unexpected onFatal'); },
      onRoutingExhausted: () => { throw new Error('unexpected onRoutingExhausted'); },
      onExhausted: () => { throw new Error('unexpected onExhausted'); },
    };

    await runFallbackLoop(hooks);

    const attemptRows = getDb().prepare('SELECT overflow FROM request_attempts').all() as { overflow: number }[];
    expect(attemptRows).toHaveLength(1);
    expect(attemptRows[0].overflow).toBe(0);
    const requestRows = getDb().prepare('SELECT overflow FROM requests').all() as { overflow: number }[];
    expect(requestRows[0].overflow).toBe(0);
  });
});

/** The id of the chain profile with this name. */
function defaultProfileId(name: string): number {
  const row = getDb().prepare('SELECT id FROM profiles WHERE LOWER(name) = ?').get(name.toLowerCase()) as { id: number };
  return row.id;
}

/** The id of the one enabled key on this platform. */
function keyId(platform: string): number {
  const row = getDb().prepare('SELECT id FROM api_keys WHERE platform = ? LIMIT 1').get(platform) as { id: number };
  return row.id;
}
