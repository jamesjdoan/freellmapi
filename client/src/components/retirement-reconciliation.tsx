import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { AlertTriangle } from 'lucide-react'
import { apiFetch } from '@/lib/api'
import { Button } from '@/components/ui/button'
import { useI18n } from '@/i18n'

/** One retirement this server made that the published catalogue contradicts.
 *  `modelDbId` is null once the catalogue has dropped the model too — the
 *  disagreement is over, and only the Ignore action still applies. */
interface UnreconciledRetirement {
  modelDbId: number | null
  platform: string
  modelId: string
  displayName: string | null
  reason: string | null
  retiredAt: string
  relistedAt: string | null
  relistCount: number
}

interface RetirementsResponse {
  retirements: UnreconciledRetirement[]
}

/**
 * Unreconciled upstream retirements.
 *
 * The gateway retires a model when the provider itself refuses it (410 "end of
 * life", 404 "no longer available"). The catalogue is built from the provider
 * rosters that keep advertising those models, so it goes on listing them as
 * enabled. The server's own result wins — but silently disagreeing with the
 * catalogue twice a day is exactly the kind of state that rots unseen, so every
 * disagreement is listed here until it is settled:
 *
 *   - Keep retired  — the provider is right; stop showing it.
 *   - Re-enable     — override the provider verdict and route to it again.
 *
 * Renders nothing when there is nothing to reconcile.
 */
export function RetirementReconciliation() {
  const { t } = useI18n()
  const queryClient = useQueryClient()

  const { data } = useQuery<RetirementsResponse>({
    queryKey: ['model-retirements'],
    queryFn: () => apiFetch('/api/models/retirements'),
  })

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ['model-retirements'] })
    void queryClient.invalidateQueries({ queryKey: ['fallback'] })
  }

  const ignore = useMutation({
    mutationFn: (item: UnreconciledRetirement) =>
      apiFetch('/api/models/retirements/ignore', {
        method: 'POST',
        body: JSON.stringify({ platform: item.platform, modelId: item.modelId }),
      }),
    onSuccess: invalidate,
  })

  const reinstate = useMutation({
    mutationFn: (modelDbId: number) =>
      apiFetch(`/api/models/${modelDbId}`, {
        method: 'PATCH',
        body: JSON.stringify({ fallbackEnabled: true }),
      }),
    onSuccess: invalidate,
  })

  const items = data?.retirements ?? []
  if (items.length === 0) return null

  return (
    <div className="rounded-2xl border border-amber-500/40 bg-amber-500/5 p-4">
      <div className="flex items-start gap-2">
        <AlertTriangle className="mt-0.5 size-4 shrink-0 text-amber-600 dark:text-amber-400" />
        <div className="min-w-0 flex-1">
          <h3 className="text-sm font-medium">{t('models.retirementConflictTitle', { count: items.length })}</h3>
          <p className="mt-0.5 text-xs text-muted-foreground">{t('models.retirementConflictHint')}</p>

          <ul className="mt-3 flex flex-col gap-3">
            {items.map(item => (
              <li key={`${item.platform}:${item.modelId}`} className="flex flex-col gap-2 border-t pt-3 sm:flex-row sm:items-start sm:justify-between">
                <div className="min-w-0">
                  <p className="truncate text-sm">
                    {item.displayName ?? item.modelId}
                    <span className="ml-1.5 text-xs text-muted-foreground">{item.platform}</span>
                  </p>
                  {item.reason && (
                    <p className="mt-0.5 break-words text-xs text-muted-foreground">{item.reason}</p>
                  )}
                  <p className="mt-0.5 text-[11px] text-muted-foreground">
                    {t('models.retirementConflictRelisted', { count: item.relistCount })}
                  </p>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={ignore.isPending}
                    onClick={() => ignore.mutate(item)}
                  >
                    {t('models.retirementConflictKeep')}
                  </Button>
                  {item.modelDbId != null && (
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={reinstate.isPending}
                      onClick={() => reinstate.mutate(item.modelDbId as number)}
                    >
                      {t('models.retirementConflictReinstate')}
                    </Button>
                  )}
                </div>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </div>
  )
}
