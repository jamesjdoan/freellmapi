import { describe, it, expect, beforeAll } from 'vitest';
import type { Express } from 'express';
import { createApp } from '../../app.js';
import { initDb, getDb, getUnifiedApiKey } from '../../db/index.js';
import { mintDashboardToken, isGatedApiPath } from '../helpers/auth.js';
import {
  noteModelRetirementSignal,
  resetModelRetirementObservations,
} from '../../services/model-retirement.js';
import { getCatalogModelTombstone, recordCatalogModelTombstone } from '../../services/model-state.js';
import { applyCatalog } from '../../services/catalog-sync.js';

// A provider that retires a model keeps listing it in /models. Observed twice on
// this deployment: google/gemini-2.5-flash answers 404 "not available to new
// users" and nvidia/openai/gpt-oss-120b answers 410 "end of life", while both
// providers still advertise both models in their catalogue.
//
// So "the catalogue still lists it, enabled" is NOT newer evidence than the
// provider's own refusal — it is the same stale evidence, republished every
// refresh. Reinstating on that signal reverted the auto-retirement on every
// catalogue sync and on every container boot, which is why these two models had
// to be held out of routing by hand with `models.enabled = 0`.
//
// The rule these tests pin: an upstream retirement is lifted by an explicit act
// of the operator, and by nothing else. That is the affordance
// retireCatalogModelUpstream already promises in its own comment ("the user can
// flip it back on if they disagree") but never actually wired up.

let dashToken = '';
const PLATFORM = 'groq';

async function request(app: Express, method: string, path: string, body?: unknown) {
  const server = app.listen(0, '127.0.0.1');
  if (!server.listening) await new Promise<void>(resolve => server.once('listening', () => resolve()));
  const addr = server.address() as { port: number };
  const res = await fetch(`http://127.0.0.1:${addr.port}${path}`, {
    method,
    headers: {
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...(isGatedApiPath(path) ? { Authorization: `Bearer ${dashToken}` } : {}),
      ...(path.startsWith('/v1/') ? { Authorization: `Bearer ${getUnifiedApiKey()}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => null);
  server.close();
  return { status: res.status, body: data };
}

const EOL_410 = Object.assign(
  new Error(
    "NVIDIA NIM API error 410: The model 'openai/gpt-oss-120b' has reached its end of life "
    + 'on 2026-07-27T00:00:00Z and is no longer available.',
  ),
  { status: 410 },
);

let app: Express;

beforeAll(() => {
  process.env.ENCRYPTION_KEY = '0'.repeat(64);
  initDb(':memory:');
  app = createApp();
  dashToken = mintDashboardToken();
});

function seedModel(modelId: string): number {
  const db = getDb();
  db.prepare(`
    INSERT INTO models (platform, model_id, display_name, intelligence_rank, speed_rank, enabled, source)
    VALUES (?, ?, 'EOL Reinstatement Test', 50, 50, 1, 'catalog')
    ON CONFLICT(platform, model_id, endpoint_scope) DO UPDATE SET enabled = 1
  `).run(PLATFORM, modelId);
  const row = db.prepare('SELECT id FROM models WHERE platform = ? AND model_id = ?')
    .get(PLATFORM, modelId) as { id: number };
  db.prepare(`
    INSERT INTO fallback_config (model_db_id, priority, enabled)
    VALUES (?, 998, 1)
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

function catalogWith(modelId: string, enabled: boolean) {
  return {
    version: '2099.01.01',
    generatedAt: new Date().toISOString(),
    tier: 'live' as const,
    models: [{
      platform: PLATFORM,
      modelId,
      displayName: 'EOL Reinstatement Test',
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

describe('an upstream retirement survives catalogue refresh', () => {
  it('does not lift the retirement when the catalogue still lists the model enabled', () => {
    resetModelRetirementObservations();
    const id = seedModel('eol-still-listed');
    noteModelRetirementSignal({ modelDbId: id, platform: PLATFORM, modelId: 'eol-still-listed' }, EOL_410, {});
    expect(isRoutable(id)).toBe(false);

    // The provider goes on advertising it. This is the case that reverted the
    // retirement on every sync.
    applyCatalog(getDb(), catalogWith('eol-still-listed', true));

    expect(isRoutable(id)).toBe(false);
    expect(getCatalogModelTombstone(getDb(), 'chat', PLATFORM, 'eol-still-listed')?.source).toBe('upstream_eol');
  });

  it('survives repeated refreshes, which is what a container reboot loop does', () => {
    resetModelRetirementObservations();
    const id = seedModel('eol-repeated');
    noteModelRetirementSignal({ modelDbId: id, platform: PLATFORM, modelId: 'eol-repeated' }, EOL_410, {});
    for (let i = 0; i < 3; i++) applyCatalog(getDb(), catalogWith('eol-repeated', true));
    expect(isRoutable(id)).toBe(false);
  });

  it('keeps the row so the dashboard can still show it as retired', () => {
    resetModelRetirementObservations();
    const id = seedModel('eol-visible');
    noteModelRetirementSignal({ modelDbId: id, platform: PLATFORM, modelId: 'eol-visible' }, EOL_410, {});
    applyCatalog(getDb(), catalogWith('eol-visible', true));

    // Retirement is a disable, never a delete: the operator has to be able to
    // see the model in order to disagree with the retirement.
    expect(getDb().prepare('SELECT id FROM models WHERE platform = ? AND model_id = ?')
      .get(PLATFORM, 'eol-visible')).toBeDefined();
    expect(id).toBeGreaterThan(0);
  });
});

describe('the operator can still lift a retirement explicitly', () => {
  it('clears the retirement when the operator re-enables the model from the dashboard', async () => {
    resetModelRetirementObservations();
    const id = seedModel('eol-operator-override');
    noteModelRetirementSignal({ modelDbId: id, platform: PLATFORM, modelId: 'eol-operator-override' }, EOL_410, {});
    expect(isRoutable(id)).toBe(false);

    const { status } = await request(app, 'PATCH', `/api/models/${id}`, { fallbackEnabled: true });
    expect(status).toBe(200);

    // Both halves: the model routes again, AND the retirement is gone, so the
    // next auto-retirement can fire cleanly instead of being suppressed by a
    // stale tombstone.
    expect(isRoutable(id)).toBe(true);
    expect(getCatalogModelTombstone(getDb(), 'chat', PLATFORM, 'eol-operator-override')).toBeUndefined();
  });

  it('leaves a user deletion alone — that tombstone means "keep it deleted"', () => {
    const id = seedModel('eol-user-deleted');
    recordCatalogModelTombstone(getDb(), 'chat', PLATFORM, 'eol-user-deleted');
    expect(id).toBeGreaterThan(0);
    applyCatalog(getDb(), catalogWith('eol-user-deleted', true));
    expect(getDb().prepare('SELECT id FROM models WHERE platform = ? AND model_id = ?')
      .get(PLATFORM, 'eol-user-deleted')).toBeUndefined();
  });
});

// Pressing "Keep retired" used to be the end of the trail: the disagreement
// left the notice and the only remaining sign was a badge on the model's own
// table row, behind the Hide-disabled filter. A settled decision has to stay
// reviewable, and reversible.
describe('decisions already taken stay reviewable', () => {
  it('moves an acknowledged retirement out of the notice and into the settled list', async () => {
    resetModelRetirementObservations();
    const id = seedModel('eol-settled');
    noteModelRetirementSignal({ modelDbId: id, platform: PLATFORM, modelId: 'eol-settled' }, EOL_410, {});
    applyCatalog(getDb(), catalogWith('eol-settled', true));

    const raised = await request(app, 'GET', '/api/models/retirements');
    expect(raised.body.retirements.some((r: { modelId: string }) => r.modelId === 'eol-settled')).toBe(true);

    const kept = await request(app, 'POST', '/api/models/retirements/ignore', {
      platform: PLATFORM, modelId: 'eol-settled',
    });
    expect(kept.status).toBe(200);

    const settled = await request(app, 'GET', '/api/models/retirements');
    expect(settled.body.retirements.some((r: { modelId: string }) => r.modelId === 'eol-settled')).toBe(false);
    const entry = settled.body.acknowledged.find((r: { modelId: string }) => r.modelId === 'eol-settled');
    expect(entry).toBeDefined();
    expect(entry.acknowledgedAt).not.toBeNull();
    // Settling the argument must not route to a model the provider refuses.
    expect(isRoutable(id)).toBe(false);
  });

  it('reopens the question on undo, without touching the retirement', async () => {
    resetModelRetirementObservations();
    const id = seedModel('eol-reopened');
    noteModelRetirementSignal({ modelDbId: id, platform: PLATFORM, modelId: 'eol-reopened' }, EOL_410, {});
    applyCatalog(getDb(), catalogWith('eol-reopened', true));
    await request(app, 'POST', '/api/models/retirements/ignore', { platform: PLATFORM, modelId: 'eol-reopened' });

    const undone = await request(app, 'POST', '/api/models/retirements/unignore', {
      platform: PLATFORM, modelId: 'eol-reopened',
    });
    expect(undone.status).toBe(200);

    const reopened = await request(app, 'GET', '/api/models/retirements');
    expect(reopened.body.retirements.some((r: { modelId: string }) => r.modelId === 'eol-reopened')).toBe(true);
    expect(reopened.body.acknowledged.some((r: { modelId: string }) => r.modelId === 'eol-reopened')).toBe(false);
    expect(isRoutable(id)).toBe(false);
    expect(getCatalogModelTombstone(getDb(), 'chat', PLATFORM, 'eol-reopened')?.source).toBe('upstream_eol');
  });

  it('404s when there is no upstream retirement to settle', async () => {
    const { status } = await request(app, 'POST', '/api/models/retirements/ignore', {
      platform: PLATFORM, modelId: 'eol-never-retired',
    });
    expect(status).toBe(404);
  });
});
