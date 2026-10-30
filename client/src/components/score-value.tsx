import { useState, type FormEvent, type ReactNode } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Plus } from 'lucide-react'
import { apiFetch } from '@/lib/api'
import { useExtensionEnabled } from '@/lib/use-extension'
import { useI18n } from '@/i18n'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import {
  ENTRY_PROVENANCES, PROVENANCE_HELP_KEY, PROVENANCE_LABEL_KEY, provenanceClass,
  type EntryProvenance, type ScoreCell, type ScoreMetric,
} from '@/lib/score-provenance'

// One score, said with its provenance (ADR ARCH-20261018, D5): a measurement
// prints plain; anything else prints in its provenance colour with a small
// italic note under the number, on every surface that shows it.

const METRIC_LABEL_KEY: Record<ScoreMetric, string> = {
  intelligence: 'compare.intelligence', coding: 'compare.coding', agentic: 'compare.agentic',
}

/** The number and its note. `toneClass` is the chain-minimum tone, which a
 *  measurement keeps; a non-measured score takes its provenance colour. */
export function ScoreValue({ cell, toneClass, suffix, title }: { cell: ScoreCell; toneClass?: string; suffix?: ReactNode; title?: string }) {
  const { t } = useI18n()
  if (cell.value == null) return <span className="text-muted-foreground">–</span>
  const colour = provenanceClass(cell.provenance)
  const superseded = cell.entry?.superseded
    ? t('scoreProvenance.superseded', { value: cell.entry.value.toFixed(1), provenance: t(PROVENANCE_LABEL_KEY[cell.entry.provenance]) })
    : undefined
  const archivedTitle = cell.provenance === 'archived'
    ? t('scoreProvenance.archivedTitle', { version: cell.version ?? '', asOf: cell.asOf ?? '' })
    : undefined
  const estimate = cell.provenance === 'derived' ? cell.estimate : null
  const derivedTitle = estimate
    ? [
      t('scoreProvenance.derivedTitle', {
        basis: estimate.basis.kind === 'intelligence'
          ? t('scoreProvenance.basisIntelligence', { version: estimate.basis.version })
          : t(`compare.cap${estimate.basis.capability[0].toUpperCase()}${estimate.basis.capability.slice(1)}`),
        basisValue: estimate.basisValue.toFixed(1),
        n: estimate.n,
        error: estimate.error.toFixed(1),
        scale: estimate.targetVersion ?? '',
      }),
      estimate.extrapolated ? t('scoreProvenance.derivedExtrapolated') : '',
    ].filter(Boolean).join(' ')
    : undefined
  const combinedTitle = [archivedTitle, derivedTitle, superseded, title].filter(Boolean).join('\n') || undefined
  return (
    <span className={`inline-flex flex-col items-end ${colour ?? toneClass ?? ''}`} title={combinedTitle}>
      <span>{cell.value.toFixed(1)}{suffix}</span>
      {cell.provenance === 'archived' && (
        <span className="text-[10px] italic leading-none">{t('scoreProvenance.archivedNote', { version: cell.version ?? '' })}</span>
      )}
      {estimate && (
        <span className="text-[10px] italic leading-none">
          {t('scoreProvenance.derivedNote', { error: estimate.error.toFixed(0) })}{estimate.extrapolated ? '*' : ''}
        </span>
      )}
      {colour && cell.provenance && cell.provenance !== 'measured' && cell.provenance !== 'archived' && cell.provenance !== 'derived' && (
        <span className="text-[10px] italic leading-none">{t(PROVENANCE_LABEL_KEY[cell.provenance])}</span>
      )}
    </span>
  )
}

/**
 * Beside an agentic score where tool calling isn't available. The score
 * describes the MODEL (AA measured it with tools); tool support is a fact
 * about the ROUTE — usually the provider's catalogue — so the number stays
 * and the mark says why a tool-requiring chain will pass this one by.
 */
export function NoToolsMark({ scope }: { scope: 'route' | 'model' }) {
  const { t } = useI18n()
  return (
    <span
      className="rounded border border-muted-foreground/30 px-1 text-[9px] font-normal not-italic leading-tight text-muted-foreground"
      title={t(scope === 'route' ? 'compare.noToolsRouteHint' : 'compare.noToolsModelHint')}
    >
      {t('compare.noToolsMark')}
    </span>
  )
}

/**
 * A score cell that can take a typed score: empty and editable shows a "+",
 * a typed score opens the same form to change or clear it. A measurement, a
 * proxy's borrowed figure and a superseded entry print read-only.
 */
export function EditableScore({ cell, metric, routes, toneClass, suffix, title }: {
  cell: ScoreCell
  metric: ScoreMetric
  /** Routes the score is written to; only those without a measurement. */
  routes: { platform: string; modelId: string }[]
  toneClass?: string
  suffix?: ReactNode
  title?: string
}) {
  const { t } = useI18n()
  const typed = cell.entry != null && !cell.entry.superseded && cell.value != null && cell.provenance === cell.entry.provenance
  // `typed-benchmark-scores` off: the entry affordance goes — the cell prints
  // plain, and a saved typed score keeps displaying like any other number.
  const typedOn = useExtensionEnabled('typed-benchmark-scores')
  // A derived estimate can always be typed over: the operator's number wins.
  const canEnter = typedOn && cell.editable && routes.length > 0 && (cell.value == null || typed || cell.provenance === 'derived')
  if (!canEnter) return <ScoreValue cell={cell} toneClass={toneClass} suffix={suffix} title={title} />
  const label = t('scoreProvenance.enter', { metric: t(METRIC_LABEL_KEY[metric]) })
  return (
    <ScoreEntryPopover cell={cell} metric={metric} routes={routes} label={label}>
      {cell.value == null
        ? <Plus aria-hidden className="size-3 text-muted-foreground/50 group-hover/score:text-muted-foreground" />
        : <ScoreValue cell={cell} toneClass={toneClass} suffix={suffix} title={title} />}
    </ScoreEntryPopover>
  )
}

function ScoreEntryPopover({ cell, metric, routes, label, children }: {
  cell: ScoreCell
  metric: ScoreMetric
  routes: { platform: string; modelId: string }[]
  label: string
  children: ReactNode
}) {
  const { t } = useI18n()
  const queryClient = useQueryClient()
  const [open, setOpen] = useState(false)
  const [value, setValue] = useState('')
  const [provenance, setProvenance] = useState<EntryProvenance | null>(null)
  const [error, setError] = useState<string | null>(null)

  const reset = () => {
    // Editing starts from the typed score; a new entry starts with no
    // provenance chosen, so it cannot be saved by accident.
    setValue(cell.entry && !cell.entry.superseded ? String(cell.entry.value) : '')
    setProvenance(cell.entry && !cell.entry.superseded ? cell.entry.provenance : null)
    setError(null)
  }
  const refresh = () => Promise.all(['analysis', 'fallback'].map(key => queryClient.invalidateQueries({ queryKey: [key] })))
  const save = useMutation({
    mutationFn: (body: { value: number; provenance: EntryProvenance }) =>
      apiFetch('/api/analysis/score', { method: 'PUT', body: JSON.stringify({ routes, metric, ...body }) }),
    onSuccess: async () => { await refresh(); setOpen(false) },
    onError: (err: Error) => setError(err.message),
  })
  const clear = useMutation({
    mutationFn: () => apiFetch('/api/analysis/score', { method: 'DELETE', body: JSON.stringify({ routes, metric }) }),
    onSuccess: async () => { await refresh(); setOpen(false) },
    onError: (err: Error) => setError(err.message),
  })

  const parsed = value.trim() === '' ? NaN : Number(value)
  const valid = Number.isFinite(parsed) && parsed >= 0 && parsed <= 100
  const submit = (event: FormEvent) => {
    event.preventDefault()
    if (valid && provenance) save.mutate({ value: parsed, provenance })
  }
  const busy = save.isPending || clear.isPending

  return (
    <Popover open={open} onOpenChange={next => { if (next) reset(); setOpen(next) }}>
      <PopoverTrigger
        aria-label={label}
        title={label}
        className="group/score inline-flex items-center justify-end rounded px-0.5 hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        onClick={event => event.stopPropagation()}
      >
        {children}
      </PopoverTrigger>
      <PopoverContent align="end" className="w-72 space-y-3 p-3" onClick={event => event.stopPropagation()}>
        <form onSubmit={submit} className="space-y-3">
          <p className="text-xs font-medium">{label}</p>
          <Input
            type="number" inputMode="decimal" min={0} max={100} step={0.1}
            aria-label={t('scoreProvenance.value')}
            placeholder="0–100"
            value={value}
            onChange={event => setValue(event.target.value)}
            className="h-8 text-xs"
          />
          <fieldset className="space-y-1.5">
            <legend className="text-[11px] text-muted-foreground">{t('scoreProvenance.source')}</legend>
            {ENTRY_PROVENANCES.map(p => (
              <label key={p} className="flex cursor-pointer items-start gap-2 text-xs">
                <input
                  type="radio" name={`provenance-${metric}`} value={p}
                  checked={provenance === p}
                  onChange={() => setProvenance(p)}
                  className="mt-0.5"
                />
                <span>
                  <span className={`font-medium ${provenanceClass(p) ?? ''}`}>{t(PROVENANCE_LABEL_KEY[p])}</span>
                  <span className="block text-[10px] text-muted-foreground">{t(PROVENANCE_HELP_KEY[p])}</span>
                </span>
              </label>
            ))}
          </fieldset>
          {error && <p role="alert" className="text-[11px] text-destructive">{error}</p>}
          <div className="flex justify-end gap-2">
            {cell.entry && !cell.entry.superseded && (
              <Button type="button" variant="outline" size="sm" disabled={busy} onClick={() => clear.mutate()}>
                {t('scoreProvenance.clear')}
              </Button>
            )}
            <Button type="submit" size="sm" disabled={!valid || !provenance || busy}>{t('scoreProvenance.save')}</Button>
          </div>
        </form>
      </PopoverContent>
    </Popover>
  )
}
