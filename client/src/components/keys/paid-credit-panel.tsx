import { useEffect, useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Search, X } from 'lucide-react'
import type {
  PaidCreditKeyView,
  PaidCreditOverview,
  PaidModelListResponse,
  OpenPaidCreditWindowInput,
} from '../../../../shared/paid-credit-types'
import { apiFetch } from '@/lib/api'
import { useI18n } from '@/i18n'
import { cn } from '@/lib/utils'
import { formatCountdown } from '@/lib/countdown'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Badge } from '@/components/ui/badge'
import { ConfirmButton } from '@/components/confirm-button'

/** The phrase the server requires; shown so it can be typed, never pre-filled. */
const CONFIRMATION = 'ALLOW PAID SPEND'
const OVERVIEW_KEY = ['quota', 'paid-credit'] as const

/** Cents become dollars; any other unit is shown as-is with its name. */
function formatAmount(value: number, unit: string): string {
  if (unit === 'cents') return `$${(value / 100).toFixed(2)}`
  return `${new Intl.NumberFormat().format(value)} ${unit}`
}

function useNow(active: boolean) {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!active) return
    const id = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(id)
  }, [active])
  return now
}

function SpendMeter({ fraction, label }: { fraction: number; label: string }) {
  const pct = Math.min(100, Math.max(0, fraction * 100))
  const fill = pct >= 90 ? 'bg-rose-500' : pct >= 67 ? 'bg-amber-500' : 'bg-emerald-500'
  return (
    <span role="meter" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(pct)}
      className="inline-block h-1.5 w-24 shrink-0 overflow-hidden rounded-full bg-muted">
      <span aria-hidden="true" className={cn('block h-full rounded-full', fill)} style={{ width: `${pct}%` }} />
    </span>
  )
}

function OpenWindowForm({ view }: { view: PaidCreditKeyView }) {
  const { t } = useI18n()
  const queryClient = useQueryClient()
  const [amount, setAmount] = useState('')
  const [hours, setHours] = useState('')
  const [confirmation, setConfirmation] = useState('')
  const cents = view.balance?.unit === 'cents'

  const open = useMutation({
    mutationFn: (input: OpenPaidCreditWindowInput) =>
      apiFetch('/api/quota/paid-credit/windows', { method: 'POST', body: JSON.stringify(input) }),
    onSuccess: () => {
      setAmount('')
      setHours('')
      setConfirmation('')
      void queryClient.invalidateQueries({ queryKey: OVERVIEW_KEY, exact: true })
    },
  })

  const quantity = cents ? Math.round(Number(amount) * 100) : Number(amount)
  const ready = quantity > 0 && Number(hours) > 0 && confirmation === CONFIRMATION && !open.isPending

  return (
    <div className="mt-2 space-y-2">
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
        <label className="flex flex-col gap-1 text-xs text-muted-foreground">
          {cents ? t('keys.paidCreditAmountUsd') : t('keys.paidCreditAmount', { unit: view.balance?.unit ?? '' })}
          <Input value={amount} onChange={e => setAmount(e.target.value)} inputMode="decimal" placeholder={cents ? '1.00' : ''} className="h-8 text-sm" />
        </label>
        <label className="flex flex-col gap-1 text-xs text-muted-foreground">
          {t('keys.paidCreditHours')}
          <Input value={hours} onChange={e => setHours(e.target.value)} inputMode="numeric" placeholder="24" className="h-8 text-sm" />
        </label>
        <label className="flex flex-col gap-1 text-xs text-muted-foreground">
          {t('keys.paidCreditConfirm', { phrase: CONFIRMATION })}
          <Input value={confirmation} onChange={e => setConfirmation(e.target.value)} placeholder={CONFIRMATION} autoComplete="off" className="h-8 text-sm" />
        </label>
      </div>
      <Button size="sm" variant="destructive" disabled={!ready}
        onClick={() => open.mutate({ platform: view.platform, keyId: view.keyId, quantity, durationHours: Number(hours), confirmation })}>
        {open.isPending ? t('keys.paidCreditOpening') : t('keys.paidCreditOpen')}
      </Button>
      {open.error && <p role="alert" className="text-xs text-destructive">{(open.error as Error).message}</p>}
    </div>
  )
}

function KeyWindow({ view }: { view: PaidCreditKeyView }) {
  const { t } = useI18n()
  const queryClient = useQueryClient()
  const w = view.window
  const active = w?.status === 'active'
  const now = useNow(active)
  const close = useMutation({
    mutationFn: (id: number) => apiFetch(`/api/quota/paid-credit/windows/${id}`, { method: 'DELETE' }),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: OVERVIEW_KEY, exact: true }),
  })
  const readAgeSeconds = view.balance ? Math.max(0, Math.round((now - Date.parse(view.balance.observedAt)) / 1000)) : null

  return (
    <div className="px-4 py-3.5 text-sm">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <span className="font-medium">{view.keyLabel || `#${view.keyId}`}</span>
        <span className="text-xs text-muted-foreground">{view.platform}</span>
        <span className="text-xs text-muted-foreground">{t('keys.paidCreditSelectedCount', { count: view.selectedModels })}</span>
      </div>
      <p className="mt-1 text-xs text-muted-foreground">
        {view.balance
          ? t('keys.paidCreditBalance', {
              used: formatAmount(view.balance.used, view.balance.unit),
              left: formatAmount(view.balance.remaining, view.balance.unit),
              age: formatCountdown(readAgeSeconds),
            })
          : t('keys.paidCreditNoBalance')}
      </p>

      <div className="mt-2 rounded-lg border p-2.5 text-xs">
        <div className="mb-1 flex items-center justify-between">
          <span className="font-medium text-foreground">{t('keys.paidCreditWindow')}</span>
          {w
            ? <Badge variant={active ? 'destructive' : 'outline'}>{t(`keys.paidCreditStatus_${w.status}`)}</Badge>
            : <span className="text-muted-foreground">{t('keys.paidCreditNoWindow')}</span>}
        </div>
        {w && (
          <div className="flex flex-wrap items-center gap-2">
            <SpendMeter fraction={w.quantity > 0 ? w.spent / w.quantity : 0} label={t('keys.paidCreditWindow')} />
            <span className="tabular-nums">{formatAmount(w.spent, w.unit)} / {formatAmount(w.quantity, w.unit)}</span>
            <span className="text-muted-foreground">{t('keys.bonusRemaining', { value: formatAmount(w.remaining, w.unit) })}</span>
            {active && w.awaitingReading && <span className="text-amber-600 dark:text-amber-400">{t('keys.paidCreditAwaiting')}</span>}
            {active && (
              <span className="ml-auto text-muted-foreground">
                {t('keys.bonusWindowExpiresIn', { countdown: formatCountdown(Math.max(0, Math.ceil((Date.parse(w.expiresAt) - now) / 1000))) })}
              </span>
            )}
            {active && (
              <ConfirmButton onConfirm={() => close.mutate(w.id)} disabled={close.isPending} aria-label={t('keys.paidCreditClose')}>
                <X className="size-3" />
              </ConfirmButton>
            )}
          </div>
        )}
        {close.error && <p role="alert" className="mt-1 text-destructive">{(close.error as Error).message}</p>}
        {!active && view.balance && <OpenWindowForm view={view} />}
      </div>
    </div>
  )
}

function PaidModelPicker({ platform }: { platform: string }) {
  const { t } = useI18n()
  const queryClient = useQueryClient()
  const [query, setQuery] = useState('')
  const listKey = ['quota', 'paid-credit', 'models', platform]
  const { data, isLoading, error } = useQuery<PaidModelListResponse>({
    queryKey: listKey,
    queryFn: () => apiFetch(`/api/quota/paid-credit/models?platform=${encodeURIComponent(platform)}`),
  })
  const toggle = useMutation({
    mutationFn: (input: { modelId: string; selected: boolean }) =>
      apiFetch<PaidModelListResponse>('/api/quota/paid-credit/models', { method: 'PUT', body: JSON.stringify({ platform, ...input }) }),
    onSuccess: next => {
      queryClient.setQueryData(listKey, next)
      // Exact: a prefix match would refetch this very list over the answer above.
      void queryClient.invalidateQueries({ queryKey: OVERVIEW_KEY, exact: true })
    },
  })
  const models = useMemo(() => {
    const needle = query.trim().toLowerCase()
    const all = data?.models ?? []
    const matched = needle ? all.filter(m => m.modelId.toLowerCase().includes(needle) || m.name.toLowerCase().includes(needle)) : all
    // Selected first, so the current choice is always visible.
    return [...matched].sort((a, b) => Number(b.selected) - Number(a.selected))
  }, [data, query])
  const price = (perM: number) => `$${perM < 1 ? perM.toFixed(3) : perM.toFixed(2)}`

  return (
    <div className="space-y-2 px-4 py-3">
      <div className="relative">
        <Search className="pointer-events-none absolute left-2 top-2 size-4 text-muted-foreground" />
        <Input value={query} onChange={e => setQuery(e.target.value)} placeholder={t('keys.paidCreditSearch')} className="h-8 pl-8 text-sm" />
      </div>
      {isLoading && <p className="text-xs text-muted-foreground">{t('quota.loading')}</p>}
      {error && <p role="alert" className="text-xs text-destructive">{(error as Error).message}</p>}
      {toggle.error && <p role="alert" className="text-xs text-destructive">{(toggle.error as Error).message}</p>}
      <ul className="max-h-72 divide-y overflow-y-auto rounded-lg border text-xs">
        {models.map(m => (
          <li key={m.modelId}>
            <label className="flex cursor-pointer items-center gap-2 px-2.5 py-1.5">
              <input type="checkbox" checked={m.selected} disabled={toggle.isPending}
                onChange={e => toggle.mutate({ modelId: m.modelId, selected: e.target.checked })} />
              <span className="min-w-0 flex-1 truncate">
                <span className="font-medium text-foreground">{m.name}</span>
                <span className="ml-2 text-muted-foreground">{m.modelId}</span>
              </span>
              <span className="shrink-0 tabular-nums text-muted-foreground">
                {t('keys.paidCreditPrice', { prompt: price(m.promptPerM), completion: price(m.completionPerM) })}
              </span>
            </label>
          </li>
        ))}
      </ul>
    </div>
  )
}

export function PaidCreditPanel() {
  const { t } = useI18n()
  const [picking, setPicking] = useState<string | null>(null)
  const { data, isLoading, isError, error } = useQuery<PaidCreditOverview>({
    queryKey: OVERVIEW_KEY,
    queryFn: () => apiFetch('/api/quota/paid-credit'),
    refetchInterval: 15_000,
  })

  const keys = data?.keys ?? []
  const platforms = data?.platforms ?? []
  // Nothing to offer when no provider both bills paid models and reports a balance.
  if (isLoading || (!isError && platforms.length === 0)) return null
  return (
    <section aria-label={t('keys.paidCreditTitle')}>
      <div className="mb-1 flex items-center justify-between">
        <h3 className="text-sm font-semibold">{t('keys.paidCreditTitle')}</h3>
        {platforms.map(p => (
          <Button key={p} size="sm" variant="outline" onClick={() => setPicking(picking === p ? null : p)}>
            {picking === p ? t('keys.paidCreditDoneChoosing') : t('keys.paidCreditChoose', { platform: p })}
          </Button>
        ))}
      </div>
      <p className="mb-3 text-xs text-muted-foreground">{t('keys.paidCreditHint')}</p>
      {isError && <p role="alert" className="text-sm text-destructive">{(error as Error).message}</p>}
      {data?.guardActive === false && (
        <p role="alert" className="mb-3 text-sm text-amber-600 dark:text-amber-400">{t('keys.paidCreditGuardOff')}</p>
      )}
      {!isError && keys.length === 0 && <p className="text-sm text-muted-foreground">{t('keys.paidCreditEmpty')}</p>}
      {(keys.length > 0 || picking) && (
        <div className="divide-y overflow-hidden rounded-3xl border bg-card">
          {picking && <PaidModelPicker platform={picking} />}
          {keys.map(k => <KeyWindow key={k.keyId} view={k} />)}
        </div>
      )}
    </section>
  )
}
