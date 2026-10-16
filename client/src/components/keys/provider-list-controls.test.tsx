// @vitest-environment jsdom
import { afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest'
import { setTimeout as delay } from 'node:timers/promises'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { I18nProvider } from '@/i18n'
import { apiFetch } from '@/lib/api'
import type { ApiKey } from '../../../../shared/types'
import { ProviderList } from './provider-list'

vi.mock('@/lib/api', () => ({ apiFetch: vi.fn() }))

function key(overrides: Partial<ApiKey>): ApiKey {
  return {
    id: 1, platform: 'groq', label: 'Key', maskedKey: 'masked-key', baseUrl: null,
    status: 'healthy', enabled: true, keyless: false, exportable: true,
    createdAt: '2026-10-14 00:00:00', lastCheckedAt: null, lastHealthError: null,
    ...overrides,
  }
}

let root: Root
let container: HTMLDivElement
let client: QueryClient

beforeAll(() => { Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true }) })
beforeEach(() => {
  localStorage.clear()
  client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } })
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})
afterEach(() => {
  act(() => root.unmount())
  client.clear()
  container.remove()
  localStorage.clear()
})

async function flush() {
  for (let i = 0; i < 4; i++) await act(async () => { await delay(0) })
}

async function render(initialSearch?: string) {
  act(() => root.render(
    <QueryClientProvider client={client}>
      <I18nProvider initialLocale="en"><ProviderList onAddKey={() => {}} initialSearch={initialSearch} /></I18nProvider>
    </QueryClientProvider>,
  ))
  await flush()
}

async function mount(keys: ApiKey[]) {
  vi.mocked(apiFetch).mockReset().mockImplementation(async (path: string) => {
    if (path === '/api/keys') return keys
    if (path === '/api/health') return { platforms: [], keys: [], quotaStates: [] }
    if (path === '/api/fallback') return []
    if (path === '/api/settings/proxy') return { proxyUrl: '', enabled: false, bypassPlatforms: [], active: false }
    if (path === '/api/keys/providers') return []
    return {}
  })
  await render()
}

function providerNames() {
  return [...container.querySelectorAll('[class~="group/krow"] h3')].map(node => node.textContent)
}

async function click(label: string) {
  const button = [...container.querySelectorAll('button')].find(node => node.textContent?.trim() === label)
  if (!button) throw new Error(`Missing control: ${label}`)
  act(() => button.click())
  await flush()
  return button
}

it('alphabetizes provider labels across native and separately named custom endpoints', async () => {
  await mount([
    key({ id: 1, platform: 'custom', label: 'Zeta endpoint', baseUrl: 'https://z.example/v1' }),
    key({ id: 2, platform: 'groq' }),
    key({ id: 3, platform: 'custom', label: 'alpha endpoint', baseUrl: 'https://a.example/v1' }),
  ])
  expect(providerNames()).toEqual(['alpha endpoint', 'Groq', 'Zeta endpoint'])
})

it('hides only wholly disabled providers and restores them without changing key enablement', async () => {
  const keys = [
    key({ id: 1, platform: 'groq', enabled: true, status: 'invalid' }),
    key({ id: 2, platform: 'groq', enabled: false }),
    key({ id: 3, platform: 'google', enabled: false }),
    key({ id: 4, platform: 'custom', label: 'Disabled endpoint', enabled: false, baseUrl: 'https://off.example/v1' }),
  ]
  await mount(keys)
  const originalNames = providerNames()
  expect(originalNames).toEqual(['Disabled endpoint', 'Google AI Studio', 'Groq'])
  await click('Hide Disabled Providers')
  expect(providerNames()).toEqual(['Groq'])
  await click('Show Disabled Providers')
  expect(providerNames()).toEqual(originalNames)
  expect(keys.map(row => row.enabled)).toEqual([true, false, false, false])
  expect(vi.mocked(apiFetch).mock.calls.some(([, options]) => options?.method && options.method !== 'GET')).toBe(false)
})

it('lets the explicit Disabled view reveal off providers after hiding them', async () => {
  await mount([key({ platform: 'groq' }), key({ id: 2, platform: 'google', enabled: false })])
  await click('Hide Disabled Providers')
  expect(providerNames()).toEqual(['Groq'])
  await click('Disabled')
  expect(providerNames()).toEqual(['Google AI Studio'])
  const hide = [...container.querySelectorAll('button')].find(node => node.textContent?.trim() === 'Hide Disabled Providers')
  expect(hide?.getAttribute('aria-pressed')).toBe('false')
})

it('keeps an enabled provider when search matches only its disabled sibling key', async () => {
  await mount([
    key({ id: 1, label: 'Active sibling' }),
    key({ id: 2, label: 'Matching off sibling', enabled: false }),
    key({ id: 3, platform: 'google', label: 'Matching off sibling', enabled: false }),
  ])
  await click('Hide Disabled Providers')
  await render('Matching off sibling')
  expect(providerNames()).toEqual(['Groq'])
})

it('remembers the visibility choice when the provider list is remounted', async () => {
  await mount([key({ platform: 'groq' }), key({ id: 2, platform: 'google', enabled: false })])
  await click('Hide Disabled Providers')
  act(() => root.unmount())
  root = createRoot(container)
  await render()
  expect(providerNames()).toEqual(['Groq'])
  await click('Show Disabled Providers')
  expect(providerNames()).toEqual(['Google AI Studio', 'Groq'])
})
