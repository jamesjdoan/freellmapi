import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ChevronDown, History, ListOrdered, Pin } from 'lucide-react'
import { useI18n } from '@/i18n'
import { apiFetch, type ApiError } from '@/lib/api'
import { formatStamp } from '@/lib/stamp'
import { openExtensions } from '@/lib/extensions'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import { Tooltip } from '@/components/tooltip'
import { ArrangePreviewDialog } from '@/components/chain-arrange-preview'
import { RunHistoryDialog } from '@/components/chain-arrange-runs'
import {
  chainArrangePaths,
  effectiveChainSettings,
  type ArrangePlan,
  type ArrangeSettingsDoc,
  type ChainArrangeOverview,
} from '@/lib/chain-arrange'

// Auto-arrange (ARCH-20261026). The arranger rewrites each chain's stored
// order from measured evidence; this panel is its dashboard surface, beside
// the chain manager on the Fallback page: extension gates, the tolerance
// band, per-chain depth floors and pins, and what the last passes did.
//
// Every write here is compare-and-set on the settings revision (like
// chain-minimums): the panel holds a draft until Save, and a 409
// revision_conflict refetches and tells the operator instead of failing
// silently.

const COLLAPSED_KEY = 'freellmapi.chainArrange.collapsed'

function readCollapsed(): boolean {
  let stored: string | null = null
  try {
    stored = localStorage.getItem(COLLAPSED_KEY)
  } catch {
    /* ignore */
  }
  return stored === null ? true : stored === '1'
}

/** Pending edits across the whole document, until Save. */
interface ArrangeDraft {
  tolerancePct: number
  chains: Record<string, { auto: boolean; minMembers: number; minPools: number }>
}

export function ChainArrangePanel() {
  const { t } = useI18n()
  const queryClient = useQueryClient()
  const [collapsed, setCollapsed] = useState<boolean>(readCollapsed)
  const [draft, setDraft] = useState<ArrangeDraft | null>(null)
  const [error, setError] = useState('')
  const [previewChain, setPreviewChain] = useState<string | null>(null)
  const [runsChain, setRunsChain] = useState<string | null>(null)
  const [written, setWritten] = useState<{ chain: string; plan: ArrangePlan } | null>(null)

  const { data: overview, isPending } = useQuery<ChainArrangeOverview>({
    queryKey: ['chain-arrange', 'overview'],
    queryFn: () => apiFetch(chainArrangePaths.overview),
  })

  const doc = overview?.settings
  const extensions = overview?.extensions

  // One entry per chain the operator touched, so Save sends a coherent
  // document. A chain absent from the saved doc IS its defaults.
  function editChain(chain: string, patch: Partial<{ auto: boolean; minMembers: number; minPools: number }>) {
    setDraft(prev => {
      const base: ArrangeDraft = prev ?? {
        tolerancePct: doc?.tolerancePct ?? 10,
        chains: {},
      }
      const current = doc ? effectiveChainSettings(doc, chain) : { auto: true, minMembers: 0, minPools: 0, pins: [] }
      const existing = prev?.chains[chain] ?? { auto: current.auto, minMembers: current.minMembers, minPools: current.minPools }
      return { ...base, chains: { ...base.chains, [chain]: { ...existing, ...patch } } }
    })
  }

  // Someone else wrote settings between our read and our write. Re-read and
  // say so: the draft survives, and the next Save lands on the current
  // revision.
  async function handleConflict(err: ApiError) {
    if (err.code === 'revision_conflict') {
      await queryClient.refetchQueries({ queryKey: ['chain-arrange', 'overview'], exact: true })
      setError(t('chainArrange.conflict'))
    } else {
      setError(err.message || t('chainArrange.saveFailed'))
    }
  }

  const save = useMutation({
    mutationFn: () => {
      if (!doc || !draft) throw new Error(t('chainArrange.saveFailed'))
      const chains: Record<string, ArrangeSettingsDoc['chains'][string]> = { ...doc.chains }
      for (const [chain, edit] of Object.entries(draft.chains)) {
        chains[chain] = { ...effectiveChainSettings(doc, chain), ...edit }
      }
      return apiFetch<{ settings: ArrangeSettingsDoc }>(chainArrangePaths.overview, {
        method: 'PUT',
        body: JSON.stringify({
          expectedRevision: doc.revision,
          tolerancePct: draft.tolerancePct,
          chains,
        }),
      })
    },
    onSuccess: ({ settings }) => {
      setError('')
      setDraft(null)
      queryClient.setQueryData<ChainArrangeOverview>(['chain-arrange', 'overview'], prev =>
        prev ? { ...prev, settings } : prev)
      // Order-affecting write: the Fallback table and the arrange views re-read.
      queryClient.invalidateQueries({ queryKey: ['chain-arrange'] })
      queryClient.invalidateQueries({ queryKey: ['fallback'] })
    },
    onError: (err: ApiError) => { void handleConflict(err) },
  })

  const runNow = useMutation({
    mutationFn: (chain: string) =>
      apiFetch<{ plan: ArrangePlan; runId: number | null; changed: boolean }>(chainArrangePaths.run, {
        method: 'POST',
        body: JSON.stringify({ chain }),
      }),
    onSuccess: ({ plan }, chain) => {
      setError('')
      queryClient.invalidateQueries({ queryKey: ['chain-arrange'] })
      queryClient.invalidateQueries({ queryKey: ['fallback'] })
      setWritten({ chain, plan })
    },
    onError: (err: ApiError) => setError(err.message || t('chainArrange.runFailed')),
  })

  function toggle() {
    setCollapsed(prev => {
      const next = !prev
      try { localStorage.setItem(COLLAPSED_KEY, next ? '1' : '0') } catch { /* ignore */ }
      return next
    })
  }

  const dirty = !!draft
  const arrangeOn = extensions?.arrange ?? true
  const probeOn = extensions?.probe ?? true

  return (
    <section className="rounded-lg border bg-card">
      <button
        type="button"
        onClick={toggle}
        aria-expanded={!collapsed}
        aria-label={collapsed ? t('common.show') : t('common.hide')}
        className={`flex w-full flex-wrap items-center justify-between gap-2 px-4 py-3 text-left ${collapsed ? '' : 'border-b'}`}
      >
        <div className="flex items-center gap-2">
          <ListOrdered className="size-4 text-muted-foreground" />
          <div>
            <h2 className="text-sm font-medium">{t('chainArrange.title')}</h2>
            <p className="text-xs text-muted-foreground">{t('chainArrange.description')}</p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Tooltip text={t(arrangeOn ? 'chainArrange.arrangeOn' : 'chainArrange.arrangeOff')}>
            <span className={`rounded-full px-2 py-0.5 text-[11px] ${arrangeOn ? 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-400' : 'bg-amber-500/10 text-amber-700 dark:text-amber-400'}`}>
              {t(arrangeOn ? 'chainArrange.arrangeOn' : 'chainArrange.arrangeOff')}
            </span>
          </Tooltip>
          <Tooltip text={t(probeOn ? 'chainArrange.probeOn' : 'chainArrange.probeOff')}>
            <span className={`rounded-full px-2 py-0.5 text-[11px] ${probeOn ? 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-400' : 'bg-amber-500/10 text-amber-700 dark:text-amber-400'}`}>
              {t(probeOn ? 'chainArrange.probeOn' : 'chainArrange.probeOff')}
            </span>
          </Tooltip>
          <ChevronDown className={`size-4 text-muted-foreground transition-transform ${collapsed ? '-rotate-90' : ''}`} />
        </div>
      </button>

      {!collapsed && (
        <div className="p-4">
          {isPending && <p className="text-xs text-muted-foreground">{t('common.loading')}</p>}
          {overview && (
            <>
              {/* Two gates, stated plainly: neither arranges nor probes when
                  off, and the Extensions dialog is where that is fixed. */}
              {(!arrangeOn || !probeOn) && (
                <div className="mb-3 flex flex-wrap items-center gap-2 rounded-xl border border-amber-500/40 bg-amber-500/5 px-3 py-2 text-xs text-amber-800 dark:text-amber-300">
                  <Pin className="size-3.5" />
                  <span>{t('chainArrange.gatedHint')}</span>
                  <Button variant="outline" size="xs" onClick={openExtensions}>
                    {t('chainArrange.openExtensions')}
                  </Button>
                </div>
              )}

              <div className="flex flex-wrap items-end gap-2">
                <label className="flex items-center gap-2 text-xs text-muted-foreground">
                  <span>{t('chainArrange.toleranceLabel')}</span>
                  <Tooltip text={t('chainArrange.toleranceHint')}>
                    <span className="cursor-help underline decoration-dotted underline-offset-2">?</span>
                  </Tooltip>
                  <Input
                    type="number"
                    min={0}
                    max={50}
                    value={draft?.tolerancePct ?? doc?.tolerancePct ?? 10}
                    onChange={e => {
                      const value = Number(e.target.value)
                      setDraft(prev => {
                        const base: ArrangeDraft = prev ?? { tolerancePct: doc?.tolerancePct ?? 10, chains: {} }
                        return { ...base, tolerancePct: Number.isFinite(value) ? value : 0 }
                      })
                    }}
                    aria-label={t('chainArrange.toleranceLabel')}
                    className="h-7 w-16 text-sm"
                  />
                </label>
                <Button size="sm" variant="secondary" disabled={!dirty || save.isPending} onClick={() => save.mutate()}>
                  {save.isPending ? t('common.saving') : t('common.save')}
                </Button>
                <span className="text-[11px] text-muted-foreground">
                  {doc
                    ? doc.revision === 0
                      ? t('chainArrange.neverSaved')
                      : t('chainArrange.revision', {
                          revision: doc.revision,
                          when: doc.savedAt ? formatStamp(new Date(doc.savedAt), { time: true }) : '—',
                        })
                    : null}
                </span>
              </div>

              <div className="mt-3 space-y-2">
                {overview.chains.map(({ chain, lastRun }) => {
                  const settings = effectiveChainSettings(doc, chain)
                  const edited = draft?.chains[chain]
                  return (
                    <div key={chain} className="rounded-xl border px-3 py-2">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="text-sm font-medium">{chain}</span>
                        <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
                          <Switch
                            size="sm"
                            checked={edited?.auto ?? settings.auto}
                            onCheckedChange={on => editChain(chain, { auto: on })}
                            aria-label={t('chainArrange.chainAuto', { chain })}
                          />
                          {t('chainArrange.chainAutoLabel')}
                        </label>
                        <Tooltip text={t('chainArrange.minMembersHint')}>
                          <label className="flex items-center gap-1 text-xs text-muted-foreground">
                            {t('chainArrange.minMembersLabel')}
                            <Input
                              type="number"
                              min={0}
                              value={edited?.minMembers ?? settings.minMembers}
                              onChange={e => editChain(chain, { minMembers: Math.max(0, Number(e.target.value) || 0) })}
                              aria-label={t('chainArrange.minMembersLabel')}
                              className="h-7 w-16 text-sm"
                            />
                          </label>
                        </Tooltip>
                        <Tooltip text={t('chainArrange.minPoolsHint')}>
                          <label className="flex items-center gap-1 text-xs text-muted-foreground">
                            {t('chainArrange.minPoolsLabel')}
                            <Input
                              type="number"
                              min={0}
                              value={edited?.minPools ?? settings.minPools}
                              onChange={e => editChain(chain, { minPools: Math.max(0, Number(e.target.value) || 0) })}
                              aria-label={t('chainArrange.minPoolsLabel')}
                              className="h-7 w-16 text-sm"
                            />
                          </label>
                        </Tooltip>
                        <span className="flex-1" />
                        <span className="text-[11px] text-muted-foreground tabular-nums">
                          {lastRun
                            ? t('chainArrange.lastRun', {
                                when: formatStamp(new Date(lastRun.ranAtMs), { time: true }),
                                trigger: t(lastRun.trigger === 'manual' ? 'chainArrange.triggerManual' : 'chainArrange.triggerSchedule'),
                                moved: lastRun.moved,
                              })
                            : t('chainArrange.lastRunNone')}
                        </span>
                        <Tooltip text={t('chainArrange.previewHint')}>
                          <Button variant="outline" size="xs" onClick={() => setPreviewChain(chain)}>
                            {t('chainArrange.preview')}
                          </Button>
                        </Tooltip>
                        <Tooltip text={t('chainArrange.arrangeNowHint')}>
                          <Button
                            variant="outline"
                            size="xs"
                            disabled={!arrangeOn || runNow.isPending}
                            onClick={() => runNow.mutate(chain)}
                          >
                            {t('chainArrange.arrangeNow')}
                          </Button>
                        </Tooltip>
                        <Tooltip text={t('chainArrange.runsOpen')}>
                          <Button
                            variant="ghost"
                            size="xs"
                            className="px-2 text-muted-foreground"
                            aria-label={t('chainArrange.runsOpen')}
                            onClick={() => setRunsChain(chain)}
                          >
                            <History className="size-3.5" />
                          </Button>
                        </Tooltip>
                      </div>
                    </div>
                  )
                })}
              </div>

              {error && <p className="mt-2 text-xs text-rose-600 dark:text-rose-400">{error}</p>}
              <p className="mt-3 text-[11px] text-muted-foreground">{t('chainArrange.footer')}</p>
            </>
          )}
        </div>
      )}

      {previewChain && (
        <ArrangePreviewDialog
          chain={previewChain}
          open
          onClose={() => setPreviewChain(null)}
        />
      )}
      {written && (
        <ArrangePreviewDialog
          chain={written.chain}
          written={written.plan}
          ranAt={written.plan.computedAtMs}
          open
          onClose={() => setWritten(null)}
        />
      )}
      {runsChain && (
        <RunHistoryDialog chain={runsChain} open onClose={() => setRunsChain(null)} />
      )}
    </section>
  )
}
