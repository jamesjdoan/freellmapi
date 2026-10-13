// @vitest-environment jsdom
//
// The syncs strip answers "what did each catalog update change" with three
// numbers per row and a lazily fetched field diff. These tests pin the parts a
// server test cannot see: the empty log says so rather than rendering a
// shell, a row shows its version transition and signed counts, and opening a
// row is what fetches its detail.
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { I18nProvider } from '@/i18n'
import { apiFetch } from '@/lib/api'
import { CatalogueSyncs } from './catalogue-syncs'

vi.mock('@/lib/api', () => ({ apiFetch: vi.fn() }))

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
  vi.mocked(apiFetch).mockReset()
})

const syncRow = {
  id: 2,
  at: '2026-10-12 13:03:49',
  version: '2026.10.12.daddd7e6',
  previousVersion: '2026.10.10.abc123',
  tier: 'live',
  generatedAt: '2026-10-12T10:09:44.790Z',
  updated: 910,
  inserted: 1,
  removed: 0,
  skippedUnknownPlatform: 0,
  quirks: 89,
  docAdded: 1,
  docRemoved: 2,
  docChanged: 3,
  byPlatform: {},
}

const baselineRow = {
  ...syncRow,
  id: 1,
  version: '2026.10.08.deadbee',
  previousVersion: null,
  docAdded: 0,
  docRemoved: 0,
  docChanged: 0,
}

function renderPage(syncs: unknown[]) {
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  vi.mocked(apiFetch).mockImplementation(async (path: string) => {
    if (String(path).startsWith('/api/models/changes/syncs/detail')) {
      return {
        ...syncRow,
        details: [{ r: 'chat', p: 'groq', m: 'test-model', f: 'rpd', o: 1000, n: 500 }],
      }
    }
    const totals = {
      syncs: syncs.length,
      added: syncs.reduce<number>((n, s) => n + (s as { docAdded: number }).docAdded, 0),
      removed: syncs.reduce<number>((n, s) => n + (s as { docRemoved: number }).docRemoved, 0),
      changed: syncs.reduce<number>((n, s) => n + (s as { docChanged: number }).docChanged, 0),
      lastAt: syncs.length ? '2026-10-12 13:03:49' : null,
      lastVersion: null,
    }
    return { syncs, total: syncs.length, totals }
  })
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  act(() => root!.render(
    <QueryClientProvider client={client}>
      <I18nProvider initialLocale="en">
        <CatalogueSyncs />
      </I18nProvider>
    </QueryClientProvider>,
  ))
  // The query resolves on a timer; let it settle before reading the DOM.
  // `Promise.withResolvers` is ES2024 and this package compiles against
  // ES2023 (tsconfig.app.json), so the executor form is what is available.
  return act(async () => { await new Promise<void>(resolve => { setTimeout(resolve, 0) }) })
}

describe('CatalogueSyncs', () => {
  it('says the log is empty instead of rendering an empty table', async () => {
    await renderPage([])
    expect(host!.textContent).toContain('No catalog update recorded yet')
    expect(host!.querySelector('li')).toBeNull()
  })

  it('shows each applied document with its transition and signed counts', async () => {
    await renderPage([syncRow, baselineRow])
    expect(host!.textContent).toContain('2026.10.10.abc123 → 2026.10.12.daddd7e6')
    expect(host!.textContent).toContain('+1')
    expect(host!.textContent).toContain('−2')
    expect(host!.textContent).toContain('~3')
    // The baseline names itself instead of inventing a previous version.
    expect(host!.textContent).toContain('2026.10.08.deadbee')
    expect(host!.textContent).toContain('log starts here')
  })

  it('sums the whole log into the headline quantities', async () => {
    await renderPage([syncRow, baselineRow])
    const text = host!.textContent ?? ''
    expect(text).toContain('Updates logged')
    expect(text).toMatch(/\+1\s*Models added/)
    expect(text).toMatch(/−2\s*Models removed/)
    expect(text).toMatch(/~3\s*Models changed/)
  })

  it('fetches and shows the field diff only while a row is open', async () => {
    await renderPage([syncRow])
    expect(host!.textContent).not.toContain('rpd')
    const row = host!.querySelector<HTMLButtonElement>('li > button')!
    await act(async () => { row.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) })
    expect(host!.textContent).toContain('rpd')
    expect(host!.textContent).toContain('1000')
    expect(host!.textContent).toContain('500')
  })
})
