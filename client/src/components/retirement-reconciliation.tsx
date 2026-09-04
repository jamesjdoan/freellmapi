import { useState } from 'react'
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
  acknowledgedAt: string | null
}

interface RetirementsResponse {
  retirements: UnreconciledRetirement[]
  acknowledged: UnreconciledRetirement[]
}

/** Identity, the provider's own wording, and how insistently the catalogue has
 *  contradicted it — the three things a decision here rests on. */
function RetirementSummary({ item }: { item: UnreconciledRetirement }) {
  const { t } = useI18n()
  return (
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
  )
}

/**
 * Upstream retirements the catalogue disagrees with.
 *
 * The gateway retires a model when the provider itself refuses it (410 "end of
 * life", 404 "no longer available"). The catalogue is built from the provider
 * rosters that keep advertising those models, so it goes on listing them as
 * enabled. The server's own result wins — but silently disagreeing with the
 * catalogue twice a day is exactly the kind of state that rots unseen, so every
 * disagreement is raised here until it is settled:
 *
 *   - Keep retired  — the provider is right; stop raising it.
 *   - Re-enable     — override the provider verdict and route to it again.
 *
 * Settled ones do not vanish without trace: they collapse into a muted count
 * that expands into the decisions taken, each undoable. Without that, pressing
 * "Keep retired" left the model visible only as a badge on its own table row,
 * behind the Hide-disabled filter.
 *
 * Renders nothing when there is nothing to show either way.
 */
export function RetirementReconciliation() {
  const { t } = useI18n()
  const queryClient = useQueryClient()
  const [showKept, setShowKept] = useState(false)

  const { data } = useQuery<RetirementsResponse>({
    queryKey: ['model-retirements'],
    queryFn: () => apiFetch('/api/models/retirements'),
  })

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ['model-retirements'] })
    void queryClient.invalidateQueries({ queryKey: ['fallback'] })
  }

  const settle = useMutation({
    mutationFn: ({ item, keep }: { item: UnreconciledRetirement; keep: boolean }) =>
      apiFetch(`/api/models/retirements/${keep ? 'ignore' : 'unignore'}`, {
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

  const pending = data?.retirements ?? []
  const kept = data?.acknowledged ?? []
  if (pending.length === 0 && kept.length === 0) return null

  return (
    <div className="flex flex-col gap-2">
      {pending.length > 0 && (
        <div className="rounded-2xl border border-amber-500/40 bg-amber-500/5 p-4">
          <div className="flex items-start gap-2">
            <AlertTriangle className="mt-0.5 size-4 shrink-0 text-amber-600 dark:text-amber-400" />
            <div className="min-w-0 flex-1">
              <h3 className="text-sm font-medium">{t('models.retirementConflictTitle', { count: pending.length })}</h3>
              <p className="mt-0.5 text-xs text-muted-foreground">{t('models.retirementConflictHint')}</p>

              <ul className="mt-3 flex flex-col gap-3">
                {pending.map(item => (
                  <li key={`${item.platform}:${item.modelId}`} className="flex flex-col gap-2 border-t pt-3 sm:flex-row sm:items-start sm:justify-between">
                    <RetirementSummary item={item} />
                    <div className="flex shrink-0 items-center gap-2">
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={settle.isPending}
                        onClick={() => settle.mutate({ item, keep: true })}
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
      )}

      {kept.length > 0 && (
        <div className="px-1">
          <button
            type="button"
            onClick={() => setShowKept(v => !v)}
            aria-expanded={showKept}
            className="text-xs text-muted-foreground underline hover:text-foreground"
          >
            {t('models.retirementKeptCount', { count: kept.length })}
          </button>

          {showKept && (
            <ul className="mt-2 flex flex-col gap-3 rounded-2xl border p-4">
              {kept.map(item => (
                <li key={`${item.platform}:${item.modelId}`} className="flex flex-col gap-2 border-b pb-3 last:border-0 last:pb-0 sm:flex-row sm:items-start sm:justify-between">
                  <RetirementSummary item={item} />
                  <div className="flex shrink-0 items-center gap-2">
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={settle.isPending}
                      onClick={() => settle.mutate({ item, keep: false })}
                    >
                      {t('models.retirementKeptUndo')}
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
          )}
        </div>
      )}
    </div>
  )
}
