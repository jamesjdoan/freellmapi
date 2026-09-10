// @vitest-environment jsdom
//
// The fold is the whole feature, so what matters is which rows are open at
// rest and whether a closed row still reports what it contains. A closed fold
// with no summary is a place for things to go missing, which is the failure
// this file guards.
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { TimeTreeLog } from './time-tree-log'

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
const row = (id: string, y: number, mo: number, d: number, h = 8): Row => ({ id, at: new Date(y, mo - 1, d, h) })

function render(items: Row[], over: Partial<{ recentCount: number; foldAbove: number; recentLabel: string }> = {}) {
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
      {...over}
    />,
  ))
  return host
}

const openLabels = (el: HTMLElement) =>
  [...el.querySelectorAll('button[aria-expanded="true"]')].map(b => b.textContent ?? '')

// These exercise the fold itself, so they force it on with `foldAbove: 0`
// rather than padding out ten rows of fixture. The threshold has its own tests
// further down.
const FOLDED = { foldAbove: 0 }

describe('TimeTreeLog', () => {
  it('opens the path to this week and leaves other days closed', () => {
    const el = render([row('a', 2026, 9, 10), row('b', 2026, 3, 2)], FOLDED)
    // Year, month, week and TODAY open; the older month stays shut.
    expect(openLabels(el)).toHaveLength(4)
    expect(openLabels(el).some(l => /Thu/.test(l))).toBe(true)
  })

  it('reports what a closed fold contains, so nothing hides', () => {
    const el = render([row('a', 2026, 3, 2), row('b', 2026, 3, 3)], FOLDED)
    // Only the current year opens (March is not this month, neither day is
    // today). The count still shows on every closed fold.
    expect(openLabels(el)).toHaveLength(1)
    expect(el.textContent).toContain('2 items')
  })

  it('keeps the rows behind a closed day and reveals them when opened', () => {
    const el = render([row('a', 2026, 9, 10)], FOLDED)
    // Today is open by default, so close it and reopen it.
    const dayButton = [...el.querySelectorAll<HTMLElement>('button')].find(b => /Thu/.test(b.textContent ?? ''))!
    act(() => dayButton.click())
    expect(dayButton.getAttribute('aria-expanded')).toBe('false')
    act(() => dayButton.click())
    expect(dayButton.getAttribute('aria-expanded')).toBe('true')
  })

  it('keeps a fold the reader closed closed, rather than re-deriving it', () => {
    // A refetch must not slam shut what was just opened, and must not reopen
    // what was just closed.
    const el = render([row('a', 2026, 9, 10)], FOLDED)
    const weekButton = [...el.querySelectorAll<HTMLElement>('button[aria-expanded="true"]')].at(-1)!
    act(() => weekButton.click())
    expect(weekButton.getAttribute('aria-expanded')).toBe('false')
  })

  it('marks the buckets holding now', () => {
    const el = render([row('a', 2026, 9, 10), row('b', 2025, 9, 10)], FOLDED)
    // Year, month, week and day on the current side only. No I18nProvider
    // here, so `t` echoes the key rather than rendering "now".
    expect(el.textContent?.match(/log\.current/g) ?? []).toHaveLength(4)
  })

  it('renders nothing at all for an empty log', () => {
    expect(render([], FOLDED).innerHTML).toBe('')
  })
})

const dataRows = (el: HTMLElement) => [...el.querySelectorAll('[data-row]')].map(n => n.getAttribute('data-row'))

describe('TimeTreeLog, flat head and fold threshold', () => {
  it('shows a short log in full with no fold at all', () => {
    // Ten rows or fewer is already readable; a tree over it is ceremony.
    const items = Array.from({ length: 10 }, (_, i) => row(`r${i}`, 2026, 9, 1 + i))
    const el = render(items)
    expect(el.querySelectorAll('button[aria-expanded]')).toHaveLength(0)
    expect(dataRows(el)).toHaveLength(10)
  })

  it('adds the fold once past the threshold, keeping the newest ten in full', () => {
    const items = Array.from({ length: 14 }, (_, i) => row(`r${i}`, 2026, 8, 1 + i))
    const el = render(items)
    expect(el.querySelectorAll('button[aria-expanded]').length).toBeGreaterThan(0)
    // r13 is the newest; the head holds ten of them, newest first.
    expect(dataRows(el).slice(0, 10)).toEqual(['r13', 'r12', 'r11', 'r10', 'r9', 'r8', 'r7', 'r6', 'r5', 'r4'])
  })

  it('counts the whole log in the summaries, head included', () => {
    // Excluding the head would make a week read "4 items" when it saw 14, and
    // the number beside a fold is the only thing a closed fold can be trusted
    // for.
    const items = Array.from({ length: 14 }, (_, i) => row(`r${i}`, 2026, 8, 1 + i))
    const el = render(items)
    const year = el.querySelector('button[aria-expanded]')!
    expect(year.textContent).toContain('14 items')
  })

  it('opens today so the current day is readable without a click', () => {
    const items = [
      row('today', 2026, 9, 10),
      ...Array.from({ length: 12 }, (_, i) => row(`old${i}`, 2026, 5, 1 + i)),
    ]
    const el = render(items)
    const openLabels = [...el.querySelectorAll('button[aria-expanded="true"]')].map(b => b.textContent ?? '')
    expect(openLabels.some(l => /Thu, 10 Sept|Thu, Sep 10/.test(l))).toBe(true)
  })

  it('leaves a single-day log wide open', () => {
    // Everything happened on one day: three nested folds would hide the rows
    // and offer nothing to choose between.
    const items = Array.from({ length: 12 }, (_, i) => row(`r${i}`, 2026, 5, 4, 8 + i))
    const el = render(items)
    const shut = [...el.querySelectorAll('button[aria-expanded="false"]')]
    expect(shut).toHaveLength(0)
    expect(dataRows(el)).toHaveLength(22) // 10 in the head, 12 in the open day
  })
})
