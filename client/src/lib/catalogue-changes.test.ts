import { describe, expect, it } from 'vitest'
import { churnByPlatform, unreadSelection, RECENT_HEAD } from './catalogue-changes'
import type { CatalogueChanges } from './catalogue-changes'

const day = (offset: number) => {
  const d = new Date(Date.now() + offset * 86_400_000)
  return `${d.toISOString().slice(0, 10)} 12:00:00`
}

function changes(over: Partial<CatalogueChanges> = {}): CatalogueChanges {
  return { since: day(-30), arrived: [], departed: [], untrackedArrivals: 0, ...over }
}

const arrival = (platform: string, firstSeenAt: string, acknowledged = false) => ({
  platform, modelId: 'm', displayName: 'M', firstSeenAt, routed: false, chains: [],
  acknowledged, supportsTools: true, supportsVision: false, contextWindow: null,
})

// `id` is a parameter because a fixture with two rows under one key is not two
// rows; the churn tests share one shape without passing it.
const departure = (platform: string, retiredAt: string, acknowledgedAt: string | null = null, id = 'gone') => ({
  platform, modelId: id, retiredAt, reason: null, lostFrom: [],
  acknowledgedAt, acknowledged: acknowledgedAt !== null,
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

describe('unreadSelection', () => {
  it('is a worklist when something is unread, and says no recent head', () => {
    const out = unreadSelection({
      arrived: [arrival('groq', day(-1)), arrival('groq', day(-2), true)],
      departed: [departure('google', day(-5)), departure('google', day(-9), day(-9))],
    })
    expect(out.hasUnread).toBe(true)
    expect(out.arrived.map(a => a.firstSeenAt)).toEqual([day(-1)])
    expect(out.departed.map(d => d.retiredAt)).toEqual([day(-5)])
    // No head while there is work: the two are different questions, and a panel
    // showing both at once cannot answer either.
    expect(out.recent).toBeNull()
  })

  it('is quiet once everything is acknowledged, with a 10-row head across both kinds', () => {
    // The count is across BOTH lists, not per-list: "the 10 most recent
    // changes" means ten rows on screen, and two ten-row lists would be twenty.
    const arrived = Array.from({ length: 8 }, (_, i) => arrival('groq', day(-i - 1), true))
    const departed = Array.from({ length: 5 }, (_, i) => departure('google', day(-i - 1), day(-i - 1)))
    const out = unreadSelection({ arrived, departed })
    expect(out.hasUnread).toBe(false)
    expect(out.arrived).toEqual([])
    expect(out.departed).toEqual([])
    expect(out.recent).toHaveLength(RECENT_HEAD)
    // Newest first, and the head is not all arrivals just because they are
    // listed first.
    expect(out.recent![0]!.at).toBe(day(-1))
    expect(out.recent!.filter(c => c.kind === 'departed')).toHaveLength(5)
  })

  it('hands back fewer than ten when there are fewer than ten', () => {
    const out = unreadSelection({ arrived: [arrival('groq', day(-1), true)], departed: [] })
    expect(out.recent).toHaveLength(1)
  })

  it('counts an acknowledged departure as read through the same field', () => {
    const out = unreadSelection({
      arrived: [],
      departed: [departure('google', day(-1), day(-1), 'read'), departure('groq', day(-2), null, 'unread')],
    })
    expect(out.hasUnread).toBe(true)
    expect(out.departed.map(d => d.modelId)).toEqual(['unread'])
    expect(out.recent).toBeNull()
  })
})

describe('acknowledging does not disturb the Keys churn chips', () => {
  it('counts acknowledged rows exactly as it counted unread ones', () => {
    // The invariant the shared payload depends on: provider chips count what a
    // provider's catalogue DID, not what the operator has read. Filter this and
    // the keys page silently loses its churn.
    const unread = changes({
      arrived: [arrival('groq', day(-2)), arrival('nvidia', day(-1))],
      departed: [departure('google', day(-5))],
    })
    const read = changes({
      arrived: [arrival('groq', day(-2), true), arrival('nvidia', day(-1), true)],
      departed: [departure('google', day(-5), day(-5))],
    })
    const before = churnByPlatform(unread)
    const after = churnByPlatform(read)
    expect(after.get('groq')!.arrived).toHaveLength(before.get('groq')!.arrived.length)
    expect(after.get('nvidia')!.arrived).toHaveLength(before.get('nvidia')!.arrived.length)
    expect(after.get('google')!.departed).toHaveLength(before.get('google')!.departed.length)
  })
})
