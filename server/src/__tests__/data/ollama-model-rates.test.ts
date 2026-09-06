import { describe, it, expect } from 'vitest';
import { ollamaCallCostUsd, OLLAMA_MODEL_RATES } from '../../data/ollama-model-rates.js';

/**
 * Ollama meters GPU time and reports usage only as a fraction of an allowance
 * it never sizes, so deriving that allowance in TOKENS gives an answer that
 * depends on which models the sample used. Measured on real traffic the implied
 * weekly allowance swung 4.9x (71.9M tokens from a nemotron-3-super-heavy mix,
 * 14.8M from an ultra-heavy one); priced in dollars the same spend moved 1.3x.
 * These rates are what make that pricing possible.
 */
describe('ollama call pricing', () => {
  it('prices input and output separately', () => {
    // nemotron-3-super: $0.015/M in, $0.60/M out.
    expect(ollamaCallCostUsd('nemotron-3-super', 1_000_000, 0)).toBeCloseTo(0.015, 6);
    expect(ollamaCallCostUsd('nemotron-3-super', 0, 1_000_000)).toBeCloseTo(0.60, 6);
  });

  it('reproduces the rate gap that made the token figure unstable', () => {
    // ultra's input costs 6.7x super's, which is why a mix shift moved the
    // token-denominated allowance so far.
    const ultra = ollamaCallCostUsd('nemotron-3-ultra', 1_000_000, 0)!;
    const superr = ollamaCallCostUsd('nemotron-3-super', 1_000_000, 0)!;
    expect(ultra / superr).toBeCloseTo(6.67, 1);
  });

  it('matches a tagged catalogue id against a bare price-list entry', () => {
    // The catalogue carries 'gemma4:31b'; the price list gives 'gemma4'.
    expect(ollamaCallCostUsd('gemma4:31b', 1_000_000, 0)).toBeCloseTo(0.14, 6);
  });

  it('returns null for a model with no published rate', () => {
    // An unpriced model must not be guessed at — the caller drops the interval.
    expect(ollamaCallCostUsd('some-unlisted-model', 1_000_000, 0)).toBeNull();
  });

  it('doubles the deepseek rates inside the peak window only', () => {
    // "Peak pricing applies between 12:00 and 18:00 UTC, Monday to Friday."
    const offPeak = ollamaCallCostUsd('deepseek-v4-flash', 1_000_000, 0, new Date('2026-09-07T09:00:00Z'))!;
    const peak = ollamaCallCostUsd('deepseek-v4-flash', 1_000_000, 0, new Date('2026-09-07T13:00:00Z'))!;
    expect(offPeak).toBeCloseTo(0.22, 6);
    expect(peak).toBeCloseTo(0.44, 6);
  });

  it('does not apply peak pricing at the weekend, or to flat-rate models', () => {
    // 2026-09-06 is a Sunday.
    expect(ollamaCallCostUsd('deepseek-v4-flash', 1_000_000, 0, new Date('2026-09-06T13:00:00Z')))
      .toBeCloseTo(0.22, 6);
    expect(ollamaCallCostUsd('gpt-oss:120b', 1_000_000, 0, new Date('2026-09-07T13:00:00Z')))
      .toBeCloseTo(0.15, 6);
  });

  it('covers the models this account actually has enabled', () => {
    // A rate table that silently misses a routable model drops whole intervals
    // from the derivation rather than pricing them.
    for (const modelId of ['gpt-oss:120b', 'gpt-oss:20b', 'gemma4:31b',
      'nemotron-3-nano:30b', 'nemotron-3-super', 'nemotron-3-ultra']) {
      expect(ollamaCallCostUsd(modelId, 1000, 100), modelId).not.toBeNull();
    }
    expect(Object.keys(OLLAMA_MODEL_RATES).length).toBeGreaterThan(15);
  });
});
