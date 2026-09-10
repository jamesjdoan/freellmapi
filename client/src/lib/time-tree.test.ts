import { describe, expect, it } from 'vitest'
import { buildTimeTree, defaultOpenIds, isoWeek, parseSqliteUtc, startOfIsoWeek } from './time-tree'

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

  it('opens the path to the current week and leaves its days shut', () => {
    // The whole point: the reader lands on this week's summary, not on a wall
    // of individual rows, and not on nothing.
    const tree = buildTimeTree([item(2026, 9, 10), item(2026, 2, 2)], at, now)
    const open = defaultOpenIds(tree)
    const year = tree[0]
    const currentMonth = year.children.find(m => m.current)!
    const currentWeek = currentMonth.children[0]
    expect(open.has(year.id)).toBe(true)
    expect(open.has(currentMonth.id)).toBe(true)
    expect(open.has(currentWeek.id)).toBe(true)
    // Days closed, and the older month closed.
    expect(open.has(currentWeek.children[0].id)).toBe(false)
    expect(open.has(year.children.find(m => !m.current)!.id)).toBe(false)
  })

  it('opens nothing when the log has no entry this week', () => {
    // Opening an absent week would render an empty expanded row.
    const tree = buildTimeTree([item(2026, 2, 2)], at, now)
    expect(defaultOpenIds(tree).size).toBe(0)
  })
})
