// @vitest-environment jsdom
//
// "Check for updates" used to spin and say nothing, so finding nothing new,
// applying an update and failing looked the same. These pin the three answers
// and that an applied update names what moved, switched-off models included.
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { I18nProvider } from '@/i18n'
import { SyncOutcome, type SyncResultView } from './sync-outcome'

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

function render(result: SyncResultView | null, error: string | null = null) {
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  act(() => root!.render(<I18nProvider initialLocale="en"><SyncOutcome result={result} error={error} at={null} /></I18nProvider>))
  return host.textContent ?? ''
}

describe('SyncOutcome', () => {
  it('says the catalog is up to date', () => {
    expect(render({ ok: true, action: 'up_to_date', version: '2026.10.13.368926f1' })).toBe('Up to date: 2026.10.13.368926f1')
  })

  it('names what an applied update moved, and skips zero counts', () => {
    const text = render({
      ok: true, action: 'applied', version: '2026.10.14.aaaa',
      changes: { added: 30, removed: 0, changed: 2, switchedOff: 20, switchedOn: 0 },
    })
    expect(text).toBe('Applied 2026.10.14.aaaa: +30 added, 20 switched off, ~2 changed')
  })

  it('says when an applied update moved no models', () => {
    expect(render({ ok: true, action: 'applied', version: 'v', changes: { added: 0, removed: 0, changed: 0, switchedOff: 0, switchedOn: 0 } }))
      .toBe('Applied v: no model changes')
  })

  it('reports a failure from the server and from the request alike', () => {
    expect(render({ ok: false, action: 'error', detail: 'catalog fetch failed: HTTP 503' })).toBe('Update failed: catalog fetch failed: HTTP 503')
    act(() => root?.unmount())
    host?.remove()
    expect(render(null, 'Network error')).toBe('Update failed: Network error')
  })

  it('renders nothing before the first check', () => {
    expect(render(null)).toBe('')
  })
})
