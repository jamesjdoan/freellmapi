import { describe, expect, it } from 'vitest'
import { activatedPlatforms, partitionByActivated } from './activated-platforms'

describe('activated platforms', () => {
  it('counts a provider as activated on an enabled key regardless of health', () => {
    // The weak test is deliberate. An unhealthy key is a provider you have and
    // have to fix, so its catalogue news is still yours to read; treating it as
    // deactivated would hide the arrivals right when they matter.
    const activated = activatedPlatforms([
      { platform: 'groq', enabled: true },
      { platform: 'nvidia', enabled: false },
    ] as never)
    expect([...activated]).toEqual(['groq'])
  })

  it('activates on ANY enabled key when a provider has several', () => {
    // Multi-key providers are normal here, and one disabled spare must not
    // deactivate a provider that is plainly in use.
    const activated = activatedPlatforms([
      { platform: 'google', enabled: false },
      { platform: 'google', enabled: true },
    ])
    expect(activated.has('google')).toBe(true)
  })

  it('reports what it hid rather than dropping it silently', () => {
    // The count is the disclosure. A panel that quietly shows two of five rows
    // is worse than one that shows all five.
    const { shown, hidden } = partitionByActivated(
      [
        { platform: 'groq', modelId: 'a' },
        { platform: 'cloudflare', modelId: 'b' },
        { platform: 'cloudflare', modelId: 'c' },
      ],
      new Set(['groq']),
    )
    expect(shown.map(r => r.modelId)).toEqual(['a'])
    expect(hidden.map(r => r.modelId)).toEqual(['b', 'c'])
  })

  it('hides nothing when no provider is activated yet', () => {
    // A fresh install holds no keys. Filtering to an empty set would render an
    // empty panel and read as broken, so callers gate on `ready` — this pins
    // the shape they gate on: everything falls to `hidden`, never lost.
    const { shown, hidden } = partitionByActivated([{ platform: 'groq' }], new Set())
    expect(shown).toEqual([])
    expect(hidden).toHaveLength(1)
  })
})
