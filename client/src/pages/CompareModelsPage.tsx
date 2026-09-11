import { useMemo, useState, type ReactNode } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ExternalLink, RefreshCw, Scale } from 'lucide-react'
import { useI18n } from '@/i18n'
import { matchesCompareQuery, sortEntries, type SortKey } from '@/lib/compare-sort'
import { ModelCombobox, type ModelComboOption } from '@/components/model-combobox'
import { apiFetch } from '@/lib/api'
import { toast } from '@/lib/toast'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { ScopePicker } from '@/components/compare/scope-picker'
import { Input } from '@/components/ui/input'
import { PageHeader } from '@/components/page-header'
import { PlatformDot, PlatformLegend, type PlatformScope } from '@/components/platform-dot'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Tooltip } from '@/components/tooltip'

// Compare our routed models on measured capability instead of on the
// hand-tuned ranks this project ships.
//
// `intelligence_rank` and `speed_rank` are ours: per-provider, tuned by hand,
// good for ordering a chain and nothing else. They cannot say whether Kimi K3
// is actually better at coding than GPT-OSS 120B. Artificial Analysis measures
// exactly that, so their three indices are fetched, cached and mapped onto our
// catalogue here.
//
// Both numbers are shown side by side deliberately: seeing a hand-tuned rank
// next to a measured index is how you find out the rank was wrong.
//
// Artificial Analysis require attribution wherever their data is displayed.
// The footer link is that attribution — do not remove it.

interface CompareRow {
  platform: string
  modelId: string
  displayName: string
  enabled: boolean
  contextWindow: number | null
  supportsTools: boolean
  /** A usable key exists for this route, scope included. */
  hasKey: boolean
  keyScope: 'none' | 'disabled' | 'unscoped' | 'in' | 'out'
  supportsVision: boolean
  intelligenceRank: number
  speedRank: number
  chains: string[]
  analysis: {
    slug: string
    name: string
    creator: string | null
    intelligenceIndex: number | null
    codingIndex: number | null
    agenticIndex: number | null
    price1mInput: number | null
    price1mOutput: number | null
    medianOutputTokensPerSecond: number | null
    medianTimeToFirstTokenSeconds: number | null
  } | null
  link: { slug: string | null; source: 'auto' | 'manual' | 'proxy'; matchReason: string | null; unresolved: boolean; proxyDelta: number } | null
}

interface CompareGroup {
  groupKey: string
  canonicalId: string
  name: string
  userDefined: boolean
  members: CompareRow[]
  analysis: CompareRow['analysis']
  analysisSource: 'inherited' | 'own' | null
  /** Routes on a platform we hold a usable key for. Zero means the entry
   *  cannot serve a request however it is configured. */
  keyedMembers?: number
  /** A pinned baseline rather than a model we serve. */
  reference?: boolean
  conflicted: boolean
  chains: string[]
  enabledMembers: number
}

interface ComparePayload {
  rows: CompareRow[]
  catalogue: { slug: string; name: string; creator: string | null; intelligenceIndex: number | null }[]
  status: {
    configured: boolean
    unreadable: boolean
    tier: string | null
    lastSyncMs: number | null
    lastError: string | null
    rateLimit: { limit: number | null; remaining: number | null; resetAt: string | null } | null
    cachedModels: number
    linkedModels: number
    indexVersion: string | null
  }
}

type Metric = 'intelligenceIndex' | 'codingIndex' | 'agenticIndex'

type Scope = 'routed' | 'keyed' | 'enabled' | 'all'

const SCOPES: { key: Scope; labelKey: string; hintKey: string }[] = [
  { key: 'routed', labelKey: 'compare.scopeRouted', hintKey: 'compare.scopeRoutedHint' },
  { key: 'keyed', labelKey: 'compare.scopeKeyed', hintKey: 'compare.scopeKeyedHint' },
  { key: 'enabled', labelKey: 'compare.scopeEnabled', hintKey: 'compare.scopeEnabledHint' },
  { key: 'all', labelKey: 'compare.scopeAll', hintKey: 'compare.scopeAllHint' },
]

/**
 * Widening rings, each a superset of the last: serving a chain now, reachable
 * at all, switched on in the catalogue, known to exist.
 */
function inScope(g: CompareGroup, scope: Scope): boolean {
  switch (scope) {
    case 'routed': return g.chains.length > 0
    case 'keyed': return (g.keyedMembers ?? 0) > 0
    case 'enabled': return g.enabledMembers > 0
    case 'all': return true
  }
}

const METRICS: { key: Metric; labelKey: string }[] = [
  { key: 'intelligenceIndex', labelKey: 'compare.intelligence' },
  { key: 'codingIndex', labelKey: 'compare.coding' },
  { key: 'agenticIndex', labelKey: 'compare.agentic' },
]

export default function CompareModelsPage() {
  const { t } = useI18n()
  const queryClient = useQueryClient()
  const [keyDraft, setKeyDraft] = useState('')
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [metric, setMetric] = useState<Metric>('intelligenceIndex')
  // What "available" means, said out loud. The page used to offer one toggle
  // between "in a chain" and "switched on", and neither answers the question
  // that decides whether a model can serve at all: do we hold a key for its
  // provider. On this install 510 of 588 models sit on providers we have no
  // key for — enabled, ranked, merged, and unreachable.
  const [scope, setScope] = useState<Scope>('routed')
  const [query, setQuery] = useState('')

  const { data, isLoading } = useQuery<ComparePayload>({
    queryKey: ['analysis', 'compare'],
    queryFn: () => apiFetch('/api/analysis/compare'),
  })
  // The condensed view: one entry per group, one per ungrouped model. Grouping
  // is manual, so this is a second read rather than something derivable here.
  const { data: grouped } = useQuery<{ groups: CompareGroup[] }>({
    queryKey: ['analysis', 'grouped'],
    queryFn: () => apiFetch('/api/analysis/grouped'),
  })
  const invalidate = () => queryClient.invalidateQueries({ queryKey: ['analysis'] })

  const saveKey = useMutation({
    mutationFn: (key: string) => apiFetch('/api/analysis/key', { method: 'PUT', body: JSON.stringify({ key }) }),
    onSuccess: () => { setKeyDraft(''); invalidate() },
  })
  const clearKey = useMutation({
    mutationFn: () => apiFetch('/api/analysis/key', { method: 'DELETE' }),
    onSuccess: invalidate,
  })
  const sync = useMutation({
    mutationFn: () => apiFetch<{ ok: boolean; fetched: number; linked: number; unmatched: number; error?: string }>(
      '/api/analysis/sync', { method: 'POST' }),
    onSuccess: result => {
      if (result.ok) toast.success(t('compare.syncDone', { fetched: result.fetched, linked: result.linked }))
      invalidate()
    },
    meta: { silenceToast: false },
  })
  // Map a whole entry in one write. A merged entry is one logical model, so
  // "this is Kimi K3" is one decision about it, not one decision per provider
  // route — and a per-route control would let the copies disagree, which is
  // exactly the `conflicted` state this page already has to warn about.
  const link = useMutation({
    mutationFn: (body: { models: { platform: string; modelId: string }[]; aaSlug: string | null }) =>
      apiFetch('/api/analysis/link', { method: 'PUT', body: JSON.stringify(body) }),
    onSuccess: invalidate,
  })

  // Baselines: models we do not serve, kept on the page so our own numbers mean
  // something. They flow through sorting and the chart as memberless entries.
  const { data: references } = useQuery<{ slugs: string[]; groups: CompareGroup[] }>({
    queryKey: ['analysis', 'references'],
    queryFn: () => apiFetch('/api/analysis/references'),
  })
  const referenceMutation = useMutation({
    mutationFn: (slugs: string[]) =>
      apiFetch('/api/analysis/references', { method: 'PUT', body: JSON.stringify({ slugs }) }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['analysis'] }),
  })
  const referenceSlugs = references?.slugs ?? []
  const addReference = (slug: string) => referenceMutation.mutate([...referenceSlugs, slug])
  const removeReference = (slug: string) => referenceMutation.mutate(referenceSlugs.filter(s => s !== slug))

  // One model in or out of its provider key's scope. The Compare table can see
  // that a route is unreachable only because the key does not name it; this is
  // the edit that fixes it without leaving the row.
  const keyScope = useMutation({
    mutationFn: (body: { platform: string; modelId: string; allow: boolean }) =>
      apiFetch('/api/analysis/key-scope', { method: 'PUT', body: JSON.stringify(body) }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['analysis'] }),
  })

  // What each provider serves and how much of it our key permits. Built from
  // the whole payload, not the visible rows: hovering a dot asks about the
  // provider, and answering with "the models that happen to be on screen" would
  // be a different, misleading question.
  const platformScopes = useMemo(() => {
    const map = new Map<string, PlatformScope>()
    for (const r of data?.rows ?? []) {
      const e = map.get(r.platform) ?? { inScope: [], outOfScope: [], noKey: [] }
      if (r.keyScope === 'none' || r.keyScope === 'disabled') e.noKey.push(r.modelId)
      else if (r.keyScope === 'out') e.outOfScope.push(r.modelId)
      else e.inScope.push(r.modelId)
      map.set(r.platform, e)
    }
    return map
  }, [data?.rows])

  // One state per platform; every route on a platform shares its key situation.
  const platformKeyStates = useMemo(() => {
    const map = new Map<string, CompareRow['keyScope']>()
    for (const r of data?.rows ?? []) if (!map.has(r.platform)) map.set(r.platform, r.keyScope)
    return map
  }, [data?.rows])

  const status = data?.status

  const entryKey = (g: CompareGroup) => g.groupKey

  // Condensed entries: one per group, one per ungrouped model. The catalogue is
  // 589 rows and most are switched off, so comparing all of them buries the
  // ones in use.
  // Measured intelligence first: the reason to open this page is to see what
  // the benchmarks say, and the payload order is the router's, not a ranking.
  const [sort, setSort] = useState<{ key: SortKey; dir: 'asc' | 'desc' }>({ key: 'intelligenceIndex', dir: 'desc' })
  // Second click reverses; moving to a new column starts descending, except for
  // the three where "low is good" (name A-Z, latency, price).
  const sortBy = (key: SortKey) =>
    setSort(prev => prev.key === key
      ? { key, dir: prev.dir === 'desc' ? 'asc' : 'desc' }
      : { key, dir: key === 'name' || key === 'latency' || key === 'price' ? 'asc' : 'desc' })

  const entries = useMemo(
    () => sortEntries(
      [
        // References are never filtered out by "only routed": the whole point
        // is that they sit beside our models wherever those land.
        ...(references?.groups ?? []),
        // Baselines are never searched away: they are the thing being compared
        // against, and a filtered table with no yardstick left is worse.
        ...(grouped?.groups ?? []).filter(g => inScope(g, scope) && matchesCompareQuery(g, query)),
      ],
      sort.key,
      sort.dir,
    ),
    [grouped, references, scope, sort, query],
  )
  const chosen = useMemo(
    () => entries.filter(g => selected.has(entryKey(g))),
    [entries, selected],
  )
  // Nothing picked reads as "compare everything visible", which is more useful
  // than an empty chart.
  const comparing = chosen.length > 0 ? chosen : entries

  const scored = useMemo(
    () => comparing
      .filter(g => g.analysis?.[metric] != null)
      .sort((a, b) => (b.analysis![metric] as number) - (a.analysis![metric] as number)),
    [comparing, metric],
  )
  const peak = scored.length > 0 ? (scored[0].analysis![metric] as number) : 0
  const unscored = comparing.filter(g => g.analysis?.[metric] == null)

  const toggle = (key: string) => {
    setSelected(prev => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }


  return (
    <div className="space-y-6">
      <PageHeader
        title={t('compare.pageTitle')}
        description={t('compare.pageDescription')}
        actions={
          status?.configured && !status.unreadable
            ? (
              <Button size="sm" variant="outline" onClick={() => sync.mutate()} disabled={sync.isPending}>
                <RefreshCw className={`size-3.5 ${sync.isPending ? 'animate-spin' : ''}`} />
                {t('compare.sync')}
              </Button>
            )
            : undefined
        }
      />

      {/* The key. Kept on this page rather than in Settings because it is
          useless anywhere else, and this is where its absence is felt. */}
      <section className="rounded-xl border p-4">
        <h2 className="text-sm font-medium">{t('compare.keyTitle')}</h2>
        <p className="mt-1 text-xs text-muted-foreground">{t('compare.keyHint')}</p>
        {status?.unreadable && (
          <p className="mt-2 text-xs text-destructive">{t('compare.keyUnreadable')}</p>
        )}
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <Input
            type="password"
            value={keyDraft}
            onChange={e => setKeyDraft(e.target.value)}
            placeholder={status?.configured ? t('compare.keyReplace') : t('compare.keyPlaceholder')}
            className="h-8 w-[280px] text-xs"
          />
          <Button size="sm" disabled={keyDraft.trim().length < 8 || saveKey.isPending} onClick={() => saveKey.mutate(keyDraft)}>
            {t('common.save')}
          </Button>
          {status?.configured && (
            <Button size="sm" variant="ghost" onClick={() => clearKey.mutate()} disabled={clearKey.isPending}>
              {t('common.remove')}
            </Button>
          )}
          {status && (
            <span className="ml-auto flex flex-wrap items-center gap-2 text-[11px] text-muted-foreground">
              {status.tier && <Badge variant="secondary">{status.tier}</Badge>}
              {status.indexVersion && <Badge variant="outline">{status.indexVersion}</Badge>}
              <span className="tabular-nums">
                {t('compare.cacheState', { cached: status.cachedModels, linked: status.linkedModels })}
              </span>
              {/* Their quota is a fixed 100/day on Free, shared across the
                  organisation — worth seeing before pressing Refresh again. */}
              {status.rateLimit?.remaining != null && (
                <span className="tabular-nums">
                  {t('compare.quota', { remaining: status.rateLimit.remaining, limit: status.rateLimit.limit ?? 0 })}
                </span>
              )}
            </span>
          )}
        </div>
        {status?.lastError && <p className="mt-2 text-xs text-destructive">{status.lastError}</p>}
      </section>

      {!isLoading && status?.cachedModels === 0 && (
        <p className="text-xs text-muted-foreground">{t('compare.empty')}</p>
      )}

      {status != null && status.cachedModels > 0 && (
        <>
          <section className="rounded-xl border p-4">
            <div className="flex flex-wrap items-center gap-2">
              <Scale className="size-4 text-muted-foreground" />
              <h2 className="text-sm font-medium">{t('compare.chartTitle')}</h2>
              <div className="ml-auto flex flex-wrap items-center gap-1">
                {METRICS.map(m => (
                  <button
                    key={m.key}
                    type="button"
                    onClick={() => setMetric(m.key)}
                    className={`rounded-full border px-2 py-0.5 text-[11px] ${metric === m.key ? 'bg-muted' : 'hover:bg-muted/50'}`}
                  >
                    {t(m.labelKey)}
                  </button>
                ))}
                <span className="ml-2">
                  <ModelCombobox
                    value=""
                    options={(data?.catalogue ?? [])
                      .filter(c => !referenceSlugs.includes(c.slug))
                      .map(c => ({
                        value: c.slug,
                        label: c.name,
                        sub: c.intelligenceIndex == null ? (c.creator ?? undefined) : c.intelligenceIndex.toFixed(0),
                        platforms: c.creator ? [c.creator] : undefined,
                      }))}
                    onSelect={addReference}
                    ariaLabel={t('compare.referenceAdd')}
                    placeholder={t('compare.mapSearchPlaceholder')}
                    emptyText={t('compare.mapNoResults')}
                    triggerPlaceholder={t('compare.referenceAdd')}
                    triggerClassName="h-6 max-w-[190px] text-[11px]"
                    align="start"
                  />
                </span>
                {/* Counted from the same predicate that filters, so a label
                    can never disagree with the list under it. */}
                {SCOPES.map(sc => {
                  const count = (grouped?.groups ?? []).filter(g => inScope(g, sc.key)).length
                  return (
                    <button
                      key={sc.key}
                      type="button"
                      onClick={() => setScope(sc.key)}
                      title={t(sc.hintKey)}
                      className={`ml-1 rounded-full border px-2 py-0.5 text-[11px] ${scope === sc.key ? 'bg-muted' : 'hover:bg-muted/50'}`}
                    >
                      {t(sc.labelKey)} <span className="tabular-nums text-muted-foreground">{count}</span>
                    </button>
                  )
                })}
              </div>
            </div>

            <ul className="mt-3 space-y-1">
              {scored.map(g => {
                const value = g.analysis![metric] as number
                return (
                  <li key={entryKey(g)} className={`flex items-center gap-2 text-xs ${g.reference ? 'text-sky-700 dark:text-sky-300' : ''}`}>
                    {/* Name first, dots after it. Leading with a variable
                        number of swatches started every name at a different
                        offset, so the column could not be read down. */}
                    <span className="w-[200px] flex-shrink-0 truncate" title={g.members.map(m => m.modelId).join('\n')}>
                      {g.name}
                      {g.members.length > 1 && (
                        <span className="ml-1 text-muted-foreground tabular-nums">{`×${g.members.length}`}</span>
                      )}
                    </span>
                    <span className="flex w-[70px] flex-shrink-0 items-center gap-0.5">
                      {[...new Map(g.members.map(m => [m.platform, m])).values()].slice(0, 7).map(m => (
                        <PlatformDot key={m.platform} platform={m.platform} hasKey={m.hasKey} scope={platformScopes.get(m.platform)} />
                      ))}
                    </span>
                    <div className="h-3 min-w-0 flex-1 rounded bg-muted">
                      {/* Scaled to the best model on screen, not to 100: the
                          indices are not percentages and the gap between the
                          top few is what a reader is looking for. */}
                      <div
                        className={`h-3 rounded ${g.reference ? 'bg-sky-500/70' : 'bg-emerald-500/70'}`}
                        style={{ width: peak > 0 ? `${Math.max((value / peak) * 100, 2)}%` : '2%' }}
                      />
                    </div>
                    <span className="w-12 flex-shrink-0 text-right tabular-nums">{value.toFixed(1)}</span>
                  </li>
                )
              })}
            </ul>
            {unscored.length > 0 && (
              <p className="mt-2 text-[11px] text-muted-foreground">
                {t('compare.notMeasured', { count: unscored.length })}
              </p>
            )}
          </section>

          <section className="rounded-xl border p-4">
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="text-sm font-medium">{t('compare.tableTitle')}</h2>
            </div>
            <p className="mt-1 text-xs text-muted-foreground">{t('compare.tableHint')}</p>
            <div className="mt-2 flex items-center gap-2">
              <input
                value={query}
                onChange={e => setQuery(e.target.value)}
                placeholder={t('compare.searchPlaceholder')}
                aria-label={t('compare.searchPlaceholder')}
                className="h-7 w-[260px] rounded border bg-background px-2 text-[11px]"
              />
              {query && (
                <button
                  type="button"
                  onClick={() => setQuery('')}
                  className="rounded-full border px-2 py-0.5 text-[11px] hover:bg-muted/50"
                >
                  {t('models.clearFilters')}
                </button>
              )}
              <span className="text-[11px] text-muted-foreground tabular-nums">
                {t('compare.showingCount', { shown: entries.length })}
              </span>
            </div>
            <div className="mt-2">
              <PlatformLegend
                platforms={[...new Set(entries.flatMap(g => g.members.map(m => m.platform)))].sort()}
                keyed={new Set(entries.flatMap(g => g.members.filter(m => m.hasKey).map(m => m.platform)))}
                scopes={platformScopes}
                keyStates={platformKeyStates}
              />
            </div>
            <Table className="mt-3">
              <TableHeader>
                <TableRow>
                  <TableHead />
                  <SortHead sort={sort} onSort={sortBy} col="name">{t('compare.colModel')}</SortHead>
                  <SortHead sort={sort} onSort={sortBy} col="chains">{t('compare.colChains')}</SortHead>
                  <SortHead sort={sort} onSort={sortBy} col="intelligenceIndex" right>{t('compare.intelligence')}</SortHead>
                  <SortHead sort={sort} onSort={sortBy} col="codingIndex" right>{t('compare.coding')}</SortHead>
                  <SortHead sort={sort} onSort={sortBy} col="agenticIndex" right>{t('compare.agentic')}</SortHead>
                  <SortHead sort={sort} onSort={sortBy} col="speed" right>{t('compare.colSpeed')}</SortHead>
                  <SortHead sort={sort} onSort={sortBy} col="latency" right>{t('compare.colLatency')}</SortHead>
                  <SortHead sort={sort} onSort={sortBy} col="price" right>{t('compare.colPrice')}</SortHead>
                  <SortHead sort={sort} onSort={sortBy} col="context" right>{t('compare.colContext')}</SortHead>
                  <SortHead sort={sort} onSort={sortBy} col="ourRank" right>{t('compare.colOurRank')}</SortHead>
                  <TableHead>{t('compare.colMatch')}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {entries.map(g => {
                  const solo = g.members.length === 1 ? g.members[0] : null
                  return (
                    <TableRow key={entryKey(g)} className={`group/row ${g.reference ? 'bg-sky-500/5' : ''}`}>
                      <TableCell>
                        {g.reference
                          ? (
                            <Tooltip text={t('compare.referenceRemove')}>
                              <Button
                                variant="ghost"
                                size="icon-xs"
                                aria-label={t('compare.referenceRemove')}
                                onClick={() => removeReference(g.analysis?.slug ?? '')}
                              >×</Button>
                            </Tooltip>
                          )
                          : (
                            <input
                              type="checkbox"
                              checked={selected.has(entryKey(g))}
                              onChange={() => toggle(entryKey(g))}
                              aria-label={g.name}
                              className="size-3.5 accent-foreground"
                            />
                          )}
                      </TableCell>
                      <TableCell>
                        {/* Name first, dots underneath. Leading the row with a
                            variable number of provider swatches indented every
                            name differently, so the column could not be read
                            down. */}
                        <span className="flex flex-wrap items-center gap-1.5">
                          <span className="max-w-[175px] truncate font-medium" title={g.name}>{g.name}</span>
                          {/* Routes the platform holds a key for that the key
                              does not name. One press each way, because this is
                              the difference between a model being unreachable
                              and being usable. */}
                          {/* Several routes is several decisions — a generous
                              free tier and a 10-cent trial are not one — so the
                              picker lists them. One route needs no choosing. */}
                          {!g.reference && g.members.some(m => m.keyScope === 'out') && (
                            <ScopePicker
                              allow
                              disabled={keyScope.isPending}
                              routes={g.members.filter(m => m.keyScope === 'out').map(m => ({ platform: m.platform, modelId: m.modelId }))}
                              onApply={rs => rs.forEach(r => keyScope.mutate({ ...r, allow: true }))}
                            />
                          )}
                          {!g.reference && g.members.some(m => m.keyScope === 'in') && (
                            <ScopePicker
                              allow={false}
                              disabled={keyScope.isPending}
                              routes={g.members.filter(m => m.keyScope === 'in').map(m => ({ platform: m.platform, modelId: m.modelId }))}
                              onApply={rs => rs.forEach(r => keyScope.mutate({ ...r, allow: false }))}
                            />
                          )}
                          {g.reference && (
                            <Badge variant="secondary" className="bg-sky-500/15 text-[10px] text-sky-700 dark:text-sky-300">
                              {t('compare.referenceBadge')}
                            </Badge>
                          )}
                          {/* The routes live in a tooltip, not inline. Printed
                              in the cell, seven `platform/modelId` pairs made
                              this column 1584px wide inside a 1070px container
                              and pushed every measured number off-screen. */}
                          {/* A baseline has no routes at all, so neither the id
                              nor a "0 routes" badge says anything true. */}
                          {g.reference
                            ? null
                            : solo
                            ? (
                              <code className="max-w-[150px] truncate text-[11px] text-muted-foreground" title={solo.modelId}>
                                {solo.modelId}
                              </code>
                            )
                            : (
                              <Tooltip text={g.members.map(m => `${m.platform}/${m.modelId}`).join('\n')}>
                                <Badge variant="secondary" className="text-[10px] tabular-nums">
                                  {t('compare.routeCount', { count: g.members.length })}
                                </Badge>
                              </Tooltip>
                            )}
                          {g.conflicted && (
                            <Tooltip text={t('compare.conflictHint')}>
                              <span className="text-[11px] text-destructive">{t('compare.conflict')}</span>
                            </Tooltip>
                          )}
                        </span>
                        {/* Hollow dot = this provider serves the model and we
                            hold no key for it, so the dot links to the Keys page
                            with the provider preselected. */}
                        <span className="mt-0.5 flex flex-wrap items-center gap-1">
                          {[...new Map(g.members.map(m => [m.platform, m])).values()].map(m => (
                            <PlatformDot
                              key={m.platform}
                              platform={m.platform}
                              hasKey={m.hasKey}
                              scope={platformScopes.get(m.platform)}
                              keyState={platformKeyStates.get(m.platform)}
                              linkToKeys
                            />
                          ))}
                        </span>
                      </TableCell>
                      <TableCell className="max-w-[120px] truncate text-[11px] text-muted-foreground" title={g.chains.join(', ')}>
                        {g.chains.join(', ') || '–'}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">{score(g.analysis?.intelligenceIndex)}</TableCell>
                      <TableCell className="text-right tabular-nums">{score(g.analysis?.codingIndex)}</TableCell>
                      <TableCell className="text-right tabular-nums">{score(g.analysis?.agenticIndex)}</TableCell>
                      {/* Measured by Artificial Analysis, so they are blank
                          exactly where the scores are: an unmapped row shows
                          dashes rather than inventing a number from our own
                          catalogue. Context is ours — it comes from the routes. */}
                      <TableCell className="text-right tabular-nums" title={t('compare.speedHint')}>
                        {stat(g.analysis?.medianOutputTokensPerSecond, 0)}
                      </TableCell>
                      <TableCell className="text-right tabular-nums" title={t('compare.latencyHint')}>
                        {stat(g.analysis?.medianTimeToFirstTokenSeconds, 2)}
                      </TableCell>
                      <TableCell className="text-right tabular-nums text-[11px]" title={t('compare.priceHint')}>
                        {price(g.analysis?.price1mInput, g.analysis?.price1mOutput)}
                      </TableCell>
                      <TableCell className="text-right tabular-nums text-[11px] text-muted-foreground">
                        {context(g.members)}
                      </TableCell>
                      <TableCell className="text-right tabular-nums text-muted-foreground">
                        {solo ? solo.intelligenceRank : '–'}
                      </TableCell>
                      <TableCell>
                        {/* Every entry is mappable, merged or not. A merged
                            entry used to report "inherited" with no way to act
                            on it, so a group the matcher got wrong — or never
                            matched — could not be corrected at all. */}
                        {/* A reference IS the benchmark, so there is nothing to
                            map it to. */}
                        {g.reference
                          ? <span className="text-[11px] text-muted-foreground">{t('compare.referenceSource')}</span>
                          : <MappingCell
                          members={g.members}
                          catalogue={data?.catalogue ?? []}
                          onLink={slug => link.mutate({
                            models: g.members.map(m => ({ platform: m.platform, modelId: m.modelId })),
                            aaSlug: slug,
                          })}
                        />}
                      </TableCell>
                    </TableRow>
                  )
                })}
              </TableBody>
            </Table>
          </section>
        </>
      )}

      {/* Required by the Artificial Analysis terms of use wherever their data
          is displayed. */}
      <p className="text-[11px] text-muted-foreground">
        {t('compare.attribution')}{' '}
        <a
          href="https://artificialanalysis.ai"
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-1 underline underline-offset-2"
        >
          Artificial Analysis
          <ExternalLink className="size-3" />
        </a>
      </p>
    </div>
  )
}

/** The combobox works in option values, so "no counterpart" needs one of its
 *  own — an empty string would read as "nothing picked yet", and those are
 *  different answers (see the manual-none label). */
const NO_COUNTERPART = '__none__'

/**
 * A sortable column header. `aria-sort` is what makes the current column and
 * direction readable without seeing the arrow.
 */
function SortHead({ col, sort, onSort, right, children }: {
  col: SortKey
  sort: { key: SortKey; dir: 'asc' | 'desc' }
  onSort: (key: SortKey) => void
  right?: boolean
  children: ReactNode
}) {
  const active = sort.key === col
  return (
    <TableHead
      className={right ? 'text-right' : undefined}
      aria-sort={active ? (sort.dir === 'asc' ? 'ascending' : 'descending') : 'none'}
    >
      <button
        type="button"
        onClick={() => onSort(col)}
        className={`inline-flex items-center gap-0.5 hover:text-foreground ${active ? 'text-foreground' : ''}`}
      >
        {children}
        <span className="text-[9px]">{active ? (sort.dir === 'asc' ? '▲' : '▼') : ''}</span>
      </button>
    </TableHead>
  )
}

/** Compact numeric stat; a dash where the measurement is absent. */
function stat(value: number | null | undefined, digits: number) {
  return value == null ? <span className="text-muted-foreground">–</span> : value.toFixed(digits)
}

/** Input/output price per million tokens. Free routes really do read 0. */
function price(input: number | null | undefined, output: number | null | undefined) {
  if (input == null && output == null) return <span className="text-muted-foreground">–</span>
  const fmt = (v: number | null | undefined) => (v == null ? '?' : v < 1 ? v.toFixed(2) : v.toFixed(1))
  return <span>{fmt(input)}/{fmt(output)}</span>
}

/** The widest context any route of this entry offers — what you would actually
 *  get, since the router can serve the request from any of them. */
function context(members: CompareRow[]) {
  const max = members.reduce((m, r) => Math.max(m, r.contextWindow ?? 0), 0)
  if (max === 0) return <span className="text-muted-foreground">–</span>
  return max >= 1000 ? `${Math.round(max / 1000)}K` : String(max)
}

/** A dash, not a zero: their nulls mean "not measured". */
function score(value: number | null | undefined) {
  return value == null ? <span className="text-muted-foreground">–</span> : value.toFixed(1)
}

/**
 * How this row is mapped, and the control to change it.
 *
 * A select rather than a search box: the cache is a few hundred slugs, sorted
 * by index so the plausible candidates are near the top, and a native select
 * is keyboard- and mobile-navigable for free.
 */
function MappingCell({ members, catalogue, onLink }: {
  members: CompareRow[]
  catalogue: ComparePayload['catalogue']
  onLink: (slug: string | null) => void
}) {
  const { t } = useI18n()
  const [editing, setEditing] = useState(false)

  // Read the state off the routes themselves. The group's own `analysisSource`
  // says "inherited" whenever the score reaches it through a member, which is
  // true even when every member was mapped by hand a second ago — reporting
  // that would hide the operator's own decision back from them.
  const slugs = new Set(members.map(m => m.link?.slug ?? null))
  const common = slugs.size === 1 ? [...slugs][0] : null
  const linked = members.filter(m => m.link != null)
  const allManual = linked.length === members.length && members.every(m => m.link?.source === 'manual')
  const unresolved = members.find(m => m.link?.unresolved)
  const scored = members.find(m => m.analysis != null)

  const label = () => {
    if (unresolved) {
      return <span className="text-destructive">{t('compare.matchUnresolved', { slug: unresolved.link?.slug ?? '' })}</span>
    }
    // Mapped by hand to nothing: a decision, and one worth showing, or the row
    // reads identically to one nobody has looked at.
    if (allManual && common === null) return <span>{t('compare.matchManualNone')}</span>
    if (!scored?.analysis) return <span className="text-muted-foreground">{t('compare.matchNone')}</span>

    // WHICH benchmark, not just how it was found. "matched by slug" alone is
    // unverifiable — the whole point of an automatic match is that it can be
    // wrong, and you cannot see that it is wrong without seeing what it picked.
    const their = scored.analysis
    const how = allManual
      ? t('compare.matchManual')
      : members.length > 1 && linked.length < members.length
        ? t('compare.matchInherited')
        : t('compare.matchAuto', { reason: scored.link?.matchReason ?? '' })
    return (
      <Tooltip text={t('compare.matchedToHint', {
        name: their.name,
        slug: their.slug,
        creator: their.creator ?? '?',
        how,
        model: `${scored.platform}/${scored.modelId}`,
      })}>
        <span className="flex max-w-[118px] flex-col items-start">
          <span className={`w-full truncate ${allManual ? '' : 'text-muted-foreground'}`}>{their.name}</span>
          <span className="w-full truncate text-[10px] text-muted-foreground">{how}</span>
        </span>
      </Tooltip>
    )
  }

  if (!editing) {
    return (
      <button
        type="button"
        onClick={() => setEditing(true)}
        className="text-left text-[11px] underline decoration-dotted underline-offset-2 hover:text-foreground"
      >
        {label()}
      </button>
    )
  }

  // Searchable, not a 646-option native select: picking "Kimi K3" out of every
  // model Artificial Analysis publishes meant scrolling an alphabetical list.
  // The dashboard already has one searchable model picker, so this is that one
  // rather than a second control that behaves almost the same.
  const options: ModelComboOption[] = [
    { value: NO_COUNTERPART, label: t('compare.matchNoneOption') },
    ...catalogue.map(c => ({
      value: c.slug,
      label: c.name,
      // Creator is searchable too, so "google" finds the Gemini family.
      sub: c.intelligenceIndex == null ? (c.creator ?? undefined) : `${c.intelligenceIndex.toFixed(0)}`,
      platforms: c.creator ? [c.creator] : undefined,
    })),
  ]

  return (
    <span className="flex items-center gap-1">
      <ModelCombobox
        value={common ?? NO_COUNTERPART}
        options={options}
        onSelect={slug => { onLink(slug === NO_COUNTERPART ? null : slug); setEditing(false) }}
        ariaLabel={t('compare.mapAriaLabel')}
        placeholder={t('compare.mapSearchPlaceholder')}
        emptyText={t('compare.mapNoResults')}
        triggerPlaceholder={t('compare.matchNoneOption')}
        triggerClassName="h-7 max-w-[200px] text-[11px]"
        align="end"
      />
      {members.length > 1 && (
        <span className="text-[10px] text-muted-foreground">{t('compare.appliesToRoutes', { count: members.length })}</span>
      )}
      <Tooltip text={t('common.cancel')}>
        <Button variant="ghost" size="icon-xs" onClick={() => setEditing(false)} aria-label={t('common.cancel')}>×</Button>
      </Tooltip>
    </span>
  )
}
