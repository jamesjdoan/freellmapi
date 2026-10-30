// Column sorting for the Compare table.
//
// Kept out of the page because the interesting part is not the comparison, it
// is what happens to the blanks: an unmeasured model is NOT a zero, and a
// column sorted "worst first" that opens with a wall of dashes tells you
// nothing. Missing values therefore sink to the bottom in both directions,
// which no single comparator expression gives you for free.

import type { TokenEfficiency } from '@freellmapi/shared/types'
import { compareTokenEfficiency } from './token-efficiency'

export type SortKey =
  | 'name' | 'routes' | 'chains'
  | 'intelligenceIndex' | 'codingIndex' | 'agenticIndex'
  | 'capabilityFinance' | 'capabilityStrategyOps' | 'capabilityLegal' | 'capabilityHealthcare' | 'capabilityEngineering' | 'capabilityEconomics'
  | 'speed' | 'latency' | 'price' | 'context' | 'ourRank'
  | 'tokensPerTask'

export interface SortableEntry {
  name: string
  chains: string[]
  members: { contextWindow: number | null; intelligenceRank: number; platform?: string; modelId?: string }[]
  analysis: {
    medianOutputTokensPerSecond: number | null
    medianTimeToFirstTokenSeconds: number | null
    price1mOutput: number | null
    capabilities?: {
      finance: number | null; strategyOps: number | null; legal: number | null;
      healthcare: number | null; engineering: number | null; economics: number | null;
    }
  } | null
  /** The index columns sort on the printed score, typed or measured. */
  scores: Record<'intelligence' | 'coding' | 'agentic', { value: number | null }>
  /** Token efficiency, with the source it came from (ADR ARCH-20261020). */
  tokenEfficiency?: TokenEfficiency | null
}

/** The value a column sorts on; null means "nothing measured here". */
export function sortValue(entry: SortableEntry, key: SortKey): number | string | null {
  const a = entry.analysis
  switch (key) {
    case 'name': return entry.name.toLowerCase()
    case 'routes': return entry.members.length
    case 'chains': return entry.chains.length
    case 'intelligenceIndex': return entry.scores.intelligence.value
    case 'codingIndex': return entry.scores.coding.value
    case 'agenticIndex': return entry.scores.agentic.value
    case 'speed': return a?.medianOutputTokensPerSecond ?? null
    case 'latency': return a?.medianTimeToFirstTokenSeconds ?? null
    case 'price': return a?.price1mOutput ?? null
    case 'capabilityFinance': return a?.capabilities?.finance ?? null
    case 'capabilityStrategyOps': return a?.capabilities?.strategyOps ?? null
    case 'capabilityLegal': return a?.capabilities?.legal ?? null
    case 'capabilityHealthcare': return a?.capabilities?.healthcare ?? null
    case 'capabilityEngineering': return a?.capabilities?.engineering ?? null
    case 'capabilityEconomics': return a?.capabilities?.economics ?? null
    case 'context': {
      const max = entry.members.reduce((m, r) => Math.max(m, r.contextWindow ?? 0), 0)
      return max === 0 ? null : max
    }
    case 'ourRank': {
      // One number for the entry: the best rank any of its routes holds, since
      // that is the one routing would act on.
      const ranks = entry.members.map(m => m.intelligenceRank).filter(n => Number.isFinite(n))
      return ranks.length === 0 ? null : Math.min(...ranks)
    }
    // Token efficiency sorts within its own source, and the sources are never
    // mixed: an AA estimate and a screen token count are different measures on
    // different workloads. The full ordering lives in lib/token-efficiency,
    // and sortEntries uses it below.
    case 'tokensPerTask': return entry.tokenEfficiency?.tokensPerTask ?? null
  }
}

/**
 * Sort a copy of `entries`. Rows with no value for the column sink to the
 * bottom whichever way the arrow points, and ties break on name so the order is
 * stable between renders.
 */
export function sortEntries<T extends SortableEntry>(entries: readonly T[], key: SortKey, dir: 'asc' | 'desc'): T[] {
  const sign = dir === 'asc' ? 1 : -1
  return [...entries].sort((x, y) => {
    // Token efficiency is the one column whose order is not a plain number
    // comparison: the AA estimates and the screen token counts are different
    // measures on different workloads, so they are ordered by source first
    // (see lib/token-efficiency).
    if (key === 'tokensPerTask') {
      const cmp = compareTokenEfficiency(x.tokenEfficiency, y.tokenEfficiency, dir)
      return cmp === 0 ? x.name.localeCompare(y.name) : cmp
    }
    const a = sortValue(x, key)
    const b = sortValue(y, key)
    if (a == null && b == null) return x.name.localeCompare(y.name)
    if (a == null) return 1
    if (b == null) return -1
    const cmp = typeof a === 'string' && typeof b === 'string' ? a.localeCompare(b) : Number(a) - Number(b)
    return cmp === 0 ? x.name.localeCompare(y.name) : cmp * sign
  })
}

/**
 * Substring match for the Compare table.
 *
 * Searches everything the row can be recognised by, not just its label: the
 * provider and model id behind each route (so "groq" or "gpt-oss" find it), the
 * chains it serves, and the benchmark it is mapped to. A merged row hides its
 * route ids behind a tooltip, so a name-only search could not find a model by
 * the id the operator actually types.
 *
 * Every term must match somewhere, so terms narrow rather than widen.
 */
export function matchesCompareQuery(entry: {
  name: string
  chains: string[]
  members: readonly { platform?: string; modelId?: string }[]
  analysis?: { name: string; slug: string; creator: string | null } | null
}, query: string): boolean {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean)
  if (terms.length === 0) return true
  const hay = [
    entry.name,
    ...entry.chains,
    ...entry.members.flatMap(m => [m.platform ?? '', m.modelId ?? '']),
    entry.analysis?.name ?? '',
    entry.analysis?.slug ?? '',
    entry.analysis?.creator ?? '',
  ].join(' ').toLowerCase()
  return terms.every(t => hay.includes(t))
}
