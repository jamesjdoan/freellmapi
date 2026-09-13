import { useQuery } from '@tanstack/react-query'
import { apiFetch } from '@/lib/api'

// Which providers this install has actually turned on.
//
// The catalogue is deliberately much larger than the routed set: sync pulls
// every model a provider publishes so the history is complete. That makes the
// catalogue panels noisy in the opposite direction from the Keys page — the log
// reports arrivals and departures on providers you hold no key for and can
// never call, and they crowd out the ones you can act on.
//
// "Activated" is deliberately the weakest useful test: a key row that exists
// and is switched on. NOT healthy, and NOT in scope for the model in question.
// An unhealthy key is a provider you have and need to fix, so its arrivals are
// still yours to read; a provider with no key at all is someone else's news.

export interface KeyedPlatform {
  platform: string
  enabled: boolean
}

/** Platforms with at least one enabled key. */
export function activatedPlatforms(keys: KeyedPlatform[]): Set<string> {
  return new Set(keys.filter(k => k.enabled).map(k => k.platform))
}

/**
 * Split rows by whether their provider is activated. Returned as a pair rather
 * than a filtered list because the count of what was hidden is part of the
 * disclosure — silently dropping rows is the failure mode here.
 */
export function partitionByActivated<T extends { platform: string }>(
  rows: T[],
  activated: Set<string>,
): { shown: T[]; hidden: T[] } {
  const shown: T[] = []
  const hidden: T[] = []
  for (const row of rows) (activated.has(row.platform) ? shown : hidden).push(row)
  return { shown, hidden }
}

/**
 * An empty set while the keys query is in flight would hide every row for a
 * moment, so callers get `ready` and keep showing everything until it lands.
 */
export function useActivatedPlatforms(): { activated: Set<string>; ready: boolean } {
  const { data, isSuccess } = useQuery<KeyedPlatform[]>({
    queryKey: ['keys'],
    queryFn: () => apiFetch('/api/keys'),
  })
  return { activated: activatedPlatforms(data ?? []), ready: isSuccess }
}
