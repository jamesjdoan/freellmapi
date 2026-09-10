import { describe, expect, it } from 'vitest'
import { addAlias, aliasesFor, normalizeInto, removeAlias, unmergeGroupKeys, type AliasMerge } from './alias-merge'

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

describe('undoing a merge', () => {
  // Both entries are real, from a live install. The second is another group's
  // business and must survive every edit to the first.
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

  it('leaves every other group untouched when undoing the whole merge', () => {
    // The live bug this pins: undoing one group wiped an unrelated group's keys.
    expect(unmergeGroupKeys(merges, ['nemotron 3 super'], '')).toEqual([merges[1]])
  })

  it('takes out one key and keeps the rest of the same group', () => {
    const next = unmergeGroupKeys(merges, merges[1].keys, 'kilo:nvidia/nemotron-3-ultra-550b-a55b:free')
    expect(next).toHaveLength(2)
    expect(next[1].keys).toEqual([
      'nvidia:nvidia/nemotron-3-ultra-550b-a55b',
      'requesty:nvidia/nemotron-3-ultra-550b-a55b',
    ])
  })

  it('removes a folded group key, which names neither the group nor a member', () => {
    // What "Merge into" actually writes: the key of the group being folded in.
    const folded = [{ into: 'Gemma 4 26B', keys: ['gemma 4 26b it'] }]
    expect(unmergeGroupKeys(folded, ['gemma 4 26b it'], '')).toEqual([])
  })

  it('is a no-op for a group the catalog built by name', () => {
    expect(unmergeGroupKeys(merges, [], '')).toEqual(merges)
  })
})
