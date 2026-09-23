import { useMemo, useState, type ReactNode } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ExternalLink, RefreshCw, Scale } from 'lucide-react'
import { useI18n } from '@/i18n'
import { matchesCompareQuery, sortEntries, type SortKey } from '@/lib/compare-sort'
import { REFERENCE_ONLY_PLATFORMS } from '@/lib/routing'
import { ModelCombobox, type ModelComboOption } from '@/components/model-combobox'
import { ModelName } from '@/components/model-name'
import { apiFetch } from '@/lib/api'
import { toast } from '@/lib/toast'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { ScopePicker } from '@/components/compare/scope-picker'
import { ClifreeFleet, useFleet } from '@/components/clifree-fleet'
import { vendorTint } from '@/lib/vendor-tint'
import { useExtensionEnabled } from '@/lib/use-extension'
import { ChainPicker } from '@/components/compare/chain-picker'
import { Input } from '@/components/ui/input'
import { PageHeader } from '@/components/page-header'
import { PlatformDot, PlatformLegend, type PlatformScope } from '@/components/platform-dot'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Tooltip } from '@/components/tooltip'
import { ConfirmButton } from '@/components/confirm-button'

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
  /** Catalogue row id, needed to edit chain membership. */
  modelDbId: number
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
    indexCostPerTask: number | null
    medianOutputTokensPerSecond: number | null
    medianTimeToFirstTokenSeconds: number | null
  } | null
  link: { slug: string | null; source: 'auto' | 'manual' | 'proxy'; matchReason: string | null; unresolved: boolean; proxyDelta: { intelligence: number; coding: number; agentic: number; speed: number } } | null
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
  /** Free CLI routes reaching this capability, `provider:id`. Several when one
   *  model is served by more than one agent. */
  fleetSpecs?: string[]
  conflicted: boolean
  chains: string[]
  /** Per chain: where it sits, and which member row holds that slot. */
  chainRanks: Record<string, { rank: number; modelDbId: number }>
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
/** What the chart plots. The three indices are one scale and can share an axis;
 *  cost is a different quantity in different units, so it gets its own view
 *  rather than a fourth bar nobody could compare against the others. */
type ChartView = Metric | 'all' | 'costPerTask'

/**
 * Price, exactly as Artificial Analysis publishes it: USD per 1M input tokens
 * and per 1M output tokens, shown side by side.
 *
 * Three things were tried here before this and every one of them was arithmetic
 * of ours laid over their data — a task size invented in this file, their 3:1
 * blend applied by us, then their measured cost-per-task (their number, but
 * answering a different question). The page shows what they give: two prices,
 * unblended, in the units they state.
 *
 * Ranked on input price with output as the tie-break. That is an ordering
 * choice, not a derived figure: no number on screen is computed.
 *
 * Null on BOTH halves means unpriced, which is not free. Zero on both is free,
 * and that is a real answer.
 */
function priceOf(a: CompareGroup['analysis']): { input: number; output: number } | null {
  if (!a) return null
  if (a.price1mInput == null && a.price1mOutput == null) return null
  return { input: a.price1mInput ?? 0, output: a.price1mOutput ?? 0 }
}

function costPerTask(a: CompareGroup['analysis']): number | null {
  const p = priceOf(a)
  return p ? p.input : null
}

interface ProxyUpgrade {
  platform: string
  modelId: string
  displayName: string
  proxySlug: string
  proxyName: string
  realSlug: string
  realName: string
  matchReason: string
}

/**
 * Diagonal hatch for a model no chain is using.
 *
 * A row can be enabled, keyed, well scored and still serve nothing, which the
 * numbers cannot show: an unallocated model looks identical to a working one
 * until you read the chains column. The hatch makes "nothing routes here"
 * visible at a glance in the scopes where unallocated models are the majority.
 *
 * Baselines and fleet routes are excluded -- they are not ours to allocate, so
 * hatching them would mark a state they can never leave.
 */
const HATCH =
  'opacity-55 bg-[repeating-linear-gradient(45deg,transparent,transparent_3px,rgba(127,127,127,0.22)_3px,rgba(127,127,127,0.22)_7px)]'

function unallocated(g: CompareGroup): boolean {
  return !g.reference && g.chains.length === 0
}

/** A free CLI route, not a pinned baseline. Both are `reference: true`. */
function isFleet(g: CompareGroup): boolean {
  return g.groupKey.startsWith('fleet:')
}

/** Two-letter marks for the agents that can reach a capability. A merged row
 *  carries BOTH when the same model is served by both agents, which is the
 *  whole reason the marks exist: "reachable" is per-agent, and a row saying
 *  only "CLI Fleet" hides that one of your two wallets cannot serve it. */
const FLEET_MARK: Record<string, string> = { opencode: 'OC', cline: 'CL' }

/** One colour per agent, so a row's reach is readable without stopping to read
 *  two letters. Kept out of the metric palette above. */
const MARK_CLASS: Record<string, string> = {
  OC: 'border-indigo-500/40 bg-indigo-500/10 text-indigo-700 dark:text-indigo-300',
  CL: 'border-fuchsia-500/40 bg-fuchsia-500/10 text-fuchsia-700 dark:text-fuchsia-300',
}

/**
 * Which agents can reach this row.
 *
 * Two sources, because a row arrives here two ways. A fleet entry carries its
 * own specs. A CATALOGUE row -- one FreeLLM can serve -- carries none, and was
 * previously unmarked even when an agent reports reaching it: `MiMo-V2.5 ×5`
 * sat under the fleet scope saying nothing about why it was there.
 *
 * A catalogue row deliberately gets marks WITHOUT the orange badge. The badge
 * means "reachable only from a free CLI agent, never from FreeLLM", which is
 * false for a row we serve; the marks alone say "also reachable from these".
 */
function fleetMarks(g: CompareGroup, byModelId: Record<string, Record<string, true>>): string[] {
  const seen: Record<string, true> = {}
  for (const spec of g.fleetSpecs ?? []) {
    const mark = FLEET_MARK[spec.slice(0, spec.indexOf(':'))]
    if (mark) seen[mark] = true
  }
  for (const m of g.members) {
    for (const mark of Object.keys(byModelId[m.modelId] ?? {})) seen[mark] = true
  }
  return Object.keys(seen).sort()
}

type Scope = 'routed' | 'keyed' | 'enabled' | 'all' | 'clifree'

const SCOPES: { key: Scope; labelKey: string; hintKey: string }[] = [
  // Ordered narrowest to widest, and they now genuinely nest. Before this,
  // `enabled` counted models switched on ANYWHERE, including 476 on providers
  // with no key -- so it was larger than `keyed` and contained models `keyed`
  // did not, while the UI order and the comment below both claimed containment.
  { key: 'routed', labelKey: 'compare.scopeRouted', hintKey: 'compare.scopeRoutedHint' },
  { key: 'enabled', labelKey: 'compare.scopeEnabled', hintKey: 'compare.scopeEnabledHint' },
  { key: 'keyed', labelKey: 'compare.scopeKeyed', hintKey: 'compare.scopeKeyedHint' },
  { key: 'all', labelKey: 'compare.scopeAll', hintKey: 'compare.scopeAllHint' },
  { key: 'clifree', labelKey: 'compare.scopeClifree', hintKey: 'compare.scopeClifreeHint' },
]

/**
 * Widening rings, each a genuine superset of the last: serving a chain now,
 * switched on AND reachable, reachable at all, known to exist.
 *
 * `clifree` is NOT part of that progression. It is an orthogonal cut — the
 * routes a free CLI agent can actually drive — and it replaced a plain
 * `opencode` platform filter because the question was never "which rows are
 * OpenCode's". It was "what can I delegate to for free", and a Zen route no
 * machine reports is not an answer to that however the catalogue lists it.
 */
function inScope(g: CompareGroup, scope: Scope, fleetModelIds: Record<string, true>): boolean {
  switch (scope) {
    case 'routed': return g.chains.length > 0
    // Enabled AND reachable, tested on the SAME member. The group-level counts
    // cannot express that intersection: a group can hold one member that is
    // enabled but unkeyed and another that is keyed but switched off, and
    // `enabledMembers > 0 && keyedMembers > 0` would call that servable when
    // no single route is.
    case 'enabled': return g.members.some(m => m.enabled && m.hasKey)
    case 'keyed': return g.members.some(m => m.hasKey)
    case 'all': return true
    case 'clifree': return g.members.some(m => m.platform === 'opencode' && fleetModelIds[m.modelId] === true)
  }
}

const METRICS: { key: Metric; labelKey: string }[] = [
  { key: 'intelligenceIndex', labelKey: 'compare.intelligence' },
  { key: 'codingIndex', labelKey: 'compare.coding' },
  { key: 'agenticIndex', labelKey: 'compare.agentic' },
]

/** The three indices share one 0-100ish scale, so they can be read against each
 *  other on a common axis — which is the whole point of the overlay: a model
 *  strong on intelligence and weak on agentic is the shape you are looking for,
 *  and three separate screens cannot show it. */
const OVERLAY: { key: Metric; labelKey: string; bar: string }[] = [
  { key: 'intelligenceIndex', labelKey: 'compare.intelligence', bar: 'bg-emerald-500/70' },
  { key: 'codingIndex', labelKey: 'compare.coding', bar: 'bg-violet-500/70' },
  { key: 'agenticIndex', labelKey: 'compare.agentic', bar: 'bg-amber-500/70' },
]

const CHART_VIEWS: { key: ChartView; labelKey: string }[] = [
  ...METRICS,
  { key: 'all', labelKey: 'compare.chartAll' },
  { key: 'costPerTask', labelKey: 'compare.chartCost' },
]

export default function CompareModelsPage() {
  const { t } = useI18n()
  const queryClient = useQueryClient()
  const [keyDraft, setKeyDraft] = useState('')
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [metric, setMetric] = useState<ChartView>('intelligenceIndex')
  // What "available" means, said out loud. The page used to offer one toggle
  // between "in a chain" and "switched on", and neither answers the question
  // that decides whether a model can serve at all: do we hold a key for its
  // provider. On this install 510 of 588 models sit on providers we have no
  // key for — enabled, ranked, merged, and unreachable.
  const [scope, setScope] = useState<Scope>('routed')


  // Which catalogue routes a machine has actually reported reaching. Keyed by
  // modelId because that is what a CompareRow carries; the fleet's `spec` is
  // `provider:id` and only its opencode half can correspond to a catalogue row
  // at all — Cline has no rows here, by design, since FreeLLM cannot call it.
  const fleetEnabled = useExtensionEnabled('clifree-fleet-telemetry')
  const { data: fleetData } = useFleet(fleetEnabled)
  // modelId -> the agents that report reaching it. Only OpenCode ids can ever
  // match a catalogue row; Cline has none here, which is the whole reason its
  // routes need synthetic entries.
  const fleetMarksByModelId = useMemo(() => {
    const byId: Record<string, Record<string, true>> = {}
    for (const r of fleetData?.routes ?? []) {
      const mark = FLEET_MARK[r.provider]
      if (!mark) continue
      const id = r.spec.slice(r.spec.indexOf(':') + 1)
      byId[id] = { ...(byId[id] ?? {}), [mark]: true }
    }
    return byId
  }, [fleetData])

  const fleetModelIds = useMemo(() => {
    const ids: Record<string, true> = {}
    for (const r of fleetData?.routes ?? []) {
      if (r.provider === 'opencode') ids[r.spec.slice(r.spec.indexOf(':') + 1)] = true
    }
    return ids
  }, [fleetData])
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

  // Proxies the upstream has caught up with. Prompted, never applied silently:
  // the estimate was a deliberate judgement, and replacing it without asking
  // is as bad as ignoring the new data.
  const { data: upgrades } = useQuery<{ upgrades: ProxyUpgrade[] }>({
    queryKey: ['analysis', 'proxy-upgrades'],
    queryFn: () => apiFetch('/api/analysis/proxy-upgrades'),
  })
  const acceptUpgrade = useMutation({
    mutationFn: (body: { platform: string; modelId: string }) =>
      apiFetch('/api/analysis/proxy-upgrades/accept', { method: 'POST', body: JSON.stringify(body) }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['analysis'] }),
  })
  const pendingUpgrades = upgrades?.upgrades ?? []

  // Every chain that exists, so the picker can offer the ones a model is NOT in.
  const { data: profiles } = useQuery<{ id: number; name: string }[]>({
    queryKey: ['profiles'],
    queryFn: () => apiFetch('/api/profiles'),
  })
  const chainNames = (profiles ?? []).map(p => p.name)
  // Position, not membership. Sending one number and letting the server
  // renumber is the whole point: priorities on this install are neither dense
  // nor unique (two models sat at 3 in Coding), and a tie makes "which runs
  // first" a coin toss.
  const position = useMutation({
    mutationFn: (body: { chain: string; modelDbId: number; position: number }) =>
      apiFetch('/api/fallback/position', { method: 'POST', body: JSON.stringify(body) }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['fallback'] })
      queryClient.invalidateQueries({ queryKey: ['analysis'] })
    },
  })

  const membership = useMutation({
    mutationFn: (body: { chain: string; modelDbIds: number[]; member: boolean }) =>
      apiFetch('/api/fallback/membership', { method: 'POST', body: JSON.stringify(body) }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['fallback'] })
      queryClient.invalidateQueries({ queryKey: ['analysis'] })
    },
  })

  const status = data?.status

  const entryKey = (g: CompareGroup) => g.groupKey

  // Condensed entries: one per group, one per ungrouped model. The catalogue is
  // 589 rows and most are switched off, so comparing all of them buries the
  // ones in use.
  // Measured intelligence first: the reason to open this page is to see what
  // the benchmarks say, and the payload order is the router's, not a ranking.
  const [sort, setSort] = useState<{ key: SortKey; dir: 'asc' | 'desc' }>({ key: 'intelligenceIndex', dir: 'desc' })

  // Every toggle this view holds, and the value it starts at. Reset reads from
  // here rather than repeating literals at the call site: a toggle added later
  // and forgotten here would leave "reset" quietly incomplete, which is worse
  // than no reset at all -- the operator believes they are back at a known
  // state and they are not.
  const catalogueSlugs = useMemo(() => {
    const slugs: Record<string, true> = {}
    for (const g of grouped?.groups ?? []) {
      if (g.analysis?.slug && inScope(g, 'clifree', fleetModelIds)) slugs[g.analysis.slug] = true
    }
    return slugs
  }, [grouped, fleetModelIds])

  const RESET = { metric: 'intelligenceIndex' as ChartView, scope: 'routed' as Scope,
                  sort: { key: 'intelligenceIndex' as SortKey, dir: 'desc' as const }, query: '' }
  const dirty = metric !== RESET.metric || scope !== RESET.scope || query !== RESET.query
    || sort.key !== RESET.sort.key || sort.dir !== RESET.sort.dir || selected.size > 0
  const resetAll = () => {
    setMetric(RESET.metric); setScope(RESET.scope); setSort(RESET.sort)
    setQuery(RESET.query); setSelected(new Set())
  }
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
        // The free CLI routes, and ONLY under their own scope. They are not
        // ours to serve -- FreeLLM cannot call them -- so they must not appear
        // in the views that answer "what is my router doing". Under the CLI
        // fleet cut that IS the question, and all 28 belong, including the
        // Cline ones that have no catalogue row at all.
        //
        // `reference: true` on each is what keeps the chain and scope controls
        // off them: a chain slot pointing at an uncallable route would silently
        // never serve.
        ...(scope === 'clifree'
          ? ((fleetData?.groups ?? []) as CompareGroup[])
              .filter(g => matchesCompareQuery(g, query))
              // A fleet route whose benchmark is already on screen as a
              // catalogue row is the SAME capability reached another way, and
              // two rows scoring 48.1 read as two models. The catalogue row
              // wins: it is the one we can actually serve, and it carries the
              // chain and key state a fleet row has nothing to say about.
              .filter(g => !g.analysis || !catalogueSlugs[g.analysis.slug])
          : []),
        // Baselines are never searched away: they are the thing being compared
        // against, and a filtered table with no yardstick left is worse.
        ...(grouped?.groups ?? []).filter(g =>
          inScope(g, scope, fleetModelIds) &&
          matchesCompareQuery(g, query)
        ),
      ],
      sort.key,
      sort.dir,
    ),
    [grouped, references, fleetData, scope, sort, query],
  )
  const chosen = useMemo(
    () => entries.filter(g => selected.has(entryKey(g))),
    [entries, selected],
  )
  // Nothing picked reads as "compare everything visible", which is more useful
  // than an empty chart.
  const comparing = chosen.length > 0 ? chosen : entries

  /**
   * What each row plots, per view.
   *
   * Overlay ranks by the mean of the three so a row's ORDER reflects the shape
   * being compared rather than one arbitrary axis; cost ranks cheapest first,
   * since the question there is "what can I afford", not "what is biggest".
   */
  const valueOf = useMemo(() => (g: CompareGroup): number | null => {
    if (metric === 'costPerTask') return costPerTask(g.analysis)
    if (metric === 'all') {
      const parts = OVERLAY.map(o => g.analysis?.[o.key]).filter((v): v is number => v != null)
      return parts.length > 0 ? parts.reduce((a, b) => a + b, 0) / parts.length : null
    }
    return (g.analysis?.[metric] as number | null) ?? null
  }, [metric])

  const scored = useMemo(
    () => comparing
      .filter(g => valueOf(g) != null)
      .sort((a, b) => metric === 'costPerTask'
        ? (valueOf(a) as number) - (valueOf(b) as number)
        : (valueOf(b) as number) - (valueOf(a) as number)),
    [comparing, metric, valueOf],
  )
  // The bar is scaled to the largest value on screen in every view — for cost
  // that is the most expensive model, so the free ones read as the flat floor
  // they are.
  const peak = scored.length > 0
    ? Math.max(...scored.map(g => {
      if (metric === 'all') return Math.max(...OVERLAY.map(o => g.analysis?.[o.key] ?? 0))
      // Both halves share one axis, so the dearer output price sets the scale —
      // otherwise every output bar clips at full width and the comparison the
      // two bars exist for disappears.
      if (metric === 'costPerTask') {
        const p = priceOf(g.analysis)
        return p ? Math.max(p.input, p.output) : 0
      }
      return valueOf(g) as number
    }))
    : 0
  const unscored = comparing.filter(g => valueOf(g) == null)

  // Collapsed only when the key is both present and usable: an unreadable one
  // needs the form, since replacing it is the fix.
  const keySettled = Boolean(status?.configured) && !status?.unreadable
  const [editingKey, setEditingKey] = useState(false)

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
          useless anywhere else, and this is where its absence is felt.

          Once saved it collapses to what a reader can act on — tier, index
          version, what is cached and how much of today's quota is left. A
          password box you cannot read back, above a hint explaining how to get
          a key you already have, is a permanent instruction for a job done
          once. */}
      {keySettled && !editingKey
        ? (
          <section className="flex flex-wrap items-center gap-2 rounded-xl border px-4 py-2.5 text-[11px]">
            <span className="text-xs font-medium">{t('compare.keyTitle')}</span>
            <Badge variant="secondary" className="text-[10px]">{t('compare.keySaved')}</Badge>
            {status?.tier && <Badge variant="secondary">{status.tier}</Badge>}
            {status?.indexVersion && <Badge variant="outline">{status.indexVersion}</Badge>}
            <span className="tabular-nums text-muted-foreground">
              {t('compare.cacheState', { cached: status?.cachedModels ?? 0, linked: status?.linkedModels ?? 0 })}
            </span>
            {status?.rateLimit?.remaining != null && (
              <span className="tabular-nums text-muted-foreground">
                {t('compare.quota', { remaining: status.rateLimit.remaining, limit: status.rateLimit.limit ?? 0 })}
              </span>
            )}
            {status?.lastSyncMs != null && (
              <span className="text-muted-foreground">
                {t('compare.lastSync', { when: new Date(status.lastSyncMs).toLocaleString() })}
              </span>
            )}
            <span className="flex-1" />
            <Button size="xs" variant="ghost" onClick={() => setEditingKey(true)}>{t('compare.keyChange')}</Button>
            {status?.lastError && <p className="w-full text-xs text-destructive">{status.lastError}</p>}
          </section>
        )
        : (
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
              <Button
                size="sm"
                disabled={keyDraft.trim().length < 8 || saveKey.isPending}
                onClick={() => { saveKey.mutate(keyDraft); setEditingKey(false) }}
              >
                {t('common.save')}
              </Button>
              {status?.configured && (
                <Button size="sm" variant="ghost" onClick={() => clearKey.mutate()} disabled={clearKey.isPending}>
                  {t('common.remove')}
                </Button>
              )}
              {keySettled && (
                <Button size="sm" variant="ghost" onClick={() => { setKeyDraft(''); setEditingKey(false) }}>
                  {t('common.cancel')}
                </Button>
              )}
            </div>
            {status?.lastError && <p className="mt-2 text-xs text-destructive">{status.lastError}</p>}
          </section>
        )}

      {!isLoading && status?.cachedModels === 0 && (
        <p className="text-xs text-muted-foreground">{t('compare.empty')}</p>
      )}

      {status != null && status.cachedModels > 0 && (
        <>
          {pendingUpgrades.length > 0 && (
            <section className="rounded-xl border border-amber-500/40 bg-amber-500/5 p-3">
              <p className="text-xs font-medium">{t(pendingUpgrades.length === 1 ? 'compare.upgradeTitleOne' : 'compare.upgradeTitle', { count: pendingUpgrades.length })}</p>
              <p className="mt-0.5 text-[11px] text-muted-foreground">{t('compare.upgradeHint')}</p>
              <ul className="mt-2 space-y-1">
                {pendingUpgrades.map(u => (
                  <li key={`${u.platform}:${u.modelId}`} className="flex flex-wrap items-center gap-2 text-[11px]">
                    <PlatformDot platform={u.platform} />
                    <span className="font-medium">{u.displayName}</span>
                    <span className="text-muted-foreground">
                      {t('compare.upgradeSwap', { from: u.proxyName, to: u.realName, reason: u.matchReason })}
                    </span>
                    <Button
                      size="xs"
                      disabled={acceptUpgrade.isPending}
                      onClick={() => acceptUpgrade.mutate({ platform: u.platform, modelId: u.modelId })}
                    >
                      {t('compare.upgradeAccept')}
                    </Button>
                  </li>
                ))}
              </ul>
            </section>
          )}

          <section className="rounded-xl border p-4">
            <div className="flex flex-wrap items-center gap-2">
              <Scale className="size-4 text-muted-foreground" />
              <h2 className="text-sm font-medium">{t('compare.chartTitle')}</h2>
              <div className="ml-auto flex flex-wrap items-center gap-1">
                {/* Shown only when something is off-default: a reset that is
                    always present invites a click that does nothing. */}
                {dirty && (
                  <button
                    type="button"
                    onClick={resetAll}
                    className="rounded-full border px-2 py-0.5 text-[11px] text-muted-foreground hover:bg-muted/50"
                    title={t('compare.resetHint')}
                  >
                    {t('compare.reset')}
                  </button>
                )}
                {CHART_VIEWS.map(m => (
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
                  const count =
                    (grouped?.groups ?? []).filter(g => inScope(g, sc.key, fleetModelIds)).length +
                    (sc.key === 'clifree' ? (fleetData?.groups ?? []).length : 0)
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
                const value = valueOf(g) as number
                return (
                  // One vocabulary for "this is a baseline", not two. The
                  // table says it with a badge; this list said it by recolouring
                  // the whole row and its bar, so the same fact looked like two
                  // different states depending which half of the page you read.
                  <li
                    key={entryKey(g)}
                    className={`flex items-center gap-2 rounded px-1 text-xs ${
                      g.reference && !isFleet(g)
                        ? vendorTint(g.name, g.analysis?.creator)
                        : unallocated(g) ? HATCH : ''
                    }`}
                  >
                    {/* Name first, dots after it. Leading with a variable
                        number of swatches started every name at a different
                        offset, so the column could not be read down. */}
                    <span className="flex w-[200px] flex-shrink-0 items-center gap-1 truncate" title={[g.name, ...g.members.map(m => m.modelId)].join('\n')}>
                      <ModelName name={g.name} className="truncate" />
                      {g.members.length > 1 && (
                        <span className="text-muted-foreground tabular-nums">{`×${g.members.length}`}</span>
                      )}
                      {/* The badge is for rows we do NOT serve. The marks are
                          for any row an agent can reach, served or not, so they
                          sit outside that guard -- a catalogue row reachable
                          from OpenCode Zen was previously unmarked and gave no
                          reason for being under the fleet scope at all. */}
                      <span className="flex items-center gap-1">
                        {/* Baseline keeps its badge here; a fleet row does not.
                            In this list the OC/CL marks already say the row is
                            agent-reachable, and the orange badge beside them
                            was a second label for the same fact in a column
                            200px wide. The table still carries it, where the
                            distinction between "we serve it" and "only an agent
                            can" has room to be read. */}
                        {g.reference && !isFleet(g) && (
                          <Badge variant="secondary" className="bg-sky-500/15 text-[10px] text-sky-700 dark:text-sky-300">
                            {t('compare.referenceBadge')}
                          </Badge>
                        )}
                        {fleetMarks(g, fleetMarksByModelId).map(mark => (
                          <Badge
                            key={mark}
                            variant="outline"
                            className={`px-1 font-mono text-[10px] ${MARK_CLASS[mark]}`}
                            title={t(mark === 'OC' ? 'compare.fleet.markOc' : 'compare.fleet.markCl')}
                          >
                            {mark}
                          </Badge>
                        ))}
                      </span>
                    </span>
                    <span className="flex w-[70px] flex-shrink-0 items-center gap-0.5">
                      {[...new Map(g.members.map(m => [m.platform, m])).values()].slice(0, 7).map(m => (
                        // Same swatch vocabulary as the table: shape carries
                        // the key state (filled = usable, hollow circle =
                        // switched off, hollow square = no key), and the dot
                        // links to Keys when there is something to fix. Without
                        // `keyState` this list could only ever draw two of the
                        // three shapes, so a provider read as "switched off"
                        // here and "no key at all" ten rows below.
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
                    {/* Scaled to the largest value on screen, not to 100: the
                        indices are not percentages and the gap between the top
                        few is what a reader is looking for. */}
                    {metric === 'costPerTask' ? (
                      // Input and output as published, never combined: output
                      // runs several times input on most models, and any single
                      // figure hides which half a given workload actually pays.
                      <div className="flex min-w-0 flex-1 flex-col gap-px">
                        {([
                          { key: 'input', label: t('compare.priceInput'), bar: 'bg-sky-500/70', v: priceOf(g.analysis)?.input },
                          { key: 'output', label: t('compare.priceOutput'), bar: 'bg-rose-500/70', v: priceOf(g.analysis)?.output },
                        ] as const).map(row => (
                          <div key={row.key} className="h-1.5 rounded-sm bg-muted" title={`${row.label}: $${row.v?.toFixed(2) ?? '—'}`}>
                            {row.v != null && (
                              <div
                                className={`h-1.5 rounded-sm ${row.bar}`}
                                style={{ width: peak > 0 ? `${Math.max((row.v / peak) * 100, row.v === 0 ? 0 : 2)}%` : '0%' }}
                              />
                            )}
                          </div>
                        ))}
                      </div>
                    ) : metric === 'all' ? (
                      // Three bars stacked in the height of one row: the SHAPE
                      // is the point — strong reasoning with weak agentic reads
                      // instantly here and cannot be seen at all when the three
                      // live on separate screens.
                      <div className="flex min-w-0 flex-1 flex-col gap-px">
                        {OVERLAY.map(o => {
                          const v = g.analysis?.[o.key]
                          return (
                            <div key={o.key} className="h-1 rounded-sm bg-muted" title={`${t(o.labelKey)}: ${v?.toFixed(1) ?? '—'}`}>
                              {v != null && (
                                <div
                                  className={`h-1 rounded-sm ${o.bar}`}
                                  style={{ width: peak > 0 ? `${Math.max((v / peak) * 100, 2)}%` : '2%' }}
                                />
                              )}
                            </div>
                          )
                        })}
                      </div>
                    ) : (
                      <div className="h-3 min-w-0 flex-1 rounded bg-muted">
                        {/* Sky marks a pinned yardstick. Everything else -- the
                            models we serve and the free CLI routes alike -- is
                            a measurement of something real and keeps the metric
                            colour, so the bars stay comparable down the column
                            instead of one class of row reading as a different
                            quantity. */}
                        <div
                          className={`h-3 rounded ${g.reference && !isFleet(g) ? 'bg-sky-500/70' : 'bg-emerald-500/70'} ${
                            unallocated(g)
                              ? 'opacity-60 bg-[repeating-linear-gradient(45deg,rgba(16,185,129,0.75),rgba(16,185,129,0.75)_3px,rgba(16,185,129,0.15)_3px,rgba(16,185,129,0.15)_7px)]'
                              : ''
                          }`}
                          style={{ width: peak > 0 ? `${Math.max((value / peak) * 100, 2)}%` : '2%' }}
                        />
                      </div>
                    )}
                    <span className="w-16 flex-shrink-0 text-right tabular-nums">
                      {metric === 'costPerTask'
                        // Free is a result, not a blank: most of this catalogue
                        // costs nothing and that is the finding.
                        ? (() => {
                          const p = priceOf(g.analysis)!
                          return p.input === 0 && p.output === 0
                            ? t('compare.costFree')
                            : `$${p.input.toFixed(2)}/$${p.output.toFixed(2)}`
                        })()
                        : value.toFixed(1)}
                    </span>
                  </li>
                )
              })}
            </ul>
            {metric === 'all' && (
              <p className="mt-2 flex flex-wrap items-center gap-3 text-[10px] text-muted-foreground">
                {OVERLAY.map(o => (
                  <span key={o.key} className="inline-flex items-center gap-1">
                    <span className={`inline-block h-2 w-3 rounded-sm ${o.bar}`} />
                    {t(o.labelKey)}
                  </span>
                ))}
              </p>
            )}
            {metric === 'costPerTask' && (
              <p className="mt-2 flex flex-wrap items-center gap-3 text-[10px] text-muted-foreground">
                <span className="inline-flex items-center gap-1">
                  <span className="inline-block h-2 w-3 rounded-sm bg-sky-500/70" />{t('compare.priceInput')}
                </span>
                <span className="inline-flex items-center gap-1">
                  <span className="inline-block h-2 w-3 rounded-sm bg-rose-500/70" />{t('compare.priceOutput')}
                </span>
                <span>{t('compare.costBasis')}</span>
              </p>
            )}
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
            {/* Only under the fleet scope, where the marks appear. A legend
                for symbols that are not on screen is noise, and this page
                already carries a platform legend for the rows that have one. */}
            {scope === 'clifree' && (
              <p className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-muted-foreground">
                <span className="inline-flex items-center gap-1">
                  <Badge variant="secondary" className="bg-orange-500/15 text-[10px] text-orange-700 dark:text-orange-300">
                    {t('compare.fleet.badge')}
                  </Badge>
                  {t('compare.fleet.legendFleet')}
                </span>
                <span className="inline-flex items-center gap-1">
                  <Badge variant="outline" className={`px-1 font-mono text-[10px] ${MARK_CLASS.OC}`}>OC</Badge>
                  {t('compare.fleet.markOc')}
                </span>
                <span className="inline-flex items-center gap-1">
                  <Badge variant="outline" className={`px-1 font-mono text-[10px] ${MARK_CLASS.CL}`}>CL</Badge>
                  {t('compare.fleet.markCl')}
                </span>
                <span>{t('compare.fleet.legendBoth')}</span>
                <span>{t('compare.fleet.legendServed')}</span>
              </p>
            )}
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
                    <TableRow key={entryKey(g)} className={`group/row ${g.reference && !isFleet(g) ? (vendorTint(g.name, g.analysis?.creator) || 'bg-sky-500/5') : unallocated(g) ? HATCH : ''}`}>
                      <TableCell>
                        {g.reference && !isFleet(g)
                          ? (
                            // Confirm-gated like every other destructive action
                            // here: the × sits exactly where the selection
                            // checkbox sits on every other row, so a misaimed
                            // click silently dropped a baseline and the scores
                            // it was there to compare against.
                            <Tooltip text={t('compare.referenceRemove')}>
                              <ConfirmButton
                                size="icon-xs"
                                armedSize="xs"
                                aria-label={t('compare.referenceRemove')}
                                onConfirm={() => removeReference(g.analysis?.slug ?? '')}
                              >×</ConfirmButton>
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
                          {/* Shortened, then wrapped rather than truncated: the
                              tail of a benchmark name is what tells siblings
                              apart, so it is the last part that may be cut. */}
                          <span className="max-w-[220px] whitespace-normal font-medium [overflow-wrap:anywhere]" title={g.name}><ModelName name={g.name} /></span>
                          {/* Routes the platform holds a key for that the key
                              does not name. One press each way, because this is
                              the difference between a model being unreachable
                              and being usable. */}
                          {/* Several routes is several decisions — a generous
                              free tier and a 10-cent trial are not one — so the
                              picker lists them. One route needs no choosing. */}
                          {/* Reference-only routes are filtered out rather than
                              hiding the picker: a mixed group still has routes
                              whose key scope is worth editing, and suppressing
                              the whole control would strand them. */}
                          {!g.reference && g.members.some(m => m.keyScope === 'out' && !REFERENCE_ONLY_PLATFORMS[m.platform]) && (
                            <ScopePicker
                              allow
                              disabled={keyScope.isPending}
                              routes={g.members.filter(m => m.keyScope === 'out' && !REFERENCE_ONLY_PLATFORMS[m.platform]).map(m => ({ platform: m.platform, modelId: m.modelId }))}
                              onApply={rs => rs.forEach(r => keyScope.mutate({ ...r, allow: true }))}
                            />
                          )}
                          {!g.reference && g.members.some(m => m.keyScope === 'in' && !REFERENCE_ONLY_PLATFORMS[m.platform]) && (
                            <ScopePicker
                              allow={false}
                              disabled={keyScope.isPending}
                              routes={g.members.filter(m => m.keyScope === 'in' && !REFERENCE_ONLY_PLATFORMS[m.platform]).map(m => ({ platform: m.platform, modelId: m.modelId }))}
                              onApply={rs => rs.forEach(r => keyScope.mutate({ ...r, allow: false }))}
                            />
                          )}
                          {g.reference && (
                            <Badge
                              variant="secondary"
                              className={isFleet(g)
                                ? 'bg-orange-500/15 text-[10px] text-orange-700 dark:text-orange-300'
                                : 'bg-sky-500/15 text-[10px] text-sky-700 dark:text-sky-300'}
                            >
                              {t(isFleet(g) ? 'compare.fleet.badge' : 'compare.referenceBadge')}
                            </Badge>
                          )}
                          {fleetMarks(g, fleetMarksByModelId).map(mark => (
                            <Badge
                              key={mark}
                              variant="outline"
                              className={`px-1 font-mono text-[10px] ${MARK_CLASS[mark]}`}
                              title={t(mark === 'OC' ? 'compare.fleet.markOc' : 'compare.fleet.markCl')}
                            >
                              {mark}
                            </Badge>
                          ))}
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
                      {/* Membership, editable. Ranking the catalogue and then
                          placing the winner is one motion; it used to mean
                          leaving for the Models page and finding the model
                          again with the scores no longer on screen. */}
                      <TableCell className="text-[11px] text-muted-foreground">
                        {g.reference
                          ? <span className="text-[10px]">–</span>
                          : (
                            <ChainPicker
                              chains={chainNames}
                              member={g.chains}
                              ranks={g.chainRanks}
                              disabled={membership.isPending || position.isPending}
                              onApply={changes => changes.forEach(c => membership.mutate({
                                chain: c.chain,
                                modelDbIds: g.members.map(m => m.modelDbId),
                                member: c.member,
                              }))}
                              onRank={(chain, modelDbId, next) => position.mutate({ chain, modelDbId, position: next })}
                            />
                          )}
                      </TableCell>
                      {/* An adjusted figure must never read as a measurement.
                          The signs say a human moved it and which way, in the
                          same green/red as the Keys panel — this is the table
                          people actually rank models in. */}
                      <TableCell className="text-right tabular-nums">
                        {score(g.analysis?.intelligenceIndex)}<DeltaMark delta={proxyDeltaOf(g, 'intelligence')} />
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        {score(g.analysis?.codingIndex)}<DeltaMark delta={proxyDeltaOf(g, 'coding')} />
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        {score(g.analysis?.agenticIndex)}<DeltaMark delta={proxyDeltaOf(g, 'agentic')} />
                      </TableCell>
                      {/* Measured by Artificial Analysis, so they are blank
                          exactly where the scores are: an unmapped row shows
                          dashes rather than inventing a number from our own
                          catalogue. Context is ours — it comes from the routes. */}
                      <TableCell className="text-right tabular-nums" title={t('compare.speedHint')}>
                        {stat(g.analysis?.medianOutputTokensPerSecond, 0)}<DeltaMark delta={proxyDeltaOf(g, 'speed')} />
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

      {/* The free CLI fleet sits after the comparison table and before the
          attribution: it answers a different question — not "which model scores
          best" but "what can each machine actually reach right now" — and its
          routes are NOT callable from FreeLLM, which the panel states itself. */}
      <ClifreeFleet />

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

/**
 * The adjustment behind an entry's scores, if a proxy produced them.
 *
 * Read off the member whose analysis the group is showing: a merged entry
 * inherits one member's figures, so it must inherit that member's adjustment
 * too or the row would print a moved number with no sign on it.
 */
function proxyDeltaOf(g: CompareGroup, metric: 'intelligence' | 'coding' | 'agentic' | 'speed'): number {
  const source = g.members.find(m => m.analysis)
  if (source?.link?.source !== 'proxy') return 0
  return source.link.proxyDelta[metric] ?? 0
}

/** Signs, not a number, in the same colours the Keys panel uses. */
function DeltaMark({ delta }: { delta: number }) {
  if (!delta) return null
  return (
    <span className={`ml-0.5 text-[10px] font-medium ${delta > 0 ? 'text-emerald-600 dark:text-emerald-400' : 'text-rose-600 dark:text-rose-400'}`}>
      {(delta > 0 ? '+' : '−').repeat(Math.min(Math.abs(delta), 3))}
    </span>
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
function MappingCell({ members, catalogue, onLink }: {
  members: CompareRow[]
  catalogue: ComparePayload['catalogue']
  onLink: (slug: string | null) => void
}) {
  const { t } = useI18n()
  const [editing, setEditing] = useState(false)
  // Provisional until OK, so changing your mind does not cost a reselect.
  const [pending, setPending] = useState<string | null>(null)

  // Read the state off the routes themselves. The group's own `analysisSource`
  // says "inherited" whenever the score reaches it through a member, which is
  // true even when every member was mapped by hand a second ago — reporting
  // that would hide the operator's own decision back from them.
  const slugs = new Set(members.map(m => m.link?.slug ?? null))
  const common = slugs.size === 1 ? [...slugs][0] : null

  const commitMapping = () => {
    const slug = pending ?? common ?? NO_COUNTERPART
    onLink(slug === NO_COUNTERPART ? null : slug)
    setPending(null)
    setEditing(false)
  }
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
    // A proxy is not a match, and labelling it one would hide that every score
    // on the row is borrowed.
    if (scored.link?.source === 'proxy') {
      return (
        <Tooltip text={t('compare.matchProxyHint', { name: their.name, slug: their.slug })}>
          <span className="flex max-w-[118px] flex-col items-start">
            <span className="w-full truncate">≈ {their.name}</span>
            <span className="w-full truncate text-[10px] text-muted-foreground">{t('compare.matchProxy')}</span>
          </span>
        </Tooltip>
      )
    }
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
        value={pending ?? common ?? NO_COUNTERPART}
        options={options}
        onSelect={setPending}
        stayOpen
        footer={
          <span className="flex items-center justify-end border-t pt-2">
            <Button size="xs" onClick={commitMapping}>{t('common.ok')}</Button>
          </span>
        }
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
        <Button variant="ghost" size="icon-xs" onClick={() => { setPending(null); setEditing(false) }} aria-label={t('common.cancel')}>×</Button>
      </Tooltip>
    </span>
  )
}
