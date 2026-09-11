import { describe, expect, it } from 'vitest'
import { sortEntries, sortValue, type SortableEntry } from './compare-sort'

const entry = (
  name: string,
  analysis: Partial<NonNullable<SortableEntry['analysis']>> | null,
  members: { contextWindow: number | null; intelligenceRank: number }[] = [{ contextWindow: 131072, intelligenceRank: 5 }],
  chains: string[] = [],
): SortableEntry => ({
  name,
  chains,
  members,
  analysis: analysis && {
    intelligenceIndex: null,
    codingIndex: null,
    agenticIndex: null,
    medianOutputTokensPerSecond: null,
    medianTimeToFirstTokenSeconds: null,
    price1mOutput: null,
    ...analysis,
  },
})

describe('sortEntries', () => {
  const measured = entry('Measured', { intelligenceIndex: 40 })
  const weaker = entry('Weaker', { intelligenceIndex: 12 })
  const unmeasured = entry('Unmeasured', null)

  it('ranks by the column, best first when descending', () => {
    const out = sortEntries([weaker, unmeasured, measured], 'intelligenceIndex', 'desc')
    expect(out.map(e => e.name)).toEqual(['Measured', 'Weaker', 'Unmeasured'])
  })

  it('keeps unmeasured rows at the bottom when ascending too', () => {
    // The point of the helper: a model with no score is not a zero, and
    // "worst first" opening with a wall of dashes would say nothing.
    const out = sortEntries([unmeasured, measured, weaker], 'intelligenceIndex', 'asc')
    expect(out.map(e => e.name)).toEqual(['Weaker', 'Measured', 'Unmeasured'])
  })

  it('sorts names alphabetically and breaks ties on name', () => {
    expect(sortEntries([entry('b', null), entry('a', null)], 'name', 'asc').map(e => e.name)).toEqual(['a', 'b'])
    const tied = sortEntries(
      [entry('Zed', { codingIndex: 30 }), entry('Ant', { codingIndex: 30 })],
      'codingIndex',
      'desc',
    )
    expect(tied.map(e => e.name)).toEqual(['Ant', 'Zed'])
  })

  it('does not mutate the input', () => {
    const input = [weaker, measured]
    sortEntries(input, 'intelligenceIndex', 'desc')
    expect(input.map(e => e.name)).toEqual(['Weaker', 'Measured'])
  })
})

describe('sortValue', () => {
  it('takes the widest context and the best rank across an entry routes', () => {
    const e = entry('Merged', null, [
      { contextWindow: 131072, intelligenceRank: 9 },
      { contextWindow: 1048576, intelligenceRank: 3 },
    ])
    expect(sortValue(e, 'context')).toBe(1048576)
    expect(sortValue(e, 'ourRank')).toBe(3)
  })

  it('reports null where nothing is measured, rather than zero', () => {
    const e = entry('Blank', null, [{ contextWindow: null, intelligenceRank: 5 }])
    expect(sortValue(e, 'context')).toBeNull()
    expect(sortValue(e, 'speed')).toBeNull()
    expect(sortValue(e, 'price')).toBeNull()
  })

  it('treats a genuine zero price as a value, not a blank', () => {
    // Free routes really do cost 0, and must sort ahead of paid ones rather
    // than sinking with the unmeasured.
    const free = entry('Free', { price1mOutput: 0 })
    const paid = entry('Paid', { price1mOutput: 15 })
    expect(sortValue(free, 'price')).toBe(0)
    expect(sortEntries([paid, free], 'price', 'asc').map(e => e.name)).toEqual(['Free', 'Paid'])
  })
})
