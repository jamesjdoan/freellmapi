// @vitest-environment jsdom
/**
 * The scope dialog's empty state, and why it had three causes to tell apart.
 *
 * Found on b.ai: its promotion ended, both of its models were switched off in
 * the catalogue, and the dialog opened blank saying "No model matches this
 * search" — when nothing had been searched.
 *
 * The cause is not the hide-disabled filter, which was the first theory and was
 * wrong: that filter hides models absent from the KEY's scope, and b.ai's key is
 * unscoped, so it hides nothing. The real cause is the candidate source.
 * `/api/fallback` selects `WHERE m.enabled = 1`, so a provider whose catalogue
 * rows are all switched off sends ZERO candidates and the dialog cannot tell
 * "this provider has no models" from "they are all switched off".
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { I18nProvider } from '@/i18n'
import { apiFetch } from '@/lib/api'
import type { ApiKey } from '../../../../shared/types'
import { ModelScopeDialog } from './model-scope-dialog'

vi.mock('@/lib/api', () => ({ apiFetch: vi.fn() }))
vi.mock('@/components/ui/dialog', () => ({
  Dialog: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DialogPopup: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DialogTitle: ({ children }: { children: ReactNode }) => <h2>{children}</h2>,
  DialogClose: ({ children }: { children: ReactNode }) => <button>{children}</button>,
}))

let root: Root
let container: HTMLDivElement
const key = { id: 27, platform: 'bai', label: 'B.AI', maskedKey: 'sk-b...lj5l', modelScope: null } as ApiKey

beforeAll(() => {
  ;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
})
beforeEach(() => {
  localStorage.clear()
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})
afterEach(() => { act(() => root.unmount()); container.remove() })

/** `fallback` is the candidate source; `catalogue` is every row including the
 *  switched-off ones, which is the distinction under test. */
async function mount(fallback: unknown[], catalogue: unknown[]) {
  vi.mocked(apiFetch).mockReset().mockImplementation((path: string) => {
    if (path.startsWith('/api/fallback')) return Promise.resolve(fallback)
    if (path === '/api/models') return Promise.resolve(catalogue)
    if (path.includes('probe')) return Promise.resolve({ probes: [] })
    if (path.includes('quota')) return Promise.resolve({ providers: [], models: [] })
    return Promise.resolve([])
  })
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  await act(async () => {
    root.render(
      <QueryClientProvider client={client}>
        <I18nProvider initialLocale="en">
          <ModelScopeDialog apiKey={key} onOpenChange={() => {}} />
        </I18nProvider>
      </QueryClientProvider>,
    )
  })
  await act(async () => { await new Promise(r => setTimeout(r, 0)) })
}

describe('the scope dialog when it has no candidates', () => {
  it('says the catalogue rows are switched off, and how many — the b.ai case', async () => {
    await mount([], [{ platform: 'bai', modelId: 'hy3' }, { platform: 'bai', modelId: 'mimo-v2.5' }])
    const text = container.textContent ?? ''
    expect(text).toContain('2 models in the catalogue')
    expect(text).toContain('switched off')
    // The message that sent me looking for a search box that was empty.
    expect(text).not.toContain('No model matches this search')
  })

  it('does not claim rows are switched off when the provider has none', async () => {
    // Nothing to explain here: no candidates and no catalogue rows is simply a
    // provider with no models, and the plain "no scope set" line is the honest
    // answer. Asserting the absence, because the failure mode being prevented
    // is a message that invents a cause.
    await mount([], [{ platform: 'groq', modelId: 'other' }])
    const text = container.textContent ?? ''
    expect(text).toContain('No scope set')
    expect(text).not.toContain('switched off')
    expect(text).not.toContain('models in the catalogue')
  })
})
