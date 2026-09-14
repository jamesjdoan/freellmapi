import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { initDb, getDb } from '../../db/index.js';
import { modelRetirementSignal } from '../../lib/error-classify.js';
import {
  noteModelRetirementSignal,
  resetModelRetirementObservations,
  RETIREMENT_CONFIRMATIONS_REQUIRED,
} from '../../services/model-retirement.js';
import {
  getCatalogModelTombstone,
  recordCatalogModelTombstone,
  clearCatalogModelTombstone,
  retireUpstreamEolCatalogModel,
  serializeChainMembership,
  reinstateUpstreamRetiredCatalogModel,
  upsertModelOverrides,
} from '../../services/model-state.js';
import { applyCatalog } from '../../services/catalog-sync.js';

// #634: NVIDIA retires a model upstream ("has reached its end of life"), and
// every subsequent request burns a fallback slot on the corpse because nothing
// persisted the 404/410. These tests lock the two halves of the fix: a
// conservative end-of-life CLASSIFIER (transient 404s must never match), and a
// corroboration threshold before the model is actually auto-disabled.

const PLATFORM = 'groq';
const MODEL_ID = 'eol-test-model';

beforeAll(() => {
  process.env.ENCRYPTION_KEY = '0'.repeat(64);
  initDb(':memory:');
});

function seedModel(modelId = MODEL_ID): number {
  const db = getDb();
  db.prepare(`
    INSERT INTO models (platform, model_id, display_name, intelligence_rank, speed_rank, enabled, source)
    VALUES (?, ?, 'EOL Test', 50, 50, 1, 'catalog')
    ON CONFLICT(platform, model_id, endpoint_scope) DO UPDATE SET enabled = 1
  `).run(PLATFORM, modelId);
  const row = db.prepare('SELECT id FROM models WHERE platform = ? AND model_id = ?')
    .get(PLATFORM, modelId) as { id: number };
  db.prepare(`
    INSERT INTO fallback_config (model_db_id, priority, enabled)
    VALUES (?, 999, 1)
    ON CONFLICT(model_db_id) DO UPDATE SET enabled = 1
  `).run(row.id);
  return row.id;
}

function isRoutable(modelDbId: number): boolean {
  const row = getDb()
    .prepare('SELECT enabled FROM fallback_config WHERE model_db_id = ?')
    .get(modelDbId) as { enabled: number } | undefined;
  return row?.enabled === 1;
}

function routeFor(modelDbId: number, modelId = MODEL_ID) {
  return { modelDbId, platform: PLATFORM, modelId };
}

// The exact NVIDIA body from issue #634.
const NVIDIA_EOL = Object.assign(
  new Error(
    "NVIDIA NIM API error 410: The model 'minimaxai/minimax-m2.7' has reached its end of life "
    + 'on 2026-07-27T00:00:00Z and is no longer available.',
  ),
  { status: 410 },
);

// The transient shape from the same issue thread: a load balancer that cannot
// find the function for the account right now. Says nothing about the model.
const TRANSIENT_404 = Object.assign(
  new Error(
    "NVIDIA NIM API error 404: Function '23d4f03a-b8a6-4adb-a183-7daa083a09cc': Not found for account 'BDnmPUMI'",
  ),
  { status: 404 },
);

describe('modelRetirementSignal (conservative end-of-life detection — #634)', () => {
  it('treats an explicit 410 / end-of-life body as definitive', () => {
    expect(modelRetirementSignal(NVIDIA_EOL)).toBe('definitive');
    expect(modelRetirementSignal(Object.assign(new Error('Gone'), { status: 410 }))).toBe('definitive');
    expect(modelRetirementSignal(new Error('Ollama Cloud API error 410: Gone'))).toBe('definitive');
    // The wording alone is definitive even when the provider picks a 404.
    expect(modelRetirementSignal(Object.assign(
      new Error('API error 404: model has reached its end of life'),
      { status: 404 },
    ))).toBe('definitive');
  });

  // 'definitive' skips the corroboration gate and disables the model on ONE
  // response, so the phrase must not be load-bearing by itself: a rate-limit
  // or server-error body can quote a retirement notice (about this model or
  // another) without the model being gone.
  it('ignores an end-of-life phrase when the status does not agree the model is gone', () => {
    expect(modelRetirementSignal(Object.assign(
      new Error('Rate limit exceeded. Note: llama-3.1-8b reaches end of life on 2026-12-01'),
      { status: 429 },
    ))).toBeNull();
    expect(modelRetirementSignal(Object.assign(
      new Error('Internal server error: upstream pool has been decommissioned'),
      { status: 500 },
    ))).toBeNull();
    expect(modelRetirementSignal(Object.assign(
      new Error('Bad request: the v1 endpoint has been sunset, use v2'),
      { status: 400 },
    ))).toBeNull();
  });

  it('still fires when a gone-shaped status carries the phrase', () => {
    expect(modelRetirementSignal(Object.assign(
      new Error('API error 410: this model has been retired'),
      { status: 410 },
    ))).toBe('definitive');
    expect(modelRetirementSignal(Object.assign(
      new Error('API error 404: this model has been decommissioned'),
      { status: 404 },
    ))).toBe('definitive');
  });

  it('treats a 404 that clearly says the model is gone as probable (needs corroboration)', () => {
    expect(modelRetirementSignal(Object.assign(
      new Error('OpenRouter API error 404: this model is no longer available'),
      { status: 404 },
    ))).toBe('probable');
    expect(modelRetirementSignal(Object.assign(
      new Error('Groq API error 404: model has been removed'),
      { status: 404 },
    ))).toBe('probable');
  });

  it('never fires on transient 404s, empty not-found bodies, or unrelated failures', () => {
    expect(modelRetirementSignal(TRANSIENT_404)).toBeNull();
    expect(modelRetirementSignal(new Error('OpenRouter API error 404: Provider returned error'))).toBeNull();
    expect(modelRetirementSignal(new Error('Model not found'))).toBeNull();
    // OpenRouter says this while a model is merely unserved right now.
    expect(modelRetirementSignal(new Error('No endpoints found for openrouter/minimax/minimax-m2.5:free'))).toBeNull();
    expect(modelRetirementSignal(new Error('429 Too Many Requests'))).toBeNull();
    expect(modelRetirementSignal(new Error('503 Service Unavailable'))).toBeNull();
    // A digit run that merely contains 410 is not a 410.
    expect(modelRetirementSignal(new Error('Groq API error 400: max_tokens 41000 exceeds 32768'))).toBeNull();
  });
});

describe('noteModelRetirementSignal (auto-disable with a reason — #634)', () => {
  beforeEach(() => {
    resetModelRetirementObservations();
    getDb().prepare("DELETE FROM catalog_model_tombstones WHERE model_id LIKE 'eol-test-%'").run();
  });

  it('auto-disables the model on a single explicit 410 end-of-life response', () => {
    const id = seedModel();
    expect(noteModelRetirementSignal(routeFor(id), NVIDIA_EOL, {})).toBe(true);
    expect(isRoutable(id)).toBe(false);

    const tombstone = getCatalogModelTombstone(getDb(), 'chat', PLATFORM, MODEL_ID);
    expect(tombstone?.source).toBe('upstream_eol');
    expect(tombstone?.reason).toContain('end of life');
  });

  it('leaves a transient 404 alone no matter how often it repeats', () => {
    const id = seedModel();
    for (let i = 0; i < 5; i++) {
      expect(noteModelRetirementSignal(routeFor(id), TRANSIENT_404, {})).toBe(false);
    }
    expect(isRoutable(id)).toBe(true);
    expect(getCatalogModelTombstone(getDb(), 'chat', PLATFORM, MODEL_ID)).toBeUndefined();
  });

  it('requires corroboration from distinct requests before disabling on a probable 404', () => {
    const id = seedModel();
    const err = Object.assign(new Error('API error 404: this model is no longer available'), { status: 404 });

    expect(RETIREMENT_CONFIRMATIONS_REQUIRED).toBeGreaterThanOrEqual(2);
    expect(noteModelRetirementSignal(routeFor(id), err, {})).toBe(false);
    expect(isRoutable(id)).toBe(true);
    expect(noteModelRetirementSignal(routeFor(id), err, {})).toBe(true);
    expect(isRoutable(id)).toBe(false);
  });

  it('does not let one flaky request corroborate itself across sibling keys', () => {
    const id = seedModel();
    const err = Object.assign(new Error('API error 404: this model is no longer available'), { status: 404 });
    const oneRequest = {};

    for (let i = 0; i < 4; i++) {
      expect(noteModelRetirementSignal(routeFor(id), err, oneRequest)).toBe(false);
    }
    expect(isRoutable(id)).toBe(true);
  });

  it('never touches user-added models (they are not catalog state)', () => {
    const db = getDb();
    db.prepare(`
      INSERT INTO models (platform, model_id, display_name, intelligence_rank, speed_rank, enabled, source)
      VALUES ('custom', 'eol-test-custom', 'Custom EOL', 50, 50, 1, 'user')
      ON CONFLICT(platform, model_id, endpoint_scope) DO UPDATE SET enabled = 1
    `).run();
    const row = db.prepare("SELECT id FROM models WHERE platform = 'custom' AND model_id = 'eol-test-custom'")
      .get() as { id: number };
    db.prepare(`
      INSERT INTO fallback_config (model_db_id, priority, enabled) VALUES (?, 998, 1)
      ON CONFLICT(model_db_id) DO UPDATE SET enabled = 1
    `).run(row.id);

    expect(noteModelRetirementSignal(
      { modelDbId: row.id, platform: 'custom', modelId: 'eol-test-custom' },
      NVIDIA_EOL,
      {},
    )).toBe(false);
    expect(isRoutable(row.id)).toBe(true);
  });
});

describe('catalog sync vs. upstream retirement (#634)', () => {
  function catalogWith(modelId: string, enabled: boolean) {
    return {
      version: '2099.01.01',
      generatedAt: new Date().toISOString(),
      tier: 'live' as const,
      models: [{
        platform: PLATFORM,
        modelId,
        displayName: 'EOL Test',
        intelligenceRank: 50,
        speedRank: 50,
        sizeLabel: 'Medium',
        limits: { rpm: 30, rpd: 1000, tpm: 6000, tpd: null },
        monthlyTokenBudget: '~1M',
        contextWindow: 8192,
        enabled,
        supportsVision: false,
        supportsTools: true,
      }],
      quirks: [],
    } as unknown as Parameters<typeof applyCatalog>[1];
  }

  it('re-enables an auto-retired model when a later catalog still lists it', () => {
    resetModelRetirementObservations();
    const id = seedModel('eol-test-relisted');
    noteModelRetirementSignal(routeFor(id, 'eol-test-relisted'), NVIDIA_EOL, {});
    expect(isRoutable(id)).toBe(false);

    applyCatalog(getDb(), catalogWith('eol-test-relisted', true));

    expect(isRoutable(id)).toBe(true);
    expect(getCatalogModelTombstone(getDb(), 'chat', PLATFORM, 'eol-test-relisted')).toBeUndefined();
    expect(getDb().prepare('SELECT id FROM models WHERE platform = ? AND model_id = ?')
      .get(PLATFORM, 'eol-test-relisted')).toBeDefined();
  });

  it('still deletes models the USER tombstoned (unchanged behavior)', () => {
    seedModel('eol-test-user-deleted');
    recordCatalogModelTombstone(getDb(), 'chat', PLATFORM, 'eol-test-user-deleted');
    applyCatalog(getDb(), catalogWith('eol-test-user-deleted', true));
    expect(getDb().prepare('SELECT id FROM models WHERE platform = ? AND model_id = ?')
      .get(PLATFORM, 'eol-test-user-deleted')).toBeUndefined();
  });
});


// A model that comes back should come back to the chains it was serving. Before
// this, a relist returned the route to the catalogue and to nothing else: the
// row was enabled, no chain listed it, and someone had to re-curate it by hand
// — which is exactly how a proven route quietly stops being routed.
describe('an operator disable outranks a catalog listing', () => {
  // Live 2026-09-14: nvidia/deepseek-ai/deepseek-v4-pro-0813 answers every
  // inference call with 410 "reached its end of life" and is still listed in
  // the catalog. It retired and was reinstated THREE times in one day, each
  // reinstatement putting it back into Apex, Coding and Frontier — after it had
  // been disabled by hand specifically so a sync could not restore it.
  beforeEach(() => {
    const db = getDb();
    db.prepare('DELETE FROM catalog_model_tombstones').run();
    db.prepare('DELETE FROM model_overrides').run();
  });

  it('refuses to reinstate a route the operator switched off', () => {
    const id = seedModel('eol-but-listed');
    recordCatalogModelTombstone(getDb(), 'chat', PLATFORM, 'eol-but-listed', { source: 'upstream_eol' });
    upsertModelOverrides(getDb(), PLATFORM, 'eol-but-listed', { enabled: false });

    expect(reinstateUpstreamRetiredCatalogModel(getDb(), PLATFORM, 'eol-but-listed')).toBe(false);
    // The tombstone stays, so no 'relisted' event is fabricated either.
    expect(getCatalogModelTombstone(getDb(), 'chat', PLATFORM, 'eol-but-listed')).toBeDefined();
    expect(id).toBeGreaterThan(0);
  });

  it('accepts a disable stored as 0, not only as false', () => {
    // The overrides column is free-form JSON: the API writes a boolean, and the
    // scripts that disabled the EOL routes on this install wrote 0. A guard
    // that only recognised `false` would have let every one of them back in.
    seedModel('eol-zero-override');
    recordCatalogModelTombstone(getDb(), 'chat', PLATFORM, 'eol-zero-override', { source: 'upstream_eol' });
    getDb().prepare(`
      INSERT INTO model_overrides (platform, model_id, overrides_json)
      VALUES (?, ?, '{"enabled":0}')
      ON CONFLICT(platform, model_id) DO UPDATE SET overrides_json = excluded.overrides_json
    `).run(PLATFORM, 'eol-zero-override');

    expect(reinstateUpstreamRetiredCatalogModel(getDb(), PLATFORM, 'eol-zero-override')).toBe(false);
  });

  it('still reinstates a route nobody disabled', () => {
    // The rule this must not break: a catalog that still lists a model IS newer
    // evidence than one 404, absent an operator saying otherwise.
    seedModel('eol-no-override');
    recordCatalogModelTombstone(getDb(), 'chat', PLATFORM, 'eol-no-override', { source: 'upstream_eol' });
    expect(reinstateUpstreamRetiredCatalogModel(getDb(), PLATFORM, 'eol-no-override')).toBe(true);
    expect(getCatalogModelTombstone(getDb(), 'chat', PLATFORM, 'eol-no-override')).toBeUndefined();
  });
});

describe('a relisted model returns to the chains it was serving', () => {
  beforeEach(() => {
    const db = getDb();
    db.prepare('DELETE FROM catalog_model_tombstones').run();
    db.prepare('DELETE FROM profile_models').run();
    db.prepare("DELETE FROM profiles WHERE name IN ('TestApex', 'TestFast', 'TestGone')").run();
  });

  function seedChain(name: string, modelDbId: number, priority: number, enabled = 1): number {
    const db = getDb();
    db.prepare("INSERT INTO profiles (name, emoji, color, type) VALUES (?, '#', '#000', 'custom')").run(name);
    const p = db.prepare('SELECT id FROM profiles WHERE name = ?').get(name) as { id: number };
    db.prepare('INSERT INTO profile_models (profile_id, model_db_id, priority, enabled) VALUES (?, ?, ?, ?)')
      .run(p.id, modelDbId, priority, enabled);
    return p.id;
  }

  const membership = (profileId: number, modelDbId: number) =>
    getDb().prepare('SELECT priority, enabled FROM profile_models WHERE profile_id = ? AND model_db_id = ?')
      .get(profileId, modelDbId) as { priority: number; enabled: number } | undefined;

  it('restores it at the position it held, not at the end', () => {
    const id = seedModel('relist-position');
    const apex = seedChain('TestApex', id, 3);

    recordCatalogModelTombstone(getDb(), 'chat', PLATFORM, 'relist-position', {
      source: 'upstream_eol',
      chains: serializeChainMembership(getDb(), id),
    });
    getDb().prepare('UPDATE profile_models SET enabled = 0 WHERE model_db_id = ?').run(id);
    expect(membership(apex, id)).toMatchObject({ enabled: 0 });

    clearCatalogModelTombstone(getDb(), 'chat', PLATFORM, 'relist-position');
    // Position 3, not appended: a chain is an order, and coming back last is a
    // different route from the one that left.
    expect(membership(apex, id)).toMatchObject({ enabled: 1, priority: 3 });
  });

  it('does not resurrect a chain the operator had already removed it from', () => {
    // The distinction the recorded membership exists for. A blanket
    // `UPDATE profile_models SET enabled = 1` restored both rows and silently
    // put the model back somewhere a person had taken it out of.
    const id = seedModel('relist-respect');
    const apex = seedChain('TestApex', id, 1);
    const fast = seedChain('TestFast', id, 2, 0);   // switched off BEFORE the retirement

    recordCatalogModelTombstone(getDb(), 'chat', PLATFORM, 'relist-respect', {
      source: 'upstream_eol',
      chains: serializeChainMembership(getDb(), id),
    });
    getDb().prepare('UPDATE profile_models SET enabled = 0 WHERE model_db_id = ?').run(id);
    clearCatalogModelTombstone(getDb(), 'chat', PLATFORM, 'relist-respect');

    expect(membership(apex, id)).toMatchObject({ enabled: 1 });
    expect(membership(fast, id)).toMatchObject({ enabled: 0 });
  });

  it('survives a chain deleted while the model was gone', () => {
    // The model comes back to the chains that still exist; a deleted chain is
    // not recreated, and the relist must not fail because of it.
    const id = seedModel('relist-missing-chain');
    const gone = seedChain('TestGone', id, 1);
    recordCatalogModelTombstone(getDb(), 'chat', PLATFORM, 'relist-missing-chain', {
      source: 'upstream_eol',
      chains: serializeChainMembership(getDb(), id),
    });
    getDb().prepare('DELETE FROM profile_models WHERE profile_id = ?').run(gone);
    getDb().prepare('DELETE FROM profiles WHERE id = ?').run(gone);

    expect(() => clearCatalogModelTombstone(getDb(), 'chat', PLATFORM, 'relist-missing-chain')).not.toThrow();
    expect(getCatalogModelTombstone(getDb(), 'chat', PLATFORM, 'relist-missing-chain')).toBeUndefined();
  });

  it('records the relist even when it was serving no chain at all', () => {
    const id = seedModel('relist-no-chains');
    recordCatalogModelTombstone(getDb(), 'chat', PLATFORM, 'relist-no-chains', {
      source: 'upstream_eol',
      chains: serializeChainMembership(getDb(), id),   // null: no memberships
    });
    clearCatalogModelTombstone(getDb(), 'chat', PLATFORM, 'relist-no-chains');
    expect(getCatalogModelTombstone(getDb(), 'chat', PLATFORM, 'relist-no-chains')).toBeUndefined();
  });
});
