import { createContext, useContext } from 'react'
import type { CapacityFreshness, ProviderCapacityResponse, ProviderCapacityReading } from '@freellmapi/shared/types'

export interface ProviderCapacityView {
  enabled: boolean
  data: ProviderCapacityResponse | undefined
  isLoading: boolean
  isError: boolean
  now: number
  numbers: Intl.NumberFormat
  percentages: Intl.NumberFormat
  timestamps: Intl.DateTimeFormat
}

export const ProviderCapacityContext = createContext<ProviderCapacityView | null>(null)

/** Widgets share the authenticated page's one observer and one clock. */
export function useProviderCapacity() {
  return useContext(ProviderCapacityContext)
}

export function currentCapacityFreshness(
  reading: Pick<ProviderCapacityReading, 'freshness' | 'observedAt'> & { resetAt?: string | null },
  maxAgeMs: number,
  now: number,
  failed = false,
): CapacityFreshness {
  if (reading.freshness !== 'fresh') return reading.freshness
  const observed = reading.observedAt == null ? NaN : Date.parse(reading.observedAt)
  if (!Number.isFinite(observed)) return 'unknown'
  const reset = reading.resetAt == null ? null : Date.parse(reading.resetAt)
  return failed || now - observed >= maxAgeMs || (reset != null && Number.isFinite(reset) && reset <= now) ? 'stale' : 'fresh'
}

/** Precision limits must not erase a known nonzero amount. */
export function formatCapacityAmount(value: number | null, formatter: Intl.NumberFormat): string {
  if (value == null) return '—'
  if (value > 0 && value < 0.00000001) return `<${formatter.format(0.00000001)}`
  return formatter.format(value)
}

/** A compact label never claims a measured 99.99999% balance is untouched. */
export function formatCapacityPercent(value: number | null, formatter: Intl.NumberFormat): string {
  if (value == null) return '—'
  const text = formatter.format(value)
  if (value < 100 && text === formatter.format(100)) return `<${text}%`
  if (value > 0 && text === formatter.format(0)) return `<${formatter.format(0.0001)}%`
  return `${text}%`
}
