import { describe, it, expect, beforeEach } from 'vitest';
import type { Express } from 'express';
import { createApp } from '../../app.js';
import { initDb, getDb } from '../../db/index.js';
import {
  getAdjustedScores,
  getComparePayload,
  getGroupedCompare,
  setBenchmarkEntry,
  setManualLink,
} from '../../services/analysis.js';
import { setUnifyOverrides } from '../../services/model-groups.js';
import { mintDashboardToken } from '../helpers/auth.js';

// ADR ARCH-20261018: an operator can type a score into a cell Artificial
// Analysis left empty, and must say where it came from. A measurement always
// wins; a typed score fills a gap, reaches routing, and never masquerades as a
// measurement.

function addModel(platform: string, modelId: string, displayName: string) {
  getDb().prepare(`
    INSERT INTO models (platform, model_id, display_name, intelligence_rank, speed_rank, size_label,
                        monthly_token_budget, enabled)
    VALUES (?, ?, ?, 50, 50, 'Large', '', 1)
  `).run(platform, modelId, displayName);
}

function addAa(slug: string, scores: { intelligence: number | null; coding: number | null; agentic: number | null }) {
  getDb().prepare(`
    INSERT INTO aa_model (slug, name, intelligence_index, coding_index, agentic_index, index_version)
    VALUES (?, ?, ?, ?, ?, 'v4.3')
  `).run(slug, slug, scores.intelligence, scores.coding, scores.agentic);
}

const row = (platform: string, modelId: string) =>
  getComparePayload().rows.find(r => r.platform === platform && r.modelId === modelId)!;

beforeEach(() => {
  process.env.ENCRYPTION_KEY = '0'.repeat(64);
  initDb(':memory:');
  const db = getDb();
  for (const t of ['profile_models', 'fallback_config', 'models', 'aa_model', 'aa_model_link', 'model_benchmark_entry']) {
    db.prepare(`DELETE FROM ${t}`).run();
  }
  setUnifyOverrides({ merges: [], splits: [] });
});

describe('resolving a score', () => {
  it('fills a gap AA left, with its provenance, and reaches routing', () => {
    addModel('mistral', 'ministral-8b', 'Ministral 8B');
    addAa('ministral-8b', { intelligence: 21.5, coding: null, agentic: null });
    setManualLink('mistral', 'ministral-8b', 'ministral-8b');
    setBenchmarkEntry([{ platform: 'mistral', modelId: 'ministral-8b' }], 'coding', 14.26, 'tested');

    const { scores } = row('mistral', 'ministral-8b');
    expect(scores.intelligence).toMatchObject({ value: 21.5, provenance: 'measured', editable: false, entry: null });
    expect(scores.coding).toMatchObject({ value: 14.3, provenance: 'tested', editable: true });
    expect(scores.agentic).toMatchObject({ value: null, provenance: null, editable: true });

    expect(getAdjustedScores().get('mistral:ministral-8b')).toMatchObject({
      intelligence: 21.5, coding: 14.3, agentic: null,
      provenance: { intelligence: 'measured', coding: 'tested', agentic: null },
    });
  });

  it('scores a route AA has never heard of, for routing as well as display', () => {
    addModel('custom', 'local-llama', 'Local Llama');
    setBenchmarkEntry([{ platform: 'custom', modelId: 'local-llama' }], 'intelligence', 18, 'approximated');

    expect(row('custom', 'local-llama').analysis).toBeNull();
    expect(row('custom', 'local-llama').scores.intelligence).toMatchObject({ value: 18, provenance: 'approximated' });
    expect(getAdjustedScores().get('custom:local-llama')).toMatchObject({
      intelligence: 18, source: null, name: null, provenance: { intelligence: 'approximated', coding: null },
    });
  });

  it('lets a measurement take over and keeps the typed score as superseded', () => {
    addModel('groq', 'qwen3', 'Qwen3');
    setBenchmarkEntry([{ platform: 'groq', modelId: 'qwen3' }], 'agentic', 30, 'family');
    // AA publishes the metric later.
    addAa('qwen3', { intelligence: 40, coding: 35, agentic: 22 });
    setManualLink('groq', 'qwen3', 'qwen3');

    expect(row('groq', 'qwen3').scores.agentic).toEqual({
      value: 22, provenance: 'measured', editable: false,
      entry: { value: 30, provenance: 'family', enteredAt: expect.any(String), superseded: true },
    });
    expect(getAdjustedScores().get('groq:qwen3')?.agentic).toBe(22);
  });

  it('reads a proxy\'s borrowed score as related family, and lets a typed score beat it', () => {
    addModel('nvidia', 'nemo-x', 'Nemo X');
    addAa('nemo-base', { intelligence: 30, coding: 25, agentic: 20 });
    setManualLink('nvidia', 'nemo-x', 'nemo-base', undefined, 'proxy');
    setBenchmarkEntry([{ platform: 'nvidia', modelId: 'nemo-x' }], 'coding', 28, 'tested');

    const { scores } = row('nvidia', 'nemo-x');
    expect(scores.intelligence).toMatchObject({ value: 30, provenance: 'family', editable: true });
    expect(scores.coding).toMatchObject({ value: 28, provenance: 'tested' });
    expect(getAdjustedScores().get('nvidia:nemo-x')?.provenance.intelligence).toBe('family');
  });

  it('gives a group the strongest member evidence, and stays editable while any member is', () => {
    addModel('groq', 'gpt-oss-120b', 'GPT-OSS 120B');
    addModel('nvidia', 'gpt-oss-120b', 'GPT-OSS 120B');
    setBenchmarkEntry([{ platform: 'groq', modelId: 'gpt-oss-120b' }], 'coding', 20, 'approximated');
    setBenchmarkEntry([{ platform: 'nvidia', modelId: 'gpt-oss-120b' }], 'coding', 24, 'tested');

    const group = getGroupedCompare().find(g => g.name.includes('GPT-OSS'))!;
    expect(group.members).toHaveLength(2);
    expect(group.scores.coding).toMatchObject({ value: 24, provenance: 'tested', editable: true });
    expect(group.scores.intelligence).toMatchObject({ value: null, editable: true });
  });
});

describe('PUT/DELETE /api/analysis/score', () => {
  let app: Express;
  let token: string;

  async function call(method: string, body: unknown) {
    const server = app.listen(0, '127.0.0.1');
    if (!server.listening) await new Promise<void>(resolve => server.once('listening', () => resolve()));
    const { port } = server.address() as { port: number };
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/analysis/score`, {
        method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      });
      return { status: res.status, body: await res.json() as { written?: number; removed?: number; error?: { message: string } } };
    } finally {
      server.close();
    }
  }

  beforeEach(() => {
    app = createApp();
    token = mintDashboardToken();
    addModel('zhipu', 'glm-x', 'GLM X');
  });

  const routes = [{ platform: 'zhipu', modelId: 'glm-x' }];

  it('refuses a score without its provenance, out of range, or for an unknown route', async () => {
    expect((await call('PUT', { routes, metric: 'coding', value: 20 })).status).toBe(400);
    expect((await call('PUT', { routes, metric: 'coding', value: 120, provenance: 'tested' })).status).toBe(400);
    expect((await call('PUT', { routes, metric: 'speed', value: 20, provenance: 'tested' })).status).toBe(400);
    expect((await call('PUT', { routes: [{ platform: 'zhipu', modelId: 'nope' }], metric: 'coding', value: 20, provenance: 'tested' })).status).toBe(404);
    expect(getDb().prepare('SELECT COUNT(*) n FROM model_benchmark_entry').get()).toEqual({ n: 0 });
  });

  it('refuses to type over a measurement', async () => {
    addAa('glm-x', { intelligence: 33, coding: 29, agentic: null });
    setManualLink('zhipu', 'glm-x', 'glm-x');
    const refused = await call('PUT', { routes, metric: 'coding', value: 40, provenance: 'tested' });
    expect(refused.status).toBe(409);
    expect(refused.body.error?.message).toContain('Already measured');
    // The unmeasured metric on the same route is still open.
    expect((await call('PUT', { routes, metric: 'agentic', value: 12, provenance: 'approximated' })).body.written).toBe(1);
  });

  it('writes, replaces and clears', async () => {
    expect((await call('PUT', { routes, metric: 'intelligence', value: 25, provenance: 'family' })).body.written).toBe(1);
    expect((await call('PUT', { routes, metric: 'intelligence', value: 27, provenance: 'tested' })).body.written).toBe(1);
    expect(row('zhipu', 'glm-x').scores.intelligence).toMatchObject({ value: 27, provenance: 'tested' });
    expect((await call('DELETE', { routes, metric: 'intelligence' })).body.removed).toBe(1);
    expect(row('zhipu', 'glm-x').scores.intelligence).toMatchObject({ value: null, provenance: null });
  });
});
