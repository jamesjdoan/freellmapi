// @vitest-environment jsdom
/**
 * Why a row is not serving, and the control that has nothing to do.
 *
 * Found on NVIDIA: kimi-k3 and deepseek-v4-flash both showed a green "tested"
 * mark, sat greyed, and said nothing about being switched off in the catalogue.
 * A greyed row with a passing test reads as the router ignoring a working
 * route.
 *
 * The four blocked states come from analysis.ts:465-486 and mean different
 * things - no credential, an unusable one, a scoped one that excludes the
 * model, and a catalogue switch. Each names a different action, so this asserts
 * they stay distinct rather than collapsing into "not selected".
 */
import { describe, it, expect } from 'vitest'
import { blockedReason, verdictEdge } from '@/lib/route-blockers'

type Row = Parameters<typeof blockedReason>[0]

function row(over: Partial<Row>): Row {
  return { enabled: true, keyScope: 'unscoped', ...over } as Row
}

describe('blockedReason', () => {
  it('says nothing when the route can serve', () => {
    expect(blockedReason(row({}))).toBeNull()
    expect(blockedReason(row({ keyScope: 'in' }))).toBeNull()
  })

  it('names the NVIDIA case: tested, keyed, and switched off in the catalogue', () => {
    expect(blockedReason(row({ enabled: false }))).toBe('panelWhyCatalogueOff')
  })

  it('keeps no-credential apart from an unusable one', () => {
    // 'disabled' is a key we hold that is off OR not healthy/unknown, which is
    // a different fix from having no key at all.
    expect(blockedReason(row({ keyScope: 'none' }))).toBe('panelWhyNoKey')
    expect(blockedReason(row({ keyScope: 'disabled' }))).toBe('panelWhyKeyOff')
  })

  it('names a scoped key that excludes the model', () => {
    expect(blockedReason(row({ keyScope: 'out' }))).toBe('panelWhyOutOfScope')
  })

  it('reports the key before the catalogue when both are wrong', () => {
    // Order matters: no key is the outer obstacle, and flipping the catalogue
    // switch would change nothing while it holds.
    expect(blockedReason(row({ enabled: false, keyScope: 'none' }))).toBe('panelWhyNoKey')
  })
})

describe('verdictEdge', () => {
  it('shades a tested route by its result', () => {
    expect(verdictEdge({ verdict: 'ok' } as never)).toContain('emerald')
    expect(verdictEdge({ verdict: 'limited' } as never)).toContain('amber')
    expect(verdictEdge({ verdict: 'dead' } as never)).toContain('rose')
  })

  it('leaves untested and unprobed rows uncoloured', () => {
    // Unknown is not evidence: a green edge on a route nobody has called would
    // claim a pass we never measured.
    expect(verdictEdge(undefined)).toContain('transparent')
    expect(verdictEdge({ verdict: 'untested' } as never)).toContain('transparent')
  })
})
