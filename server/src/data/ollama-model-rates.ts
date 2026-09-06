// Published per-model token rates for Ollama Cloud.
//
// Source: https://ollama.com/pricing, read 2026-09-06. Dollars per million
// tokens, input and output listed separately.
//
// Why this exists: Ollama meters GPU time, not tokens, and reports usage only
// as a fraction of an allowance it never sizes. Deriving that allowance in
// TOKENS therefore gives an answer that depends entirely on which models the
// sample happened to use — measured on real traffic, the implied weekly
// allowance swung 4.9x (71.9M tokens from a nemotron-3-super-heavy mix, 14.8M
// from a nemotron-3-ultra-heavy one) purely because ultra's input costs 6.7x
// super's.
//
// Pricing the same spend in dollars collapsed that to 1.3x ($2.00 vs $1.53),
// which is what identifies dollars as the unit the provider is really counting.
//
// Rates change. This is a dated reading of a public page, not a permanent
// fact: an unlisted model yields no dollar estimate rather than a wrong one,
// and the whole table is worth re-reading when Ollama revises pricing.

export interface ModelTokenRate {
  /** USD per million input tokens. */
  input: number;
  /** USD per million output tokens. */
  output: number;
}

export const OLLAMA_MODEL_RATES: Readonly<Record<string, ModelTokenRate>> = {
  'deepseek-v4-flash': { input: 0.22, output: 0.66 },
  'deepseek-v4-pro': { input: 0.66, output: 1.98 },
  'gemma4': { input: 0.14, output: 0.40 },
  'gemma4:31b': { input: 0.14, output: 0.40 },
  'glm-5.3': { input: 1.40, output: 4.40 },
  'glm-5.3-flash': { input: 0.15, output: 0.50 },
  'glm-5.2': { input: 1.40, output: 4.40 },
  'glm-5.1': { input: 1.00, output: 3.20 },
  'gpt-oss:120b': { input: 0.15, output: 0.60 },
  'gpt-oss:20b': { input: 0.07, output: 0.30 },
  'kimi-k3': { input: 3.00, output: 15.00 },
  'kimi-k2.7-code': { input: 0.95, output: 4.00 },
  'kimi-k2.6': { input: 0.95, output: 4.00 },
  'minimax-m3': { input: 0.60, output: 2.40 },
  'minimax-m2.7': { input: 0.30, output: 1.20 },
  'mistral-large-3': { input: 0.50, output: 1.50 },
  'nemotron-3-nano': { input: 0.06, output: 0.24 },
  'nemotron-3-nano:30b': { input: 0.06, output: 0.24 },
  'nemotron-3-super': { input: 0.015, output: 0.60 },
  'nemotron-3-ultra': { input: 0.10, output: 3.00 },
  'qwen3.5:397b': { input: 0.60, output: 3.60 },
};

/**
 * Peak pricing doubles the deepseek rates between 12:00 and 18:00 UTC, Monday
 * to Friday (same page). Applied only to the models the page lists as peak-
 * priced; everything else bills flat.
 */
const PEAK_PRICED = new Set(['deepseek-v4-flash', 'deepseek-v4-pro']);

function isPeakPricing(at: Date): boolean {
  const day = at.getUTCDay();
  if (day === 0 || day === 6) return false;
  const hour = at.getUTCHours();
  return hour >= 12 && hour < 18;
}

/**
 * Cost in USD of a completed call, or null when the model has no published
 * rate — in which case the caller must not guess.
 *
 * `modelId` is matched exactly and then by family prefix, because the
 * catalogue carries tags ('gemma4:31b') that the price list sometimes gives
 * bare ('gemma4').
 */
export function ollamaCallCostUsd(
  modelId: string,
  inputTokens: number,
  outputTokens: number,
  at: Date = new Date(),
): number | null {
  const rate = OLLAMA_MODEL_RATES[modelId] ?? OLLAMA_MODEL_RATES[modelId.split(':')[0]!];
  if (!rate) return null;
  const multiplier = PEAK_PRICED.has(modelId.split(':')[0]!) && isPeakPricing(at) ? 2 : 1;
  return (inputTokens / 1_000_000) * rate.input * multiplier
    + (outputTokens / 1_000_000) * rate.output * multiplier;
}
