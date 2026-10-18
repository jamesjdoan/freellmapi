// @vitest-environment jsdom
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { I18nProvider } from '@/i18n'
import { apiFetch } from '@/lib/api'
import type { ScoreCell } from '@/lib/score-provenance'
import { EditableScore } from './score-value'

// ADR ARCH-20261018: a typed score must carry where it came from, so the form
// refuses to save without a provenance, and every non-measured score prints in
// its provenance colour with an italic note — a measurement prints plain.

vi.mock('@/lib/api', () => ({ apiFetch: vi.fn() }))
// Render the popup inline: portal and positioning are not under test.
vi.mock('@/components/ui/popover', () => ({
  Popover: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  PopoverTrigger: ({ children, ...props }: { children: ReactNode; 'aria-label'?: string }) =>
    <button type="button" aria-label={props['aria-label']}>{children}</button>,
  PopoverContent: ({ children }: { children: ReactNode }) => <div data-testid="popup">{children}</div>,
}))

let root: Root
let container: HTMLDivElement

const cell = (over: Partial<ScoreCell>): ScoreCell => ({ value: null, provenance: null, entry: null, editable: true, ...over })
const routes = [{ platform: 'mistral', modelId: 'ministral-8b' }]

function render(node: ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  act(() => {
    root.render(<QueryClientProvider client={client}><I18nProvider>{node}</I18nProvider></QueryClientProvider>)
  })
}

function setInput(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
  act(() => {
    setter.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

beforeAll(() => { Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true }) })
beforeEach(() => {
  vi.mocked(apiFetch).mockReset()
  vi.mocked(apiFetch).mockResolvedValue({ success: true, written: 1 })
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})
afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

describe('EditableScore', () => {
  it('offers entry on an empty cell and will not save until a value AND a provenance are chosen', async () => {
    render(<EditableScore cell={cell({})} metric="coding" routes={routes} />)
    expect(container.querySelector('button[aria-label="Enter Coding score"]')).not.toBeNull()

    const save = [...container.querySelectorAll('button')].find(b => b.textContent === 'Save')!
    expect(save.disabled).toBe(true)
    setInput(container.querySelector('input[type="number"]')!, '14.3')
    expect(save.disabled).toBe(true)
    act(() => { container.querySelector<HTMLInputElement>('input[value="tested"]')!.click() })
    expect(save.disabled).toBe(false)

    await act(async () => { save.click() })
    expect(apiFetch).toHaveBeenCalledWith('/api/analysis/score', {
      method: 'PUT',
      body: JSON.stringify({ routes, metric: 'coding', value: 14.3, provenance: 'tested' }),
    })
  })

  it('prints a tested score in cyan with an italic "tested" note', () => {
    render(<EditableScore cell={cell({
      value: 22, provenance: 'tested', entry: { value: 22, provenance: 'tested', enteredAt: '2026-10-18 09:00:00', superseded: false },
    })} metric="agentic" routes={routes} />)
    const note = [...container.querySelectorAll('span.italic')].find(s => s.textContent === 'tested')
    expect(note).toBeDefined()
    expect(note!.parentElement!.className).toContain('text-cyan-700')
  })

  it('prints a measurement plain, with no note and no way to type over it', () => {
    render(<EditableScore cell={cell({ value: 40.5, provenance: 'measured', editable: false })} metric="intelligence" routes={routes} toneClass="tone-x" />)
    expect(container.textContent).toBe('40.5')
    expect(container.querySelector('span.italic')).toBeNull()
    expect(container.querySelector('button')).toBeNull()
    // The chain-minimum tone still applies to a measurement.
    expect(container.querySelector('.tone-x')).not.toBeNull()
  })

  it('keeps a superseded entry visible as a note on the measurement that replaced it', () => {
    render(<EditableScore cell={cell({
      value: 31, provenance: 'measured', editable: false,
      entry: { value: 28, provenance: 'approximated', enteredAt: '2026-10-01 00:00:00', superseded: true },
    })} metric="coding" routes={routes} />)
    expect(container.querySelector('[title]')!.getAttribute('title')).toBe('Your 28.0 (approximated) was replaced by a measurement.')
  })
})
