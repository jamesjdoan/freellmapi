import { useRef, useState, type MouseEvent } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useI18n } from '@/i18n'
import { apiFetch } from '@/lib/api'
import { ConfirmButton } from '@/components/confirm-button'
import { formatStamp } from '@/lib/stamp'
import { Dialog, DialogPopup, DialogTitle, DialogDescription } from '@/components/ui/dialog'

// Ignoring a provider or model is the operator saying "never use this, free
// or not". It switches the provider's keys and the models off (routing stops),
// keeps them off across catalog syncs, and drops them from the catalogue
// views. Because it changes what serves, the first click only previews what
// would switch off; the second confirms. Un-ignoring restores exactly what the
// ignore switched off.

const BASE = '/api/models/catalogue-ignores'

interface Impact { keys: number; models: number; chains: string[] }

/** A whole provider (modelId null) or one of its models. */
export interface IgnoreTarget { platform: string; modelId: string | null }

interface CatalogueIgnore {
  platform: string
  modelId: string | null
  at: string
  switchedOff: { keys: number; models: number }
}

const query = (platform: string, modelId: string | null) =>
  new URLSearchParams(modelId ? { platform, modelId } : { platform }).toString()

function useRefreshCatalogue() {
  const queryClient = useQueryClient()
  return () => {
    for (const key of ['catalogue-syncs', 'catalogue-sync-detail', 'catalogue-ignores', 'catalogue-changes', 'catalogue-log', 'models', 'fallback']) {
      queryClient.invalidateQueries({ queryKey: [key] })
    }
  }
}

/** Stop a click inside a <summary> from also folding the group. */
const contained = (fn: () => void) => (e: MouseEvent) => {
  e.preventDefault()
  e.stopPropagation()
  fn()
}

/**
 * Ignore one or more targets together. The Models page passes every provider
 * route of a logical model; Catalog updates passes a single provider or model.
 * `name` labels the control for screen readers; `className` styles the
 * unarmed button only, so a hover-revealed button stays visible once armed.
 */
export function IgnoreButton({ targets, name, label, className }: {
  targets: IgnoreTarget[]
  name: string
  label: string
  className?: string
}) {
  const { t } = useI18n()
  const refresh = useRefreshCatalogue()
  const [impact, setImpact] = useState<Impact | null>(null)
  const buttonRef = useRef<HTMLButtonElement>(null)
  const body = JSON.stringify({ targets })
  const preview = useMutation({
    mutationFn: () => apiFetch<Impact>(`${BASE}/preview`, { method: 'POST', body }),
    onSuccess: setImpact,
  })
  const ignore = useMutation({
    mutationFn: () => apiFetch(BASE, { method: 'POST', body }),
    onSuccess: () => { setImpact(null); refresh() },
  })

  return (
    <Dialog open={impact !== null} onOpenChange={open => { if (!open && !ignore.isPending) setImpact(null) }}>
      <button
        ref={buttonRef}
        type="button"
        onClick={contained(() => preview.mutate())}
        disabled={preview.isPending || ignore.isPending}
        aria-label={t('catalogue.ignoreLabel', { name })}
        className={className ?? 'text-[11px] text-muted-foreground underline decoration-dotted hover:text-foreground'}
      >
        {preview.isPending ? t('catalogue.ignoreChecking') : label}
      </button>
      {impact && (
        <DialogPopup finalFocus={buttonRef} onClick={e => e.stopPropagation()}>
          <DialogTitle>{t('catalogue.ignoreLabel', { name })}</DialogTitle>
          <DialogDescription className="mt-2">
            {t('catalogue.ignoreImpact', { keys: impact.keys, models: impact.models })}
          </DialogDescription>
          {impact.chains.length > 0 && (
            <p className="mt-2 text-sm text-rose-600 dark:text-rose-400">
              {t('catalogue.ignoreImpactChains', { chains: impact.chains.join(', ') })}
            </p>
          )}
          <div className="mt-4 flex justify-end gap-3">
            <button type="button" onClick={contained(() => setImpact(null))} disabled={ignore.isPending} className="rounded border px-3 py-2 text-sm">
              {t('catalogue.ignoreCancel')}
            </button>
            <button type="button" onClick={contained(() => ignore.mutate())} disabled={ignore.isPending} className="rounded border border-rose-500/40 px-3 py-2 text-sm font-medium text-rose-600 dark:text-rose-400">
              {t('catalogue.ignoreConfirm')}
            </button>
          </div>
        </DialogPopup>
      )}
    </Dialog>
  )
}

export function CatalogueIgnoresList({ hidden }: { hidden: number }) {
  const { t } = useI18n()
  const refresh = useRefreshCatalogue()
  const { data } = useQuery<{ ignores: CatalogueIgnore[] }>({
    queryKey: ['catalogue-ignores'],
    queryFn: () => apiFetch(BASE),
  })
  const unignore = useMutation({
    mutationFn: (ig: CatalogueIgnore) => apiFetch(`${BASE}?${query(ig.platform, ig.modelId)}`, { method: 'DELETE' }),
    onSuccess: refresh,
  })
  const ignores = data?.ignores ?? []
  if (ignores.length === 0) return null

  return (
    <details className="mt-2 text-xs">
      <summary className="cursor-pointer text-muted-foreground hover:text-foreground">
        {t('catalogue.ignoredTitle')} <span className="tabular-nums">{ignores.length}</span>
        {hidden > 0 && <span className="ml-2 text-[11px]">{t('catalogue.ignoredHidden', { count: hidden })}</span>}
      </summary>
      <ul className="mt-1 divide-y divide-border">
        {ignores.map(ig => {
          const name = ig.modelId ?? ig.platform
          return (
            <li key={`${ig.platform}:${ig.modelId ?? ''}`} className="flex flex-wrap items-baseline gap-x-3 py-1.5">
              <span className="font-medium">{ig.platform}</span>
              {ig.modelId
                ? <code className="text-[11px] text-muted-foreground">{ig.modelId}</code>
                : <span className="text-[11px] text-muted-foreground">{t('catalogue.ignoredWholeProvider')}</span>}
              <span className="text-[11px] text-muted-foreground">
                {t('catalogue.ignoredSwitchedOff', { keys: ig.switchedOff.keys, models: ig.switchedOff.models })}
              </span>
              <span className="ml-auto text-[11px] text-muted-foreground tabular-nums">{formatStamp(ig.at, { time: true })}</span>
              <ConfirmButton onConfirm={() => unignore.mutate(ig)} disabled={unignore.isPending} aria-label={t('catalogue.unignoreLabel', { name })}>
                {t('catalogue.unignore')}
              </ConfirmButton>
            </li>
          )
        })}
      </ul>
    </details>
  )
}
