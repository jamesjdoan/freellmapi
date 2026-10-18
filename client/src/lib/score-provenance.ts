// Where a benchmark score came from (ADR ARCH-20261018). Every surface that
// prints a score reads its colour and note from here, so a typed number can
// never pass for a measurement on one screen while being labelled on another.

export type ScoreMetric = 'intelligence' | 'coding' | 'agentic'
export type EntryProvenance = 'family' | 'approximated' | 'tested'
export type ScoreProvenance = 'measured' | EntryProvenance

export interface ScoreCell {
  /** The number every table prints, sorts and grades on. */
  value: number | null
  /** Null exactly when `value` is. */
  provenance: ScoreProvenance | null
  /** The operator's typed score, kept even once a measurement supersedes it. */
  entry: { value: number; provenance: EntryProvenance; enteredAt: string; superseded: boolean } | null
  /** False when the value is a measurement: a typed score never replaces one. */
  editable: boolean
}

export type Scores = Record<ScoreMetric, ScoreCell>

export const SCORE_METRICS: readonly ScoreMetric[] = ['intelligence', 'coding', 'agentic']
export const ENTRY_PROVENANCES: readonly EntryProvenance[] = ['family', 'approximated', 'tested']

/** Hues no other score marking on these surfaces uses: chain minimums take
 *  emerald and amber, fit and proxy deltas rose, baselines sky (D5). */
export const PROVENANCE_CLASS: Record<EntryProvenance, string> = {
  tested: 'text-cyan-700 dark:text-cyan-400',
  family: 'text-indigo-600 dark:text-indigo-400',
  approximated: 'text-fuchsia-700 dark:text-fuchsia-400',
}

export const PROVENANCE_LABEL_KEY: Record<EntryProvenance, string> = {
  tested: 'scoreProvenance.tested',
  family: 'scoreProvenance.family',
  approximated: 'scoreProvenance.approximated',
}

export const PROVENANCE_HELP_KEY: Record<EntryProvenance, string> = {
  tested: 'scoreProvenance.testedHelp',
  family: 'scoreProvenance.familyHelp',
  approximated: 'scoreProvenance.approximatedHelp',
}

/** Related family and approximated are estimates; a test is the operator's own
 *  measurement and grades like one. */
export function isEstimate(provenance: ScoreProvenance | null): boolean {
  return provenance === 'family' || provenance === 'approximated'
}

/** The colour class for a score, or null for a measurement (and for nothing). */
export function provenanceClass(provenance: ScoreProvenance | null): string | null {
  return provenance == null || provenance === 'measured' ? null : PROVENANCE_CLASS[provenance]
}

/** A cell with no number and no say over it — for payloads from before scores existed. */
export const EMPTY_SCORES: Scores = {
  intelligence: { value: null, provenance: null, entry: null, editable: false },
  coding: { value: null, provenance: null, entry: null, editable: false },
  agentic: { value: null, provenance: null, entry: null, editable: false },
}
