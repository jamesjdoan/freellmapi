import { describe, expect, it } from 'vitest'
import { buildCards, formatAge, formatReset, headroomTone, liveObservations, poolName, summarizeUsageCredentials, type OverviewPool, type UsageCredentialStatus } from './quota-dashboard'

const NOW = Date.UTC(2026, 9, 17, 6, 0, 0)
const pool = (over: Partial<OverviewPool>): OverviewPool => ({
  platform: 'groq', pool: 'groq::model::qwen', limit: 1000, remaining: 812, reset_at: null,
  metered: true, usedSource: 'provider', metric: 'requests', unit: null, ...over,
})
const keys = [
  { id: 1, platform: 'groq', enabled: true },
  { id: 2, platform: 'xkiro', enabled: true },
  { id: 3, platform: 'zhipu', enabled: true },
  { id: 4, platform: 'anyapi', enabled: false },
]

describe('buildCards', () => {
  it('makes one card per enabled keyed provider, spent first and unmeasured last', () => {
    const cards = buildCards([
      pool({}),
      pool({ platform: 'xkiro', pool: 'xkiro::free', limit: 1_000_000, remaining: 0, metric: 'tokens', reset_at: '2026-10-18T00:00:00.000Z' }),
      pool({ platform: 'anyapi', pool: 'anyapi::free' }),
    ], keys, [], NOW)
    expect(cards.map(c => c.platform)).toEqual(['xkiro', 'groq', 'zhipu'])
    expect(cards[0]).toMatchObject({ waiting: true, nextResetMs: Date.UTC(2026, 9, 18) })
    expect(cards[0].rows[0]).toMatchObject({ label: 'free', spent: true, left: 0, amount: '0 / 1M tokens' })
    expect(cards[1].rows[0]).toMatchObject({ label: 'qwen', left: 81, tone: 'good', amount: '812 / 1,000' })
    expect(cards[2].rows).toEqual([])
  })

  it('reports a spent allowance with no known reset as used up, not waiting', () => {
    const [card] = buildCards([pool({ remaining: 0 })], [keys[0]], [], NOW)
    expect(card).toMatchObject({ waiting: false, nextResetMs: null })
    expect(card.rows[0].spent).toBe(true)
  })

  it('shows a row whose reset has passed as refilled full, spent or not, and not waiting', () => {
    const cards = buildCards([
      pool({ remaining: 0, reset_at: '2026-10-17 05:00:00' }),
      pool({ pool: 'groq::model::other', remaining: 300, reset_at: '2026-10-17T04:00:00.000Z' }),
    ], [keys[0]], [], NOW)
    expect(cards[0]).toMatchObject({ waiting: false, nextResetMs: null })
    expect(cards[0].rows[0]).toMatchObject({ spent: false, refilled: true, left: 100, tone: 'good', amount: '1,000 / 1,000' })
    expect(cards[0].rows[1]).toMatchObject({ refilled: true, left: 100, amount: '1,000 / 1,000' })
  })

  it('hides zero-allowance pools as paid-only, shows a learned limit as learned, and drops pools with no numbers', () => {
    const [card] = buildCards([
      pool({ pool: 'groq::model::paid', limit: 0, remaining: 0 }),
      pool({ pool: 'groq::account', metered: false, limit: null, remaining: null }),
      pool({ pool: 'groq::calendar_day', metered: false, limit: 1060, remaining: 0, usedSource: 'local', reset_at: '2026-10-17T07:00:00.000Z' }),
      pool({}),
    ], [keys[0]], [], NOW)
    expect(card.paidOnly).toBe(1)
    expect(card.rows.map(r => [r.label, r.learned])).toEqual([['daily', true], ['qwen', false]])
    expect(card).toMatchObject({ waiting: true, nextResetMs: Date.UTC(2026, 9, 17, 7) })
  })

  it('formats credit balances and fractions in their own units, and marks local counts', () => {
    const cards = buildCards([
      pool({ platform: 'openrouter', pool: 'openrouter::credits', unit: 'cents', limit: 1200, remaining: 950 }),
      pool({ platform: 'openrouter', pool: 'openrouter::calendar_day', limit: 1000, remaining: 812, usedSource: 'local' }),
    ], [{ id: 9, platform: 'openrouter', enabled: true }], [], NOW)
    const rows = cards[0].rows
    expect(rows.find(r => r.label === 'credits')!.amount).toBe('$9.50 / $12.00')
    expect(rows.find(r => r.label === 'daily')!.local).toBe(true)
    // An unsized allowance reported as a fraction shows only its percentage.
    const [ollama] = buildCards([pool({ platform: 'ollama', pool: 'ollama::monthly', unit: 'per_10k', limit: 10_000, remaining: 6820 })],
      [{ id: 8, platform: 'ollama', enabled: true }], [], NOW)
    expect(ollama.rows[0]).toMatchObject({ left: 68, amount: '' })
  })

  it('dates a card by its newest measured reading for a live key, and flags it stale after a day', () => {
    const cards = buildCards([], keys, [
      { platform: 'zhipu', keyId: 3, observedAt: '2026-10-09 06:00:00', limit: null, remaining: 5 },
      { platform: 'groq', keyId: 1, observedAt: '2026-10-17 05:58:00' },
      { platform: 'groq', keyId: 99, observedAt: '2026-10-17 05:59:59' },
      // A probe that measured nothing is not a fresher reading.
      { platform: 'groq', keyId: 1, observedAt: '2026-10-17 05:59:30', limit: null, remaining: null },
    ], NOW)
    const groq = cards.find(c => c.platform === 'groq')!
    expect(groq).toMatchObject({ updatedMs: Date.UTC(2026, 9, 17, 5, 58), stale: false })
    expect(cards.find(c => c.platform === 'zhipu')!.stale).toBe(true)
  })
})

describe('helpers', () => {
  it('uses the shared headroom thresholds', () => {
    expect([100, 51, 50, 21, 20, 0].map(headroomTone)).toEqual(['good', 'good', 'warn', 'warn', 'low', 'low'])
  })

  it('names a pool without its provider prefix or kind', () => {
    expect(poolName('google', 'google::project-model::gemini-3.8-flash')).toBe('gemini-3.8-flash')
    expect(poolName('nvidia', 'nvidia::calendar_day')).toBe('daily')
    expect(poolName('mistral', 'mistral::codestral')).toBe('codestral')
  })

  it('formats ages at the coarsest useful unit, and resets without seconds past an hour', () => {
    expect([59_000, 4 * 60_000, 3 * 3_600_000, 50 * 3_600_000].map(formatAge)).toEqual(['0m', '4m', '3h', '2d'])
    expect([63_998, 245, 0].map(formatReset)).toEqual(['17h 46m', '4m 05s', '0m'])
  })

  it('keeps only readings for keys that still exist and are on', () => {
    const rows = [{ platform: 'groq', keyId: 1, observedAt: '' }, { platform: 'anyapi', keyId: 4, observedAt: '' }, { platform: 'gone', keyId: 77, observedAt: '' }]
    expect(liveObservations(rows, keys)).toEqual({ live: [rows[0]], hidden: 2 })
  })
})

describe('usage credential lines', () => {
  const cred = (over: Partial<UsageCredentialStatus>): UsageCredentialStatus => ({
    keyId: 1, platform: 'unorouter', setAt: '2026-10-17 05:00:00',
    lastReadAt: null, lastStatus: null, lastMessage: null, ...over,
  })

  it('is null while no key of the platform is connected', () => {
    expect(summarizeUsageCredentials([cred({})], 'radeon')).toBeNull()
    expect(summarizeUsageCredentials([], 'unorouter')).toBeNull()
  })

  it('reports the newest read and message, with a refusal winning over a balance note', () => {
    expect(summarizeUsageCredentials([
      cred({ keyId: 1, lastReadAt: '2026-10-17 05:59:00', lastStatus: 'ok', lastMessage: 'balance $3.20 of $5.00' }),
      cred({ keyId: 2, lastReadAt: '2026-10-17 05:58:00', lastStatus: 'error', lastMessage: 'session expired' }),
    ], 'unorouter')).toEqual({
      readMs: Date.UTC(2026, 9, 17, 5, 59),
      message: 'balance $3.20 of $5.00',
      errorMessage: 'session expired',
    })
    expect(summarizeUsageCredentials([cred({ lastReadAt: '2026-10-17 05:59:00', lastStatus: 'ok', lastMessage: 'balance $3.20 of $5.00' })], 'unorouter'))
      .toEqual({ readMs: Date.UTC(2026, 9, 17, 5, 59), message: 'balance $3.20 of $5.00', errorMessage: null })
  })
})
