import { describe, expect, it } from 'vitest'
import {
  MODEL_PICKER_MIN_MODELS,
  enabledModelCount,
  modelFamilyAndVersion,
  providerKeyAccess,
  orderScopeCandidates,
  resolveScopeUpdate,
  scopeCandidates,
  shouldOfferModelPicker,
  type ScopeCandidate,
} from './model-scope-selection'
import type { FallbackEntry } from './routing'
import type { ApiKey } from '../../../shared/types'

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

  it('leads with the highest version among tied siblings', () => {
    const rows = orderScopeCandidates([
      model('gemini-2.5-flash'),
      model('gemini-3.6-flash'),
      model('gemini-3.5-flash'),
      model('gemini-3-flash'),
    ], () => true)
    expect(rows.map(row => row.modelId))
      .toEqual(['gemini-3.6-flash', 'gemini-3.5-flash', 'gemini-3-flash', 'gemini-2.5-flash'])
  })

  it('clusters families rather than comparing versions across vendors', () => {
    const rows = orderScopeCandidates([
      model('qwen3.6'),
      model('glm-4.5'),
      model('qwen3.9'),
      model('glm-4.7'),
    ], () => true)
    // glm before qwen on family name; newest first inside each.
    expect(rows.map(row => row.modelId)).toEqual(['glm-4.7', 'glm-4.5', 'qwen3.9', 'qwen3.6'])
  })

  it('still lets tier and rank outrank the version', () => {
    const rows = orderScopeCandidates([
      model('gemini-3.6-flash', { sizeLabel: 'Small' }),
      model('gemini-2.5-flash', { sizeLabel: 'Frontier' }),
    ], () => true)
    expect(rows.map(row => row.modelId)).toEqual(['gemini-2.5-flash', 'gemini-3.6-flash'])
  })
})

describe('modelFamilyAndVersion', () => {
  it('reads the version that follows the family name', () => {
    expect(modelFamilyAndVersion('gemini-3.5-flash')).toEqual({ family: 'gemini-flash', version: [3, 5] })
    expect(modelFamilyAndVersion('google/gemini-2.5-flash-lite')).toEqual({ family: 'gemini-flash-lite', version: [2, 5] })
    expect(modelFamilyAndVersion('glm-4.7-flash')).toEqual({ family: 'glm-flash', version: [4, 7] })
  })

  it('reads a version glued to the name', () => {
    expect(modelFamilyAndVersion('qwen/qwen3.6-27b')).toEqual({ family: 'qwen', version: [3, 6] })
    expect(modelFamilyAndVersion('gpt4')).toEqual({ family: 'gpt', version: [4] })
  })

  it('never mistakes a parameter count for a version', () => {
    expect(modelFamilyAndVersion('openai/gpt-oss-120b')).toEqual({ family: 'gpt-oss', version: [] })
    expect(modelFamilyAndVersion('meta/llama-3.3-70b-instruct'))
      .toEqual({ family: 'llama-instruct', version: [3, 3] })
    // `9b` is the parameter count and stays out of it; `v2` really is version 2.
    expect(modelFamilyAndVersion('nvidia-nemotron-nano-9b-v2'))
      .toEqual({ family: 'nvidia-nemotron-nano-v', version: [2] })
    expect(modelFamilyAndVersion('nvidia-nemotron-nano-9b-v3').family)
      .toBe(modelFamilyAndVersion('nvidia-nemotron-nano-9b-v2').family)
  })

  it('gives one family to siblings that differ only by version', () => {
    const a = modelFamilyAndVersion('gemini-3.6-flash')
    const b = modelFamilyAndVersion('gemini-2.5-flash')
    expect(a.family).toBe(b.family)
  })

  it('keeps different vendors in different families', () => {
    expect(modelFamilyAndVersion('glm-4.5').family).not.toBe(modelFamilyAndVersion('qwen3.6').family)
  })
})

describe('enabledModelCount', () => {
  const rows = [
    entry('groq', 'a'),
    entry('groq', 'b'),
    entry('groq', 'b'), // duplicate id, counted once
    entry('groq', 'c'),
    entry('cerebras', 'x'),
    entry('groq', 'relay', { source: 'custom' }),
  ]
  const keyed = (over: Partial<ApiKey>) =>
    [{ id: 1, platform: 'groq', enabled: true, status: 'healthy', modelScope: null, ...over }] as unknown as ApiKey[]

  it('counts every catalogue model of the platform, once, excluding relays', () => {
    const access = providerKeyAccess(keyed({})).get('groq')
    expect(enabledModelCount(rows, 'groq', access)).toEqual({ enabled: 3, total: 3 })
  })

  it('counts only the scoped models when the key is scoped', () => {
    const access = providerKeyAccess(keyed({ modelScope: ['a', 'c'] })).get('groq')
    expect(enabledModelCount(rows, 'groq', access)).toEqual({ enabled: 2, total: 3 })
  })

  it('reports none enabled when the provider has no key at all', () => {
    expect(enabledModelCount(rows, 'cerebras', undefined)).toEqual({ enabled: 0, total: 1 })
  })

  it('still counts an unhealthy key when health is not required', () => {
    const keys = keyed({ status: 'invalid', modelScope: ['a'] })
    expect(providerKeyAccess(keys).get('groq')).toBeUndefined()
    const configured = providerKeyAccess(keys, { requireUsable: false }).get('groq')
    expect(enabledModelCount(rows, 'groq', configured)).toEqual({ enabled: 1, total: 3 })
  })

  it('ignores a disabled key under either reading', () => {
    const keys = keyed({ enabled: false })
    expect(providerKeyAccess(keys, { requireUsable: false }).get('groq')).toBeUndefined()
  })
})
