import { useMemo, useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { apiFetch } from '@/lib/api'
import { Switch } from '@/components/ui/switch'
import { Tooltip } from '@/components/tooltip'
import { useI18n } from '@/i18n'

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
    intelligenceIndex: number | null
    codingIndex: number | null
    agenticIndex: number | null
    medianOutputTokensPerSecond: number | null
  } | null
}

type SortKey = 'intelligence' | 'coding' | 'agentic' | 'speed' | 'name'

export function ProviderModelsPanel({ platform }: { platform: string }) {
  const { t } = useI18n()
  const queryClient = useQueryClient()
  const [sort, setSort] = useState<SortKey>('intelligence')
  const [onlyScoped, setOnlyScoped] = useState(false)

  // Shared cache with the Compare page: the scores, the scope state and the
  // enabled flag all come from one payload, so the two views cannot disagree.
  const { data, isLoading } = useQuery<{ rows: Row[] }>({
    queryKey: ['analysis', 'compare'],
    queryFn: () => apiFetch('/api/analysis/compare'),
  })

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: ['analysis'] })
    queryClient.invalidateQueries({ queryKey: ['models'] })
    queryClient.invalidateQueries({ queryKey: ['fallback'] })
  }

  const setScope = useMutation({
    mutationFn: (body: { platform: string; modelId: string; allow: boolean }) =>
      apiFetch('/api/analysis/key-scope', { method: 'PUT', body: JSON.stringify(body) }),
    onSuccess: invalidate,
  })
  const setEnabled = useMutation({
    mutationFn: (body: { id: number; enabled: boolean }) =>
      apiFetch(`/api/models/${body.id}`, { method: 'PATCH', body: JSON.stringify({ enabled: body.enabled }) }),
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
      .filter(r => !onlyScoped || r.keyScope === 'in' || r.keyScope === 'unscoped')
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

  const scoped = rows.filter(r => r.keyScope === 'in' || r.keyScope === 'unscoped').length
  const busy = setScope.isPending || setEnabled.isPending

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
            <th className="py-1 pr-2 text-center font-normal">{t('keys.panelColScope')}</th>
            <th className="py-1 text-center font-normal">{t('keys.panelColEnabled')}</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(r => {
            // An unscoped key permits everything, so there is no per-model
            // switch to offer: narrowing it is a decision about the KEY.
            const unscoped = r.keyScope === 'unscoped'
            const inScope = r.keyScope === 'in' || unscoped
            return (
              <tr key={r.modelDbId} className="border-t">
                <td className="py-1 pr-2">
                  <span className="block max-w-[260px] truncate font-medium" title={r.displayName}>{r.displayName}</span>
                  <code className="block max-w-[260px] truncate text-[10px] text-muted-foreground" title={r.modelId}>{r.modelId}</code>
                </td>
                <Num v={r.analysis?.intelligenceIndex} />
                <Num v={r.analysis?.codingIndex} />
                <Num v={r.analysis?.agenticIndex} />
                <Num v={r.analysis?.medianOutputTokensPerSecond} digits={0} />
                <td className="py-1 pr-2 text-right tabular-nums text-muted-foreground">
                  {r.contextWindow ? `${Math.round(r.contextWindow / 1000)}K` : '–'}
                </td>
                <td className="py-1 pr-2 text-center">
                  {unscoped ? (
                    <Tooltip text={t('keys.panelUnscopedHint')}>
                      <span className="text-[10px] text-muted-foreground">{t('keys.panelUnscoped')}</span>
                    </Tooltip>
                  ) : (
                    <Switch
                      checked={inScope}
                      disabled={busy}
                      aria-label={t('keys.panelColScope')}
                      onCheckedChange={checked =>
                        setScope.mutate({ platform: r.platform, modelId: r.modelId, allow: checked })}
                    />
                  )}
                </td>
                <td className="py-1 text-center">
                  <Switch
                    checked={r.enabled}
                    disabled={busy}
                    aria-label={t('keys.panelColEnabled')}
                    onCheckedChange={checked => setEnabled.mutate({ id: r.modelDbId, enabled: checked })}
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

/** A dash, not a zero: an absent measurement is not a score of nothing. */
function Num({ v, digits = 1 }: { v: number | null | undefined; digits?: number }) {
  return (
    <td className="py-1 pr-2 text-right tabular-nums">
      {v == null ? <span className="text-muted-foreground">–</span> : v.toFixed(digits)}
    </td>
  )
}
