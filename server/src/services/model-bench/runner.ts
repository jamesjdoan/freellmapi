import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { ChatCompletionResponse, ChatMessage, ChatToolChoice, ChatToolDefinition } from '@freellmapi/shared/types.js';
import type { ReasoningEffort } from '../../lib/sampling-params.js';
import { BENCH_VERSION, SCENARIOS, STAGE_1, STAGE_2, a3ToolReply, estimatePromptTokens, type Scenario, type ScenarioId } from './fixtures.js';
import { FAIL_BELOW, PASS_AT, grade, parseArgs, type Grade, type Status, type ToolCallRecord, type Transcript, type Turn } from './grade.js';

// Runs the scenarios against ONE route through an injected caller. The CLI
// wires the caller straight to a provider adapter, so there is no router and
// no chain fallback underneath: a failure is this model's failure.

export interface CallOptions {
  max_tokens: number;
  temperature: number;
  seed?: number;
  reasoning_effort?: ReasoningEffort;
  tools?: ChatToolDefinition[];
  tool_choice?: ChatToolChoice;
}
export type Caller = (messages: ChatMessage[], options: CallOptions) => Promise<ChatCompletionResponse>;

export interface RunConfig {
  platform: string;
  modelId: string;
  /** Distinguishes two relays serving the same id. */
  endpoint?: string;
  temperature: number;
  seed: number;
  reasoningEffort?: ReasoningEffort;
  /** Hard ceiling on tokens spent this run, prompt plus output. */
  budgetTokens: number;
  /** Runs per scenario when the first is borderline. */
  maxRuns: number;
  /** Ignore cached results. */
  fresh: boolean;
  /** Only these scenarios; otherwise the two-stage screen. */
  only?: ScenarioId[];
  /** Stop after stage 1. */
  screenOnly?: boolean;
  cacheDir: string;
}

export interface Usage {
  calls: number;
  failedCalls: number;
  repeatRuns: number;
  promptTokens: number;
  completionTokens: number;
  reasoningTokens: number;
  /** Some reply carried no usage, so a count is the gateway's estimate. */
  estimated: boolean;
  /** Completion tokens per second of wall time, per successful call. */
  throughput: number[];
}

export interface ScenarioResult {
  id: ScenarioId;
  status: Status;
  score: number | null;
  runs: Grade[];
  transcripts: Transcript[];
  mode: Transcript['mode'];
  cached: boolean;
  /** Runs disagreed on PASS vs FAIL. */
  inconsistent: boolean;
  note?: string;
}

export interface RunResult {
  benchVersion: string;
  config: Omit<RunConfig, 'cacheDir' | 'fresh'>;
  results: Partial<Record<ScenarioId, ScenarioResult>>;
  usage: Usage;
  /** Why the run stopped short of the plan, if it did. */
  stoppedBy: string | null;
  plannedTokens: number;
  startedAt: string;
}

class BudgetExceeded extends Error {}

const emptyUsage = (): Usage => ({
  calls: 0, failedCalls: 0, repeatRuns: 0, promptTokens: 0, completionTokens: 0, reasoningTokens: 0, estimated: false, throughput: [],
});

const spent = (u: Usage) => u.promptTokens + u.completionTokens;

function textOf(m: ChatMessage | undefined): string {
  const c = m?.content;
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) return c.map(p => (typeof p === 'string' ? p : 'text' in p && typeof p.text === 'string' ? p.text : '')).join('');
  return '';
}

function toolsRefused(err: unknown): boolean {
  const status = (err as { status?: number }).status;
  const message = err instanceof Error ? err.message : String(err);
  return (status === 400 || status === 404 || status === 422 || status === 501) && /tool|function/i.test(message);
}

/** The tools described in text, for an endpoint without native calling. */
function simulate(s: Scenario): ChatMessage[] {
  const schema = s.tools.map(t => ({ name: t.function.name, description: t.function.description, parameters: t.function.parameters }));
  const suffix = [
    '',
    'Tools (not natively callable here):',
    JSON.stringify(schema),
    'To call a tool, reply with only {"tool": "<name>", "arguments": {...}}. Otherwise answer normally.',
  ].join('\n');
  return s.messages.map((m, i) => (i === s.messages.length - 1 ? { ...m, content: `${textOf(m)}${suffix}` } : m));
}

function simulatedCalls(content: string): ToolCallRecord[] {
  try {
    const v = JSON.parse(content.trim().replace(/^```(?:json)?\n|\n```$/g, '')) as { tool?: unknown; arguments?: unknown };
    if (typeof v?.tool !== 'string') return [];
    const raw = JSON.stringify(v.arguments ?? {});
    return [{ name: v.tool, rawArguments: raw, args: parseArgs(raw) }];
  } catch { return []; }
}

export function cacheKey(cfg: Pick<RunConfig, 'platform' | 'modelId' | 'endpoint' | 'temperature' | 'seed' | 'reasoningEffort'>, id: ScenarioId): string {
  const s = SCENARIOS[id];
  return createHash('sha256').update(JSON.stringify({
    v: BENCH_VERSION, id, maxTokens: s.maxTokens, platform: cfg.platform, model: cfg.modelId, endpoint: cfg.endpoint ?? '',
    temperature: cfg.temperature, seed: cfg.seed, effort: cfg.reasoningEffort ?? null,
  })).digest('hex').slice(0, 24);
}

/** Upper bound on what the plan can spend, for the budget preview. */
export function plannedTokens(ids: ScenarioId[]): number {
  return ids.reduce((sum, id) => {
    const s = SCENARIOS[id];
    // Multi-turn prompts grow with each reply; bound by turns × (prompt + cap).
    return sum + s.maxTurns * (estimatePromptTokens(s) + s.maxTokens);
  }, 0);
}

export async function runBenchmark(call: Caller, cfg: RunConfig): Promise<RunResult> {
  const usage = emptyUsage();
  const results: Partial<Record<ScenarioId, ScenarioResult>> = {};
  let stoppedBy: string | null = null;
  mkdirSync(cfg.cacheDir, { recursive: true });

  const invoke = async (s: Scenario, messages: ChatMessage[], tools: boolean): Promise<ChatCompletionResponse> => {
    const projected = spent(usage) + Math.ceil(JSON.stringify(messages).length / 4) + s.maxTokens;
    if (projected > cfg.budgetTokens) throw new BudgetExceeded(`token budget ${cfg.budgetTokens} would be exceeded (spent ${spent(usage)}, next call up to ${projected - spent(usage)})`);
    usage.calls++;
    const started = Date.now();
    try {
      const res = await call(messages, {
        max_tokens: s.maxTokens, temperature: cfg.temperature, seed: cfg.seed,
        ...(cfg.reasoningEffort ? { reasoning_effort: cfg.reasoningEffort } : {}),
        ...(tools ? { tools: s.tools, tool_choice: 'auto' as const } : {}),
      });
      const u = res.usage;
      usage.promptTokens += u?.prompt_tokens ?? 0;
      usage.completionTokens += u?.completion_tokens ?? 0;
      usage.reasoningTokens += u?.completion_tokens_details?.reasoning_tokens ?? 0;
      if (!u || u.estimated) usage.estimated = true;
      const secs = (Date.now() - started) / 1000;
      if (secs > 0 && (u?.completion_tokens ?? 0) > 0) usage.throughput.push(u.completion_tokens / secs);
      return res;
    } catch (err) {
      usage.failedCalls++;
      throw err;
    }
  };

  const turnOf = (res: ChatCompletionResponse, mode: Transcript['mode']): Turn => {
    const msg = res.choices?.[0]?.message;
    const content = textOf(msg);
    const toolCalls = mode === 'simulated'
      ? simulatedCalls(content)
      : (msg?.tool_calls ?? []).map(tc => ({ name: tc.function.name, rawArguments: tc.function.arguments, args: parseArgs(tc.function.arguments) }));
    return { content, toolCalls, finishReason: res.choices?.[0]?.finish_reason ?? null };
  };

  const once = async (s: Scenario): Promise<Transcript> => {
    const wantsTools = s.tools.length > 0;
    let mode: Transcript['mode'] = wantsTools ? 'native' : 'none';
    let messages: ChatMessage[] = [...s.messages];
    const turns: Turn[] = [];
    for (let i = 0; i < s.maxTurns; i++) {
      let res: ChatCompletionResponse;
      try {
        res = await invoke(s, messages, mode === 'native');
      } catch (err) {
        if (err instanceof BudgetExceeded) throw err;
        if (mode === 'native' && i === 0 && toolsRefused(err)) {
          if (!s.simulable) return { mode, turns, toolsUnsupported: true, error: err instanceof Error ? err.message : String(err) };
          mode = 'simulated';
          messages = simulate(s);
          i--;
          continue;
        }
        return { mode, turns, error: err instanceof Error ? err.message.slice(0, 300) : String(err) };
      }
      const turn = turnOf(res, mode);
      turns.push(turn);
      if (s.id !== 'A3' || turn.toolCalls.length === 0) break;
      // A3: answer each call from the scripted world and continue.
      const assistant = res.choices[0].message;
      messages = [...messages, { role: 'assistant', content: assistant.content ?? '', tool_calls: assistant.tool_calls, ...(assistant.reasoning_content ? { reasoning_content: assistant.reasoning_content } : {}) }];
      for (const [k, tc] of (assistant.tool_calls ?? []).entries()) {
        messages.push({ role: 'tool', tool_call_id: tc.id, content: a3ToolReply(turn.toolCalls[k]?.name ?? '', turn.toolCalls[k]?.args ?? {}) });
      }
    }
    return { mode, turns };
  };

  const runScenario = async (id: ScenarioId): Promise<void> => {
    const s = SCENARIOS[id];
    const file = path.join(cfg.cacheDir, `${cacheKey(cfg, id)}.json`);
    if (!cfg.fresh && existsSync(file)) {
      const hit = JSON.parse(readFileSync(file, 'utf8')) as ScenarioResult;
      results[id] = { ...hit, cached: true };
      return;
    }
    const runs: Grade[] = [];
    const transcripts: Transcript[] = [];
    for (let run = 0; run < cfg.maxRuns; run++) {
      if (run > 0) usage.repeatRuns++;
      const t = await once(s);
      transcripts.push(t);
      runs.push(grade(id, t));
      const last = runs.at(-1)!;
      // Repeat only a borderline score; a clear pass, a clear fail, an
      // unsupported interface or a dead endpoint will not change by retrying.
      const borderline = last.score != null && last.score >= FAIL_BELOW && last.score < PASS_AT;
      if (!borderline) break;
    }
    const scored = runs.filter(r => r.score != null).map(r => r.score!).sort((a, b) => a - b);
    const median = scored.length ? scored[Math.floor((scored.length - 1) / 2)] : null;
    const lastRun = runs.at(-1)!;
    const status: Status = median == null ? lastRun.status
      : lastRun.status === 'INCONCLUSIVE' && runs.length === 1 && lastRun.checks.length === 0 ? lastRun.status
      : median >= PASS_AT ? 'PASS' : median < FAIL_BELOW ? 'FAIL' : 'INCONCLUSIVE';
    const result: ScenarioResult = {
      id, status, score: median, runs, transcripts, mode: transcripts.at(-1)!.mode, cached: false,
      inconsistent: runs.some(r => r.status === 'PASS') && runs.some(r => r.status === 'FAIL'),
      note: lastRun.note,
    };
    results[id] = result;
    // Only a graded outcome is cached; an endpoint error deserves a retry later.
    if (!transcripts.some(t => t.error && t.turns.length === 0)) writeFileSync(file, JSON.stringify(result, null, 2));
  };

  const plan = cfg.only ?? STAGE_1;
  const runAll = async (ids: ScenarioId[]) => {
    for (const id of ids) {
      if (stoppedBy) { results[id] = notTested(id, stoppedBy); continue; }
      try {
        await runScenario(id);
      } catch (err) {
        if (!(err instanceof BudgetExceeded)) throw err;
        stoppedBy = err.message;
        results[id] = notTested(id, stoppedBy);
      }
    }
  };

  await runAll(plan);
  if (!cfg.only && !cfg.screenOnly && !stoppedBy) {
    // Stage 2 only where stage 1 shows promise, judged per capability so a
    // coding-only model is not dropped for weak tool use, or the reverse.
    // Borderline counts as promising; an endpoint that never answered does not.
    const promising = (ids: ScenarioId[]) => ids.some(id => results[id]?.status === 'PASS' || (results[id]?.status === 'INCONCLUSIVE' && results[id]?.score != null));
    const next: ScenarioId[] = [];
    if (promising(['A1'])) next.push('A2', 'A3');
    if (promising(['C1', 'C3'])) next.push('C2');
    for (const id of STAGE_2) if (!next.includes(id)) results[id] = notTested(id, 'screened out at stage 1');
    await runAll(next);
  }
  for (const id of Object.keys(SCENARIOS) as ScenarioId[]) {
    if (!results[id]) results[id] = notTested(id, cfg.only ? 'not selected' : cfg.screenOnly ? 'screen only' : 'not run');
  }

  const { cacheDir: _c, fresh: _f, ...config } = cfg;
  return {
    benchVersion: BENCH_VERSION, config, results, usage, stoppedBy,
    plannedTokens: plannedTokens(cfg.only ?? [...STAGE_1, ...STAGE_2]), startedAt: new Date().toISOString(),
  };
}

function notTested(id: ScenarioId, why: string): ScenarioResult {
  return { id, status: 'NOT_TESTED', score: null, runs: [], transcripts: [], mode: 'none', cached: false, inconsistent: false, note: why };
}
