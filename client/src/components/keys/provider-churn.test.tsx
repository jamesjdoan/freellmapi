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
import { ProviderChurnChip, ProviderChurnPanel } from './provider-churn'
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

describe('ProviderChurnPanel', () => {
  const churn = {
    arrived: [arrival('openai/new-model', 'New Model', '2026-09-08 09:00:00', ['Fast-Lane'])],
    departed: [departure('gemini-2.5-pro', '2026-09-04 09:00:00')],
  }

  function renderPanel(over: Partial<Parameters<typeof ProviderChurnPanel>[0]> = {}) {
    host = document.createElement('div')
    document.body.append(host)
    root = createRoot(host)
    const props = {
      churn,
      isServed: () => true,
      onSetServed: () => {},
      pending: false,
      disabledReason: () => null,
      ...over,
    }
    act(() => root!.render(<ProviderChurnPanel {...props} />))
    return host
  }

  it('lists both directions with the model names the chip only hinted at', () => {
    const el = renderPanel()
    expect(el.textContent).toContain('New Model')
    expect(el.textContent).toContain('gemini-2.5-pro')
    expect(el.textContent).toContain('2026-09-08')
  })

  it('reports the scope change a switch would make, by model id', () => {
    const calls: [string, boolean][] = []
    const el = renderPanel({ onSetServed: (id, served) => calls.push([id, served]) })
    // The id is what the scope stores; the display name is not addressable.
    const sw = el.querySelector<HTMLElement>('[aria-label="openai/new-model"]')!
    act(() => sw.click())
    expect(calls).toEqual([['openai/new-model', false]])
  })

  it('offers a retired model its switch, so it can be taken out of scope', () => {
    // It is gone upstream but can still be sitting in the key's scope, and
    // removing it is the cleanup the departure implies.
    const el = renderPanel()
    expect(el.querySelector('[aria-label="gemini-2.5-pro"]')).not.toBeNull()
  })

  it('disables the switch it cannot honour instead of failing the write', () => {
    const calls: string[] = []
    const el = renderPanel({
      disabledReason: id => (id === 'openai/new-model' ? 'cannot scope to nothing' : null),
      onSetServed: id => calls.push(id),
    })
    const sw = el.querySelector<HTMLElement>('[aria-label="openai/new-model"]')!
    act(() => sw.click())
    expect(calls).toEqual([])
  })

  it('renders nothing when this provider gained and lost nothing', () => {
    expect(renderPanel({ churn: { arrived: [], departed: [] } }).innerHTML).toBe('')
  })
})

describe('ProviderChurnPanel, retired models', () => {
  const gone = { arrived: [], departed: [departure('gemini-2.5-pro', '2026-09-04 09:00:00')] }

  function renderWith(isServed: (id: string) => boolean, onSetServed = () => {}) {
    host = document.createElement('div')
    document.body.append(host)
    root = createRoot(host)
    act(() => root!.render(
      <ProviderChurnPanel
        churn={gone}
        isServed={isServed}
        onSetServed={onSetServed}
        pending={false}
        disabledReason={() => null}
      />,
    ))
    return host
  }

  it('offers no switch when the key never listed the retired model', () => {
    // Retirement DELETES the catalogue row - only a tombstone survives - so the
    // id resolves to nothing, is absent from the picker and uncounted by the
    // n/m badge. A switch there would be a control over nothing.
    const el = renderWith(() => false)
    expect(el.querySelector('[aria-label="gemini-2.5-pro"]')).toBeNull()
    // No I18nProvider in this file, so `t` echoes the key - assert on that
    // rather than on English that a translation would legitimately change.
    expect(el.textContent).toContain('keys.churnNotScoped')
  })

  it('offers the switch while the stale id is still in scope', () => {
    // Here it is real cleanup: the scope holds a string pointing at a model
    // that no longer exists, and taking it out is the point.
    const el = renderWith(() => true)
    expect(el.querySelector('[aria-label="gemini-2.5-pro"]')).not.toBeNull()
    expect(el.textContent).not.toContain('keys.churnNotScoped')
  })

  it('still names the model and its date either way', () => {
    for (const served of [true, false]) {
      const el = renderWith(() => served)
      expect(el.textContent).toContain('gemini-2.5-pro')
      expect(el.textContent).toContain('2026-09-04')
      act(() => root!.unmount()); host!.remove(); root = null; host = null
    }
  })
})
