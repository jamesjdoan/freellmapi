// @vitest-environment jsdom
//
// The update list answers "what did the catalog change, and on which
// provider". These tests pin what a server test cannot see: the empty log says
// so, each day names its providers busiest first, opening a day lists the
// models per provider, a day whose model names were never recorded says so,
// the default filters (keyed providers, nothing ignored) reach the server, and
// a day's Expand all opens every provider in it.
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { I18nProvider } from '@/i18n'
import { apiFetch } from '@/lib/api'
import { CatalogueSyncs, providersByChurn } from './catalogue-syncs'

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

const update = {
  id: 2,
  day: '2026-10-13',
  ids: [2],
  netted: true,
  at: '2026-10-13 09:40:02',
  version: '2026.10.13.70a95cb9',
  previousVersion: '2026.10.12.daddd7e6',
  tier: 'live',
  generatedAt: null,
  updated: 910, inserted: 3, removed: 1, skippedUnknownPlatform: 0, quirks: 89,
  docAdded: 3,
  docRemoved: 1,
  docChanged: 1,
  docSwitchedOff: 1,
  docSwitchedOn: 0,
  byPlatform: { inferbase: { a: 2, r: 0, c: 0, off: 0, on: 0 }, llm7: { a: 1, r: 1, c: 0, off: 0, on: 0 }, sail: { a: 0, r: 0, c: 1, off: 1, on: 0 } },
}

const earlierDay = { ...update, id: 1, day: '2026-10-10', ids: [1], version: '2026.10.10.aaaa', previousVersion: '2026.10.09.bbbb' }

const detail = {
  ...update,
  details: [
    { r: 'chat', p: 'sail', m: 'sail-pro', f: 'enabled', o: true, n: false },
    { r: 'chat', p: 'sail', m: 'sail-lite', f: 'rpd', o: 1000, n: 500 },
  ],
  members: {
    added: [
      { r: 'chat', p: 'inferbase', m: 'qwen-3-max', n: 'Qwen 3 Max' },
      { r: 'chat', p: 'inferbase', m: 'glm-5', n: null },
      { r: 'chat', p: 'llm7', m: 'llm7-new', n: 'LLM7 New' },
    ],
    removed: [{ r: 'chat', p: 'llm7', m: 'llm7-old', n: 'LLM7 Old' }],
  },
}

async function renderList(syncs: unknown[], detailBody: unknown = detail, hiddenUnkeyed = 0) {
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  vi.mocked(apiFetch).mockImplementation(async (path: string) => {
    if (String(path).startsWith('/api/models/changes/syncs/detail')) return detailBody
    const list = syncs as Array<{ docAdded: number; docRemoved: number; docChanged: number; docSwitchedOff: number; docSwitchedOn: number }>
    return {
      syncs, total: list.length,
      totals: {
        syncs: list.length,
        added: list.reduce<number>((n, s) => n + s.docAdded, 0),
        removed: list.reduce<number>((n, s) => n + s.docRemoved, 0),
        changed: list.reduce<number>((n, s) => n + s.docChanged, 0),
        switchedOff: list.reduce<number>((n, s) => n + s.docSwitchedOff, 0),
        switchedOn: list.reduce<number>((n, s) => n + s.docSwitchedOn, 0),
        hiddenIgnored: 0,
        hiddenUnkeyed,
        lastAt: list.length ? '2026-10-13 09:40:02' : null,
        lastVersion: null,
      },
    }
  })
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  act(() => root!.render(
    <QueryClientProvider client={client}>
      <I18nProvider initialLocale="en"><CatalogueSyncs /></I18nProvider>
    </QueryClientProvider>,
  ))
  await act(async () => {
    await vi.waitFor(() => { if (!host!.textContent) throw new Error('not rendered yet') })
  })
}

const rowButtons = () => [...host!.querySelectorAll<HTMLButtonElement>('li button')].filter(b => b.textContent !== 'Expand all' && b.textContent !== 'Collapse all')

async function openRow(index = 0) {
  await act(async () => { rowButtons()[index].click() })
  await act(async () => {
    await vi.waitFor(() => { if (!host!.querySelector('details')) throw new Error('detail not rendered yet') })
  })
}

const requested = () => vi.mocked(apiFetch).mock.calls.map(([p]) => String(p))

describe('providersByChurn', () => {
  it('orders providers busiest first, ties alphabetically', () => {
    expect(providersByChurn({ b: { a: 1, r: 0, c: 0 }, a: { a: 0, r: 1, c: 0 }, z: { a: 5, r: 0, c: 1 } }).map(([p]) => p))
      .toEqual(['z', 'a', 'b'])
  })
})

describe('CatalogueSyncs', () => {
  it('says the log is empty instead of rendering an empty table, and says when filters hid everything', async () => {
    await renderList([])
    expect(host!.textContent).toContain('No catalog changes recorded yet')
    expect(host!.querySelector('li')).toBeNull()
    act(() => root?.unmount())
    host?.remove()
    await renderList([], detail, 2)
    expect(host!.textContent).toContain('No catalogue changes match these filters')
  })

  it('asks for keyed providers only and nothing ignored by default, in the browser time zone', async () => {
    await renderList([update], detail, 4)
    const list = requested().find(p => p.startsWith('/api/models/changes/syncs?'))!
    expect(list).toContain('keyedOnly=true')
    expect(list).toContain('hideIgnored=true')
    expect(list).toContain(`timeZone=${encodeURIComponent(Intl.DateTimeFormat().resolvedOptions().timeZone)}`)
    expect(host!.textContent).toContain('4 changes from providers without a key hidden')

    const keyed = [...host!.querySelectorAll('label')].find(l => l.textContent?.startsWith('Only providers with a key'))!
    await act(async () => { keyed.querySelector('input')!.click() })
    await act(async () => {
      await vi.waitFor(() => { if (!requested().some(p => p.includes('keyedOnly=false'))) throw new Error('not refetched') })
    })
  })

  it('sums the whole log into the headline quantities', async () => {
    await renderList([update, earlierDay])
    const text = host!.textContent ?? ''
    expect(text).toMatch(/2\s*Days with changes/)
    expect(text).toMatch(/\+6\s*Models added/)
    expect(text).toMatch(/−2\s*Models removed/)
    expect(text).not.toContain('Switched back on')
  })

  it('names each day’s providers with their counts, busiest first', async () => {
    await renderList([update])
    const row = host!.querySelector('li')!.textContent ?? ''
    expect(row).toContain('2026.10.12.daddd7e6 → 2026.10.13.70a95cb9')
    expect(row.indexOf('inferbase')).toBeLessThan(row.indexOf('llm7'))
    expect(row).toMatch(/inferbase\s*\+2/)
    expect(row).toMatch(/llm7\s*\+1\s*−1/)
    expect(row).toMatch(/sail\s*1 off\s*~1/)
    expect(row).not.toContain('updates merged')
  })

  it('says how many updates a day merged, and when it could only sum them', async () => {
    await renderList([{ ...update, ids: [5, 6, 7], netted: false }])
    const row = host!.querySelector('li')!.textContent ?? ''
    expect(row).toContain('3 updates merged')
    expect(row).toContain('counts are summed')
  })

  it('collapses providers past the sixth into a count', async () => {
    const busy = { ...update, byPlatform: Object.fromEntries(Array.from({ length: 8 }, (_, i) => [`p${i}`, { a: 8 - i, r: 0, c: 0 }])) }
    await renderList([busy])
    const row = host!.querySelector('li')!.textContent ?? ''
    expect(row).toContain('p5')
    expect(row).not.toContain('p6')
    expect(row).toContain('+2 more')
  })

  it('lists added, removed and changed models per provider, fetched for every merged update', async () => {
    await renderList([{ ...update, ids: [5, 6] }])
    await openRow()
    expect(requested().find(p => p.startsWith('/api/models/changes/syncs/detail'))).toMatch(/ids=5,6&hideIgnored=true&keyedOnly=true/)
    const groups = [...host!.querySelectorAll('details')]
    expect(groups.map(g => g.querySelector('summary')!.textContent)).toEqual([
      expect.stringContaining('inferbase'), expect.stringContaining('llm7'), expect.stringContaining('sail'),
    ])
    expect(groups.every(g => !g.open)).toBe(true)
    expect(groups[0].textContent).toContain('Qwen 3 Max')
    expect(groups[1].textContent).toMatch(/Added.*llm7-new.*Removed.*llm7-old/)
    expect(groups[2].textContent).toMatch(/Switched off by the feed.*sail-pro.*Changed.*sail-lite.*rpd.*1000.*500/)
  })

  it('opens the group straight away when only one provider moved', async () => {
    const single = { ...update, docRemoved: 0, docChanged: 0, docSwitchedOff: 0, byPlatform: { inferbase: { a: 2, r: 0, c: 0, off: 0, on: 0 } } }
    await renderList([single], { ...detail, ...single, details: [], members: { added: detail.members.added.slice(0, 2), removed: [] } })
    await openRow()
    expect(host!.querySelector('details')!.open).toBe(true)
  })

  it('says the names are unknown for an update recorded before they were kept', async () => {
    await renderList([update], { ...detail, members: null })
    await openRow()
    expect(host!.textContent).toContain('Model names were not recorded for this update')
  })

  it('expands every provider in one day at once, and only that day', async () => {
    await renderList([update, earlierDay])
    const [today, before] = [...host!.querySelectorAll('li')]
    await act(async () => { [...today.querySelectorAll('button')].find(b => b.textContent === 'Expand all')!.click() })
    await act(async () => {
      await vi.waitFor(() => { if (today.querySelectorAll('details').length < 3) throw new Error('details not all rendered') })
    })
    expect([...today.querySelectorAll('details')].every(g => g.open)).toBe(true)
    expect(before.querySelector('details')).toBeNull()

    await act(async () => { [...today.querySelectorAll('button')].find(b => b.textContent === 'Collapse all')!.click() })
    expect(today.querySelector('details')).toBeNull()
  })
})
