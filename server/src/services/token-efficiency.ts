import { z } from 'zod';
import type { TokenEfficiency } from '@freellmapi/shared/types.js';
import type { Db } from '../db/types.js';
import { getDb } from '../db/index.js';
import { loadAaScoring } from './aa-scoring.js';

// Token efficiency: how many tokens a model spends to finish a task
// (ADR ARCH-20261020).
//
// Three answers, and never a blend of them:
//
//   1. An ESTIMATE from Artificial Analysis. AA publishes the USD cost of one
//      task of their Intelligence Index and the model's input and output
//      prices, but no token counts and no input/output split of that cost. So
//      the token count is derived: cost per task ÷ a blended price. It is
//      shown as a RANGE (all tokens at the dearer price to all at the
//      cheaper), because AA gives no input/output split; the 3:1 blend sorts.
//
//   2. A MEASUREMENT from our own screening benchmark, imported by hand.
//      Shown as a token count and never ranked against the AA estimate: the
//      two are different measures on different workloads, and comparing them
//      as if they were the same would be a fiction.
//
//   3. Unknown. "—", never guessed.
//
// The AA estimate needs a price, so a model with no AA cost, or a free model
// whose blended price is zero, has no estimate at all and falls through to
// the screen.

/**
 * The blended price per million tokens: three input tokens for every output
 * token. The mix the estimate is defined against, and the only assumption in
 * it — so it is stated wherever the estimate is shown.
 */
export function blendedPricePerMillion(
  price1mInput: number | null,
  price1mOutput: number | null,
): number | null {
  if (price1mInput == null || price1mOutput == null) return null;
  return (3 * price1mInput + price1mOutput) / 4;
}

/**
 * Tokens one AA task would take on this model, estimated.
 *
 * Null whenever the arithmetic is not possible: no published cost, no
 * published price, or a price of zero (a free model). A cost of zero or less
 * is null as well — a spend of nothing says nothing about token volume.
 */
export function estimateTokensPerTask(
  costPerTask: number | null,
  price1mInput: number | null,
  price1mOutput: number | null,
): number | null {
  if (costPerTask == null || costPerTask <= 0) return null;
  const price = blendedPricePerMillion(price1mInput, price1mOutput);
  if (price == null || price <= 0) return null;
  return (costPerTask / price) * 1_000_000;
}

/**
 * The token range one AA task allows: billed entirely at the dearer price
 * (fewest tokens) to entirely at the cheaper one (most). AA publishes no
 * input/output split of its cost, so any single number inside this range is
 * an assumption; the range is what the data supports.
 */
export function tokenRangePerTask(
  costPerTask: number | null,
  price1mInput: number | null,
  price1mOutput: number | null,
): { low: number; high: number } | null {
  if (costPerTask == null || costPerTask <= 0) return null;
  if (price1mInput == null || price1mOutput == null) return null;
  const dear = Math.max(price1mInput, price1mOutput);
  const cheap = Math.min(price1mInput, price1mOutput);
  if (dear <= 0) return null;
  const low = (costPerTask / dear) * 1_000_000;
  // A zero price on one side bounds nothing above; the 3:1 blend stands in.
  const high = cheap > 0 ? (costPerTask / cheap) * 1_000_000 : low;
  return { low, high };
}

export interface AaTokenEstimate {
  /** The 3:1 blended estimate of tokens per AA task — the sort value. */
  tokensPerTask: number;
  /** Fewest tokens the cost allows (all at the dearer price). */
  low: number;
  /** Most tokens the cost allows (all at the cheaper price). */
  high: number;
}

/** The AA estimate for every cached model that has one. Cost per task is
 *  read under the pinned scoring version (services/aa-scoring.ts): it is the
 *  cost of THAT version's workload, so it belongs with that version's scores. */
export function aaTokenEstimates(db: Db): Map<string, AaTokenEstimate> {
  const rows = db.prepare(`
    SELECT slug, price_1m_input, price_1m_output FROM aa_model
  `).all() as { slug: string; price_1m_input: number | null; price_1m_output: number | null }[];
  const scoring = loadAaScoring(db);

  const out = new Map<string, AaTokenEstimate>();
  for (const r of rows) {
    const cost = scoring.get(r.slug)?.costPerTask.value ?? null;
    const tokens = estimateTokensPerTask(cost, r.price_1m_input, r.price_1m_output);
    const range = tokenRangePerTask(cost, r.price_1m_input, r.price_1m_output);
    if (tokens != null && range != null) out.set(String(r.slug), { tokensPerTask: tokens, low: range.low, high: range.high });
  }
  return out;
}

// ---- The screen measurement (model_bench_result) ----

export interface BenchResult {
  platform: string;
  modelId: string;
  benchVersion: string;
  promptTokens: number;
  completionTokens: number;
  reasoningTokens: number;
  calls: number;
  scenariosCompleted: number;
  reasoningEffort: string | null;
  runAt: string;
  importedAt: string;
}

/** The bench results, keyed `platform\0modelId`. */
export function loadBenchResults(db: Db): Map<string, BenchResult> {
  const rows = db.prepare(`
    SELECT platform, model_id, bench_version, prompt_tokens, completion_tokens, reasoning_tokens,
           calls, scenarios_completed, reasoning_effort, run_at, imported_at
      FROM model_bench_result
  `).all() as {
    platform: string; model_id: string; bench_version: string;
    prompt_tokens: number; completion_tokens: number; reasoning_tokens: number;
    calls: number; scenarios_completed: number; reasoning_effort: string | null;
    run_at: string; imported_at: string;
  }[];
  return new Map(rows.map(r => [
    `${r.platform}\u0000${r.model_id}`,
    {
      platform: String(r.platform),
      modelId: String(r.model_id),
      benchVersion: String(r.bench_version),
      promptTokens: Number(r.prompt_tokens),
      completionTokens: Number(r.completion_tokens),
      reasoningTokens: Number(r.reasoning_tokens),
      calls: Number(r.calls),
      scenariosCompleted: Number(r.scenarios_completed),
      reasoningEffort: r.reasoning_effort == null ? null : String(r.reasoning_effort),
      runAt: String(r.run_at),
      importedAt: String(r.imported_at),
    },
  ]));
}

/**
 * Tokens per completed scenario.
 *
 * Completion tokens already include the reasoning tokens, so prompt +
 * completion is the whole spend; adding reasoning again would count the
 * thinking twice.
 */
export function screenTokensPerTask(result: BenchResult): number | null {
  if (result.scenariosCompleted <= 0) return null;
  return (result.promptTokens + result.completionTokens) / result.scenariosCompleted;
}

/**
 * The one number a surface prints, and where it came from.
 *
 * The AA estimate wins: it is measured on a common workload, so it is
 * comparable across models. A screen result is used only where there is no
 * AA estimate at all, and it is never sorted together with one.
 */
export function resolveTokenEfficiency(
  aa: AaTokenEstimate | undefined,
  screen: BenchResult | undefined,
  proxied = false,
): TokenEfficiency | null {
  if (aa) {
    return {
      source: 'aa',
      tokensLow: aa.low,
      tokensHigh: aa.high,
      tokensPerTask: aa.tokensPerTask,
      benchVersion: null,
      scenariosCompleted: null,
      runAt: null,
      proxied,
    };
  }
  if (screen) {
    const tokens = screenTokensPerTask(screen);
    if (tokens == null) return null;
    return {
      source: 'screen',
      tokensLow: null,
      tokensHigh: null,
      tokensPerTask: tokens,
      benchVersion: screen.benchVersion,
      scenariosCompleted: screen.scenariosCompleted,
      runAt: screen.runAt,
      proxied,
    };
  }
  return null;
}

export interface BenchResultInput {
  platform: string;
  modelId: string;
  benchVersion: string;
  promptTokens: number;
  completionTokens: number;
  reasoningTokens: number;
  calls: number;
  scenariosCompleted: number;
  reasoningEffort: string | null;
  runAt: string;
}

/**
 * Store one imported bench run, replacing whatever was there for the route.
 *
 * The newer run is the one the operator imported on purpose, so it replaces
 * the older row rather than sitting beside it.
 */
export function saveBenchResult(input: BenchResultInput, db: Db = getDb()): void {
  db.prepare(`
    INSERT INTO model_bench_result
      (platform, model_id, bench_version, prompt_tokens, completion_tokens, reasoning_tokens,
       calls, scenarios_completed, reasoning_effort, run_at, imported_at)
    VALUES (@platform, @modelId, @benchVersion, @promptTokens, @completionTokens, @reasoningTokens,
            @calls, @scenariosCompleted, @reasoningEffort, @runAt, datetime('now'))
    ON CONFLICT(platform, model_id) DO UPDATE SET
      bench_version = excluded.bench_version,
      prompt_tokens = excluded.prompt_tokens,
      completion_tokens = excluded.completion_tokens,
      reasoning_tokens = excluded.reasoning_tokens,
      calls = excluded.calls,
      scenarios_completed = excluded.scenarios_completed,
      reasoning_effort = excluded.reasoning_effort,
      run_at = excluded.run_at,
      imported_at = excluded.imported_at
  `).run(input);
}

/** Remove one route's bench result. Returns how many rows went. */
export function deleteBenchResult(platform: string, modelId: string, db: Db = getDb()): number {
  return db.prepare('DELETE FROM model_bench_result WHERE platform = ? AND model_id = ?')
    .run(platform, modelId).changes;
}

// ---- The passport, as the CLI writes it ----

/**
 * A Model Passport file, as `server/src/scripts/model-bench.ts` writes it.
 *
 * Only the `run` half is read: the passport half is a rendering of the run,
 * and re-deriving the numbers from it would be a second way to be wrong.
 */
const benchRunSchema = z.object({
  benchVersion: z.string().min(1),
  config: z.object({
    platform: z.string().min(1),
    modelId: z.string().min(1),
    /** The key's base_url: which relay served a custom route. */
    endpoint: z.string().nullable().optional(),
    reasoningEffort: z.string().nullable().optional(),
  }),
  usage: z.object({
    calls: z.number().int().nonnegative(),
    promptTokens: z.number().int().nonnegative(),
    completionTokens: z.number().int().nonnegative(),
    reasoningTokens: z.number().int().nonnegative(),
  }),
  // Per-scenario fields beyond `status` are optional so a passport written
  // before the route-history import still imports; they feed
  // route_probe_result (services/route-probe.ts recordBenchImport).
  results: z.record(z.string(), z.object({
    status: z.string().min(1),
    score: z.number().nullable().optional(),
    mode: z.string().optional(),
    cached: z.boolean().optional(),
    note: z.string().optional(),
  })),
  startedAt: z.string().min(1),
});

export const benchPassportSchema = z.object({ run: benchRunSchema });

/**
 * A scenario counts as completed when it reached a verdict: PASS or FAIL.
 *
 * INCONCLUSIVE and NOT_TESTED did not produce a result to divide the tokens
 * by, and UNSUPPORTED means the endpoint refused the scenario outright. None
 * of them is a completed task.
 */
export function countCompletedScenarios(results: Record<string, { status: string }>): number {
  return Object.values(results).filter(r => r.status === 'PASS' || r.status === 'FAIL').length;
}
