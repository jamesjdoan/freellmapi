// @vitest-environment jsdom
/**
 * The extensions panel.
 *
 * The registry's own contract is asserted server-side
 * (server/src/__tests__/data/extension-registry.test.ts), because the rows live
 * there: `@freellmapi/shared` ships no JavaScript, so a value import of it
 * fails inside the built image. The panel is fed a fixture payload here, which
 * is also what it gets in production — it reads rows from GET /api/extensions
 * rather than importing them.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter } from 'react-router-dom'
import { I18nProvider } from '@/i18n'
import { apiFetch } from '@/lib/api'
import { ExtensionFeatureList } from '../components/extensions-dialog'

vi.mock('@/lib/api', () => ({ apiFetch: vi.fn() }))

const CONFIRMATION = 'ALLOW PAID SPEND'
const ROWS = [
  {
    id: 'paid-balance-guard', title: 'Paid-balance guard', summary: 'No free chain spends credit.',
    settingsLocation: 'Extensions', destinations: [{ kind: 'internal', label: 'Open', href: '/extensions' }],
    category: 'safety', defaultEnabled: true, offBehaviour: 'Paid routes become selectable and real credit can be spent.',
    takesEffect: 'Next upstream dispatch.', codeLocations: ['server/src/services/provider-quota.ts'],
    disableConfirmation: 'paid-spend', enabled: true,
  },
  {
    id: 'catalogue-log', title: 'Catalogue arrival and departure log', summary: 'History of models entering and leaving.',
    settingsLocation: 'Models', destinations: [{ kind: 'internal', label: 'Open', href: '/models/chat' }],
    category: 'presentation', defaultEnabled: true, offBehaviour: 'The panel is hidden; events keep being recorded.',
    takesEffect: 'Next page load.', codeLocations: ['server/src/services/catalogue-log.ts'],
    disableConfirmation: 'none', enabled: true,
  },
]

let root: Root
let container: HTMLDivElement

beforeAll(() => {
  ;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
})
beforeEach(() => {
  vi.mocked(apiFetch).mockReset().mockResolvedValue({
    revision: 3,
    paidSpendAcknowledgement: null,
    paidSpendConfirmation: CONFIRMATION,
    extensions: ROWS,
  })
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})
afterEach(() => { act(() => root.unmount()); container.remove() })

/** The switch belonging to one extension, found by its own row container. */
function switchFor(title: string): HTMLElement {
  const row = [...container.querySelectorAll('div.rounded-2xl')]
    .find(node => node.textContent?.includes(title))
  if (!row) throw new Error(`no row rendered for ${title}`)
  const toggle = row.querySelector<HTMLElement>('[role="switch"]')
  if (!toggle) throw new Error(`row for ${title} has no switch`)
  return toggle
}

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
  // The list renders a pending state first; let the query settle.
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) })
}

describe('the extensions panel', () => {
  it('renders one switch per extension, with its off-behaviour', async () => {
    await mount()
    // Switch renders a role=switch element plus a hidden input; count the former.
    expect(container.querySelectorAll('[role="switch"]').length).toBe(ROWS.length)
    const html = container.innerHTML
    for (const row of ROWS) expect(html).toContain(row.title)
    expect(html).toContain('When off:')
    expect(html).toContain('Takes effect:')
  })

  it('toggles an ordinary extension straight away', async () => {
    await mount()
    await act(async () => { switchFor('Catalogue arrival').click() })
    const writes = vi.mocked(apiFetch).mock.calls.filter(([, init]) => (init as RequestInit | undefined)?.method === 'PUT')
    expect(writes).toHaveLength(1)
    expect(String(writes[0]![0])).toContain('catalogue-log')
  })

  it('will not disable the paid guard on a click alone', async () => {
    await mount()
    await act(async () => { switchFor('Paid-balance guard').click() })
    // No write went out; the confirmation phrase is demanded instead. The
    // phrase comes from the payload, not from a shared constant.
    const writes = vi.mocked(apiFetch).mock.calls.filter(([, init]) => (init as RequestInit | undefined)?.method === 'PUT')
    expect(writes).toHaveLength(0)
    expect(container.innerHTML).toContain(CONFIRMATION)
  })
})
