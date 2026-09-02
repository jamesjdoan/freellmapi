import { describe, expect, it } from 'vitest'
import {
  MODEL_PICKER_MIN_MODELS,
  orderScopeCandidates,
  resolveScopeUpdate,
  scopeCandidates,
  shouldOfferModelPicker,
  type ScopeCandidate,
} from './model-scope-selection'
import type { FallbackEntry } from './routing'

function entry(platform: string, modelId: string, extra: Partial<FallbackEntry> = {}): FallbackEntry {
  return {
    modelDbId: 1,
    priority: 1,
    effectivePriority: 1,
    penalty: 0,
    rateLimitHits: 0,
    enabled: true,
    platform,
    modelId,
    displayName: modelId.toUpperCase(),
    intelligenceRank: 50,
    speedRank: 50,
    sizeLabel: 'Large',
    rpmLimit: null,
    rpdLimit: null,
    monthlyTokenBudget: '',
    supportsVision: false,
    supportsTools: true,
    keyCount: 1,
    ...extra,
  }
}

function candidates(...ids: string[]): ScopeCandidate[] {
  return ids.map(modelId => ({
    modelId,
    displayName: modelId,
    sizeLabel: null,
    contextWindow: null,
    intelligenceRank: 50,
  }))
}

describe('scopeCandidates (#657 post-add picker)', () => {
  const entries = [
    entry('groq', 'llama-3.3-70b'),
    entry('cerebras', 'qwen-3-32b'),
    entry('groq', 'kimi-k2', { displayName: 'Kimi K2', sizeLabel: 'Frontier', contextWindow: 262144 }),
  ]

  it('keeps only the named platform, in server order', () => {
    expect(scopeCandidates(entries, 'groq').map(c => c.modelId)).toEqual(['llama-3.3-70b', 'kimi-k2'])
  })

  it('carries the display name, tier and context the picker badges', () => {
    expect(scopeCandidates(entries, 'groq')[1]).toEqual({
      modelId: 'kimi-k2',
      displayName: 'Kimi K2',
      sizeLabel: 'Frontier',
      contextWindow: 262144,
      intelligenceRank: 50,
    })
  })

  it('falls back to the model id when the catalog has no display name', () => {
    const rows = scopeCandidates([entry('groq', 'bare', { displayName: '' })], 'groq')
    expect(rows[0].displayName).toBe('bare')
  })

  it('normalises a missing tier/context to null', () => {
    const rows = scopeCandidates([entry('groq', 'x', { sizeLabel: '', contextWindow: undefined })], 'groq')
    expect(rows[0]).toMatchObject({ sizeLabel: null, contextWindow: null })
  })

  it('collapses duplicate model ids — modelScope matches on id alone', () => {
    const dupes = [entry('groq', 'dup'), entry('groq', 'dup'), entry('groq', 'other')]
    expect(scopeCandidates(dupes, 'groq').map(c => c.modelId)).toEqual(['dup', 'other'])
  })

  it('offers nothing for custom endpoints or an unnamed platform', () => {
    expect(scopeCandidates([entry('custom', 'local-qwen')], 'custom')).toEqual([])
    expect(scopeCandidates(entries, '')).toEqual([])
  })

  it('offers nothing when the model list has not loaded', () => {
    expect(scopeCandidates([], 'groq')).toEqual([])
  })
})

describe('shouldOfferModelPicker', () => {
  it('stays out of the way for a small catalog', () => {
    expect(shouldOfferModelPicker(candidates('a', 'b', 'c', 'd', 'e'))).toBe(false)
  })

  it('offers the picker once the catalog passes five models', () => {
    expect(shouldOfferModelPicker(candidates('a', 'b', 'c', 'd', 'e', 'f'))).toBe(true)
  })

  it('never offers an empty list', () => {
    expect(shouldOfferModelPicker([])).toBe(false)
  })

  it('draws the line at six', () => {
    expect(MODEL_PICKER_MIN_MODELS).toBe(6)
  })
})

describe('resolveScopeUpdate', () => {
  const all = ['a', 'b', 'c']

  it('saves nothing when every model is ticked — the scope stays null', () => {
    // A stored full list would freeze the key at today's catalog; null keeps
    // tomorrow's models flowing through it.
    expect(resolveScopeUpdate(all, new Set(all))).toEqual({ patch: false, reason: 'all' })
  })

  it('patches exactly the ticked ids for a subset', () => {
    expect(resolveScopeUpdate(all, new Set(['a', 'c']))).toEqual({ patch: true, modelScope: ['a', 'c'] })
  })

  it('emits the ids in catalog order, not tick order', () => {
    const update = resolveScopeUpdate(all, new Set(['c', 'a']))
    expect(update).toEqual({ patch: true, modelScope: ['a', 'c'] })
  })

  it('patches a single ticked model', () => {
    expect(resolveScopeUpdate(all, new Set(['b']))).toEqual({ patch: true, modelScope: ['b'] })
  })

  it('refuses to submit an empty selection', () => {
    // The server maps `modelScope: []` back to NULL = "serves everything", the
    // opposite of an empty tick list — so this never becomes a request. The
    // dialog also disables Confirm here.
    expect(resolveScopeUpdate(all, new Set())).toEqual({ patch: false, reason: 'empty' })
  })

  it('ignores ticks for ids no longer on offer', () => {
    expect(resolveScopeUpdate(all, new Set(['a', 'gone']))).toEqual({ patch: true, modelScope: ['a'] })
    // …including when the leftovers would otherwise fake a full selection.
    expect(resolveScopeUpdate(all, new Set(['a', 'b', 'c', 'gone']))).toEqual({ patch: false, reason: 'all' })
  })

  it('treats an empty catalog as nothing to save', () => {
    expect(resolveScopeUpdate([], new Set(['a']))).toEqual({ patch: false, reason: 'empty' })
  })
})

describe('orderScopeCandidates', () => {
  const model = (modelId: string, over: Partial<ScopeCandidate> = {}): ScopeCandidate => ({
    modelId,
    displayName: modelId,
    sizeLabel: 'Medium',
    contextWindow: null,
    intelligenceRank: 50,
    ...over,
  })

  it('puts enabled models above the rest, whatever their tier', () => {
    const rows = orderScopeCandidates(
      [model('frontier-unticked', { sizeLabel: 'Frontier' }), model('small-ticked', { sizeLabel: 'Small' })],
      modelId => modelId === 'small-ticked',
    )
    expect(rows.map(row => row.modelId)).toEqual(['small-ticked', 'frontier-unticked'])
  })

  it('ranks the most advanced first inside one enabled group', () => {
    const rows = orderScopeCandidates([
      model('small', { sizeLabel: 'Small' }),
      model('frontier', { sizeLabel: 'Frontier' }),
      model('untiered', { sizeLabel: null }),
      model('medium'),
      model('large', { sizeLabel: 'Large' }),
    ], () => true)
    expect(rows.map(row => row.modelId)).toEqual(['frontier', 'large', 'medium', 'small', 'untiered'])
  })

  it('breaks a tier tie on per-provider rank, then name', () => {
    const rows = orderScopeCandidates([
      model('slower', { intelligenceRank: 90 }),
      model('sharper', { intelligenceRank: 10 }),
      model('b-tied', { intelligenceRank: 10 }),
    ], () => true)
    expect(rows.map(row => row.modelId)).toEqual(['b-tied', 'sharper', 'slower'])
  })

  it('keeps every unticked model below every ticked one', () => {
    const rows = orderScopeCandidates([
      model('frontier-off', { sizeLabel: 'Frontier', intelligenceRank: 1 }),
      model('small-on', { sizeLabel: 'Small', intelligenceRank: 99 }),
      model('large-off', { sizeLabel: 'Large', intelligenceRank: 2 }),
      model('medium-on', { intelligenceRank: 40 }),
    ], modelId => modelId.endsWith('-on'))
    expect(rows.map(row => row.modelId)).toEqual(['medium-on', 'small-on', 'frontier-off', 'large-off'])
  })

  it('leaves the input array untouched', () => {
    const input = [model('b'), model('a')]
    orderScopeCandidates(input, () => true)
    expect(input.map(row => row.modelId)).toEqual(['b', 'a'])
  })

  it('sorts unranked live-discovery rows after every ranked one', () => {
    const rows = orderScopeCandidates([
      model('live', { sizeLabel: null, intelligenceRank: Number.MAX_SAFE_INTEGER }),
      model('small', { sizeLabel: 'Small' }),
    ], () => true)
    expect(rows.map(row => row.modelId)).toEqual(['small', 'live'])
  })
})
