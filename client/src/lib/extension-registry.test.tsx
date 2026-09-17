// @vitest-environment jsdom
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter } from 'react-router-dom'
import { I18nProvider } from '@/i18n'
import { apiFetch } from '@/lib/api'
import {
  IMPERIUM_EXTENSIONS,
  PAID_BALANCE_GUARD_ID,
  PAID_SPEND_CONFIRMATION,
} from '@freellmapi/shared/extension-registry'
import { ExtensionFeatureList } from '../components/extensions-dialog'

vi.mock('@/lib/api', () => ({ apiFetch: vi.fn() }))

let root: Root
let container: HTMLDivElement

beforeAll(() => {
  ;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
})
beforeEach(() => {
  vi.mocked(apiFetch).mockReset().mockResolvedValue({
    revision: 3,
    paidSpendAcknowledgement: null,
    extensions: IMPERIUM_EXTENSIONS.map(feature => ({ ...feature, enabled: true })),
  })
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})
afterEach(() => { act(() => root.unmount()); container.remove() })

async function mount() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  await act(async () => {
    root.render(
      <QueryClientProvider client={client}>
        <I18nProvider initialLocale="en">
          <MemoryRouter><ExtensionFeatureList /></MemoryRouter>
        </I18nProvider>
      </QueryClientProvider>,
    )
  })
  // The list renders a pending state first; let the query settle before asserting.
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) })
}

describe('the extension registry', () => {
  // Deliberately NOT pinning the id list: it grew from 19 to 33 and would fail
  // on every addition without telling anyone anything. What matters is that
  // each entry is addressable and documents its own off-behaviour.
  it('gives every entry a unique id and a reachable destination', () => {
    const ids = IMPERIUM_EXTENSIONS.map(feature => feature.id)
    expect(new Set(ids).size).toBe(ids.length)
    for (const feature of IMPERIUM_EXTENSIONS) {
      expect(feature.destinations.length).toBeGreaterThan(0)
      for (const destination of feature.destinations) {
        if (destination.kind === 'internal') expect(destination.href).toMatch(/^\//)
        else expect(destination.href).toMatch(/^https:\/\//)
      }
    }
  })

  it('documents what switching each one off actually does', () => {
    // The whole point of the registry: an operator about to disable something
    // can read what stops and what is retained before they do it.
    for (const feature of IMPERIUM_EXTENSIONS) {
      expect(feature.offBehaviour.length).toBeGreaterThan(20)
      expect(feature.takesEffect.length).toBeGreaterThan(5)
      expect(feature.codeLocations.length).toBeGreaterThan(0)
      expect(feature.settingsLocation.length).toBeGreaterThan(0)
    }
  })

  it('guards paid spend, and only paid spend, behind a typed confirmation', () => {
    const needConfirmation = IMPERIUM_EXTENSIONS.filter(f => f.disableConfirmation === 'paid-spend')
    expect(needConfirmation.map(f => f.id)).toEqual([PAID_BALANCE_GUARD_ID])
    // It must also default to ON, or a fresh install routes paid by omission.
    expect(needConfirmation[0]!.defaultEnabled).toBe(true)
  })
})

describe('the extensions panel', () => {
  it('renders one switch per extension, with its off-behaviour', async () => {
    await mount()
    // Switch renders a role=switch element plus a hidden input; count the former.
    const switches = container.querySelectorAll('[role="switch"]')
    expect(switches.length).toBe(IMPERIUM_EXTENSIONS.length)
    const html = container.innerHTML
    for (const feature of IMPERIUM_EXTENSIONS) expect(html).toContain(feature.title)
    expect(html).toContain('When off:')
  })

  it('will not disable the paid guard on a click alone', async () => {
    await mount()
    const guard = IMPERIUM_EXTENSIONS.find(f => f.id === PAID_BALANCE_GUARD_ID)!
    // Find the guard's own switch by walking up from its title.
    const section = [...container.querySelectorAll('div')]
      .find(node => node.textContent?.includes(guard.title) && node.querySelector('[role="switch"], input[type="checkbox"]'))!
    const toggle = section.querySelector<HTMLElement>('[role="switch"], input[type="checkbox"]')!
    await act(async () => { toggle.click() })
    // No write went out; the confirmation phrase is demanded instead.
    expect(vi.mocked(apiFetch).mock.calls.filter(([, init]) => (init as RequestInit | undefined)?.method === 'PUT')).toHaveLength(0)
    expect(container.innerHTML).toContain(PAID_SPEND_CONFIRMATION)
  })
})
