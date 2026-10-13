import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useI18n } from '@/i18n'
import { apiFetch } from '@/lib/api'
import { Badge } from '@/components/ui/badge'
import { PlatformDot } from '@/components/platform-dot'
import { formatStamp } from '@/lib/stamp'

// One row per applied catalog document, on the Premium page.
//
// The catalogue log on the chat-models page records what happened to each
// MODEL; this records what each catalog UPDATE brought: when the document
// landed, from which tier, and — diffed against the previously applied
// document — which providers gained, lost, or quietly changed models. A
// provider tightening a quota on an existing model never appears in the event
// log; it appears here.
//
// Each row names its providers up front; opening it lists the models per
// provider, each provider a collapsible group. Detail is fetched on open: a
// sync can move hundreds of models and the list view stays cheap.

interface Churn { a: number; r: number; c: number }

interface CatalogueSync {
  id: number
  at: string
  version: string
  previousVersion: string | null
  tier: string
  generatedAt: string | null
  updated: number
  inserted: number
  removed: number
  skippedUnknownPlatform: number
  quirks: number
  docAdded: number
  docRemoved: number
  docChanged: number
  byPlatform: Record<string, Churn>
}

interface CatalogueSyncTotals {
  syncs: number
  added: number
  removed: number
  changed: number
  lastAt: string | null
  lastVersion: string | null
}

type FieldValue = string | number | boolean | null
interface FieldChange { r: string; p: string; m: string; f: string; o: FieldValue; n: FieldValue }
interface Member { r: string; p: string; m: string; n: string | null }

interface CatalogueSyncDetail extends CatalogueSync {
  details: FieldChange[]
  members: { added: Member[]; removed: Member[] } | null
}

const PROVIDERS_SHOWN = 6

const valueOf = (v: FieldValue) => (v === null ? '—' : String(v))

/** Providers busiest first; ties alphabetical so the order is stable. */
export function providersByChurn(byPlatform: Record<string, Churn>): Array<[string, Churn]> {
  return Object.entries(byPlatform).sort(([pa, a], [pb, b]) =>
    (b.a + b.r + b.c) - (a.a + a.r + a.c) || pa.localeCompare(pb))
}

function ChurnCounts({ churn }: { churn: Churn }) {
  return (
    <span className="tabular-nums">
      {churn.a > 0 && <span className="text-emerald-600 dark:text-emerald-400">{`+${churn.a}`}</span>}
      {churn.r > 0 && <span className="ml-1 text-rose-600 dark:text-rose-400">{`−${churn.r}`}</span>}
      {churn.c > 0 && <span className="ml-1 text-amber-600 dark:text-amber-400">{`~${churn.c}`}</span>}
    </span>
  )
}

function ModelLine({ sign, tone, member }: { sign: string; tone: string; member: Member }) {
  return (
    <li className="flex flex-wrap items-baseline gap-x-2">
      <span className={`w-3 text-center font-medium ${tone}`}>{sign}</span>
      {member.n && <span>{member.n}</span>}
      <code className="text-muted-foreground">{member.m}</code>
      {member.r !== 'chat' && <Badge variant="outline" className="text-[10px]">{member.r}</Badge>}
    </li>
  )
}

function ProviderGroup({ provider, churn, detail, open }: {
  provider: string
  churn: Churn
  detail: CatalogueSyncDetail
  open: boolean
}) {
  const { t } = useI18n()
  const added = detail.members?.added.filter(m => m.p === provider) ?? []
  const removed = detail.members?.removed.filter(m => m.p === provider) ?? []
  const changes = detail.details.filter(d => d.p === provider)
  const changedModels = [...new Set(changes.map(d => d.m))]
  return (
    <details open={open} className="rounded border bg-muted/20 px-2 py-1">
      <summary className="flex cursor-pointer items-baseline gap-2 text-xs">
        <PlatformDot platform={provider} />
        <span className="font-medium">{provider}</span>
        <ChurnCounts churn={churn} />
      </summary>
      <div className="mt-1 space-y-2 pb-1 pl-5 text-[11px]">
        {added.length > 0 && (
          <div>
            <h5 className="text-muted-foreground">{t('catalogue.syncsAddedModels')}</h5>
            <ul>{added.map(m => <ModelLine key={`${m.r}:${m.m}`} sign="+" tone="text-emerald-600 dark:text-emerald-400" member={m} />)}</ul>
          </div>
        )}
        {removed.length > 0 && (
          <div>
            <h5 className="text-muted-foreground">{t('catalogue.syncsRemovedModels')}</h5>
            <ul>{removed.map(m => <ModelLine key={`${m.r}:${m.m}`} sign="−" tone="text-rose-600 dark:text-rose-400" member={m} />)}</ul>
          </div>
        )}
        {changedModels.length > 0 && (
          <div>
            <h5 className="text-muted-foreground">{t('catalogue.syncsChangedModels')}</h5>
            <ul className="space-y-0.5">
              {changedModels.map(model => (
                <li key={model}>
                  <code className="text-muted-foreground">{model}</code>
                  {changes.filter(d => d.m === model).map(d => (
                    <span key={d.f} className="ml-2">
                      <span className="font-medium">{d.f}</span>{' '}
                      <code className="text-rose-600 dark:text-rose-400">{valueOf(d.o)}</code>
                      {' → '}
                      <code className="text-emerald-600 dark:text-emerald-400">{valueOf(d.n)}</code>
                    </span>
                  ))}
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </details>
  )
}

function SyncDetail({ sync }: { sync: CatalogueSync }) {
  const { t } = useI18n()
  const { data, isPending } = useQuery<CatalogueSyncDetail>({
    queryKey: ['catalogue-sync-detail', sync.id],
    queryFn: () => apiFetch(`/api/models/changes/syncs/detail?id=${sync.id}`),
  })
  if (isPending) return <p className="pl-5 text-[11px] text-muted-foreground">{t('catalogue.syncsDetailLoading')}</p>
  if (!data) return null
  const providers = providersByChurn(data.byPlatform)
  if (providers.length === 0) return null
  const namesMissing = data.members === null && data.docAdded + data.docRemoved > 0
  return (
    <div className="mb-2 ml-5 mt-1 space-y-1">
      {namesMissing && <p className="text-[11px] text-muted-foreground">{t('catalogue.syncsNamesMissing')}</p>}
      {providers.map(([provider, churn]) => (
        <ProviderGroup key={provider} provider={provider} churn={churn} detail={data} open={providers.length === 1} />
      ))}
    </div>
  )
}

function Stat({ label, value, tone }: { label: string; value: string; tone?: string }) {
  return (
    <div className="min-w-24">
      <div className={`text-lg font-semibold tabular-nums ${tone ?? ''}`}>{value}</div>
      <div className="text-[11px] text-muted-foreground">{label}</div>
    </div>
  )
}

function ProviderSummary({ byPlatform }: { byPlatform: Record<string, Churn> }) {
  const { t } = useI18n()
  const providers = providersByChurn(byPlatform)
  if (providers.length === 0) return null
  const shown = providers.slice(0, PROVIDERS_SHOWN)
  const hidden = providers.length - shown.length
  return (
    <span className="flex w-full flex-wrap items-baseline gap-x-3 gap-y-0.5 pl-1 text-[11px] text-muted-foreground">
      {shown.map(([provider, churn]) => (
        <span key={provider} className="inline-flex items-baseline gap-1">
          <span className="text-foreground/80">{provider}</span>
          <ChurnCounts churn={churn} />
        </span>
      ))}
      {hidden > 0 && <span>{t('catalogue.syncsMoreProviders', { count: hidden })}</span>}
    </span>
  )
}

export function CatalogueSyncs() {
  const { t } = useI18n()
  const [openId, setOpenId] = useState<number | null>(null)
  const { data } = useQuery<{ syncs: CatalogueSync[]; total: number; totals: CatalogueSyncTotals }>({
    queryKey: ['catalogue-syncs'],
    queryFn: () => apiFetch('/api/models/changes/syncs?limit=30'),
  })
  if (!data) return null
  if (data.syncs.length === 0) {
    return <p className="text-xs text-muted-foreground">{t('catalogue.syncsEmpty')}</p>
  }
  const { totals } = data
  return (
    <div>
      <div className="flex flex-wrap items-end gap-x-8 gap-y-3">
        <Stat label={t('catalogue.syncsTotalUpdates')} value={String(totals.syncs)} />
        <Stat label={t('catalogue.syncsTotalAdded')} value={`+${totals.added}`} tone="text-emerald-600 dark:text-emerald-400" />
        <Stat label={t('catalogue.syncsTotalRemoved')} value={`−${totals.removed}`} tone="text-rose-600 dark:text-rose-400" />
        <Stat label={t('catalogue.syncsTotalChanged')} value={`~${totals.changed}`} tone="text-amber-600 dark:text-amber-400" />
        {totals.lastAt && (
          <span className="ml-auto text-[11px] text-muted-foreground tabular-nums">
            {t('catalogue.syncsLast', { when: formatStamp(totals.lastAt, { time: true }) })}
          </span>
        )}
      </div>
      <p className="mt-3 text-[11px] text-muted-foreground">{t('catalogue.syncsHint')}</p>
      <ul className="mt-2 divide-y divide-border">
        {data.syncs.map(s => {
          const moved = s.docAdded + s.docRemoved + s.docChanged > 0
          return (
            <li key={s.id}>
              <button
                type="button"
                onClick={() => moved && setOpenId(v => (v === s.id ? null : s.id))}
                aria-expanded={moved ? openId === s.id : undefined}
                className={`flex w-full flex-wrap items-baseline gap-x-2 gap-y-0.5 py-1.5 text-left text-xs ${moved ? '' : 'cursor-default'}`}
              >
                <Badge variant="outline" className="text-[10px]">{s.tier}</Badge>
                <span className="font-mono">
                  {s.previousVersion ? `${s.previousVersion} → ${s.version}` : s.version}
                </span>
                {!s.previousVersion && <span className="text-muted-foreground">({t('catalogue.syncsBaseline')})</span>}
                {moved
                  ? <ChurnCounts churn={{ a: s.docAdded, r: s.docRemoved, c: s.docChanged }} />
                  : <span className="text-muted-foreground">—</span>}
                <span className="ml-auto flex-shrink-0 text-[11px] text-muted-foreground tabular-nums">
                  {formatStamp(s.at, { time: true })}
                </span>
                <ProviderSummary byPlatform={s.byPlatform} />
              </button>
              {openId === s.id && <SyncDetail sync={s} />}
            </li>
          )
        })}
      </ul>
    </div>
  )
}
