import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ArrowDown, ArrowUp, ChevronDown, Pin, PinOff } from 'lucide-react'
import { useI18n } from '@/i18n'
import { apiFetch, type ApiError } from '@/lib/api'
import { formatStamp } from '@/lib/stamp'
import { Tooltip } from '@/components/tooltip'
import { Dialog, DialogPopup, DialogTitle, DialogDescription } from '@/components/ui/dialog'
import {
  chainArrangePaths,
  effectiveChainSettings,
  endpointHandle,
  routePinKey,
  type ArrangeChainSettings,
  type ArrangeEntry,
  type ArrangePlan,
  type ArrangeSettingsDoc,
  type ChainArrangeOverview,
} from '@/lib/chain-arrange'

// The ArrangePlan table (ARCH-20261026): what a pass would do, one row per
// route. Read-only for a run's revision; from the preview dialog every row
// also offers Pin here / Unpin, which writes settings and re-previews.

// Full literal keys, not template strings: the i18n key-presence check reads
// this file as text, and a gap it cannot see is a gap it cannot gate.
const ELIGIBILITY_KEYS = {
  fit: 'chainArrange.eligibility_fit',
  near: 'chainArrange.eligibility_near',
  filler: 'chainArrange.eligibility_filler',
  out: 'chainArrange.eligibility_out',
} as const

const TIER_KEYS = {
  proven: 'chainArrange.tier_proven',
  partial: 'chainArrange.tier_partial',
  unmeasured: 'chainArrange.tier_unmeasured',
  failing: 'chainArrange.tier_failing',
} as const

const METRIC_KEYS = {
  intelligence: 'chainArrange.metric_intelligence',
  coding: 'chainArrange.metric_coding',
  latency: 'chainArrange.metric_latency',
  reliability: 'chainArrange.metric_reliability',
} as const

interface ArrangePreviewTableProps {
  entries: ArrangeEntry[]
  /** Absent for a run detail, which carries no depth snapshot. */
  depth?: ArrangePlan['depth'] | null
  /** Run revisions are history: nothing on a row is actionable there. */
  readOnly?: boolean
  saving?: boolean
  onPin?: (entry: ArrangeEntry) => void
  onUnpin?: (entry: ArrangeEntry) => void
}

export function ArrangePreviewTable({ entries, depth, readOnly, saving, onPin, onUnpin }: ArrangePreviewTableProps) {
  const { t } = useI18n()
  const [expanded, setExpanded] = useState<Set<string>>(new Set())

  const toggle = (key: string) =>
    setExpanded(prev => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })

  return (
    <div>
      {depth && (
        <p className="mb-2 text-xs text-muted-foreground tabular-nums">
          {t('chainArrange.depth', {
            eligible: depth.eligible,
            required: depth.required,
            pools: depth.pools,
            requiredPools: depth.requiredPools,
          })}{' '}
          <span className={depth.satisfied ? 'text-emerald-700 dark:text-emerald-400' : 'text-amber-700 dark:text-amber-400'}>
            {depth.satisfied ? t('chainArrange.depthOk') : t('chainArrange.depthShort')}
          </span>
        </p>
      )}
      <div className="max-w-full overflow-x-auto">
        <table className="w-full text-xs">
          <thead className="text-[10px] text-muted-foreground">
            <tr>
              <th className="py-1 pr-2 text-left font-normal">{t('chainArrange.colNew')}</th>
              <th className="py-1 pr-2 text-left font-normal">{t('chainArrange.colWas')}</th>
              <th className="py-1 pr-2 text-left font-normal">{t('chainArrange.colRoute')}</th>
              <th className="py-1 pr-2 text-left font-normal">{t('chainArrange.colFit')}</th>
              <th className="py-1 pr-2 text-left font-normal">{t('chainArrange.colTier')}</th>
              <th className="py-1 pr-2 text-left font-normal">{t('chainArrange.colMetric')}</th>
              <th className="py-1 pr-2 text-right font-normal">{t('chainArrange.colReliability')}</th>
              <th className="py-1 pr-2 text-center font-normal">{t('chainArrange.colPinned')}</th>
              {!readOnly && <th className="py-1 text-right font-normal">{t('chainArrange.colAction')}</th>}
            </tr>
          </thead>
          <tbody>
            {entries.map(entry => {
              const key = `${entry.platform}\u0000${entry.modelId}\u0000${entry.endpointScope}`
              const open = expanded.has(key)
              return (
                <FragmentRows
                  key={key}
                  entry={entry}
                  open={open}
                  onToggle={() => toggle(key)}
                  readOnly={readOnly}
                  saving={saving}
                  onPin={onPin}
                  onUnpin={onUnpin}
                />
              )
            })}
          </tbody>
        </table>
      </div>
    </div>
  )
}

// One plan row plus, expanded, the reasons row underneath it. Split out so the
// table body above stays readable; the two <tr>s travel together.
function FragmentRows({ entry, open, onToggle, readOnly, saving, onPin, onUnpin }: {
  entry: ArrangeEntry
  open: boolean
  onToggle: () => void
  readOnly?: boolean
  saving?: boolean
  onPin?: (entry: ArrangeEntry) => void
  onUnpin?: (entry: ArrangeEntry) => void
}) {
  const { t } = useI18n()
  const moved = entry.from > 0 && entry.from !== entry.position
  const up = moved && entry.from > entry.position
  const handle = endpointHandle(entry.endpointScope)
  const reliability = entry.reliability.n > 0 ? `${entry.reliability.ok}/${entry.reliability.n}` : '–'
  const metricValue = entry.metric.value == null ? '–' : String(Math.round(entry.metric.value * 10) / 10)

  return (
    <>
      <tr className="border-t">
        <td className="py-1 pr-2 font-medium tabular-nums">{entry.position}</td>
        <td className="py-1 pr-2 tabular-nums text-muted-foreground">
          {moved ? (
            <Tooltip text={up ? t('chainArrange.movedUp', { from: entry.from }) : t('chainArrange.movedDown', { from: entry.from })}>
              <span className="inline-flex items-center gap-0.5">
                {up
                  ? <ArrowUp className="size-3 text-emerald-600 dark:text-emerald-400" aria-label={t('chainArrange.movedUp', { from: entry.from })} />
                  : <ArrowDown className="size-3 text-amber-600 dark:text-amber-400" aria-label={t('chainArrange.movedDown', { from: entry.from })} />}
                {entry.from}
              </span>
            </Tooltip>
          ) : (
            <span title={t('chainArrange.unchanged')}>·</span>
          )}
        </td>
        <td className="py-1 pr-2">
          <span className="block max-w-[220px] truncate font-medium">{entry.displayName}</span>
          <span className="block max-w-[220px] truncate font-mono text-[10px] text-muted-foreground">
            {entry.platform}/{entry.modelId}
            {handle && <span className="text-muted-foreground/80"> · {handle}</span>}
          </span>
        </td>
        <td className="py-1 pr-2">
          <EligibilityBadge eligibility={entry.eligibility} />
        </td>
        <td className="py-1 pr-2">
          <TierBadge tier={entry.tier} />
        </td>
        <td className="py-1 pr-2 text-muted-foreground">
          {t(METRIC_KEYS[entry.metric.name])} <span className="tabular-nums text-foreground">{metricValue}</span>
        </td>
        <td className="py-1 pr-2 text-right tabular-nums" title={t('chainArrange.reliabilityHint')}>
          {reliability}
        </td>
        <td className="py-1 pr-2 text-center">
          {entry.pinned && (
            <Tooltip text={t('chainArrange.pinnedHint')}>
              <Pin className="inline size-3 text-foreground" aria-label={t('chainArrange.pinnedHint')} />
            </Tooltip>
          )}
        </td>
        {!readOnly && (
          <td className="py-1 text-right">
            <button
              type="button"
              disabled={saving}
              onClick={() => (entry.pinned ? onUnpin?.(entry) : onPin?.(entry))}
              className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:opacity-50"
            >
              {entry.pinned
                ? <><PinOff className="size-3" />{t('chainArrange.unpin')}</>
                : <><Pin className="size-3" />{t('chainArrange.pinHere')}</>}
            </button>
          </td>
        )}
      </tr>
      {entry.reasons.length > 0 && (
        <tr className="border-t border-dashed">
          <td colSpan={readOnly ? 8 : 9} className="bg-muted/30 px-2 py-1">
            <button
              type="button"
              aria-expanded={open}
              onClick={onToggle}
              className="inline-flex items-center gap-1 text-[10px] text-muted-foreground hover:text-foreground"
            >
              <ChevronDown className={`size-3 transition-transform ${open ? '' : '-rotate-90'}`} />
              {t('chainArrange.reasons', { count: entry.reasons.length })}
            </button>
            {open && (
              <ul className="mt-1 list-disc space-y-0.5 pl-4 text-[11px] text-muted-foreground">
                {entry.reasons.map((reason, i) => <li key={i}>{reason}</li>)}
              </ul>
            )}
          </td>
        </tr>
      )}
    </>
  )
}

function EligibilityBadge({ eligibility }: { eligibility: ArrangeEntry['eligibility'] }) {
  const { t } = useI18n()
  const tone = eligibility === 'fit' ? 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-400'
    : eligibility === 'near' || eligibility === 'filler' ? 'bg-amber-500/10 text-amber-700 dark:text-amber-400'
    : 'bg-muted text-muted-foreground'
  return (
    <span className={`inline-block rounded-full px-1.5 py-0.5 text-[10px] ${tone}`}>
      {t(ELIGIBILITY_KEYS[eligibility])}
    </span>
  )
}

function TierBadge({ tier }: { tier: ArrangeEntry['tier'] }) {
  const { t } = useI18n()
  const tone = tier === 'proven' ? 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-400'
    : tier === 'failing' ? 'bg-rose-500/10 text-rose-700 dark:text-rose-400'
    : 'bg-muted text-muted-foreground'
  return (
    <span className={`inline-block rounded-full px-1.5 py-0.5 text-[10px] ${tone}`}>
      {t(TIER_KEYS[tier])}
    </span>
  )
}

interface ArrangePreviewDialogProps {
  chain: string
  open: boolean
  onClose: () => void
  /** Given when the dialog shows what a run WROTE; absent, the dialog asks
   *  for a preview itself, so a pin can refresh the plan in place. */
  written?: ArrangePlan | null
  ranAt?: number
}

/**
 * The plan in front of the operator, with the one write it can offer: a pin.
 * Pinning saves settings (compare-and-set, like every chain-arrange write)
 * and re-previews, so the table under the cursor is never one click stale.
 */
export function ArrangePreviewDialog({ chain, open, onClose, written, ranAt }: ArrangePreviewDialogProps) {
  const { t } = useI18n()
  const queryClient = useQueryClient()
  const [error, setError] = useState('')

  const { data: overview } = useQuery<ChainArrangeOverview>({
    queryKey: ['chain-arrange', 'overview'],
    queryFn: () => apiFetch(chainArrangePaths.overview),
    enabled: open,
  })
  // The dialog owns the preview fetch: refetching after a pin save keeps the
  // dialog open on the fresh order instead of closing it.
  const { data: previewed, isPending, error: previewError, refetch: refetchPreview } = useQuery<ArrangePlan>({
    queryKey: ['chain-arrange', 'preview', chain],
    queryFn: () => apiFetch(chainArrangePaths.preview, {
      method: 'POST',
      body: JSON.stringify({ chain }),
    }),
    enabled: open && !written,
  })
  const plan = written ?? previewed

  // Someone else wrote settings between our read and our write. Re-read and
  // say so: the operator's next pin lands on the current revision.
  async function handleConflict(err: ApiError) {
    if (err.code === 'revision_conflict') {
      await queryClient.refetchQueries({ queryKey: ['chain-arrange', 'overview'], exact: true })
      setError(t('chainArrange.conflict'))
    } else {
      setError(err.message || t('chainArrange.saveFailed'))
    }
  }

  const savePins = useMutation({
    mutationFn: (entry: ArrangeEntry) => {
      const doc = overview?.settings
      if (!doc) throw new Error(t('chainArrange.saveFailed'))
      return apiFetch<{ settings: ArrangeSettingsDoc }>(chainArrangePaths.overview, {
        method: 'PUT',
        body: JSON.stringify({
          expectedRevision: doc.revision,
          tolerancePct: doc.tolerancePct,
          chains: withPin(doc, chain, entry),
        }),
      })
    },
    onSuccess: ({ settings }) => {
      setError('')
      queryClient.setQueryData<ChainArrangeOverview>(['chain-arrange', 'overview'], prev =>
        prev ? { ...prev, settings } : prev)
      // Order-affecting write: the Fallback table and every chain-arrange
      // view re-read, and the open preview follows.
      queryClient.invalidateQueries({ queryKey: ['chain-arrange'] })
      queryClient.invalidateQueries({ queryKey: ['fallback'] })
      if (!written) void refetchPreview()
    },
    onError: (err: ApiError) => { void handleConflict(err) },
  })

  const moved = plan ? plan.entries.filter(e => e.from > 0 && e.from !== e.position).length : 0

  return (
    <Dialog open={open} onOpenChange={next => { if (!next && !savePins.isPending) onClose() }}>
      <DialogPopup maxWidth="max-w-4xl">
        <DialogTitle>{t(ranAt ? 'chainArrange.runPlanTitle' : 'chainArrange.previewTitle', { chain })}</DialogTitle>
        <DialogDescription className="mt-1">
          {ranAt
            ? t('chainArrange.runPlanDescription', { moved, when: formatStamp(new Date(ranAt), { time: true }) })
            : plan
              ? plan.changed
                ? t('chainArrange.previewWouldMove', { moved })
                : t('chainArrange.previewNoChange')
              : t('common.loading')}
        </DialogDescription>
        {previewError && (
          <p className="mt-2 text-xs text-rose-600 dark:text-rose-400">{previewError.message}</p>
        )}
        {plan && (
          <div className="mt-3">
            <ArrangePreviewTable
              entries={plan.entries}
              depth={plan.depth}
              saving={savePins.isPending || isPending}
              onPin={entry => savePins.mutate(entry)}
              onUnpin={entry => savePins.mutate(entry)}
            />
          </div>
        )}
        {error && <p className="mt-2 text-xs text-rose-600 dark:text-rose-400">{error}</p>}
        <div className="mt-4 flex items-center justify-between gap-3">
          <span className="text-[11px] text-muted-foreground">
            {plan && t('chainArrange.planComputedAt', { when: formatStamp(new Date(plan.computedAtMs), { time: true }) })}
          </span>
          <button type="button" onClick={onClose} className="rounded-lg border px-3 py-1.5 text-sm">
            {t('common.close')}
          </button>
        </div>
      </DialogPopup>
    </Dialog>
  )
}

/** settings.chains[chain] with the row's pin set or cleared. Everything else
 *  in the document passes through untouched — a pin write must not silently
 *  publish a draft tolerance or someone else's pending edits. */
function withPin(doc: ArrangeSettingsDoc, chain: string, entry: ArrangeEntry): Record<string, ArrangeChainSettings> {
  const current = effectiveChainSettings(doc, chain)
  const pins = current.pins.filter(pin => routePinKey(pin) !== routePinKey(entry))
  pins.push({ platform: entry.platform, modelId: entry.modelId, endpointScope: entry.endpointScope, position: entry.position })
  return { ...doc.chains, [chain]: { ...current, pins } }
}
