import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { useLocation } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { apiFetch } from '@/lib/api'
import { useExtensionEnabled } from '@/lib/use-extension'
import { useI18n } from '@/i18n'
import { Tooltip } from '@/components/tooltip'
import { formatCountdown } from '@/lib/countdown'
import {
  ProviderCapacityContext, useProviderCapacity, currentCapacityFreshness,
  formatCapacityAmount, formatCapacityPercent,
} from '@/lib/provider-capacity'
import type { ProviderCapacityPool, ProviderCapacityReading, ProviderCapacityResponse, ProviderModelCapacity } from '@freellmapi/shared/types'

/** One authenticated observer and one clock for every supported widget. */
export function ProviderCapacityProvider({ children }: { children: ReactNode }) {
  const location = useLocation()
  const presentation = useExtensionEnabled('quota-capacity-dashboard')
  const { locale } = useI18n()
  const enabled = presentation && (location.pathname === '/keys' || location.pathname.startsWith('/models/chat'))
  const query = useQuery<ProviderCapacityResponse>({
    queryKey: ['provider-capacity'],
    queryFn: () => apiFetch('/api/quota/capacity'),
    enabled,
    staleTime: 20_000,
    refetchInterval: 20_000,
  })
  const [now, setNow] = useState(Date.now)
  useEffect(() => {
    if (!enabled) return
    const timer = window.setInterval(() => setNow(Date.now()), 1_000)
    return () => window.clearInterval(timer)
  }, [enabled])
  const numbers = useMemo(() => new Intl.NumberFormat(locale, { maximumFractionDigits: 8 }), [locale])
  const percentages = useMemo(() => new Intl.NumberFormat(locale, { maximumFractionDigits: 4 }), [locale])
  const timestamps = useMemo(() => new Intl.DateTimeFormat(locale, { dateStyle: 'short', timeStyle: 'short' }), [locale])
  const value = useMemo(() => ({ enabled, data: query.data, isLoading: query.isLoading, isError: query.isError, now,
    numbers, percentages, timestamps }), [enabled, query.data, query.isLoading, query.isError, now, numbers, percentages, timestamps])
  return <ProviderCapacityContext.Provider value={value}>{children}</ProviderCapacityContext.Provider>
}

/** Spent fraction drives one tone across every bar: amber from two thirds,
 *  red from nine tenths, matching the Keys allowance cell. Unknown stays
 *  muted; a measured 100% is exhausted, not an error. */
function usageTone(spent: number | null): { fill: string; text: string } {
  if (spent == null) return { fill: 'bg-muted-foreground/40', text: 'text-muted-foreground' }
  if (spent >= 0.9) return { fill: 'bg-rose-500', text: 'text-rose-700 dark:text-rose-400' }
  if (spent >= 0.67) return { fill: 'bg-amber-500', text: 'text-amber-700 dark:text-amber-400' }
  return { fill: 'bg-emerald-500', text: 'text-foreground' }
}

/** The allocation bar shows what is LEFT, so it takes the provider cards'
 *  thresholds: red at 20% or less left, amber at half or less. */
function leftTone(spent: number | null): { fill: string; text: string } {
  if (spent == null) return usageTone(null)
  const left = 1 - spent
  if (left <= 0.2) return { fill: 'bg-rose-500', text: 'text-rose-700 dark:text-rose-400' }
  if (left <= 0.5) return { fill: 'bg-amber-500', text: 'text-amber-700 dark:text-amber-400' }
  return { fill: 'bg-emerald-500', text: 'text-foreground' }
}

/** One meter used by both reading kinds, so widths and heights align across
 *  every row and kind of bar. */
function UsageMeter({ modelId, label, value, fill, dataAttribute }: {
  modelId: string
  label: string
  /** Percentage 0-100; null renders the muted empty track, not a fake zero. */
  value: number | null
  fill: string
  dataAttribute: 'capacity-utilization' | 'capacity-allocation-usage'
}) {
  const view = useProviderCapacity()
  const { t } = useI18n()
  return <span
    role="meter"
    aria-label={`${modelId} · ${label}`}
    aria-valuemin={0}
    aria-valuemax={100}
    aria-valuenow={value ?? undefined}
    aria-valuetext={value == null || !view ? t('capacity.unknown') : formatCapacityPercent(value, view.percentages)}
    className="inline-block h-1.5 w-28 shrink-0 overflow-hidden rounded-full bg-muted"
    data-capacity-utilization={dataAttribute === 'capacity-utilization' ? modelId : undefined}
    data-capacity-allocation-usage={dataAttribute === 'capacity-allocation-usage' ? modelId : undefined}
  >
    <span aria-hidden="true" className={`block h-full rounded-full ${fill}`} style={{ width: `${value ?? 0}%` }} />
  </span>
}

function Reading({ reading, kind, compact = false }: { reading: ProviderCapacityReading; kind: 'allocation' | 'rpm'; compact?: boolean }) {
  const view = useProviderCapacity()
  const { t } = useI18n()
  if (!view) return null
  const freshness = currentCapacityFreshness(reading, kind === 'allocation' ? 15 * 60_000 : 60_000, view.now, view.isError)
  const amount = (value: number | null) => formatCapacityAmount(value, view.numbers)
  const observed = reading.observedAt == null ? NaN : Date.parse(reading.observedAt)
  const reset = reading.resetAt == null ? NaN : Date.parse(reading.resetAt)
  const when = Number.isFinite(observed) ? view.timestamps.format(observed) : t('capacity.unknown')
  const resetText = Number.isFinite(reset) ? view.timestamps.format(reset) : t('capacity.unknown')
  const title = [
    t(kind === 'allocation' ? 'capacity.sharedHint' : 'capacity.rpmHint'),
    t('capacity.exactReading', { used: amount(reading.used), remaining: amount(reading.remaining), limit: amount(reading.limit) }),
    t('capacity.provenance', { source: reading.source ?? t('capacity.unknown'), time: when }),
    t('capacity.resetAt', { time: resetText }),
  ].join('\n')
  const label = kind === 'allocation' ? t('capacity.sharedAllocation') : t('capacity.rpm')
  const spent = reading.limit != null && reading.limit > 0 && reading.used != null ? reading.used / reading.limit : null
  const tone = leftTone(freshness === 'fresh' ? spent : null)
  const value = freshness === 'unknown' ? t('capacity.unknown')
    : compact && kind === 'allocation' && reading.remainingPct != null
      ? formatCapacityPercent(reading.remainingPct, view.percentages)
      : t('capacity.leftOf', { remaining: amount(reading.remaining), limit: amount(reading.limit) })
  return (
    <Tooltip text={title} wide>
      <span className={`inline-flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[10px] tabular-nums ${tone.text}`} data-capacity-reading={kind} data-freshness={freshness}>
        <span>{label}:</span>
        {freshness === 'stale' && <span>{t('capacity.lastReported')}</span>}
        <span className="font-mono">{value}</span>
        {freshness === 'fresh' && spent != null && <UsageMeter
          modelId={`${kind}:${reading.observedAt ?? ''}`}
          label={label}
          // What is LEFT, shrinking as it is used, like every allowance bar on
          // Keys → Quota (2026-10-22). It used to fill up with usage.
          value={Math.max(0, Math.min(100, (1 - spent) * 100))}
          fill={tone.fill}
          dataAttribute="capacity-allocation-usage"
        />}
        {freshness === 'fresh' && reading.remaining === 0 && <span className="ml-1">{t('capacity.exhaustedWait')}</span>}
        {!compact && kind === 'allocation' && freshness !== 'unknown' && <>
          <span>{t('capacity.points')}</span>
          <span>· {t('capacity.used', { count: amount(reading.used) })}</span>
        </>}
        {!compact && kind === 'rpm' && freshness !== 'unknown' && <span>{t('capacity.requests')}</span>}
        {!compact && <span className="text-muted-foreground">· {t('capacity.observedAt', { time: when })}</span>}
        {!compact && kind === 'allocation' && <span className="text-muted-foreground">· {t('capacity.resetAt', { time: resetText })}</span>}
      </span>
    </Tooltip>
  )
}

function Pressure({ model }: { model: ProviderModelCapacity }) {
  const view = useProviderCapacity()
  const { t } = useI18n()
  if (!view) return null
  const freshness = currentCapacityFreshness(model.pressure, 60_000, view.now, view.isError)
  const state = freshness === 'unknown' || model.pressure.state == null ? 'unknown' : model.pressure.state
  const observed = model.pressure.observedAt == null ? NaN : Date.parse(model.pressure.observedAt)
  const when = Number.isFinite(observed) ? view.timestamps.format(observed) : t('capacity.unknown')
  const utilization = freshness === 'unknown' || state === 'unknown' ? null : model.pressure.utilizationPct
  const spent = utilization == null ? null : utilization / 100
  const tone = usageTone(spent)
  return (
    <Tooltip text={`${t('capacity.fleetHint')}\n${t('capacity.provenance', { source: model.pressure.source, time: when })}`} wide>
      <span className={`inline-flex flex-wrap items-center gap-1 text-[10px] ${tone.text}`} data-model-pressure={model.modelId} data-freshness={freshness}>
        <span>{t('capacity.modelPressure')}:</span>
        {freshness === 'stale' && <span>{t('capacity.lastReported')}</span>}
        <span>{t(`capacity.pressure_${state}`)}</span>
        {freshness !== 'unknown' && model.pressure.utilizationPct != null && <span className="font-mono tabular-nums">
          {formatCapacityPercent(model.pressure.utilizationPct, view.percentages)}
        </span>}
        <span className="text-muted-foreground">· {t('capacity.observedAt', { time: when })}</span>
        {utilization != null && <UsageMeter
          modelId={model.modelId}
          label={t('capacity.modelPressure')}
          value={utilization}
          fill={tone.fill}
          dataAttribute="capacity-utilization"
        />}
        {freshness === 'fresh' && state === 'full' && <span className="ml-1">{t('capacity.exhaustedWait')}</span>}
      </span>
    </Tooltip>
  )
}

function Cooldowns({ pools, modelId }: { pools: readonly ProviderCapacityPool[]; modelId?: string }) {
  const view = useProviderCapacity()
  const { t } = useI18n()
  if (!view) return null
  return <>{pools.map(pool => pool.cooldowns.map(row =>
    row.expiresAtMs > view.now && (!modelId || row.modelId === modelId) ? (
      <span key={`${pool.keyId}:${row.modelId}:${row.expiresAtMs}`} className="text-[10px] text-sky-700 dark:text-sky-400" data-capacity-cooldown={row.modelId}>
        {t('capacity.cooldown', { key: pool.keyLabel || `#${pool.keyId}`, model: row.modelId,
          time: formatCountdown(Math.ceil((row.expiresAtMs - view.now) / 1000)) })}
      </span>
    ) : null,
  ))}</>
}

export function ProviderModelCapacityIndicator({ platform, modelId }: { platform: string; modelId: string }) {
  const view = useProviderCapacity()
  const { t } = useI18n()
  if (platform !== 'radeon' || !view?.enabled) return null
  const model = view.data?.models.find(row => row.platform === platform && row.modelId === modelId)
  if (!model) return <div className="mt-1 text-[10px] text-muted-foreground" data-capacity-model={modelId}>
    {view.isLoading ? t('capacity.loading') : t('capacity.unavailable')}
  </div>
  // The account allocation is ONE pool for every model this key serves: it
  // belongs once, above the list, not repeated on every row. Each row keeps
  // only its own fleet pressure, which is the fact that differs per model.
  const pressure = currentCapacityFreshness(model.pressure, 60_000, view.now, view.isError)
  const exhausted = pressure === 'fresh' && model.pressure.state === 'full'
  return (
    <div className={`mt-1 flex flex-col gap-1 ${exhausted ? 'opacity-60 saturate-0' : ''}`} data-capacity-model={modelId}>
      <Pressure model={model} />
      <Cooldowns pools={view.data?.pools.filter(pool => model.keyIds.includes(pool.keyId)) ?? []} modelId={model.modelId} />
    </div>
  )
}

export function ProviderKeyCapacityIndicator({ platform, keyId }: { platform: string; keyId: number }) {
  const view = useProviderCapacity()
  const { t } = useI18n()
  if (platform !== 'radeon' || !view?.enabled) return null
  const pool = view.data?.pools.find(row => row.keyId === keyId && row.platform === platform)
  if (!pool) return <span className="text-[10px] text-muted-foreground" data-capacity-key={keyId}>
    {view.isLoading ? t('capacity.loading') : t('capacity.unavailable')}
  </span>
  const scoped = view.data?.models.filter(model => model.keyIds.includes(keyId)) ?? []
  const measured = scoped.filter(model => currentCapacityFreshness(model.pressure, 60_000, view.now, view.isError) === 'fresh')
  const full = measured.filter(model => model.pressure.state === 'full').length
  const busy = measured.filter(model => model.pressure.state === 'busy').length
  const pressure = measured.length === 0 ? t('capacity.fleetUnknown')
    : full > 0 ? t('capacity.fullModels', { count: full })
      : busy > 0 ? t('capacity.busyModels', { count: busy })
        : measured.length < scoped.length ? t('capacity.fleetPartial') : t('capacity.fleetIdle')
  return <span className="inline-flex flex-wrap items-center gap-x-2 gap-y-1" data-capacity-key={keyId}>
    <Reading reading={pool.allocation} kind="allocation" compact />
    <Tooltip text={t('capacity.fleetHint')}><span className="text-[10px] text-muted-foreground">{pressure}</span></Tooltip>
    <Cooldowns pools={[pool]} />
  </span>
}

/** The quota page counts each account pool once, then lists only model pressure. */
export function ProviderCapacityPanel() {
  const view = useProviderCapacity()
  const { t } = useI18n()
  if (!view?.enabled) return null
  if (!view.data) return <section className="rounded-3xl border bg-card p-4" data-capacity-panel>
    <h2 className="text-sm font-medium">{t('capacity.title')}</h2>
    <p className="mt-2 text-xs text-muted-foreground">{view.isLoading ? t('capacity.loading') : t('capacity.unavailable')}</p>
  </section>
  if (view.data.pools.length === 0) return null
  return <section className="rounded-3xl border bg-card p-4" data-capacity-panel>
    <h2 className="text-sm font-medium">{t('capacity.title')}</h2>
    <p className="mt-1 text-xs text-muted-foreground">{t('capacity.sharedHint')}</p>
    {view.isError && <p className="mt-2 text-xs text-amber-700 dark:text-amber-400">{t('capacity.unavailable')}</p>}
    <div className="mt-3 space-y-4">
      {view.data.pools.map(pool => <div key={`${pool.platform}:${pool.keyId}:${pool.quotaPoolKey}`} className="space-y-2 border-t pt-3" data-capacity-pool={pool.keyId}>
        <h3 className="text-xs font-medium">{pool.keyLabel || t('keys.quotaKeyRef', { id: pool.keyId })}</h3>
        <Reading reading={pool.allocation} kind="allocation" />
        <div><Reading reading={pool.rpm} kind="rpm" /></div>
        <Cooldowns pools={[pool]} />
      </div>)}
    </div>
    <div className="mt-4 border-t pt-3">
      <p className="mb-2 text-xs text-muted-foreground">{t('capacity.fleetHint')}</p>
      <div className="space-y-2">
        {view.data.models.map(model => <div key={model.modelDbId} className="flex flex-wrap items-baseline justify-between gap-2">
          <span className="text-xs">{model.modelId}</span>
          <Pressure model={model} />
        </div>)}
      </div>
    </div>
  </section>
}
