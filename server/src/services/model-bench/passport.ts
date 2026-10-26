import type { ScoreCell, ScoreMetric } from '../analysis.js';
import { SCENARIOS, type ScenarioId } from './fixtures.js';
import { FAIL_BELOW, PASS_AT, type Check, type Tag } from './grade.js';
import type { RunResult, ScenarioResult } from './runner.js';

// Turns a run into a Model Passport: internal 0–100 measurements, the
// published Artificial Analysis figures beside them (never blended), and
// chain / OMP-role recommendations that say which evidence they rest on.

export interface RouteInfo {
  platform: string;
  modelId: string;
  displayName: string;
  contextWindow: number | null;
  supportsTools: boolean;
  supportsVision: boolean;
}

export interface PublishedEvidence {
  /** Resolved scores as Compare shows them, each with its provenance. */
  scores: Record<ScoreMetric, ScoreCell>;
  aa: {
    slug: string;
    name: string;
    indexVersion: string | null;
    fetchedAt: string | null;
    outputTokensPerSecond: number | null;
    timeToFirstTokenSeconds: number | null;
    price1mInput: number | null;
    price1mOutput: number | null;
  } | null;
}

export interface ChainRule { name: string; requiresTools: boolean; requiresVision: boolean }
export interface ChainMinimum { general: number | null; coding: number | null; agentic: number | null; acceptEstimated: boolean; either?: ('general' | 'coding' | 'agentic')[] }

export type Evidence = 'complete' | 'partial' | 'none';

export interface Metric {
  /** 0–100 on the INTERNAL scale. Never comparable with an AA index. */
  value: number | null;
  evidence: Evidence;
  /** Scenarios or checks behind the number. */
  basis: string;
}

export interface Recommendation {
  target: string;
  status: 'qualified' | 'provisional' | 'not qualified' | 'insufficient evidence';
  reasons: string[];
}

export interface Passport {
  route: RouteInfo;
  benchVersion: string;
  generatedAt: string;
  configuration: { temperature: number; seed: number; reasoningEffort: string | null; endpoint: string | null };
  published: {
    intelligence: ScoreCell;
    coding: ScoreCell;
    agentic: ScoreCell;
    source: string | null;
    methodology: string | null;
    outputTokensPerSecond: number | null;
    timeToFirstTokenSeconds: number | null;
  };
  internal: {
    scenarios: Record<ScenarioId, { status: string; score: number | null; mode: string; cached: boolean; inconsistent: boolean; runs: number; note: string | null }>;
    coding: Metric;
    agentic: Metric;
    /** A narrow proxy from constraint and decision checks inside the six
     *  scenarios — not a substitute for the AA Intelligence Index. */
    reasoningProxy: Metric;
    instructionAdherence: Metric;
    toolReliability: Metric & { nativeSupport: 'native' | 'simulated only' | 'unsupported' | 'untested'; nativeCalls: number; validNativeCalls: number };
    operationalReliability: Metric & { calls: number; failedCalls: number };
    comparable: boolean;
  };
  tokens: {
    prompt: number; completion: number; reasoning: number; total: number;
    planned: number; budget: number; estimated: boolean; repeatRuns: number;
    differenceFromPlan: number;
  };
  cost: string;
  measuredOutputTokensPerSecond: number | null;
  missing: string[];
  bestFor: string[];
  unsuitableFor: string[];
  chains: Recommendation[];
  ompRoles: Recommendation[];
  stoppedBy: string | null;
}

// ── Metrics ─────────────────────────────────────────────────────────────────

const graded = (r: ScenarioResult | undefined) => r && r.score != null && (r.status === 'PASS' || r.status === 'FAIL' || r.status === 'INCONCLUSIVE');

function capability(run: RunResult, ids: ScenarioId[]): Metric {
  const done = ids.filter(id => graded(run.results[id]));
  const value = done.length ? Math.round(done.reduce((s, id) => s + run.results[id]!.score!, 0) / done.length * 10) / 10 : null;
  return { value, evidence: done.length === ids.length ? 'complete' : done.length ? 'partial' : 'none', basis: done.length ? done.join(', ') : 'none graded' };
}

function byTag(run: RunResult, tag: Tag): Metric {
  const checks: Check[] = Object.values(run.results).flatMap(r => (graded(r) ? r!.runs.at(-1)?.checks ?? [] : []))
    .filter(c => c.tags.includes(tag) && c.score != null);
  const weight = checks.reduce((s, c) => s + c.weight, 0);
  const value = weight ? Math.round(checks.reduce((s, c) => s + c.weight * c.score!, 0) / weight * 1000) / 10 : null;
  const scenarios = Object.values(run.results).filter(graded).length;
  return { value, evidence: scenarios === 6 ? 'complete' : checks.length ? 'partial' : 'none', basis: `${checks.length} checks across ${scenarios}/6 scenarios` };
}

function toolReliability(run: RunResult): Passport['internal']['toolReliability'] {
  const transcripts = Object.values(run.results).flatMap(r => r?.transcripts ?? []);
  const native = transcripts.filter(t => t.mode === 'native');
  const calls = native.flatMap(t => t.turns.flatMap(x => x.toolCalls));
  const valid = calls.filter(c => c.args != null).length;
  const agentic = (['A1', 'A2', 'A3'] as const).map(id => run.results[id]);
  const nativeSupport = agentic.some(r => r?.mode === 'native' && r.transcripts.some(t => !t.toolsUnsupported)) ? 'native'
    : agentic.some(r => r?.mode === 'simulated') ? 'simulated only'
    : agentic.some(r => r?.status === 'UNSUPPORTED') ? 'unsupported' : 'untested';
  return {
    value: calls.length ? Math.round(valid / calls.length * 1000) / 10 : null,
    evidence: calls.length ? 'partial' : 'none',
    basis: `${valid}/${calls.length} native tool calls structurally valid; a 95% success rate is NOT established by a sample this size`,
    nativeSupport, nativeCalls: calls.length, validNativeCalls: valid,
  };
}

// ── Recommendations ─────────────────────────────────────────────────────────

const METRIC_OF = { general: 'intelligence', coding: 'coding', agentic: 'agentic' } as const;

export interface MetricVerdict {
  result: 'pass' | 'near' | 'below' | 'unknown';
  reason: string;
  /** The number behind the verdict is an AA measurement, not a typed score
   *  or a proxy's estimate. */
  measured: boolean;
}

export interface MinimumJudgeOptions {
  /** How far below a minimum still counts as near-fit. The passport's chain
   *  recommendations stay hard-edged (0); the chain arranger passes its
   *  tolerancePct so one rule grades both surfaces. */
  tolerancePct: number;
  acceptEstimated: boolean;
}

/** One published metric judged against one minimum — THE one rule, shared by
 *  recommendChains and the chain arranger. A missing score and an unaccepted
 *  estimate are both unknown, a value at or above the minimum passes, one
 *  inside the tolerance band is near, one under it is below. */
export function judgeMetric(key: string, cell: ScoreCell, min: number, opts: MinimumJudgeOptions): MetricVerdict {
  const measured = cell.provenance === 'measured';
  if (cell.value == null) {
    return { result: 'unknown', reason: `${key}: no published or typed score (minimum ${min})`, measured };
  }
  if ((cell.provenance === 'family' || cell.provenance === 'approximated') && !opts.acceptEstimated) {
    return { result: 'unknown', reason: `${key}: ${cell.value} is ${cell.provenance}; chain does not accept estimates`, measured };
  }
  if (cell.value >= min) {
    return { result: 'pass', reason: `${key}: ${cell.value} (${cell.provenance}) meets ${min}`, measured };
  }
  const floor = min * (1 - opts.tolerancePct / 100);
  if (cell.value >= floor) {
    return { result: 'near', reason: `${key}: ${cell.value} (${cell.provenance}) within ${opts.tolerancePct}% of ${min}`, measured };
  }
  return { result: 'below', reason: `${key}: ${cell.value} (${cell.provenance}) below minimum ${min}`, measured };
}

/** Provisional working thresholds on PUBLISHED AA indices (task brief, 2026-10-18).
 *  Not AA categories. Never applied to internal 0–100 scores. */
export const OMP_ROLE_THRESHOLDS: Record<string, { intelligence?: number; coding?: number; agentic?: number; critical?: boolean }> = {
  default: { intelligence: 40, coding: 35, agentic: 40, critical: true },
  slow: { intelligence: 45, coding: 35 },
  plan: { intelligence: 40, coding: 35, agentic: 35, critical: true },
  task: { intelligence: 30, coding: 45, agentic: 35, critical: true },
  smol: { intelligence: 20, coding: 20, agentic: 25 },
  tiny: { intelligence: 10 },
  memory: { intelligence: 25 },
  commit: { intelligence: 15, coding: 15 },
  advisor: { intelligence: 40, coding: 35 },
  vision: {},
};

function toolEvidence(p: Pick<Passport, 'internal' | 'route'>): { ok: boolean | null; reason: string } {
  const a1 = p.internal.scenarios.A1;
  if (p.internal.toolReliability.nativeSupport === 'unsupported') return { ok: false, reason: 'endpoint refused native tool calls' };
  if (p.internal.toolReliability.nativeSupport === 'native' && a1.status === 'PASS') return { ok: true, reason: 'native tool call verified (A1 PASS)' };
  if (p.internal.toolReliability.nativeSupport === 'native') return { ok: null, reason: `native tools accepted but A1 ${a1.status}` };
  return { ok: null, reason: p.route.supportsTools ? 'catalogue claims tools; not verified by a native call' : 'no tool support recorded' };
}

export function recommendChains(p: Pick<Passport, 'internal' | 'route' | 'published'>, rules: ChainRule[], mins: Record<string, ChainMinimum>): Recommendation[] {
  return rules.map(rule => {
    const reasons: string[] = [];
    let provisional = false;
    if (rule.requiresTools) {
      const t = toolEvidence(p);
      reasons.push(`tools: ${t.reason}`);
      if (t.ok === false) return { target: rule.name, status: 'not qualified' as const, reasons };
      if (t.ok === null) provisional = true;
    }
    if (rule.requiresVision) {
      if (!p.route.supportsVision) return { target: rule.name, status: 'not qualified' as const, reasons: [...reasons, 'vision: no image input'] };
      reasons.push('vision: catalogue claims image input; not tested here');
      provisional = true;
    }
    const m = mins[rule.name];
    const either = new Set(m?.either ?? []);
    let unknown = false;
    // Alternatives: one passing member clears the group; otherwise the group
    // fails if every set member is measured below, and is unknown if any
    // could still pass once scored.
    const group: { key: string; result: MetricVerdict['result']; reason: string; measured: boolean }[] = [];
    for (const key of ['general', 'coding', 'agentic'] as const) {
      const min = m?.[key];
      if (min == null) continue;
      const cell = p.published[METRIC_OF[key]];
      // Tolerance 0 keeps these recommendations hard-edged; the band is the
      // arranger's widening of the same rule.
      const v = judgeMetric(key, cell, min, { tolerancePct: 0, acceptEstimated: m?.acceptEstimated ?? false });
      if (either.has(key)) { group.push({ key, result: v.result, reason: v.reason, measured: v.measured }); continue; }
      if (v.result === 'pass' && !v.measured) provisional = true;
      if (v.result === 'below') return { target: rule.name, status: 'not qualified' as const, reasons: [...reasons, v.reason] };
      if (v.result === 'unknown') unknown = true;
      reasons.push(v.reason);
    }
    if (group.length > 0) {
      // A measured pass beats an estimated one: only the alternative that
      // actually carries the group decides whether the result is provisional.
      const passed = group.find(g => g.result === 'pass' && g.measured) ?? group.find(g => g.result === 'pass');
      if (passed) {
        if (!passed.measured) provisional = true;
        reasons.push(`${passed.reason} (one of ${group.map(g => g.key).join(' / ')})`);
      }
      else {
        const why = `none of ${group.map(g => g.key).join(' / ')} met: ${group.map(g => g.reason).join('; ')}`;
        if (group.every(g => g.result === 'below')) return { target: rule.name, status: 'not qualified' as const, reasons: [...reasons, why] };
        unknown = true;
        reasons.push(why);
      }
    }
    if (unknown) return { target: rule.name, status: 'insufficient evidence' as const, reasons };
    return { target: rule.name, status: provisional ? 'provisional' as const : 'qualified' as const, reasons };
  });
}

export function recommendRoles(p: Pick<Passport, 'internal' | 'route' | 'published' | 'measuredOutputTokensPerSecond'>): Recommendation[] {
  return Object.entries(OMP_ROLE_THRESHOLDS).map(([role, need]) => {
    const reasons: string[] = [];
    if (role === 'vision') {
      return { target: role, status: 'insufficient evidence' as const, reasons: [p.route.supportsVision ? 'catalogue claims image input; the six tests do not exercise images' : 'no image input recorded'] };
    }
    let provisional = false;
    // Per missing published metric, what the internal screen says about it:
    // a pass supports a provisional assignment, a fail rules it out, anything
    // else leaves it unknown. Never a threshold comparison — different scales.
    const support: ('pass' | 'fail' | 'unknown')[] = [];
    for (const metric of ['intelligence', 'coding', 'agentic'] as const) {
      const min = need[metric];
      if (min == null) continue;
      const cell = p.published[metric];
      if (cell.value == null) {
        const internal = metric === 'coding' ? p.internal.coding : metric === 'agentic' ? p.internal.agentic : p.internal.reasoningProxy;
        support.push(internal.value == null ? 'unknown' : internal.value >= PASS_AT ? 'pass' : internal.value < FAIL_BELOW ? 'fail' : 'unknown');
        reasons.push(`${metric}: no published score (needs ${min}); internal ${internal.value ?? '—'}/100 is supporting evidence only`);
        continue;
      }
      if (cell.provenance === 'measured') {
        if (cell.value < min) return { target: role, status: 'not qualified' as const, reasons: [...reasons, `${metric}: AA ${cell.value} below ${min}`] };
        reasons.push(`${metric}: AA ${cell.value} meets ${min}`);
      } else {
        provisional = true;
        // An estimate below the bar can neither qualify the role nor rule it
        // out: only a measurement can do either. It leaves the metric unknown.
        if (cell.value < min) {
          support.push('unknown');
          reasons.push(`${metric}: ${cell.value} (${cell.provenance}) below ${min}; an estimate cannot settle it`);
        } else reasons.push(`${metric}: ${cell.value} (${cell.provenance}) meets ${min}, not a published figure`);
      }
    }
    const tools = toolEvidence(p);
    if (role === 'default' || role === 'task' || role === 'plan') {
      if (tools.ok === false) return { target: role, status: 'not qualified' as const, reasons: [...reasons, tools.reason] };
      const wantContext = role === 'default' ? 128_000 : role === 'task' ? 64_000 : null;
      if (wantContext && (p.route.contextWindow ?? 0) < wantContext) reasons.push(`context ${p.route.contextWindow ?? 'unknown'} below preferred ${wantContext}`);
      reasons.push(`tools: ${tools.reason}`);
      reasons.push('operational: 95% native tool success not established (needs a larger reliability sample)');
      provisional = true;
    }
    if (role === 'smol') {
      const speed = p.published.outputTokensPerSecond ?? p.measuredOutputTokensPerSecond;
      if (speed == null) { provisional = true; reasons.push('speed: unknown (target 80 tok/s)'); }
      else if (speed < 80) reasons.push(`speed: ${Math.round(speed)} tok/s below the 80 tok/s target`);
      else reasons.push(`speed: ${Math.round(speed)} tok/s`);
    }
    if (support.includes('fail')) return { target: role, status: 'not qualified' as const, reasons: [...reasons, 'internal screen failed on a metric this role needs'] };
    if (support.includes('unknown')) return { target: role, status: 'insufficient evidence' as const, reasons };
    if (support.length > 0) return { target: role, status: 'provisional' as const, reasons };
    return { target: role, status: provisional ? 'provisional' as const : 'qualified' as const, reasons };
  });
}

// ── Assembly ────────────────────────────────────────────────────────────────

export function buildPassport(run: RunResult, route: RouteInfo, published: PublishedEvidence, rules: ChainRule[], mins: Record<string, ChainMinimum>): Passport {
  const scenarios = Object.fromEntries((Object.keys(SCENARIOS) as ScenarioId[]).map(id => {
    const r = run.results[id]!;
    return [id, { status: r.status, score: r.score, mode: r.mode, cached: r.cached, inconsistent: r.inconsistent, runs: r.runs.length, note: r.note ?? null }];
  })) as Passport['internal']['scenarios'];
  const coding = capability(run, ['C1', 'C2', 'C3']);
  const agentic = capability(run, ['A1', 'A2', 'A3']);
  const u = run.usage;
  const throughput = u.throughput.length ? Math.round(u.throughput.reduce((a, b) => a + b, 0) / u.throughput.length) : null;
  const internal: Passport['internal'] = {
    scenarios, coding, agentic,
    reasoningProxy: byTag(run, 'reasoning'),
    instructionAdherence: byTag(run, 'instruction'),
    toolReliability: toolReliability(run),
    operationalReliability: {
      value: u.calls ? Math.round((u.calls - u.failedCalls) / u.calls * 1000) / 10 : null,
      evidence: u.calls ? 'partial' : 'none', basis: `${u.calls - u.failedCalls}/${u.calls} calls completed`,
      calls: u.calls, failedCalls: u.failedCalls,
    },
    comparable: coding.evidence === 'complete' && agentic.evidence === 'complete',
  };
  const total = u.promptTokens + u.completionTokens;
  const base = {
    route, internal, measuredOutputTokensPerSecond: throughput,
    published: {
      intelligence: published.scores.intelligence, coding: published.scores.coding, agentic: published.scores.agentic,
      source: published.aa ? `Artificial Analysis: ${published.aa.name} (${published.aa.slug})` : null,
      methodology: published.aa ? `index ${published.aa.indexVersion ?? 'version unknown'}, fetched ${published.aa.fetchedAt ?? 'unknown'}` : null,
      outputTokensPerSecond: published.aa?.outputTokensPerSecond ?? null,
      timeToFirstTokenSeconds: published.aa?.timeToFirstTokenSeconds ?? null,
    },
  };
  const missing = [
    ...(['intelligence', 'coding', 'agentic'] as const).filter(m => published.scores[m].value == null).map(m => `published ${m} score`),
    ...(Object.entries(scenarios).filter(([, s]) => s.status === 'NOT_TESTED' || s.status === 'INCONCLUSIVE' || s.status === 'UNSUPPORTED').map(([id, s]) => `${id} ${s.status.toLowerCase()}`)),
    'image input test', '95% native tool success (reliability sample)',
  ];
  const ok = (id: ScenarioId) => scenarios[id].status === 'PASS';
  const bad = (id: ScenarioId) => scenarios[id].status === 'FAIL' || scenarios[id].status === 'UNSUPPORTED';
  const bestFor = [
    ok('A1') && ok('A3') ? 'multi-step tool use with recovery' : null,
    ok('A1') ? 'single tool selection' : null,
    ok('A2') ? 'triage of untrusted input without acting on it' : null,
    ok('C1') && ok('C2') ? 'small code edits and implementations' : null,
    ok('C3') ? 'code review' : null,
  ].filter((x): x is string => x != null);
  const unsuitableFor = [
    bad('A1') || bad('A3') ? 'agent tool loops' : null,
    bad('A2') ? 'handling untrusted input with tools in reach' : null,
    bad('C1') || bad('C2') ? 'unsupervised code changes' : null,
    bad('C3') ? 'code review' : null,
  ].filter((x): x is string => x != null);
  return {
    ...base,
    benchVersion: run.benchVersion,
    generatedAt: new Date().toISOString(),
    configuration: { temperature: run.config.temperature, seed: run.config.seed, reasoningEffort: run.config.reasoningEffort ?? null, endpoint: run.config.endpoint ?? null },
    tokens: {
      prompt: u.promptTokens, completion: u.completionTokens, reasoning: u.reasoningTokens, total,
      planned: run.plannedTokens, budget: run.config.budgetTokens, estimated: u.estimated, repeatRuns: u.repeatRuns,
      differenceFromPlan: total - run.plannedTokens,
    },
    cost: 'free route; paid routes are refused before any call',
    missing, bestFor, unsuitableFor,
    chains: recommendChains(base, rules, mins),
    ompRoles: recommendRoles(base),
    stoppedBy: run.stoppedBy,
  };
}

const fmt = (v: number | null | undefined) => (v == null ? '—' : String(v));
const cellText = (c: ScoreCell) => (c.value == null ? '— (unknown)' : `${c.value} (${c.provenance})`);

export function renderMarkdown(p: Passport): string {
  const s = p.internal.scenarios;
  return [
    `# Model Passport — ${p.route.displayName}`,
    '',
    `\`${p.route.platform}/${p.route.modelId}\` · context ${fmt(p.route.contextWindow)} · bench v${p.benchVersion} · ${p.generatedAt}`,
    `Configuration: temperature ${p.configuration.temperature}, seed ${p.configuration.seed}, reasoning effort ${p.configuration.reasoningEffort ?? 'provider default'}`,
    p.stoppedBy ? `\n**Stopped early:** ${p.stoppedBy}` : '',
    '',
    '## Published scores (Artificial Analysis scale)',
    '',
    '| Metric | Value (provenance) |',
    '|---|---|',
    `| Intelligence | ${cellText(p.published.intelligence)} |`,
    `| Coding | ${cellText(p.published.coding)} |`,
    `| Agentic | ${cellText(p.published.agentic)} |`,
    `| Output speed | ${fmt(p.published.outputTokensPerSecond)} tok/s |`,
    '',
    `Source: ${p.published.source ?? 'none'}. ${p.published.methodology ?? ''}`,
    '',
    '## Internal screen (0–100, not comparable with AA indices)',
    '',
    '| Scenario | Status | Score | Mode | Runs | Note |',
    '|---|---|---:|---|---:|---|',
    ...(Object.keys(s) as ScenarioId[]).map(id => `| ${id} ${SCENARIOS[id].title} | ${s[id].status}${s[id].inconsistent ? ' (inconsistent)' : ''} | ${fmt(s[id].score)} | ${s[id].mode}${s[id].cached ? ', cached' : ''} | ${s[id].runs} | ${s[id].note ?? ''} |`),
    '',
    '| Metric | Value | Evidence | Basis |',
    '|---|---:|---|---|',
    ...([
      ['Coding', p.internal.coding], ['Agentic', p.internal.agentic], ['Reasoning proxy (narrow)', p.internal.reasoningProxy],
      ['Instruction adherence', p.internal.instructionAdherence], ['Tool reliability', p.internal.toolReliability],
      ['Operational reliability', p.internal.operationalReliability],
    ] as [string, Metric][]).map(([name, m]) => `| ${name} | ${fmt(m.value)} | ${m.evidence} | ${m.basis} |`),
    '',
    `Native tool support: ${p.internal.toolReliability.nativeSupport}. Comparable with other complete screens: ${p.internal.comparable ? 'yes' : 'no (partial)'}.`,
    '',
    '## Tokens',
    '',
    `${p.tokens.total} used (${p.tokens.prompt} prompt, ${p.tokens.completion} output, ${p.tokens.reasoning} reasoning) of a ${p.tokens.budget} budget; plan ceiling ${p.tokens.planned} (${p.tokens.differenceFromPlan >= 0 ? '+' : ''}${p.tokens.differenceFromPlan}). Repeat runs: ${p.tokens.repeatRuns}.${p.tokens.estimated ? ' Some counts are estimates (no usage returned).' : ''} Measured throughput: ${fmt(p.measuredOutputTokensPerSecond)} tok/s (includes time to first token). Cost: ${p.cost}.`,
    '',
    '## Recommendations',
    '',
    '| Chain | Status | Reasons |',
    '|---|---|---|',
    ...p.chains.map(r => `| ${r.target} | ${r.status} | ${r.reasons.join('; ')} |`),
    '',
    '| OMP role | Status | Reasons |',
    '|---|---|---|',
    ...p.ompRoles.map(r => `| ${r.target} | ${r.status} | ${r.reasons.join('; ')} |`),
    '',
    `Best for: ${p.bestFor.join(', ') || '—'}. Unsuitable for: ${p.unsuitableFor.join(', ') || '—'}.`,
    `Missing: ${p.missing.join(', ')}.`,
    '',
    'Role thresholds are provisional working cut-offs on published AA scores, not AA categories. Internal scores are never compared against them.',
    '',
  ].join('\n');
}
