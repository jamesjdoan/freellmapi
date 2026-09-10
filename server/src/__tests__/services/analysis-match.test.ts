import { describe, it, expect } from 'vitest';
import { matchAaModel, normalizeModelKey } from '../../services/analysis-match.js';

// Real ids from this install's catalogue, matched against real Artificial
// Analysis slugs. A wrong match is worse than none: it puts another model's
// benchmark scores beside a model and invites a decision on them.

const AA = [
  { slug: 'gpt-oss-120b', name: 'gpt-oss-120B' },
  { slug: 'gpt-oss-20b', name: 'gpt-oss-20B' },
  { slug: 'kimi-k3', name: 'Kimi K3' },
  { slug: 'nemotron-3-ultra-550b', name: 'Nemotron 3 Ultra 550B' },
  { slug: 'llama-3.3-70b', name: 'Llama 3.3 70B' },
  { slug: 'llama-3.1-70b', name: 'Llama 3.1 70B' },
  { slug: 'gemini-3.7-flash', name: 'Gemini 3.7 Flash' },
];

describe('normalizeModelKey', () => {
  it('drops the vendor path our providers prepend', () => {
    expect(normalizeModelKey('openai/gpt-oss-120b')).toBe('gptoss120b');
    expect(normalizeModelKey('moonshotai/kimi-k3')).toBe('kimik3');
  });

  it('leaves a bare slug alone', () => {
    // The slug side of the comparison has no path to strip.
    expect(normalizeModelKey('gpt-oss-120b')).toBe('gptoss120b');
  });

  it('strips route and serving suffixes, including stacked ones', () => {
    expect(normalizeModelKey('nvidia/nemotron-3-ultra-550b-a55b:free'))
      .toBe(normalizeModelKey('nemotron-3-ultra-550b-a55b'));
    expect(normalizeModelKey('@cf/meta/llama-3.3-70b-instruct-fp8-fast')).toBe('llama3370b');
  });

  it('keeps versions that actually differ apart', () => {
    // The whole value of this is telling 3.3 from 3.1; collapsing them would
    // attach one model's scores to another.
    expect(normalizeModelKey('llama-3.3-70b')).not.toBe(normalizeModelKey('llama-3.1-70b'));
  });

  it('treats punctuation variants of one name as one key', () => {
    expect(normalizeModelKey('qwen3.5-27b')).toBe(normalizeModelKey('qwen3_5_27b'));
  });
});

describe('matchAaModel', () => {
  it('matches a prefixed id to its slug', () => {
    expect(matchAaModel('openai/gpt-oss-120b', 'GPT-OSS 120B (Groq)', AA))
      .toEqual({ slug: 'gpt-oss-120b', reason: 'slug' });
  });

  it('matches through a Cloudflare-style path with quantisation suffixes', () => {
    expect(matchAaModel('@cf/meta/llama-3.3-70b-instruct-fp8-fast', null, AA)?.slug)
      .toBe('llama-3.3-70b');
  });

  it('falls back to the display name, ignoring the provider in brackets', () => {
    // Some providers publish a marketing name where AA publishes a slug.
    expect(matchAaModel('nim-hosted-xyz-01', 'Kimi K3 (NVIDIA NIM)', AA))
      .toEqual({ slug: 'kimi-k3', reason: 'name' });
  });

  it('returns null rather than a near miss', () => {
    // No fuzzy distance anywhere: unmatched goes to the operator to map.
    expect(matchAaModel('someone/brand-new-model-v9', 'Brand New V9', AA)).toBeNull();
  });

  it('refuses an ambiguous key instead of picking one', () => {
    // Two AA models normalising the same way is a coin toss, and a coin toss
    // rendered as a benchmark is worse than a blank.
    const ambiguous = [
      { slug: 'mystery-7b', name: 'Mystery 7B' },
      { slug: 'mystery_7b', name: 'Mystery 7B (v2)' },
    ];
    expect(matchAaModel('vendor/mystery-7b', 'Mystery 7B', ambiguous)).toBeNull();
  });

  it('does not match the 550b variant to a different parameter count', () => {
    const withDecoy = [...AA, { slug: 'nemotron-3-super-120b', name: 'Nemotron 3 Super 120B' }];
    expect(matchAaModel('nvidia/nemotron-3-super-120b-a12b:free', null, withDecoy)?.slug)
      .toBe('nemotron-3-super-120b');
  });

  it('handles an empty candidate list without throwing', () => {
    expect(matchAaModel('openai/gpt-oss-120b', 'GPT-OSS 120B', [])).toBeNull();
  });
});
