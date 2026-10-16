import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getDb, initDb, setSetting } from '../../db/index.js';
import { encrypt } from '../../lib/crypto.js';
import { RadeonProvider, type RadeonPressureSnapshot } from '../../providers/radeon.js';
import {
  getOrderedFusionChain, resolveModelGroupCandidates, routePinnedModel, routeRequest,
  setExploreEnabled, setRoutingStrategy,
} from '../../services/router.js';
import { resetExtensionStateCache, setExtensionEnabled } from '../../services/extension-state.js';
import { clearCooldownsForKey, setCooldown } from '../../services/ratelimit.js';
import { PROVIDER_PREFERENCES_KEY } from '../../services/model-groups.js';
import * as scoring from '../../services/scoring.js';
import { addToActiveChain } from '../helpers/chain.js';

const AMD_MODEL = 'capacity-shared';
const SECOND_MODEL = 'capacity-secondary';
const originalKey = process.env.ENCRYPTION_KEY;
let amdId: number;
let secondId: number;
let alternateId: number;
let alternateKeyId: number;
let snapshot: RadeonPressureSnapshot;

function addModel(platform: string, modelId: string, priority: number): number {
  const db = getDb();
  const id = Number(db.prepare(`
    INSERT INTO models (platform, model_id, display_name, intelligence_rank, speed_rank,
      size_label, monthly_token_budget, enabled, supports_vision, supports_tools, context_window)
    VALUES (?, ?, ?, 1, 1, 'Large', '~50M', 1, 1, 1, 200000)
  `).run(platform, modelId, modelId).lastInsertRowid);
  db.prepare('INSERT INTO fallback_config (model_db_id, priority, enabled) VALUES (?, ?, 1)').run(id, priority);
  addToActiveChain(id, priority);
  return id;
}

function addKey(platform: string): number {
  const { encrypted, iv, authTag } = encrypt(`synthetic-${platform}-capacity-key`);
  return Number(getDb().prepare(`
    INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled)
    VALUES (?, 'capacity test', ?, ?, ?, 'healthy', 1)
  `).run(platform, encrypted, iv, authTag).lastInsertRowid);
}

function choose(preferred?: number, requireVision = false): number {
  const route = routeRequest(100, undefined, preferred, requireVision);
  route.release?.();
  return route.modelDbId;
}

beforeEach(() => {
  process.env.ENCRYPTION_KEY = '0'.repeat(64);
  initDb(':memory:');
  const db = getDb();
  db.exec('DELETE FROM profile_models; DELETE FROM fallback_config; DELETE FROM api_keys; DELETE FROM models; DELETE FROM requests;');
  resetExtensionStateCache();
  setExtensionEnabled('quota-aware-scoring', false);
  setRoutingStrategy('priority');
  setExploreEnabled(false);
  amdId = addModel('radeon', AMD_MODEL, 10);
  alternateId = addModel('google', AMD_MODEL, 20);
  secondId = addModel('radeon', SECOND_MODEL, 30);
  addKey('radeon');
  alternateKeyId = addKey('google');
  snapshot = {
    models: {
      [AMD_MODEL]: { state: 'full', utilization: 100 },
      [SECOND_MODEL]: { state: 'busy', utilization: 63.3 },
    },
    observedAt: new Date().toISOString(), freshness: 'fresh',
  };
  vi.spyOn(RadeonProvider.prototype, 'getModelPressure').mockImplementation(() => snapshot);
});

afterEach(() => {
  clearCooldownsForKey(alternateKeyId);
  vi.restoreAllMocks();
  resetExtensionStateCache();
  if (originalKey === undefined) delete process.env.ENCRYPTION_KEY;
  else process.env.ENCRYPTION_KEY = originalKey;
});

describe('AMD fleet capacity as soft automatic priority', () => {
  it('changes selection only when enabled and preserves saved chain membership and priority', () => {
    const db = getDb();
    const saved = db.prepare('SELECT * FROM profile_models ORDER BY profile_id, model_db_id').all();
    expect(choose()).toBe(amdId);
    setExtensionEnabled('amd-capacity-routing', true);
    expect(choose()).toBe(alternateId);
    setExtensionEnabled('amd-capacity-routing', false);
    expect(choose()).toBe(amdId);
    expect(db.prepare('SELECT * FROM profile_models ORDER BY profile_id, model_db_id').all()).toEqual(saved);
  });

  it.each(['balanced', 'smartest', 'fastest', 'reliable', 'custom'] as const)(
    'keeps full models last in the %s strategy', strategy => {
      setExtensionEnabled('amd-capacity-routing', true);
      setRoutingStrategy(strategy);
      const ids = getOrderedFusionChain(100).map(row => row.modelDbId);
      expect(ids.at(-1)).toBe(amdId);
      expect(new Set(ids)).toEqual(new Set([amdId, alternateId, secondId]));
      expect(choose()).not.toBe(amdId);
    },
  );

  it.each(['stale', 'unknown'] as const)('makes %s readings neutral rather than unavailable', freshness => {
    setExtensionEnabled('amd-capacity-routing', true);
    snapshot = { ...snapshot, freshness };
    expect(choose()).toBe(amdId);
  });

  it('keeps an unreported model neutral and does not penalise the same model on another provider', () => {
    setExtensionEnabled('amd-capacity-routing', true);
    expect(choose()).toBe(alternateId);
    snapshot = { ...snapshot, models: { [SECOND_MODEL]: { state: 'busy', utilization: 63.3 } } };
    expect(choose()).toBe(amdId);
  });

  it('retains the existing order when all remaining routes are full', () => {
    setExtensionEnabled('amd-capacity-routing', true);
    getDb().prepare("UPDATE api_keys SET enabled = 0 WHERE platform = 'google'").run();
    snapshot = { ...snapshot, models: {
      [AMD_MODEL]: { state: 'full', utilization: 100 },
      [SECOND_MODEL]: { state: 'full', utilization: 100 },
    } };
    expect(choose()).toBe(amdId);
  });

  it('uses a full backend as last resort when the non-full alternatives cannot serve', () => {
    setExtensionEnabled('amd-capacity-routing', true);
    setCooldown('google', AMD_MODEL, alternateKeyId, 60_000);
    getDb().prepare('UPDATE models SET enabled = 0 WHERE id = ?').run(secondId);
    expect(choose()).toBe(amdId);
  });

  it('cannot make a scoped-out alternative eligible or auto-enable a disabled model', () => {
    setExtensionEnabled('amd-capacity-routing', true);
    getDb().prepare('UPDATE api_keys SET model_scope_json = ? WHERE id = ?')
      .run(JSON.stringify(['different-model']), alternateKeyId);
    getDb().prepare('UPDATE models SET enabled = 0 WHERE id = ?').run(secondId);
    expect(choose()).toBe(amdId);
  });

  it('keeps capability gates authoritative even when an alternative is not full', () => {
    setExtensionEnabled('amd-capacity-routing', true);
    getDb().prepare('UPDATE models SET supports_vision = 0 WHERE id IN (?, ?)').run(alternateId, secondId);
    expect(choose(undefined, true)).toBe(amdId);
  });

  it('keeps full models behind alternatives that still fit the advertised context window', () => {
    setExtensionEnabled('amd-capacity-routing', true);
    getDb().prepare('UPDATE models SET context_window = 110 WHERE id = ?').run(alternateId);
    getDb().prepare('UPDATE models SET enabled = 0 WHERE id = ?').run(secondId);
    expect(choose()).toBe(alternateId);
  });

  it('preserves explicit model selection even while automatic routing prefers an alternative', () => {
    setExtensionEnabled('amd-capacity-routing', true);
    expect(choose()).toBe(alternateId);
    expect(choose(amdId)).toBe(amdId);
    const pinned = routePinnedModel(amdId, 100);
    expect(pinned?.modelDbId).toBe(amdId);
    pinned?.release?.();
  });

  it('applies pressure to unified members without overriding exact-match tiers', () => {
    setExtensionEnabled('amd-capacity-routing', true);
    expect(resolveModelGroupCandidates([amdId, alternateId]).map(row => row.model_db_id))
      .toEqual([alternateId, amdId]);
    expect(resolveModelGroupCandidates([amdId, alternateId], new Set([alternateId]))
      .map(row => row.model_db_id)).toEqual([amdId, alternateId]);
  });

  it('overrides soft provider preference, not the identity of the requested unified model', () => {
    setSetting(PROVIDER_PREFERENCES_KEY, JSON.stringify({
      version: 1,
      groups: { 'capacity-shared': { mode: 'preferred', memberOrder: [`radeon:${AMD_MODEL}`, `google:${AMD_MODEL}`] } },
    }));
    expect(resolveModelGroupCandidates([amdId, alternateId])[0].model_db_id).toBe(amdId);
    setExtensionEnabled('amd-capacity-routing', true);
    const members = resolveModelGroupCandidates([amdId, alternateId]);
    const selected = routeRequest(100, undefined, undefined, false, false, undefined, members);
    expect(selected.modelDbId).toBe(alternateId);
    selected.release?.();
  });

  it('does not let exploration promote a full backend ahead of a non-full choice', () => {
    setExtensionEnabled('amd-capacity-routing', true);
    setRoutingStrategy('balanced');
    setExploreEnabled(true);
    vi.spyOn(scoring, 'sampleBeta').mockReturnValue(0.5);
    vi.spyOn(Math, 'random').mockReturnValueOnce(0.01).mockReturnValue(0.99);
    expect(choose()).not.toBe(amdId);
  });
});
