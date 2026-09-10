// @vitest-environment jsdom
//
// The chip's counts are trivial; its whole value is the detail behind them, and
// that detail is reachable only through the tooltip. A static-markup check
// would have passed while the tooltip stayed shut: `Tooltip` put `onFocus` on a
// wrapper span that nothing could focus, so the keyboard path was dead for
// every tooltip in the app until `focusable` was added. This file focuses the
// chip for real and reads what opens.
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { ProviderChurnChip } from './provider-churn'
import type { ProviderChurn } from '@/lib/catalogue-changes'

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
  document.querySelectorAll('[role=tooltip]').forEach(n => n.remove())
})

function render(churn: ProviderChurn | undefined) {
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  act(() => root!.render(<ProviderChurnChip churn={churn} />))
  return host
}

const arrival = (modelId: string, displayName: string, firstSeenAt: string, chains: string[] = []) => ({
  platform: 'groq', modelId, displayName, firstSeenAt,
  routed: chains.length > 0, chains, supportsTools: true, supportsVision: false, contextWindow: null,
})

const departure = (modelId: string, retiredAt: string) => ({
  platform: 'groq', modelId, retiredAt, reason: null, lostFrom: [], acknowledgedAt: null,
})

describe('ProviderChurnChip', () => {
  it('says nothing at all for a provider whose catalogue held still', () => {
    // Most providers, most of the time. A "+0 -0" on every row would cost the
    // width the Keys page needs to compare all of them at a glance.
    expect(render(undefined).innerHTML).toBe('')
    expect(render({ arrived: [], departed: [] }).innerHTML).toBe('')
  })

  it('counts both directions separately', () => {
    const el = render({
      arrived: [arrival('a', 'A', '2026-09-08 09:00:00'), arrival('b', 'B', '2026-09-07 09:00:00')],
      departed: [departure('gone', '2026-09-04 09:00:00')],
    })
    expect(el.textContent).toContain('+2')
    expect(el.textContent).toContain('−1')
  })

  it('reveals the model names and dates on keyboard focus', () => {
    const el = render({
      arrived: [arrival('openai/gpt-oss-20b', 'GPT-OSS 20B', '2026-09-08 09:00:00')],
      departed: [departure('gemini-2.5-pro', '2026-09-04 09:00:00')],
    })
    // The names are NOT in the row itself - that is the point of the chip.
    expect(el.textContent).not.toContain('GPT-OSS 20B')

    const stop = el.querySelector<HTMLElement>('[tabindex="0"]')
    expect(stop).not.toBeNull()
    act(() => stop!.focus())

    const tip = document.querySelector('[role=tooltip]')
    expect(tip).not.toBeNull()
    expect(tip!.textContent).toContain('GPT-OSS 20B')
    expect(tip!.textContent).toContain('2026-09-08')
    expect(tip!.textContent).toContain('gemini-2.5-pro')
    expect(tip!.textContent).toContain('2026-09-04')
  })

  it('names the chains a new model has already joined', () => {
    // An arrival that is merely in the catalogue is news; one already serving
    // traffic is the row that needs acting on.
    const el = render({ arrived: [arrival('x', 'X', '2026-09-08 09:00:00', ['Fast-Lane', 'Default'])], departed: [] })
    act(() => el.querySelector<HTMLElement>('[tabindex="0"]')!.focus())
    expect(document.querySelector('[role=tooltip]')!.textContent).toContain('Fast-Lane, Default')
  })
})
