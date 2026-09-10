import { useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ExternalLink, RefreshCw, Scale } from 'lucide-react'
import { useI18n } from '@/i18n'
import { apiFetch } from '@/lib/api'
import { toast } from '@/lib/toast'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { PageHeader } from '@/components/page-header'
import { PlatformDot } from '@/components/platform-dot'
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
  link: { slug: string | null; source: 'auto' | 'manual'; matchReason: string | null; unresolved: boolean } | null
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
  const [onlyRouted, setOnlyRouted] = useState(true)

  const { data, isLoading } = useQuery<ComparePayload>({
    queryKey: ['analysis', 'compare'],
    queryFn: () => apiFetch('/api/analysis/compare'),
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
  const link = useMutation({
    mutationFn: (body: { platform: string; modelId: string; aaSlug: string | null }) =>
      apiFetch('/api/analysis/link', { method: 'PUT', body: JSON.stringify(body) }),
    onSuccess: invalidate,
  })

  const status = data?.status
  const rows = data?.rows ?? []

  // Only models that can actually serve: the catalogue is 589 rows and most are
  // switched off, so comparing all of them buries the ones in use.
  const visible = useMemo(
    () => rows.filter(r => (onlyRouted ? r.chains.length > 0 : r.enabled)),
    [rows, onlyRouted],
  )
  const rowKey = (r: CompareRow) => `${r.platform}:${r.modelId}`
  const chosen = useMemo(
    () => visible.filter(r => selected.has(rowKey(r))),
    [visible, selected],
  )
  // Nothing picked reads as "compare everything visible", which is the more
  // useful default than an empty chart.
  const comparing = chosen.length > 0 ? chosen : visible

  const scored = useMemo(
    () => comparing
      .filter(r => r.analysis?.[metric] != null)
      .sort((a, b) => (b.analysis![metric] as number) - (a.analysis![metric] as number)),
    [comparing, metric],
  )
  const peak = scored.length > 0 ? (scored[0].analysis![metric] as number) : 0
  const unscored = comparing.filter(r => r.analysis?.[metric] == null)

  const toggle = (r: CompareRow) => {
    setSelected(prev => {
      const next = new Set(prev)
      const k = rowKey(r)
      if (next.has(k)) next.delete(k)
      else next.add(k)
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
                <button
                  type="button"
                  onClick={() => setOnlyRouted(o => !o)}
                  className={`ml-2 rounded-full border px-2 py-0.5 text-[11px] ${onlyRouted ? 'bg-muted' : 'hover:bg-muted/50'}`}
                >
                  {t('compare.onlyRouted')}
                </button>
              </div>
            </div>

            <ul className="mt-3 space-y-1">
              {scored.map(r => {
                const value = r.analysis![metric] as number
                return (
                  <li key={rowKey(r)} className="flex items-center gap-2 text-xs">
                    <PlatformDot platform={r.platform} />
                    <span className="w-[220px] flex-shrink-0 truncate" title={r.modelId}>{r.displayName}</span>
                    <div className="h-3 min-w-0 flex-1 rounded bg-muted">
                      {/* Scaled to the best model on screen, not to 100: the
                          indices are not percentages and the gap between the
                          top few is what a reader is looking for. */}
                      <div
                        className="h-3 rounded bg-emerald-500/70"
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
            <h2 className="text-sm font-medium">{t('compare.tableTitle')}</h2>
            <p className="mt-1 text-xs text-muted-foreground">{t('compare.tableHint')}</p>
            <Table className="mt-3">
              <TableHeader>
                <TableRow>
                  <TableHead />
                  <TableHead>{t('compare.colModel')}</TableHead>
                  <TableHead>{t('compare.colChains')}</TableHead>
                  <TableHead className="text-right">{t('compare.intelligence')}</TableHead>
                  <TableHead className="text-right">{t('compare.coding')}</TableHead>
                  <TableHead className="text-right">{t('compare.agentic')}</TableHead>
                  <TableHead className="text-right">{t('compare.colOurRank')}</TableHead>
                  <TableHead>{t('compare.colMatch')}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {visible.map(r => (
                  <TableRow key={rowKey(r)}>
                    <TableCell>
                      <input
                        type="checkbox"
                        checked={selected.has(rowKey(r))}
                        onChange={() => toggle(r)}
                        aria-label={r.modelId}
                        className="size-3.5 accent-foreground"
                      />
                    </TableCell>
                    <TableCell>
                      <span className="flex items-center gap-1.5">
                        <PlatformDot platform={r.platform} />
                        <span className="font-medium">{r.displayName}</span>
                        <code className="text-[11px] text-muted-foreground">{r.modelId}</code>
                      </span>
                    </TableCell>
                    <TableCell className="text-[11px] text-muted-foreground">
                      {r.chains.join(', ') || '–'}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">{score(r.analysis?.intelligenceIndex)}</TableCell>
                    <TableCell className="text-right tabular-nums">{score(r.analysis?.codingIndex)}</TableCell>
                    <TableCell className="text-right tabular-nums">{score(r.analysis?.agenticIndex)}</TableCell>
                    <TableCell className="text-right tabular-nums text-muted-foreground">{r.intelligenceRank}</TableCell>
                    <TableCell>
                      <MappingCell
                        row={r}
                        catalogue={data?.catalogue ?? []}
                        onLink={slug => link.mutate({ platform: r.platform, modelId: r.modelId, aaSlug: slug })}
                      />
                    </TableCell>
                  </TableRow>
                ))}
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
function MappingCell({ row, catalogue, onLink }: {
  row: CompareRow
  catalogue: ComparePayload['catalogue']
  onLink: (slug: string | null) => void
}) {
  const { t } = useI18n()
  const [editing, setEditing] = useState(false)
  const current = row.link?.slug ?? ''

  if (!editing) {
    return (
      <button
        type="button"
        onClick={() => setEditing(true)}
        className="text-left text-[11px] underline decoration-dotted underline-offset-2 hover:text-foreground"
      >
        {row.link?.unresolved
          ? <span className="text-destructive">{t('compare.matchUnresolved', { slug: row.link.slug ?? '' })}</span>
          : row.analysis
            ? (
              <span className={row.link?.source === 'manual' ? '' : 'text-muted-foreground'}>
                {row.link?.source === 'manual'
                  ? t('compare.matchManual')
                  : t('compare.matchAuto', { reason: row.link?.matchReason ?? '' })}
              </span>
            )
            : <span className="text-muted-foreground">{t('compare.matchNone')}</span>}
      </button>
    )
  }

  return (
    <span className="flex items-center gap-1">
      <select
        value={current}
        onChange={e => { onLink(e.target.value || null); setEditing(false) }}
        className="h-7 max-w-[220px] rounded border bg-background px-1 text-[11px]"
      >
        <option value="">{t('compare.matchNoneOption')}</option>
        {catalogue.map(c => (
          <option key={c.slug} value={c.slug}>
            {c.intelligenceIndex == null ? c.name : `${c.name} · ${c.intelligenceIndex.toFixed(0)}`}
          </option>
        ))}
      </select>
      <Tooltip text={t('common.cancel')}>
        <Button variant="ghost" size="icon-xs" onClick={() => setEditing(false)} aria-label={t('common.cancel')}>×</Button>
      </Tooltip>
    </span>
  )
}
