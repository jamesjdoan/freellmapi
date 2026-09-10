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

function render(items: Row[]) {
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
    />,
  ))
  return host
}

const openLabels = (el: HTMLElement) =>
  [...el.querySelectorAll('button[aria-expanded="true"]')].map(b => b.textContent ?? '')

describe('TimeTreeLog', () => {
  it('opens the path to this week and leaves the days closed', () => {
    const el = render([row('a', 2026, 9, 10), row('b', 2026, 3, 2)])
    // Year, month and week open — three folds, no day.
    expect(openLabels(el)).toHaveLength(3)
    // The individual rows are behind the closed day.
    expect(el.querySelector('[data-row="a"]')).toBeNull()
  })

  it('reports what a closed fold contains, so nothing hides', () => {
    const el = render([row('a', 2026, 3, 2), row('b', 2026, 3, 3)])
    // Nothing is open: March is not this week. The count still shows.
    expect(openLabels(el)).toHaveLength(0)
    expect(el.textContent).toContain('2 items')
  })

  it('reveals the rows when a day is opened', () => {
    const el = render([row('a', 2026, 9, 10)])
    const dayButton = [...el.querySelectorAll('button')].find(b => /Thu/.test(b.textContent ?? ''))!
    act(() => dayButton.click())
    expect(el.querySelector('[data-row="a"]')).not.toBeNull()
  })

  it('keeps a fold the reader closed closed, rather than re-deriving it', () => {
    // A refetch must not slam shut what was just opened, and must not reopen
    // what was just closed.
    const el = render([row('a', 2026, 9, 10)])
    const weekButton = [...el.querySelectorAll<HTMLElement>('button[aria-expanded="true"]')].at(-1)!
    act(() => weekButton.click())
    expect(weekButton.getAttribute('aria-expanded')).toBe('false')
  })

  it('marks the buckets holding now', () => {
    const el = render([row('a', 2026, 9, 10), row('b', 2025, 9, 10)])
    // Year, month, week and day on the current side only. No I18nProvider
    // here, so `t` echoes the key rather than rendering "now".
    expect(el.textContent?.match(/log\.current/g) ?? []).toHaveLength(4)
  })

  it('renders nothing at all for an empty log', () => {
    expect(render([]).innerHTML).toBe('')
  })
})
