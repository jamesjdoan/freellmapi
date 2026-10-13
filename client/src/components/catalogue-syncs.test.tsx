// @vitest-environment jsdom
//
// The update list answers "what did each catalog update change, and on which
// provider". These tests pin what a server test cannot see: the empty log says
// so, each row names its providers busiest first, opening a row lists the
// models per provider, and a row whose model names were never recorded says so
// instead of showing an empty group. Updates group by day, and a day's Expand
// all opens every update and provider in it.
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { I18nProvider } from '@/i18n'
import { apiFetch } from '@/lib/api'
import { CatalogueSyncs, groupByDay, providersByChurn } from './catalogue-syncs'

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
  at: '2026-10-13 09:40:02',
  version: '2026.10.13.70a95cb9',
  previousVersion: '2026.10.12.daddd7e6',
  tier: 'live',
  generatedAt: null,
  updated: 910, inserted: 3, removed: 1, skippedUnknownPlatform: 0, quirks: 89,
  docAdded: 3,
  docRemoved: 1,
  docChanged: 2,
  byPlatform: { inferbase: { a: 2, r: 0, c: 0 }, llm7: { a: 1, r: 1, c: 0 }, sail: { a: 0, r: 0, c: 2 } },
}

const baseline = {
  ...update, id: 1, version: '2026.10.12.daddd7e6', previousVersion: null,
  docAdded: 0, docRemoved: 0, docChanged: 0, byPlatform: {},
}

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

async function renderList(syncs: unknown[], detailBody: unknown = detail) {
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  vi.mocked(apiFetch).mockImplementation(async (path: string) => {
    if (String(path).startsWith('/api/models/changes/syncs/detail')) return detailBody
    const list = syncs as Array<{ docAdded: number; docRemoved: number; docChanged: number }>
    return {
      syncs, total: list.length,
      totals: {
        syncs: list.length,
        added: list.reduce<number>((n, s) => n + s.docAdded, 0),
        removed: list.reduce<number>((n, s) => n + s.docRemoved, 0),
        changed: list.reduce<number>((n, s) => n + s.docChanged, 0),
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

async function openRow(index = 0) {
  const row = host!.querySelectorAll<HTMLButtonElement>('li > button')[index]
  await act(async () => { row.click() })
  await act(async () => {
    await vi.waitFor(() => { if (!host!.querySelector('details')) throw new Error('detail not rendered yet') })
  })
}

describe('providersByChurn', () => {
  it('orders providers busiest first, ties alphabetically', () => {
    expect(providersByChurn({ b: { a: 1, r: 0, c: 0 }, a: { a: 0, r: 1, c: 0 }, z: { a: 5, r: 0, c: 1 } }).map(([p]) => p))
      .toEqual(['z', 'a', 'b'])
  })
})

describe('CatalogueSyncs', () => {
  it('says the log is empty instead of rendering an empty table', async () => {
    await renderList([])
    expect(host!.textContent).toContain('No catalog update recorded yet')
    expect(host!.querySelector('li')).toBeNull()
  })

  it('sums the whole log into the headline quantities', async () => {
    await renderList([update, baseline])
    const text = host!.textContent ?? ''
    expect(text).toMatch(/\+3\s*Models added/)
    expect(text).toMatch(/−1\s*Models removed/)
    expect(text).toMatch(/~2\s*Models changed/)
  })

  it('names each row’s providers with their counts, busiest first', async () => {
    await renderList([update, baseline])
    const row = host!.querySelectorAll('li')[0].textContent ?? ''
    expect(row).toContain('2026.10.12.daddd7e6 → 2026.10.13.70a95cb9')
    expect(row.indexOf('inferbase')).toBeLessThan(row.indexOf('llm7'))
    expect(row).toMatch(/inferbase\s*\+2/)
    expect(row).toMatch(/llm7\s*\+1\s*−1/)
    expect(row).toMatch(/sail\s*~2/)
    expect(host!.querySelectorAll('li')[1].textContent).toContain('log starts here')
  })

  it('collapses providers past the sixth into a count', async () => {
    const busy = { ...update, byPlatform: Object.fromEntries(Array.from({ length: 8 }, (_, i) => [`p${i}`, { a: 8 - i, r: 0, c: 0 }])) }
    await renderList([busy])
    const row = host!.querySelector('li')!.textContent ?? ''
    expect(row).toContain('p5')
    expect(row).not.toContain('p6')
    expect(row).toContain('+2 more')
  })

  it('lists added, removed and changed models per provider, each provider collapsible', async () => {
    await renderList([update])
    await openRow()
    const groups = [...host!.querySelectorAll('details')]
    expect(groups.map(g => g.querySelector('summary')!.textContent)).toEqual([
      expect.stringContaining('inferbase'), expect.stringContaining('llm7'), expect.stringContaining('sail'),
    ])
    expect(groups.every(g => !g.open)).toBe(true)
    expect(groups[0].textContent).toContain('Qwen 3 Max')
    expect(groups[0].textContent).toContain('glm-5')
    expect(groups[1].textContent).toMatch(/Added.*llm7-new.*Removed.*llm7-old/)
    expect(groups[2].textContent).toMatch(/sail-lite.*rpd.*1000.*500/)
  })

  it('opens the group straight away when only one provider moved', async () => {
    const single = { ...update, docRemoved: 0, docChanged: 0, byPlatform: { inferbase: { a: 2, r: 0, c: 0 } } }
    await renderList([single], { ...detail, ...single, details: [], members: { added: detail.members.added.slice(0, 2), removed: [] } })
    await openRow()
    expect(host!.querySelector('details')!.open).toBe(true)
  })

  it('says the names are unknown for an update recorded before they were kept', async () => {
    await renderList([update], { ...detail, members: null })
    await openRow()
    expect(host!.textContent).toContain('Model names were not recorded for this update')
  })

  it('does not expand a row that changed nothing', async () => {
    await renderList([baseline])
    await act(async () => { host!.querySelector<HTMLButtonElement>('li > button')!.click() })
    expect(vi.mocked(apiFetch).mock.calls.some(([p]) => String(p).includes('/detail'))).toBe(false)
  })

  // 06:00 and 06:30 UTC sit on the same local day for any offset between
  // UTC-6 and UTC+17; the third update is three days earlier.
  const morning = { ...update, id: 10, at: '2026-10-13 06:00:00' }
  const later = { ...update, id: 11, at: '2026-10-13 06:30:00', docAdded: 1, docRemoved: 0, docChanged: 0 }
  const quietSameDay = { ...baseline, id: 12, at: '2026-10-13 06:15:00', previousVersion: 'x' }
  const earlier = { ...update, id: 13, at: '2026-10-10 06:00:00' }

  it('groups updates by day, newest first, with each day’s totals', async () => {
    expect(groupByDay([later, quietSameDay, morning, earlier]).map(([, s]) => s.map(x => x.id))).toEqual([[11, 12, 10], [13]])
    await renderList([later, quietSameDay, morning, earlier])
    const days = [...host!.querySelectorAll('section')]
    expect(days).toHaveLength(2)
    expect(days[0].textContent).toMatch(/Updates: 3\s*\+4\s*−1\s*~2/)
    expect(days[1].textContent).toMatch(/Updates: 1\s*\+3\s*−1\s*~2/)
  })

  it('expands every update and provider in a day at once, and only that day', async () => {
    await renderList([later, quietSameDay, morning, earlier])
    const [today, before] = [...host!.querySelectorAll('section')]
    await act(async () => { [...today.querySelectorAll('button')].find(b => b.textContent === 'Expand all')!.click() })
    await act(async () => {
      await vi.waitFor(() => { if (today.querySelectorAll('details').length < 6) throw new Error('details not all rendered') })
    })
    const groups = [...today.querySelectorAll('details')]
    expect(groups).toHaveLength(6)
    expect(groups.every(g => g.open)).toBe(true)
    const fetched = vi.mocked(apiFetch).mock.calls.map(([p]) => String(p)).filter(p => p.includes('/detail'))
    expect(fetched.sort()).toEqual(['/api/models/changes/syncs/detail?id=10', '/api/models/changes/syncs/detail?id=11'])
    expect(before.querySelector('details')).toBeNull()

    await act(async () => { [...today.querySelectorAll('button')].find(b => b.textContent === 'Collapse all')!.click() })
    expect(today.querySelector('details')).toBeNull()
  })

  it('offers no Expand all on a day when nothing moved', async () => {
    await renderList([{ ...baseline, at: '2026-10-12 06:00:00' }])
    expect([...host!.querySelectorAll('button')].some(b => b.textContent === 'Expand all')).toBe(false)
  })
})
