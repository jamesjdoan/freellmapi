import { describe, expect, it } from 'vitest'
import { currentCapacityFreshness, formatCapacityAmount, formatCapacityPercent } from './provider-capacity'

const NOW = Date.parse('2026-10-14T09:00:00Z')
const reading = { freshness: 'fresh' as const, observedAt: new Date(NOW).toISOString(), resetAt: null }
const amounts = new Intl.NumberFormat('en', { maximumFractionDigits: 8 })
const percentages = new Intl.NumberFormat('en', { maximumFractionDigits: 4 })

describe('capacity display boundaries', () => {
  it('does not round nonzero consumption into an apparently untouched allowance', () => {
    expect(formatCapacityPercent(99.999999, percentages)).toBe('<100%')
    expect(formatCapacityPercent(100, percentages)).toBe('100%')
    expect(formatCapacityAmount(0.99995531, amounts)).toBe('0.99995531')
    expect(formatCapacityAmount(0.000000001, amounts)).toBe('<0.00000001')
  })

  it('keeps unknown measurements distinct from genuine zero', () => {
    expect(formatCapacityAmount(null, amounts)).toBe('—')
    expect(formatCapacityAmount(0, amounts)).toBe('0')
    expect(formatCapacityPercent(null, percentages)).toBe('—')
    expect(formatCapacityPercent(0, percentages)).toBe('0%')
  })

  it('expires short RPM readings before the shared allocation', () => {
    expect(currentCapacityFreshness(reading, 60_000, NOW + 60_000)).toBe('stale')
    expect(currentCapacityFreshness(reading, 15 * 60_000, NOW + 60_000)).toBe('fresh')
    expect(currentCapacityFreshness(reading, 15 * 60_000, NOW + 15 * 60_000)).toBe('stale')
  })

  it('does not make a provider reset or failed refresh appear replenished and fresh', () => {
    expect(currentCapacityFreshness({ ...reading, resetAt: new Date(NOW - 1).toISOString() }, 900_000, NOW)).toBe('stale')
    expect(currentCapacityFreshness(reading, 900_000, NOW, true)).toBe('stale')
    expect(currentCapacityFreshness({ ...reading, freshness: 'stale' }, 900_000, NOW)).toBe('stale')
  })

  it('does not turn absent or invalid observed times into a live reading', () => {
    expect(currentCapacityFreshness({ ...reading, observedAt: null }, 900_000, NOW)).toBe('unknown')
    expect(currentCapacityFreshness({ ...reading, observedAt: 'bad-date' }, 900_000, NOW)).toBe('unknown')
  })
})
