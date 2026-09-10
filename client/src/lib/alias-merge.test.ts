import { describe, expect, it } from 'vitest'
import { addAlias, aliasesFor, foldedKeys, normalizeInto, removeAlias, unmergeGroupKeys, type AliasMerge } from './alias-merge'

const merges: AliasMerge[] = [
  { into: 'GPT-4.1', keys: ['custom:gpt41-relay'] },
  { into: 'Llama 3.3 70B', keys: ['custom:llama-relay', 'custom:llama-backup'] },
]

describe('normalizeInto (#790)', () => {
  it('ignores case, separators, and surrounding space', () => {
    expect(normalizeInto('  Llama-3.3_70B ')).toBe('llama 3.3 70b')
  })
})

describe('aliasesFor (#790)', () => {
  it('returns only the aliases of the named group', () => {
    expect(aliasesFor(merges, 'Llama 3.3 70B')).toEqual(['custom:llama-relay', 'custom:llama-backup'])
  })

  it('matches the group through normalization', () => {
    expect(aliasesFor(merges, 'llama-3.3-70b')).toEqual(['custom:llama-relay', 'custom:llama-backup'])
  })

  it('returns nothing for a group with no merges', () => {
    expect(aliasesFor(merges, 'Claude Sonnet 4')).toEqual([])
  })
})

describe('addAlias (#790)', () => {
  it('keeps the aliases already merged into the group', () => {
    const next = addAlias(merges, 'Llama 3.3 70B', 'custom:llama-third')
    expect(aliasesFor(next, 'Llama 3.3 70B')).toEqual([
      'custom:llama-relay', 'custom:llama-backup', 'custom:llama-third',
    ])
  })

  it('leaves other groups untouched', () => {
    const next = addAlias(merges, 'Llama 3.3 70B', 'custom:llama-third')
    expect(aliasesFor(next, 'GPT-4.1')).toEqual(['custom:gpt41-relay'])
  })

  it('creates the entry for a group that had none', () => {
    const next = addAlias(merges, 'Claude Sonnet 4', 'custom:claude-relay')
    expect(aliasesFor(next, 'Claude Sonnet 4')).toEqual(['custom:claude-relay'])
    expect(next).toHaveLength(3)
  })

  it('trims the alias and ignores a blank one', () => {
    expect(aliasesFor(addAlias(merges, 'GPT-4.1', '  custom:x  '), 'GPT-4.1'))
      .toEqual(['custom:gpt41-relay', 'custom:x'])
    expect(addAlias(merges, 'GPT-4.1', '   ')).toBe(merges)
  })

  it('does not duplicate an alias that is already merged', () => {
    const next = addAlias(merges, 'GPT-4.1', 'custom:gpt41-relay')
    expect(aliasesFor(next, 'GPT-4.1')).toEqual(['custom:gpt41-relay'])
  })
})

describe('removeAlias (#790)', () => {
  it('drops one alias and keeps the rest of the group', () => {
    const next = removeAlias(merges, 'Llama 3.3 70B', 'custom:llama-relay')
    expect(aliasesFor(next, 'Llama 3.3 70B')).toEqual(['custom:llama-backup'])
  })

  it('never touches another group that sits at the same visible index', () => {
    // The page renders only this group's aliases, so the first row on screen is
    // entry #1 in the full list — removing by row index used to delete GPT-4.1's.
    const next = removeAlias(merges, 'Llama 3.3 70B', 'custom:llama-relay')
    expect(aliasesFor(next, 'GPT-4.1')).toEqual(['custom:gpt41-relay'])
  })

  it('removes the whole entry once its last alias is gone', () => {
    const next = removeAlias(merges, 'GPT-4.1', 'custom:gpt41-relay')
    expect(next).toEqual([{ into: 'Llama 3.3 70B', keys: ['custom:llama-relay', 'custom:llama-backup'] }])
  })

  it('is a no-op for an alias that is not merged here', () => {
    expect(removeAlias(merges, 'GPT-4.1', 'custom:nope')).toEqual(merges)
  })
})

describe('group-identity merge matching', () => {
  // Both entries are real, from a live install. The Super group's label
  // ("Nemotron-3 Super") differs from its merge target ("Nemotron 3 Super
  // 120B"), which is what a label match got wrong.
  const superGroup = {
    key: 'nemotron 3 super 120b',
    members: [
      { platform: 'nvidia', modelId: 'nvidia/nemotron-3-super-120b-a12b' },
      { platform: 'ollama', modelId: 'nemotron-3-super' },
    ],
  }
  const merges = [
    { into: 'Nemotron 3 Super 120B', keys: ['nemotron 3 super'] },
    {
      into: 'Nemotron 3 Ultra 550B',
      keys: [
        'nvidia:nvidia/nemotron-3-ultra-550b-a55b',
        'kilo:nvidia/nemotron-3-ultra-550b-a55b:free',
        'requesty:nvidia/nemotron-3-ultra-550b-a55b',
      ],
    },
  ]

  it('finds the entry whose target does not match the rendered label', () => {
    expect(foldedKeys(merges, superGroup)).toEqual(['nemotron 3 super'])
  })

  it('leaves every other group untouched when undoing the whole merge', () => {
    // The bug this pins: undoing one group wiped an unrelated group's keys.
    expect(unmergeGroupKeys(merges, superGroup, '')).toEqual([merges[1]])
  })

  it('takes out one key and keeps the rest of the same group', () => {
    const g = { key: 'nemotron 3 ultra 550b', members: [] }
    const next = unmergeGroupKeys(merges, g, 'kilo:nvidia/nemotron-3-ultra-550b-a55b:free')
    expect(next).toHaveLength(2)
    expect(next[1].keys).toEqual([
      'nvidia:nvidia/nemotron-3-ultra-550b-a55b',
      'requesty:nvidia/nemotron-3-ultra-550b-a55b',
    ])
  })

  it('matches an entry by a member it names, not only by target', () => {
    const g = { key: 'some other label', members: [{ platform: 'nvidia', modelId: 'nvidia/nemotron-3-ultra-550b-a55b' }] }
    expect(foldedKeys(merges, g)).toHaveLength(3)
  })

  it('reports nothing for a group the catalogue own names produced', () => {
    expect(foldedKeys(merges, { key: 'gpt oss 120b', members: [{ platform: 'groq', modelId: 'openai/gpt-oss-120b' }] })).toEqual([])
  })
})
