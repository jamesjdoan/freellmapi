// @vitest-environment jsdom
//
// The discovery panel is where agent-recorded leads become visible, so the
// tests pin what an operator relies on: leads are grouped by provider and the
// groups fold away once there are several, agent rows are marked, a new lead
// is posted with the fields typed, remove targets the row it sits on, and the
// agent token is shown exactly once and can be revoked.
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { I18nProvider } from '@/i18n'
import { apiFetch } from '@/lib/api'
import { ExternalDiscovery, groupByProvider, type ExternalLead } from './external-discovery'

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

const lead = (over: Partial<ExternalLead>): ExternalLead => ({
  id: 1, at: '2026-10-14 03:34:00', source: 'https://opencode.ai/docs/zen', provider: 'opencode',
  modelId: 'big-pickle', displayName: 'Big Pickle', kind: 'chat', status: 'rejected',
  notes: null, addedBy: 'agent', ...over,
})

const leads: ExternalLead[] = [
  lead({ id: 1 }),
  lead({ id: 2, modelId: 'cat-jam-free', displayName: null }),
  lead({ id: 3, source: 'https://vercel.com/ai-gateway', provider: 'vercel', modelId: 'stealth/glyph-cluster', status: 'candidate', addedBy: 'user' }),
  lead({ id: 4, source: 'a forum post', provider: null, modelId: 'mystery-model', status: 'candidate', addedBy: 'user' }),
]

async function renderPanel(token: { active: boolean; createdAt: string | null } = { active: false, createdAt: null }, rows = leads) {
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  vi.mocked(apiFetch).mockImplementation(async (path: string, init?: RequestInit) => {
    if (path === '/api/discovery/agent-token') {
      if (init?.method === 'POST') return { token: 'fld_' + 'a'.repeat(64), createdAt: '2026-10-14T04:00:00.000Z' }
      if (init?.method === 'DELETE') return { active: false, createdAt: null }
      return token
    }
    if (!init?.method) {
      return { leads: rows, total: rows.length, byStatus: { candidate: 2, testing: 0, verified: 0, rejected: 2, added: 0 } }
    }
    return {}
  })
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  act(() => root!.render(
    <QueryClientProvider client={client}>
      <I18nProvider initialLocale="en"><ExternalDiscovery /></I18nProvider>
    </QueryClientProvider>,
  ))
  await act(async () => {
    await vi.waitFor(() => { if (!host!.querySelector('details') || !host!.textContent?.includes('Agent access')) throw new Error('not rendered yet') })
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

const button = (text: string) => [...host!.querySelectorAll('button')].find(b => b.textContent?.trim() === text)
const calls = (method: string) => vi.mocked(apiFetch).mock.calls.filter(([, init]) => init?.method === method)

describe('groupByProvider', () => {
  it('puts the largest provider first and leads without one last', () => {
    expect(groupByProvider(leads).map(([p, list]) => [p, list.length])).toEqual([['opencode', 2], ['vercel', 1], [null, 1]])
  })
})

describe('ExternalDiscovery', () => {
  it('groups leads by provider and folds the groups when there are several', async () => {
    await renderPanel()
    const groups = [...host!.querySelectorAll('details')].filter(d => d.querySelector('ul'))
    expect(groups.map(g => g.querySelector('summary')!.textContent)).toEqual([
      expect.stringMatching(/^opencode\s*2.*Rejected 2/),
      expect.stringMatching(/^vercel\s*1.*Candidate 1/),
      expect.stringMatching(/^No provider\s*1/),
    ])
    expect(groups.every(g => !g.open)).toBe(true)
  })

  it('opens the only group when every lead shares a provider', async () => {
    await renderPanel(undefined, leads.slice(0, 2))
    expect(host!.querySelector('details')!.open).toBe(true)
  })

  it('marks the leads an agent recorded', async () => {
    await renderPanel()
    const rows = [...host!.querySelectorAll('li')]
    expect(rows.find(r => r.textContent?.includes('big-pickle'))!.textContent).toContain('Agent')
    expect(rows.find(r => r.textContent?.includes('glyph-cluster'))!.textContent).not.toContain('Agent')
  })

  it('posts a new lead with exactly the fields typed, provider included', async () => {
    await renderPanel()
    type('Model ID', 'space-bunny-free')
    type('Source', 'https://opencode.ai/docs/zen')
    type('Provider', 'opencode')
    await act(async () => { host!.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })) })
    const [path, init] = calls('POST').find(([p]) => p === '/api/discovery/leads')!
    expect(path).toBe('/api/discovery/leads')
    expect(JSON.parse(String(init?.body))).toEqual({
      source: 'https://opencode.ai/docs/zen', modelId: 'space-bunny-free', provider: 'opencode', displayName: null, notes: null,
    })
  })

  it('does not post without both a model id and a source', async () => {
    await renderPanel()
    type('Model ID', 'cat-jam-free')
    await act(async () => { host!.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })) })
    expect(calls('POST').some(([p]) => p === '/api/discovery/leads')).toBe(false)
  })

  it('removes the row the button sits on', async () => {
    await renderPanel()
    await act(async () => { host!.querySelector<HTMLButtonElement>('button[aria-label="Remove glyph-cluster"], button[aria-label="Remove stealth/glyph-cluster"]')!.click() })
    expect(calls('DELETE').map(([p]) => p)).toEqual(['/api/discovery/leads/3'])
  })

  it('shows a new agent token once, with the warning, after creating it', async () => {
    await renderPanel()
    expect(host!.textContent).toContain('No agent token')
    await act(async () => { button('Create agent token')!.click() })
    await act(async () => {
      await vi.waitFor(() => { if (!host!.querySelector('input[readonly]')) throw new Error('token not shown yet') })
    })
    expect(calls('POST').map(([p]) => p)).toEqual(['/api/discovery/agent-token'])
    expect(host!.querySelector<HTMLInputElement>('input[readonly]')!.value).toBe('fld_' + 'a'.repeat(64))
    expect(host!.textContent).toContain('It is not shown again')
  })

  it('revokes an active token only after the confirm click', async () => {
    await renderPanel({ active: true, createdAt: '2026-10-14T04:00:00.000Z' })
    expect(host!.textContent).toContain('Agent token active since')
    await act(async () => { button('Revoke')!.click() })
    expect(calls('DELETE')).toHaveLength(0)
    await act(async () => { button('Confirm')!.click() })
    expect(calls('DELETE').map(([p]) => p)).toEqual(['/api/discovery/agent-token'])
  })
})
