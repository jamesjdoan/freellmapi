import { useEffect, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import type { ApiKey, ProviderQuotaState } from '../../../../shared/types'
import { apiFetch } from '@/lib/api'
import { useI18n } from '@/i18n'
import { cn } from '@/lib/utils'
import { PlatformDot } from '@/components/platform-dot'
import { buildCards, formatAge, formatReset, summarizeUsageCredentials, type OverviewPool, type PoolRow, type ProviderCard, type Tone, type UsageCredLine, type UsageCredentialsResponse } from '@/lib/quota-dashboard'
import { UsageCredentialDialog } from './usage-credential-dialog'
import { CUSTOM_GROUP, PLATFORMS } from './shared'

// Provider allowance cards, Atrium-style: one card per provider with an
// enabled key, one bar per allowance. Spent rows fade and say they are waiting
// for the reset; the footer carries the next reset and the reading's age.

// Three, not five: a grid row is as tall as its tallest card, so one provider
// with many pools (Mistral, Groq) left a band of empty space beside it.
const ROWS_SHOWN = 3

const BAR: Record<Tone, string> = {
  good: 'bg-emerald-500',
  warn: 'bg-amber-500',
  low: 'bg-rose-500',
}
const TEXT: Record<Tone, string> = {
  good: 'text-emerald-700 dark:text-emerald-400',
  warn: 'text-amber-700 dark:text-amber-400',
  low: 'text-rose-700 dark:text-rose-400',
}

/** Provider name without the catalogue's parenthetical ("Auray (50 shared…)"). */
function providerName(platform: string): string {
  const label = [...PLATFORMS, CUSTOM_GROUP].find(p => p.value === platform)?.label ?? platform
  return label.replace(/\s*\(.*\)\s*$/, '')
}

function useNow(): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(id)
  }, [])
  return now
}

function Row({ row, waitingLabel, exhaustedLabel, localLabel, learnedLabel, refilledLabel, hasReset }: {
  row: PoolRow; waitingLabel: string; exhaustedLabel: string; localLabel: string; learnedLabel: string; refilledLabel: string; hasReset: boolean
}) {
  const { t } = useI18n()
  return (
    <li className={cn('rounded-lg px-2.5 py-2', row.spent ? 'bg-muted/40' : 'bg-muted/20 ring-1 ring-border/60')}>
      <div className={cn(row.spent && 'opacity-50')}>
        <div className="flex items-baseline justify-between gap-2 text-xs">
          <span className="min-w-0 truncate font-medium" title={row.label}>{row.label}</span>
          {row.spent ? (
            <span className="shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-amber-700 ring-1 ring-amber-500/40 dark:text-amber-300">
              {hasReset ? waitingLabel : exhaustedLabel}
            </span>
          ) : row.tone && (
            <span className={cn('shrink-0 font-semibold tabular-nums', TEXT[row.tone])}>{t('keys.pctLeft', { pct: row.left ?? 0 })}</span>
          )}
        </div>
        <div className="mt-0.5 flex items-baseline justify-between gap-2 text-[11px] text-muted-foreground">
          <span className="tabular-nums">{row.amount && t('keys.quotaDashAmountLeft', { amount: row.amount })}</span>
          {(row.refilled || row.learned || row.local) && (
            <span>{[row.refilled ? refilledLabel : null, row.learned ? learnedLabel : null, row.local ? localLabel : null].filter(Boolean).join(' · ')}</span>
          )}
        </div>
        {row.left != null && (
          <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-muted" role="meter" aria-label={row.label}
            aria-valuemin={0} aria-valuemax={100} aria-valuenow={row.left}>
            <div className={cn('h-full rounded-full', row.spent || !row.tone ? 'bg-muted-foreground/40' : BAR[row.tone])} style={{ width: `${row.left}%` }} />
          </div>
        )}
      </div>
    </li>
  )
}

function Card({ card, nowMs, usageSupported, usageLine, onOpenUsage }: {
  card: ProviderCard; nowMs: number; usageSupported: boolean; usageLine: UsageCredLine | null; onOpenUsage: () => void
}) {
  const { t, locale } = useI18n()
  const [all, setAll] = useState(false)
  const rows = all ? card.rows : card.rows.slice(0, ROWS_SHOWN)
  const hidden = card.rows.length - rows.length
  const name = providerName(card.platform)
  const resetIn = card.nextResetMs != null ? Math.max(0, Math.round((card.nextResetMs - nowMs) / 1000)) : null
  const clock = card.nextResetMs != null
    ? new Intl.DateTimeFormat(locale, { hour: '2-digit', minute: '2-digit' }).format(card.nextResetMs)
    : null
  return (
    <article aria-label={name} className={cn('flex flex-col rounded-2xl border bg-card p-3', card.waiting && 'border-amber-500/40')}>
      <h4 className="mb-2 flex items-center gap-2 text-sm font-semibold">
        <PlatformDot platform={card.platform} />
        <span className="truncate">{name}</span>
      </h4>
      {card.rows.length === 0 ? (
        <p className="text-xs text-muted-foreground">{t('keys.quotaDashNoReading')}</p>
      ) : (
        <ul className="space-y-1.5">
          {rows.map(row => (
            <Row key={row.id} row={row} hasReset={card.nextResetMs != null}
              waitingLabel={t('keys.quotaDashWaiting')} exhaustedLabel={t('keys.quotaDashExhausted')}
              localLabel={t('keys.quotaDashLocal')} learnedLabel={t('keys.quotaDashLearned')}
              refilledLabel={t('keys.quotaDashRefilled')} />
          ))}
        </ul>
      )}
      {(hidden > 0 || all) && (
        <button type="button" onClick={() => setAll(v => !v)} className="mt-1.5 self-start text-[11px] text-muted-foreground underline decoration-dotted hover:text-foreground">
          {all ? t('keys.quotaDashLess') : t('keys.quotaDashMore', { count: hidden })}
        </button>
      )}
      {usageSupported && (
        usageLine ? (
          <button type="button" onClick={onOpenUsage} title={usageLine.errorMessage ?? usageLine.message ?? undefined}
            className={cn('mt-1.5 block w-full truncate text-left text-[11px] underline decoration-dotted underline-offset-2 hover:text-foreground',
              usageLine.errorMessage ? 'text-destructive' : 'text-muted-foreground')}>
            {t('keys.usageCredConnected')}
            {usageLine.readMs != null && <> {' · '}{t('keys.usageCredRead', { age: formatAge(nowMs - usageLine.readMs) })}</>}
            {usageLine.errorMessage
              ? <> {' · '}{usageLine.errorMessage}</>
              : usageLine.message && <> {' · '}{usageLine.message}</>}
          </button>
        ) : (
          <button type="button" onClick={onOpenUsage}
            className="mt-1.5 self-start text-[11px] text-muted-foreground underline decoration-dotted underline-offset-2 hover:text-foreground">
            {t('keys.usageCredConnect')}
          </button>
        )
      )}
      {(clock || card.paidOnly > 0 || card.updatedMs != null) && (
        <div className="mt-2 space-y-0.5 border-t pt-2 text-[11px] text-muted-foreground">
          {clock && resetIn != null && (
            <p className={cn('tabular-nums', card.waiting ? 'font-semibold text-amber-700 dark:text-amber-300' : 'text-foreground/80')}>
              <span className="whitespace-nowrap">{t('keys.quotaDashResets', { clock })}</span>
              {' · '}
              <span className="whitespace-nowrap">{t('keys.quotaDashIn', { countdown: formatReset(resetIn) })}</span>
            </p>
          )}
          {card.paidOnly > 0 && <p>{t('keys.quotaDashPaidOnly', { count: card.paidOnly })}</p>}
          {card.updatedMs != null && (
            <p className={cn(card.stale && 'font-medium text-amber-700 dark:text-amber-400')}>
              {t(card.stale ? 'keys.quotaDashStale' : 'keys.quotaDashUpdated', { age: formatAge(nowMs - card.updatedMs) })}
            </p>
          )}
        </div>
      )}
    </article>
  )
}

export function QuotaDashboard({ states }: { states: ProviderQuotaState[] }) {
  const { t, locale } = useI18n()
  const nowMs = useNow()
  const { data } = useQuery<{ providers?: OverviewPool[] }>({
    queryKey: ['quota', 'providers'],
    queryFn: () => apiFetch('/api/quota/providers'),
    refetchInterval: 60_000,
  })
  const { data: keys = [] } = useQuery<ApiKey[]>({
    queryKey: ['keys'],
    queryFn: () => apiFetch('/api/keys'),
  })
  // Which providers take a second credential for account usage, and how the
  // saved ones last read. Only unorouter, radeon and google are in `supported`
  // today, so every other card renders without a connect line.
  const { data: usageCreds } = useQuery<UsageCredentialsResponse>({
    queryKey: ['quota', 'usage-credentials'],
    queryFn: () => apiFetch('/api/quota/usage-credentials'),
    refetchInterval: 60_000,
  })
  const [usageDialog, setUsageDialog] = useState<{ platform: string; label: string } | null>(null)
  const cards = buildCards(data?.providers ?? [], keys, states, nowMs, locale)
  // A provider with nothing reported has nothing to draw. A whole card each
  // ("No allowance reported…") was a third of the grid; they share one line.
  const reporting = cards.filter(card => card.rows.length > 0)
  const silent = cards.filter(card => card.rows.length === 0)
  const openUsage = (platform: string) => setUsageDialog({ platform, label: providerName(platform) })
  return (
    <section aria-label={t('keys.quotaDashTitle')}>
      <div className="mb-1 flex items-baseline justify-between gap-3">
        <h3 className="text-sm font-semibold">{t('keys.quotaDashTitle')}</h3>
      </div>
      <p className="mb-3 text-xs text-muted-foreground">{t('keys.quotaDashHint')}</p>
      {cards.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t('keys.quotaDashEmpty')}</p>
      ) : (
        // `items-start`: each card is as tall as its own rows. Stretched to the
        // tallest card in the row, short cards were mostly empty space.
        <div className="grid items-start gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
          {reporting.map(card => (
            <Card key={card.platform} card={card} nowMs={nowMs}
              usageSupported={Boolean(usageCreds?.supported?.[card.platform]?.length)}
              usageLine={summarizeUsageCredentials(usageCreds?.credentials ?? [], card.platform)}
              onOpenUsage={() => openUsage(card.platform)} />
          ))}
        </div>
      )}
      {silent.length > 0 && (
        <p className="mt-3 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
          <span>{t('keys.quotaDashSilent')}</span>
          {silent.map(card => (
            <span key={card.platform} className="inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5">
              <PlatformDot platform={card.platform} />
              <span className="text-foreground/80">{providerName(card.platform)}</span>
              {Boolean(usageCreds?.supported?.[card.platform]?.length) && (
                <button type="button" onClick={() => openUsage(card.platform)}
                  className="underline decoration-dotted underline-offset-2 hover:text-foreground">
                  {t('keys.usageCredConnect')}
                </button>
              )}
            </span>
          ))}
        </p>
      )}
      {usageDialog && usageCreds && (
        <UsageCredentialDialog
          platform={usageDialog.platform}
          providerLabel={usageDialog.label}
          keys={keys}
          credentials={usageCreds.credentials ?? []}
          fields={usageCreds.supported?.[usageDialog.platform] ?? []}
          onOpenChange={open => { if (!open) setUsageDialog(null) }}
        />
      )}
    </section>
  )
}
