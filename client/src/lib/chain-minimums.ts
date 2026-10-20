import { useSyncExternalStore } from 'react'
import { useQuery } from '@tanstack/react-query'
import { apiFetch } from '@/lib/api'
import { useExtensionEnabled } from '@/lib/use-extension'
import { isEstimate, type Scores } from '@/lib/score-provenance'

// Operator-set AA minimums per chain, and the recommendation they imply.
// Recommendation only: nothing here changes chain membership or routing.
// The server stores the document and its revisions
// (server/src/services/chain-minimums.ts); evaluation happens here so the
// side panel can re-grade every visible row as a stepper moves, before save.

export const GRADED_CHAINS = ['Apex', 'Frontier', 'Workhorse', 'Default', 'Coding', 'Vision', 'Extra-Tier', 'Fast-Lane'] as const
export type GradedChain = typeof GRADED_CHAINS[number]
export type Metric = 'general' | 'coding' | 'agentic'
export const METRICS: readonly Metric[] = ['general', 'coding', 'agentic']

export interface ChainMinimums {
  general: number | null
  coding: number | null
  agentic: number | null
  acceptEstimated: boolean
  /** Alternatives: the model needs every set minimum NOT listed here, plus at
   *  least ONE that is. Empty = every set minimum is required. */
  either: Metric[]
}
export interface ChainMinimumsDoc {
  version: 1
  revision: number
  savedAt: string | null
  chains: Record<GradedChain, ChainMinimums>
}
export interface ChainRequirement { name: string; requiresTools: boolean; requiresVision: boolean }
export interface ChainMinimumsPayload {
  doc: ChainMinimumsDoc
  requirements: ChainRequirement[]
  revisions: { revision: number; savedAt: string }[]
}

export function useChainMinimums() {
  return useQuery<ChainMinimumsPayload>({
    queryKey: ['chain-minimums'],
    queryFn: () => apiFetch('/api/chain-minimums'),
  })
}

/** The scores a recommendation reads. Capability only: price, free status and
 *  provider availability have no field here, so they cannot move a grade. */
export interface ScoreRow {
  general: number | null
  coding: number | null
  agentic: number | null
  /** Per metric: the score is an estimate (a related model's, or the
   *  operator's approximation), not a measurement or the operator's own test. */
  estimated: Record<Metric, boolean>
  supportsTools: boolean
  supportsVision: boolean
}

interface CompareLike {
  supportsTools: boolean
  supportsVision: boolean
  scores: Scores
}
export function scoreRowOf(r: CompareLike): ScoreRow {
  return {
    general: r.scores.intelligence.value,
    coding: r.scores.coding.value,
    agentic: r.scores.agentic.value,
    estimated: {
      general: isEstimate(r.scores.intelligence.provenance),
      coding: isEstimate(r.scores.coding.provenance),
      agentic: isEstimate(r.scores.agentic.provenance),
    },
    supportsTools: r.supportsTools,
    supportsVision: r.supportsVision,
  }
}

/** Some score on the row is an estimate. */
export function anyEstimated(row: ScoreRow): boolean {
  return METRICS.some(m => row.estimated[m])
}

export interface Evaluation {
  /** fits: every set minimum met. below: a measured score misses one.
   *  unknown: nothing missed, but a required score is not measured (or is an
   *  estimate the chain does not accept). structural: the chain needs tools or
   *  vision this model lacks - no score changes that. */
  status: 'fits' | 'below' | 'unknown' | 'structural'
  shortfalls: { metric: Metric; value: number; min: number }[]
  unknown: Metric[]
  missing: ('tools' | 'vision')[]
}

export function evaluate(row: ScoreRow, mins: ChainMinimums, req: Pick<ChainRequirement, 'requiresTools' | 'requiresVision'> | undefined): Evaluation {
  const missing: Evaluation['missing'] = []
  if (req?.requiresTools && !row.supportsTools) missing.push('tools')
  if (req?.requiresVision && !row.supportsVision) missing.push('vision')
  const either = new Set(mins.either)
  const shortfalls: Evaluation['shortfalls'] = []
  const unknown: Metric[] = []
  let below = false
  let open = false
  const group: { metric: Metric; result: 'pass' | 'below' | 'unknown'; value: number | null; min: number }[] = []
  for (const metric of METRICS) {
    const min = mins[metric]
    if (min == null) continue
    const value = row[metric]
    // Unmeasured is not zero, and an estimate is not a measurement unless the
    // chain says it will take one.
    const result = value == null || (row.estimated[metric] && !mins.acceptEstimated) ? 'unknown'
      : value < min ? 'below' : 'pass'
    if (either.has(metric)) { group.push({ metric, result, value, min }); continue }
    if (result === 'unknown') { unknown.push(metric); open = true }
    if (result === 'below') { shortfalls.push({ metric, value: value!, min }); below = true }
  }
  // One passing alternative clears the group. Otherwise every alternative is
  // reported, and the group is a miss only when all of them are measured below
  // — an unscored one could still carry it.
  if (group.length > 0 && !group.some(g => g.result === 'pass')) {
    for (const g of group) {
      if (g.result === 'unknown') unknown.push(g.metric)
      else shortfalls.push({ metric: g.metric, value: g.value!, min: g.min })
    }
    if (group.every(g => g.result === 'below')) below = true
    else open = true
  }
  const status = missing.length > 0 ? 'structural' : below ? 'below' : open ? 'unknown' : 'fits'
  return { status, shortfalls, unknown, missing }
}

/** How one score reads against one minimum, for highlighting a number. Null
 *  when there is no minimum on that metric or no score to compare. */
export function scoreTone(value: number | null | undefined, min: number | null | undefined): 'meets' | 'near' | 'below' | null {
  if (value == null || min == null) return null
  if (value >= min) return 'meets'
  return value >= min - 1 ? 'near' : 'below'
}

export const TONE_CLASS: Record<'meets' | 'near' | 'below', string> = {
  meets: 'text-emerald-700 dark:text-emerald-400 font-medium',
  near: 'text-amber-700 dark:text-amber-400',
  below: 'text-muted-foreground/60',
}

// ── Shared view state ───────────────────────────────────────────────────────
// The panel's unsaved draft, which chain scores are highlighted against, and
// whether the panel is open. One store so Compare, every Keys provider and the
// panel re-render together as a stepper moves.

/** minimums: the steppers. members: each chain's current members, read-only. */
export type PanelTab = 'minimums' | 'members'
interface ViewState { draft: ChainMinimumsDoc | null; compareAgainst: GradedChain | null; open: boolean; tab: PanelTab }
const COMPARE_KEY = 'imperium.chainMinimums.compareAgainst'
const TAB_KEY = 'imperium.chainMinimums.tab'
function readTab(): PanelTab {
  try { return localStorage.getItem(TAB_KEY) === 'members' ? 'members' : 'minimums' } catch { return 'minimums' }
}
function readCompare(): GradedChain | null {
  try {
    const v = localStorage.getItem(COMPARE_KEY)
    return (GRADED_CHAINS as readonly string[]).includes(v ?? '') ? v as GradedChain : null
  } catch { return null }
}
let state: ViewState = { draft: null, compareAgainst: readCompare(), open: false, tab: readTab() }
const listeners = new Set<() => void>()
function set(next: Partial<ViewState>) {
  state = { ...state, ...next }
  for (const l of listeners) l()
}
const subscribe = (l: () => void) => { listeners.add(l); return () => { listeners.delete(l) } }
const snapshot = () => state

export function useChainMinimumsView(): ViewState {
  return useSyncExternalStore(subscribe, snapshot, snapshot)
}
export function setDraft(draft: ChainMinimumsDoc | null) { set({ draft }) }
export function setPanelOpen(open: boolean) { set(open ? { open } : { open, draft: null }) }
export function setPanelTab(tab: PanelTab) {
  try { localStorage.setItem(TAB_KEY, tab) } catch { /* view state only */ }
  set({ tab })
}
export function setCompareAgainst(chain: GradedChain | null) {
  try { if (chain) localStorage.setItem(COMPARE_KEY, chain); else localStorage.removeItem(COMPARE_KEY) } catch { /* view state only */ }
  set({ compareAgainst: chain })
}

/** The minimums every surface should grade with right now: the panel's draft
 *  while it is being edited, otherwise the saved document. */
export function useEffectiveMinimums(): { doc: ChainMinimumsDoc | undefined; requirements: ChainRequirement[]; compareAgainst: GradedChain | null } {
  const { data } = useChainMinimums()
  const view = useChainMinimumsView()
  return { doc: view.draft ?? data?.doc, requirements: data?.requirements ?? [], compareAgainst: view.compareAgainst }
}

/** Class for a score against the chain chosen in the side panel, so numbers
 *  that clear its minimum stand out. Empty when nothing is being compared. */
export function useScoreTone(): (metric: Metric, value: number | null | undefined) => string {
  const enabled = useExtensionEnabled('chain-minimums')
  const { doc, compareAgainst } = useEffectiveMinimums()
  return (metric, value) => {
    if (!enabled || !doc || !compareAgainst) return ''
    const tone = scoreTone(value, doc.chains[compareAgainst][metric])
    return tone ? TONE_CLASS[tone] : ''
  }
}
