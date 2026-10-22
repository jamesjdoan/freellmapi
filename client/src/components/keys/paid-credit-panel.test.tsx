// @vitest-environment jsdom
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { I18nProvider } from '@/i18n'
import { apiFetch } from '@/lib/api'
import { PaidCreditPanel } from './paid-credit-panel'
import type { PaidCreditOverview, PaidCreditKeyView } from '../../../../shared/paid-credit-types'

vi.mock('@/lib/api', () => ({ apiFetch: vi.fn() }))

let root: Root
let container: HTMLDivElement
let client: QueryClient

const keyView = (over: Partial<PaidCreditKeyView> = {}): PaidCreditKeyView => ({
  keyId: 19, keyLabel: 'OR main', platform: 'openrouter',
  balance: { used: 250, remaining: 950, limit: 1_200, unit: 'cents', observedAt: new Date().toISOString() },
  window: null, selectedModels: 1, ...over,
})
const overview = (over: Partial<PaidCreditOverview> = {}): PaidCreditOverview => ({
  keys: [keyView()], platforms: ['openrouter'], guardActive: true, ...over,
})

function mockApi(data: PaidCreditOverview, extra?: (path: string, opts?: RequestInit) => unknown) {
  vi.mocked(apiFetch).mockImplementation(async (path: string, opts?: RequestInit) => {
    const handled = extra?.(path, opts)
    if (handled !== undefined) return handled
    if (path === '/api/quota/paid-credit') return data
    return {}
  })
}

beforeAll(() => {
  ;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
})

beforeEach(() => {
  vi.mocked(apiFetch).mockReset()
  client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  client.clear()
  container.remove()
})

async function flush() {
  for (let i = 0; i < 6; i++) await act(async () => { await new Promise<void>(resolve => setTimeout(resolve, 0)) })
}

function mount() {
  act(() => root.render(
    <QueryClientProvider client={client}>
      <I18nProvider initialLocale="en"><PaidCreditPanel /></I18nProvider>
    </QueryClientProvider>,
  ))
}

function type(input: HTMLInputElement, value: string) {
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

describe('PaidCreditPanel', () => {
  it('shows the measured balance in dollars and keeps Open disabled until the phrase is typed', async () => {
    const posts: unknown[] = []
    mockApi(overview(), (path, opts) => {
      if (path === '/api/quota/paid-credit/windows' && opts?.method === 'POST') {
        posts.push(JSON.parse(opts.body as string))
        return { key: keyView() }
      }
      return undefined
    })
    mount()
    await flush()
    expect(container.textContent).toContain('$2.50 used, $9.50 left')

    const [amount, hours, phrase] = [...container.querySelectorAll('input')]
    type(amount, '1.25')
    type(hours, '6')
    const open = [...container.querySelectorAll('button')].find(b => b.textContent === 'Open credit window')!
    type(phrase, 'allow paid spend')
    expect(open.disabled).toBe(true)
    type(phrase, 'ALLOW PAID SPEND')
    expect(open.disabled).toBe(false)

    act(() => open.click())
    await flush()
    expect(posts).toEqual([{ platform: 'openrouter', keyId: 19, quantity: 125, durationHours: 6, confirmation: 'ALLOW PAID SPEND' }])
  })

  it('shows an active window as spend against its amount, with no way to open a second', async () => {
    mockApi(overview({ keys: [keyView({ window: {
      id: 3, quantity: 500, spent: 400, remaining: 100, unit: 'cents', status: 'active', awaitingReading: true,
      startsAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    } })] }))
    mount()
    await flush()
    const text = container.textContent ?? ''
    expect(text).toContain('$4.00 spent of $5.00')
    expect(text).toContain('waiting for the balance to measure the last request')
    // $4 of $5 spent: the bar shows what is left, so 20%.
    expect(container.querySelector('[role="meter"]')?.getAttribute('aria-valuenow')).toBe('20')
    expect([...container.querySelectorAll('button')].some(b => b.textContent === 'Open credit window')).toBe(false)
  })

  it('warns that windows are moot while the paid-balance guard is off', async () => {
    mockApi(overview({ guardActive: false }))
    mount()
    await flush()
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('paid-balance guard is off')
  })

  it('selects a paid model from the provider listing', async () => {
    const puts: unknown[] = []
    const listing = { platform: 'openrouter', models: [
      { modelId: 'anthropic/claude-sonnet-5', name: 'Claude Sonnet 5', contextLength: 200_000, promptPerM: 3, completionPerM: 15, supportsTools: true, supportsVision: true, selected: false },
    ] }
    mockApi(overview(), (path, opts) => {
      if (path.startsWith('/api/quota/paid-credit/models?')) return listing
      if (path === '/api/quota/paid-credit/models' && opts?.method === 'PUT') {
        puts.push(JSON.parse(opts.body as string))
        return { ...listing, models: [{ ...listing.models[0], selected: true }] }
      }
      return undefined
    })
    mount()
    await flush()
    act(() => [...container.querySelectorAll('button')].find(b => b.textContent === 'Choose openrouter paid models')!.click())
    await flush()
    expect(container.textContent).toContain('$3.00 in · $15.00 out per 1M')
    const box = container.querySelector<HTMLInputElement>('input[type="checkbox"]')!
    act(() => box.click())
    await flush()
    expect(puts).toEqual([{ platform: 'openrouter', modelId: 'anthropic/claude-sonnet-5', selected: true }])
    expect(container.querySelector<HTMLInputElement>('input[type="checkbox"]')!.checked).toBe(true)
  })
})
