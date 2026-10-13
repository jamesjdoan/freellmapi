// @vitest-environment jsdom
//
// The discovery panel is where agent-recorded leads become visible, so the
// tests pin what an operator relies on: agent rows are marked, the status
// chips count the whole list, a new lead is posted with the fields typed, and
// remove targets the row it sits on.
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { I18nProvider } from '@/i18n'
import { apiFetch } from '@/lib/api'
import { ExternalDiscovery } from './external-discovery'

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

const leads = [
  {
    id: 1, at: '2026-10-12 09:00:00', source: 'https://opencode.ai/docs/zen', modelId: 'big-pickle',
    displayName: 'Big Pickle', kind: 'chat', status: 'candidate', notes: 'Free while in stealth', addedBy: 'agent',
  },
  {
    id: 2, at: '2026-10-11 09:00:00', source: 'OpenRouter stealth page', modelId: 'space-bunny-alpha',
    displayName: null, kind: 'chat', status: 'rejected', notes: null, addedBy: 'user',
  },
]

async function renderPanel() {
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  vi.mocked(apiFetch).mockImplementation(async (_path: string, init?: RequestInit) => {
    if (!init?.method) {
      return { leads, total: 2, byStatus: { candidate: 1, testing: 0, verified: 0, rejected: 1, added: 0 } }
    }
    return {}
  })
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  act(() => root!.render(
    <QueryClientProvider client={client}>
      <I18nProvider initialLocale="en"><ExternalDiscovery /></I18nProvider>
    </QueryClientProvider>,
  ))
  // Poll for the rows rather than counting ticks: the first render in a cold
  // module takes more microtask hops than later ones.
  await act(async () => {
    await vi.waitFor(() => { if (!host!.querySelector('li')) throw new Error('leads not rendered yet') })
  })
}

function type(label: string, value: string) {
  const input = host!.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`)!
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
  act(() => {
    setter.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

describe('ExternalDiscovery', () => {
  it('lists leads with their source and marks the ones an agent recorded', async () => {
    await renderPanel()
    const text = host!.textContent ?? ''
    expect(text).toContain('Big Pickle')
    expect(text).toContain('space-bunny-alpha')
    expect(text).toContain('opencode.ai/docs/zen')
    const rows = host!.querySelectorAll('li')
    expect(rows[0].textContent).toContain('Agent')
    expect(rows[1].textContent).not.toContain('Agent')
  })

  it('counts only the statuses present, against the whole list', async () => {
    await renderPanel()
    const chips = [...host!.querySelectorAll('button')].map(b => b.textContent)
    expect(chips).toContain('All 2')
    expect(chips).toContain('Candidate 1')
    expect(chips).toContain('Rejected 1')
    expect(chips.some(c => c?.startsWith('Verified'))).toBe(false)
  })

  it('posts a new lead with exactly the fields typed', async () => {
    await renderPanel()
    type('Model ID', 'cat-jam-free')
    type('Source', 'https://opencode.ai/docs/zen')
    await act(async () => { host!.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })) })
    const post = vi.mocked(apiFetch).mock.calls.find(([, init]) => init?.method === 'POST')
    expect(post?.[0]).toBe('/api/models/discovery/leads')
    expect(JSON.parse(String(post?.[1]?.body))).toEqual({
      source: 'https://opencode.ai/docs/zen', modelId: 'cat-jam-free', displayName: null, notes: null,
    })
  })

  it('does not post without both a model id and a source', async () => {
    await renderPanel()
    type('Model ID', 'cat-jam-free')
    await act(async () => { host!.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })) })
    expect(vi.mocked(apiFetch).mock.calls.some(([, init]) => init?.method === 'POST')).toBe(false)
  })

  it('removes the row the button sits on', async () => {
    await renderPanel()
    const remove = host!.querySelector<HTMLButtonElement>('button[aria-label="Remove space-bunny-alpha"]')!
    await act(async () => { remove.click() })
    const del = vi.mocked(apiFetch).mock.calls.find(([, init]) => init?.method === 'DELETE')
    expect(del?.[0]).toBe('/api/models/discovery/leads/2')
  })
})
