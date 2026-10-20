// @vitest-environment jsdom
/**
 * The Keys → provider model table, and the token-efficiency column in it
 * (ADR ARCH-20261020).
 *
 * The panel is the second place the model's analysis numbers show, so the
 * column has to be there and has to say the same thing as on Compare: an AA
 * rank with the token count in the tooltip, a screen measurement marked as
 * such, and a dash where nothing measures it.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { I18nProvider } from '@/i18n'
import { apiFetch } from '@/lib/api'
import type { TokenEfficiency } from '@freellmapi/shared/types'
import { ProviderModelsPanel } from './provider-models-panel'

vi.mock('@/lib/api', () => ({ apiFetch: vi.fn() }))

let root: Root
let container: HTMLDivElement
let client: QueryClient

const aa: TokenEfficiency = {
  source: 'aa', tokensLow: 271_316, tokensHigh: 833_897, tokensPerTask: 547_874,
  benchVersion: null, scenariosCompleted: null, runAt: null, proxied: false,
}
const screen: TokenEfficiency = {
  source: 'screen', tokensLow: null, tokensHigh: null, tokensPerTask: 1_400,
  benchVersion: '1.0.0', scenariosCompleted: 6, runAt: '2026-10-20T00:00:00.000Z', proxied: false,
}

const row = (over: Record<string, unknown>) => ({
  modelDbId: 1,
  platform: 'groq',
  modelId: 'openai/gpt-oss-20b',
  displayName: 'GPT-OSS 20B',
  enabled: true,
  contextWindow: 131072,
  supportsTools: true,
  supportsVision: false,
  keyScope: 'unscoped',
  offReason: null,
  pause: null,
  chains: [],
  chainRanks: [],
  analysis: null,
  link: null,
  scores: {
    intelligence: { value: 20, provenance: 'measured', entry: null, editable: false },
    coding: { value: 18, provenance: 'measured', entry: null, editable: false },
    agentic: { value: 12, provenance: 'measured', entry: null, editable: false },
  },
  tokenEfficiency: null,
  ...over,
})

beforeAll(() => { Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true }) })
beforeEach(() => {
  vi.mocked(apiFetch).mockReset().mockImplementation(async path => {
    if (path === '/api/analysis/compare') return { rows: [], catalogue: [] }
    if (path === '/api/analysis/proxy-upgrades') return { upgrades: [] }
    if (path === '/api/keys/model-health') return { rows: [] }
    if (path === '/api/fallback/rate-limit-usage') return { rows: [] }
    if (path === '/api/fallback') return []
    if (path === '/api/profiles') return []
    if (path === '/api/quota/probes') return { probes: [] }
    if (path === '/api/extensions') return { extensions: [] }
    return []
  })
  client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } } })
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})
afterEach(() => { act(() => root.unmount()); client.clear(); container.remove() })

async function mount(rows: unknown[]) {
  vi.mocked(apiFetch).mockImplementation(async path => {
    if (path === '/api/analysis/compare') return { rows, catalogue: [] }
    if (path === '/api/analysis/proxy-upgrades') return { upgrades: [] }
    if (path === '/api/keys/model-health') return { rows: [] }
    if (path === '/api/fallback/rate-limit-usage') return { rows: [] }
    if (path === '/api/fallback') return []
    if (path === '/api/profiles') return []
    if (path === '/api/quota/probes') return { probes: [] }
    if (path === '/api/extensions') return { extensions: [] }
    return []
  })
  act(() => {
    root.render(
      <QueryClientProvider client={client}>
        <I18nProvider initialLocale="en">
          <ProviderModelsPanel platform="groq" />
        </I18nProvider>
      </QueryClientProvider>,
    )
  })
  // Several queries resolve in sequence (extensions gate the table), so one
  // tick renders the loading state, not the rows.
  // Executor form: the client's TS lib predates Promise.withResolvers (es2024).
  for (let i = 0; i < 5; i++) await act(async () => { await new Promise(r => setTimeout(r, 10)) })
}

describe('the token-efficiency column in the provider model table', () => {
  it('prints an AA estimate as a token range, with the 3:1 estimate in the tooltip', async () => {
    await mount([row({ modelDbId: 1, displayName: 'Ranged', tokenEfficiency: aa })])
    const cell = container.querySelector('td[title*="tokens"]') ?? container.querySelectorAll('td')[5]
    expect(cell?.textContent ?? '').toContain('271.3K–833.9K')
    expect(cell?.querySelector('[title]')?.getAttribute('title') ?? '').toContain('547.9K')
  })

  it('prints a screen measurement as a token count, marked as a screen', async () => {
    await mount([row({ modelDbId: 1, displayName: 'Screened', tokenEfficiency: screen })])
    const cell = container.querySelector('td[title*="tokens"]') ?? container.querySelectorAll('td')[5]
    const text = cell?.textContent ?? ''
    expect(text).toContain('1.4K')
    expect(text).toContain('screen')
  })

  it('prints a dash where nothing measures it', async () => {
    await mount([row({ modelDbId: 1, displayName: 'Unknown', tokenEfficiency: null })])
    const cell = container.querySelector('td[title*="tokens"]') ?? container.querySelectorAll('td')[5]
    expect(cell?.textContent).toContain('—')
  })

  it('has a column header for it', async () => {
    await mount([row({ modelDbId: 1 })])
    const headers = [...container.querySelectorAll('th')].map(th => th.textContent ?? '')
    expect(headers.some(h => h.includes('Tokens/task'))).toBe(true)
  })
})
