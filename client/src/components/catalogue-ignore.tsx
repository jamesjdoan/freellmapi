import { useState, type MouseEvent } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useI18n } from '@/i18n'
import { apiFetch } from '@/lib/api'
import { ConfirmButton } from '@/components/confirm-button'
import { formatStamp } from '@/lib/stamp'

// Ignoring a provider or model is the operator saying "never use this, free
// or not". It switches the provider's keys and the models off (routing stops),
// keeps them off across catalog syncs, and drops them from the catalogue
// views. Because it changes what serves, the first click only previews what
// would switch off; the second confirms. Un-ignoring restores exactly what the
// ignore switched off.

const BASE = '/api/models/catalogue-ignores'

interface Impact { keys: number; models: number; chains: string[] }

interface CatalogueIgnore {
  platform: string
  modelId: string | null
  at: string
  switchedOff: { keys: number; models: number }
}

const target = (platform: string, modelId: string | null) =>
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

export function IgnoreButton({ platform, modelId, label }: { platform: string; modelId: string | null; label: string }) {
  const { t } = useI18n()
  const refresh = useRefreshCatalogue()
  const [impact, setImpact] = useState<Impact | null>(null)
  const preview = useMutation({
    mutationFn: () => apiFetch<Impact>(`${BASE}/preview?${target(platform, modelId)}`),
    onSuccess: setImpact,
  })
  const ignore = useMutation({
    mutationFn: () => apiFetch(BASE, { method: 'POST', body: JSON.stringify({ platform, modelId }) }),
    onSuccess: () => { setImpact(null); refresh() },
  })
  const name = modelId ?? platform

  if (!impact) {
    return (
      <button
        type="button"
        onClick={contained(() => preview.mutate())}
        disabled={preview.isPending}
        aria-label={t('catalogue.ignoreLabel', { name })}
        className="text-[11px] text-muted-foreground underline decoration-dotted hover:text-foreground"
      >
        {preview.isPending ? t('catalogue.ignoreChecking') : label}
      </button>
    )
  }
  return (
    <span role="group" aria-label={t('catalogue.ignoreLabel', { name })} className="inline-flex flex-wrap items-baseline gap-x-2 rounded border border-rose-500/40 bg-rose-500/5 px-1.5 py-0.5 text-[11px]">
      <span>{t('catalogue.ignoreImpact', { keys: impact.keys, models: impact.models })}</span>
      {impact.chains.length > 0 && (
        <span className="text-rose-600 dark:text-rose-400">{t('catalogue.ignoreImpactChains', { chains: impact.chains.join(', ') })}</span>
      )}
      <button type="button" onClick={contained(() => ignore.mutate())} disabled={ignore.isPending} className="font-medium text-rose-600 hover:underline dark:text-rose-400">
        {t('catalogue.ignoreConfirm')}
      </button>
      <button type="button" onClick={contained(() => setImpact(null))} className="text-muted-foreground hover:underline">
        {t('catalogue.ignoreCancel')}
      </button>
    </span>
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
    mutationFn: (ig: CatalogueIgnore) => apiFetch(`${BASE}?${target(ig.platform, ig.modelId)}`, { method: 'DELETE' }),
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
