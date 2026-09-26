import { useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { SlidersHorizontal, X, Lock } from 'lucide-react'
import { apiFetch } from '@/lib/api'
import { Button } from '@/components/ui/button'
import { useI18n } from '@/i18n'
import { useExtensionEnabled } from '@/lib/use-extension'
import {
  GRADED_CHAINS, METRICS, evaluate, scoreRowOf, setCompareAgainst, setDraft, setPanelOpen, setPanelTab,
  useChainMinimums, useChainMinimumsView,
  type ChainMinimums, type ChainMinimumsDoc, type ChainRequirement, type Evaluation, type GradedChain, type Metric,
} from '@/lib/chain-minimums'
import { blockedReason } from '@/lib/route-blockers'

// The one place chain minimums are set. Docked, not modal: the point is to
// watch the Compare and Keys numbers re-grade while a stepper moves, so the
// page underneath has to stay visible and scrollable.

interface CompareRow {
  modelDbId: number
  platform: string
  modelId: string
  displayName: string
  enabled: boolean
  keyScope: 'none' | 'disabled' | 'unscoped' | 'in' | 'out'
  endpointScope?: string
  unlimited?: { flagged: boolean; effective: boolean }
  supportsTools: boolean
  supportsVision: boolean
  chains: string[]
  /** Priority in each of `chains`, same order. */
  chainRanks: number[]
  analysis: { slug: string; name: string; intelligenceIndex: number | null; codingIndex: number | null; agenticIndex: number | null } | null
  link: { source: 'auto' | 'manual' | 'proxy' } | null
}

const METRIC_FIELD: Record<Metric, 'intelligenceIndex' | 'codingIndex' | 'agenticIndex'> = {
  general: 'intelligenceIndex', coding: 'codingIndex', agentic: 'agenticIndex',
}
// Where a metric starts when switched on: the middle of the draft audit's
// bands, so it lands somewhere meaningful rather than at zero.
const ENABLE_AT: Record<Metric, number> = { general: 25, coding: 45, agentic: 30 }

export function ChainMinimumsButton() {
  const { t } = useI18n()
  if (!useExtensionEnabled('chain-minimums')) return null
  return (
    <Button size="sm" variant="outline" onClick={() => setPanelOpen(true)}>
      <SlidersHorizontal className="size-3.5" />
      {t('chainMinimums.open')}
    </Button>
  )
}

export function ChainMinimumsPanel() {
  const enabled = useExtensionEnabled('chain-minimums')
  const view = useChainMinimumsView()
  if (!enabled || !view.open) return null
  return <PanelBody />
}

function PanelBody() {
  const { t } = useI18n()
  const queryClient = useQueryClient()
  const view = useChainMinimumsView()
  const { data } = useChainMinimums()
  const { data: compare } = useQuery<{ rows: CompareRow[] }>({
    queryKey: ['analysis', 'compare'],
    queryFn: () => apiFetch('/api/analysis/compare'),
  })
  const saved = data?.doc
  // No draft until the first edit: until then the saved document IS the draft.
  const draft = view.draft ?? saved
  const dirty = !!(saved && view.draft && JSON.stringify(saved.chains) !== JSON.stringify(view.draft.chains))
  const [conflict, setConflict] = useState<string | null>(null)

  const save = useMutation({
    mutationFn: (doc: ChainMinimumsDoc) => apiFetch<{ doc: ChainMinimumsDoc }>('/api/chain-minimums', {
      method: 'PUT', body: JSON.stringify({ expectedRevision: doc.revision, chains: doc.chains }),
    }),
    onSuccess: ({ doc }) => {
      setConflict(null)
      // Saved becomes the new baseline at once, so Save greys out without
      // waiting for a refetch; the refetch then brings the revision list.
      queryClient.setQueryData(['chain-minimums'], (prev: { doc: ChainMinimumsDoc } | undefined) => prev && { ...prev, doc })
      setDraft(null)
      queryClient.invalidateQueries({ queryKey: ['chain-minimums'] })
    },
    onError: (err: Error) => setConflict(err.message),
  })

  // One entry per AA model, so a model on six providers counts once and every
  // route of it grades the same.
  const canonical = useMemo(() => {
    const bySlug = new Map<string, { name: string; row: CompareRow }>()
    for (const r of compare?.rows ?? []) {
      if (r.analysis && !bySlug.has(r.analysis.slug)) bySlug.set(r.analysis.slug, { name: r.analysis.name, row: r })
    }
    return [...bySlug.values()]
  }, [compare?.rows])

  if (!draft) return null
  const req = (chain: GradedChain) => data?.requirements.find(r => r.name === chain)
  const update = (chain: GradedChain, patch: Partial<ChainMinimums>) =>
    setDraft({ ...draft, chains: { ...draft.chains, [chain]: { ...draft.chains[chain], ...patch } } })

  return (
    <aside
      aria-label={t('chainMinimums.title')}
      className="fixed right-4 top-16 bottom-4 z-40 flex w-[380px] flex-col rounded-2xl border bg-card shadow-xl"
    >
      <header className="flex items-start justify-between gap-2 border-b p-3">
        <div>
          <h2 className="text-sm font-semibold">{t(view.tab === 'members' ? 'chainMinimums.membersTitle' : 'chainMinimums.title')}</h2>
          <p className="text-[11px] text-muted-foreground">
            {view.tab === 'members'
              ? t('chainMinimums.membersHint')
              : draft.revision === 0
                ? t('chainMinimums.neverSaved')
                : t('chainMinimums.revision', { revision: draft.revision, when: new Date(draft.savedAt ?? '').toLocaleString() })}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {/* Swaps the panel's body; the minimums draft survives the swap. */}
          <div role="tablist" aria-label={t('chainMinimums.tabs')} className="flex rounded-md border p-0.5 text-[11px]">
            {(['minimums', 'members'] as const).map(tab => (
              <button
                key={tab}
                type="button"
                role="tab"
                aria-selected={view.tab === tab}
                onClick={() => setPanelTab(tab)}
                className={`rounded px-2 py-0.5 ${view.tab === tab ? 'bg-muted font-medium' : 'text-muted-foreground hover:text-foreground'}`}
              >
                {t(tab === 'members' ? 'chainMinimums.tabMembers' : 'chainMinimums.tabMinimums')}
              </button>
            ))}
          </div>
          <button type="button" onClick={() => setPanelOpen(false)} aria-label={t('chainMinimums.close')} className="rounded-md p-1 hover:bg-muted">
            <X className="size-4" />
          </button>
        </div>
      </header>

      {view.tab === 'members' ? (
        <MembersView rows={compare?.rows ?? []} draft={draft} requirement={req} />
      ) : (
      <>

      <div className="border-b px-3 py-2 text-[11px] text-muted-foreground">
        <label className="flex items-center gap-2">
          {t('chainMinimums.compareAgainst')}
          <select
            value={view.compareAgainst ?? ''}
            onChange={e => setCompareAgainst((e.target.value || null) as GradedChain | null)}
            className="h-7 rounded-md border bg-background px-1.5 text-xs text-foreground"
          >
            <option value="">{t('chainMinimums.compareNone')}</option>
            {GRADED_CHAINS.map(c => <option key={c} value={c}>{c}</option>)}
          </select>
        </label>
        <p className="mt-1">{t('chainMinimums.recommendOnly')}</p>
      </div>

      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-3">
        {GRADED_CHAINS.map(chain => {
          const mins = draft.chains[chain]
          const results = canonical.map(c => ({ ...c, e: evaluate(scoreRowOf(c.row), mins, req(chain)) }))
          const qualify = results.filter(r => r.e.status === 'fits').length
          const members = (compare?.rows ?? []).filter(r => r.chains.includes(chain))
          const membersPass = members.filter(r => evaluate(scoreRowOf(r), mins, req(chain)).status === 'fits').length
          // The line itself, on the first metric this chain sets: the closest
          // model that clears it and the closest that does not.
          const metric = METRICS.find(m => mins[m] != null)
          const line = metric ? (() => {
            const min = mins[metric]!
            const scored = canonical
              .map(c => ({ name: c.name, v: c.row.analysis![METRIC_FIELD[metric]] }))
              .filter((x): x is { name: string; v: number } => x.v != null)
            const above = scored.filter(x => x.v >= min).sort((a, b) => a.v - b.v)[0]
            const below = scored.filter(x => x.v < min).sort((a, b) => b.v - a.v)[0]
            return { above, below }
          })() : null
          const active = view.compareAgainst === chain
          return (
            <section key={chain} className={`rounded-xl border p-2.5 ${active ? 'border-primary/60 bg-primary/5' : ''}`}>
              <div className="flex items-center justify-between">
                <button type="button" onClick={() => setCompareAgainst(active ? null : chain)} className="text-xs font-semibold hover:underline" title={t('chainMinimums.highlightHint')}>
                  {chain}
                </button>
                <span className="text-[10px] tabular-nums text-muted-foreground">
                  {t('chainMinimums.counts', { qualify, pass: membersPass, members: members.length })}
                </span>
              </div>
              <div className="mt-2 space-y-1.5">
                {METRICS.map(m => (
                  <Stepper
                    key={m}
                    label={t(`chainMinimums.metric_${m}`)}
                    value={mins[m]}
                    onChange={v => update(chain, { [m]: v })}
                    enableAt={ENABLE_AT[m]}
                  />
                ))}
              </div>
              <label className="mt-2 flex items-center gap-1.5 text-[10px] text-muted-foreground">
                <input type="checkbox" checked={mins.acceptEstimated} onChange={e => update(chain, { acceptEstimated: e.target.checked })} className="size-3 accent-primary" />
                {t('chainMinimums.acceptEstimated')}
              </label>
              {(req(chain)?.requiresTools || req(chain)?.requiresVision) && (
                <p className="mt-1 text-[10px] text-muted-foreground">
                  {[req(chain)?.requiresTools && t('chainMinimums.needsTools'), req(chain)?.requiresVision && t('chainMinimums.needsVision')].filter(Boolean).join(' · ')}
                </p>
              )}
              {line && (line.above || line.below) && (
                <p className="mt-1 text-[10px] tabular-nums text-muted-foreground">
                  {line.above && <span className="text-emerald-700 dark:text-emerald-400">↑ {line.above.name} {line.above.v.toFixed(1)}</span>}
                  {line.above && line.below && ' · '}
                  {line.below && <span>↓ {line.below.name} {line.below.v.toFixed(1)}</span>}
                </p>
              )}
            </section>
          )
        })}
        <section className="flex items-center gap-2 rounded-xl border border-dashed p-2.5 text-[11px] text-muted-foreground">
          <Lock className="size-3.5" />
          {t('chainMinimums.fastLaneReserved')}
        </section>
      </div>

      <footer className="space-y-2 border-t p-3">
        {conflict && <p className="text-[11px] text-destructive">{conflict}</p>}
        <div className="flex justify-end gap-2">
          <Button size="sm" variant="outline" disabled={!dirty || save.isPending} onClick={() => setDraft(null)}>
            {t('chainMinimums.reset')}
          </Button>
          <Button size="sm" disabled={!dirty || save.isPending} onClick={() => save.mutate(draft)}>
            {save.isPending ? t('common.saving') : t('common.save')}
          </Button>
        </div>
      </footer>
      </>
      )}
    </aside>
  )
}

// The chains as they stand: enabled members in the order the router tries
// them. An effective unlimited model goes first in every chain it is in
// (router.ts unlimitedFirst), then chain priority. Health, cooldowns and quota
// can still skip a member at request time; this is the order, not a promise.
const MEMBER_CHAINS = [...GRADED_CHAINS, 'Fast-Lane'] as const
const FIT_CLASS: Record<Evaluation['status'], string> = {
  fits: 'text-emerald-700 dark:text-emerald-400',
  below: 'text-rose-700 dark:text-rose-400',
  unknown: 'text-muted-foreground',
  structural: 'text-amber-700 dark:text-amber-400',
}

function providerOf(r: CompareRow): string {
  if (r.platform !== 'custom' || !r.endpointScope) return r.platform
  try { return new URL(r.endpointScope).host } catch { return r.endpointScope }
}

function MembersView({ rows, draft, requirement }: {
  rows: CompareRow[]
  draft: ChainMinimumsDoc
  requirement: (chain: GradedChain) => ChainRequirement | undefined
}) {
  const { t } = useI18n()
  // "unknown" covers two cases: no AA score at all, or a proxy estimate the
  // chain does not accept. A row showing a number must not read "unscored".
  const fitLabel = (e: Evaluation, estimated: boolean) =>
    e.status === 'fits' ? '✓'
    : e.status === 'below' ? t('chainMinimums.fitBelow')
    : e.status === 'unknown' ? t(estimated ? 'chainMinimums.fitEstimated' : 'chainMinimums.fitUnknown')
    : e.missing.includes('tools') ? t('chainMinimums.fitNoTools') : t('chainMinimums.fitNoVision')

  return (
    <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-3">
      {MEMBER_CHAINS.map(chain => {
        const graded = (GRADED_CHAINS as readonly string[]).includes(chain) ? chain as GradedChain : null
        const members = rows
          .filter(r => r.chains.includes(chain))
          .map(r => ({ r, rank: r.chainRanks[r.chains.indexOf(chain)] ?? 0 }))
          .sort((a, b) => Number(!a.r.unlimited?.effective) - Number(!b.r.unlimited?.effective) || a.rank - b.rank)
        const rated = members.map(m => ({ ...m, e: graded ? evaluate(scoreRowOf(m.r), draft.chains[graded], requirement(graded)) : null }))
        const fits = rated.filter(m => m.e?.status === 'fits').length
        return (
          <section key={chain} className="rounded-xl border p-2.5">
            <div className="flex items-center justify-between">
              <span className="text-xs font-semibold">{chain}</span>
              <span className="text-[10px] tabular-nums text-muted-foreground">
                {graded ? t('chainMinimums.membersCount', { count: members.length, fits }) : t('chainMinimums.fastLaneReserved')}
              </span>
            </div>
            {members.length === 0 ? (
              <p className="mt-1.5 text-[11px] text-muted-foreground">{t('chainMinimums.membersEmpty')}</p>
            ) : (
              <ol className="mt-1.5 space-y-0.5">
                {rated.map(({ r, e }, i) => {
                  const why = blockedReason(r)
                  return (
                    <li key={r.modelDbId} className={`flex items-baseline gap-1.5 text-[11px] ${why ? 'opacity-50' : ''}`}>
                      <span className="w-4 shrink-0 text-right tabular-nums text-muted-foreground">{i + 1}</span>
                      <span className="min-w-0 flex-1 truncate" title={`${r.displayName} · ${r.modelId}`}>
                        {r.unlimited?.effective && <span className="mr-0.5 text-emerald-700 dark:text-emerald-400" title={t('keys.unlimitedEffective')}>∞</span>}
                        {r.displayName}
                        <span className="ml-1 text-muted-foreground">{providerOf(r)}</span>
                      </span>
                      {why && <span className="shrink-0 text-[10px] text-muted-foreground">{t(`keys.${why}`)}</span>}
                      <span className="shrink-0 tabular-nums text-muted-foreground">{r.analysis?.intelligenceIndex?.toFixed(1) ?? '–'}</span>
                      {e && <span className={`w-14 shrink-0 text-right text-[10px] ${FIT_CLASS[e.status]}`}>{fitLabel(e, scoreRowOf(r).estimated)}</span>}
                    </li>
                  )
                })}
              </ol>
            )}
          </section>
        )
      })}
    </div>
  )
}

function Stepper({ label, value, onChange, enableAt }: {
  label: string
  value: number | null
  onChange: (v: number | null) => void
  enableAt: number
}) {
  const { t } = useI18n()
  const clamp = (v: number) => Math.max(0, Math.min(100, Math.round(v * 10) / 10))
  const step = (e: React.MouseEvent, dir: 1 | -1) => onChange(clamp((value ?? enableAt) + dir * (e.shiftKey ? 5 : 1)))
  return (
    <div className="flex items-center gap-1.5 text-[11px]">
      <span className="w-16 text-muted-foreground">{label}</span>
      {value == null ? (
        <button type="button" onClick={() => onChange(enableAt)} className="rounded-md border border-dashed px-2 py-0.5 text-[10px] text-muted-foreground hover:bg-muted">
          {t('chainMinimums.off')}
        </button>
      ) : (
        <>
          <button type="button" onClick={e => step(e, -1)} className="size-6 rounded-md border hover:bg-muted" aria-label={`${label} −`} title={t('chainMinimums.shiftHint')}>−</button>
          <input
            type="number"
            min={0}
            max={100}
            step={1}
            value={value}
            onChange={e => e.target.value !== '' && onChange(clamp(Number(e.target.value)))}
            className="h-6 w-14 rounded-md border bg-background px-1 text-center tabular-nums"
            aria-label={label}
          />
          <button type="button" onClick={e => step(e, 1)} className="size-6 rounded-md border hover:bg-muted" aria-label={`${label} +`} title={t('chainMinimums.shiftHint')}>+</button>
          <button type="button" onClick={() => onChange(null)} className="ml-auto text-[10px] text-muted-foreground hover:text-foreground" title={t('chainMinimums.turnOff')}>
            {t('chainMinimums.turnOffShort')}
          </button>
        </>
      )}
    </div>
  )
}
