import { describe, expect, it } from 'vitest'
import { buildTimeTree, defaultOpenIds, isoWeek, mostRecent, parseSqliteUtc, startOfIsoWeek, withinCurrentUnit } from './time-tree'

const at = (x: { when: Date }) => x.when
/** Built in LOCAL time on purpose: buckets are the reader's days, so a fixture
 *  written as UTC would move between buckets depending on the machine's zone
 *  and make these assertions flaky rather than wrong. */
const item = (y: number, mo: number, d: number, h = 8) => ({ when: new Date(y, mo - 1, d, h) })

describe('parseSqliteUtc', () => {
  it('reads SQLite timestamps as UTC, not as local time', () => {
    // `new Date('2026-09-10 22:30:00')` is LOCAL, which west of UTC drops the
    // event into the previous day and puts it in the wrong bucket.
    expect(parseSqliteUtc('2026-09-10 22:30:00').toISOString()).toBe('2026-09-10T22:30:00.000Z')
  })
})

describe('isoWeek', () => {
  it('puts the New Year straddle in the week its Thursday belongs to', () => {
    // 2026-12-31 is a Thursday, so its week is week 53 of 2026, and
    // 2027-01-01 (Friday) is in that same week - not week 1 of 2027.
    expect(isoWeek(new Date(2026, 11, 31, 12))).toEqual({ year: 2026, week: 53 })
    expect(isoWeek(new Date(2027, 0, 1, 12))).toEqual({ year: 2026, week: 53 })
  })

  it('starts weeks on Monday', () => {
    // 2026-09-10 is a Thursday; its week starts Monday the 7th, local midnight.
    const monday = startOfIsoWeek(new Date(2026, 8, 10, 12))
    expect([monday.getFullYear(), monday.getMonth(), monday.getDate(), monday.getHours()])
      .toEqual([2026, 8, 7, 0])
  })
})

describe('buildTimeTree', () => {
  const now = new Date(2026, 8, 10, 12)

  it('nests year > month > week > day and rolls items up every level', () => {
    const tree = buildTimeTree(
      [item(2026, 9, 10), item(2026, 9, 10, 9), item(2026, 9, 8, 9)],
      at, now,
    )
    expect(tree).toHaveLength(1)
    const [year] = tree
    expect(year.items).toHaveLength(3)
    const month = year.children[0]
    const week = month.children[0]
    expect(week.items).toHaveLength(3)
    // Two days inside the one week; the 10th holds two items.
    expect(week.children.map(d => d.items.length)).toEqual([2, 1])
  })

  it('orders newest first at every level', () => {
    const tree = buildTimeTree(
      [item(2025, 3, 2, 10), item(2026, 9, 10, 10), item(2026, 1, 4, 10)],
      at, now,
    )
    expect(tree.map(y => y.start.getFullYear())).toEqual([2026, 2025])
    expect(tree[0].children.map(m => m.start.getMonth())).toEqual([8, 0])
  })

  it('marks the buckets containing now, and only those', () => {
    const tree = buildTimeTree([item(2026, 9, 10), item(2026, 7, 1)], at, now)
    const [year] = tree
    expect(year.current).toBe(true)
    expect(year.children.map(m => m.current)).toEqual([true, false])
    expect(year.children[0].children[0].current).toBe(true)
    expect(year.children[0].children[0].children[0].current).toBe(true)
  })

  it('keeps two Januaries of different years apart', () => {
    const tree = buildTimeTree([item(2026, 1, 5), item(2025, 1, 6)], at, now)
    expect(tree).toHaveLength(2)
    expect(tree.every(y => y.children.length === 1)).toBe(true)
  })
})

describe('defaultOpenIds', () => {
  const now = new Date(2026, 8, 10, 12)

  it('opens the path to TODAY, today included', () => {
    // The reader's own day is what they came to look at; making them click
    // down to it is a toll. Older buckets stay shut, carrying their summary.
    const tree = buildTimeTree([item(2026, 9, 10), item(2026, 9, 8), item(2026, 2, 2)], at, now)
    const open = defaultOpenIds(tree)
    const year = tree[0]
    const currentMonth = year.children.find(m => m.current)!
    const currentWeek = currentMonth.children.find(w => w.current)!
    const today = currentWeek.children.find(d => d.current)!
    expect(open.has(year.id)).toBe(true)
    expect(open.has(currentMonth.id)).toBe(true)
    expect(open.has(currentWeek.id)).toBe(true)
    expect(open.has(today.id)).toBe(true)
    // A sibling day in the same open week stays shut, as does an older month.
    expect(open.has(currentWeek.children.find(d => !d.current)!.id)).toBe(false)
    expect(open.has(year.children.find(m => !m.current)!.id)).toBe(false)
  })

  it('opens everything when the whole log covers one day', () => {
    // Folding one day's rows behind three nested folds is ceremony over
    // nothing - even when that day is not today.
    const tree = buildTimeTree([item(2026, 2, 2), item(2026, 2, 2, 15)], at, now)
    const open = defaultOpenIds(tree)
    const year = tree[0]
    const month = year.children[0]
    const week = month.children[0]
    expect([year.id, month.id, week.id, week.children[0].id].every(id => open.has(id))).toBe(true)
  })

  it('does not open a lone past day once the log spans more than one', () => {
    // The single-day rule is whole-log on purpose. Per bucket it fires
    // constantly - a sparse log has one day in most of its weeks - and then
    // every fold is open and the condensing means nothing.
    const tree = buildTimeTree([item(2026, 2, 2), item(2026, 2, 20)], at, now)
    const open = defaultOpenIds(tree)
    // The current YEAR is still open - it is current, and showing month
    // summaries under it is the point. Nothing below it opens: February is
    // not this month and neither of its days is today.
    expect([...open]).toEqual([tree[0].id])
  })

  it('opens nothing for an empty log', () => {
    expect(defaultOpenIds(buildTimeTree([], at, now)).size).toBe(0)
  })
})

describe('mostRecent', () => {
  it('returns the newest first, capped', () => {
    const items = [item(2026, 9, 1), item(2026, 9, 3), item(2026, 9, 2)]
    expect(mostRecent(items, at, 2).map(i => i.when.getDate())).toEqual([3, 2])
  })

  it('does not mutate the caller\'s array', () => {
    const items = [item(2026, 9, 1), item(2026, 9, 3)]
    const before = items.map(i => i.when.getDate())
    mostRecent(items, at, 2)
    expect(items.map(i => i.when.getDate())).toEqual(before)
  })
})

describe('defaultOpenIds depth', () => {
  const now = new Date(2026, 8, 10, 12)
  const tree = () => buildTimeTree([item(2026, 9, 10), item(2026, 9, 8), item(2026, 5, 2)], at, now)

  it('stops at the month when asked, leaving week summaries', () => {
    // A catalogue changes at the pace of a month, so weeks are the grain to
    // show; opening to the day would bury them.
    const open = defaultOpenIds(tree(), 'month')
    const year = tree()[0]
    const month = year.children.find(m => m.current)!
    expect(open.has(year.id)).toBe(true)
    expect(open.has(month.id)).toBe(true)
    expect(open.has(month.children.find(w => w.current)!.id)).toBe(false)
  })

  it('reaches today when asked for the day', () => {
    const open = defaultOpenIds(tree(), 'day')
    const month = tree()[0].children.find(m => m.current)!
    const week = month.children.find(w => w.current)!
    expect(open.has(week.id)).toBe(true)
    expect(open.has(week.children.find(d => d.current)!.id)).toBe(true)
  })

  it('opens a single-day log completely regardless of depth', () => {
    const single = buildTimeTree([item(2026, 5, 2), item(2026, 5, 2, 14)], at, now)
    for (const depth of ['month', 'day'] as const) {
      const open = defaultOpenIds(single, depth)
      const week = single[0].children[0].children[0]
      expect(open.has(week.children[0].id)).toBe(true)
    }
  })
})

describe('withinCurrentUnit', () => {
  const now = new Date(2026, 8, 10, 12)

  it('takes today only, newest first', () => {
    const items = [item(2026, 9, 10, 9), item(2026, 9, 10, 15), item(2026, 9, 9)]
    expect(withinCurrentUnit(items, at, 'day', now).map(i => i.when.getHours())).toEqual([15, 9])
  })

  it('takes the whole month when that is the unit', () => {
    const items = [item(2026, 9, 10), item(2026, 9, 1), item(2026, 8, 31)]
    expect(withinCurrentUnit(items, at, 'month', now)).toHaveLength(2)
  })

  it('does not match the same month in another year', () => {
    const items = [item(2026, 9, 3), item(2025, 9, 3)]
    expect(withinCurrentUnit(items, at, 'month', now)).toHaveLength(1)
  })
})
