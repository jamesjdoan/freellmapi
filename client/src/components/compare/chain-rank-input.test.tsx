// @vitest-environment jsdom
//
// The field writes live routing: the number typed here decides what the router
// tries first. Browser automation could not reach the input (it sits in a
// clipped table cell), so the commit rules are pinned here instead — and they
// are rules, not rendering: when a write fires, and just as importantly when it
// must not.
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { RankInput } from './chain-picker'

beforeAll(() => {
  ;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
})

let root: Root | null = null
let host: HTMLDivElement | null = null

function render(ui: React.ReactElement) {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  act(() => { root!.render(ui) })
  return host.querySelector('input') as HTMLInputElement
}

afterEach(() => {
  act(() => { root?.unmount() })
  host?.remove()
  root = null
  host = null
})

function type(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!
  act(() => {
    setter.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

describe('RankInput', () => {
  it('writes the typed position on blur', () => {
    const seen: number[] = []
    const input = render(<RankInput chain="Apex" rank={5} onSet={n => seen.push(n)} />)

    type(input, '1')
    act(() => { input.dispatchEvent(new FocusEvent('focusout', { bubbles: true })) })

    expect(seen).toEqual([1])
  })

  it('writes nothing while the number is still being typed', () => {
    // Committing on keystroke would read "12" as 1 first, reorder the chain,
    // then reorder it again — landing somewhere nobody asked for.
    const seen: number[] = []
    const input = render(<RankInput chain="Apex" rank={5} onSet={n => seen.push(n)} />)

    type(input, '1')
    type(input, '12')

    expect(seen).toEqual([])
  })

  it('writes nothing when the value is unchanged', () => {
    // Every write renumbers the whole chain, so a no-op edit must stay a no-op.
    const seen: number[] = []
    const input = render(<RankInput chain="Apex" rank={5} onSet={n => seen.push(n)} />)

    type(input, '5')
    act(() => { input.dispatchEvent(new FocusEvent('focusout', { bubbles: true })) })

    expect(seen).toEqual([])
  })

  it('abandons the edit on Escape and shows the real position again', () => {
    const seen: number[] = []
    const input = render(<RankInput chain="Apex" rank={5} onSet={n => seen.push(n)} />)

    type(input, '2')
    act(() => { input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })) })

    expect(seen).toEqual([])
    expect(input.value).toBe('5')
  })

  it('refuses a position below 1 rather than sending it', () => {
    const seen: number[] = []
    const input = render(<RankInput chain="Apex" rank={5} onSet={n => seen.push(n)} />)

    type(input, '0')
    act(() => { input.dispatchEvent(new FocusEvent('focusout', { bubbles: true })) })

    expect(seen).toEqual([])
    expect(input.value).toBe('5')
  })

  it('follows the position when other models move around it', () => {
    // The row re-renders as the chain changes underneath; a stale draft would
    // write back the slot this model held two edits ago.
    const input = render(<RankInput chain="Apex" rank={5} onSet={() => {}} />)
    type(input, '3')

    act(() => { root!.render(<RankInput chain="Apex" rank={2} onSet={() => {}} />) })

    expect((host!.querySelector('input') as HTMLInputElement).value).toBe('2')
  })
})
