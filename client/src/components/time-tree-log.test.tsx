// @vitest-environment jsdom
//
// The reading order is the feature: newest rows in full, then one click for the
// rest of the period on screen, then a shut `Full history`. What matters is
// which of those is visible at rest, and that nothing a closed fold hides is
// unaccounted for — a closed fold always carries its own summary.
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { TimeTreeLog } from './time-tree-log'
import type { OpenDepth } from '@/lib/time-tree'

beforeAll(() => {
  ;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
})

let root: Root | null = null
let host: HTMLDivElement | null = null

afterEach(() => {
  act(() => root?.unmount())
  host?.remove()
  root = null
  host = null
})

const NOW = new Date(2026, 8, 10, 12)
type Row = { id: string; at: Date }
/** Local-time fixtures: buckets are the reader's days (see lib/time-tree), so
 *  a UTC fixture would drift between buckets by machine zone. */
const row = (id: string, y: number, mo: number, d: number, h = 8): Row =>
  ({ id, at: new Date(y, mo - 1, d, h) })

// Both real callers pass a `recentLabel`; without one the section header falls
// back to the same key as the history fold and the two become indistinguishable.
function render(items: Row[], over: Partial<{ unit: OpenDepth; recentCount: number; foldAbove: number }> = {}) {
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  act(() => root!.render(
    <TimeTreeLog
      items={items}
      now={NOW}
      at={i => i.at}
      itemKey={i => i.id}
      summary={xs => `${xs.length} items`}
      row={i => <span data-row={i.id}>{i.id}</span>}
      recentLabel="HEAD"
      {...over}
    />,
  ))
  return host!
}

const rowIds = (el: HTMLElement) => [...el.querySelectorAll('[data-row]')].map(n => n.getAttribute('data-row'))
// No I18nProvider in this file, so `t` echoes the key and drops its vars.
// Buttons are found by key, and counts are asserted from what appears rather
// than from a label that cannot interpolate here.
const button = (el: HTMLElement, re: RegExp) =>
  [...el.querySelectorAll<HTMLElement>('button')].find(b => re.test(b.textContent ?? ''))
const treeFolds = (el: HTMLElement) =>
  [...el.querySelectorAll<HTMLElement>('li button[aria-expanded]')]

describe('TimeTreeLog at rest', () => {
  const many = Array.from({ length: 14 }, (_, i) => row(`r${i}`, 2026, 8, 1 + i))

  it('shows the newest rows and keeps Full history shut', () => {
    const el = render(many)
    // r13 is newest; ten of them, newest first.
    expect(rowIds(el)).toEqual(['r13', 'r12', 'r11', 'r10', 'r9', 'r8', 'r7', 'r6', 'r5', 'r4'])
    expect(button(el, /log\.history/)!.getAttribute('aria-expanded')).toBe('false')
    // Nothing of the tree is rendered while it is shut.
    expect(treeFolds(el)).toHaveLength(0)
  })

  it('states the whole log beside the shut history, so nothing hides', () => {
    const el = render(many)
    // The count is rendered directly, not through `t`, so it shows here.
    expect(button(el, /log\.history/)!.textContent).toContain('14')
  })

  it('reveals the tree when Full history is opened', () => {
    const el = render(many)
    act(() => button(el, /log\.history/)!.click())
    expect(treeFolds(el).length).toBeGreaterThan(0)
  })

  it('shows no history fold at all for a short log', () => {
    // Ten or fewer is already readable; a tree over it is ceremony.
    const items = Array.from({ length: 10 }, (_, i) => row(`r${i}`, 2026, 9, 1 + i))
    const el = render(items)
    expect(button(el, /log\.history/)).toBeUndefined()
    expect(rowIds(el)).toHaveLength(10)
  })
})

describe('TimeTreeLog, the rest of the current period', () => {
  // Twelve today plus one last month: the head holds ten, so two of today's
  // are still unseen.
  const items = [
    ...Array.from({ length: 12 }, (_, i) => row(`t${i}`, 2026, 9, 10, 1 + i)),
    row('old', 2026, 8, 3),
  ]

  it('offers only what it would actually add', () => {
    const el = render(items, { unit: 'day' })
    expect(rowIds(el)).toHaveLength(10)
    act(() => button(el, /log\.restOfDay/)!.click())
    // 12 today − 10 already in the head = 2 more, and nothing from last month.
    expect(rowIds(el)).toHaveLength(12)
  })

  it('appends those rows in place, without opening the history', () => {
    const el = render(items, { unit: 'day' })
    act(() => button(el, /log\.restOfDay/)!.click())
    expect(rowIds(el)).toHaveLength(12)
    expect(button(el, /log\.history/)!.getAttribute('aria-expanded')).toBe('false')
    expect(rowIds(el)).not.toContain('old')
  })

  it('offers the month, not the day, when that is the unit', () => {
    // A catalogue changes at the pace of a month, so the month is the useful
    // step. Same fixture, different unit, different control.
    const el = render(items, { unit: 'month' })
    expect(button(el, /log\.restOfDay/)).toBeUndefined()
    expect(button(el, /log\.restOfMonth/)).toBeDefined()
  })

  it('says nothing when the head already covers the period', () => {
    const el = render([row('a', 2026, 9, 10), row('b', 2026, 9, 10, 9)], { unit: 'day' })
    expect(button(el, /log\.restOf/)).toBeUndefined()
  })
})

describe('TimeTreeLog, history depth', () => {
  const spread = [
    row('today', 2026, 9, 10),
    ...Array.from({ length: 12 }, (_, i) => row(`old${i}`, 2026, 5, 1 + i)),
  ]

  it('opens down to today when the unit is the day', () => {
    const el = render(spread, { unit: 'day' })
    act(() => button(el, /log\.history/)!.click())
    const open = treeFolds(el).filter(b => b.getAttribute('aria-expanded') === 'true')
    // year, month, week, day
    expect(open).toHaveLength(4)
    expect(open.at(-1)!.textContent).toMatch(/Thu/)
  })

  it('stops at the month when the unit is the month', () => {
    const el = render(spread, { unit: 'month' })
    act(() => button(el, /log\.history/)!.click())
    const open = treeFolds(el).filter(b => b.getAttribute('aria-expanded') === 'true')
    // year and month only: week summaries are the grain a monthly log wants.
    expect(open).toHaveLength(2)
  })

  it('opens a single-day log completely, whatever the unit', () => {
    // Folding one day's rows behind three nested folds hides them and offers
    // nothing to choose between.
    const items = Array.from({ length: 12 }, (_, i) => row(`r${i}`, 2026, 5, 4, 8 + i))
    for (const unit of ['day', 'month'] as OpenDepth[]) {
      const el = render(items, { unit })
      act(() => button(el, /log\.history/)!.click())
      expect(treeFolds(el).filter(b => b.getAttribute('aria-expanded') === 'false')).toHaveLength(0)
      act(() => root!.unmount()); host!.remove(); root = null; host = null
    }
  })
})

describe('TimeTreeLog, the section fold', () => {
  const many = Array.from({ length: 14 }, (_, i) => row(`r${i}`, 2026, 8, 1 + i))

  it('collapses the whole log to one line that still reports its size', () => {
    // A log nobody is reading today should cost one line and no more — but
    // collapsing it must not hide that there is anything in it.
    const el = render(many)
    const section = button(el, /HEAD/)!
    act(() => section.click())
    expect(rowIds(el)).toHaveLength(0)
    expect(button(el, /log\.history/)).toBeUndefined()
    expect(section.textContent).toContain('14 items')
  })

  it('keeps a fold the reader closed closed, rather than re-deriving it', () => {
    const el = render(many)
    act(() => button(el, /log\.history/)!.click())
    const week = treeFolds(el).find(b => b.getAttribute('aria-expanded') === 'true')!
    act(() => week.click())
    expect(week.getAttribute('aria-expanded')).toBe('false')
  })

  it('renders nothing at all for an empty log', () => {
    expect(render([]).innerHTML).toBe('')
  })
})
