// @vitest-environment jsdom
/**
 * The ArrangePlan table (ARCH-20261026). The whole point of the preview is
 * that a pass is legible BEFORE it writes: each row must show where a route
 * moved from and to, whether it is pinned, and why it sits there — and from
 * the dialog, one action per row that pins or unpins it.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { I18nProvider } from '@/i18n'
import { ArrangePreviewTable } from './chain-arrange-preview'
import type { ArrangeEntry, ArrangePlan } from '@/lib/chain-arrange'

let root: Root
let container: HTMLDivElement

beforeAll(() => {
  ;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
})
beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})
afterEach(() => { act(() => root.unmount()); container.remove() })

function render(node: React.ReactNode) {
  act(() => { root.render(<I18nProvider initialLocale="en">{node}</I18nProvider>) })
}

const entry = (over: Partial<ArrangeEntry>): ArrangeEntry => ({
  modelDbId: 1,
  platform: 'groq',
  modelId: 'qwen3.8-27b',
  endpointScope: '',
  displayName: 'Qwen 3.8 27B',
  position: 1,
  from: 1,
  eligibility: 'fit',
  tier: 'proven',
  pinned: false,
  pool: 'groq',
  metric: { name: 'intelligence', value: 42.7 },
  reliability: { n: 50, ok: 41, lowerBound: 0.69 },
  reasons: [],
  ...over,
})

// Four routes: one promoted and pinned, one demoted onto a custom endpoint,
// one unmoved, one failing out at the tail.
const entries: ArrangeEntry[] = [
  entry({ modelDbId: 1, displayName: 'GLM 5.3 Flash', position: 1, from: 4, pinned: true,
    metric: { name: 'intelligence', value: 51.2 },
    reasons: ['Proven reliability: 91% over 50 calls', 'Highest intelligence in the chain'] }),
  entry({ modelDbId: 2, displayName: 'Step 5 Preview', position: 2, from: 1,
    platform: 'custom', modelId: 'step-5-preview', endpointScope: 'https://relay.example.com/v1',
    tier: 'failing', eligibility: 'out',
    metric: { name: 'reliability', value: null },
    reliability: { n: 6, ok: 0, lowerBound: 0 } }),
  entry({ modelDbId: 3, displayName: 'Clef Flash', position: 3, from: 3 }),
  entry({ modelDbId: 4, displayName: 'Nemotron Ultra', position: 4, from: 2, eligibility: 'near',
    metric: { name: 'coding', value: 58 } }),
]

const depth: ArrangePlan['depth'] = { required: 8, requiredPools: 4, eligible: 3, pools: 2, satisfied: false }

describe('ArrangePreviewTable', () => {
  it('prints each route with its move, badges and reliability', () => {
    render(<ArrangePreviewTable entries={entries} depth={depth} />)
    const text = container.textContent ?? ''
    expect(text).toContain('GLM 5.3 Flash')
    // Custom routes carry their endpoint, not just the model id.
    expect(text).toContain('relay.example.com')
    expect(text).toContain('fit')
    expect(text).toContain('near')
    expect(text).toContain('failing')
    // Reliability ok/n, with a dash when nothing was measured.
    expect(text).toContain('41/50')
    expect(text).toContain('0/6')
    // The depth line the assignment asks for.
    expect(text).toContain('3/8 eligible')
    expect(text).toContain('2/4 pools')
    expect(text).toContain('depth short')
  })

  it('marks the direction of every move, including unmoved rows', () => {
    render(<ArrangePreviewTable entries={entries} />)
    const up = container.querySelector('[aria-label="Moved up from 4"]')
    expect(up).not.toBeNull()
    const down = container.querySelector('[aria-label="Moved down from 2"]')
    expect(down).not.toBeNull()
    // The unmoved row (3 → 3) shows no arrow at all.
    expect(container.querySelector('[aria-label="Moved up from 3"], [aria-label="Moved down from 3"]')).toBeNull()
  })

  it('flags the pinned route', () => {
    render(<ArrangePreviewTable entries={entries} />)
    const pins = [...container.querySelectorAll('svg[aria-label]')].filter(
      el => el.getAttribute('aria-label')?.includes('Pinned'))
    expect(pins.length).toBe(1)
  })

  it('expands the reasons per row', () => {
    render(<ArrangePreviewTable entries={entries} />)
    expect(container.textContent).toContain('2 reasons')
    // Collapsed by default: the why is one click away, not ink on every row.
    expect(container.textContent).not.toContain('Highest intelligence in the chain')
    const toggle = [...container.querySelectorAll('button[aria-expanded]')]
      .find(b => b.textContent?.includes('2 reasons')) as HTMLButtonElement
    act(() => { toggle.click() })
    expect(container.textContent).toContain('Highest intelligence in the chain')
  })

  it('offers Pin here on unpinned rows and Unpin on pinned ones', () => {
    const onPin = vi.fn()
    const onUnpin = vi.fn()
    render(<ArrangePreviewTable entries={entries} onPin={onPin} onUnpin={onUnpin} />)
    const pin = [...container.querySelectorAll('button')].find(b => b.textContent === 'Pin here')!
    const unpin = [...container.querySelectorAll('button')].find(b => b.textContent === 'Unpin')!
    act(() => { pin.click() })
    act(() => { unpin.click() })
    // Pinning keeps the position the preview proposed.
    expect(onPin).toHaveBeenCalledWith(expect.objectContaining({ displayName: 'Step 5 Preview', position: 2 }))
    expect(onUnpin).toHaveBeenCalledWith(expect.objectContaining({ displayName: 'GLM 5.3 Flash' }))
  })

  it('hides the action column on a run revision', () => {
    render(<ArrangePreviewTable entries={entries} readOnly />)
    expect(container.textContent).not.toContain('Pin here')
    expect(container.textContent).not.toContain('Unpin')
  })
})
