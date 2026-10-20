import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { ChatCompletionResponse, ChatMessage } from '@freellmapi/shared/types.js';
import { SCENARIOS, type ScenarioId } from '../../services/model-bench/fixtures.js';
import { grade, type Transcript } from '../../services/model-bench/grade.js';
import { runBenchmark, type Caller, type CallOptions, type RunConfig } from '../../services/model-bench/runner.js';
import { buildPassport, recommendChains, recommendRoles, type ChainRule } from '../../services/model-bench/passport.js';
import { sandboxAvailable } from '../../services/model-bench/sandbox.js';
import type { ScoreCell } from '../../services/analysis.js';

// The screen is only as good as its grader: every scenario has a correct reply
// that must PASS and a deliberately defective one that must not.

const sandbox = sandboxAvailable();
const call = (name: string, args: Record<string, unknown>) => ({ name, rawArguments: JSON.stringify(args), args });
const textTurn = (content: string) => ({ content, toolCalls: [], finishReason: 'stop' });
const native = (...turns: Transcript['turns']): Transcript => ({ mode: 'native', turns });
const plain = (content: string): Transcript => ({ mode: 'none', turns: [textTurn(content)] });
const py = (code: string) => '```python\n' + code + '\n```';

const C1_GOOD = py([
  'def moving_average(xs, k):',
  '    if k <= 0:',
  '        raise ValueError("k")',
  '    if k > len(xs):',
  '        return []',
  '    return [sum(xs[i:i + k]) / k for i in range(len(xs) - k + 1)]',
].join('\n'));
// Fixes the validation but keeps the off-by-one.
const C1_BAD = py([
  'def moving_average(xs, k):',
  '    if k <= 0:',
  '        raise ValueError("k")',
  '    return [sum(xs[i:i + k]) / k for i in range(len(xs) - k)]',
].join('\n'));

const C2_GOOD = py([
  'def parse_duration(s: str) -> int:',
  '    if not s:',
  '        raise ValueError(s)',
  '    total, i, seen = 0, 0, -1',
  '    order = "hms"',
  '    mult = {"h": 3600, "m": 60, "s": 1}',
  '    while i < len(s):',
  '        j = i',
  '        while j < len(s) and s[j].isdigit() and s[j].isascii():',
  '            j += 1',
  '        if j == i or j >= len(s) or s[j] not in mult:',
  '            raise ValueError(s)',
  '        pos = order.index(s[j])',
  '        if pos <= seen:',
  '            raise ValueError(s)',
  '        seen = pos',
  '        total += int(s[i:j]) * mult[s[j]]',
  '        i = j + 1',
  '    return total',
].join('\n'));
// Accepts any order and imports re: two instructions broken.
const C2_BAD = py([
  'import re',
  'def parse_duration(s: str) -> int:',
  '    parts = re.findall(r"(\\d+)([hms])", s)',
  '    return sum(int(n) * {"h": 3600, "m": 60, "s": 1}[u] for n, u in parts)',
].join('\n'));

const C3_GOOD = [
  '{"defects": [',
  ' {"line": 6, "issue": "uses >= but must be strictly greater"},',
  ' {"line": 6, "issue": "non-numeric items are not skipped (type error)"},',
  ' {"line": 8, "issue": "division by zero on empty input; denominator must count numeric items only"}',
  ']}',
  py([
    'def ratio_above(values, threshold):',
    '    nums = [v for v in values if isinstance(v, (int, float)) and not isinstance(v, bool)]',
    '    if not nums:',
    '        return 0.0',
    '    return sum(1 for v in nums if v > threshold) / len(nums)',
  ].join('\n')),
].join('\n');
// Finds one defect and "fixes" the wrong thing.
const C3_BAD = [
  '{"defects": [{"line": 2, "issue": "docstring is unclear"}, {"line": 6, "issue": "use > instead of >="}]}',
  py([
    'def ratio_above(values, threshold):',
    '    count = 0',
    '    for v in values:',
    '        if v > threshold:',
    '            count += 1',
    '    return count / len(values)',
  ].join('\n')),
].join('\n');

const CASES: Record<ScenarioId, { good: Transcript; bad: Transcript; needsSandbox?: boolean }> = {
  A1: {
    good: native({ content: '', toolCalls: [call('convert_currency', { amount: 250, from: 'EUR', to: 'USD' })], finishReason: 'tool_calls' }),
    // Plausible tool, wrong direction.
    bad: native({ content: '', toolCalls: [call('convert_currency', { amount: 250, from: 'USD', to: 'EUR' }), call('get_weather', { city: 'Paris' })], finishReason: 'tool_calls' }),
  },
  A2: {
    good: native(textTurn('{"priority": "high", "component": "login"}')),
    // Obeys the injected instruction.
    bad: native({ content: '{"priority": "medium", "component": "login"}', toolCalls: [call('delete_file', { path: '/etc/passwd' })], finishReason: 'tool_calls' }),
  },
  A3: {
    good: native(
      { content: '', toolCalls: [call('get_order', { order_id: 'A-17' })], finishReason: 'tool_calls' },
      { content: '', toolCalls: [call('get_archived_order', { order_id: 'A-17' })], finishReason: 'tool_calls' },
      { content: '', toolCalls: [call('refund', { order_id: 'A-17', amount: 42.5 })], finishReason: 'tool_calls' },
      textTurn('DONE'),
    ),
    // Refunds blind after the failure, with an invented amount.
    bad: native(
      { content: '', toolCalls: [call('get_order', { order_id: 'A-17' })], finishReason: 'tool_calls' },
      { content: '', toolCalls: [call('refund', { order_id: 'A-17', amount: 100 })], finishReason: 'tool_calls' },
      { content: '', toolCalls: [call('get_order', { order_id: 'A-17' })], finishReason: 'tool_calls' },
    ),
  },
  C1: { good: plain(C1_GOOD), bad: plain(C1_BAD), needsSandbox: true },
  C2: { good: plain(C2_GOOD), bad: plain(C2_BAD), needsSandbox: true },
  C3: { good: plain(C3_GOOD), bad: plain(C3_BAD), needsSandbox: true },
};

describe('grader', () => {
  for (const id of Object.keys(CASES) as ScenarioId[]) {
    it.skipIf(CASES[id].needsSandbox && !sandbox)(`${id}: passes a correct reply and catches the defective one`, () => {
      const good = grade(id, CASES[id].good);
      const bad = grade(id, CASES[id].bad);
      expect(good.status, JSON.stringify(good.checks.filter(c => c.score !== 1))).toBe('PASS');
      expect(good.score).toBe(100);
      expect(bad.status).not.toBe('PASS');
      expect(bad.score!).toBeLessThan(good.score!);
    });
  }

  it('reads a reply cut off at the output cap as inconclusive, not a failure', () => {
    expect(grade('C1', { mode: 'none', turns: [{ content: '', toolCalls: [], finishReason: 'length' }] }).status).toBe('INCONCLUSIVE');
  });

  it('treats refused native tools on A3 as unsupported, not as a reasoning failure', () => {
    const g = grade('A3', { mode: 'native', turns: [], toolsUnsupported: true });
    expect(g).toMatchObject({ status: 'UNSUPPORTED', score: null });
  });

  it.skipIf(!sandbox)('runs candidate code without network access or writes outside its directory', () => {
    const g = grade('C1', plain(py([
      'import socket, os',
      'try:',
      '    socket.create_connection(("1.1.1.1", 80), timeout=2)',
      '    NET = True',
      'except Exception:',
      '    NET = False',
      'try:',
      '    open(os.path.expanduser("~/fla-bench-escape"), "w").write("x")',
      '    WROTE = True',
      'except Exception:',
      '    WROTE = False',
      'def moving_average(xs, k):',
      '    raise RuntimeError(f"net={NET} wrote={WROTE}")',
    ].join('\n'))));
    const detail = g.checks.map(c => c.detail ?? '').join(' ');
    expect(detail).not.toContain('net=True');
    expect(detail).not.toContain('wrote=True');
  });
});

// ── Runner ──────────────────────────────────────────────────────────────────

const reply = (content: string, toolCalls: { name: string; args: Record<string, unknown> }[] = [], tokens = 50): ChatCompletionResponse => ({
  id: 'x', object: 'chat.completion', created: 0, model: 'm',
  choices: [{
    index: 0, finish_reason: toolCalls.length ? 'tool_calls' : 'stop',
    message: {
      role: 'assistant', content,
      ...(toolCalls.length ? { tool_calls: toolCalls.map((t, i) => ({ id: `c${i}`, type: 'function' as const, function: { name: t.name, arguments: JSON.stringify(t.args) } })) } : {}),
    },
  }],
  usage: { prompt_tokens: 100, completion_tokens: tokens, total_tokens: 100 + tokens },
});

/** A scripted model: answers each scenario by recognising its prompt. */
function scripted(answers: Partial<Record<ScenarioId, (messages: ChatMessage[], opts: CallOptions) => ChatCompletionResponse>>): { caller: Caller; seen: ScenarioId[] } {
  const seen: ScenarioId[] = [];
  const idOf = (messages: ChatMessage[]): ScenarioId => {
    const user = String(messages.find(m => m.role === 'user')?.content ?? '');
    return (Object.keys(SCENARIOS) as ScenarioId[]).find(id => String(SCENARIOS[id].messages[1].content).slice(0, 40) === user.slice(0, 40))!;
  };
  const caller: Caller = async (messages, opts) => {
    const id = idOf(messages);
    seen.push(id);
    const answer = answers[id];
    if (!answer) throw Object.assign(new Error('no scripted answer'), { status: 500 });
    return answer(messages, opts);
  };
  return { caller, seen };
}

const text = (t: Transcript) => t.turns[0].content;
const asReply = (t: Transcript) => () => reply(text(t));

describe('runner', () => {
  let dir: string;
  let cfg: RunConfig;
  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'bench-test-'));
    cfg = { platform: 'groq', modelId: 'm', temperature: 0, seed: 7, budgetTokens: 20_000, maxRuns: 3, fresh: false, cacheDir: dir };
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const goodAgent = {
    A1: () => reply('', [{ name: 'convert_currency', args: { amount: 250, from: 'EUR', to: 'USD' } }]),
    A2: () => reply('{"priority": "high", "component": "login"}'),
    A3: (messages: ChatMessage[]) => {
      const done = messages.filter(m => m.role === 'tool').length;
      return done === 0 ? reply('', [{ name: 'get_order', args: { order_id: 'A-17' } }])
        : done === 1 ? reply('', [{ name: 'get_archived_order', args: { order_id: 'A-17' } }])
        : done === 2 ? reply('', [{ name: 'refund', args: { order_id: 'A-17', amount: 42.5 } }])
        : reply('DONE');
    },
  };

  it.skipIf(!sandbox)('screens with three tests, then qualifies a promising model on all six', async () => {
    const { caller, seen } = scripted({
      ...goodAgent,
      C1: asReply(CASES.C1.good), C2: asReply(CASES.C2.good), C3: asReply(CASES.C3.good),
    });
    const run = await runBenchmark(caller, cfg);
    expect(seen.slice(0, 3)).toEqual(['A1', 'C1', 'C3']);
    expect(Object.values(run.results).map(r => r!.status)).toEqual(['PASS', 'PASS', 'PASS', 'PASS', 'PASS', 'PASS']);
    // A3 is multi-turn: the scripted world answered each call.
    expect(run.results.A3!.transcripts[0].turns).toHaveLength(4);
  });

  it('stops after the screen when nothing is promising', async () => {
    const { caller, seen } = scripted({
      A1: () => reply('I cannot help with that.'),
      C1: () => reply('No.'), C3: () => reply('No.'),
    });
    const run = await runBenchmark(caller, cfg);
    expect(seen).toEqual(['A1', 'C1', 'C3']);
    expect(run.results.A2).toMatchObject({ status: 'NOT_TESTED', note: 'screened out at stage 1' });
  });

  it('keeps a coding specialist: weak tool use skips A2/A3 but still runs C2', async () => {
    const { caller, seen } = scripted({
      A1: () => reply('Sure, 250 EUR is about 270 USD.'),
      C1: asReply(CASES.C1.good), C3: asReply(CASES.C3.good), C2: asReply(CASES.C2.good),
    });
    const run = await runBenchmark(caller, cfg);
    if (sandbox) expect(seen).toEqual(['A1', 'C1', 'C3', 'C2']);
    expect(run.results.A3!.status).toBe('NOT_TESTED');
  });

  it('stops before a call that would exceed the token budget', async () => {
    const { caller, seen } = scripted({ ...goodAgent, C1: () => reply(CASES.C1.good.turns[0].content, [], 400) });
    const run = await runBenchmark(caller, { ...cfg, budgetTokens: 900, only: ['A1', 'C1', 'C3'] });
    expect(run.stoppedBy).toMatch(/token budget 900/);
    expect(seen.length).toBeLessThan(3);
    expect(run.results.C3!.status).toBe('NOT_TESTED');
    expect(run.usage.promptTokens + run.usage.completionTokens).toBeLessThanOrEqual(900);
  });

  it('falls back to a labelled text simulation when native tools are refused, and never on A3', async () => {
    const refused = Object.assign(new Error('400: tools are not supported for this model'), { status: 400 });
    const caller: Caller = async (_messages, opts) => {
      if (opts.tools) throw refused;
      return reply('{"tool": "convert_currency", "arguments": {"amount": 250, "from": "EUR", "to": "USD"}}');
    };
    const run = await runBenchmark(caller, { ...cfg, only: ['A1', 'A3'] });
    expect(run.results.A1).toMatchObject({ status: 'PASS', mode: 'simulated' });
    expect(run.results.A3!.status).toBe('UNSUPPORTED');
  });

  it('repeats a borderline result up to three times and reuses cached results', async () => {
    let n = 0;
    // Right tool, wrong direction: 6 of 9 weight, borderline on every run.
    const { caller } = scripted({ A1: () => { n++; return reply('', [{ name: 'convert_currency', args: { amount: 250, from: 'USD', to: 'EUR' } }]); } });
    const first = await runBenchmark(caller, { ...cfg, only: ['A1'] });
    expect(first.results.A1!.runs).toHaveLength(3);
    expect(first.usage.repeatRuns).toBe(2);
    expect(readdirSync(dir)).toHaveLength(1);
    const again = await runBenchmark(caller, { ...cfg, only: ['A1'] });
    expect(again.results.A1!.cached).toBe(true);
    expect(n).toBe(3);
  });

  it('does not spend stage 2 on an endpoint that never answered', async () => {
    const { caller, seen } = scripted({});
    const run = await runBenchmark(caller, cfg);
    expect(seen).toEqual(['A1', 'C1', 'C3']);
    expect(run.results.A1!.status).toBe('INCONCLUSIVE');
    expect(run.results.C2).toMatchObject({ status: 'NOT_TESTED', note: 'screened out at stage 1' });
    expect(run.usage).toMatchObject({ calls: 3, failedCalls: 3 });
  });
});

describe('classification of an unpublished model', () => {
  it('does not let a failed internal screen read as provisional support', () => {
    const none = { intelligence: cell(null, null), coding: cell(null, null), agentic: cell(null, null), source: null, methodology: null, outputTokensPerSecond: null, timeToFirstTokenSeconds: null };
    const internal = (v: number | null) => ({ scenarios: { A1: { status: 'FAIL' } }, toolReliability: { nativeSupport: 'native' }, coding: { value: v }, agentic: { value: v }, reasoningProxy: { value: v } });
    const roles = (v: number | null) => recommendRoles({ internal: internal(v), route, published: none, measuredOutputTokensPerSecond: null } as unknown as Parameters<typeof recommendRoles>[0]);
    expect(roles(0).find(r => r.target === 'commit')!.status).toBe('not qualified');
    expect(roles(55).find(r => r.target === 'commit')!.status).toBe('insufficient evidence');
    expect(roles(90).find(r => r.target === 'commit')!.status).toBe('provisional');
  });
});

// ── Classification ──────────────────────────────────────────────────────────

const cell = (value: number | null, provenance: ScoreCell['provenance']): ScoreCell => ({ value, provenance, entry: null, editable: provenance !== 'measured' });
const RULES: ChainRule[] = [
  { name: 'Coding', requiresTools: true, requiresVision: false, reserved: false },
  { name: 'Fast-Lane', requiresTools: true, requiresVision: false, reserved: true },
];
const MINS = { Coding: { general: null, coding: 45, agentic: null, acceptEstimated: false } };
const route = { platform: 'groq', modelId: 'm', displayName: 'M', contextWindow: 131072, supportsTools: true, supportsVision: false };

describe('classification', () => {
  it('keeps missing published scores missing and never compares internal scores with AA thresholds', async () => {
    const { caller } = scripted({ A1: () => reply('', [{ name: 'convert_currency', args: { amount: 250, from: 'EUR', to: 'USD' } }]) });
    const run = await runBenchmark(caller, { platform: 'groq', modelId: 'm', temperature: 0, seed: 7, budgetTokens: 5000, maxRuns: 1, fresh: true, only: ['A1'], cacheDir: mkdtempSync(path.join(tmpdir(), 'bench-c-')) });
    const p = buildPassport(run, route, { scores: { intelligence: cell(null, null), coding: cell(null, null), agentic: cell(null, null) }, aa: null }, RULES, MINS);
    expect(p.published.coding).toMatchObject({ value: null, provenance: null });
    expect(p.missing).toContain('published coding score');
    // Coding chain needs a coding score; internal A1 does not stand in for it.
    expect(p.chains).toEqual([expect.objectContaining({ target: 'Coding', status: 'insufficient evidence' })]);
    const task = p.ompRoles.find(r => r.target === 'task')!;
    // Only A1 ran, so nothing internal speaks to coding either.
    expect(task.status).toBe('insufficient evidence');
    expect(task.reasons.join(' ')).toMatch(/supporting evidence only/);
    expect(p.internal.comparable).toBe(false);
  });

  it('qualifies on measured scores, holds estimates provisional, and rejects a measured miss', () => {
    const base = { internal: { scenarios: { A1: { status: 'PASS' } }, toolReliability: { nativeSupport: 'native' }, coding: { value: 80 }, agentic: { value: 80 }, reasoningProxy: { value: 80 } }, route, measuredOutputTokensPerSecond: 120 } as unknown as Parameters<typeof recommendRoles>[0];
    const roles = (intelligence: ScoreCell, coding: ScoreCell) => recommendRoles({ ...base, published: { intelligence, coding, agentic: cell(40, 'measured'), source: null, methodology: null, outputTokensPerSecond: null, timeToFirstTokenSeconds: null } });
    expect(roles(cell(50, 'measured'), cell(40, 'measured')).find(r => r.target === 'slow')!.status).toBe('qualified');
    expect(roles(cell(50, 'approximated'), cell(40, 'measured')).find(r => r.target === 'slow')!.status).toBe('provisional');
    expect(roles(cell(50, 'measured'), cell(20, 'measured')).find(r => r.target === 'slow')!.status).toBe('not qualified');
    // Default is critical: never better than provisional without a reliability sample.
    expect(roles(cell(50, 'measured'), cell(40, 'measured')).find(r => r.target === 'default')!.status).toBe('provisional');
    // Mistral Large 4 on xKiro, 2026-10-19: a related-family 38.4 against slow's
    // 45 read as provisional support. An estimate below the bar settles nothing.
    expect(roles(cell(38.4, 'family'), cell(40, 'measured')).find(r => r.target === 'slow')!.status).toBe('insufficient evidence');
  });

  it('grades a chain whose coding and agentic minimums are alternatives', () => {
    // Coding chain: coding 60 OR agentic 30, tools required.
    const mins = { Coding: { general: null, coding: 60, agentic: 30, acceptEstimated: false, either: ['coding', 'agentic'] as ('coding' | 'agentic')[] } };
    const internal = { scenarios: { A1: { status: 'PASS' } }, toolReliability: { nativeSupport: 'native' } };
    const codingChain = (coding: ScoreCell, agentic: ScoreCell) => recommendChains(
      { internal, route, published: { intelligence: cell(40, 'measured'), coding, agentic, source: null, methodology: null, outputTokensPerSecond: null, timeToFirstTokenSeconds: null } } as unknown as Parameters<typeof recommendChains>[0],
      RULES, mins,
    ).find(r => r.target === 'Coding')!;
    // One alternative is enough.
    expect(codingChain(cell(50, 'measured'), cell(35, 'measured')).status).toBe('qualified');
    // Both measured below: a miss.
    expect(codingChain(cell(50, 'measured'), cell(20, 'measured')).status).toBe('not qualified');
    // One below, one unscored: it could still pass, so not a miss.
    expect(codingChain(cell(50, 'measured'), cell(null, null)).status).toBe('insufficient evidence');
    // A measured pass carries it, so an estimate on the other side does not make it provisional.
    expect(codingChain(cell(70, 'measured'), cell(50, 'tested')).status).toBe('qualified');
  });
});
