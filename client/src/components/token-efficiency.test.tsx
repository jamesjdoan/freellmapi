// @vitest-environment jsdom
/**
 * Token efficiency, printed and ordered (ADR ARCH-20261020).
 *
 * Three states, and the whole point is that they never look alike:
 *   - an AA ESTIMATE: a token range (all at the output price to all at the
 *     input price), with the 3:1 estimate in the tooltip;
 *   - a SCREEN measurement: a single token count, marked "screen";
 *   - unknown: a dash.
 *
 * The order matters as much as the rendering: AA first, then the screen
 * figures, then the unknown ones, and within a source the fewest tokens
 * first. AA's long tasks and our six short ones are different workloads, so
 * the two sources are never put in one numeric order.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { I18nProvider } from '@/i18n'
import type { TokenEfficiency } from '@freellmapi/shared/types'
import { TokenEfficiencyCell } from './token-efficiency'
import { compareTokenEfficiency, tokenEfficiencyValue } from '@/lib/token-efficiency'
import { sortEntries, type SortableEntry } from '@/lib/compare-sort'

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

const aa: TokenEfficiency = {
  source: 'aa', tokensLow: 271_316, tokensHigh: 833_897, tokensPerTask: 547_874,
  benchVersion: null, scenariosCompleted: null, runAt: null, proxied: false,
}
const screen: TokenEfficiency = {
  source: 'screen', tokensLow: null, tokensHigh: null, tokensPerTask: 1_400,
  benchVersion: '1.0.0', scenariosCompleted: 6, runAt: '2026-10-20T00:00:00.000Z', proxied: false,
}

describe('TokenEfficiencyCell', () => {
  it('prints an AA estimate as a token range, with the 3:1 estimate in the tooltip', () => {
    render(<TokenEfficiencyCell value={aa} />)
    const text = container.textContent ?? ''
    expect(text).toContain('271.3K–833.9K')
    const title = container.querySelector('[title]')?.getAttribute('title') ?? ''
    expect(title).toContain('547.9K')
    expect(title).toContain('3:1')
  })

  it('prints a screen measurement as a token count, marked as a screen', () => {
    render(<TokenEfficiencyCell value={screen} />)
    const text = container.textContent ?? ''
    expect(text).toContain('1.4K')
    expect(text).toContain('screen')
    // A single measured count, never a range.
    const title = container.querySelector('[title]')?.getAttribute('title') ?? ''
    expect(title).toContain('6')
    expect(title).toContain('1.0.0')
  })

  it('prints a dash where nothing measures it', () => {
    render(<TokenEfficiencyCell value={null} />)
    expect(container.textContent).toContain('—')
  })
})

describe('ordering', () => {
  it('puts AA first, then the screen, then the unknown', () => {
    const a = { ...aa, tokensPerTask: 900_000 }
    const cmp = compareTokenEfficiency(a, screen, 'asc')
    expect(cmp).toBeLessThan(0)
    expect(compareTokenEfficiency(screen, null, 'asc')).toBeLessThan(0)
    expect(compareTokenEfficiency(null, a, 'asc')).toBeGreaterThan(0)
  })

  it('puts the most efficient model of a source first', () => {
    // AA: fewer tokens at the 3:1 estimate is more efficient.
    expect(compareTokenEfficiency({ ...aa, tokensPerTask: 40_000 }, { ...aa, tokensPerTask: 500_000 }, 'asc')).toBeLessThan(0)
    // Screen: fewer tokens is more efficient.
    expect(compareTokenEfficiency({ ...screen, tokensPerTask: 600 }, { ...screen, tokensPerTask: 1_400 }, 'asc'))
      .toBeLessThan(0)
  })

  it('never compares an AA estimate with a screen token count', () => {
    // The screen figure is far smaller than the AA estimate, so a merged
    // numeric order would put the screen first. It must not: the sources are
    // different workloads.
    expect(compareTokenEfficiency(aa, screen, 'asc')).toBeLessThan(0)
    expect(compareTokenEfficiency(screen, aa, 'asc')).toBeGreaterThan(0)
  })

  it('reads the number a row sorts on within its source', () => {
    expect(tokenEfficiencyValue(aa)).toBe(547_874)
    expect(tokenEfficiencyValue(screen)).toBe(1_400)
    expect(tokenEfficiencyValue(null)).toBeNull()
  })
})

describe('the Compare column', () => {
  const entry = (name: string, tokenEfficiency: TokenEfficiency | null): SortableEntry => ({
    name,
    chains: [],
    members: [{ contextWindow: 131072, intelligenceRank: 5 }],
    analysis: null,
    scores: {
      intelligence: { value: 20 }, coding: { value: 20 }, agentic: { value: 20 },
    },
    tokenEfficiency,
  })

  it('sorts most efficient first, AA before screen before unknown', () => {
    const aaFirst = entry('AA first', { ...aa, tokensPerTask: 40_000 })
    const aaSecond = entry('AA second', { ...aa, tokensPerTask: 500_000 })
    const screened = entry('Screened', screen)
    const unknown = entry('Unknown', null)

    const out = sortEntries([unknown, screened, aaSecond, aaFirst], 'tokensPerTask', 'asc')
    expect(out.map(e => e.name)).toEqual(['AA first', 'AA second', 'Screened', 'Unknown'])
  })

  it('keeps the unknown rows at the bottom in both directions', () => {
    const known = entry('Known', aa)
    const unknown = entry('Unknown', null)
    expect(sortEntries([known, unknown], 'tokensPerTask', 'asc').map(e => e.name))
      .toEqual(['Known', 'Unknown'])
    expect(sortEntries([known, unknown], 'tokensPerTask', 'desc').map(e => e.name))
      .toEqual(['Known', 'Unknown'])
  })
})
