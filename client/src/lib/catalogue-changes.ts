import { useQuery } from '@tanstack/react-query'
import { apiFetch } from '@/lib/api'

// Shared by the chain page's full panel and the per-provider chip on the Keys
// page. ONE query serves both: the widest window either surface needs is
// fetched once and each narrows it locally. Two queries here would mean two
// requests and two cutoffs that could disagree on screen.

export interface ArrivedModel {
  platform: string
  modelId: string
  displayName: string
  firstSeenAt: string
  routed: boolean
  chains: string[]
  supportsTools: boolean
  supportsVision: boolean
  contextWindow: number | null
}

export interface DepartedModel {
  platform: string
  modelId: string
  retiredAt: string
  reason: string | null
  lostFrom: { chain: string; priority: number }[]
  acknowledgedAt: string | null
}

export interface CatalogueChanges {
  since: string
  arrived: ArrivedModel[]
  departed: DepartedModel[]
  untrackedArrivals: number
}

/** The panel's window. The chip's is narrower and applied client-side. */
export const CHANGES_WINDOW_DAYS = 30

/** How recently a model must have arrived or left to show on a provider row. */
export const PROVIDER_CHURN_DAYS = 14

export function useCatalogueChanges() {
  return useQuery<CatalogueChanges>({
    queryKey: ['catalogue-changes', CHANGES_WINDOW_DAYS],
    queryFn: () => apiFetch(`/api/models/changes?sinceDays=${CHANGES_WINDOW_DAYS}`),
  })
}

/** Stored as `YYYY-MM-DD HH:MM:SS` UTC; the date alone is what a reader needs. */
export function shortDate(value: string): string {
  return value.slice(0, 10)
}

export interface ProviderChurn {
  arrived: ArrivedModel[]
  departed: DepartedModel[]
}

/**
 * Per-platform arrivals and departures inside `days`.
 *
 * Departures are windowed here even though the panel keeps every
 * unacknowledged one forever. The two surfaces answer different questions: the
 * panel is a worklist ("what still needs dealing with"), while a provider row
 * is asking "what has this provider done lately" — and a retirement from four
 * months ago is not news about the provider, acknowledged or not.
 */
export function churnByPlatform(
  data: CatalogueChanges | undefined,
  days = PROVIDER_CHURN_DAYS,
): Map<string, ProviderChurn> {
  const out = new Map<string, ProviderChurn>()
  if (!data) return out
  const cutoff = new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10)
  const bucket = (platform: string): ProviderChurn => {
    let b = out.get(platform)
    if (!b) { b = { arrived: [], departed: [] }; out.set(platform, b) }
    return b
  }
  for (const m of data.arrived) {
    if (shortDate(m.firstSeenAt) >= cutoff) bucket(m.platform).arrived.push(m)
  }
  for (const m of data.departed) {
    if (shortDate(m.retiredAt) >= cutoff) bucket(m.platform).departed.push(m)
  }
  return out
}
