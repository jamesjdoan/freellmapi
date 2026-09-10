import { describe, expect, it } from 'vitest'
import { churnByPlatform } from './catalogue-changes'
import type { CatalogueChanges } from './catalogue-changes'

const day = (offset: number) => {
  const d = new Date(Date.now() + offset * 86_400_000)
  return `${d.toISOString().slice(0, 10)} 12:00:00`
}

function changes(over: Partial<CatalogueChanges> = {}): CatalogueChanges {
  return { since: day(-30), arrived: [], departed: [], untrackedArrivals: 0, ...over }
}

const arrival = (platform: string, firstSeenAt: string) => ({
  platform, modelId: 'm', displayName: 'M', firstSeenAt,
  routed: false, chains: [], supportsTools: true, supportsVision: false, contextWindow: null,
})

const departure = (platform: string, retiredAt: string, acknowledgedAt: string | null = null) => ({
  platform, modelId: 'gone', retiredAt, reason: null, lostFrom: [], acknowledgedAt,
})

describe('churnByPlatform', () => {
  it('groups a provider row by platform and reports nothing for the quiet ones', () => {
    const out = churnByPlatform(changes({
      arrived: [arrival('groq', day(-2)), arrival('groq', day(-3)), arrival('nvidia', day(-1))],
      departed: [departure('google', day(-5))],
    }))
    expect(out.get('groq')!.arrived).toHaveLength(2)
    expect(out.get('nvidia')!.arrived).toHaveLength(1)
    expect(out.get('google')!.departed).toHaveLength(1)
    // A provider whose catalogue held still gets no chip at all, rather than +0/-0.
    expect(out.get('ollama')).toBeUndefined()
  })

  it('windows departures even while they are unacknowledged', () => {
    // The chain page's panel keeps these forever, on purpose: an unacknowledged
    // retirement is unfinished work. A provider row asks a different question,
    // and a four-month-old retirement is not news about the provider.
    const out = churnByPlatform(changes({
      departed: [departure('google', day(-120), null), departure('groq', day(-3), null)],
    }))
    expect(out.get('google')).toBeUndefined()
    expect(out.get('groq')!.departed).toHaveLength(1)
  })

  it('counts a departure the operator already acknowledged', () => {
    // Acknowledgement means "I have dealt with the gap", not "it did not
    // happen" - the provider still shed a model this fortnight.
    const out = churnByPlatform(changes({ departed: [departure('groq', day(-1), day(-1))] }))
    expect(out.get('groq')!.departed).toHaveLength(1)
  })

  it('excludes an arrival that falls outside the window', () => {
    const out = churnByPlatform(changes({ arrived: [arrival('groq', day(-20))] }), 14)
    expect(out.get('groq')).toBeUndefined()
  })
})
