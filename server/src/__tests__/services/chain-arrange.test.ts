import { describe, it, expect, beforeEach } from 'vitest';
import { initDb, getDb } from '../../db/index.js';
import { encrypt } from '../../lib/crypto.js';
import type { ScoreCell, ScoreMetric } from '../../services/analysis.js';
import type { ChainMinimums } from '../../services/chain-minimums.js';
import type { RouteEvidence } from '../../services/route-evidence.js';
import { invalidateQuotaPressure } from '../../services/quota-pressure.js';
import { resetExtensionStateCache, setExtensionEnabled } from '../../services/extension-state.js';
import {
  ArrangeRevisionConflict,
  CHAIN_ARRANGE_EXTENSION_ID,
  applyChainArrangement,
  getArrangeSettings,
  isChainOrderManaged,
  listArrangeRuns,
  rankChain,
  saveArrangeSettings,
  type ArrangeInput,
  type ArrangeMember,
  type ArrangePlan,
} from '../../services/chain-arrange.js';
import { applyCuration, planCuration } from '../../scripts/apply-routing-curation.js';

// The arranger decides which model serves under priority routing, so these
// pin its ordering rules: what goes to the tail, what the band admits, how the
// head spreads across pools, and that an operator's pin always wins.

const cell = (value: number | null, provenance: ScoreCell['provenance'] = value == null ? null : 'measured'): ScoreCell =>
  ({ value, provenance, entry: null, editable: provenance !== 'measured' });

const scores = (intelligence: number | null, coding: number | null = null, agentic: number | null = null): Record<ScoreMetric, ScoreCell> =>
  ({ intelligence: cell(intelligence), coding: cell(coding), agentic: cell(agentic) });

function evidence(real: [number, number], opts: Partial<{ latency: number; agentic: [number, number]; coding: [number, number]; toolsRefused: boolean }> = {}): RouteEvidence {
  return {
    platform: 'x', modelId: 'x', endpointScope: '',
    real: { n: real[0], ok: real[1], avgOkLatencyMs: opts.latency ?? null },
    probe: { n: 0, ok: 0, avgOkLatencyMs: null, lastAtMs: null },
    screen: {
      agentic: opts.agentic ? { mean: opts.agentic[0], graded: opts.agentic[1] } : { mean: null, graded: 0 },
      coding: opts.coding ? { mean: opts.coding[0], graded: opts.coding[1] } : { mean: null, graded: 0 },
      nativeToolsUnsupported: opts.toolsRefused ?? false,
    },
  };
}

let nextId = 1;
function member(name: string, over: Partial<ArrangeMember> = {}): ArrangeMember {
  const id = nextId++;
  return {
    route: { modelDbId: id, platform: name.split('/')[0], modelId: name.split('/')[1] ?? name, endpointScope: '' },
    displayName: name,
    from: id,
    scores: scores(40),
    supportsTools: true,
    supportsVision: false,
    hasKey: true,
    evidence: evidence([100, 95]),
    pool: `pool:${name}`,
    ...over,
  };
}

const NO_MINS: ChainMinimums = { general: null, coding: null, agentic: null, acceptEstimated: false, either: [] };

function input(chain: ArrangeInput['chain'], members: ArrangeMember[], over: Partial<ArrangeInput> = {}): ArrangeInput {
  members.forEach((m, i) => { m.from = i + 1; });
  return {
    chain, members, minimums: NO_MINS, requiresTools: true, requiresVision: false,
    settings: { auto: true, minMembers: 0, minPools: 0, pins: [] }, tolerancePct: 10, computedAtMs: 0,
    ...over,
  };
}

const order = (plan: ArrangePlan) => plan.entries.map(e => e.displayName);

describe('ranking', () => {
  beforeEach(() => { nextId = 1; });

  it('puts the strongest proven route first on Apex and sends failing routes to the tail', () => {
    const plan = rankChain(input('Apex', [
      member('a/failing', { scores: scores(50), evidence: evidence([100, 20]) }),
      member('a/mid', { scores: scores(40) }),
      member('a/best', { scores: scores(45) }),
      member('a/new', { scores: scores(48), evidence: null }),
    ]));
    // Proven before unmeasured even when the unmeasured model scores higher;
    // the failing route goes last whatever its score.
    expect(order(plan)).toEqual(['a/best', 'a/mid', 'a/new', 'a/failing']);
    expect(plan.entries[3]).toMatchObject({ tier: 'failing' });
    expect(plan.changed).toBe(true);
  });

  it('keeps a model just under a floor as near, drops one well under to out, and never fails an unpublished score', () => {
    const mins: ChainMinimums = { ...NO_MINS, general: 40 };
    const plan = rankChain(input('Apex', [
      member('a/far', { scores: scores(34) }),       // 15% under
      member('a/close', { scores: scores(38) }),     // 5% under
      member('a/unknown', { scores: scores(null) }),
      member('a/fit', { scores: scores(41) }),
    ], { minimums: mins }));
    const byName = Object.fromEntries(plan.entries.map(e => [e.displayName, e.eligibility]));
    expect(byName).toEqual({ 'a/fit': 'fit', 'a/close': 'near', 'a/unknown': 'near', 'a/far': 'out' });
    expect(order(plan)[0]).toBe('a/fit');
    expect(order(plan).at(-1)).toBe('a/far');
  });

  it("lets a route's own screen settle a coding minimum nobody has published", () => {
    const mins: ChainMinimums = { ...NO_MINS, coding: 60 };
    const plan = rankChain(input('Coding', [
      member('c/screen-fail', { scores: scores(40, null), evidence: evidence([100, 95], { coding: [20, 1] }) }),
      member('c/screen-pass', { scores: scores(40, null), evidence: evidence([100, 95], { coding: [85, 1] }) }),
    ], { minimums: mins }));
    expect(plan.entries.map(e => [e.displayName, e.eligibility])).toEqual([['c/screen-pass', 'fit'], ['c/screen-fail', 'out']]);
  });

  it('vetoes a route whose own probes refuse tools or fail the agentic screen, however good its model', () => {
    const plan = rankChain(input('Apex', [
      member('a/refuses-tools', { scores: scores(60), evidence: evidence([100, 99], { toolsRefused: true }) }),
      member('a/bad-agent', { scores: scores(58), evidence: evidence([100, 99], { agentic: [20, 3] }) }),
      member('a/plain', { scores: scores(35) }),
    ]));
    expect(order(plan)[0]).toBe('a/plain');
    expect(plan.entries.filter(e => e.tier === 'failing').map(e => e.displayName).sort()).toEqual(['a/bad-agent', 'a/refuses-tools']);
  });

  it('ranks two routes of one model apart on their own evidence', () => {
    const plan = rankChain(input('Apex', [
      member('radeon/glm-flash', { scores: scores(41.8), evidence: evidence([146, 60]) }),
      member('nvidia/glm-flash', { scores: scores(41.8), evidence: evidence([8580, 7800]) }),
    ]));
    expect(plan.entries.map(e => [e.displayName, e.tier])).toEqual([['nvidia/glm-flash', 'proven'], ['radeon/glm-flash', 'failing']]);
  });

  it('promotes the best out-of-band routes to fillers until the minimum depth is met', () => {
    const mins: ChainMinimums = { ...NO_MINS, general: 40 };
    const plan = rankChain(input('Apex', [
      member('a/fit', { scores: scores(45) }),
      member('a/out-weak', { scores: scores(20) }),
      member('a/out-strong', { scores: scores(30) }),
    ], { minimums: mins, settings: { auto: true, minMembers: 2, minPools: 0, pins: [] } }));
    expect(plan.entries.map(e => [e.displayName, e.eligibility])).toEqual([['a/fit', 'fit'], ['a/out-strong', 'filler'], ['a/out-weak', 'out']]);
    expect(plan.depth).toMatchObject({ required: 2, eligible: 2, satisfied: true });
  });

  it('spreads the head across quota pools', () => {
    const shared = { pool: 'radeon::account' };
    const plan = rankChain(input('Apex', [
      member('radeon/a', { ...shared, scores: scores(48) }),
      member('radeon/b', { ...shared, scores: scores(47) }),
      member('radeon/c', { ...shared, scores: scores(46) }),
      member('nvidia/d', { scores: scores(40) }),
      member('groq/e', { scores: scores(39) }),
    ], { settings: { auto: true, minMembers: 4, minPools: 3, pins: [] } }));
    // Without the spread the three radeon routes would hold the first three
    // places and one exhausted pool would empty the head.
    expect(order(plan).slice(0, 2)).toEqual(['radeon/a', 'nvidia/d']);
    expect(new Set(plan.entries.slice(0, 4).map(e => e.pool)).size).toBeGreaterThanOrEqual(3);
    expect(plan.depth).toMatchObject({ pools: 3, satisfied: true });
  });

  it('orders Fast-Lane on measured latency', () => {
    const plan = rankChain(input('Fast-Lane', [
      member('f/slow', { scores: scores(45), evidence: evidence([100, 98], { latency: 20_000 }) }),
      member('f/fast', { scores: scores(10), evidence: evidence([100, 98], { latency: 700 }) }),
    ]));
    expect(order(plan)).toEqual(['f/fast', 'f/slow']);
  });

  it('orders Coding on a derived estimate only when the chain accepts estimates', () => {
    const derived = (value: number): Record<ScoreMetric, ScoreCell> => ({ ...scores(40), coding: cell(value, 'derived') });
    const members = () => [
      // The better proven route, with no coding score at all.
      member('c/unscored', { scores: scores(40), evidence: evidence([100, 99]) }),
      member('c/estimated', { scores: derived(70), evidence: evidence([100, 90]) }),
    ];
    expect(order(rankChain(input('Coding', members())))).toEqual(['c/unscored', 'c/estimated']);
    expect(order(rankChain(input('Coding', members(), { minimums: { ...NO_MINS, acceptEstimated: true } }))))
      .toEqual(['c/estimated', 'c/unscored']);
  });

  it('honours a pin over everything else', () => {
    const plan = rankChain(input('Apex', [
      member('a/best', { scores: scores(50) }),
      member('a/pinned', { scores: scores(20), evidence: evidence([100, 20]) }),
      member('a/mid', { scores: scores(40) }),
    ], { settings: { auto: true, minMembers: 0, minPools: 0, pins: [{ platform: 'a', modelId: 'pinned', endpointScope: '', position: 1 }] } }));
    expect(order(plan)).toEqual(['a/pinned', 'a/best', 'a/mid']);
    expect(plan.entries[0]).toMatchObject({ pinned: true, tier: 'failing' });
  });
});

// ── Database paths ──────────────────────────────────────────────────────────

function reset(): void {
  process.env.ENCRYPTION_KEY = '0'.repeat(64);
  initDb(':memory:');
  const db = getDb();
  for (const t of ['fallback_config', 'profile_models', 'models', 'api_keys', 'requests', 'route_probe_result', 'chain_arrange_run']) db.prepare(`DELETE FROM ${t}`).run();
  db.prepare("DELETE FROM settings WHERE key = 'imperium_chain_arrange'").run();
  invalidateQuotaPressure();
  resetExtensionStateCache();
  setExtensionEnabled(CHAIN_ARRANGE_EXTENSION_ID, true);
  const secret = encrypt('groq-arrange-test');
  db.prepare("INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled) VALUES ('groq', 't', ?, ?, ?, 'healthy', 1)")
    .run(secret.encrypted, secret.iv, secret.authTag);
}

function addModel(modelId: string): number {
  return Number(getDb().prepare(`
    INSERT INTO models (platform, model_id, display_name, intelligence_rank, speed_rank, size_label, monthly_token_budget, context_window, enabled, supports_vision, supports_tools)
    VALUES ('groq', ?, ?, 5, 5, 'Large', '', 128000, 1, 0, 1)
  `).run(modelId, modelId).lastInsertRowid);
}

function addRequests(modelDbId: number, modelId: string, n: number, ok: number): void {
  const insert = getDb().prepare("INSERT INTO requests (platform, model_id, model_db_id, status, latency_ms, created_at) VALUES ('groq', ?, ?, ?, 500, datetime('now', '-1 hour'))");
  for (let i = 0; i < n; i++) insert.run(modelId, modelDbId, i < ok ? 'success' : 'error');
}

function chainOrder(name: string): number[] {
  return (getDb().prepare(`
    SELECT pm.model_db_id AS id FROM profile_models pm JOIN profiles p ON p.id = pm.profile_id
     WHERE p.name = ? AND pm.enabled = 1 ORDER BY pm.priority
  `).all(name) as { id: number }[]).map(r => r.id);
}

function addChain(name: string, ids: number[]): void {
  const db = getDb();
  const existing = db.prepare('SELECT id FROM profiles WHERE name = ?').get(name) as { id: number } | undefined;
  const profileId = existing?.id ?? Number(db.prepare("INSERT INTO profiles (name, type) VALUES (?, 'custom')").run(name).lastInsertRowid);
  ids.forEach((id, i) => db.prepare('INSERT INTO profile_models (profile_id, model_db_id, priority, enabled) VALUES (?, ?, ?, 1)').run(profileId, id, i + 1));
}

describe('writing the order', () => {
  beforeEach(reset);

  it('renumbers the chain and records the run once, and writes nothing when the order already holds', () => {
    const weak = addModel('weak');
    const strong = addModel('strong');
    addChain('Fast-Lane', [weak, strong]);
    addRequests(weak, 'weak', 60, 20);
    addRequests(strong, 'strong', 60, 59);

    const first = applyChainArrangement('Fast-Lane', 'manual')!;
    expect(first.changed).toBe(true);
    expect(chainOrder('Fast-Lane')).toEqual([strong, weak]);
    expect(listArrangeRuns(getDb(), 'Fast-Lane')).toEqual([expect.objectContaining({ trigger: 'manual', moved: 2 })]);

    const again = applyChainArrangement('Fast-Lane', 'schedule')!;
    expect(again).toMatchObject({ changed: false, runId: null });
    expect(listArrangeRuns(getDb(), 'Fast-Lane')).toHaveLength(1);
  });

  it('leaves the order of a managed chain to the arranger when the curation is applied', () => {
    const a = addModel('a');
    const b = addModel('b');
    addChain('Fast-Lane', [b, a]);
    expect(isChainOrderManaged('Fast-Lane')).toBe(true);
    applyCuration({
      ...planCuration(),
      enable: [
        { chain: 'Fast-Lane', modelDbId: a, platform: 'groq', modelId: 'a', priority: 1, wasEnabled: true },
        { chain: 'Fast-Lane', modelDbId: b, platform: 'groq', modelId: 'b', priority: 2, wasEnabled: true },
      ],
      disable: [],
    });
    expect(chainOrder('Fast-Lane')).toEqual([b, a]);

    // With auto off for that chain, the spec's positions apply again.
    const s = getArrangeSettings();
    saveArrangeSettings(getDb(), { expectedRevision: s.revision, tolerancePct: s.tolerancePct, chains: { ...s.chains, 'Fast-Lane': { ...s.chains['Fast-Lane'], auto: false } } });
    applyCuration({ ...planCuration(), enable: [
      { chain: 'Fast-Lane', modelDbId: a, platform: 'groq', modelId: 'a', priority: 1, wasEnabled: true },
      { chain: 'Fast-Lane', modelDbId: b, platform: 'groq', modelId: 'b', priority: 2, wasEnabled: true },
    ], disable: [] });
    expect(chainOrder('Fast-Lane')).toEqual([a, b]);
  });

  it('refuses a stale settings save', () => {
    const s = getArrangeSettings();
    saveArrangeSettings(getDb(), { expectedRevision: s.revision, tolerancePct: 15, chains: s.chains });
    expect(() => saveArrangeSettings(getDb(), { expectedRevision: s.revision, tolerancePct: 5, chains: s.chains })).toThrow(ArrangeRevisionConflict);
    expect(getArrangeSettings().tolerancePct).toBe(15);
  });
});
