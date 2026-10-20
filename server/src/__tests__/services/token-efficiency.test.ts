import { describe, it, expect, beforeEach } from 'vitest';
import type { Express } from 'express';
import { createApp } from '../../app.js';
import { initDb, getDb } from '../../db/index.js';
import { getComparePayload, getGroupedCompare, setManualLink } from '../../services/analysis.js';
import {
  aaTokenEstimates,
  blendedPricePerMillion,
  countCompletedScenarios,
  deleteBenchResult,
  estimateTokensPerTask,
  loadBenchResults,
  resolveTokenEfficiency,
  saveBenchResult,
  tokenRangePerTask,
  screenTokensPerTask,
} from '../../services/token-efficiency.js';
import { setUnifyOverrides } from '../../services/model-groups.js';
import { mintDashboardToken } from '../helpers/auth.js';

// ADR ARCH-20261020: token efficiency is a stat of the model, shown wherever
// the other analysis numbers are. It comes from one of two sources and never
// from a blend of them:
//
//   - an AA ESTIMATE (a token range from AA's cost per task, all-output to
//     all-input price), which needs a published cost and a published price;
//   - a SCREEN MEASUREMENT from our own benchmark, imported by hand.
//
// The arithmetic and the import are the two things that can be wrong here, so
// they are what is under test.

function addModel(platform: string, modelId: string, displayName: string) {
  getDb().prepare(`
    INSERT INTO models (platform, model_id, display_name, intelligence_rank, speed_rank, size_label,
                        monthly_token_budget, enabled)
    VALUES (?, ?, ?, 50, 50, 'Large', '', 1)
  `).run(platform, modelId, displayName);
}

function addAa(slug: string, over: {
  costPerTask?: number | null;
  price1mInput?: number | null;
  price1mOutput?: number | null;
} = {}) {
  getDb().prepare(`
    INSERT INTO aa_model (slug, name, intelligence_index, coding_index, agentic_index,
                          index_cost_per_task, price_1m_input, price_1m_output, index_version)
    VALUES (?, ?, 30, 20, 10, ?, ?, ?, 'v4.3')
  `).run(
    slug,
    slug,
    over.costPerTask === undefined ? 1.1341 : over.costPerTask,
    over.price1mInput === undefined ? 3 : over.price1mInput,
    over.price1mOutput === undefined ? 1.5 : over.price1mOutput,
  );
}

/** A passport as the CLI writes it. */
function passport(over: {
  platform?: string;
  modelId?: string;
  promptTokens?: number;
  completionTokens?: number;
  reasoningTokens?: number;
  calls?: number;
  statuses?: Record<string, string>;
  startedAt?: string;
  benchVersion?: string;
} = {}) {
  const statuses = over.statuses ?? { A1: 'PASS', A2: 'PASS', C1: 'PASS' };
  return {
    run: {
      benchVersion: over.benchVersion ?? '1.0.0',
      config: {
        platform: over.platform ?? 'groq',
        modelId: over.modelId ?? 'openai/gpt-oss-20b',
        temperature: 0,
        seed: 7,
        reasoningEffort: 'low',
        budgetTokens: 12000,
        maxRuns: 3,
        screenOnly: false,
      },
      results: Object.fromEntries(Object.entries(statuses).map(([id, status]) => [id, { id, status }])),
      usage: {
        calls: over.calls ?? 3,
        failedCalls: 0,
        repeatRuns: 0,
        promptTokens: over.promptTokens ?? 900,
        completionTokens: over.completionTokens ?? 300,
        reasoningTokens: over.reasoningTokens ?? 100,
        estimated: false,
        throughput: [],
      },
      stoppedBy: null,
      plannedTokens: 1200,
      startedAt: over.startedAt ?? '2026-10-20T05:51:08.913Z',
    },
  };
}

beforeEach(() => {
  process.env.ENCRYPTION_KEY = '0'.repeat(64);
  initDb(':memory:');
  const db = getDb();
  for (const t of ['profile_models', 'fallback_config', 'models', 'aa_model', 'aa_model_link', 'model_benchmark_entry', 'model_bench_result']) {
    db.prepare(`DELETE FROM ${t}`).run();
  }
  setUnifyOverrides({ merges: [], splits: [] });
});

describe('the AA estimate', () => {
  it('divides the cost per task by the blended price', () => {
    // The ADR's own example: Mistral Large 4 costs $1.1341 for one AA task,
    // and at a $2.07/M blend that is about 549K tokens.
    expect(blendedPricePerMillion(2.26, 1.5)).toBeCloseTo(2.07, 6);
    expect(estimateTokensPerTask(1.1341, 2.26, 1.5)).toBeCloseTo(547_874, 0);
  });

  it('is nothing without a cost, without a price, or at a zero price', () => {
    expect(estimateTokensPerTask(null, 3, 1.5)).toBeNull();
    expect(estimateTokensPerTask(1.1341, null, 1.5)).toBeNull();
    expect(estimateTokensPerTask(1.1341, 3, null)).toBeNull();
    // A free model: a blended price of zero cannot divide anything.
    expect(estimateTokensPerTask(1.1341, 0, 0)).toBeNull();
    // A cost of zero says nothing about token volume either.
    expect(estimateTokensPerTask(0, 3, 1.5)).toBeNull();
  });

  it('bounds the tokens between the dearer and the cheaper price', () => {
    // Mistral Large 4 on 2026-10-20: $1.1341 per task, $1.36 in / $4.18 out.
    // All at the output price is the fewest tokens, all at input the most.
    const range = tokenRangePerTask(1.1341, 1.36, 4.18)!;
    expect(range.low).toBeCloseTo(271_316, 0);
    expect(range.high).toBeCloseTo(833_897, 0);
    // The 3:1 sort value sits inside the range it is the middle of.
    const mid = estimateTokensPerTask(1.1341, 1.36, 4.18)!;
    expect(mid).toBeGreaterThan(range.low);
    expect(mid).toBeLessThan(range.high);
  });

  it('has no range without a cost, a price, or a non-zero price', () => {
    expect(tokenRangePerTask(null, 1, 1)).toBeNull();
    expect(tokenRangePerTask(1, null, 1)).toBeNull();
    expect(tokenRangePerTask(1, 0, 0)).toBeNull();
    // One free side bounds nothing above: the range collapses to its floor
    // rather than reaching infinity.
    expect(tokenRangePerTask(1, 0, 2)).toEqual({ low: 500_000, high: 500_000 });
  });

  it('carries an estimate for every priced AA model and none for the rest', () => {
    addAa('priced', { costPerTask: 1, price1mInput: 1, price1mOutput: 4 });
    addAa('unpriced', { costPerTask: null, price1mInput: 1, price1mOutput: 1 });

    const estimates = aaTokenEstimates(getDb());
    expect(estimates.get('priced')).toMatchObject({ low: 250_000, high: 1_000_000 });
    expect(estimates.get('unpriced')).toBeUndefined();
  });

  it('reaches a route through its benchmark link', () => {
    addModel('groq', 'openai/gpt-oss-20b', 'GPT-OSS 20B');
    addAa('gpt-oss-20b', { costPerTask: 1.1341, price1mInput: 2.26, price1mOutput: 1.5 });
    setManualLink('groq', 'openai/gpt-oss-20b', 'gpt-oss-20b');

    const row = getComparePayload().rows.find(r => r.modelId === 'openai/gpt-oss-20b')!;
    expect(row.tokenEfficiency).toMatchObject({ source: 'aa' });
    // $2.26 in is the dearer side here, so it sets the floor.
    expect(row.tokenEfficiency?.tokensLow).toBeCloseTo(501_814, 0);
    expect(row.tokenEfficiency?.tokensHigh).toBeCloseTo(756_067, 0);
    expect(row.tokenEfficiency?.tokensPerTask).toBeCloseTo(547_874, 0);
  });
});

describe('the screen measurement', () => {
  it('divides the tokens by the scenarios that reached a verdict', () => {
    const result = {
      platform: 'groq', modelId: 'm', benchVersion: '1.0.0',
      promptTokens: 900, completionTokens: 300, reasoningTokens: 100,
      calls: 3, scenariosCompleted: 4, reasoningEffort: 'low',
      runAt: '2026-10-20T00:00:00.000Z', importedAt: '2026-10-20 00:00:00',
    };
    // 900 prompt + 300 completion, over 4 scenarios. The reasoning tokens are
    // already inside the completion count, so they are not added again.
    expect(screenTokensPerTask(result)).toBe(300);
  });

  it('counts PASS and FAIL as completed, and nothing else', () => {
    expect(countCompletedScenarios({
      A1: { status: 'PASS' }, A2: { status: 'FAIL' }, A3: { status: 'INCONCLUSIVE' },
      C1: { status: 'NOT_TESTED' }, C2: { status: 'UNSUPPORTED' },
    })).toBe(2);
  });

  it('is a single measured count, not a range', () => {
    const screen = {
      platform: 'groq', modelId: 'm', benchVersion: '1.0.0',
      promptTokens: 900, completionTokens: 300, reasoningTokens: 100,
      calls: 3, scenariosCompleted: 3, reasoningEffort: 'low',
      runAt: '2026-10-20T00:00:00.000Z', importedAt: '2026-10-20 00:00:00',
    };
    const resolved = resolveTokenEfficiency(undefined, screen);
    expect(resolved).toMatchObject({ source: 'screen', tokensLow: null, tokensHigh: null, tokensPerTask: 400 });
  });

  it('loses to the AA estimate where both exist', () => {
    const screen = {
      platform: 'groq', modelId: 'm', benchVersion: '1.0.0',
      promptTokens: 900, completionTokens: 300, reasoningTokens: 100,
      calls: 3, scenariosCompleted: 3, reasoningEffort: 'low',
      runAt: '2026-10-20T00:00:00.000Z', importedAt: '2026-10-20 00:00:00',
    };
    const aa = { tokensPerTask: 1000, low: 600, high: 1800 };
    expect(resolveTokenEfficiency(aa, screen)).toMatchObject({ source: 'aa', tokensLow: 600, tokensHigh: 1800 });
  });
});

describe('a logical model', () => {
  it('takes the AA estimate of any member, and the newest screen run otherwise', () => {
    addModel('groq', 'openai/gpt-oss-20b', 'GPT-OSS 20B (Groq)');
    addModel('nvidia', 'openai/gpt-oss-20b', 'GPT-OSS 20B (NV)');
    addAa('gpt-oss-20b', { costPerTask: 1, price1mInput: 1, price1mOutput: 1 });
    setManualLink('groq', 'openai/gpt-oss-20b', 'gpt-oss-20b');

    // Two screen results for the two routes, one older than the other.
    saveBenchResult({
      platform: 'nvidia', modelId: 'openai/gpt-oss-20b', benchVersion: '1.0.0',
      promptTokens: 100, completionTokens: 100, reasoningTokens: 0, calls: 1,
      scenariosCompleted: 2, reasoningEffort: null, runAt: '2026-10-01T00:00:00.000Z',
    });
    saveBenchResult({
      platform: 'groq', modelId: 'openai/gpt-oss-20b', benchVersion: '1.0.0',
      promptTokens: 300, completionTokens: 300, reasoningTokens: 0, calls: 1,
      scenariosCompleted: 2, reasoningEffort: null, runAt: '2026-10-19T00:00:00.000Z',
    });

    const group = getGroupedCompare().find(g => g.name.includes('GPT-OSS'))!;
    // The AA estimate wins: it is measured on a common workload.
    expect(group.tokenEfficiency).toMatchObject({ source: 'aa' });
  });

  it('takes the newest screen run when no member has an AA estimate', () => {
    addModel('groq', 'openai/gpt-oss-20b', 'GPT-OSS 20B (Groq)');
    addModel('nvidia', 'openai/gpt-oss-20b', 'GPT-OSS 20B (NV)');

    saveBenchResult({
      platform: 'nvidia', modelId: 'openai/gpt-oss-20b', benchVersion: '1.0.0',
      promptTokens: 100, completionTokens: 100, reasoningTokens: 0, calls: 1,
      scenariosCompleted: 2, reasoningEffort: null, runAt: '2026-10-01T00:00:00.000Z',
    });
    saveBenchResult({
      platform: 'groq', modelId: 'openai/gpt-oss-20b', benchVersion: '1.0.0',
      promptTokens: 300, completionTokens: 300, reasoningTokens: 0, calls: 1,
      scenariosCompleted: 2, reasoningEffort: null, runAt: '2026-10-19T00:00:00.000Z',
    });

    const group = getGroupedCompare().find(g => g.name.includes('GPT-OSS'))!;
    expect(group.tokenEfficiency).toMatchObject({ source: 'screen', tokensPerTask: 300 });
  });
});

describe('POST/DELETE /api/analysis/bench-results', () => {
  let app: Express;
  let token: string;

  async function call(method: string, body: unknown) {
    const server = app.listen(0, '127.0.0.1');
    if (!server.listening) await new Promise<void>(resolve => server.once('listening', () => resolve()));
    const { port } = server.address() as { port: number };
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/analysis/bench-results`, {
        method,
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      return { status: res.status, body: await res.json() as Record<string, unknown> };
    } finally {
      server.close();
    }
  }

  beforeEach(() => {
    // The session lives in the database, and the outer beforeEach rebuilds it
    // for every test, so the token is minted after that rebuild.
    addModel('groq', 'openai/gpt-oss-20b', 'GPT-OSS 20B');
    app = createApp();
    token = mintDashboardToken();
  });


  it('imports a passport and shows the tokens per task', async () => {
    const res = await call('POST', passport());
    expect(res.status).toBe(200);
    // 900 prompt + 300 completion over 3 completed scenarios.
    expect(res.body.tokensPerTask).toBe(400);

    const stored = loadBenchResults(getDb()).get('groq\u0000openai/gpt-oss-20b');
    expect(stored).toMatchObject({ benchVersion: '1.0.0', scenariosCompleted: 3, calls: 3 });

    const row = getComparePayload().rows.find(r => r.modelId === 'openai/gpt-oss-20b')!;
    expect(row.tokenEfficiency).toMatchObject({ source: 'screen', tokensPerTask: 400 });
  });

  it('replaces the row when the same route is imported again', async () => {
    await call('POST', passport());
    await call('POST', passport({ promptTokens: 3000, completionTokens: 600, startedAt: '2026-10-21T00:00:00.000Z' }));

    const stored = [...loadBenchResults(getDb()).values()];
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({ promptTokens: 3000, completionTokens: 600 });
  });

  it('refuses a run where no scenario reached a verdict', async () => {
    const res = await call('POST', passport({ statuses: { A1: 'INCONCLUSIVE', A2: 'NOT_TESTED' } }));
    expect(res.status).toBe(400);
    expect(loadBenchResults(getDb()).size).toBe(0);
  });

  it('refuses a route that is not in the catalogue', async () => {
    const res = await call('POST', passport({ platform: 'groq', modelId: 'nope' }));
    expect(res.status).toBe(404);
    expect(loadBenchResults(getDb()).size).toBe(0);
  });

  it('refuses a malformed passport', async () => {
    expect((await call('POST', { run: { benchVersion: '1.0.0' } })).status).toBe(400);
    expect((await call('POST', { nothing: true })).status).toBe(400);
    expect(loadBenchResults(getDb()).size).toBe(0);
  });

  it('removes one result', async () => {
    await call('POST', passport());
    const removed = await call('DELETE', { platform: 'groq', modelId: 'openai/gpt-oss-20b' });
    expect(removed.status).toBe(200);
    expect(removed.body.removed).toBe(1);
    expect(loadBenchResults(getDb()).size).toBe(0);

    const row = getComparePayload().rows.find(r => r.modelId === 'openai/gpt-oss-20b')!;
    expect(row.tokenEfficiency).toBeNull();
  });
});

describe('the stored row', () => {
  it('survives a save and a delete', () => {
    saveBenchResult({
      platform: 'groq', modelId: 'm', benchVersion: '1.0.0',
      promptTokens: 10, completionTokens: 20, reasoningTokens: 5, calls: 1,
      scenariosCompleted: 1, reasoningEffort: 'low', runAt: '2026-10-20T00:00:00.000Z',
    });
    expect(loadBenchResults(getDb()).get('groq\u0000m')).toMatchObject({ reasoningEffort: 'low' });
    expect(deleteBenchResult('groq', 'm', getDb())).toBe(1);
    expect(loadBenchResults(getDb()).size).toBe(0);
  });
});
