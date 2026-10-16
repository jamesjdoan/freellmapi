import { useState, useEffect, useMemo } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { Plus, Pencil, Trash2, X, Save } from 'lucide-react'
import type { BonusGrantView, CreateBonusGrantInput, UpdateBonusGrantInput } from '../../../../shared/bonus-types'
import { apiFetch } from '@/lib/api'
import { useI18n } from '@/i18n'
import { cn } from '@/lib/utils'
import { formatCountdown } from '@/lib/countdown'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Badge } from '@/components/ui/badge'
import { ConfirmButton } from '@/components/confirm-button'

const BONUS_METRICS = ['requests', 'total_tokens'] as const

function useLiveCountdown(expiresAt: string | null, active: boolean) {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!active || !expiresAt) return
    const id = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(id)
  }, [active, expiresAt])
  if (!expiresAt) return null
  const ms = Date.parse(expiresAt) - now
  return ms > 0 ? Math.ceil(ms / 1000) : 0
}

function usageTone(spent: number | null): { fill: string; text: string } {
  if (spent == null) return { fill: 'bg-muted-foreground/40', text: 'text-muted-foreground' }
  if (spent >= 0.9) return { fill: 'bg-rose-500', text: 'text-rose-700 dark:text-rose-400' }
  if (spent >= 0.67) return { fill: 'bg-amber-500', text: 'text-amber-700 dark:text-amber-400' }
  return { fill: 'bg-emerald-500', text: 'text-foreground' }
}

function formatMetricLabel(metric: string, t: (k: string) => string): string {
  if (metric === 'requests') return t('keys.bonusMetricRequests')
  if (metric === 'total_tokens') return t('keys.bonusMetricTokens')
  return metric
}

function UsageMeter({ value, label }: { value: number | null; label: string }) {
  const tone = usageTone(value == null ? null : value / 100)
  // Usage can run past a limit (the normal allowance, once a window funds the
  // excess); the fill stops at the track while the label keeps the real figure.
  const fill = value == null ? 0 : Math.min(100, Math.max(0, value))
  return (
    <span role="meter" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={value == null ? undefined : fill}
      className="inline-block h-1.5 w-20 shrink-0 overflow-hidden rounded-full bg-muted">
      <span aria-hidden="true" className={cn('block h-full rounded-full', tone.fill)} style={{ width: `${fill}%` }} />
    </span>
  )
}

interface GrantFormState {
  platform: string
  keyIds: string
  metric: string
  quantity: string
  durationHours: string
  normalLimit: string
  timezone: string
  label: string
  allowanceQuantity: string
  allowanceDurationHours: string
}

const EMPTY_FORM: GrantFormState = {
  platform: '', keyIds: '', metric: 'total_tokens',
  quantity: '', durationHours: '', normalLimit: '',
  timezone: 'UTC', label: '',
  allowanceQuantity: '', allowanceDurationHours: '',
}

const XKIRO_DEFAULTS: Partial<GrantFormState> = {
  quantity: '30000000', durationHours: '720', normalLimit: '1000000',
  timezone: 'UTC', metric: 'total_tokens',
}

function GrantForm({ platforms, keysByPlatform, existingGrant, onCancel, onSaved }: {
  platforms: string[]
  keysByPlatform: Record<string, Array<{ id: number; label: string }>>
  existingGrant?: BonusGrantView
  onCancel: () => void
  onSaved: () => void
}) {
  const { t } = useI18n()
  const queryClient = useQueryClient()
  const isEdit = !!existingGrant
  const defaultPlatform = platforms.includes('xkiro') ? 'xkiro' : (platforms[0] ?? '')

  const [form, setForm] = useState<GrantFormState>(() => {
    if (existingGrant) {
      return {
        platform: existingGrant.platform,
        keyIds: existingGrant.keyIds.join(','),
        metric: existingGrant.metric,
        quantity: String(existingGrant.quantity),
        durationHours: String((Date.parse(existingGrant.expiresAt) - Date.parse(existingGrant.startsAt)) / 3_600_000),
        normalLimit: String(existingGrant.normal.limit),
        timezone: existingGrant.normal.timezone,
        label: existingGrant.label,
        allowanceQuantity: '',
        allowanceDurationHours: '',
      }
    }
    const base = { ...EMPTY_FORM, platform: defaultPlatform }
    return defaultPlatform === 'xkiro' ? { ...base, ...XKIRO_DEFAULTS, platform: defaultPlatform } : base
  })

  const [submitError, setSubmitError] = useState<string | null>(null)
  const [isSubmitting, setIsSubmitting] = useState(false)

  const set = (field: keyof GrantFormState, value: string) => {
    setForm(prev => {
      const next = { ...prev, [field]: value }
      if (field === 'platform' && !isEdit) {
        next.keyIds = ''
        if (value === 'xkiro') {
          Object.assign(next, XKIRO_DEFAULTS, { platform: value, keyIds: '' })
        } else {
          next.quantity = ''
          next.durationHours = ''
          next.normalLimit = ''
        }
      }
      return next
    })
  }
  const availableKeys = keysByPlatform[form.platform] ?? []

  const handleSubmit = async () => {
    setSubmitError(null)
    const parsedKeyIds = form.keyIds.split(',').map(s => Number(s.trim())).filter(n => Number.isFinite(n) && n > 0)
    const qty = Number(form.quantity)
    const dur = Number(form.durationHours)
    const normLim = Number(form.normalLimit)

    if (isEdit) {
      if (!(normLim > 0) || !(qty > 0) || !(dur > 0)) {
        setSubmitError(t('validation.required'))
        return
      }
      const updateInput: UpdateBonusGrantInput = {}
      if (form.label !== existingGrant!.label) updateInput.label = form.label
      if (qty > 0 && qty !== existingGrant!.quantity) updateInput.quantity = qty
      if (normLim !== existingGrant!.normal.limit) updateInput.normalLimit = normLim
      const originalDuration = (Date.parse(existingGrant!.expiresAt) - Date.parse(existingGrant!.startsAt)) / 3_600_000
      if (dur !== originalDuration) updateInput.durationHours = dur

      const hasUpdate = Object.keys(updateInput).length > 0
      const hasAllowance = form.allowanceQuantity && form.allowanceDurationHours
        && Number(form.allowanceQuantity) > 0 && Number(form.allowanceDurationHours) > 0

      if (!hasUpdate && !hasAllowance) { onCancel(); return }

      setIsSubmitting(true)
      try {
        if (hasUpdate) {
          await apiFetch<{ grant: BonusGrantView }>(`/api/quota/bonuses/${existingGrant!.id}`, { method: 'PATCH', body: JSON.stringify(updateInput) })
        }
        if (hasAllowance) {
          await apiFetch<{ grant: BonusGrantView }>(`/api/quota/bonuses/${existingGrant!.id}/allowance`, {
            method: 'POST',
            body: JSON.stringify({ quantity: Number(form.allowanceQuantity), durationHours: Number(form.allowanceDurationHours) }),
          })
        }
        queryClient.invalidateQueries({ queryKey: ['quota', 'bonuses'] })
        onSaved()
      } catch (err) {
        setSubmitError((err as Error).message)
      } finally {
        setIsSubmitting(false)
      }
    } else {
      if (parsedKeyIds.length === 0 || !(qty > 0) || !(dur > 0) || !(normLim > 0)) {
        setSubmitError(t('validation.required'))
        return
      }
      setIsSubmitting(true)
      try {
        await apiFetch<{ grant: BonusGrantView }>('/api/quota/bonuses', {
          method: 'POST',
          body: JSON.stringify({
            platform: form.platform,
            keyIds: parsedKeyIds,
            metric: form.metric as CreateBonusGrantInput['metric'],
            quantity: qty,
            durationHours: dur,
            normalLimit: normLim,
            timezone: form.timezone || 'UTC',
            label: form.label || undefined,
          } satisfies CreateBonusGrantInput),
        })
        queryClient.invalidateQueries({ queryKey: ['quota', 'bonuses'] })
        onSaved()
      } catch (err) {
        setSubmitError((err as Error).message)
      } finally {
        setIsSubmitting(false)
      }
    }
  }

  const field = (label: string, control: React.ReactNode) => (
    <label className="flex flex-col gap-1 text-xs text-muted-foreground">
      {label}
      {control}
    </label>
  )

  return (
    <div className="space-y-3 border-t pt-4 mt-4">
      <p className="text-xs font-medium">{isEdit ? t('keys.bonusEditGrant') : t('keys.bonusCreateGrant')}</p>
      <p className="text-[11px] text-muted-foreground">{t('keys.bonusNormalFirstHint')}</p>
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        {!isEdit && field(t('keys.bonusProvider'), (
          <select value={form.platform} onChange={e => set('platform', e.target.value)}
            className="h-8 rounded-md border bg-background px-1.5 text-xs text-foreground">
            {platforms.map(p => <option key={p} value={p}>{p}</option>)}
          </select>
        ))}
        {!isEdit && field(t('keys.bonusKeys'), (
          <select multiple value={form.keyIds ? form.keyIds.split(',').map(s => s.trim()) : []}
            onChange={e => set('keyIds', Array.from(e.target.selectedOptions, o => o.value).join(','))}
            className="h-20 rounded-md border bg-background px-1.5 text-xs text-foreground">
            {availableKeys.map(k => <option key={k.id} value={String(k.id)}>{k.label || `#${k.id}`}</option>)}
          </select>
        ))}
        {!isEdit && field(t('keys.bonusMetric'), (
          <select value={form.metric} onChange={e => set('metric', e.target.value)}
            className="h-8 rounded-md border bg-background px-1.5 text-xs text-foreground">
            {BONUS_METRICS.map(m => <option key={m} value={m}>{formatMetricLabel(m, t)}</option>)}
          </select>
        ))}
        {field(t('keys.bonusLabel'), (
          <Input value={form.label} onChange={e => set('label', e.target.value)} placeholder={t('keys.bonusLabelPlaceholder')} className="h-8 text-sm" />
        ))}
        {field(t('keys.bonusPoolQuantity'), (
          <Input value={form.quantity} onChange={e => set('quantity', e.target.value)} inputMode="numeric" className="h-8 text-sm" />
        ))}
        {field(t('keys.bonusPoolDuration'), (
          <Input value={form.durationHours} onChange={e => set('durationHours', e.target.value)} inputMode="numeric" placeholder="720" className="h-8 text-sm" />
        ))}
        {field(t('keys.bonusNormalLimit'), (
          <Input value={form.normalLimit} onChange={e => set('normalLimit', e.target.value)} inputMode="numeric" className="h-8 text-sm" />
        ))}
        {!isEdit && field(t('keys.bonusTimezone'), (
          <Input value={form.timezone} onChange={e => set('timezone', e.target.value)} placeholder="UTC" className="h-8 text-sm" />
        ))}
        {isEdit && field(t('keys.bonusAllowanceQuantity'), (
          <Input value={form.allowanceQuantity} onChange={e => set('allowanceQuantity', e.target.value)} inputMode="numeric" placeholder={t('keys.bonusAllowancePlaceholder')} className="h-8 text-sm" />
        ))}
        {isEdit && field(t('keys.bonusAllowanceDuration'), (
          <Input value={form.allowanceDurationHours} onChange={e => set('allowanceDurationHours', e.target.value)} inputMode="numeric" placeholder="hours" className="h-8 text-sm" />
        ))}
      </div>
      {isEdit && <p className="text-[11px] text-muted-foreground">{t('keys.bonusWindowHint')}</p>}
      {submitError && <p className="text-sm text-destructive" role="alert">{submitError}</p>}
      <div className="flex gap-2">
        <Button size="sm" disabled={isSubmitting} onClick={() => void handleSubmit()}>
          {isSubmitting ? t('keys.bonusSaving') : <><Save className="size-3 mr-1" />{isEdit ? t('keys.bonusSaveChanges') : t('keys.bonusCreate')}</>}
        </Button>
        <Button size="sm" variant="outline" onClick={onCancel}><X className="size-3 mr-1" />{t('keys.bonusCancel')}</Button>
      </div>
    </div>
  )
}

function GrantRow({ grant, keysById, onEdit }: { grant: BonusGrantView; keysById: Map<number, string>; onEdit: () => void }) {
  const { t, locale } = useI18n()
  const queryClient = useQueryClient()
  const poolSeconds = useLiveCountdown(grant.expiresAt, grant.status === 'active')
  const allowanceSeconds = useLiveCountdown(grant.allowance?.expiresAt ?? null, grant.allowance?.status === 'active')
  const resetSeconds = useLiveCountdown(grant.normal.resetAt, true)

  const cancelAllowance = useMutation({
    mutationFn: () => apiFetch(`/api/quota/bonuses/${grant.id}/allowance`, { method: 'DELETE' }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['quota', 'bonuses'] }),
  })

  const poolSpent = grant.quantity > 0 ? (grant.used + grant.reserved) / grant.quantity : null
  const allowanceSpent = grant.allowance && grant.allowance.quantity > 0
    ? (grant.allowance.used + grant.allowance.reserved) / grant.allowance.quantity
    : null
  const normalSpent = grant.normal.limit > 0 ? grant.normal.used / grant.normal.limit : null

  const keyLabels = grant.keyIds.map(id => keysById.get(id) ?? `#${id}`).join(', ')
  const numberFmt = useMemo(() => new Intl.NumberFormat(locale), [locale])

  const statusVariant = grant.status === 'active' ? 'default' : grant.status === 'expired' ? 'outline' : 'destructive'
  const allowanceStatusVariant = !grant.allowance ? 'secondary'
    : grant.allowance.status === 'active' ? 'default'
    : grant.allowance.status === 'cancelled' ? 'outline'
    : 'destructive'

  return (
    <div className={cn('px-4 py-3.5 text-sm border-b last:border-b-0', grant.status !== 'active' && 'opacity-60')}>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <span className="font-medium">{grant.label || grant.platform}</span>
        <Badge variant={statusVariant}>{t(`keys.bonusStatus_${grant.status}`)}</Badge>
        <span className="text-muted-foreground text-xs">{grant.platform}</span>
        <span className="text-muted-foreground text-xs">{keyLabels}</span>
        <span className="text-xs px-2 py-0.5 rounded-full bg-muted text-muted-foreground">{formatMetricLabel(grant.metric, t)}</span>
        <span className="ml-auto text-xs text-muted-foreground">{t('keys.bonusLocalAccounting')}</span>
        <Button size="xs" variant="ghost" onClick={onEdit} aria-label={t('keys.bonusEdit')}>
          <Pencil className="size-3" />
        </Button>
      </div>

      {/* Normal allowance */}
      <div className="mt-2 rounded-lg border bg-muted/20 p-2.5 text-xs">
        <div className="flex items-center justify-between mb-1">
          <span className="font-medium text-foreground">{t('keys.bonusNormalAllowance')}</span>
          <span className="text-muted-foreground">
            {numberFmt.format(grant.normal.used)} / {numberFmt.format(grant.normal.limit)} · {t('keys.bonusPeriodDay')} {grant.normal.timezone} · {t(grant.normal.limitSource === 'provider' ? 'keys.bonusLimitProvider' : 'keys.bonusLimitOperator')}
          </span>
        </div>
        <div className="flex items-center gap-2">
          <UsageMeter value={normalSpent != null ? normalSpent * 100 : null} label={t('keys.bonusNormalAllowance')} />
          <span className={cn('tabular-nums', usageTone(normalSpent).text)}>
            {normalSpent != null ? `${Math.round(normalSpent * 100)}%` : '—'}
          </span>
          <span className="text-muted-foreground">{t('keys.bonusRemaining', { value: numberFmt.format(grant.normal.remaining) })}</span>
          {resetSeconds != null && <span className="text-muted-foreground ml-auto">{t('keys.bonusResetsIn', { countdown: formatCountdown(resetSeconds) })}</span>}
        </div>
      </div>

      {/* Grant pool */}
      <div className="mt-2 rounded-lg border p-2.5 text-xs">
        <div className="flex items-center justify-between mb-1">
          <span className="font-medium text-foreground">{t('keys.bonusGrantPool')}</span>
          <span className="text-muted-foreground">{numberFmt.format(grant.used)} / {numberFmt.format(grant.quantity)} · {t('keys.bonusReserved', { value: numberFmt.format(grant.reserved) })}</span>
        </div>
        <div className="flex items-center gap-2">
          <UsageMeter value={poolSpent != null ? poolSpent * 100 : null} label={t('keys.bonusGrantPool')} />
          <span className={cn('tabular-nums', usageTone(poolSpent).text)}>
            {poolSpent != null ? `${Math.round(poolSpent * 100)}%` : '—'}
          </span>
          <span className="text-muted-foreground">{t('keys.bonusRemaining', { value: numberFmt.format(grant.remaining) })}</span>
          {grant.status === 'active' && poolSeconds != null && (
            <span className="text-muted-foreground ml-auto">{t('keys.bonusExpiresIn', { countdown: formatCountdown(poolSeconds) })}</span>
          )}
        </div>
      </div>

      {/* Active allowance window */}
      <div className="mt-2 rounded-lg border p-2.5 text-xs">
        <div className="flex items-center justify-between mb-1">
          <span className="font-medium text-foreground">{t('keys.bonusSpendingWindow')}</span>
          {grant.allowance ? (
            <div className="flex items-center gap-2">
              <Badge variant={allowanceStatusVariant}>{t(`keys.bonusAllowanceStatus_${grant.allowance.status}`)}</Badge>
              <span className="text-muted-foreground">{numberFmt.format(grant.allowance.used)} / {numberFmt.format(grant.allowance.quantity)} · {t('keys.bonusReserved', { value: numberFmt.format(grant.allowance.reserved) })}</span>
            </div>
          ) : (
            <span className="text-muted-foreground">{t('keys.bonusNoActiveAllowance')}</span>
          )}
        </div>
        {grant.allowance && (
          <div className="flex items-center gap-2">
            <UsageMeter value={allowanceSpent != null ? allowanceSpent * 100 : null} label={t('keys.bonusSpendingWindow')} />
            <span className={cn('tabular-nums', usageTone(allowanceSpent).text)}>
              {allowanceSpent != null ? `${Math.round(allowanceSpent * 100)}%` : '—'}
            </span>
            <span className="text-muted-foreground">{t('keys.bonusRemaining', { value: numberFmt.format(grant.allowance.remaining) })}</span>
            {grant.allowance.status === 'active' && allowanceSeconds != null && (
              <span className="text-muted-foreground ml-auto">{t('keys.bonusWindowExpiresIn', { countdown: formatCountdown(allowanceSeconds) })}</span>
            )}
            {grant.allowance.status === 'active' && (
              <ConfirmButton
                onConfirm={() => cancelAllowance.mutate()}
                confirmLabel={t('keys.bonusConfirmCancel')}
                disabled={cancelAllowance.isPending}
                aria-label={t('keys.bonusCancelAllowance')}
              >
                <Trash2 className="size-3" />
              </ConfirmButton>
            )}
          </div>
        )}
        {cancelAllowance.error && <p className="mt-1 text-destructive">{(cancelAllowance.error as Error).message}</p>}
      </div>
    </div>
  )
}

export function BonusGrantsPanel() {
  const { t } = useI18n()
  const [showForm, setShowForm] = useState(false)
  const [editingId, setEditingId] = useState<number | null>(null)

  const { data: bonusData, isLoading, isError, error } = useQuery<{ grants: BonusGrantView[]; observedAt: string }>({
    queryKey: ['quota', 'bonuses'],
    queryFn: () => apiFetch('/api/quota/bonuses'),
    refetchInterval: 30_000,
  })

  const { data: keys = [] } = useQuery<Array<{ id: number; platform: string; label: string }>>({
    queryKey: ['keys'],
    queryFn: () => apiFetch('/api/keys'),
  })

  const grants = bonusData?.grants ?? []
  const keysById = useMemo(() => new Map(keys.map(k => [k.id, k.label || k.platform])), [keys])
  const keysByPlatform = useMemo(() => {
    const r: Record<string, Array<{ id: number; label: string }>> = {}
    for (const k of keys) {
      ;(r[k.platform] ??= []).push({ id: k.id, label: k.label })
    }
    return r
  }, [keys])
  const platforms = useMemo(() => [...new Set(keys.map(k => k.platform))], [keys])
  const editingGrant = editingId != null ? grants.find(g => g.id === editingId) : undefined

  const handleSaved = () => {
    setShowForm(false)
    setEditingId(null)
  }

  return (
    <section aria-label={t('keys.bonusTitle')}>
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-sm font-semibold">{t('keys.bonusTitle')}</h3>
        {!showForm && editingId == null && (
          <Button size="sm" variant="outline" onClick={() => setShowForm(true)}>
            <Plus className="size-3 mr-1" />{t('keys.bonusNewGrant')}
          </Button>
        )}
      </div>

      {showForm && !editingGrant && (
        <GrantForm platforms={platforms} keysByPlatform={keysByPlatform} onCancel={() => setShowForm(false)} onSaved={handleSaved} />
      )}

      {isLoading && <p className="text-sm text-muted-foreground">{t('quota.loading')}</p>}
      {isError && (
        <div className="flex flex-wrap items-center gap-3">
          <p role="alert" className="text-sm text-destructive">{(error as Error)?.message ?? t('quota.loadFailed')}</p>
        </div>
      )}

      {!isLoading && !isError && grants.length === 0 && !showForm && (
        <p className="text-sm text-muted-foreground">{t('keys.bonusEmpty')}</p>
      )}

      {grants.length > 0 && (
        <div className="rounded-3xl border divide-y bg-card overflow-hidden">
          {grants.map(grant => (
            <div key={grant.id}>
              <GrantRow
                grant={grant}
                keysById={keysById}
                onEdit={() => { setEditingId(grant.id); setShowForm(false) }}
              />
              {editingId === grant.id && (
                <div className="px-4 pb-4">
                  <GrantForm
                    platforms={platforms}
                    keysByPlatform={keysByPlatform}
                    existingGrant={grant}
                    onCancel={() => setEditingId(null)}
                    onSaved={handleSaved}
                  />
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </section>
  )
}
