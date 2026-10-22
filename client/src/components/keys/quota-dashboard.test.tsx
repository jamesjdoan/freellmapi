// @vitest-environment jsdom
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { I18nProvider } from '@/i18n'
import { apiFetch } from '@/lib/api'
import type { ApiKey } from '../../../../shared/types'
import type { UsageCredentialsResponse } from '@/lib/quota-dashboard'
import { QuotaDashboard } from './quota-dashboard'

// The connect line only exists on cards whose platform takes a second
// credential for account usage, and it must report the last read's outcome —
// including a refusal — instead of a bare "connected".

vi.mock('@/lib/api', () => ({ apiFetch: vi.fn() }))
// Keep the real dialog content; remove only portal/focus management.
vi.mock('@/components/ui/dialog', () => ({
  Dialog: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DialogPopup: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DialogTitle: ({ children }: { children: ReactNode }) => <h2>{children}</h2>,
  DialogClose: ({ children }: { children: ReactNode }) => <button>{children}</button>,
}))

let root: Root
let container: HTMLDivElement
let client: QueryClient
let keys: ApiKey[]
let providers: unknown[]
let usage: UsageCredentialsResponse

const key = (over: Partial<ApiKey> & Pick<ApiKey, 'id' | 'platform'>): ApiKey => ({
  label: '', maskedKey: 'k-…00', baseUrl: null, status: 'healthy', enabled: true,
  keyless: false, exportable: true, createdAt: '2026-10-01 00:00:00',
  lastCheckedAt: null, lastHealthError: null, ...over,
}) as ApiKey

const usageOf = (over: Partial<UsageCredentialsResponse> = {}): UsageCredentialsResponse => ({
  supported: { unorouter: ['userId', 'accessToken'], radeon: ['cookie'], google: ['serviceAccountJson'] },
  credentials: [],
  ...over,
})

beforeAll(() => { Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true }) })
beforeEach(() => {
  keys = [
    key({ id: 7, platform: 'unorouter', label: 'Uno main', maskedKey: 'ur-…a1' }),
    key({ id: 9, platform: 'groq', maskedKey: 'gsk-…z9' }),
  ]
  // One reading each: a provider with nothing reported is no longer a card of
  // its own, it is a chip on the "No allowance reported" line.
  const pool = (platform: string) => ({ platform, pool: `${platform}::daily`, limit: 100, remaining: 60, reset_at: null, metered: true, usedSource: 'provider', metric: 'requests', unit: null })
  providers = [pool('unorouter'), pool('groq')]
  usage = usageOf()
  vi.mocked(apiFetch).mockReset().mockImplementation(async path => {
    if (path === '/api/keys') return keys
    if (path === '/api/quota/providers') return { providers }
    if (path === '/api/quota/usage-credentials') return usage
    throw new Error(`unexpected path ${path}`)
  })
  client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } } })
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})
afterEach(() => { act(() => root.unmount()); client.clear(); container.remove() })

async function mount() {
  act(() => root.render(
    <QueryClientProvider client={client}>
      <I18nProvider initialLocale="en"><QuotaDashboard states={[]} /></I18nProvider>
    </QueryClientProvider>,
  ))
  // The queries resolve on a timer, so wait for the data rather than draining
  // a fixed number of microtasks and hoping. vi.waitFor polls on a timer too,
  // so the state update it waits for lands outside act's scope; wrap the poll.
  await act(async () => {
    await vi.waitFor(() => {
      expect(container.querySelectorAll('article').length).toBe(keys.length)
    })
  })
}

function card(name: string): HTMLElement {
  const found = container.querySelector(`article[aria-label="${name}"]`)
  if (!found) throw new Error(`expected a ${name} card in the rendered dashboard`)
  return found as HTMLElement
}

describe('QuotaDashboard usage credentials', () => {
  it('offers no connect control on a provider without a usage credential', async () => {
    await mount()
    const groq = card('Groq')
    expect(groq.textContent).not.toContain('Connect account usage')
    expect(groq.querySelector('button')).toBeNull()
  })

  it('shows Connect account usage on a supported provider and opens its dialog', async () => {
    await mount()
    const connect = [...card('UnoRouter').querySelectorAll('button')].find(b => b.textContent === 'Connect account usage')
    expect(connect).toBeDefined()
    await act(async () => { connect!.click() })
    expect(container.querySelector('h2')!.textContent).toBe('UnoRouter account usage')
    expect(container.textContent).toContain('User ID')
    expect(container.textContent).toContain('System access token')
  })

  it('shows a failed read on the card in the destructive tone with its message', async () => {
    usage = usageOf({ credentials: [
      { keyId: 7, platform: 'unorouter', setAt: '2026-10-17 06:00:00', lastReadAt: '2026-10-17 06:00:10', lastStatus: 'error', lastMessage: 'access token invalid' },
    ] })
    await mount()
    const uno = card('UnoRouter')
    expect(uno.textContent).toContain('Account usage: connected')
    expect(uno.textContent).toContain('access token invalid')
    expect(uno.querySelector('.text-destructive')).not.toBeNull()
    expect(uno.textContent).not.toContain('Connect account usage')
  })

  it('reports a connected read with its message and age', async () => {
    usage = usageOf({ credentials: [
      { keyId: 7, platform: 'unorouter', setAt: '2026-10-17 06:00:00', lastReadAt: '2026-10-17 06:00:10', lastStatus: 'ok', lastMessage: 'balance $3.20 of $5.00' },
    ] })
    await mount()
    const uno = card('UnoRouter')
    expect(uno.textContent!.replace(/\s+/g, ' ')).toContain('Account usage: connected · read ')
    expect(uno.textContent).toContain('balance $3.20 of $5.00')
    expect(uno.querySelector('.text-destructive')).toBeNull()
  })
})
