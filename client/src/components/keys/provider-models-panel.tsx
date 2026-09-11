import { useMemo, useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { apiFetch } from '@/lib/api'
import { Switch } from '@/components/ui/switch'
import { useI18n } from '@/i18n'
import { ModelCombobox } from '@/components/model-combobox'

// Every model this provider serves, with the measured scores beside the two
// switches that decide whether it can route. Lives inside the expanded provider
// group because that is where the comparison is actually made: "which of these
// eight should this key spend its allowance on" is a question about one
// provider's menu, and answering it used to mean holding the Compare page and
// the key's scope dialog in your head at once.

interface Row {
  modelDbId: number
  platform: string
  modelId: string
  displayName: string
  enabled: boolean
  contextWindow: number | null
  supportsTools: boolean
  supportsVision: boolean
  keyScope: 'none' | 'disabled' | 'unscoped' | 'in' | 'out'
  analysis: {
    slug: string
    name: string
    intelligenceIndex: number | null
    codingIndex: number | null
    agenticIndex: number | null
    medianOutputTokensPerSecond: number | null
  } | null
  link: {
    slug: string | null
    source: 'auto' | 'manual' | 'proxy'
    matchReason: string | null
    unresolved: boolean
    proxyDelta: { intelligence: number; coding: number; agentic: number; speed: number }
  } | null
}

interface CatalogueEntry {
  slug: string
  name: string
  creator: string | null
  intelligenceIndex: number | null
}

type SortKey = 'intelligence' | 'coding' | 'agentic' | 'speed' | 'name'

export function ProviderModelsPanel({ platform }: { platform: string }) {
  const { t } = useI18n()
  const queryClient = useQueryClient()
  const [sort, setSort] = useState<SortKey>('intelligence')
  const [onlyScoped, setOnlyScoped] = useState(false)

  // Shared cache with the Compare page: the scores, the scope state and the
  // enabled flag all come from one payload, so the two views cannot disagree.
  const { data, isLoading } = useQuery<{ rows: Row[]; catalogue: CatalogueEntry[] }>({
    queryKey: ['analysis', 'compare'],
    queryFn: () => apiFetch('/api/analysis/compare'),
  })

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: ['analysis'] })
    queryClient.invalidateQueries({ queryKey: ['models'] })
    queryClient.invalidateQueries({ queryKey: ['fallback'] })
  }

  // ONE switch, because the operator's question is "does this key route this
  // model", and answering it needed two: the catalogue flag and the key's
  // scope. They are still separate underneath — one is a judgement about the
  // model, the other is what the credential permits — but nothing is served by
  // making a reader hold both to decide one thing.
  //
  // An unscoped key has no per-model list to edit, so only the flag moves. A
  // scope edit that would empty the list is refused by the server (409); the
  // flag still lands, which is the half that matters.
  const setRoutable = useMutation({
    mutationFn: async ({ row, on }: { row: Row; on: boolean }) => {
      await apiFetch(`/api/models/${row.modelDbId}`, { method: 'PATCH', body: JSON.stringify({ enabled: on }) })
      if (row.keyScope === 'in' || row.keyScope === 'out') {
        await apiFetch('/api/analysis/key-scope', {
          method: 'PUT',
          body: JSON.stringify({ platform: row.platform, modelId: row.modelId, allow: on }),
        }).catch(() => { /* 409: unscoped key, or the last id — the flag stands */ })
      }
    },
    onSuccess: invalidate,
  })

  // Same endpoint the Compare page uses. Mapping here matters because the
  // scores in these columns are only as good as the match behind them: a row
  // reading "-" is unjudgeable, and the provider's own menu is where you notice
  // that one of its models never got matched.
  const link = useMutation({
    mutationFn: (body: { platform: string; modelId: string; aaSlug: string | null; proxy?: boolean }) =>
      apiFetch('/api/analysis/link', {
        method: 'PUT',
        body: JSON.stringify({
          models: [{ platform: body.platform, modelId: body.modelId }],
          aaSlug: body.aaSlug,
          proxy: body.proxy ?? false,
        }),
      }),
    onSuccess: invalidate,
  })
  const nudge = useMutation({
    mutationFn: (body: { platform: string; modelId: string; metric: ProxyMetric; delta: number }) =>
      apiFetch('/api/analysis/proxy-delta', { method: 'PUT', body: JSON.stringify(body) }),
    onSuccess: invalidate,
  })

  const rows = useMemo(() => {
    const mine = (data?.rows ?? []).filter(r => r.platform === platform)
    const value = (r: Row) =>
      sort === 'name' ? null
      : sort === 'speed' ? r.analysis?.medianOutputTokensPerSecond ?? null
      : sort === 'coding' ? r.analysis?.codingIndex ?? null
      : sort === 'agentic' ? r.analysis?.agenticIndex ?? null
      : r.analysis?.intelligenceIndex ?? null
    return [...mine]
      .filter(r => !onlyScoped || (r.enabled && (r.keyScope === 'in' || r.keyScope === 'unscoped')))
      // Unmeasured last in every ordering: a model with no score is not a zero.
      .sort((a, b) => {
        if (sort === 'name') return a.displayName.localeCompare(b.displayName)
        const x = value(a); const y = value(b)
        if (x == null && y == null) return a.displayName.localeCompare(b.displayName)
        if (x == null) return 1
        if (y == null) return -1
        return y - x || a.displayName.localeCompare(b.displayName)
      })
  }, [data?.rows, platform, sort, onlyScoped])

  if (isLoading) return <p className="px-3 py-2 text-xs text-muted-foreground">{t('common.loading')}</p>
  if (rows.length === 0) return <p className="px-3 py-2 text-xs text-muted-foreground">{t('keys.panelNoModels')}</p>

  const routable = (r: Row) => r.enabled && (r.keyScope === 'in' || r.keyScope === 'unscoped')
  const scoped = rows.filter(routable).length
  const busy = setRoutable.isPending

  return (
    <div className="mt-2 rounded-2xl border bg-card p-3">
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <span className="text-xs font-medium">{t('keys.panelTitle', { count: rows.length })}</span>
        <span className="text-[11px] text-muted-foreground tabular-nums">
          {t('keys.panelScopedCount', { scoped, total: rows.length })}
        </span>
        <span className="flex-1" />
        <button
          type="button"
          onClick={() => setOnlyScoped(v => !v)}
          aria-pressed={onlyScoped}
          className={`rounded-full border px-2 py-0.5 text-[10px] ${onlyScoped ? 'bg-muted' : 'hover:bg-muted/50'}`}
        >
          {t('keys.panelOnlyScoped')}
        </button>
      </div>

      <table className="w-full text-xs">
        <thead className="text-[10px] text-muted-foreground">
          <tr>
            <SortTh active={sort === 'name'} onClick={() => setSort('name')}>{t('keys.panelColModel')}</SortTh>
            <SortTh active={sort === 'intelligence'} onClick={() => setSort('intelligence')} right>{t('compare.intelligence')}</SortTh>
            <SortTh active={sort === 'coding'} onClick={() => setSort('coding')} right>{t('compare.coding')}</SortTh>
            <SortTh active={sort === 'agentic'} onClick={() => setSort('agentic')} right>{t('compare.agentic')}</SortTh>
            <SortTh active={sort === 'speed'} onClick={() => setSort('speed')} right>{t('compare.colSpeed')}</SortTh>
            <th className="py-1 pr-2 text-right font-normal">{t('compare.colContext')}</th>
            <th className="py-1 pr-2 text-left font-normal">{t('compare.colMatch')}</th>
            <th className="py-1 text-center font-normal">{t('keys.panelColEnabled')}</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(r => {
            return (
              <tr key={r.modelDbId} className="border-t">
                <td className="py-1 pr-2">
                  <span className="block max-w-[260px] truncate font-medium" title={r.displayName}>{r.displayName}</span>
                  <code className="block max-w-[260px] truncate text-[10px] text-muted-foreground" title={r.modelId}>{r.modelId}</code>
                </td>
                <Num v={r.analysis?.intelligenceIndex} row={r} metric="intelligence" onNudge={nudge.mutate} busy={busy} />
                <Num v={r.analysis?.codingIndex} row={r} metric="coding" onNudge={nudge.mutate} busy={busy} />
                <Num v={r.analysis?.agenticIndex} row={r} metric="agentic" onNudge={nudge.mutate} busy={busy} />
                <Num v={r.analysis?.medianOutputTokensPerSecond} digits={0} row={r} metric="speed" onNudge={nudge.mutate} busy={busy} />
                <td className="py-1 pr-2 text-right tabular-nums text-muted-foreground">
                  {r.contextWindow ? `${Math.round(r.contextWindow / 1000)}K` : '–'}
                </td>
                <td className="py-1 pr-2">
                  <MappingCell
                    row={r}
                    catalogue={data?.catalogue ?? []}
                    disabled={link.isPending || nudge.isPending}
                    onLink={(slug, proxy) => link.mutate({ platform: r.platform, modelId: r.modelId, aaSlug: slug, proxy })}
                  />
                </td>
                <td className="py-1 text-center">
                  <Switch
                    checked={routable(r)}
                    disabled={busy}
                    aria-label={t('keys.panelColEnabled')}
                    onCheckedChange={on => setRoutable.mutate({ row: r, on })}
                  />
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

function SortTh({ active, onClick, right, children }: {
  active: boolean
  onClick: () => void
  right?: boolean
  children: React.ReactNode
}) {
  return (
    <th className={`py-1 pr-2 font-normal ${right ? 'text-right' : 'text-left'}`} aria-sort={active ? 'descending' : 'none'}>
      <button type="button" onClick={onClick} className={active ? 'text-foreground' : 'hover:text-foreground'}>
        {children}{active ? ' ▼' : ''}
      </button>
    </th>
  )
}

/**
 * A score cell. A dash, not a zero: an absent measurement is not a score of
 * nothing.
 *
 * On a proxy the cell also carries its own adjustment, because a stand-in is
 * rarely uniformly close — it can code like its proxy and reason worse. At rest
 * that is one signed number, green up or red down and nothing when level; the
 * − and + appear on hover so the column stays readable.
 */
function Num({ v, digits = 1, row, metric, onNudge, busy }: {
  v: number | null | undefined
  digits?: number
  row?: Row
  metric?: ProxyMetric
  onNudge?: (body: { platform: string; modelId: string; metric: ProxyMetric; delta: number }) => void
  busy?: boolean
}) {
  const { t } = useI18n()
  const adjustable = row?.link?.source === 'proxy' && metric != null && onNudge != null && v != null
  const delta = adjustable ? row.link!.proxyDelta[metric] : 0

  return (
    <td className="group/num py-1 pr-2 text-right tabular-nums">
      <span className="inline-flex items-center justify-end gap-1">
        {adjustable && (
          <button
            type="button"
            disabled={busy}
            onClick={() => onNudge({ platform: row.platform, modelId: row.modelId, metric, delta: delta - 1 })}
            aria-label={t('keys.proxyNudgeDown')}
            hidden={delta <= -PROXY_DELTA_MAX}
            className="opacity-0 transition-opacity group-hover/num:opacity-100 focus-visible:opacity-100"
          >−</button>
        )}
        {v == null ? <span className="text-muted-foreground">–</span> : v.toFixed(digits)}
        {/* Signs, not a number: the scale is three coarse steps each way, and
            "+++" reads as a judgement where "+3" reads as a measurement. */}
        {delta !== 0 && (
          <span className={`text-[10px] font-medium ${delta > 0 ? 'text-emerald-600 dark:text-emerald-400' : 'text-rose-600 dark:text-rose-400'}`}>
            {(delta > 0 ? '+' : '−').repeat(Math.min(Math.abs(delta), PROXY_DELTA_MAX))}
          </span>
        )}
        {adjustable && (
          <button
            type="button"
            disabled={busy}
            onClick={() => onNudge({ platform: row.platform, modelId: row.modelId, metric, delta: delta + 1 })}
            aria-label={t('keys.proxyNudgeUp')}
            hidden={delta >= PROXY_DELTA_MAX}
            className="opacity-0 transition-opacity group-hover/num:opacity-100 focus-visible:opacity-100"
          >+</button>
        )}
      </span>
    </td>
  )
}

type ProxyMetric = 'intelligence' | 'coding' | 'agentic' | 'speed'

/** Matches the server's clamp; the two must not drift. */
const PROXY_DELTA_MAX = 3

/** The benchmark this route is matched to, and the control to change it. */
function MappingCell({ row, catalogue, onLink, disabled }: {
  row: Row
  catalogue: CatalogueEntry[]
  onLink: (slug: string | null, proxy: boolean) => void
  disabled?: boolean
}) {
  const { t } = useI18n()
  const [editing, setEditing] = useState(false)
  const [proxy, setProxy] = useState(false)
  const isProxy = row.link?.source === 'proxy'

  if (!editing) {
    return (
      <span className="flex items-center gap-1">
        <button
          type="button"
          onClick={() => { setProxy(isProxy); setEditing(true) }}
          className="max-w-[130px] truncate text-left text-[11px] underline decoration-dotted underline-offset-2 hover:text-foreground"
          title={row.analysis ? `${row.analysis.name} (${row.analysis.slug})` : undefined}
        >
          {row.link?.unresolved
            ? <span className="text-destructive">{t('compare.matchUnresolved', { slug: row.link.slug ?? '' })}</span>
            : row.analysis
              ? (
                <span className={row.link?.source === 'manual' ? '' : 'text-muted-foreground'}>
                  {isProxy ? '≈ ' : ''}{row.analysis.name}
                </span>
              )
              : <span className="text-muted-foreground">{t('compare.matchNone')}</span>}
        </button>
      </span>
    )
  }

  return (
    <span className="flex items-center gap-1">
      <ModelCombobox
        value={row.link?.slug ?? NO_COUNTERPART}
        options={[
          { value: NO_COUNTERPART, label: t('compare.matchNoneOption') },
          ...catalogue.map(c => ({
            value: c.slug,
            label: c.name,
            sub: c.intelligenceIndex == null ? (c.creator ?? undefined) : c.intelligenceIndex.toFixed(0),
            platforms: c.creator ? [c.creator] : undefined,
          })),
        ]}
        onSelect={slug => { onLink(slug === NO_COUNTERPART ? null : slug, proxy); setEditing(false) }}
        ariaLabel={t('compare.mapAriaLabel')}
        placeholder={t('compare.mapSearchPlaceholder')}
        emptyText={t('compare.mapNoResults')}
        triggerPlaceholder={t('compare.matchNoneOption')}
        triggerClassName="h-6 max-w-[160px] text-[11px]"
        ariaInvalid={false}
        align="start"
      />
      {/* Ticked BEFORE choosing: "closest thing to this" is a different claim
          from "this is that model", and the picker cannot tell which was meant. */}
      <label className="inline-flex items-center gap-1 text-[10px] text-muted-foreground" title={t('keys.proxyHint')}>
        <input type="checkbox" checked={proxy} onChange={e => setProxy(e.target.checked)} className="size-3 accent-foreground" />
        {t('keys.proxyLabel')}
      </label>
      <button type="button" onClick={() => setEditing(false)} disabled={disabled} aria-label={t('common.cancel')} className="text-muted-foreground">×</button>
    </span>
  )
}

/** "No counterpart" is a decision, so it needs a value of its own: an empty
 *  string would read as "nothing picked yet". */
const NO_COUNTERPART = '__none__'
