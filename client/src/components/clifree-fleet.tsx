import { useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Server, AlertTriangle } from 'lucide-react'
import { useI18n } from '@/i18n'
import { apiFetch } from '@/lib/api'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { useExtensionEnabled } from '@/lib/use-extension'
import { vendorTint } from '@/lib/vendor-tint'
import { ModelCombobox, type ModelComboOption } from '@/components/model-combobox'
import { ModelName } from '@/components/model-name'

// What each MACHINE can reach on the free CLI rosters, and what it has spent.
//
// The Mac Studio and the MBP spend the SAME free accounts from different
// machines, so "are we out of Cline quota, and who spent it" is unanswerable on
// either one — each holds half the evidence.
//
// 🛑 These routes are NOT callable from FreeLLM. Their free tiers refuse callers
// outside the vendor's own CLI: OpenCode Zen answers 403 FreeTierError, and
// Cline's free models are not served through its API at all. The panel says so
// in its own copy, and carries NO chain or scope control, because a control
// here would produce a routing slot that silently never serves.
//
// Columns mirror the comparison table above so the two can be read together.
// See docs/adr/ARCH-20260922-clifree-fleet-telemetry.md.

export interface FleetRow {
  machine: string
  spec: string
  provider: string
  class: string | null
  intelligence: number | null
  matchQuality: string | null
  reachability: string
  coolingUntilMs: number | null
  coolingReason: string | null
  observedAtMs: number
  benchmarkSlug: string | null
}

interface FleetAnalysis {
  slug: string
  name: string
  creator?: string | null
  intelligenceIndex: number | null
  codingIndex: number | null
  agenticIndex: number | null
}

export interface FleetGroup {
  groupKey: string
  name: string
  analysis: FleetAnalysis | null
  fleetSpecs?: string[]
}

/** One machine's consumption and what that inference was worth. Per machine,
 *  not per route: "what was this machine given" is not a per-row question. */
export interface FleetValue {
  machine: string
  /** Dashboard device label, matching the Analytics device tabs. */
  device: string
  /** The machine's last delivery (epoch ms); null if it never sent a roster. */
  reportedAtMs: number | null
  requests: number
  inputTokens: number
  outputTokens: number
  /** Null when nothing this machine used maps to a priced benchmark. */
  valueUsd: number | null
  unpricedSpecs: number
  reportedCostUsd: number
}

/** One route on one machine over the window, with the model's quality. */
export interface FleetUsageRow {
  machine: string
  device: string
  spec: string
  provider: string
  /** From the machine's current roster; null once the route left it. */
  class: string | null
  intelligence: number | null
  benchmarkSlug: string | null
  requests: number
  inputTokens: number
  outputTokens: number
  valueUsd: number | null
  reportedCostUsd: number
}

interface BaselineGroup {
  groupKey: string
  name: string
  analysis: FleetAnalysis | null
}

/** The combobox works in option values, so "no counterpart" needs one of its
 *  own: an empty string would read as "nothing picked yet", and those are
 *  different answers. */
const NO_MATCH = '__none__'

const STALE_AFTER_MS = 6 * 60 * 60 * 1000

const REACH_LABEL: Record<string, string> = {
  ok: 'compare.fleet.reachOk',
  fail: 'compare.fleet.reachFail',
  notools: 'compare.fleet.reachNotools',
  unprobed: 'compare.fleet.reachUnprobed',
}

const FLEET_MARK: Record<string, string> = { opencode: 'OC', cline: 'CL' }
const MARK_CLASS: Record<string, string> = {
  OC: 'border-indigo-500/40 bg-indigo-500/10 text-indigo-700 dark:text-indigo-300',
  CL: 'border-fuchsia-500/40 bg-fuchsia-500/10 text-fuchsia-700 dark:text-fuchsia-300',
}

/** Best wins. A capability reachable from one agent is reachable, even if
 *  another agent's route to it refuses tools. */
const REACH_RANK: Record<string, number> = { ok: 3, unprobed: 2, fail: 1, notools: 0 }

type Col = 'name' | 'class' | 'intelligence' | 'coding' | 'agentic' | 'routes' | 'reached' | 'available' | 'mapped'

export function useFleet(enabled: boolean) {
  return useQuery({
    queryKey: ['clifree-fleet'],
    queryFn: () => apiFetch<{ routes: FleetRow[]; groups: FleetGroup[]; value: FleetValue[] }>('/api/clifree-fleet'),
    enabled,
  })
}

/** A dash, not a zero: their nulls mean "not measured". */
function score(v: number | null | undefined) {
  return v == null ? <span className="text-muted-foreground">–</span> : v.toFixed(1)
}

function ago(ms: number): string {
  const mins = Math.max(0, Math.round(ms / 60_000))
  if (mins < 60) return `${mins}m`
  const hours = Math.round(mins / 60)
  return hours < 48 ? `${hours}h` : `${Math.round(hours / 24)}d`
}

function Head({ col, sort, dir, onSort, right, className, children }: {
  col: Col
  sort: Col
  dir: 'asc' | 'desc'
  onSort: (c: Col) => void
  right?: boolean
  className?: string
  children: React.ReactNode
}) {
  const active = sort === col
  return (
    <TableHead
      className={`${right ? 'text-right ' : ''}${className ?? ''}`}
      aria-sort={active ? (dir === 'asc' ? 'ascending' : 'descending') : 'none'}
    >
      <button
        type="button"
        onClick={() => onSort(col)}
        className={`inline-flex items-center gap-0.5 hover:text-foreground ${active ? 'text-foreground' : ''}`}
      >
        {children}
        <span className="text-[9px]">{active ? (dir === 'asc' ? '▲' : '▼') : ''}</span>
      </button>
    </TableHead>
  )
}

/** One capability, with every route that reaches it folded in. */
interface Entry {
  key: string
  name: string
  cls: string | null
  analysis: FleetAnalysis | null
  matchQuality: string | null
  specs: string[]
  marks: string[]
  machines: string[]
  reached: string
  /** Minutes until the soonest route frees up, null when one is free now. */
  coolingMins: number | null
  coolingReason: string | null
  baseline?: boolean
}

export function ClifreeFleet() {
  const { t } = useI18n()
  const enabled = useExtensionEnabled('clifree-fleet-telemetry')
  const { data, isPending } = useFleet(enabled)

  const [showBaselines, setShowBaselines] = useState(false)
  const { data: references } = useQuery<{ groups: BaselineGroup[] }>({
    queryKey: ['analysis', 'references'],
    queryFn: () => apiFetch('/api/analysis/references'),
    enabled: enabled && showBaselines,
  })

  const queryClient = useQueryClient()
  // Same catalogue the comparison table maps against, so the two controls
  // offer the same choices rather than two subtly different lists.
  const { data: compare } = useQuery<{ catalogue: { slug: string; name: string; creator: string | null; intelligenceIndex: number | null }[] }>({
    queryKey: ['analysis', 'compare'],
    queryFn: () => apiFetch('/api/analysis/compare'),
    enabled,
  })
  const link = useMutation({
    mutationFn: (body: { spec: string; aaSlug: string | null }) =>
      apiFetch('/api/clifree-fleet/link', { method: 'PUT', body: JSON.stringify(body) }),
    onSuccess: () => { void queryClient.invalidateQueries({ queryKey: ['clifree-fleet'] }) },
  })

  const [sort, setSort] = useState<Col>('intelligence')
  const [dir, setDir] = useState<'asc' | 'desc'>('desc')

  const now = Date.now()
  const routes = useMemo(() => data?.routes ?? [], [data])
  const groups = useMemo(() => data?.groups ?? [], [data])

  // Fold the per-route telemetry onto the merged capabilities. The groups carry
  // benchmark scores; the routes carry who can reach them and when.
  const entries = useMemo<Entry[]>(() => {
    const bySpec = new Map<string, FleetRow[]>()
    for (const r of routes) {
      const list = bySpec.get(r.spec)
      if (list) list.push(r)
      else bySpec.set(r.spec, [r])
    }

    const rows: Entry[] = groups.map(g => {
      const specs = g.fleetSpecs ?? []
      const mine = specs.flatMap(s => bySpec.get(s) ?? [])
      const marks: Record<string, true> = {}
      const machines: Record<string, true> = {}
      let reached = 'notools'
      let coolingMins: number | null = null
      let coolingReason: string | null = null
      let anyFree = false

      for (const r of mine) {
        const mark = FLEET_MARK[r.provider]
        if (mark) marks[mark] = true
        machines[r.machine] = true
        if ((REACH_RANK[r.reachability] ?? 0) > (REACH_RANK[reached] ?? 0)) reached = r.reachability
        const left = r.coolingUntilMs === null ? null : Math.ceil((r.coolingUntilMs - now) / 60_000)
        if (left === null || left <= 0) anyFree = true
        else if (coolingMins === null || left < coolingMins) { coolingMins = left; coolingReason = r.coolingReason }
      }

      return {
        key: g.groupKey,
        name: g.name,
        cls: mine[0]?.class ?? null,
        analysis: g.analysis,
        matchQuality: mine[0]?.matchQuality ?? null,
        specs,
        marks: Object.keys(marks).sort(),
        machines: Object.keys(machines).sort(),
        reached,
        // Free somewhere beats cooling elsewhere: the question is whether the
        // capability is usable now, not whether every route to it is.
        coolingMins: anyFree ? null : coolingMins,
        coolingReason: anyFree ? null : coolingReason,
      }
    })

    if (showBaselines) {
      for (const b of references?.groups ?? []) {
        rows.push({
          key: b.groupKey, name: b.analysis?.name ?? b.name, cls: null,
          analysis: b.analysis, matchQuality: null, specs: [], marks: [], machines: [],
          reached: '', coolingMins: null, coolingReason: null, baseline: true,
        })
      }
    }
    return rows
  }, [groups, routes, references, showBaselines, now])

  const sorted = useMemo(() => {
    const mul = dir === 'asc' ? 1 : -1
    const key = (e: Entry): string | number => {
      switch (sort) {
        case 'name': return e.name
        case 'class': return e.cls ?? ''
        // Unrated sorts last either way rather than posing as a zero, which
        // would rank an unmeasured model below a bad one.
        case 'intelligence': return e.analysis?.intelligenceIndex ?? -Infinity
        case 'coding': return e.analysis?.codingIndex ?? -Infinity
        case 'agentic': return e.analysis?.agenticIndex ?? -Infinity
        case 'routes': return e.specs.length
        case 'reached': return REACH_RANK[e.reached] ?? -1
        case 'available': return e.coolingMins ?? 0
        case 'mapped': return e.analysis?.name ?? ''
      }
    }
    return [...entries].sort((a, b) => {
      const ka = key(a), kb = key(b)
      if (typeof ka === 'string' || typeof kb === 'string') return String(ka).localeCompare(String(kb)) * mul
      return (ka - kb) * mul
    })
  }, [entries, sort, dir])

  if (!enabled) return null

  const onSort = (c: Col) => {
    if (c === sort) setDir(d => (d === 'asc' ? 'desc' : 'asc'))
    else { setSort(c); setDir(c === 'name' || c === 'mapped' || c === 'class' ? 'asc' : 'desc') }
  }

  const reportedAt = new Map<string, number>()
  for (const r of routes) reportedAt.set(r.machine, Math.max(reportedAt.get(r.machine) ?? 0, r.observedAtMs))
  // Keyed by machine like reportedAt above: both answer "what is true of this
  // machine right now", and the strip renders them together.
  const valueByMachine = new Map<string, FleetValue>()
  for (const v of data?.value ?? []) valueByMachine.set(v.machine, v)

  return (
    <section className="mt-8 space-y-3 rounded-lg border p-4">
      <div>
        <h2 className="flex items-center gap-2 text-lg font-semibold">
          <Server className="h-4 w-4" aria-hidden />
          {t('compare.fleet.title')}
        </h2>
        <p className="text-sm text-muted-foreground">{t('compare.fleet.description')}</p>
      </div>

      <p className="flex items-start gap-2 rounded-md border border-amber-500/30 bg-amber-500/5 p-3 text-sm text-muted-foreground">
        <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-500" aria-hidden />
        {t('compare.fleet.notRoutable')}
      </p>

      {isPending ? (
        <div className="rounded-md border p-4 text-sm text-muted-foreground">{t('common.loading')}</div>
      ) : routes.length === 0 ? (
        <div className="rounded-md border p-4 text-sm text-muted-foreground">
          <p>{t('compare.fleet.empty')}</p>
          <p className="mt-1 font-mono text-xs">{t('compare.fleet.emptyHint')}</p>
        </div>
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
            <Button
              variant="outline"
              size="xs"
              aria-pressed={showBaselines}
              onClick={() => setShowBaselines(v => !v)}
              className={showBaselines ? 'bg-muted' : undefined}
            >
              {t('compare.fleet.compareBaselines')}
            </Button>
            {[...reportedAt.entries()].map(([machine, at]) => {
              const stale = now - at > STALE_AFTER_MS
              const value = valueByMachine.get(machine)
              return (
                <span key={machine} className="inline-flex items-center gap-1">
                  <span className="font-medium text-foreground">{machine}</span>
                  <span>{t('compare.fleet.lastReported', { ago: ago(now - at) })}</span>
                  {/* What the machine was GIVEN, priced at the benchmark
                      equivalent's published rates. Absent entirely until a
                      reporter sends usage, so an older reporter degrades to
                      today's strip rather than showing a misleading $0. */}
                  {value && (
                    value.valueUsd === null ? (
                      <span className="text-muted-foreground" title={t('compare.fleet.valueUnknownHint')}>
                        {t('compare.fleet.valueUnknown')}
                      </span>
                    ) : (
                      <span
                        className="font-medium tabular-nums text-emerald-600 dark:text-emerald-400"
                        title={t('compare.fleet.valueHint')}
                      >
                        {t('compare.fleet.valueDelivered', { value: value.valueUsd.toFixed(2) })}
                      </span>
                    )
                  )}
                  {/* A partial figure must never read as a complete one. */}
                  {value && value.valueUsd !== null && value.unpricedSpecs > 0 && (
                    <span className="text-muted-foreground">
                      {t('compare.fleet.valueUnpriced', { count: value.unpricedSpecs })}
                    </span>
                  )}
                  {/* A "free" route that billed money is an alarm, not a saving. */}
                  {value && value.reportedCostUsd > 0 && (
                    <Badge variant="outline" className="border-amber-500/40 text-amber-600">
                      {t('compare.fleet.valueBilled', { cost: value.reportedCostUsd.toFixed(2) })}
                    </Badge>
                  )}
                  {stale && (
                    <Badge variant="outline" className="border-amber-500/40 text-amber-600">
                      {t('compare.fleet.staleWarning', { ago: ago(now - at) })}
                    </Badge>
                  )}
                </span>
              )
            })}
          </div>

          <Table className="w-full table-fixed">
            <TableHeader>
              <TableRow>
                <Head col="name" sort={sort} dir={dir} onSort={onSort} className="w-[24%]">{t('compare.colModel')}</Head>
                <Head col="class" sort={sort} dir={dir} onSort={onSort} className="w-[11%]">{t('compare.fleet.class')}</Head>
                <Head col="intelligence" sort={sort} dir={dir} onSort={onSort} right className="w-[9%]">{t('compare.intelligence')}</Head>
                <Head col="coding" sort={sort} dir={dir} onSort={onSort} right className="w-[8%]">{t('compare.coding')}</Head>
                <Head col="agentic" sort={sort} dir={dir} onSort={onSort} right className="w-[8%]">{t('compare.agentic')}</Head>
                <Head col="routes" sort={sort} dir={dir} onSort={onSort} className="w-[10%]">{t('compare.fleet.colRoutes')}</Head>
                <Head col="reached" sort={sort} dir={dir} onSort={onSort} className="w-[10%]">{t('compare.fleet.reachability')}</Head>
                <Head col="available" sort={sort} dir={dir} onSort={onSort} className="w-[7%]">{t('compare.fleet.availability')}</Head>
                <Head col="mapped" sort={sort} dir={dir} onSort={onSort} className="w-[13%]">{t('compare.colMatch')}</Head>
              </TableRow>
            </TableHeader>
            <TableBody>
              {sorted.map(e => (
                <TableRow key={e.key} className={e.baseline ? (vendorTint(e.name, e.analysis?.creator) || 'bg-sky-500/5') : undefined}>
                  <TableCell title={e.baseline ? e.name : [e.name, ...e.specs].join('\n')}>
                    <span className="flex items-center gap-1">
                      {/* Badge first and non-shrinking: it is the one thing on
                          this row that must survive truncation. */}
                      {e.baseline && (
                        <Badge variant="secondary" className="shrink-0 bg-sky-500/15 text-[10px] text-sky-700 dark:text-sky-300">
                          {t('compare.referenceBadge')}
                        </Badge>
                      )}
                      {/* Wrapped, not truncated, as on the Compare table: the
                          variant is the tail, which truncation cuts first. */}
                      <ModelName name={e.name} className="min-w-0 whitespace-normal [overflow-wrap:anywhere]" />
                    </span>
                  </TableCell>
                  <TableCell className="text-xs">{e.cls ?? <span className="text-muted-foreground">–</span>}</TableCell>
                  <TableCell className="text-right tabular-nums">{score(e.analysis?.intelligenceIndex)}</TableCell>
                  <TableCell className="text-right tabular-nums">{score(e.analysis?.codingIndex)}</TableCell>
                  <TableCell className="text-right tabular-nums">{score(e.analysis?.agenticIndex)}</TableCell>
                  <TableCell>
                    <span className="flex items-center gap-1" title={e.specs.join('\n')}>
                      {e.marks.map(m => (
                        <Badge key={m} variant="outline" className={`px-1 font-mono text-[10px] ${MARK_CLASS[m]}`}>
                          {m}
                        </Badge>
                      ))}
                      {e.specs.length > 1 && (
                        <span className="text-[10px] text-muted-foreground tabular-nums">{`×${e.specs.length}`}</span>
                      )}
                      {e.baseline && <span className="text-muted-foreground">–</span>}
                    </span>
                  </TableCell>
                  <TableCell className="text-xs">
                    {e.baseline
                      ? <span className="text-muted-foreground">–</span>
                      : t(REACH_LABEL[e.reached] ?? 'compare.fleet.reachUnprobed')}
                  </TableCell>
                  {/* TableCell is whitespace-nowrap by default, which forced
                      "1436m (notools)" onto one line and widened the column.
                      Overridden here only: a cooldown reason is free text from
                      a provider and can be longer than the column. */}
                  <TableCell className="text-xs whitespace-normal break-words">
                    {e.baseline
                      ? <span className="text-muted-foreground">–</span>
                      : e.coolingMins === null
                        ? t('compare.fleet.availableNow')
                        : (
                          // Two lines, not one wrapped string. "1172m (notools)"
                          // has a single space, so break-words keeps it intact
                          // and the column stays as wide as the longest reason
                          // any provider ever returns. Splitting it makes the
                          // width predictable and gives that space to Mapped to.
                          <span className="flex flex-col leading-tight text-amber-600 dark:text-amber-400">
                            <span className="tabular-nums">{t('compare.fleet.coolingMinutes', { minutes: e.coolingMins })}</span>
                            {e.coolingReason && <span className="text-[10px] opacity-80">{e.coolingReason}</span>}
                          </span>
                        )}
                  </TableCell>
                  <TableCell className="text-xs" title={e.analysis?.slug ?? ''}>
                    {/* Always mounted, never swapped in on click.
                        Swapping a button for this control unmounted the focused
                        element, focus fell to <body>, and the browser scrolled
                        the page to the top -- so remapping meant scrolling back
                        down to find the row you were on. */}
                    {e.baseline ? <span className="text-muted-foreground">–</span> : (
                      <ModelCombobox
                        value={e.analysis?.slug ?? NO_MATCH}
                        options={[
                          { value: NO_MATCH, label: t('compare.matchNoneOption') },
                          ...(compare?.catalogue ?? []).map(c => ({
                            value: c.slug,
                            label: c.name,
                            sub: c.intelligenceIndex == null ? (c.creator ?? undefined) : c.intelligenceIndex.toFixed(0),
                          } satisfies ModelComboOption)),
                        ]}
                        renderLabel={label => <ModelName name={label} />}
                        onSelect={slug => {
                          // Every route reaching this capability remaps
                          // together: they were merged BECAUSE they are one
                          // model, so remapping half would split the row.
                          for (const spec of e.specs) {
                            link.mutate({ spec, aaSlug: slug === NO_MATCH ? null : slug })
                          }
                        }}
                        ariaLabel={t('compare.mapAriaLabel')}
                        placeholder={t('compare.mapSearchPlaceholder')}
                        emptyText={t('compare.mapNoResults')}
                        triggerPlaceholder={t('compare.matchNone')}
                        triggerClassName="h-7 w-full text-[11px]"
                        align="end"
                        side="top"
                      />
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </>
      )}
    </section>
  )
}
