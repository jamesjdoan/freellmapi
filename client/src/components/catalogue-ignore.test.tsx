// @vitest-environment jsdom
//
// Ignoring switches keys and models off, so the flow is pinned: the first
// click only previews what would switch off (and which chains lose models),
// nothing is written until the operator confirms, cancel writes nothing, and
// un-ignoring — which switches routing back on — also needs a confirm.
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { I18nProvider } from '@/i18n'
import { apiFetch } from '@/lib/api'
import { CatalogueIgnoresList, IgnoreButton } from './catalogue-ignore'

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

const settle = () => act(async () => { await new Promise<void>(resolve => { setTimeout(resolve, 0) }) })
/** Poll until the list query has resolved; a cold first render needs more than one tick. */
const listed = () => act(async () => {
  await vi.waitFor(() => { if (!host!.textContent?.includes('Ignored providers')) throw new Error('list not rendered yet') })
})
const calls = (method: string) => vi.mocked(apiFetch).mock.calls.filter(([, init]) => (init?.method ?? 'GET') === method)
const button = (text: string) => [...document.querySelectorAll('button')].find(b => b.textContent?.trim() === text)

function render(node: React.ReactNode, ignores: unknown[] = []) {
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  vi.mocked(apiFetch).mockImplementation(async (path: string, init?: RequestInit) => {
    if (String(path).includes('/preview')) return { keys: 1, models: 13, chains: ['Apex', 'Default'] }
    if (!init?.method && path === '/api/models/catalogue-ignores') return { ignores }
    return {}
  })
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  act(() => root!.render(
    <QueryClientProvider client={client}><I18nProvider initialLocale="en">{node}</I18nProvider></QueryClientProvider>,
  ))
}

// Preview is a POST too (the target list rides in the body), so a "write" is
// only a POST to the ignore endpoint itself.
const previews = () => calls('POST').filter(([p]) => p === '/api/models/catalogue-ignores/preview')
const writes = () => calls('POST').filter(([p]) => p === '/api/models/catalogue-ignores')
const bodyOf = (call: unknown[]) => JSON.parse(String((call[1] as RequestInit).body))

describe('IgnoreButton', () => {
  it('previews a provider ignore, then writes only on confirm', async () => {
    render(<IgnoreButton targets={[{ platform: 'sail', modelId: null }]} name="sail" label="Ignore provider" />)
    await act(async () => { button('Ignore provider')!.click() })
    await settle()
    expect(previews().map(bodyOf)).toEqual([{ targets: [{ platform: 'sail', modelId: null }] }])
    expect(document.querySelector('[role="dialog"]')!.textContent).toContain('Switches off keys: 1, models: 13.')
    expect(document.querySelector('[role="dialog"]')!.textContent).toContain('Leaves chains: Apex, Default.')
    expect(writes()).toHaveLength(0)

    await act(async () => { button('Ignore and switch off')!.click() })
    expect(writes().map(bodyOf)).toEqual([{ targets: [{ platform: 'sail', modelId: null }] }])
  })

  it('ignores every provider route of a model in one write', async () => {
    const routes = [{ platform: 'groq', modelId: 'glm-5.3' }, { platform: 'sail', modelId: 'zai-org/GLM-5.3' }]
    render(<IgnoreButton targets={routes} name="GLM 5.3" label="Ignore" />)
    await act(async () => { button('Ignore')!.click() })
    await settle()
    expect(writes()).toHaveLength(0)
    await act(async () => { button('Ignore and switch off')!.click() })
    expect(writes().map(bodyOf)).toEqual([{ targets: routes }])
  })

  it('writes nothing when the preview is cancelled', async () => {
    render(<IgnoreButton targets={[{ platform: 'xkiro', modelId: 'kiro/claude-sonnet-4' }]} name="kiro/claude-sonnet-4" label="Ignore" />)
    await act(async () => { button('Ignore')!.click() })
    await settle()
    expect(previews()).toHaveLength(1)
    await act(async () => { button('Cancel')!.click() })
    expect(writes()).toHaveLength(0)
    expect(button('Ignore')).toBeDefined()
  })
})

describe('CatalogueIgnoresList', () => {
  const ignores = [
    { platform: 'sail', modelId: null, at: '2026-10-14 03:00:00', switchedOff: { keys: 1, models: 13 } },
    { platform: 'xkiro', modelId: 'kiro/claude-sonnet-4', at: '2026-10-14 03:05:00', switchedOff: { keys: 0, models: 1 } },
  ]

  it('lists what is ignored, what it switched off, and how much it hides', async () => {
    render(<CatalogueIgnoresList hidden={20} />, ignores)
    await listed()
    const text = host!.textContent ?? ''
    expect(text).toContain('Ignored providers and models 2')
    expect(text).toContain('(20 changes hidden from these totals)')
    expect(text).toMatch(/sail\s*whole provider\s*switched off keys: 1, models: 13/)
    expect(text).toContain('kiro/claude-sonnet-4')
  })

  it('un-ignores only after the confirm click, by the same name it was ignored under', async () => {
    render(<CatalogueIgnoresList hidden={0} />, ignores)
    await listed()
    const unignore = host!.querySelector<HTMLButtonElement>('button[aria-label="Un-ignore kiro/claude-sonnet-4"]')!
    await act(async () => { unignore.click() })
    expect(calls('DELETE')).toHaveLength(0)
    await act(async () => { button('Confirm')!.click() })
    expect(calls('DELETE').map(([p]) => p)).toEqual(['/api/models/catalogue-ignores?platform=xkiro&modelId=kiro%2Fclaude-sonnet-4'])
  })

  it('renders nothing when nothing is ignored', async () => {
    render(<CatalogueIgnoresList hidden={0} />, [])
    await act(async () => {
      await vi.waitFor(() => { if (!calls('GET').some(([p]) => p === '/api/models/catalogue-ignores')) throw new Error('not fetched yet') })
    })
    await settle()
    expect(host!.textContent).toBe('')
  })
})
