import type { TokenEfficiency } from '@freellmapi/shared/types'

// Ordering for the token-efficiency column (ADR ARCH-20261020).
//
// The two sources are never compared with each other: an AA estimate and a
// screen token count are on different workloads (AA's long tasks against our
// six short ones), so putting them in one numeric order would be a fiction.
// AA comes first, then the screen figures, then the unknown ones — which
// sink to the bottom in both directions, like every other missing value on
// these tables.
//
// Within a source, ascending means MOST EFFICIENT FIRST (fewest tokens). AA
// sorts on its 3:1 blended estimate, the middle of the range it shows.

/** AA, then screen, then unknown. */
const SOURCE_ORDER: Record<TokenEfficiency['source'], number> = { aa: 0, screen: 1 }

export function tokenEfficiencySourceOrder(value: TokenEfficiency | null | undefined): number {
  if (!value) return 2
  return SOURCE_ORDER[value.source]
}

/**
 * The number a row sorts on within its source: tokens per task (the 3:1
 * estimate for AA, the measurement for the screen).
 */
export function tokenEfficiencyValue(value: TokenEfficiency | null | undefined): number | null {
  if (!value) return null
  return value.tokensPerTask
}

/**
 * Compare two rows by token efficiency.
 *
 * `dir` is 'asc' for most efficient first. The source order never flips: a
 * screen measurement is never ranked above an AA estimate, and an unknown
 * never rises above a measured one.
 */
export function compareTokenEfficiency(
  a: TokenEfficiency | null | undefined,
  b: TokenEfficiency | null | undefined,
  dir: 'asc' | 'desc',
): number {
  const sourceDiff = tokenEfficiencySourceOrder(a) - tokenEfficiencySourceOrder(b);
  if (sourceDiff !== 0) return sourceDiff;
  const av = tokenEfficiencyValue(a);
  const bv = tokenEfficiencyValue(b);
  if (av == null && bv == null) return 0;
  if (av == null) return 1;
  if (bv == null) return -1;
  const diff = av - bv;
  return dir === 'asc' ? diff : -diff;
}
