import { useMemo, useState } from 'react'
import { useQueries, useQuery } from '@tanstack/react-query'
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
  LineChart, Line, Legend,
} from 'recharts'
import {
  Activity,
  Archive,
  ArrowDown,
  ArrowUp,
  Bot,
  ChartLine,
  CheckCircle2,
  CircleAlert,
  CircleDollarSign,
  Clock,
  Coins,
  Gauge,
  GitBranch,
  KeyRound,
  Layers,
  List,
  Network,
  Server,
  TriangleAlert,
  Zap,
  X,
  type LucideIcon,
} from 'lucide-react'
import { apiFetch } from '@/lib/api'
import { SegmentedControl } from '@/components/ui/segmented-control'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Badge } from '@/components/ui/badge'
import { Dialog, DialogClose, DialogPopup, DialogTitle } from '@/components/ui/dialog'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { PageHeader } from '@/components/page-header'
import { Skeleton } from '@/components/ui/skeleton'
import { PlatformDot } from '@/components/platform-dot'
import { Tooltip as HoverTooltip } from '@/components/tooltip'
import { SortableHeader } from '@/components/sortable-header'
import { OffloadedInference } from '@/components/offloaded-inference'
import { formatSqliteUtcToLocalTime } from '@/lib/utils'
import { sortRows, useTableSort, type SortValueFn } from '@/lib/table-sort'
import { categoryAxisProps, verticalCategoryAxisProps } from '@/lib/chart-axis'
import { useI18n } from '@/i18n'

// The analytics window, as the page holds it.
//
// Two shapes, and they are mutually exclusive:
//   - `range`: one of the server's presets, counting back from now.
//   - `from` + `to`: explicit dates for any window the presets don't cover.
//
// The presets grew past 90d because a daily line stops being legible there.
// The server picks the timeline bucket from the window's own span, so 180d and
// 365d bucket by month instead of drawing 180 unreadable daily ticks.
type TimeRange = '24h' | '7d' | '30d' | '90d' | '180d' | '365d'

const TIME_RANGES: TimeRange[] = ['24h', '7d', '30d', '90d', '180d', '365d']

// The window sticks: whichever one you last looked at is the one the tab
// opens with next time, instead of always snapping back to 7d (#711).
const RANGE_KEY = 'analytics.range'

const CUSTOM = 'custom'

// Preset → its i18n keys. One table, read by both the toggle and the savings
// card, so a window can never be labelled two different ways in two places.
const RANGE_LABEL_KEY: Record<TimeRange, string> = {
  '24h': 'analytics.rangeLabel24h',
  '7d': 'analytics.rangeLabel7d',
  '30d': 'analytics.rangeLabel30d',
  '90d': 'analytics.rangeLabel90d',
  '180d': 'analytics.rangeLabel180d',
  '365d': 'analytics.rangeLabel365d',
}

/** A custom span, stored as two 'YYYY-MM-DD' strings. Kept beside the range
 *  preset so returning to a preset and coming back is lossless. */
interface CustomWindow {
  from: string
  to: string
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/

/** The date input's own value format, which is also what the server parses. */
function isoDate(offsetDays: number, from: number): string {
  return new Date(from + offsetDays * 86_400_000).toISOString().slice(0, 10)
}

function storedRange(): TimeRange | typeof CUSTOM {
  try {
    const v = localStorage.getItem(RANGE_KEY)
    if (v === CUSTOM) return CUSTOM
    if (v && (TIME_RANGES as string[]).includes(v)) return v as TimeRange
  } catch { /* ignore */ }
  return '7d'
}

function storedCustom(): CustomWindow {
  try {
    const raw = localStorage.getItem(`${RANGE_KEY}.custom`)
    if (raw) {
      const parsed: unknown = JSON.parse(raw)
      if (
        parsed && typeof parsed === 'object' && 'from' in parsed && 'to' in parsed &&
        ISO_DATE.test(String(parsed.from)) && ISO_DATE.test(String(parsed.to))
      ) {
        return { from: String(parsed.from), to: String(parsed.to) }
      }
    }
  } catch { /* ignore */ }
  // A sensible default: the last 14 days, which is a window worth opening.
  const to = isoDate(0, Date.now())
  return { from: isoDate(-13, Date.parse(`${to}T00:00:00Z`)), to }
}

// The query-string tail EVERY analytics request carries. One builder, so the
// window and the filters cannot drift between panels: before this, the range
// rode eight hand-built URLs and the status/provider filters existed only on
// the recent-calls table, so filtering moved one panel and left the other nine
// describing different traffic.
function windowParams(range: TimeRange | typeof CUSTOM, custom: CustomWindow, device: string, filters: FilterState): string {
  const params = new URLSearchParams()
  if (range === CUSTOM) {
    params.set('from', custom.from)
    params.set('to', custom.to)
  } else {
    params.set('range', range)
  }
  if (device) params.set('device', device)
  if (filters.status !== 'all') params.set('status', filters.status)
  if (filters.provider !== 'all') params.set('provider', filters.provider)
  if (filters.model !== 'all') params.set('model', filters.model)
  return params.toString()
}

// The filters the page owns, above every panel. 'all' means no filter at all,
// so it never appears in the URL.
interface FilterState {
  status: StatusFilter
  provider: string
  model: string
}

const FILTERS_KEY = 'analytics.filters'

function storedFilters(): FilterState {
  try {
    const raw = localStorage.getItem(FILTERS_KEY)
    if (raw) {
      const parsed: unknown = JSON.parse(raw)
      if (parsed && typeof parsed === 'object') {
        const p = parsed as Record<string, unknown>
        const status = typeof p.status === 'string' ? p.status : 'all'
        return {
          status: (['all', 'success', 'error', 'canceled'] as string[]).includes(status)
            ? (status as StatusFilter) : 'all',
          provider: typeof p.provider === 'string' ? p.provider : 'all',
          model: typeof p.model === 'string' ? p.model : 'all',
        }
      }
    }
  } catch { /* ignore */ }
  return { status: 'all', provider: 'all', model: 'all' }
}



// Sortable columns of the three breakdown tables. Sorting is client-side over
// the rows already loaded and remembered per table (same localStorage idiom as
// the range). Recent calls are fetched newest-first with limit=100, so its
// sort covers that window, not the whole filtered set — the table says so
// whenever `total` exceeds the loaded rows.
type RecentCallCol = 'time' | 'ip' | 'agent' | 'model' | 'provider' | 'status' | 'attempts' | 'inTokens' | 'outTokens' | 'latency'
const RECENT_CALL_COLS: readonly RecentCallCol[] = ['time', 'ip', 'agent', 'model', 'provider', 'status', 'attempts', 'inTokens', 'outTokens', 'latency']
const RECENT_CALLS_SORT_KEY = 'analytics.recentCallsSort'

// success > canceled > error, so ascending puts the failures on top.
function statusRank(status: string): number {
  return status === 'success' ? 2 : status === 'canceled' ? 1 : 0
}

const recentCallValue: SortValueFn<RecentCallRow, RecentCallCol> = (r, col) => {
  switch (col) {
    case 'time': return r.createdAt
    case 'ip': return r.clientIp
    case 'agent': return r.clientUserAgent
    case 'model': return r.modelId
    // Same text the cell shows: a labelled custom endpoint sorts by its label.
    case 'provider': return r.platform === 'custom' && r.keyLabel ? r.keyLabel : r.platform
    case 'status': return statusRank(r.status)
    case 'attempts': return r.attemptCount
    case 'inTokens': return r.inputTokens
    case 'outTokens': return r.outputTokens
    case 'latency': return r.latencyMs
  }
}

type ByModelCol = 'model' | 'provider' | 'requests' | 'pinned' | 'success' | 'latency' | 'inTokens' | 'outTokens' | 'saved'
const BY_MODEL_COLS: readonly ByModelCol[] = ['model', 'provider', 'requests', 'pinned', 'success', 'latency', 'inTokens', 'outTokens', 'saved']
const BY_MODEL_SORT_KEY = 'analytics.byModelSort'

const byModelValue: SortValueFn<ByModelRow, ByModelCol> = (m, col) => {
  switch (col) {
    case 'model': return m.displayName
    case 'provider': return m.endpoint ?? m.platform
    case 'requests': return m.requests
    case 'pinned': return m.pinnedRequests
    case 'success': return m.successRate
    case 'latency': return m.avgLatencyMs
    case 'inTokens': return m.totalInputTokens
    case 'outTokens': return m.totalOutputTokens
    case 'saved': return m.estimatedCost ?? null
  }
}

type ByKeyCol = 'label' | 'provider' | 'requests' | 'success' | 'latency' | 'inTokens' | 'outTokens'
const BY_KEY_COLS: readonly ByKeyCol[] = ['label', 'provider', 'requests', 'success', 'latency', 'inTokens', 'outTokens']
const BY_KEY_SORT_KEY = 'analytics.byKeySort'

const byKeyValue: SortValueFn<ByKeyRow, ByKeyCol> = (k, col) => {
  switch (col) {
    // Unlabelled keys sort by id rather than bunching as one empty string.
    case 'label': return k.label || `#${k.keyId}`
    case 'provider': return k.platform
    case 'requests': return k.requests
    case 'success': return k.successRate
    case 'latency': return k.avgLatencyMs
    case 'inTokens': return k.totalInputTokens
    case 'outTokens': return k.totalOutputTokens
  }
}

// Response shapes mirror the JSON emitted by server/src/routes/analytics.ts.
// Latency percentiles and TTFT are null when the raw window is empty (pruned).
interface SummaryResponse {
  totalRequests: number
  successRate: number
  totalInputTokens: number
  totalOutputTokens: number
  avgLatencyMs: number
  p50LatencyMs: number | null
  p95LatencyMs: number | null
  avgTtfbMs: number | null
  requestTypeCounts: { chat: number; embedding: number }
  estimatedCostSavings: number
  pinnedRequests: number
  pinHonoredRequests: number
  firstRequestAt: string | null
  // The window the server actually read. The UI labels a custom span from this
  // rather than from its own arithmetic, so a clamped or reordered pair still
  // reads correctly and the two can never disagree.
  windowSince: string
  windowUntil: string
  // True when the window opens before the oldest surviving raw row, and that
  // row's date. The notice on the card needs both.
  rawWindowTruncated: boolean
  rawWindowOldest: string | null
  lifetimeTotalRequests: number
}

interface CacheStatsResponse {
  enabled: boolean
  entries: number
  // Hits carried by the entries currently held (restored from SQLite), and the
  // provider round-trips / tokens they represent.
  totalHits: number
  estimatedRequestsSaved: number
  savedTokens: number
  // Lookups since the server started — the ratio's two halves. Kept separate
  // from totalHits, which shrinks when entries are evicted.
  lookupHits: number
  lookupMisses: number
  hitRate: number
}

interface ByPlatformRow {
  platform: string
  // Stable identity for the filter dropdown. For a catalog platform it equals
  // `platform`; for a custom endpoint it is `custom:<base_url>` (#889), so each
  // relay is filterable on its own instead of collapsing into 'custom'.
  providerId: string
  // Human display name. Catalog: the platform id. Custom: the endpoint host
  // (e.g. 'relay.example.com') so several relays are distinguishable.
  endpoint?: string
  requests: number
  successRate: number
  avgLatencyMs: number
  p95LatencyMs: number | null
  avgTtfbMs: number | null
  errorCount: number
  avgTokensPerSecond: number | null
  totalInputTokens: number
  totalOutputTokens: number
  // Paid-API equivalent of this provider's successful traffic, same per-model
  // pricing the summary and per-model rows use.
  estimatedCost: number
}

// One row per DEVICE. The server derives it from client_user_agent and folds
// every UA that machine has reported (routes/analytics.ts DEVICE_SQL), so a
// machine does not gain a row each time its harness version changes.
interface ByClientRow {
  // The device label, e.g. 'Mac Studio'. Field name predates the rollup.
  clientAgent: string
  // The raw User-Agents folded into it, for the hover.
  agents: string[]
  // True when this row is a machine the page can filter on, false for a
  // caller reported under its own User-Agent (curl, an unknown client).
  isDevice: boolean
  requests: number
  successRate: number
  avgLatencyMs: number
  totalInputTokens: number
  totalOutputTokens: number
  estimatedCost: number
  lastSeenAt: string | null
}

interface TimelineBucket {
  timestamp: string
  requests: number
  successCount: number
  failureCount: number
  inputTokens: number
  outputTokens: number
}

interface ByModelRow {
  platform: string
  // Endpoint identity of the row (#889). The same model id served by two
  // custom relays is two rows, one per relay, so the name has to say which.
  // Same id/name pair /by-platform returns for that endpoint.
  providerId?: string
  endpoint?: string
  modelId: string
  displayName: string
  requests: number
  successRate: number
  avgLatencyMs: number
  totalInputTokens: number
  totalOutputTokens: number
  pinnedRequests: number
  estimatedCost: number
}

interface ByKeyRow {
  keyId: number
  label: string | null
  platform: string | null
  requests: number
  successRate: number
  avgLatencyMs: number
  totalInputTokens: number
  totalOutputTokens: number
}

interface ErrorDistribution {
  byCategory: Array<{ category: string; count: number }>
  // One entry per provider — per custom ENDPOINT, not one pooled 'custom'
  // entry (#889); `platform` is kept for the dot coloring.
  byPlatform: Array<{ platform: string; providerId?: string; endpoint?: string; count: number }>
  detailed: Array<{ platform: string; model_id: string; error_category: string; count: number }>
}

interface RecentErrorRow {
  id: number
  platform: string
  // Which endpoint produced the error: the platform slug for catalog
  // providers, the custom endpoint's host/path for a relay (#889).
  providerId?: string
  endpoint?: string
  modelId: string
  error: string
  latencyMs: number
  createdAt: string
}

interface RecentCallRow {
  id: number
  platform: string
  modelId: string
  requestedModel: string | null
  requestType: string
  status: string
  inputTokens: number
  outputTokens: number
  latencyMs: number
  error: string | null
  clientIp: string | null
  clientUserAgent: string | null
  createdAt: string
  // #785: custom endpoints all share the generic 'custom' platform id; the
  // user's key label ("Ollama box") names the real provider. Null when the
  // key was deleted or never labelled.
  keyLabel: string | null
  // Failover-ladder length: attempts hang off the TERMINAL row of a proxied
  // request, so mid-ladder failure rows report 0.
  attemptCount: number
}

interface RecentCallsResponse {
  total: number
  rows: RecentCallRow[]
}

// One hop of the failover ladder, from GET /api/analytics/requests/:id.
interface RequestAttempt {
  ordinal: number
  platform: string
  modelId: string
  keyOrdinal: number
  // Operator-facing key label captured at attempt time (#869); null when the
  // key had no label. Shown in a tooltip on the key badge so a multi-key
  // provider's ladder says WHICH key was tried, not just key1/key2.
  keyLabel: string | null
  outcome: string
  startOffsetMs: number
  durationMs: number
  errorSummary: string | null
  // What the router was looking at when it chose this hop, captured at the
  // decision (see server/src/lib/attempt-trace.ts). Null for hops recorded
  // before the trace existed. The rank pair is the load-bearing part: a
  // multiplier that reordered nothing reads very differently from one that
  // decided the route, and only rankBefore/rankAfter tells them apart.
  routing: {
    strategy: string
    poolKey: string | null
    scarcity: number
    harvest: number
    diversity: number
    inFlightShare: number | null
    scoringRank: number
    scoringRankWithoutQuotaTerms: number
    selectionRank: number
    selectionOverride: 'explore' | 'sticky' | 'pinned' | null
    skipped: string[]
  } | null
}

/**
 * Why the router picked this hop — rendered only when something actually had
 * an opinion.
 *
 * The common case is that every signal is neutral: quota is comfortable, the
 * window is not expiring, nothing else is in flight, and the rank did not
 * move. Printing `scarcity 1.00 · harvest 1.00 · diversity 1.00` on every row
 * of every ladder would bury the handful of rows where one of them decided the
 * route, so a fully neutral trace renders nothing at all.
 *
 * The rank pair leads when it moved, because that is the only part that
 * distinguishes "this signal was computed" from "this signal chose the route".
 */
function RoutingTraceLine({ routing }: { routing: RequestAttempt['routing'] }) {
  const { t } = useI18n()
  if (!routing) return null

  const parts: string[] = []
  // An override is named FIRST and the rank move is suppressed under it: a
  // sticky pin or an exploration probe puts a route first for reasons that have
  // nothing to do with quota, and reporting a scoring-stage move alongside it
  // would credit the quota terms for someone else's decision.
  if (routing.selectionOverride) {
    parts.push(t(`analytics.routingOverride.${routing.selectionOverride}`))
  } else if (routing.scoringRank !== routing.scoringRankWithoutQuotaTerms) {
    parts.push(t('analytics.routingRankMove', {
      from: routing.scoringRankWithoutQuotaTerms,
      to: routing.scoringRank,
    }))
  }
  // Thresholds, not equality: these are floats off a ramp, and a value a
  // hair under 1 is arithmetic noise rather than a decision worth reporting.
  if (routing.scarcity < 0.995) parts.push(t('analytics.routingScarcity', { pct: Math.round(routing.scarcity * 100) }))
  if (routing.harvest > 1.005) parts.push(t('analytics.routingHarvest'))
  if (routing.diversity < 0.995) parts.push(t('analytics.routingDiversity', { pct: Math.round((1 - routing.diversity) * 100) }))
  if (routing.inFlightShare !== null && routing.inFlightShare > 0) {
    parts.push(t('analytics.routingInFlight', { pct: Math.round(routing.inFlightShare * 100) }))
  }
  const skipped = routing.skipped ?? []
  if (parts.length === 0 && skipped.length === 0) return null

  return (
    <div className="mt-1 pl-8 text-xs text-muted-foreground break-words">
      {parts.length > 0 && (
        <p>
          {routing.poolKey && <span className="font-mono">{routing.poolKey}</span>}
          {routing.poolKey && ' — '}
          {parts.join(' · ')}
        </p>
      )}
      {/* Verbatim reasons the candidates ahead of this one were passed over.
          On a request that SUCCEEDED this is the only evidence an admission
          block happened at all — a 200 looks the same whether the gate was
          right or misfiring. */}
      {skipped.length > 0 && (
        <ul className="mt-1 space-y-0.5">
          {skipped.map((line, i) => (
            <li key={i} className="font-mono text-[11px] opacity-80">{line}</li>
          ))}
        </ul>
      )}
    </div>
  )
}

interface RequestDetail extends Omit<RecentCallRow, 'attemptCount'> {
  ttfbMs: number | null
  attempts: RequestAttempt[]
}

// The status the page is scoped to. 'canceled' (#752 — the client hung up
// mid-request) is neither success nor error, and is a first-class choice here
// rather than folded into 'all'.
type StatusFilter = 'all' | 'success' | 'error' | 'canceled'


// 'canceled' (#752 — the client hung up mid-request) is neither success nor
// error: neutral amber, not destructive red.
function statusTextClass(status: string): string {
  if (status === 'success') return 'text-muted-foreground'
  if (status === 'canceled') return 'text-amber-600 dark:text-amber-400'
  return 'text-destructive'
}

// First product token of the UA ("python-requests/2.32.3", "curl/8.6.0", …)
// is enough to tell callers apart in a narrow cell; full string on hover.
function shortUserAgent(ua: string | null): string {
  if (!ua) return '—'
  const first = ua.split(' ')[0]
  return first.length > 32 ? first.slice(0, 32) + '…' : first
}

function formatTokens(n?: number): string {
  if (!n) return '0'
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`
  return String(n)
}

function Stat({ icon: Icon, label, value, sub, hint, className }: { icon: LucideIcon; label: string; value: string | number; sub?: string; hint?: string; className?: string }) {
  const card = (
    <div className="rounded-3xl border bg-card px-4 py-3">
      <div className="flex items-center justify-between gap-3">
        <p className="text-[11px] text-muted-foreground uppercase tracking-wider">{label}</p>
        <span className="flex size-7 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground">
          <Icon className="size-3.5" aria-hidden="true" />
        </span>
      </div>
      <p className={`text-xl font-semibold tabular-nums mt-1 ${className ?? ''}`}>{value}</p>
      {/* Optional second figure, so one card can carry two related numbers
          instead of spending another slot in the summary row. */}
      {sub ? <p className="text-[11px] text-muted-foreground tabular-nums truncate">{sub}</p> : null}
    </div>
  )
  // Same portal tooltip as the routing strategy chips. Opens BELOW the card:
  // the stats row sits right under the sticky navbar.
  return hint ? <HoverTooltip text={hint} side="bottom" className="block">{card}</HoverTooltip> : card
}

// `icon` is optional: the compare metric cards are a row of four small panels
// whose titles are already one word each, and a glyph on every one of them is
// four pieces of furniture carrying no information.
function Panel({ icon: Icon, title, actions, children }: { icon?: LucideIcon; title: string; actions?: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="rounded-3xl border bg-card">
      <div className="px-4 py-3 border-b flex flex-wrap items-center justify-between gap-2">
        <h3 className="flex items-center gap-2 text-sm font-medium">
          {Icon && <Icon className="size-4 text-muted-foreground" aria-hidden="true" />}
          {title}
        </h3>
        {actions}
      </div>
      <div className="p-4">{children}</div>
    </div>
  )
}

// Compact ms rendering for ladder timings: sub-second stays in ms, longer
// spans read as seconds ("38.8 s") like the issue reports do.
function formatMs(ms: number): string {
  if (ms >= 1000) return `${(ms / 1000).toFixed(1)} s`
  return `${ms} ms`
}

// Key/value line of the request-detail summary grid.
function DetailField({ label, value, mono }: { label: string; value: React.ReactNode; mono?: boolean }) {
  return (
    <div className="min-w-0">
      <p className="text-[11px] text-muted-foreground uppercase tracking-wider">{label}</p>
      <p className={`text-sm mt-0.5 break-words ${mono ? 'tabular-nums' : ''}`}>{value}</p>
    </div>
  )
}

// Per-request drill-down: the parent row's fields plus the failover ladder —
// one entry per dispatched attempt (ordinal → provider/model → key ordinal →
// outcome → timing, with the redacted per-hop error when one was recorded).
// A dialog (the app's detail-popup idiom, cf. keys/export-keys-dialog) rather
// than a routed page so the list's range/filter context stays put behind it.
function RequestDetailDialog({ requestId, onClose }: { requestId: number | null; onClose: () => void }) {
  const { t } = useI18n()

  const { data: detail, isLoading } = useQuery({
    queryKey: ['analytics', 'request-detail', requestId],
    queryFn: () => apiFetch<RequestDetail>(`/api/analytics/requests/${requestId}`),
    enabled: requestId != null,
  })

  return (
    <Dialog open={requestId != null} onOpenChange={(open) => { if (!open) onClose() }}>
      <DialogPopup maxWidth="max-w-2xl">
        <div className="mb-4 flex items-center justify-between gap-4">
          <div className="flex items-center gap-2">
            <Activity className="size-4 text-muted-foreground" aria-hidden="true" />
            <DialogTitle>{t('analytics.requestDetailTitle', { id: requestId ?? '' })}</DialogTitle>
          </div>
          <DialogClose
            aria-label={t('common.dismiss')}
            className="-mr-1 rounded-lg p-1 text-muted-foreground/70 transition-colors outline-none hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50"
          >
            <X className="size-4" />
          </DialogClose>
        </div>

        {isLoading || !detail ? (
          <div className="space-y-3">
            <Skeleton className="h-24 rounded-xl" />
            <Skeleton className="h-32 rounded-xl" />
          </div>
        ) : (
          <div className="space-y-5">
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-x-4 gap-y-3">
              <DetailField
                label={t('analytics.time')}
                value={formatSqliteUtcToLocalTime(detail.createdAt, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' })}
                mono
              />
              <DetailField
                label={t('common.status')}
                value={
                  <span className={detail.status === 'success' ? '' : statusTextClass(detail.status)}>{detail.status}</span>
                }
              />
              <DetailField
                label={t('common.provider')}
                value={
                  <span className="inline-flex items-center gap-1.5">
                    <PlatformDot platform={detail.platform} />
                    {detail.platform}
                  </span>
                }
              />
              <DetailField label={t('common.model')} value={detail.modelId} />
              {detail.requestedModel && detail.requestedModel !== detail.modelId && (
                <DetailField label={t('analytics.requestedModel')} value={detail.requestedModel} />
              )}
              <DetailField
                label={`${t('analytics.inTokens')} / ${t('analytics.outTokens')}`}
                value={`${formatTokens(detail.inputTokens)} / ${formatTokens(detail.outputTokens)}`}
                mono
              />
              <DetailField label={t('analytics.latency')} value={formatMs(detail.latencyMs ?? 0)} mono />
              <DetailField label={t('analytics.ttft')} value={detail.ttfbMs != null ? formatMs(detail.ttfbMs) : '—'} mono />
              <DetailField label={t('analytics.clientIp')} value={detail.clientIp ?? '—'} mono />
              <DetailField label={t('analytics.clientAgent')} value={detail.clientUserAgent ?? '—'} />
            </div>

            {detail.error && (
              <div className="rounded-xl border border-destructive/30 bg-destructive/5 px-3 py-2">
                <p className="text-[11px] text-destructive uppercase tracking-wider">{t('analytics.message')}</p>
                <p className="text-xs text-destructive/90 mt-1 break-words">{detail.error}</p>
              </div>
            )}

            <div>
              <h4 className="flex items-center gap-2 text-sm font-medium">
                <GitBranch className="size-4 text-muted-foreground" aria-hidden="true" />
                {t('analytics.failoverLadder')}
              </h4>
              <p className="text-xs text-muted-foreground mt-0.5">{t('analytics.failoverLadderHint')}</p>
              {detail.attempts.length === 0 ? (
                <p className="text-sm text-muted-foreground text-center py-6">{t('analytics.noAttemptTrace')}</p>
              ) : (
                <ol className="mt-3 space-y-2">
                  {detail.attempts.map((a) => (
                    <li key={a.ordinal} className="rounded-xl border px-3 py-2">
                      <div className="flex items-center gap-2 text-xs">
                        <span className="w-6 text-muted-foreground tabular-nums">#{a.ordinal + 1}</span>
                        <PlatformDot platform={a.platform} />
                        <span className="font-medium">{a.platform}</span>
                        <span className="text-muted-foreground truncate" title={a.modelId}>{a.modelId}</span>
                        <HoverTooltip text={a.keyLabel ? `${t('analytics.keyBadge', { n: a.keyOrdinal })} · ${a.keyLabel}` : t('analytics.keyBadge', { n: a.keyOrdinal })}>
                          <Badge variant="outline">{t('analytics.keyOrdinal', { n: a.keyOrdinal })}</Badge>
                        </HoverTooltip>
                        {/* client_abort is the caller's doing, not a hop failure. */}
                        <Badge variant={a.outcome === 'ok' || a.outcome === 'committed' ? 'secondary' : a.outcome === 'client_abort' ? 'outline' : 'destructive'}>
                          {a.outcome}
                        </Badge>
                        <span
                          className="ml-auto whitespace-nowrap text-muted-foreground tabular-nums"
                          title={t('analytics.attemptTimingHint')}
                        >
                          +{formatMs(a.startOffsetMs)} · {formatMs(a.durationMs)}
                        </span>
                      </div>
                      {a.errorSummary && (
                        <p className="mt-1 pl-8 text-xs text-destructive/90 break-words">{a.errorSummary}</p>
                      )}
                      <RoutingTraceLine routing={a.routing} />
                    </li>
                  ))}
                </ol>
              )}
            </div>
          </div>
        )}
      </DialogPopup>
    </Dialog>
  )
}

const axisStyle = { fontSize: 11, fill: 'var(--muted-foreground)' } as const
const gridStyle = 'var(--border)'
const primaryFill = 'var(--foreground)'
const tooltipStyle = { backgroundColor: 'var(--popover)', border: '1px solid var(--border)', borderRadius: 8, fontSize: 12 } as const

// The timeline endpoint buckets on the viewer's wall clock (the query sends
// the browser's tzOffset), so its zone-less timestamps ("2026-08-10T14:00:00"
// hourly, "2026-08-10" daily, "2026-08-01" monthly) are already local time.
// Parse them as local — re-interpreting them as UTC here would shift every
// tick a second time.
//
// A monthly bucket is day 01 of its month. It has to render as the MONTH, not
// as "Aug 1", because on a 365-day chart that is twelve ticks that all read as
// the first of a month and give no sense of where the year sits.
function formatTimelineTick(value: string): string {
  if (!value) return ''
  const iso = value.includes('T') ? value : `${value}T00:00:00`
  const date = new Date(iso)
  if (isNaN(date.getTime())) return value
  const monthly = /^\d{4}-\d{2}-01$/.test(value)
  return date.toLocaleString([], monthly
    ? { month: 'short', year: '2-digit' }
    : {
        month: 'short',
        day: 'numeric',
        ...(value.includes('T') ? { hour: '2-digit', minute: '2-digit' } : {}),
      })
}

// Every timeline XAxis below carries `type="category"` for the same reason:
// recharts INFERS the axis type from the data, and from two points it infers a
// numeric one. It then renders two empty tick groups instead of two labelled
// ones, so a 180d or 365d window over a young install showed an axis with no
// dates on it at all. Stating the type invents no data — the honest two points
// stay two points, and they get their labels back.


// Two categorical series hues, validated against the app's actual chart
// surfaces (light card #ffffff, dark card #101010) with the dataviz palette
// checker. Slot A (blue) = the "average / input" series; slot B (aqua) = the
// "p95 / output" series. The app's own --chart-* tokens are all grayscale
// (zero chroma), which fails the CVD separation check for a two-series chart,
// so we take the nearest passing categorical hues and theme them here.
const seriesA = 'var(--series-a)'
const seriesB = 'var(--series-b)'
const chartVars = `
.analytics-viz { --series-a: #2a78d6; --series-b: #1baf7a; }
.dark .analytics-viz { --series-a: #3987e5; --series-b: #199e70; }
`

// Device scope of the whole page. 'all' is every caller (the behaviour before
// devices existed, and the default); a device name filters every panel to that
// machine; 'compare' overlays the machines on the charts instead of filtering.
type DeviceScope = string // 'all' | 'compare' | a device name
const DEVICE_KEY = 'analytics.device'

function storedDevice(): DeviceScope {
  try { return localStorage.getItem(DEVICE_KEY) || 'all' } catch { return 'all' }
}

// Compare mode colours, reusing the two-series palette the charts already use.
const COMPARE_COLORS = [seriesA, seriesB, 'var(--muted-foreground)']

// Compare mode is METRIC-first, not machine-first. A panel per machine, each
// repeating the same four figures, means reading one metric across two boxes in
// two panels; with three machines it is three. One card per metric listing the
// machines inside it puts the numbers being compared on adjacent lines, and the
// swatch ties each line to its series in the chart below.
const COMPARE_METRICS: { labelKey: string; value: (s: SummaryResponse) => string }[] = [
  { labelKey: 'analytics.requests', value: s => String(s.totalRequests ?? 0) },
  { labelKey: 'analytics.inputTokens', value: s => formatTokens(s.totalInputTokens) },
  { labelKey: 'analytics.successRate', value: s => `${s.successRate ?? 0}%` },
  { labelKey: 'analytics.saved', value: s => `$${(s.estimatedCostSavings ?? 0).toFixed(2)}` },
]

// ── Filling gaps in the timeline ────────────────────────────────────────────
//
// The server emits only buckets where traffic exists. That is right for the
// data and wrong for the chart: a month with no traffic leaves a hole in the
// line and no tick, so "September then November" renders as two points with an
// unexplained gap. This fills every month in between with a zero, so a quiet
// month reads as a dip rather than as missing data.
//
// It does NOT fix a two-bucket chart — September and October are adjacent, so
// there is no gap to fill and the result is the same two rows. That case is an
// unlabelled axis, handled by TIMELINE_XAXIS below: two honest points that
// carry their labels is the correct rendering of a young install, not a defect.
//
// Zero is honest for a month that genuinely had no requests. It is NOT used to
// cover a month we hold no data for at all — the window bounds decide that, and
// the horizon notice above the charts says so in words.
//
// Generic over the row shape so the Compare chart (one key per device, and no
// index signature) gets the same treatment as the single-series one — a gap is
// a gap either way, and recharts mis-renders both identically.
function fillMonthlyGaps<T extends { timestamp: string }>(
  rows: T[],
  zero: (timestamp: string) => T,
): T[] {
  if (rows.length < 2) return rows;
  // Only monthly buckets carry a month key. Hourly and daily ones already have
  // a tick per hour or day and never fall into the two-point problem.
  if (!rows.every((r) => /^\d{4}-\d{2}-01$/.test(r.timestamp))) return rows;

  const months = rows.map((r) => r.timestamp.slice(0, 7));
  const [fy, fm] = months[0].split('-').map(Number) as [number, number];
  const [ly, lm] = (months.at(-1) as string).split('-').map(Number) as [number, number];
  const span = (ly - fy) * 12 + (lm - fm);
  // Past ~15 months a monthly line stops carrying information, and materialising
  // the gaps would be noise rather than shape.
  if (span < 0 || span > 15) return rows;

  const byMonth = new Map(rows.map((r) => [r.timestamp.slice(0, 7), r]));
  const out: T[] = [];
  for (let i = 0; i <= span; i++) {
    // Absolute month index, so December → January needs no special case.
    const monthIndex = fy * 12 + (fm - 1) + i;
    const timestamp = `${Math.floor(monthIndex / 12)}-${String((monthIndex % 12) + 1).padStart(2, '0')}-01`;
    out.push(byMonth.get(timestamp.slice(0, 7)) ?? zero(timestamp));
  }
  return out;
}

const EMPTY_BUCKET = (timestamp: string): TimelineBucket => ({
  timestamp,
  requests: 0,
  successCount: 0,
  failureCount: 0,
  inputTokens: 0,
  outputTokens: 0,
})

export default function AnalyticsPage() {
  const { t } = useI18n()
  // The window: either a preset or an explicit date pair, remembered together
  // so switching to a preset and back does not lose the custom span.
  const [range, setRange] = useState<TimeRange | typeof CUSTOM>(storedRange)
  const [custom, setCustom] = useState<CustomWindow>(storedCustom)
  const updateRange = (r: TimeRange | typeof CUSTOM) => {
    setRange(r)
    try { localStorage.setItem(RANGE_KEY, r) } catch { /* ignore */ }
  }
  const updateCustom = (next: CustomWindow) => {
    setCustom(next)
    setRange(CUSTOM)
    try {
      localStorage.setItem(`${RANGE_KEY}.custom`, JSON.stringify(next))
      localStorage.setItem(RANGE_KEY, CUSTOM)
    } catch { /* ignore */ }
  }

  // The filters sit ABOVE the panels, so every card, chart and table answers
  // for the same slice of traffic. They replace the status/provider pair that
  // used to live in the recent-calls table header and moved that one table
  // alone.
  const [filters, setFilters] = useState<FilterState>(storedFilters)
  const updateFilter = <K extends keyof FilterState>(key: K, value: FilterState[K]) => {
    setFilters(prev => {
      const next = { ...prev, [key]: value }
      try { localStorage.setItem(FILTERS_KEY, JSON.stringify(next)) } catch { /* ignore */ }
      return next
    })
  }
  const filtersActive = filters.status !== 'all' || filters.provider !== 'all' || filters.model !== 'all'

  const [device, setDevice] = useState<DeviceScope>(storedDevice)
  const updateDevice = (d: DeviceScope) => {
    setDevice(d)
    try { localStorage.setItem(DEVICE_KEY, d) } catch { /* ignore */ }
  }
  // Compare overlays machines rather than filtering to one, so every panel that
  // cannot show two series at once keeps showing everything.
  const comparing = device === 'compare'
  // What the per-panel queries scope to. Compare and All both mean unfiltered.
  const scope = comparing || device === 'all' ? '' : device
  // Capture "now" once at mount so the savings extrapolation below stays a pure
  // render (calling Date.now() during render is impure and non-deterministic).
  const [now] = useState(() => Date.now())

  // One query string, shared by every panel. `scope`, the window and all three
  // filters ride the key as well, so react-query caches each combination on its
  // own and switching back to a previous view is instant.
  const params = useMemo(
    () => windowParams(range, custom, scope, filters),
    [range, custom.from, custom.to, scope, filters.status, filters.provider, filters.model],
  )

  const { data: summary, isLoading: summaryLoading } = useQuery({
    queryKey: ['analytics', 'summary', params],
    queryFn: () => apiFetch<SummaryResponse>(`/api/analytics/summary?${params}`),
  })

  // Response-cache health: how often identical requests were served from memory
  // (zero quota cost) vs. spending a free-tier slot. The cache is process-local,
  // so these are lifetime-this-boot numbers, not range-filtered — and not
  // device-filtered either, which is why this card keeps its own wording.
  const { data: cacheStats } = useQuery({
    queryKey: ['cache', 'stats'],
    queryFn: () => apiFetch<CacheStatsResponse>('/api/cache/stats'),
  })

  // The provider filter needs its own option list, and that list must NOT be
  // the filtered one: filtering to `groq` would leave `openrouter` unselectable,
  // and the operator could never widen the filter again. Built from the widest
  // window with no filters, for the same reason the device tabs are (below).
  const { data: providerOptions = [] } = useQuery({
    queryKey: ['analytics', 'provider-facets'],
    queryFn: () => apiFetch<ByPlatformRow[]>('/api/analytics/by-platform?range=365d'),
  })

  // The provider breakdown itself, scoped to the window and the filters like
  // every other panel. Selecting a provider narrows it to that one row — which
  // is the point of a page-level filter — and the dropdown above is the way
  // back out, so the facet list below stays unfiltered for exactly that reason.
  const { data: byPlatform = [] } = useQuery({
    queryKey: ['analytics', 'by-platform', params],
    queryFn: () => apiFetch<ByPlatformRow[]>(`/api/analytics/by-platform?${params}`),
  })

  // Friendly display name per providerId: catalog → the platform id, custom →
  // the endpoint host. Used by the filter dropdown so a selected custom relay
  // shows 'relay.example.com', not 'custom:https://relay.example.com' (#889).
  const providerDisplay = new Map(providerOptions.map((p) => [p.providerId, p.endpoint ?? p.platform]))

  // Never device-scoped: this IS the device breakdown, and filtering it to one
  // machine would leave a table with a single row and no tabs to leave by.
  const { data: byClient = [] } = useQuery({
    queryKey: ['analytics', 'by-client', params],
    queryFn: () => apiFetch<ByClientRow[]>(`/api/analytics/by-client?${params}`),
  })

  // Browser's offset from UTC in minutes (480 = UTC+8), so the server buckets
  // the timeline on the viewer's wall clock instead of UTC.
  const tzOffset = -new Date().getTimezoneOffset()

  const { data: timeline = [] } = useQuery({
    queryKey: ['analytics', 'timeline', params, tzOffset],
    queryFn: () => apiFetch<TimelineBucket[]>(`/api/analytics/timeline?${params}&tzOffset=${tzOffset}`),
  })

  // Gaps filled for the CHARTS only — see fillMonthlyGaps. Every count, table
  // and total reads the raw buckets, because "that month had no traffic" is a
  // true zero on a chart and a phantom row in a breakdown.
  const chartTimeline = useMemo(() => fillMonthlyGaps(timeline, EMPTY_BUCKET), [timeline])

  const { data: byModel = [] } = useQuery({
    queryKey: ['analytics', 'by-model', params],
    queryFn: () => apiFetch<ByModelRow[]>(`/api/analytics/by-model?${params}`),
  })

  const { data: byKey = [] } = useQuery({
    queryKey: ['analytics', 'by-key', params],
    queryFn: () => apiFetch<ByKeyRow[]>(`/api/analytics/by-key?${params}`),
  })

  const { data: errors = [] } = useQuery({
    queryKey: ['analytics', 'errors', params],
    queryFn: () => apiFetch<RecentErrorRow[]>(`/api/analytics/errors?${params}`),
  })

  const { data: errorDist } = useQuery({
    queryKey: ['analytics', 'error-distribution', params],
    queryFn: () => apiFetch<ErrorDistribution>(`/api/analytics/error-distribution?${params}`),
  })

  // The model filter's options come from the widest window too, for the same
  // reason: a filtered list would drop every model the filter excludes, so
  // widening it would be impossible.
  const { data: modelOptions = [] } = useQuery({
    queryKey: ['analytics', 'model-facets'],
    queryFn: () => apiFetch<ByModelRow[]>('/api/analytics/by-model?range=365d'),
  })

  // The model's readable name for the filter dropdown. Keyed by the SERVED
  // model id, because that is what `?model=` matches on.
  const modelDisplay = new Map(modelOptions.map((m) => [m.modelId, m.displayName]))

  const [detailId, setDetailId] = useState<number | null>(null)

  const { data: recentCalls } = useQuery({
    queryKey: ['analytics', 'requests', params],
    queryFn: () => apiFetch<RecentCallsResponse>(`/api/analytics/requests?${params}&limit=100`),
  })

  // The devices worth offering as tabs: the rollup rows, never a bare caller
  // like curl.
  //
  // Deliberately NOT read from the range-filtered breakdown above. A machine
  // that made no calls inside the selected window would drop out of the list,
  // and with it the tab bar itself — leaving the page filtered to that machine
  // with no All tab to escape by, because the selected device persists while
  // the control that changes it disappears. The tab bar is navigation, so it
  // is built from the widest window and stays put as the range moves.
  const { data: knownDevices = [] } = useQuery({
    queryKey: ['analytics', 'by-client', 'device-facets'],
    queryFn: () => apiFetch<ByClientRow[]>('/api/analytics/by-client?range=365d'),
  })
  const devices = useMemo(() => {
    const found = knownDevices.filter((c) => c.isDevice).map((c) => c.clientAgent)
    // A device selected earlier stays selectable even if it has since fallen
    // out of the facet window: the page is filtered to it, so it must appear
    // in the control that un-filters it.
    return found.includes(device) || device === 'all' || device === 'compare'
      ? found
      : [...found, device]
  }, [knownDevices, device])

  // Compare mode: one summary and one timeline per device, fetched in parallel
  // and only while comparing. `useQueries` rather than a loop of useQuery
  // because the device list is data, and hook order cannot depend on data.
  //
  // The WINDOW AND FILTERS ride these too, with only the device swapped per
  // series — otherwise Compare would answer for a different slice of traffic
  // than the cards directly below it.
  const compareSummaries = useQueries({
    queries: devices.map((d) => ({
      queryKey: ['analytics', 'summary', params, d],
      queryFn: () => apiFetch<SummaryResponse>(
        `/api/analytics/summary?${windowParams(range, custom, d, filters)}`),
      enabled: comparing,
    })),
  })
  const compareTimelines = useQueries({
    queries: devices.map((d) => ({
      queryKey: ['analytics', 'timeline', params, tzOffset, d],
      queryFn: () => apiFetch<TimelineBucket[]>(
        `/api/analytics/timeline?${windowParams(range, custom, d, filters)}&tzOffset=${tzOffset}`),
      enabled: comparing,
    })),
  })

  // The series name for the combined line. Not a device, so it can never
  // collide with one: a machine called "All" would need that literal UA.
  const ALL_SERIES = t('analytics.deviceAll')

  // Merge the per-device timelines AND the unfiltered one onto a single time
  // axis: one row per bucket, one key per series. `timeline` is already the
  // all-devices data while comparing (scope is empty in compare mode), so the
  // combined line costs no extra request.
  //
  // Buckets are only present where a series actually has traffic, so the union
  // of timestamps is taken and gaps left undefined — recharts breaks the line
  // rather than drawing through zero, which is the honest shape for "this
  // machine was asleep".
  const compareChart = useMemo(() => {
    if (!comparing) return []
    // One row per bucket, one key per series — so the row type has to carry both
    // the axis key and an open set of device names.
    type CompareRow = { timestamp: string } & Record<string, string | number>
    const byTimestamp = new Map<string, CompareRow>()
    const put = (name: string, buckets: TimelineBucket[]) => {
      for (const bucket of buckets) {
        const row = byTimestamp.get(bucket.timestamp) ?? { timestamp: bucket.timestamp }
        row[name] = bucket.requests
        byTimestamp.set(bucket.timestamp, row)
      }
    }
    put(ALL_SERIES, timeline)
    compareTimelines.forEach((q, i) => put(devices[i], q.data ?? []))
    const merged = [...byTimestamp.values()].sort((a, b) => a.timestamp.localeCompare(b.timestamp))
    // Same gap fill as the single-series chart, with every series missing from a
    // filled month left undefined rather than zeroed — recharts then breaks the
    // line there, which is still the honest shape for "this machine was asleep".
    return fillMonthlyGaps(merged, (timestamp) => ({ timestamp }))
  }, [comparing, compareTimelines, devices, timeline, ALL_SERIES])

  // How many buckets each series actually has. A series with a single point
  // draws NO line — there is no segment to draw — so it needs a visible dot or
  // it is legible only in the legend. Found by reading the plot: the MacBook
  // had one bucket and rendered as an empty chart with a legend entry.
  const seriesPointCounts = useMemo(() => {
    const counts = new Map<string, number>()
    for (const row of compareChart) {
      for (const key of Object.keys(row)) {
        if (key === 'timestamp') continue
        counts.set(key, (counts.get(key) ?? 0) + 1)
      }
    }
    return counts
  }, [compareChart])

  // Per-table column sort (client-side, remembered per table). `null` keeps
  // the API order, so the memoised arrays are the query data itself then.
  const recentCallsSort = useTableSort(RECENT_CALLS_SORT_KEY, RECENT_CALL_COLS)
  const byModelSort = useTableSort(BY_MODEL_SORT_KEY, BY_MODEL_COLS)
  const byKeySort = useTableSort(BY_KEY_SORT_KEY, BY_KEY_COLS)
  const recentCallRows = useMemo(
    () => sortRows(recentCalls?.rows ?? [], recentCallsSort.sort, recentCallValue),
    [recentCalls?.rows, recentCallsSort.sort],
  )
  const byModelRows = useMemo(() => sortRows(byModel, byModelSort.sort, byModelValue), [byModel, byModelSort.sort])
  const byKeyRows = useMemo(() => sortRows(byKey, byKeySort.sort, byKeyValue), [byKey, byKeySort.sort])
  // The list is capped at 100 rows while `total` counts the whole filtered
  // set; say so while a sort is active and there is more than what's loaded.
  const recentCallsSortHint = recentCallsSort.sort && recentCalls && recentCalls.total > recentCalls.rows.length
    ? t('analytics.sortHint', { count: recentCalls.rows.length })
    : null

  // The window's human-readable name, used on the stat card and in the savings
  // hint. A custom window is named by its dates rather than by a preset, since
  // there is no preset to name it after — and the server's echoed window bounds
  // are the authority, so a clamped or reordered pair still reads correctly.
  const windowLabel = range === CUSTOM ? `${custom.from} → ${custom.to}` : t(RANGE_LABEL_KEY[range])
  // The window as the SERVER resolved it. Preferred over the local label for a
  // custom span, because the server clamps and reorders and this is the truth.
  const resolvedWindowLabel = summary?.windowSince && summary?.windowUntil && range === CUSTOM
    ? `${summary.windowSince.slice(0, 10)} → ${summary.windowUntil.slice(0, 10)}`
    : windowLabel


  // Savings card shows the SELECTED window's actual figure, so the number moves
  // when the window changes. It used to render one 30-day projection at every
  // setting, which made 24h, 7d, 30d and 90d read identically and looked like a
  // frozen stat rather than a deliberate choice.
  //
  // The 30-day pace still has a place — it is the "what does this save me a
  // month" number — so it moves into the hover hint, where an unchanging value
  // is not mistaken for a broken one. It carries the same device scope and
  // filters as the window it annotates, so the hint and the figure describe the
  // same traffic.
  const { data: summary30 } = useQuery({
    queryKey: ['analytics', 'summary', windowParams('30d', custom, scope, filters)],
    queryFn: () => apiFetch<SummaryResponse>(
      `/api/analytics/summary?${windowParams('30d', custom, scope, filters)}`),
  })
  const actualSavings = summary?.estimatedCostSavings ?? 0
  const baseSavings = summary30?.estimatedCostSavings ?? 0
  const spanDays = (() => {
    if (!summary30?.firstRequestAt) return 30
    // SQLite stores UTC "YYYY-MM-DD HH:MM:SS"
    const first = new Date(summary30.firstRequestAt.replace(' ', 'T') + 'Z').getTime()
    const days = (now - first) / 86_400_000
    if (!Number.isFinite(days)) return 30
    return Math.min(Math.max(days, 1 / 24), 30)
  })()
  const extrapolated = spanDays < 29.5
  const savings30d = extrapolated ? baseSavings * (30 / spanDays) : baseSavings
  const spanLabel = spanDays >= 2 ? t('analytics.spanDays', { count: Math.round(spanDays) }) : t('analytics.spanHours', { count: Math.max(1, Math.round(spanDays * 24)) })
  const savingsHint = extrapolated
    ? t('analytics.savingsHintWindow', { window: resolvedWindowLabel, monthly: savings30d.toFixed(2), span: spanLabel })
    : t('analytics.savingsHintWindowExact', { window: resolvedWindowLabel, monthly: savings30d.toFixed(2) })

  // Pinned = the client named a specific model instead of auto-routing.
  // Honored = that model actually served it (the rest failed over).
  const pinned = summary?.pinnedRequests ?? 0
  const pinHonored = summary?.pinHonoredRequests ?? 0
  const chatCount = summary?.requestTypeCounts?.chat ?? 0
  const embeddingCount = summary?.requestTypeCounts?.embedding ?? 0
  const requestsHint = (pinned > 0
    ? t('analytics.requestsHintPinned', { pinned, honored: pinHonored, failed: pinned - pinHonored })
    : t('analytics.requestsHintAuto'))
    + ' ' + t('analytics.requestsHintTypes', { chat: chatCount, embedding: embeddingCount })

  // Avg time-to-first-token is null when nothing streamed (or the raw window
  // was pruned); show a placeholder glyph rather than a misleading "0 ms".
  const avgTtfb = summary?.avgTtfbMs
  const ttftValue = avgTtfb != null ? `${avgTtfb} ms` : '—'

  // p95 latency is likewise null when the raw window was pruned; the server
  // does NOT coerce it (unlike avg latency), so a null must render the same
  // placeholder glyph instead of a misleading "0 ms".
  const p95Latency = summary?.p95LatencyMs
  const p95Value = p95Latency != null ? `${p95Latency} ms` : '—'

  // TTFT-by-provider is empty when no provider recorded a streaming first
  // token; render a muted line instead of an axis-only empty chart.
  const ttftHasData = byPlatform.some((p) => (p.avgTtfbMs ?? 0) > 0)

  return (
    <div className="analytics-viz">
      <style>{chartVars}</style>
      <PageHeader
        title={t('analytics.title')}
        description={t('analytics.description')}
        actions={
          <div className="flex flex-wrap items-center gap-2">
            {/* Device scope. Hidden while only one machine has ever been seen:
                the tabs would read All / that machine / a comparison of one,
                three ways to say the same thing.

                But NEVER hidden while a scope is selected. The selection
                persists in localStorage, so a control that disappears leaves
                the page filtered with no way back to All — and it would
                disappear exactly when a machine goes quiet, which is when an
                operator is most likely to be looking for it. */}
            {(devices.length > 1 || device !== 'all') && (
              <SegmentedControl
                value={device}
                onValueChange={updateDevice}
                options={[
                  { value: 'all', label: t('analytics.deviceAll') },
                  ...devices.map((d) => ({ value: d, label: d })),
                  // Comparing needs two machines to compare.
                  ...(devices.length > 1 ? [{ value: 'compare', label: t('analytics.deviceCompare') }] : []),
                ]}
                ariaLabel={t('analytics.device')}
              />
            )}
            <SegmentedControl
              value={range}
              onValueChange={updateRange}
              options={([...TIME_RANGES, CUSTOM] as Array<TimeRange | typeof CUSTOM>).map(r => ({
                value: r,
                label: r === CUSTOM ? t('analytics.rangeCustom') : t(RANGE_LABEL_KEY[r]),
              }))}
              ariaLabel={t('analytics.rangeLabel')}
            />
           </div>
        }
      />

      {/* Window + filters. These sit ABOVE every card and chart on purpose: the
          status, provider and model selectors used to live in the recent-calls
          table header, where choosing one moved that one table and left the
          stat cards, the timeline and both breakdowns describing different
          traffic. One bar, one scope, every panel follows. */}
      <div className="mb-6 flex flex-wrap items-end gap-2">
        {range === CUSTOM && (
          <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
            {t('analytics.from')}
            <input
              type="date"
              value={custom.from}
              max={custom.to}
              onChange={e => e.target.value && updateCustom({ ...custom, from: e.target.value })}
              aria-label={t('analytics.from')}
              className="h-8 rounded-lg border border-input bg-transparent px-2 text-xs md:text-sm"
            />
          </label>
        )}
        {range === CUSTOM && (
          <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
            {t('analytics.to')}
            <input
              type="date"
              value={custom.to}
              min={custom.from}
              onChange={e => e.target.value && updateCustom({ ...custom, to: e.target.value })}
              aria-label={t('analytics.to')}
              className="h-8 rounded-lg border border-input bg-transparent px-2 text-xs md:text-sm"
            />
          </label>
        )}
        <SegmentedControl
          value={filters.status}
          onValueChange={v => updateFilter('status', v)}
          options={[
            { value: 'all', label: t('analytics.filterAllStatuses') },
            { value: 'success', label: t('common.success') },
            { value: 'error', label: t('analytics.errors') },
            { value: 'canceled', label: t('analytics.filterCanceled') },
          ]}
          ariaLabel={t('common.status')}
        />
        <Select value={filters.provider} onValueChange={v => updateFilter('provider', v ?? 'all')}>
          <SelectTrigger size="sm" aria-label={t('common.provider')}>
            <SelectValue>
              {(v: string) => (!v || v === 'all' ? t('analytics.allProviders') : providerDisplay.get(v) ?? v)}
            </SelectValue>
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">{t('analytics.allProviders')}</SelectItem>
            {providerOptions.map((p) => (
              <SelectItem key={p.providerId} value={p.providerId}>
                <span className="flex items-center gap-2">
                  <PlatformDot platform={p.platform} />
                  <span>{p.endpoint ?? p.platform}</span>
                </span>
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value={filters.model} onValueChange={v => updateFilter('model', v ?? 'all')}>
          <SelectTrigger size="sm" aria-label={t('common.model')}>
            <SelectValue>
              {(v: string) => (!v || v === 'all' ? t('analytics.allModels') : modelDisplay.get(v) ?? v)}
            </SelectValue>
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">{t('analytics.allModels')}</SelectItem>
            {modelOptions.map((m) => (
              <SelectItem key={`${m.providerId ?? m.platform}:${m.modelId}`} value={m.modelId}>
                <span className="flex items-center gap-2">
                  <PlatformDot platform={m.platform} />
                  <span className="truncate">{m.displayName}</span>
                </span>
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {/* A visible reset, because every one of these persists: a filter set
            in a session an hour ago is still applied on return, and a page that
            quietly shows a subset with no marker reads as the whole. */}
        {filtersActive && (
          <button
            type="button"
            onClick={() => {
              setFilters({ status: 'all', provider: 'all', model: 'all' })
              try { localStorage.removeItem(FILTERS_KEY) } catch { /* ignore */ }
            }}
            className="h-8 rounded-lg border px-2.5 text-xs text-muted-foreground hover:bg-muted"
          >
            {t('analytics.clearFilters')}
          </button>
        )}
      </div>

      {/* Say so when the window reaches past the oldest surviving raw row. The
          aggregate-backed totals stay right; latency spread, TTFT, savings and
          the two breakdowns do not, and a 365-day card that silently covers
          40 days is worse than one that admits it. The date named is the
          oldest retained row — where per-request detail stops. */}
      {summary?.rawWindowTruncated && (
        <p className="mb-6 rounded-xl border border-amber-500/40 bg-amber-500/5 px-3 py-2 text-xs text-amber-700 dark:text-amber-400">
          {t('analytics.rawHorizonNotice', { oldest: summary.rawWindowOldest?.slice(0, 10) ?? summary.windowSince.slice(0, 10) })}
        </p>
      )}


      <div className="space-y-6">
        {/* Compare: the machines side by side, and their request volume on one
            axis. Everything BELOW this stays unfiltered while comparing, so
            the page reads as "here is each machine, and here is the whole
            picture they add up to" rather than blanking out. */}
        {comparing && (
          <div className="space-y-6">
            {/* One card per metric; every machine on its own line inside it,
                plus the unfiltered total as context. `summary` IS the
                all-devices figure while comparing (scope is empty then), so
                the total costs no extra request. */}
            <div className="grid gap-3 grid-cols-2 md:grid-cols-4">
              {COMPARE_METRICS.map(metric => (
                <Panel key={metric.labelKey} title={t(metric.labelKey)}>
                  <dl className="space-y-1.5">
                    {devices.map((d, i) => {
                      const s = compareSummaries[i]?.data
                      return (
                        <div key={d} className="flex items-baseline justify-between gap-2">
                          <dt className="flex min-w-0 items-center gap-1.5 text-[11px] text-muted-foreground">
                            <span
                              aria-hidden
                              className="size-2 shrink-0 rounded-full"
                              style={{ background: COMPARE_COLORS[i % COMPARE_COLORS.length] }}
                            />
                            <span className="truncate" title={d}>{d}</span>
                          </dt>
                          {s
                            ? <dd className="text-sm font-semibold tabular-nums">{metric.value(s)}</dd>
                            : <Skeleton className="h-4 w-10 rounded" />}
                        </div>
                      )
                    })}
                    {/* Muted and rule-separated, matching the dashed context
                        line in the chart: the whole these machines add up to,
                        not another machine. */}
                    <div className="flex items-baseline justify-between gap-2 border-t pt-1.5">
                      <dt className="text-[11px] text-muted-foreground">{ALL_SERIES}</dt>
                      {summary
                        ? <dd className="text-sm tabular-nums text-muted-foreground">{metric.value(summary)}</dd>
                        : <Skeleton className="h-4 w-10 rounded" />}
                    </div>
                  </dl>
                </Panel>
              ))}
            </div>

            <Panel icon={ChartLine} title={t('analytics.compareRequests')}>
              {compareChart.length === 0 ? (
                <p className="text-sm text-muted-foreground text-center py-8">{t('common.noData')}</p>
              ) : (
                <ResponsiveContainer width="100%" height={240}>
                  <LineChart data={compareChart} margin={{ top: 6, right: 6, left: -12, bottom: 0 }}>
                    <CartesianGrid strokeDasharray="2 4" stroke={gridStyle} />
                    <XAxis dataKey="timestamp" type="category" tick={axisStyle} tickLine={false} axisLine={{ stroke: gridStyle }} tickFormatter={formatTimelineTick} />
                    <YAxis tick={axisStyle} tickLine={false} axisLine={false} />
                    <Tooltip contentStyle={tooltipStyle} labelFormatter={(label) => formatTimelineTick(String(label))} />
                    <Legend wrapperStyle={{ fontSize: 12 }} iconType="line" />
                    {/* The combined line first, so the devices draw over it.
                        Dashed and muted: it is the context the machines sit
                        inside, not a third machine. */}
                    <Line
                      type="monotone"
                      dataKey={ALL_SERIES}
                      name={ALL_SERIES}
                      stroke="var(--muted-foreground)"
                      strokeWidth={1.5}
                      strokeDasharray="4 3"
                      dot={(seriesPointCounts.get(ALL_SERIES) ?? 0) <= 2 ? { r: 3 } : false}
                      connectNulls={false}
                    />
                    {devices.map((d, i) => (
                      <Line
                        key={d}
                        type="monotone"
                        dataKey={d}
                        name={d}
                        stroke={COMPARE_COLORS[i % COMPARE_COLORS.length]}
                        strokeWidth={2}
                        // A series with one or two points has no segment long
                        // enough to read, and with a single point none at all:
                        // recharts draws nothing and the machine exists only in
                        // the legend. Mark those explicitly.
                        dot={(seriesPointCounts.get(d) ?? 0) <= 2 ? { r: 3 } : false}
                        // A machine that made no calls in a bucket has no data
                        // point there; joining across the gap would draw
                        // traffic that never happened.
                        connectNulls={false}
                      />
                    ))}
                  </LineChart>
                </ResponsiveContainer>
              )}
            </Panel>
          </div>
        )}
        {/* Summary stats */}
        <div className="grid grid-cols-2 md:grid-cols-4 xl:grid-cols-4 gap-3">
          {summaryLoading ? (
            // Same count as the cards below, cache card included, so the row
            // does not reflow when the summary lands.
            Array.from({ length: cacheStats?.enabled ? 9 : 8 }).map((_, i) => <Skeleton key={i} className="h-[74px] rounded-3xl" />)
          ) : (
            <>
              <Stat icon={Activity} label={t('analytics.requests')} value={summary?.totalRequests ?? 0} hint={requestsHint} />
              <Stat icon={CheckCircle2} label={t('analytics.successRate')} value={`${summary?.successRate ?? 0}%`} />
              <Stat icon={ArrowDown} label={t('analytics.inputTokens')} value={formatTokens(summary?.totalInputTokens)} />
              <Stat icon={ArrowUp} label={t('analytics.outputTokens')} value={formatTokens(summary?.totalOutputTokens)} />
              <Stat icon={Gauge} label={t('analytics.avgLatency')} value={`${summary?.avgLatencyMs ?? 0} ms`} />
              <Stat icon={Clock} label={t('analytics.p95Latency')} value={p95Value} />
              <Stat icon={Zap} label={t('analytics.avgTtft')} value={ttftValue} />
              {/* Priced per request at the served model's paid-API equivalent rate,
                  not a flat frontier-model rate — see db/model-pricing.ts. The value
                  follows the window and the filters; the hover hint carries the
                  30-day pace and says whether it was extrapolated. */}
              <Stat icon={CircleDollarSign} label={t('analytics.estSavings')} value={`$${actualSavings.toFixed(2)}`} sub={windowLabel} hint={savingsHint} />
              {/* Response-cache impact, as ONE card: hit rate with the tokens
                  it gave back underneath. Rendered only when the cache is on,
                  so installs that opted out neither lose a slot in this row nor
                  see a misleading 0%. */}
              {cacheStats?.enabled && (
                <Stat
                  icon={Archive}
                  label={t('analytics.cacheHitRate')}
                  value={`${Math.round(cacheStats.hitRate * 100)}%`}
                  sub={t('analytics.cacheSavedTokens', { tokens: formatTokens(cacheStats.savedTokens) })}
                  hint={t('analytics.cacheHitRateHint', { hits: cacheStats.lookupHits, misses: cacheStats.lookupMisses, requests: cacheStats.estimatedRequestsSaved })}
                />
              )}
            </>
          )}
        </div>

        {/* The fleet's own window is day-granular and bucketed in UTC, so a
            custom span cannot be expressed on its endpoint. It follows the
            preset when one is selected, and the WIDEST preset while a custom
            span is active — the card's own numbers (the proxy half) still come
            from `summary`, which does honour the custom window. */}
        <OffloadedInference
          range={range === CUSTOM ? '365d' : range}
          device={scope}
          now={now}
          proxy={summary && {
            requests: summary.totalRequests,
            inputTokens: summary.totalInputTokens,
            outputTokens: summary.totalOutputTokens,
            valueUsd: summary.estimatedCostSavings ?? 0,
          }}
        />

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          <div className="lg:col-span-2">
            <Panel icon={ChartLine} title={t('analytics.requestsOverTime')}>
              {timeline.length === 0 ? (
                <p className="text-sm text-muted-foreground text-center py-8">{t('common.noData')}</p>
              ) : (
                <ResponsiveContainer width="100%" height={240}>
                  <LineChart data={chartTimeline} margin={{ top: 6, right: 6, left: -12, bottom: 0 }}>
                    <CartesianGrid strokeDasharray="2 4" stroke={gridStyle} />
                    <XAxis dataKey="timestamp" type="category" tick={axisStyle} tickLine={false} axisLine={{ stroke: gridStyle }} tickFormatter={formatTimelineTick} />
                    <YAxis tick={axisStyle} tickLine={false} axisLine={false} />
                    <Tooltip contentStyle={tooltipStyle} />
                    <Legend wrapperStyle={{ fontSize: 12 }} iconType="line" />
                    <Line type="monotone" dataKey="successCount" name={t('common.success')} stroke={primaryFill} strokeWidth={1.5} dot={false} />
                    <Line type="monotone" dataKey="failureCount" name={t('common.failures')} stroke="var(--destructive)" strokeWidth={1.5} dot={false} />
                  </LineChart>
                </ResponsiveContainer>
              )}
            </Panel>
          </div>

          {/* Tokens over time: input vs output, one axis, two-series legend. */}
          <div className="lg:col-span-2">
            <Panel icon={Coins} title={t('analytics.tokensOverTime')}>
              {timeline.length === 0 ? (
                <p className="text-sm text-muted-foreground text-center py-8">{t('common.noData')}</p>
              ) : (
                <ResponsiveContainer width="100%" height={240}>
                  <LineChart data={chartTimeline} margin={{ top: 6, right: 6, left: -12, bottom: 0 }}>
                    <CartesianGrid strokeDasharray="2 4" stroke={gridStyle} />
                    <XAxis dataKey="timestamp" type="category" tick={axisStyle} tickLine={false} axisLine={{ stroke: gridStyle }} tickFormatter={formatTimelineTick} />
                    <YAxis tick={axisStyle} tickLine={false} axisLine={false} tickFormatter={(v: number) => formatTokens(v)} />
                    <Tooltip contentStyle={tooltipStyle} formatter={(value) => formatTokens(Number(value))} />
                    <Legend wrapperStyle={{ fontSize: 12 }} iconType="line" />
                    <Line type="monotone" dataKey="inputTokens" name={t('analytics.inputTokens')} stroke={seriesA} strokeWidth={2} dot={false} />
                    <Line type="monotone" dataKey="outputTokens" name={t('analytics.outputTokens')} stroke={seriesB} strokeWidth={2} dot={false} />
                  </LineChart>
                </ResponsiveContainer>
              )}
            </Panel>
          </div>

          <Panel icon={Server} title={t('analytics.requestsByProvider')}>
            {byPlatform.length === 0 ? (
              <p className="text-sm text-muted-foreground text-center py-8">{t('common.noData')}</p>
            ) : (
              <ResponsiveContainer width="100%" height={240}>
                <BarChart data={byPlatform} margin={{ top: 6, right: 6, left: -12, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="2 4" stroke={gridStyle} />
                  <XAxis dataKey={(row: ByPlatformRow) => row.endpoint ?? row.platform} tick={axisStyle} tickLine={false} axisLine={{ stroke: gridStyle }} {...categoryAxisProps(byPlatform.length)} />
                  <YAxis tick={axisStyle} tickLine={false} axisLine={false} />
                  <Tooltip contentStyle={tooltipStyle} />
                  <Bar dataKey="requests" name={t('analytics.requests')} fill={primaryFill} radius={[3, 3, 0, 0]} maxBarSize={24} />
                </BarChart>
              </ResponsiveContainer>
            )}
          </Panel>

          {/* Callers rolled up to the DEVICE that made them. The server folds
              every User-Agent one machine has reported — a new row per harness
              version otherwise — and returns the raw list so the hover can show
              its working. See routes/analytics.ts DEVICE_SQL for the mapping
              and what it assumes about untagged history. */}
          <Panel icon={Bot} title={t('analytics.usageByDevice')}>
            {byClient.length === 0 ? (
              <p className="text-sm text-muted-foreground text-center py-8">{t('common.noData')}</p>
            ) : (
              <div className="max-h-[240px] overflow-y-auto -mx-4">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead className="pl-4">{t('analytics.device')}</TableHead>
                      <TableHead className="text-right">{t('analytics.requests')}</TableHead>
                      <TableHead className="text-right">{t('common.success')}</TableHead>
                      <TableHead className="text-right">{t('analytics.inTokens')}</TableHead>
                      <TableHead className="text-right">{t('analytics.outTokens')}</TableHead>
                      <TableHead className="text-right pr-4">{t('analytics.saved')}</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {byClient.map((c) => (
                      <TableRow key={c.clientAgent}>
                        <TableCell className="pl-4 text-xs font-medium max-w-[160px] truncate" title={(c.agents ?? []).join('\n')}>
                          {c.clientAgent}
                        </TableCell>
                        <TableCell className="text-right tabular-nums">{c.requests}</TableCell>
                        <TableCell className="text-right tabular-nums">{c.successRate}%</TableCell>
                        <TableCell className="text-right tabular-nums">{formatTokens(c.totalInputTokens)}</TableCell>
                        <TableCell className="text-right tabular-nums">{formatTokens(c.totalOutputTokens)}</TableCell>
                        <TableCell className="text-right tabular-nums pr-4">${(c.estimatedCost ?? 0).toFixed(2)}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            )}
          </Panel>

          {/* Latency by provider: grouped avg + p95, same unit (ms), one axis. */}
          <Panel icon={Gauge} title={t('analytics.avgLatencyByProvider')}>
            {byPlatform.length === 0 ? (
              <p className="text-sm text-muted-foreground text-center py-8">{t('common.noData')}</p>
            ) : (
              <ResponsiveContainer width="100%" height={240}>
                <BarChart data={byPlatform} margin={{ top: 6, right: 6, left: -12, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="2 4" stroke={gridStyle} />
                  <XAxis dataKey={(row: ByPlatformRow) => row.endpoint ?? row.platform} tick={axisStyle} tickLine={false} axisLine={{ stroke: gridStyle }} {...categoryAxisProps(byPlatform.length)} />
                  <YAxis unit="ms" tick={axisStyle} tickLine={false} axisLine={false} />
                  <Tooltip contentStyle={tooltipStyle} />
                  <Legend wrapperStyle={{ fontSize: 12 }} iconType="rect" />
                  <Bar dataKey="avgLatencyMs" name={t('analytics.avgLatency')} fill={seriesA} radius={[3, 3, 0, 0]} maxBarSize={24} />
                  <Bar dataKey="p95LatencyMs" name={t('analytics.p95Latency')} fill={seriesB} radius={[3, 3, 0, 0]} maxBarSize={24} />
                </BarChart>
              </ResponsiveContainer>
            )}
          </Panel>

          {/* Time to first token by provider (single series → no legend). */}
          <Panel icon={Zap} title={t('analytics.ttftByProvider')}>
            {byPlatform.length === 0 ? (
              <p className="text-sm text-muted-foreground text-center py-8">{t('common.noData')}</p>
            ) : !ttftHasData ? (
              <p className="text-sm text-muted-foreground text-center py-8">{t('analytics.ttftEmpty')}</p>
            ) : (
              <ResponsiveContainer width="100%" height={240}>
                <BarChart data={byPlatform} margin={{ top: 6, right: 6, left: -12, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="2 4" stroke={gridStyle} />
                  <XAxis dataKey={(row: ByPlatformRow) => row.endpoint ?? row.platform} tick={axisStyle} tickLine={false} axisLine={{ stroke: gridStyle }} {...categoryAxisProps(byPlatform.length)} />
                  <YAxis unit="ms" tick={axisStyle} tickLine={false} axisLine={false} />
                  <Tooltip contentStyle={tooltipStyle} />
                  <Bar dataKey="avgTtfbMs" name={t('analytics.avgTtft')} fill={seriesA} radius={[3, 3, 0, 0]} maxBarSize={24} />
                </BarChart>
              </ResponsiveContainer>
            )}
          </Panel>

          {/* Errors by category: horizontal bars, destructive hue, no legend. */}
          <Panel icon={TriangleAlert} title={t('analytics.errorDistribution')}>
            {!errorDist?.byCategory?.length ? (
              <p className="text-sm text-muted-foreground text-center py-8">{t('analytics.noErrors')}</p>
            ) : (
              <ResponsiveContainer width="100%" height={240}>
                <BarChart data={errorDist.byCategory} layout="vertical" margin={{ top: 6, right: 12, left: 8, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="2 4" stroke={gridStyle} horizontal={false} />
                  <XAxis type="number" tick={axisStyle} tickLine={false} axisLine={{ stroke: gridStyle }} allowDecimals={false} />
                  <YAxis type="category" dataKey="category" tick={axisStyle} tickLine={false} axisLine={false} {...verticalCategoryAxisProps()} />
                  <Tooltip contentStyle={tooltipStyle} />
                  <Bar dataKey="count" name={t('analytics.errors')} fill="var(--destructive)" radius={[0, 3, 3, 0]} maxBarSize={24} />
                </BarChart>
              </ResponsiveContainer>
            )}
          </Panel>

          <Panel icon={CircleAlert} title={t('analytics.errorsByProvider')}>
            {!errorDist?.byPlatform?.length ? (
              <p className="text-sm text-muted-foreground text-center py-8">{t('analytics.noErrors')}</p>
            ) : (
              <ResponsiveContainer width="100%" height={240}>
                <BarChart data={errorDist.byPlatform} margin={{ top: 6, right: 6, left: -12, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="2 4" stroke={gridStyle} />
                  <XAxis dataKey={(row: ErrorDistribution['byPlatform'][number]) => row.endpoint ?? row.platform} tick={axisStyle} tickLine={false} axisLine={{ stroke: gridStyle }} {...categoryAxisProps(errorDist.byPlatform.length)} />
                  <YAxis tick={axisStyle} tickLine={false} axisLine={false} />
                  <Tooltip contentStyle={tooltipStyle} />
                  <Bar dataKey="count" name={t('analytics.errors')} fill="var(--destructive)" radius={[3, 3, 0, 0]} maxBarSize={24} />
                </BarChart>
              </ResponsiveContainer>
            )}
          </Panel>

          <Panel icon={CircleAlert} title={t('analytics.recentErrors')}>
            {errors.length === 0 ? (
              <p className="text-sm text-muted-foreground text-center py-8">{t('analytics.noErrors')}</p>
            ) : (
              <div className="max-h-[240px] overflow-y-auto -mx-4">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead className="pl-4">{t('common.provider')}</TableHead>
                      <TableHead>{t('analytics.message')}</TableHead>
                      <TableHead className="text-right pr-4">{t('analytics.time')}</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {errors.slice(0, 20).map((e) => (
                      <TableRow key={e.id}>
                        <TableCell className="pl-4 text-xs">{e.endpoint ?? e.platform}</TableCell>
                        <TableCell className="text-xs max-w-[200px]">
                          {e.error
                            ? <HoverTooltip text={e.error} side="top" className="block truncate">{e.error}</HoverTooltip>
                            : null}
                        </TableCell>
                        <TableCell className="text-right text-xs text-muted-foreground tabular-nums pr-4">
                          {formatSqliteUtcToLocalTime(e.createdAt, { hour: '2-digit', minute: '2-digit' })}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            )}
          </Panel>

          {/* Recent calls: one line per proxied request with the caller's IP +
              user agent. All local clients share the unified key, so this is
              the only view that answers "who is hitting the router". Rows open
              the failover-ladder drill-down.

              It carries NO filter controls of its own: the status and provider
              selectors that used to sit here moved to the page-level bar above
              the cards, where they scope every panel rather than only this
              table. Two filters in two places was how the list and the charts
              came to describe different traffic. */}
          <div className="lg:col-span-2">
            <Panel icon={List} title={t('analytics.recentCalls')}>
              {recentCallsSortHint && (
                <p className="pb-2 text-xs text-muted-foreground">{recentCallsSortHint}</p>
              )}
              {!recentCalls?.rows?.length ? (
                <p className="text-sm text-muted-foreground text-center py-8">{t('common.noData')}</p>
              ) : (
                <div className="max-h-[420px] overflow-y-auto -mx-4">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <SortableHeader column="time" label={t('analytics.time')} className="pl-4" sort={recentCallsSort.sort} onToggle={recentCallsSort.toggle} />
                        <SortableHeader column="ip" label={t('analytics.clientIp')} sort={recentCallsSort.sort} onToggle={recentCallsSort.toggle} />
                        <SortableHeader column="agent" label={t('analytics.clientAgent')} sort={recentCallsSort.sort} onToggle={recentCallsSort.toggle} />
                        <SortableHeader column="model" label={t('common.model')} sort={recentCallsSort.sort} onToggle={recentCallsSort.toggle} />
                        <SortableHeader column="provider" label={t('common.provider')} sort={recentCallsSort.sort} onToggle={recentCallsSort.toggle} />
                        <SortableHeader column="status" label={t('common.status')} sort={recentCallsSort.sort} onToggle={recentCallsSort.toggle} />
                        <SortableHeader column="attempts" label={t('analytics.attempts')} align="right" sort={recentCallsSort.sort} onToggle={recentCallsSort.toggle} />
                        <SortableHeader column="inTokens" label={t('analytics.inTokens')} align="right" sort={recentCallsSort.sort} onToggle={recentCallsSort.toggle} />
                        <SortableHeader column="outTokens" label={t('analytics.outTokens')} align="right" sort={recentCallsSort.sort} onToggle={recentCallsSort.toggle} />
                        <SortableHeader column="latency" label={t('analytics.latency')} align="right" className="pr-4" sort={recentCallsSort.sort} onToggle={recentCallsSort.toggle} />
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {recentCallRows.map((r) => (
                        <TableRow
                          key={r.id}
                          onClick={() => setDetailId(r.id)}
                          className="cursor-pointer"
                        >
                          <TableCell className="pl-4 text-xs text-muted-foreground tabular-nums whitespace-nowrap">
                            {formatSqliteUtcToLocalTime(r.createdAt, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' })}
                          </TableCell>
                          <TableCell className="text-xs font-medium tabular-nums">{r.clientIp ?? '—'}</TableCell>
                          <TableCell className="text-xs text-muted-foreground" title={r.clientUserAgent ?? undefined}>
                            {shortUserAgent(r.clientUserAgent)}
                          </TableCell>
                          <TableCell className="text-xs max-w-[220px] truncate" title={r.requestedModel && r.requestedModel !== r.modelId ? t('analytics.requestedModelHint', { model: r.requestedModel }) : undefined}>
                            {r.modelId}
                            {r.requestedModel && r.requestedModel !== r.modelId ? ' *' : ''}
                          </TableCell>
                          <TableCell className="text-xs text-muted-foreground">
                            {r.platform === 'custom' && r.keyLabel ? r.keyLabel : r.platform}
                          </TableCell>
                          <TableCell className={`text-xs ${statusTextClass(r.status)}`} title={r.error ?? undefined}>
                            {r.status}
                          </TableCell>
                          {/* >1 = the request burned failover hops; that is the
                              row worth drilling into, so give it weight. */}
                          <TableCell className={`text-right text-xs tabular-nums ${r.attemptCount > 1 ? 'font-medium' : 'text-muted-foreground'}`}>
                            {r.attemptCount > 0 ? r.attemptCount : '—'}
                          </TableCell>
                          <TableCell className="text-right text-xs tabular-nums">{formatTokens(r.inputTokens)}</TableCell>
                          <TableCell className="text-right text-xs tabular-nums">{formatTokens(r.outputTokens)}</TableCell>
                          <TableCell className="text-right text-xs tabular-nums pr-4">{r.latencyMs} ms</TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              )}
            </Panel>
          </div>

          {/* Per-provider breakdown: the tabular face of the by-platform data —
              the charts above show volume/latency, this row surfaces the
              success-rate and error-count numbers (#335). */}
          <div className="lg:col-span-2">
            <Panel icon={Network} title={t('analytics.providerBreakdown')}>
              {byPlatform.length === 0 ? (
                <p className="text-sm text-muted-foreground text-center py-8">{t('common.noData')}</p>
              ) : (
                <div className="max-h-[360px] overflow-y-auto -mx-4">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead className="pl-4">{t('common.provider')}</TableHead>
                        <TableHead className="text-right">{t('analytics.requests')}</TableHead>
                        <TableHead className="text-right">{t('common.success')}</TableHead>
                        <TableHead className="text-right">{t('analytics.errors')}</TableHead>
                        <TableHead className="text-right">{t('analytics.avgLatency')}</TableHead>
                        <TableHead className="text-right">{t('analytics.p95Latency')}</TableHead>
                        <TableHead className="text-right">{t('analytics.avgTtft')}</TableHead>
                        <TableHead className="text-right">{t('analytics.tokensPerSec')}</TableHead>
                        <TableHead className="text-right">{t('analytics.inTokens')}</TableHead>
                        <TableHead className="text-right">{t('analytics.outTokens')}</TableHead>
                        <TableHead className="text-right pr-4">{t('analytics.saved')}</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {byPlatform.map((p) => (
                        <TableRow key={p.providerId}>
                          <TableCell className="pl-4 text-sm font-medium">
                            <span className="flex items-center gap-2">
                              <PlatformDot platform={p.platform} />
                              {p.endpoint ?? p.platform}
                            </span>
                          </TableCell>
                          <TableCell className="text-right tabular-nums">{p.requests}</TableCell>
                          <TableCell className="text-right tabular-nums">{p.successRate}%</TableCell>
                          <TableCell className={`text-right tabular-nums ${p.errorCount > 0 ? 'text-destructive' : ''}`}>
                            {p.errorCount > 0 ? p.errorCount : '—'}
                          </TableCell>
                          <TableCell className="text-right tabular-nums">{p.avgLatencyMs} ms</TableCell>
                          <TableCell className="text-right tabular-nums">{p.p95LatencyMs != null ? `${p.p95LatencyMs} ms` : '—'}</TableCell>
                          <TableCell className="text-right tabular-nums">{p.avgTtfbMs != null ? `${p.avgTtfbMs} ms` : '—'}</TableCell>
                          <TableCell className="text-right tabular-nums">{p.avgTokensPerSecond != null ? p.avgTokensPerSecond : '—'}</TableCell>
                          <TableCell className="text-right tabular-nums">{formatTokens(p.totalInputTokens)}</TableCell>
                          <TableCell className="text-right tabular-nums">{formatTokens(p.totalOutputTokens)}</TableCell>
                          <TableCell className="text-right tabular-nums pr-4">${(p.estimatedCost ?? 0).toFixed(2)}</TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              )}
            </Panel>
          </div>

          <div className="lg:col-span-2">
            <Panel icon={Layers} title={t('analytics.perModelBreakdown')}>
              {byModel.length === 0 ? (
                <p className="text-sm text-muted-foreground text-center py-8">{t('common.noData')}</p>
              ) : (
                <div className="max-h-[360px] overflow-y-auto -mx-4">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <SortableHeader column="model" label={t('common.model')} className="pl-4" sort={byModelSort.sort} onToggle={byModelSort.toggle} />
                        <SortableHeader column="provider" label={t('common.provider')} sort={byModelSort.sort} onToggle={byModelSort.toggle} />
                        <SortableHeader column="requests" label={t('analytics.requests')} align="right" sort={byModelSort.sort} onToggle={byModelSort.toggle} />
                        <SortableHeader column="pinned" label={t('analytics.pinned')} align="right" sort={byModelSort.sort} onToggle={byModelSort.toggle} />
                        <SortableHeader column="success" label={t('common.success')} align="right" sort={byModelSort.sort} onToggle={byModelSort.toggle} />
                        <SortableHeader column="latency" label={t('analytics.latency')} align="right" sort={byModelSort.sort} onToggle={byModelSort.toggle} />
                        <SortableHeader column="inTokens" label={t('analytics.inTokens')} align="right" sort={byModelSort.sort} onToggle={byModelSort.toggle} />
                        <SortableHeader column="outTokens" label={t('analytics.outTokens')} align="right" sort={byModelSort.sort} onToggle={byModelSort.toggle} />
                        <SortableHeader column="saved" label={t('analytics.saved')} align="right" className="pr-4" sort={byModelSort.sort} onToggle={byModelSort.toggle} />
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {byModelRows.map((m) => (
                        <TableRow key={`${m.providerId ?? m.platform}:${m.modelId}`}>
                          <TableCell className="pl-4 text-sm font-medium">{m.displayName}</TableCell>
                          <TableCell className="text-xs text-muted-foreground">{m.endpoint ?? m.platform}</TableCell>
                          <TableCell className="text-right tabular-nums">{m.requests}</TableCell>
                          <TableCell className="text-right tabular-nums">{m.pinnedRequests > 0 ? m.pinnedRequests : '—'}</TableCell>
                          <TableCell className="text-right tabular-nums">{m.successRate}%</TableCell>
                          <TableCell className="text-right tabular-nums">{m.avgLatencyMs} ms</TableCell>
                          <TableCell className="text-right tabular-nums">{formatTokens(m.totalInputTokens)}</TableCell>
                          <TableCell className="text-right tabular-nums">{formatTokens(m.totalOutputTokens)}</TableCell>
                          <TableCell className="text-right tabular-nums pr-4">${(m.estimatedCost ?? 0).toFixed(2)}</TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              )}
            </Panel>
          </div>

          {/* Usage by key: only rendered when the endpoint returns rows. */}
          {byKey.length > 0 && (
            <div className="lg:col-span-2">
              <Panel icon={KeyRound} title={t('analytics.usageByKey')}>
                <div className="max-h-[360px] overflow-y-auto -mx-4">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <SortableHeader column="label" label={t('analytics.keyColumn')} className="pl-4" sort={byKeySort.sort} onToggle={byKeySort.toggle} />
                        <SortableHeader column="provider" label={t('common.provider')} sort={byKeySort.sort} onToggle={byKeySort.toggle} />
                        <SortableHeader column="requests" label={t('analytics.requests')} align="right" sort={byKeySort.sort} onToggle={byKeySort.toggle} />
                        <SortableHeader column="success" label={t('common.success')} align="right" sort={byKeySort.sort} onToggle={byKeySort.toggle} />
                        <SortableHeader column="latency" label={t('analytics.latency')} align="right" sort={byKeySort.sort} onToggle={byKeySort.toggle} />
                        <SortableHeader column="inTokens" label={t('analytics.inTokens')} align="right" sort={byKeySort.sort} onToggle={byKeySort.toggle} />
                        <SortableHeader column="outTokens" label={t('analytics.outTokens')} align="right" className="pr-4" sort={byKeySort.sort} onToggle={byKeySort.toggle} />
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {byKeyRows.map((k) => (
                        <TableRow key={k.keyId}>
                          <TableCell className="pl-4 text-sm font-medium">
                            {k.label || t('analytics.keyLabelFallback', { id: k.keyId })}
                          </TableCell>
                          <TableCell className="text-xs text-muted-foreground">{k.platform ?? '—'}</TableCell>
                          <TableCell className="text-right tabular-nums">{k.requests}</TableCell>
                          <TableCell className="text-right tabular-nums">{k.successRate}%</TableCell>
                          <TableCell className="text-right tabular-nums">{k.avgLatencyMs} ms</TableCell>
                          <TableCell className="text-right tabular-nums">{formatTokens(k.totalInputTokens)}</TableCell>
                          <TableCell className="text-right tabular-nums pr-4">{formatTokens(k.totalOutputTokens)}</TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              </Panel>
            </div>
          )}
        </div>
      </div>

      <RequestDetailDialog requestId={detailId} onClose={() => setDetailId(null)} />
    </div>
  )
}
