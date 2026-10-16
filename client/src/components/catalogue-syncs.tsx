import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useI18n } from '@/i18n'
import { apiFetch } from '@/lib/api'
import { Badge } from '@/components/ui/badge'
import { PlatformDot } from '@/components/platform-dot'
import { formatStamp } from '@/lib/stamp'
import { CatalogueIgnoresList, IgnoreButton } from '@/components/catalogue-ignore'

// Catalog updates that changed something, on the Premium page.
//
// The model history below it on the same page records what happened to each
// MODEL; this records what catalog UPDATES brought: which providers gained,
// lost, or quietly changed models. A provider tightening a quota on an existing
// model never appears in the event log; it appears here.
//
// One entry per local day. The server merges a day's documents into one net
// change (a model added and removed the same day cancels out) and leaves out
// documents that changed nothing. By default it shows only providers this
// install holds a key for, and nothing ignored. Opening an entry lists the
// models per provider, each provider a collapsible group; detail is fetched on
// open because a day can move hundreds of models.

/** Added, removed, edited, and switched off / back on by the feed. A model the
 *  feed switches off is still listed but no longer served. */
interface Churn { a: number; r: number; c: number; off?: number; on?: number }

interface CatalogueSync {
  id: number
  /** YYYY-MM-DD in the browser's time zone. */
  day: string
  /** The documents merged into this day, oldest first. */
  ids: number[]
  /** False when a document was too large to net per model, so counts are summed. */
  netted: boolean
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
  docSwitchedOff: number
  docSwitchedOn: number
  byPlatform: Record<string, Churn>
}

interface CatalogueSyncTotals {
  syncs: number
  added: number
  removed: number
  changed: number
  switchedOff: number
  switchedOn: number
  /** Changes left out because their provider or model is ignored. */
  hiddenIgnored: number
  /** Changes left out because no key exists for their provider. */
  hiddenUnkeyed: number
  lastAt: string | null
  lastVersion: string | null
}

interface Filters { hideIgnored: boolean; keyedOnly: boolean; status: string }

const TIME_ZONE = Intl.DateTimeFormat().resolvedOptions().timeZone

const filterQuery = (f: Filters) =>
  `hideIgnored=${f.hideIgnored}&keyedOnly=${f.keyedOnly}&status=${f.status}&timeZone=${encodeURIComponent(TIME_ZONE)}`

type FieldValue = string | number | boolean | null
interface FieldChange { r: string; p: string; m: string; f: string; o: FieldValue; n: FieldValue }
interface Member { r: string; p: string; m: string; n: string | null }

interface CatalogueSyncDetail extends CatalogueSync {
  details: FieldChange[]
  members: { added: Member[]; removed: Member[] } | null
}

const PROVIDERS_SHOWN = 6

const valueOf = (v: FieldValue) => (v === null ? '—' : String(v))

const churnOf = (s: CatalogueSync): Churn =>
  ({ a: s.docAdded, r: s.docRemoved, c: s.docChanged, off: s.docSwitchedOff, on: s.docSwitchedOn })

const weight = (c: Churn) => c.a + c.r + c.c + (c.off ?? 0) + (c.on ?? 0)

/** A server day key (YYYY-MM-DD) as a local date, for display. */
function dayDate(day: string): Date {
  const [y, m, d] = day.split('-').map(Number)
  return new Date(y, m - 1, d)
}

/** Providers busiest first; ties alphabetical so the order is stable. */
export function providersByChurn(byPlatform: Record<string, Churn>): Array<[string, Churn]> {
  return Object.entries(byPlatform).sort(([pa, a], [pb, b]) => weight(b) - weight(a) || pa.localeCompare(pb))
}

function ChurnCounts({ churn }: { churn: Churn }) {
  const { t } = useI18n()
  return (
    <span className="tabular-nums">
      {churn.a > 0 && <span className="text-emerald-600 dark:text-emerald-400">{`+${churn.a}`}</span>}
      {churn.r > 0 && <span className="ml-1 text-rose-600 dark:text-rose-400">{`−${churn.r}`}</span>}
      {(churn.off ?? 0) > 0 && <span className="ml-1 text-rose-600 dark:text-rose-400">{t('catalogue.syncsOffCount', { count: churn.off ?? 0 })}</span>}
      {(churn.on ?? 0) > 0 && <span className="ml-1 text-emerald-600 dark:text-emerald-400">{t('catalogue.syncsOnCount', { count: churn.on ?? 0 })}</span>}
      {churn.c > 0 && <span className="ml-1 text-amber-600 dark:text-amber-400">{`~${churn.c}`}</span>}
    </span>
  )
}

function ModelLine({ sign, tone, member }: { sign: string; tone: string; member: Member }) {
  const { t } = useI18n()
  return (
    <li className="flex flex-wrap items-baseline gap-x-2">
      <span className={`w-3 text-center font-medium ${tone}`}>{sign}</span>
      {member.n && <span>{member.n}</span>}
      <code className="text-muted-foreground">{member.m}</code>
      {member.r !== 'chat' && <Badge variant="outline" className="text-[10px]">{member.r}</Badge>}
      <span className="ml-auto"><IgnoreButton targets={[{ platform: member.p, modelId: member.m }]} name={member.m} label={t('catalogue.ignoreModel')} /></span>
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
  const fields = detail.details.filter(d => d.p === provider)
  const flips = fields.filter(d => d.f === 'enabled')
  const switchedOff = flips.filter(d => d.o === true && d.n === false)
  const switchedOn = flips.filter(d => d.o === false && d.n === true)
  const changes = fields.filter(d => d.f !== 'enabled')
  const changedModels = [...new Set(changes.map(d => d.m))]
  const flipList = (rows: FieldChange[], sign: string, tone: string) => (
    <ul>{rows.map(d => <ModelLine key={`${d.r}:${d.m}`} sign={sign} tone={tone} member={{ r: d.r, p: d.p, m: d.m, n: null }} />)}</ul>
  )
  return (
    <details open={open} className="rounded border bg-muted/20 px-2 py-1">
      <summary className="flex cursor-pointer items-baseline gap-2 text-xs">
        <PlatformDot platform={provider} />
        <span className="font-medium">{provider}</span>
        <ChurnCounts churn={churn} />
        <span className="ml-auto"><IgnoreButton targets={[{ platform: provider, modelId: null }]} name={provider} label={t('catalogue.ignoreProvider')} /></span>
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
        {switchedOff.length > 0 && (
          <div>
            <h5 className="text-muted-foreground">{t('catalogue.syncsSwitchedOffModels')}</h5>
            {flipList(switchedOff, '⊘', 'text-rose-600 dark:text-rose-400')}
          </div>
        )}
        {switchedOn.length > 0 && (
          <div>
            <h5 className="text-muted-foreground">{t('catalogue.syncsSwitchedOnModels')}</h5>
            {flipList(switchedOn, '↺', 'text-emerald-600 dark:text-emerald-400')}
          </div>
        )}
        {changedModels.length > 0 && (
          <div>
            <h5 className="text-muted-foreground">{t('catalogue.syncsChangedModels')}</h5>
            <ul className="space-y-0.5">
              {changedModels.map(model => (
                <li key={model} className="flex flex-wrap items-baseline gap-x-2">
                  <code className="text-muted-foreground">{model}</code>
                  {changes.filter(d => d.m === model).map(d => (
                    <span key={d.f} className="ml-2">
                      <span className="font-medium">{d.f}</span>{' '}
                      <code className="text-rose-600 dark:text-rose-400">{valueOf(d.o)}</code>
                      {' → '}
                      <code className="text-emerald-600 dark:text-emerald-400">{valueOf(d.n)}</code>
                    </span>
                  ))}
                  <span className="ml-auto"><IgnoreButton targets={[{ platform: provider, modelId: model }]} name={model} label={t('catalogue.ignoreModel')} /></span>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </details>
  )
}

function SyncDetail({ sync, expandAll, filters }: { sync: CatalogueSync; expandAll: boolean; filters: Filters }) {
  const { t } = useI18n()
  const { data, isPending } = useQuery<CatalogueSyncDetail>({
    queryKey: ['catalogue-sync-detail', sync.ids.join(','), filters],
    queryFn: () => apiFetch(`/api/models/changes/syncs/detail?ids=${sync.ids.join(',')}&${filterQuery(filters)}`),
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
        // Keyed on expandAll so toggling it re-opens or re-folds groups the
        // operator had toggled by hand.
        <ProviderGroup
          key={`${provider}:${expandAll}`}
          provider={provider}
          churn={churn}
          detail={data}
          open={expandAll || providers.length === 1}
        />
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
  const [openDays, setOpenDays] = useState<ReadonlySet<string>>(new Set())
  const [expandedDays, setExpandedDays] = useState<ReadonlySet<string>>(new Set())
  // Both on by default: providers you hold no key for and anything you have
  // ignored are noise on a page read for what affects this install.
  const [hideIgnored, setHideIgnored] = useState(true)
  const [keyedOnly, setKeyedOnly] = useState(true)
  const [status, setStatus] = useState('all')
  const filters: Filters = { hideIgnored, keyedOnly, status }
  const { data } = useQuery<{ syncs: CatalogueSync[]; total: number; totals: CatalogueSyncTotals }>({
    queryKey: ['catalogue-syncs', filters],
    queryFn: () => apiFetch(`/api/models/changes/syncs?limit=30&${filterQuery(filters)}`),
  })
  if (!data) return null
  const { totals } = data
  // "Nothing matches" only when a filter actually hid something; otherwise
  // the log is simply empty.
  const filtered = status !== 'all' || totals.hiddenIgnored + totals.hiddenUnkeyed > 0

  const toggle = (set: ReadonlySet<string>, day: string) => {
    const next = new Set(set)
    if (next.has(day)) next.delete(day)
    else next.add(day)
    return next
  }
  const toggleExpandAll = (day: string) => {
    const expanding = !expandedDays.has(day)
    setExpandedDays(prev => toggle(prev, day))
    setOpenDays(prev => {
      const next = new Set(prev)
      if (expanding) next.add(day)
      else next.delete(day)
      return next
    })
  }

  return (
    <div>
      <div className="flex flex-wrap items-end gap-x-8 gap-y-3">
        <Stat label={t('catalogue.syncsTotalUpdates')} value={String(totals.syncs)} />
        <Stat label={t('catalogue.syncsTotalAdded')} value={`+${totals.added}`} tone="text-emerald-600 dark:text-emerald-400" />
        <Stat label={t('catalogue.syncsTotalRemoved')} value={`−${totals.removed}`} tone="text-rose-600 dark:text-rose-400" />
        <Stat label={t('catalogue.syncsTotalSwitchedOff')} value={String(totals.switchedOff)} tone="text-rose-600 dark:text-rose-400" />
        {totals.switchedOn > 0 && (
          <Stat label={t('catalogue.syncsTotalSwitchedOn')} value={String(totals.switchedOn)} tone="text-emerald-600 dark:text-emerald-400" />
        )}
        <Stat label={t('catalogue.syncsTotalChanged')} value={`~${totals.changed}`} tone="text-amber-600 dark:text-amber-400" />
        {totals.lastAt && (
          <span className="ml-auto text-[11px] text-muted-foreground tabular-nums">
            {t('catalogue.syncsLast', { when: formatStamp(totals.lastAt, { time: true }) })}
          </span>
        )}
      </div>
      <p className="mt-3 text-[11px] text-muted-foreground">{t('catalogue.syncsHint')}</p>
      <CatalogueIgnoresList hidden={totals.hiddenIgnored} />
      <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-2 text-xs">
        <label className="flex cursor-pointer items-center gap-1.5">
          <input type="checkbox" checked={keyedOnly} onChange={e => setKeyedOnly(e.target.checked)} />
          {t('catalogue.keyedOnly')}
          {keyedOnly && totals.hiddenUnkeyed > 0 && (
            <span className="text-[11px] text-muted-foreground">{t('catalogue.hiddenUnkeyed', { count: totals.hiddenUnkeyed })}</span>
          )}
        </label>
        <label className="flex cursor-pointer items-center gap-1.5">
          <input type="checkbox" checked={hideIgnored} onChange={e => setHideIgnored(e.target.checked)} />
          {t('catalogue.hideIgnored')}
        </label>
        <label className="flex items-center gap-2">
          {t('catalogue.modelStatus')}
          <select aria-label={t('catalogue.modelStatus')} value={status} onChange={e => setStatus(e.target.value)}
            className="rounded-md border bg-background px-2 py-1">
            <option value="all">{t('catalogue.statusAll')}</option>
            <option value="enabled">{t('catalogue.statusEnabled')}</option>
            <option value="disabled">{t('catalogue.statusDisabled')}</option>
          </select>
        </label>
      </div>
      {status !== 'all' && <p className="mt-2 text-[11px] text-muted-foreground">{t('catalogue.currentStatusHint')}</p>}
      {data.syncs.length === 0 && <p className="mt-3 text-xs text-muted-foreground">
        {t(filtered ? 'catalogue.noMatchingUpdates' : 'catalogue.syncsEmpty')}
      </p>}
      <ul className="mt-2 divide-y divide-border">
        {data.syncs.map(s => {
          const open = openDays.has(s.day)
          const expandAll = expandedDays.has(s.day)
          return (
            <li key={s.day} aria-label={s.day}>
              <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 py-1.5 text-xs">
                <button
                  type="button"
                  onClick={() => setOpenDays(prev => toggle(prev, s.day))}
                  aria-expanded={open}
                  className="flex flex-1 flex-wrap items-baseline gap-x-2 gap-y-0.5 text-left"
                >
                  <span className="font-medium">{formatStamp(dayDate(s.day))}</span>
                  <ChurnCounts churn={churnOf(s)} />
                  {s.ids.length > 1 && (
                    <span className="text-[11px] text-muted-foreground">{t('catalogue.syncsMerged', { count: s.ids.length })}</span>
                  )}
                  <span className="font-mono text-[11px] text-muted-foreground">
                    {s.previousVersion ? `${s.previousVersion} → ${s.version}` : s.version}
                  </span>
                  {!s.netted && <span className="text-[11px] text-amber-600 dark:text-amber-400">{t('catalogue.syncsNotNetted')}</span>}
                  <ProviderSummary byPlatform={s.byPlatform} />
                </button>
                <button
                  type="button"
                  onClick={() => toggleExpandAll(s.day)}
                  aria-expanded={expandAll}
                  className="text-[11px] text-muted-foreground underline decoration-dotted hover:text-foreground"
                >
                  {expandAll ? t('catalogue.syncsCollapseDay') : t('catalogue.syncsExpandDay')}
                </button>
              </div>
              {open && <SyncDetail sync={s} expandAll={expandAll} filters={filters} />}
            </li>
          )
        })}
      </ul>
    </div>
  )
}
