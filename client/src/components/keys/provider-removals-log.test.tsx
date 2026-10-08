// @vitest-environment jsdom
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { MemoryRouter } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { I18nProvider } from '@/i18n'
import { apiFetch } from '@/lib/api'
import { ProviderRemovalsLog } from './provider-removals'
import type { ProviderRemoval } from '@/lib/provider-removals'

// The removals log is a record of retired providers, not part of the working
// list. Two things must hold or it pushes the keys the operator came for down
// the page: it renders once (it used to render twice — expanded above the list
// AND again at the bottom), and it starts collapsed.

vi.mock('@/lib/api', () => ({ apiFetch: vi.fn() }))

let root: Root
let container: HTMLDivElement
let client: QueryClient
let removals: ProviderRemoval[]

const removal = (overrides: Partial<ProviderRemoval> = {}): ProviderRemoval => ({
  platform: 'sail',
  reason: 'cancelled the paid plan',
  note: null,
  removedAt: '2026-09-30 14:05:00',
  removedBy: 'provider',
  modelsRemoved: 4,
  keyIds: [1],
  restoredAt: null,
  restoredBy: null,
  ...overrides,
})

beforeAll(() => { Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true }) })
beforeEach(() => {
  removals = [removal(), removal({ platform: 'aclide', reason: 'credits are not spendable cash', removedBy: 'key' })]
  vi.mocked(apiFetch).mockReset().mockImplementation(async path => {
    if (path === '/api/keys/provider-removals') return { removals }
    throw new Error(`unexpected path ${path}`)
  })
  client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } })
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})
afterEach(() => { act(() => root.unmount()); client.clear(); container.remove() })

async function mount() {
  act(() => root.render(
    <MemoryRouter>
      <QueryClientProvider client={client}>
        <I18nProvider initialLocale="en"><ProviderRemovalsLog /></I18nProvider>
      </QueryClientProvider>
    </MemoryRouter>,
  ))
  // The removals query resolves on a timer, so wait for the data rather than
  // draining a fixed number of microtasks and hoping. vi.waitFor polls on a
  // timer too, so the state update it waits for lands outside act's scope;
  // wrap the poll itself.
  await act(async () => {
    await vi.waitFor(() => {
      if (removals.length === 0) return
      expect(container.querySelector('details')).not.toBeNull()
    })
  })
}

function el<T extends Element>(selector: string): T {
  const found = container.querySelector(selector)
  if (!found) throw new Error(`expected ${selector} in the rendered removals log`)
  return found as T
}

describe('ProviderRemovalsLog', () => {
  it('starts collapsed, so the section is a summary until asked for', async () => {
    await mount()
    const details = el<HTMLDetailsElement>('details')
    expect(details.open).toBe(false)
    // The count still reads on the collapsed header — that is why it stays
    // rendered rather than being hidden outright.
    expect(el<HTMLElement>('summary').textContent).toContain('Removed providers (2)')
  })

  it('opens on a click and shows the reason and restore action per provider', async () => {
    await mount()
    const details = el<HTMLDetailsElement>('details')
    await act(async () => { el<HTMLElement>('summary').click() })
    expect(details.open).toBe(true)
    expect(container.textContent).toContain('cancelled the paid plan')
    expect(container.textContent).toContain('last key removed')
    expect(container.textContent).toContain('credits are not spendable cash')
  })

  it('renders nothing when no provider has been removed', async () => {
    removals = []
    await mount()
    expect(container.querySelector('details')).toBeNull()
    expect(container.textContent).toBe('')
  })
})