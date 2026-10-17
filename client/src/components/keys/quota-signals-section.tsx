import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import type { ApiKey, ProviderQuotaState } from '../../../../shared/types'
import { EmptyState } from '@/components/empty-state'
import { apiFetch } from '@/lib/api'
import { formatSqliteUtcToLocalTime } from '@/lib/utils'
import { useI18n } from '@/i18n'
import { liveObservations, parseStamp, STALE_AFTER_MS } from '@/lib/quota-dashboard'
import { QuotaOutlookSection } from './quota-outlook-section'
import { QuotaDashboard } from './quota-dashboard'
import { ProviderCapacityPanel } from '../provider-capacity'
import { BonusGrantsPanel } from './bonus-grants-panel'
import { PaidCreditPanel } from './paid-credit-panel'

function formatQuotaNumber(value: number | null): string {
  return value == null ? '—' : new Intl.NumberFormat().format(value)
}

function formatResetAt(value: string | null): string {
  if (!value) return '—'
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? '—' : date.toLocaleString()
}

// Keys → Quota. Provider allowance cards first, because "how much is left and
// when does it come back" is the question the tab is opened for. The forecast
// and the raw observations it is built from sit in Details below.
export function QuotaSignalsSection({ states }: { states: ProviderQuotaState[] }) {
  const { t } = useI18n()
  const { data: keys = [] } = useQuery<ApiKey[]>({
    queryKey: ['keys'],
    queryFn: () => apiFetch('/api/keys'),
  })
  // Observations about deleted or disabled keys are history, not quota: they
  // were most of this list and read as dead allowances.
  const { live, hidden } = liveObservations(states, keys)
  // Staleness is measured in days, so the moment the tab opened is precise enough.
  const [now] = useState(() => Date.now())
  return (
    <div className="space-y-6">
      <QuotaDashboard states={states} />
      <ProviderCapacityPanel />
      <BonusGrantsPanel />
      <PaidCreditPanel />
      <details className="overflow-hidden rounded-3xl border bg-card">
        <summary className="cursor-pointer px-4 py-3 text-sm font-medium">{t('keys.quotaDetails')}</summary>
        <div className="space-y-5 border-t p-4">
          <QuotaOutlookSection />
          <details>
            <summary className="cursor-pointer text-sm font-medium">{t('keys.outlookRaw')}</summary>
            <div className="mt-3 space-y-2">
              {hidden > 0 && <p className="text-xs text-muted-foreground">{t('keys.quotaRawHidden', { count: hidden })}</p>}
              {live.length === 0 ? (
                <EmptyState title={t('keys.quotaSignalsEmptyTitle')} description={t('keys.quotaSignalsEmptyDesc')} className="bg-card" />
              ) : (
                <div className="rounded-3xl border divide-y bg-card overflow-hidden">
                  {live.map((state) => {
                    const observed = parseStamp(state.observedAt)
                    const stale = observed != null && now - observed > STALE_AFTER_MS
                    return (
                      <div key={`${state.platform}:${state.keyId}:${state.quotaPoolKey}:${state.metric}`} className="px-4 py-3.5 text-sm">
                        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                          <span className="font-medium">{state.platform}</span>
                          {/* The key's own name where it has one, since "key #7" tells the
                              operator nothing about which credential is near its limit (#705). */}
                          <span className="text-muted-foreground">
                            {state.keyLabel || t('keys.quotaKeyRef', { id: state.keyId })}
                          </span>
                          <span className="text-muted-foreground">{t('keys.quotaPoolRef', { pool: state.quotaPoolKey })}</span>
                          <span className="text-xs px-2 py-0.5 rounded-full bg-muted text-muted-foreground">{state.metric}</span>
                          {stale && <span className="text-xs px-2 py-0.5 rounded-full bg-amber-500/10 text-amber-700 dark:text-amber-400">{t('keys.quotaRawStale')}</span>}
                          <span className="ml-auto text-xs text-muted-foreground">
                            {state.source} · {Math.round(state.confidence * 100)}%
                          </span>
                        </div>
                        <div className="mt-2 grid gap-2 text-xs text-muted-foreground sm:grid-cols-2 lg:grid-cols-4">
                          <div><span className="text-foreground">{t('keys.quotaLimit')}</span> {formatQuotaNumber(state.limit)}</div>
                          <div><span className="text-foreground">{t('keys.quotaRemaining')}</span> {formatQuotaNumber(state.remaining)}</div>
                          <div><span className="text-foreground">{t('keys.quotaReset')}</span> {formatResetAt(state.resetAt)}</div>
                          <div><span className="text-foreground">{t('keys.quotaObserved')}</span> {formatSqliteUtcToLocalTime(state.observedAt, { hour: '2-digit', minute: '2-digit' })}</div>
                        </div>
                        {state.notes && (
                          <p className="mt-2 text-xs text-muted-foreground">{state.notes}</p>
                        )}
                      </div>
                    )
                  })}
                </div>
              )}
            </div>
          </details>
        </div>
      </details>
    </div>
  )
}
