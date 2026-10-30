// Where a benchmark score came from (ADR ARCH-20261018). Every surface that
// prints a score reads its colour and note from here, so a typed number can
// never pass for a measurement on one screen while being labelled on another.

export type ScoreMetric = 'intelligence' | 'coding' | 'agentic'
export type EntryProvenance = 'family' | 'approximated' | 'tested'
export type ScoreProvenance = 'measured' | 'archived' | 'derived' | EntryProvenance

/** How a derived score was estimated (server services/aa-derive.ts). */
export interface ScoreEstimate {
  value: number
  basis: { kind: 'intelligence'; version: string } | { kind: 'capability'; capability: string }
  basisValue: number
  /** Models the line was fitted on. */
  n: number
  /** Typical miss on an unseen model, in index points. */
  error: number
  r: number
  /** The input is outside the range the line was fitted on. */
  extrapolated: boolean
  targetVersion: string | null
}

export interface ScoreCell {
  /** The number every table prints, sorts and grades on. */
  value: number | null
  /** Null exactly when `value` is. */
  provenance: ScoreProvenance | null
  /** The operator's typed score, kept even once a measurement supersedes it. */
  entry: { value: number; provenance: EntryProvenance; enteredAt: string; superseded: boolean } | null
  /** False when the value is a measurement: a typed score never replaces one. */
  editable: boolean
  /** AA index version and publication time, present only on AA-sourced cells. */
  version?: string | null
  asOf?: string | null
  /** Present when provenance is 'derived'. */
  estimate?: ScoreEstimate | null
}

export type Scores = Record<ScoreMetric, ScoreCell>

export const SCORE_METRICS: readonly ScoreMetric[] = ['intelligence', 'coding', 'agentic']
export const ENTRY_PROVENANCES: readonly EntryProvenance[] = ['family', 'approximated', 'tested']

/** Hues no other score marking on these surfaces uses: chain minimums take
 *  emerald and amber, fit and proxy deltas rose, baselines sky (D5). */
export const PROVENANCE_CLASS: Record<Exclude<ScoreProvenance, 'measured'>, string> = {
  tested: 'text-cyan-700 dark:text-cyan-400',
  family: 'text-indigo-600 dark:text-indigo-400',
  approximated: 'text-fuchsia-700 dark:text-fuchsia-400',
  archived: 'text-slate-600 dark:text-slate-400',
  derived: 'text-blue-700 dark:text-blue-400',
}

export const PROVENANCE_LABEL_KEY: Record<Exclude<ScoreProvenance, 'measured'>, string> = {
  tested: 'scoreProvenance.tested',
  family: 'scoreProvenance.family',
  approximated: 'scoreProvenance.approximated',
  archived: 'scoreProvenance.archived',
  derived: 'scoreProvenance.derived',
}

export const PROVENANCE_HELP_KEY: Record<EntryProvenance, string> = {
  tested: 'scoreProvenance.testedHelp',
  family: 'scoreProvenance.familyHelp',
  approximated: 'scoreProvenance.approximatedHelp',
}

/** Related family, approximated and derived are estimates; archived values
 *  retain the status of published measurements, and tested is an operator
 *  measurement. */
export function isEstimate(provenance: ScoreProvenance | null): boolean {
  return provenance === 'family' || provenance === 'approximated' || provenance === 'derived'
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
