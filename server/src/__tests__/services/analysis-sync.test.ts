import { describe, it, expect, beforeEach } from 'vitest';
import { initDb, getDb, setSetting } from '../../db/index.js';
import {
  getAnalysisStatus,
  getComparePayload,
  measuredRoutes,
  setAnalysisKey,
  setBenchmarkEntry,
  setManualLink,
  setScoringVersion,
  syncAnalysis,
} from '../../services/analysis.js';
import { judgeMetric } from '../../services/model-bench/passport.js';
import { aaTokenEstimates } from '../../services/token-efficiency.js';
import { setUnifyOverrides } from '../../services/model-groups.js';

// The v2 migration (ADR ARCH-20261030): a refresh publishes one complete,
// validated catalogue or nothing, and a version change or a retired metric
// never erases the scores the chains are graded on.

type Body = Record<string, unknown>;
type Reply = { status: number; body?: unknown; headers?: Record<string, string> } | Error;

const CAPS = {
  artificial_analysis_finance_and_accounting_index: null,
  artificial_analysis_strategy_and_ops_index: null,
  artificial_analysis_legal_index: null,
  artificial_analysis_healthcare_and_medical_index: null,
  artificial_analysis_engineering_index: null,
  artificial_analysis_economics_index: null,
};

function model(slug: string, over: { intelligence?: number | null; coding?: number | null; agentic?: number | null; cost?: number | null; extra?: Body; evaluations?: Body } = {}): Body {
  return {
    id: `id-${slug}`,
    name: slug.toUpperCase(),
    slug,
    release_date: '2026-08-01',
    model_creator: { id: 'c1', name: 'Maker' },
    evaluations: {
      artificial_analysis_intelligence_index: over.intelligence === undefined ? 40 : over.intelligence,
      artificial_analysis_coding_index: over.coding ?? null,
      artificial_analysis_agentic_index: over.agentic ?? null,
      ...CAPS,
      ...over.evaluations,
    },
    artificial_analysis_intelligence_index_cost: { total_cost: 100, cost_per_task: { total_cost: over.cost === undefined ? 0.5 : over.cost } },
    pricing: { price_1m_input_tokens: 1, price_1m_output_tokens: 3 },
    performance: {
      median_output_tokens_per_second: 120,
      median_time_to_first_token_seconds: 0.6,
      median_time_to_first_answer_token_seconds: 4.2,
      median_end_to_end_response_time_seconds: 9,
    },
    ...over.extra,
  };
}

function page(n: number, total: number, data: Body[], version = 5): Body {
  return { tier: 'free', intelligence_index_version: version, pagination: { page: n, page_size: 2, total_pages: total, has_more: n < total }, data };
}

const ok = (body: unknown, headers: Record<string, string> = {}): Reply => ({
  status: 200, body, headers: { 'x-aa-tier': 'free', 'x-ratelimit-limit': '100', 'x-ratelimit-remaining': '90', 'x-ratelimit-reset': '1893456000', ...headers },
});

/** A fake AA: per page number, a queue of replies consumed one per request. */
function fakeAa(pages: Record<number, Reply[]>) {
  const calls: string[] = [];
  const fetchImpl = (async (input: string | URL | Request) => {
    const url = String(input);
    calls.push(url);
    const n = Number(new URL(url).searchParams.get('page'));
    const reply = pages[n]?.shift();
    if (!reply) throw new Error(`unexpected request for page ${n}`);
    if (reply instanceof Error) throw reply;
    return new Response(reply.body === undefined ? null : typeof reply.body === 'string' ? reply.body : JSON.stringify(reply.body), {
      status: reply.status, headers: reply.headers,
    });
  }) as typeof fetch;
  const sleeps: number[] = [];
  const sleep = async (ms: number) => { sleeps.push(ms); };
  return { fetchImpl, sleep, calls, sleeps };
}

const aaRows = () => getDb().prepare('SELECT * FROM aa_model ORDER BY slug').all() as Record<string, unknown>[];
const measurementCount = () => (getDb().prepare('SELECT COUNT(*) AS c FROM aa_measurement').get() as { c: number }).c;
const archiveRows = () => getDb().prepare('SELECT slug, metric, index_version, value FROM aa_score_archive ORDER BY slug, metric, index_version').all();

function addModel(platform: string, modelId: string) {
  getDb().prepare(`
    INSERT INTO models (platform, model_id, display_name, intelligence_rank, speed_rank, size_label, monthly_token_budget, enabled)
    VALUES (?, ?, ?, 50, 50, 'Large', '', 1)
  `).run(platform, modelId, modelId);
}
const row = (platform: string, modelId: string) =>
  getComparePayload().rows.find(r => r.platform === platform && r.modelId === modelId)!;

/** A complete first snapshot on v4.3 with coding and agentic still published. */
async function seedV43() {
  const aa = fakeAa({
    1: [ok(page(1, 2, [model('alpha', { intelligence: 50, coding: 45, agentic: 40, cost: 0.6 }), model('beta', { intelligence: 30, coding: 20, agentic: null })], 4.3))],
    2: [ok(page(2, 2, [model('gamma', { intelligence: 20, coding: null, agentic: 15 })], 4.3))],
  });
  const result = await syncAnalysis(getDb(), { fetchImpl: aa.fetchImpl, sleep: aa.sleep, now: () => Date.parse('2026-10-26T09:53:02Z') });
  expect(result).toMatchObject({ ok: true, fetched: 3 });
}

beforeEach(() => {
  process.env.ENCRYPTION_KEY = '0'.repeat(64);
  initDb(':memory:');
  const db = getDb();
  for (const t of ['profile_models', 'fallback_config', 'models', 'aa_model', 'aa_model_link', 'aa_measurement', 'aa_score_archive', 'model_benchmark_entry']) {
    db.prepare(`DELETE FROM ${t}`).run();
  }
  db.prepare("DELETE FROM settings WHERE key LIKE 'aa_%'").run();
  setUnifyOverrides({ merges: [], splits: [] });
  setAnalysisKey('aa-test-key-0000');
});

describe('a refresh publishes every page as one snapshot', () => {
  it('fetches all pages in order and maps the v2 fields, nested performance included', async () => {
    const aa = fakeAa({
      1: [ok(page(1, 3, [model('a1'), model('a2')]))],
      2: [ok(page(2, 3, [model('b1', { evaluations: { artificial_analysis_legal_index: 61.5 } }), model('b2')]))],
      3: [ok(page(3, 3, [model('c1')]))],
    });
    const result = await syncAnalysis(getDb(), { fetchImpl: aa.fetchImpl, sleep: aa.sleep });

    expect(result).toMatchObject({ ok: true, fetched: 5 });
    expect(aa.calls.map(u => new URL(u).pathname + new URL(u).search)).toEqual([
      '/api/v2/language/models/free?page=1', '/api/v2/language/models/free?page=2', '/api/v2/language/models/free?page=3',
    ]);
    const b1 = aaRows().find(r => r.slug === 'b1')!;
    expect(b1).toMatchObject({
      index_version: 'v5.0',
      median_output_tokens_per_second: 120,
      median_time_to_first_token_seconds: 0.6,
      // The legacy `median_time_to_first_answer_token`, renamed and nested.
      median_time_to_first_answer_token_seconds: 4.2,
      legal_index: 61.5,
      finance_index: null,
      response_shape: 'free',
      prompt_type: null,
    });
    const status = getAnalysisStatus();
    expect(status).toMatchObject({
      tier: 'free', responseShape: 'free', indexVersion: 'v5.0', scoringVersion: 'v5.0',
      totalPages: 3, stale: false, lastError: null, cachedModels: 5,
    });
    expect(status.rateLimit).toMatchObject({ limit: 100, remaining: 90 });
  });

  it('keeps a model listed on two pages once, and refuses two models sharing a slug', async () => {
    const twice = fakeAa({
      1: [ok(page(1, 2, [model('a1'), model('dup')]))],
      2: [ok(page(2, 2, [model('dup'), model('b2')]))],
    });
    expect(await syncAnalysis(getDb(), { fetchImpl: twice.fetchImpl, sleep: twice.sleep })).toMatchObject({ ok: true, fetched: 3 });
    expect(aaRows().map(r => r.slug)).toEqual(['a1', 'b2', 'dup']);
    expect(measurementCount()).toBe(3);

    const clash = fakeAa({
      1: [ok(page(1, 2, [model('a1'), model('dup')]))],
      2: [ok(page(2, 2, [model('dup', { extra: { id: 'someone-else' } })]))],
    });
    const result = await syncAnalysis(getDb(), { fetchImpl: clash.fetchImpl, sleep: clash.sleep });
    expect(result.ok).toBe(false);
    expect(result.error).toContain('share the slug');
    expect(measurementCount()).toBe(3);
  });

  it('reads omitted and null fields as unmeasured, never as zero', async () => {
    const bare = model('bare', { intelligence: null, cost: null });
    delete bare.performance;
    delete bare.pricing;
    (bare.evaluations as Body).artificial_analysis_economics_index = undefined;
    const aa = fakeAa({ 1: [ok(page(1, 1, [bare, model('full')]))] });
    expect((await syncAnalysis(getDb(), { fetchImpl: aa.fetchImpl, sleep: aa.sleep })).ok).toBe(true);

    expect(aaRows().find(r => r.slug === 'bare')).toMatchObject({
      intelligence_index: null, index_cost_per_task: null, price_1m_input: null, price_1m_output: null,
      median_output_tokens_per_second: null, median_time_to_first_token_seconds: null,
      median_time_to_first_answer_token_seconds: null, economics_index: null,
    });
    addModel('groq', 'bare');
    setManualLink('groq', 'bare', 'bare');
    expect(row('groq', 'bare').scores.intelligence).toMatchObject({ value: null, provenance: null });
    expect(aaTokenEstimates(getDb()).has('bare')).toBe(false);
  });

  it('refuses a number that is not a number, and keeps the previous snapshot', async () => {
    await seedV43();
    const before = aaRows();
    const aa = fakeAa({ 1: [ok(page(1, 1, [model('alpha', { intelligence: '57' as unknown as number })]))] });
    const result = await syncAnalysis(getDb(), { fetchImpl: aa.fetchImpl, sleep: aa.sleep });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/malformed/i);
    expect(aaRows()).toEqual(before);
  });
});

describe('a failure part-way never replaces a complete snapshot', () => {
  it('keeps every row, history and archive when a later page fails, and reports the snapshot stale', async () => {
    await seedV43();
    const before = { rows: aaRows(), history: measurementCount(), archive: archiveRows() };
    const lastSync = getAnalysisStatus().lastSyncMs;

    const aa = fakeAa({
      1: [ok(page(1, 2, [model('alpha', { intelligence: 58 }), model('beta')]))],
      2: [{ status: 503 }, { status: 502 }, { status: 500 }],
    });
    const result = await syncAnalysis(getDb(), { fetchImpl: aa.fetchImpl, sleep: aa.sleep, now: () => Date.parse('2026-10-30T00:00:00Z') });

    expect(result.ok).toBe(false);
    // Bounded: three attempts at page 2, with backoff between them.
    expect(aa.calls).toHaveLength(4);
    expect(aa.sleeps).toEqual([1000, 2000]);
    expect(aaRows()).toEqual(before.rows);
    expect(measurementCount()).toBe(before.history);
    expect(archiveRows()).toEqual(before.archive);
    const status = getAnalysisStatus();
    expect(status.stale).toBe(true);
    expect(status.lastSyncMs).toBe(lastSync);
    expect(status.lastAttemptMs).toBe(Date.parse('2026-10-30T00:00:00Z'));
    expect(status.lastError).toContain('500');
  });

  it('retries a network error, then publishes', async () => {
    const aa = fakeAa({ 1: [new Error('ECONNRESET'), ok(page(1, 1, [model('a1')]))] });
    expect(await syncAnalysis(getDb(), { fetchImpl: aa.fetchImpl, sleep: aa.sleep })).toMatchObject({ ok: true, fetched: 1 });
    expect(aa.sleeps).toEqual([1000]);
  });

  it('refuses a refresh whose page count or index version changes part-way', async () => {
    await seedV43();
    const before = aaRows();
    const pages = fakeAa({
      1: [ok(page(1, 2, [model('alpha')]))],
      2: [ok({ ...page(2, 2, [model('beta')]), pagination: { page: 2, page_size: 2, total_pages: 3, has_more: true } })],
    });
    expect((await syncAnalysis(getDb(), { fetchImpl: pages.fetchImpl, sleep: pages.sleep })).error).toContain('page count');
    const version = fakeAa({
      1: [ok(page(1, 2, [model('alpha')], 5))],
      2: [ok(page(2, 2, [model('beta')], 5.1))],
    });
    expect((await syncAnalysis(getDb(), { fetchImpl: version.fetchImpl, sleep: version.sleep })).error).toContain('version changed');
    expect(aaRows()).toEqual(before);
  });

  it('does not retry an authentication error and keeps the snapshot', async () => {
    await seedV43();
    const before = aaRows();
    const aa = fakeAa({ 1: [{ status: 401, body: { error: 'API key is required' } }] });
    const result = await syncAnalysis(getDb(), { fetchImpl: aa.fetchImpl, sleep: aa.sleep });
    expect(result).toMatchObject({ ok: false });
    expect(result.error).toContain('401');
    expect(aa.calls).toHaveLength(1);
    expect(aaRows()).toEqual(before);
  });

  it('reports a retired endpoint (410) without retrying', async () => {
    await seedV43();
    const before = aaRows();
    const aa = fakeAa({ 1: [{ status: 410, body: { error: 'Gone' } }] });
    const result = await syncAnalysis(getDb(), { fetchImpl: aa.fetchImpl, sleep: aa.sleep });
    expect(result.error).toContain('410');
    expect(aa.calls).toHaveLength(1);
    expect(aaRows()).toEqual(before);
  });
});

describe('the rate limit', () => {
  it('waits out a short Retry-After and carries on', async () => {
    const aa = fakeAa({
      1: [{ status: 429, headers: { 'retry-after': '2', 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '1893456000' } }, ok(page(1, 1, [model('a1')]))],
    });
    expect(await syncAnalysis(getDb(), { fetchImpl: aa.fetchImpl, sleep: aa.sleep })).toMatchObject({ ok: true });
    expect(aa.sleeps).toEqual([2000]);
  });

  it('stops on a long Retry-After, and sends nothing until it has passed', async () => {
    await seedV43();
    const before = aaRows();
    let clock = Date.parse('2026-10-30T00:00:00Z');
    const now = () => clock;
    const limited = fakeAa({ 1: [{ status: 429, headers: { 'retry-after': '3600' } }] });
    const first = await syncAnalysis(getDb(), { fetchImpl: limited.fetchImpl, sleep: limited.sleep, now });
    expect(first.ok).toBe(false);
    expect(limited.sleeps).toEqual([]);
    expect(aaRows()).toEqual(before);

    clock += 60_000;
    const early = fakeAa({});
    const second = await syncAnalysis(getDb(), { fetchImpl: early.fetchImpl, sleep: early.sleep, now });
    expect(second.error).toContain('No request was sent');
    expect(early.calls).toHaveLength(0);

    clock += 3600_000;
    const later = fakeAa({ 1: [ok(page(1, 1, [model('alpha')]))] });
    expect((await syncAnalysis(getDb(), { fetchImpl: later.fetchImpl, sleep: later.sleep, now })).ok).toBe(true);
  });

  it('refuses up front when the remaining quota cannot cover every page', async () => {
    await seedV43(); // two pages
    setSetting('aa_rate_limit', JSON.stringify({ limit: 100, remaining: 1, resetAt: '2026-10-31T00:00:00.000Z' }));
    const aa = fakeAa({});
    const result = await syncAnalysis(getDb(), { fetchImpl: aa.fetchImpl, sleep: aa.sleep, now: () => Date.parse('2026-10-30T12:00:00Z') });
    expect(result.error).toContain('needs 2');
    expect(aa.calls).toHaveLength(0);
  });
});

describe('an index version change and retired metrics', () => {
  async function moveToV5() {
    const aa = fakeAa({
      1: [ok(page(1, 2, [
        // v5.0: intelligence rescored for alpha only; coding and agentic gone.
        model('alpha', { intelligence: 37, coding: null, agentic: null, cost: 0.9 }),
        model('beta', { intelligence: null, coding: null, agentic: null, cost: null }),
      ]))],
      2: [ok(page(2, 2, [model('gamma', { intelligence: null, coding: null, agentic: null, cost: null })]))],
    });
    expect((await syncAnalysis(getDb(), { fetchImpl: aa.fetchImpl, sleep: aa.sleep, now: () => Date.parse('2026-10-30T00:00:00Z') })).ok).toBe(true);
  }

  it('keeps ranking on the pinned version and serves retired metrics as archived', async () => {
    await seedV43();
    for (const slug of ['alpha', 'beta', 'gamma']) { addModel('p', slug); setManualLink('p', slug, slug); }
    await moveToV5();

    const status = getAnalysisStatus();
    expect(status).toMatchObject({ indexVersion: 'v5.0', scoringVersion: 'v4.3' });

    const alpha = row('p', 'alpha');
    // The same numbers the chains were graded on before the sync, marked as
    // no longer current, with their version.
    expect(alpha.scores.intelligence).toMatchObject({ value: 50, provenance: 'archived', version: 'v4.3', editable: false });
    expect(alpha.scores.coding).toMatchObject({ value: 45, provenance: 'archived', version: 'v4.3' });
    expect(alpha.scores.agentic).toMatchObject({ value: 40, provenance: 'archived' });
    expect(alpha.analysis).toMatchObject({ intelligenceIndex: 50, currentIntelligenceIndex: 37, currentIndexVersion: 'v5.0', indexCostPerTask: 0.6 });
    // Never invented: gamma had no coding on v4.3, beta no agentic.
    expect(row('p', 'gamma').scores.coding).toMatchObject({ value: null, provenance: null });
    expect(row('p', 'beta').scores.agentic).toMatchObject({ value: null, provenance: null });
    // Never substituted: coding is not filled from intelligence.
    expect(row('p', 'gamma').scores.coding.value).not.toBe(row('p', 'gamma').scores.intelligence.value);
  });

  it('switches scale only when told, and then shows v5.0 values as current with gaps left empty', async () => {
    await seedV43();
    for (const slug of ['alpha', 'beta']) { addModel('p', slug); setManualLink('p', slug, slug); }
    await moveToV5();

    expect(setScoringVersion('v9.9')).toBe(false);
    expect(setScoringVersion('v5.0')).toBe(true);
    expect(row('p', 'alpha').scores.intelligence).toMatchObject({ value: 37, provenance: 'measured', version: 'v5.0' });
    expect(row('p', 'beta').scores.intelligence).toMatchObject({ value: null, provenance: null });
    // Coding is retired on every version, so it stays archived either way.
    expect(row('p', 'alpha').scores.coding).toMatchObject({ value: 45, provenance: 'archived' });
    expect(row('p', 'alpha').analysis?.indexCostPerTask).toBe(0.9);
  });

  it('does not serve a retired metric from the archive while AA still publishes it', async () => {
    await seedV43();
    addModel('p', 'beta');
    setManualLink('p', 'beta', 'beta');
    // Still v4.3, coding still published for alpha, withdrawn for beta.
    const aa = fakeAa({
      1: [ok(page(1, 2, [model('alpha', { intelligence: 50, coding: 45 }), model('beta', { intelligence: 30, coding: null })], 4.3))],
      2: [ok(page(2, 2, [model('gamma', { intelligence: 20 })], 4.3))],
    });
    expect((await syncAnalysis(getDb(), { fetchImpl: aa.fetchImpl, sleep: aa.sleep })).ok).toBe(true);
    expect(row('p', 'beta').scores.coding).toMatchObject({ value: null, provenance: null });
  });

  it('stops serving archived scores for a model AA no longer lists', async () => {
    await seedV43();
    addModel('p', 'gamma');
    setManualLink('p', 'gamma', 'gamma');
    const aa = fakeAa({ 1: [ok(page(1, 1, [model('alpha', { intelligence: null }), model('beta', { intelligence: null })]))] });
    expect((await syncAnalysis(getDb(), { fetchImpl: aa.fetchImpl, sleep: aa.sleep })).ok).toBe(true);
    expect(row('p', 'gamma').analysis).toBeNull();
    expect(row('p', 'gamma').link?.unresolved).toBe(true);
    expect(archiveRows()).toContainEqual({ slug: 'gamma', metric: 'agentic', index_version: 'v4.3', value: 15 });
  });

  it('keeps a typed score that an archived measurement superseded, superseded', async () => {
    await seedV43();
    addModel('p', 'beta');
    setManualLink('p', 'beta', 'beta');
    getDb().prepare(`INSERT INTO model_benchmark_entry (platform, model_id, metric, value, provenance) VALUES ('p', 'beta', 'coding', 33, 'tested')`).run();
    expect(row('p', 'beta').scores.coding).toMatchObject({ value: 20, provenance: 'measured' });
    await moveToV5();
    expect(row('p', 'beta').scores.coding).toMatchObject({ value: 20, provenance: 'archived', entry: { value: 33, superseded: true } });
  });
});

describe('derived Coding and Agentic estimates', () => {
  // 24 models scored on v4.3 for intelligence and coding (coding = 1.5·i + 2),
  // plus one whose intelligence AA scored but whose coding it never did.
  const calibration = Array.from({ length: 24 }, (_, i) => ({ slug: `m${i}`, intelligence: 20 + i, coding: 1.5 * (20 + i) + 2 + (i % 2 ? 0.5 : -0.5) }));

  async function seed() {
    const v43 = [...calibration.map(c => model(c.slug, { intelligence: c.intelligence, coding: c.coding })), model('gap', { intelligence: 30, coding: null })];
    const aa = fakeAa({ 1: [ok(page(1, 1, v43, 4.3))] });
    expect((await syncAnalysis(getDb(), { fetchImpl: aa.fetchImpl, sleep: aa.sleep, now: () => Date.parse('2026-10-26T09:53:02Z') })).ok).toBe(true);
    for (const slug of ['gap', 'm3', 'brandnew']) { addModel('p', slug); }
    setManualLink('p', 'gap', 'gap');
    setManualLink('p', 'm3', 'm3');
  }

  it('estimates a missing score, labelled with its input, fit size and error, and never as a value AA published', async () => {
    await seed();
    const cell = row('p', 'gap').scores.coding;
    expect(cell).toMatchObject({ provenance: 'derived', editable: true, version: 'v4.3' });
    expect(cell.value).toBeCloseTo(47, 0);
    expect(cell.estimate).toMatchObject({ basis: { kind: 'intelligence', version: 'v4.3' }, n: 24, extrapolated: false });
    expect(cell.estimate!.error).toBeLessThan(1);
    // The analysis block keeps AA's own data only.
    expect(row('p', 'gap').analysis?.codingIndex).toBeNull();
    // A real value is never replaced by an estimate.
    expect(row('p', 'm3').scores.coding).toMatchObject({ provenance: 'measured' });
    // Too few agentic scores to fit anything: no estimate.
    expect(row('p', 'gap').scores.agentic).toMatchObject({ value: null, provenance: null });
  });

  it('refits from the new intelligence version after a version change, for a model only scored on it', async () => {
    await seed();
    const v5 = [
      ...calibration.map(c => model(c.slug, { intelligence: Math.round(0.74 * c.intelligence * 10) / 10, coding: null })),
      model('gap', { intelligence: null }),
      model('brandnew', { intelligence: 28, coding: null }),
    ];
    const aa = fakeAa({ 1: [ok(page(1, 1, v5))] });
    expect((await syncAnalysis(getDb(), { fetchImpl: aa.fetchImpl, sleep: aa.sleep })).ok).toBe(true);
    setManualLink('p', 'brandnew', 'brandnew');

    const fresh = row('p', 'brandnew').scores.coding;
    expect(fresh).toMatchObject({ provenance: 'derived', estimate: { basis: { kind: 'intelligence', version: 'v5.0' }, n: 24 } });
    // 28 on v5.0 is about 37.8 on v4.3, so coding about 1.5 × 37.8 + 2.
    expect(fresh.value).toBeCloseTo(58.8, 0);
    // Its v4.3 intelligence stays unknown: only coding and agentic are derived.
    expect(row('p', 'brandnew').scores.intelligence).toMatchObject({ value: null, provenance: null });
  });

  it('gives way to a typed score, never blocks typing, and counts toward no minimum unless estimates are accepted', async () => {
    await seed();
    const route = [{ platform: 'p', modelId: 'gap' }];
    expect(measuredRoutes(route, 'coding')).toEqual([]);
    const derived = row('p', 'gap').scores.coding;
    expect(judgeMetric('coding', derived, 40, { tolerancePct: 0, acceptEstimated: false }).result).toBe('unknown');
    expect(judgeMetric('coding', derived, 40, { tolerancePct: 0, acceptEstimated: true }).result).toBe('pass');

    setBenchmarkEntry(route, 'coding', 33, 'tested');
    expect(row('p', 'gap').scores.coding).toMatchObject({ value: 33, provenance: 'tested' });
  });
});
