// @vitest-environment jsdom
/**
 * Route history (ARCH-20261026). The dialog exists so drift is visible: the
 * daily table lines real traffic up against probes and the screen means, the
 * probe list shows what was actually sent, and "Probe now" spends one of the
 * route's probes and reports the outcome — including a refusal, which is the
 * server saying why it did NOT call.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { I18nProvider } from '@/i18n'
import { apiFetch } from '@/lib/api'
import { RouteHistoryDialog } from './route-history-dialog'
import type { RouteHistoryResponse } from '@/lib/chain-arrange'

vi.mock('@/lib/api', () => ({ apiFetch: vi.fn() }))

let root: Root
let container: HTMLDivElement
let client: QueryClient

beforeAll(() => {
  ;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
})
beforeEach(() => {
  client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } } })
  container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container)
})
afterEach(() => { act(() => root.unmount()); client.clear(); container.remove() })

async function flush() { for (let i = 0; i < 4; i++) await act(async () => { await new Promise(r => setTimeout(r, 0)) }) }

const ROUTE = { platform: 'custom', modelId: 'step-5-preview', endpointScope: 'https://relay.example.com/v1' }
const history: RouteHistoryResponse = {
  route: ROUTE,
  evidence: {
    ...ROUTE,
    real: { n: 12, ok: 4, avgOkLatencyMs: 8200 },
    probe: { n: 6, ok: 1, avgOkLatencyMs: 31000, lastAtMs: Date.now() - 3_600_000 },
    screen: {
      agentic: { mean: 21.4, graded: 6 },
      coding: { mean: null, graded: 0 },
      nativeToolsUnsupported: false,
    },
  },
  probes: [
    { id: 2, keyId: null, scenarioId: 'A2', benchVersion: '1.0.0', source: 'probe', streamed: true,
      outcome: 'empty', status: 'FAIL', score: null, mode: 'agentic', latencyMs: 41_000, ttfbMs: null,
      promptTokens: 120, completionTokens: 0, error: 'empty completion', probedAtMs: Date.now() - 3_600_000 },
    { id: 1, keyId: null, scenarioId: 'C1', benchVersion: '1.0.0', source: 'import', streamed: false,
      outcome: 'ok', status: 'PASS', score: 74.5, mode: 'coding', latencyMs: 9_200, ttfbMs: 300,
      promptTokens: 500, completionTokens: 900, error: null, probedAtMs: Date.now() - 86_400_000 },
  ],
  daily: [
    { day: '2026-10-24', realN: 8, realOk: 3, probeN: 1, probeOk: 0, agenticMean: null, codingMean: 74.5 },
    { day: '2026-10-25', realN: 4, realOk: 1, probeN: 2, probeOk: 1, agenticMean: 21.4, codingMean: null },
  ],
}

async function mount(outcome?: unknown) {
  vi.mocked(apiFetch).mockReset().mockImplementation(async (path: string) => {
    if (typeof path === 'string' && path.startsWith('/api/chain-arrange/route-history')) return history
    if (typeof path === 'string' && path === '/api/chain-arrange/probe') {
      if (outcome instanceof Error) throw outcome
      return outcome
    }
    return {}
  })
  act(() => {
    root.render(
      <QueryClientProvider client={client}>
        <I18nProvider initialLocale="en">
          <RouteHistoryDialog route={ROUTE} displayName="Step 5 Preview" open onClose={() => {}} />
        </I18nProvider>
      </QueryClientProvider>,
    )
  })
  await flush()
}

describe('RouteHistoryDialog', () => {
  it('summarises the evidence the arranger ranks on', async () => {
    await mount()
    const text = document.body.textContent ?? ''
    // Real 4/12, probes 1/6, agentic screen 21.4, coding screen unmeasured.
    expect(text).toContain('Real traffic')
    expect(text).toContain('4/12')
    expect(text).toContain('1/6')
    expect(text).toContain('21.4')
    expect(text).toContain('6 graded scenarios')
  })

  it('renders the daily table so drift is visible', async () => {
    await mount()
    const text = document.body.textContent ?? ''
    expect(text).toContain('2026-10-24')
    expect(text).toContain('2026-10-25')
    expect(text).toContain('3/8')
    expect(text).toContain('1/4')
    expect(text).toContain('0/1')
    expect(text).toContain('1/2')
    expect(text).toContain('74.5')
    // The unmeasured cells read as a dash, not a zero.
    expect(text).toContain('–')
  })

  it('lists the probes with scenario, source, streamed, outcome and error', async () => {
    await mount()
    const text = document.body.textContent ?? ''
    expect(text).toContain('Probes (2)')
    expect(text).toContain('A2')
    expect(text).toContain('C1')
    expect(text).toContain('import')
    expect(text).toContain('FAIL')
    expect(text).toContain('PASS')
    expect(text).toContain('empty completion')
    expect(text).toContain('41000')
  })

  it('sends the route triple to Probe now and reports a pass', async () => {
    await mount({ ok: true, scenarioId: 'A1', outcome: 'ok', status: 'PASS', score: 88.2, latencyMs: 5400 })
    const button = [...document.body.querySelectorAll('button')].find(b => b.textContent?.includes('Probe now')) as HTMLButtonElement
    await act(async () => { button.click() })
    await flush()
    const call = vi.mocked(apiFetch).mock.calls.find(c => c[0] === '/api/chain-arrange/probe')!
    expect(JSON.parse((call[1] as RequestInit).body as string)).toEqual(ROUTE)
    const text = document.body.textContent ?? ''
    expect(text).toContain('Probe passed')
    expect(text).toContain('A1')
    expect(text).toContain('88.2')
  })

  it('shows why the server refused to probe', async () => {
    await mount({ ok: false, refused: 'the route-bench-probe extension is off' })
    const button = [...document.body.querySelectorAll('button')].find(b => b.textContent?.includes('Probe now')) as HTMLButtonElement
    await act(async () => { button.click() })
    await flush()
    const text = document.body.textContent ?? ''
    expect(text).toContain('No probe sent: the route-bench-probe extension is off')
  })

  it('surfaces a probe error instead of swallowing it', async () => {
    await mount(new Error('probe request failed'))
    const button = [...document.body.querySelectorAll('button')].find(b => b.textContent?.includes('Probe now')) as HTMLButtonElement
    await act(async () => { button.click() })
    await flush()
    expect(document.body.textContent).toContain('probe request failed')
  })
})
