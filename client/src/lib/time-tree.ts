// Group a flat, time-stamped list into Year > Month > Week > Day.
//
// Both the catalogue log and the routing-decision (shadow) log are append-only
// streams that get long and are read the same way: "what happened lately", then
// occasionally "what happened back then". A flat list answers the first badly
// and the second not at all.
//
// Everything starts collapsed except the current week, whose days stay
// collapsed too. So the default view is a handful of rows - this week, and the
// closed months and years above it - and every closed row carries the summary
// of what is inside, so collapsing never hides the fact that something
// happened.
//
// Pure and generic on purpose: the caller supplies a timestamp and a summariser
// for its own item type, and gets a tree back. No React, no fetching, testable
// on its own.

export type TimeTreeLevel = 'year' | 'month' | 'week' | 'day'

export interface TimeTreeNode<T> {
  /** Stable across renders and unique among siblings, for keys and open-state. */
  id: string
  level: TimeTreeLevel
  /** Start of the bucket, for labelling in the reader's own locale. */
  start: Date
  /** Every item inside this bucket, including all descendants. */
  items: T[]
  children: TimeTreeNode<T>[]
  /** True for the bucket containing `now` at this level. */
  current: boolean
}

// Buckets are the READER'S days, not UTC days.
//
// The stored timestamps are UTC and the rows render their time in local time,
// like the rest of the dashboard. Bucketing by UTC made the two disagree: an
// event at 14:00 UTC appeared under "Thu, Sep 10" showing 00:00, which in
// UTC+10 was Friday the 11th. Whichever half you trusted, the other was wrong.
// So every date part below comes from the local accessors, and the labels are
// formatted in local time to match.

/** ISO-8601 week in local time: weeks start Monday, week 1 holds the first
 *  Thursday. */
export function isoWeek(date: Date): { year: number; week: number } {
  const d = new Date(date.getFullYear(), date.getMonth(), date.getDate())
  // Thursday of this week decides which year the week belongs to, which is
  // what makes a 29 December belong to week 1 of the next year.
  const day = d.getDay() || 7
  d.setDate(d.getDate() + 4 - day)
  const yearStart = new Date(d.getFullYear(), 0, 1)
  // Day difference rather than raw ms: a DST change inside the span would make
  // a millisecond division land a day out.
  const days = Math.round((d.getTime() - yearStart.getTime()) / 86_400_000)
  return { year: d.getFullYear(), week: Math.ceil((days + 1) / 7) }
}

/** Local midnight on the Monday of the week holding `date`. */
export function startOfIsoWeek(date: Date): Date {
  const d = new Date(date.getFullYear(), date.getMonth(), date.getDate())
  const day = d.getDay() || 7
  d.setDate(d.getDate() - (day - 1))
  return d
}

/**
 * SQLite writes `YYYY-MM-DD HH:MM:SS` in UTC with no zone marker, which
 * `new Date()` reads as LOCAL time - shifting every row by the offset and, for
 * anyone west of UTC, moving late-evening events into the previous day. Parsed
 * explicitly rather than relying on the engine.
 */
export function parseSqliteUtc(value: string): Date {
  const m = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2}):(\d{2})/.exec(value)
  if (!m) return new Date(value)
  return new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]))
}

const pad = (n: number) => String(n).padStart(2, '0')

/**
 * @param items anything with a timestamp; order does not matter
 * @param at    reads the timestamp off an item
 * @param now   injected so tests are not wall-clock dependent
 */
export function buildTimeTree<T>(
  items: readonly T[],
  at: (item: T) => Date,
  now: Date = new Date(),
): TimeTreeNode<T>[] {
  const nowWeek = isoWeek(now)
  const localDayStart = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate())
  const todayStart = localDayStart(now).getTime()
  const keyed = items.map(item => ({ item, when: at(item) }))
  // Newest first at every level, so the tree reads top-down as most-recent.
  keyed.sort((a, b) => b.when.getTime() - a.when.getTime())

  const years = new Map<string, TimeTreeNode<T>>()
  for (const { item, when } of keyed) {
    const y = when.getFullYear()
    const mo = when.getMonth()
    const week = isoWeek(when)
    const dayStart = localDayStart(when)

    const yearId = `y${y}`
    // A month id carries its year: two Januaries must not merge.
    const monthId = `${yearId}-m${pad(mo + 1)}`
    // A week id carries its ISO week-year, which is NOT always the calendar
    // year of its days - the week spanning New Year belongs to one of them.
    const weekId = `w${week.year}-${pad(week.week)}`
    const dayId = `d${y}-${pad(mo + 1)}-${pad(when.getDate())}`

    const year = upsert(years, yearId, () => ({
      id: yearId, level: 'year', start: new Date(y, 0, 1),
      items: [], children: [], current: y === now.getFullYear(),
    }))
    year.items.push(item)

    const month = upsertChild(year, monthId, () => ({
      id: monthId, level: 'month', start: new Date(y, mo, 1),
      items: [], children: [],
      current: y === now.getFullYear() && mo === now.getMonth(),
    }))
    month.items.push(item)

    const weekNode = upsertChild(month, weekId, () => ({
      id: weekId, level: 'week', start: startOfIsoWeek(when),
      items: [], children: [],
      current: week.year === nowWeek.year && week.week === nowWeek.week,
    }))
    weekNode.items.push(item)

    const day = upsertChild(weekNode, dayId, () => ({
      id: dayId, level: 'day', start: dayStart, items: [], children: [],
      current: dayStart.getTime() === todayStart,
    }))
    day.items.push(item)
  }

  return [...years.values()]
}

function upsert<T>(map: Map<string, TimeTreeNode<T>>, id: string, make: () => TimeTreeNode<T>): TimeTreeNode<T> {
  const found = map.get(id)
  if (found) return found
  const made = make()
  map.set(id, made)
  return made
}

function upsertChild<T>(parent: TimeTreeNode<T>, id: string, make: () => TimeTreeNode<T>): TimeTreeNode<T> {
  const found = parent.children.find(c => c.id === id)
  if (found) return found
  const made = make()
  parent.children.push(made)
  return made
}

/**
 * The ids open on first render: the chain from each year down to the CURRENT
 * week, and nothing else. Days stay shut even inside the open week - the day
 * summaries are the point, and expanding one is a deliberate act.
 *
 * A week only counts as current if it actually has items; an empty log opens
 * nothing rather than opening a week that is not there.
 */
export function defaultOpenIds<T>(tree: readonly TimeTreeNode<T>[]): Set<string> {
  const open = new Set<string>()
  for (const year of tree) {
    for (const month of year.children) {
      for (const week of month.children) {
        if (!week.current) continue
        open.add(year.id)
        open.add(month.id)
        open.add(week.id)
      }
    }
  }
  return open
}
