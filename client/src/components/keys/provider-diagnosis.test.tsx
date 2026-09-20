// @vitest-environment jsdom
/**
 * The provider verdict chip.
 *
 * Two behaviours worth defending: a blocked provider must show what happened
 * and what to do, and a healthy one must show NOTHING. The second is the one
 * that keeps the first useful — a badge on every provider row is a badge nobody
 * reads, and nine of eleven providers here are healthy at any time.
 */
import { describe, it, expect, afterEach } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'
import { ProviderDiagnosisChip, type ProviderDiagnosis } from './provider-diagnosis'

function diagnosis(over: Partial<ProviderDiagnosis>): ProviderDiagnosis {
  return {
    platform: 'opencode', verdict: 'healthy', dominantCode: null, sample: null,
    keyed: true, okModels: 5, failingModels: 0, activeCooldowns: 0,
    cause: 'Serving normally.', action: 'Nothing to do.', selfHealing: true,
    sinceMs: null,
    ...over,
  }
}

let root: Root | null = null
let container: HTMLElement | null = null

function render(d: ProviderDiagnosis | undefined): HTMLElement {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  act(() => { root!.render(<ProviderDiagnosisChip diagnosis={d} />) })
  return container
}

afterEach(() => {
  act(() => root?.unmount())
  container?.remove()
  root = null
})

describe('the provider verdict chip', () => {
  it('names the code and carries the provider\'s own words when an account is blocked', () => {
    const el = render(diagnosis({
      verdict: 'access_denied',
      dominantCode: 'E403',
      sample: "OpenCode Zen API error 403: OpenCode's free tier has ended",
      okModels: 0,
      failingModels: 11,
      cause: 'The account may not use these models (403/402).',
      action: 'Waiting will not fix this.',
      selfHealing: false,
    }))
    expect(el.textContent).toContain('E403')
    // The tooltip portals into document.body on hover, so drive the hover
    // rather than reading a title attribute this component does not use.
    act(() => {
      // The wrapper listens on mouseenter; jsdom needs the event dispatched on
      // the element that carries the handler, which is the outer span.
      const wrapper = el.firstElementChild as HTMLElement
      wrapper.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true }))
      wrapper.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }))
    })
    const tip = document.body.textContent ?? ''
    expect(tip).toContain('free tier')
    expect(tip).toContain('Waiting will not fix this')
  })

  it('says nothing at all for a healthy provider', () => {
    // The whole design: silence is what makes the blocked row visible.
    expect(render(diagnosis({ verdict: 'healthy' })).textContent).toBe('')
  })

  it('says nothing for a provider with no key, which is not a fault', () => {
    expect(render(diagnosis({ verdict: 'no_key', keyed: false })).textContent).toBe('')
  })

  it('marks a rate limit differently from a block, because one heals itself', () => {
    const chip = (el: HTMLElement) =>
      [...el.querySelectorAll('span')].map(s => s.className).join(' ')

    const limited = render(diagnosis({ verdict: 'rate_limited', dominantCode: 'E429', activeCooldowns: 2 }))
    expect(chip(limited)).toContain('amber')

    act(() => root!.unmount())
    container!.remove()

    const blocked = render(diagnosis({ verdict: 'access_denied', dominantCode: 'E403' }))
    expect(chip(blocked)).toContain('rose')
  })
})
