import type { TokenUsageData } from './routing'

// One capacity segment per quota pool, ordered by its smartest member.
// Recorded spend is not subtracted: catalogue estimates and renewing daily
// allowances are not a measured monthly balance.

export type LegendModel = TokenUsageData['models'][number]

export interface LegendRow extends LegendModel {
  memberNames: string[]
  /** Share of the estimated capacity, counted once per pool. */
  widthPct: number
}

export interface BudgetLegend {
  /** Rows with a budget to show, smartest first. */
  rows: LegendRow[]
  /** Rows with no published quota, folded into the "+N" summary line. */
  unpublishedCount: number
}

/** Smartest first (rank 1 = smartest). Rows without a rank sort last, and the
 *  incoming order is kept as the tiebreaker so equal ranks stay stable. */
export function sortByIntelligence<T extends { intelligenceRank?: number }>(models: readonly T[]): T[] {
  const rank = (m: T) => (typeof m.intelligenceRank === 'number' && Number.isFinite(m.intelligenceRank)
    ? m.intelligenceRank
    : Number.POSITIVE_INFINITY)
  return models
    .map((m, i) => ({ m, i }))
    .sort((a, b) => rank(a.m) - rank(b.m) || a.i - b.i)
    .map(({ m }) => m)
}

export function buildBudgetLegend(models: readonly LegendModel[], totalBudget: number): BudgetLegend {
  const rows: LegendRow[] = []
  const byPool = new Map<string, LegendRow>()
  let unpublishedCount = 0
  for (const m of sortByIntelligence(models)) {
    if (m.poolBudget <= 0) {
      unpublishedCount += 1
      continue
    }
    const existing = byPool.get(m.poolKey)
    if (existing) {
      existing.memberNames.push(m.displayName)
      continue
    }
    const row: LegendRow = {
      ...m,
      budget: m.poolBudget,
      memberNames: [m.displayName],
      widthPct: totalBudget > 0 ? (m.poolBudget / totalBudget) * 100 : 0,
    }
    rows.push(row)
    byPool.set(m.poolKey, row)
  }
  return { rows, unpublishedCount }
}
