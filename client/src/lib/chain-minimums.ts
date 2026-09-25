import { useSyncExternalStore } from 'react'
import { useQuery } from '@tanstack/react-query'
import { apiFetch } from '@/lib/api'
import { useExtensionEnabled } from '@/lib/use-extension'

// Operator-set AA minimums per chain, and the recommendation they imply.
// Recommendation only: nothing here changes chain membership or routing.
// The server stores the document and its revisions
// (server/src/services/chain-minimums.ts); evaluation happens here so the
// side panel can re-grade every visible row as a stepper moves, before save.

export const GRADED_CHAINS = ['Apex', 'Frontier', 'Workhorse', 'Default', 'Coding', 'Vision', 'Extra-Tier'] as const
export type GradedChain = typeof GRADED_CHAINS[number]
export type Metric = 'general' | 'coding' | 'agentic'
export const METRICS: readonly Metric[] = ['general', 'coding', 'agentic']

export interface ChainMinimums {
  general: number | null
  coding: number | null
  agentic: number | null
  acceptEstimated: boolean
}
export interface ChainMinimumsDoc {
  version: 1
  revision: number
  savedAt: string | null
  chains: Record<GradedChain, ChainMinimums>
}
export interface ChainRequirement { name: string; requiresTools: boolean; requiresVision: boolean; reserved: boolean }
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
  /** An operator-set proxy estimate, not an AA measurement. */
  estimated: boolean
  supportsTools: boolean
  supportsVision: boolean
}

interface CompareLike {
  supportsTools: boolean
  supportsVision: boolean
  analysis: { intelligenceIndex: number | null; codingIndex: number | null; agenticIndex: number | null } | null
  link: { source: 'auto' | 'manual' | 'proxy' } | null
}
export function scoreRowOf(r: CompareLike): ScoreRow {
  return {
    general: r.analysis?.intelligenceIndex ?? null,
    coding: r.analysis?.codingIndex ?? null,
    agentic: r.analysis?.agenticIndex ?? null,
    estimated: r.link?.source === 'proxy',
    supportsTools: r.supportsTools,
    supportsVision: r.supportsVision,
  }
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
  const shortfalls: Evaluation['shortfalls'] = []
  const unknown: Metric[] = []
  for (const metric of METRICS) {
    const min = mins[metric]
    if (min == null) continue
    const value = row[metric]
    // Unmeasured is not zero, and an estimate is not a measurement unless the
    // chain says it will take one.
    if (value == null || (row.estimated && !mins.acceptEstimated)) { unknown.push(metric); continue }
    if (value < min) shortfalls.push({ metric, value, min })
  }
  const status = missing.length > 0 ? 'structural' : shortfalls.length > 0 ? 'below' : unknown.length > 0 ? 'unknown' : 'fits'
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

interface ViewState { draft: ChainMinimumsDoc | null; compareAgainst: GradedChain | null; open: boolean }
const COMPARE_KEY = 'imperium.chainMinimums.compareAgainst'
function readCompare(): GradedChain | null {
  try {
    const v = localStorage.getItem(COMPARE_KEY)
    return (GRADED_CHAINS as readonly string[]).includes(v ?? '') ? v as GradedChain : null
  } catch { return null }
}
let state: ViewState = { draft: null, compareAgainst: readCompare(), open: false }
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
