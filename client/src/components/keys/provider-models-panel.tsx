import { blockedReason, hideControlPressable, verdictEdge } from '@/lib/route-blockers'
import { Fragment, useMemo, useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { apiFetch } from '@/lib/api'
import { readHideDisabled, writeHideDisabled } from '@/lib/hide-disabled-pref'
import { formatCountdown } from '@/lib/countdown'
import { REFERENCE_ONLY_PLATFORMS } from '@/lib/routing'
import { Switch } from '@/components/ui/switch'
import { Tooltip } from '@/components/tooltip'
import { ChainPicker } from '@/components/compare/chain-picker'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { useI18n } from '@/i18n'
import { ModelCombobox } from '@/components/model-combobox'
import { ModelName } from '@/components/model-name'
import { useExtensionEnabled } from '@/lib/use-extension'
import { churnByPlatform, useCatalogueChanges } from '@/lib/catalogue-changes'
import { markArrivalsSeen, useUnseenArrivals } from '@/lib/seen-arrivals'
import { ChainFit } from '@/components/chain-fit'
import { scoreRowOf, useScoreTone } from '@/lib/chain-minimums'

// Every model this provider serves, with the measured scores beside the two
// switches that decide whether it can route. Lives inside the expanded provider
// group because that is where the comparison is actually made: "which of these
// eight should this key spend its allowance on" is a question about one
// provider's menu, and answering it used to mean holding the Compare page and
// the key's scope dialog in your head at once.

/**
 * What happened last time this route was called.
 *
 * Deliberately silent for 'ok' and 'untested'. A badge on every row is a badge
 * nobody reads, and marking untested green would claim evidence we do not have
 * — the same unknown-is-not-zero rule the quota ledger keeps. Only a failure
 * earns ink, because only a failure changes the decision in front of you.
 */
/** "3 days ago" beats a timestamp here: the question is whether the verdict is
 *  current, not what hour it happened. */
function agoLabel(ms: number | null, t: (k: string, v?: Record<string, string | number>) => string): string {
  if (ms == null) return ''
  const mins = Math.max(0, Math.round((Date.now() - ms) / 60_000))
  if (mins < 60) return t('keys.healthAgoMinutes', { count: mins })
  const hours = Math.round(mins / 60)
  if (hours < 48) return t('keys.healthAgoHours', { count: hours })
  return t('keys.healthAgoDays', { count: Math.round(hours / 24) })
}

function HealthMark({ health }: { health?: ModelHealthRow }) {
  const { t } = useI18n()
  if (!health || health.verdict === 'untested') return null

  // A working route earns a quiet mark rather than none: "tested, and it
  // answered" is different from "nobody has ever tried", and only one of them
  // is a reason to leave a route switched on.
  const ok = health.verdict === 'ok'
  const dead = health.verdict === 'dead'
  const when = agoLabel(health.lastCheckedAtMs, t)
  const tone = ok
    ? 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-400'
    : dead
      ? 'bg-rose-500/10 text-rose-700 dark:text-rose-400'
      : 'bg-amber-500/10 text-amber-700 dark:text-amber-400'

  return (
    <Tooltip text={health.detail ?? (ok ? t('keys.healthOkHint') : dead ? t('keys.healthDeadHint') : t('keys.healthLimitedHint'))}>
      <span className="mt-0.5 inline-flex items-center gap-1">
        <span className={`rounded-full px-1.5 py-0.5 text-[10px] ${tone}`}>
          {ok ? t('keys.healthOk') : `${health.code ?? 'EOTHER'} ${dead ? t('keys.healthDead') : t('keys.healthLimited')}`}
        </span>
        {/* When the verdict was established: a two-week-old refusal and one
            from a minute ago are not the same evidence. */}
        {when && <span className="text-[10px] text-muted-foreground">{when}</span>}
      </span>
    </Tooltip>
  )
}

// The hide-can't-route preference lives in lib/hide-disabled-pref.ts: this file
// exports components only, so a non-component export here breaks fast refresh.

/** Only what this panel reads from the quota payload: when the allowance
 *  returns, including a window folded behind a binding one. */
interface ProviderQuotaRow {
  platform: string
  seconds_until_reset: number | null
  alsoBound?: Array<{ seconds_until_reset: number | null }>
}

interface ModelHealthRow {
  modelId: string
  /** 'dead' is the one that matters: a refusal no waiting will fix. */
  verdict: 'ok' | 'dead' | 'limited' | 'untested'
  /** Short reason, explained once in the legend below the table. */
  code: 'OK' | 'E429' | 'E403' | 'E404' | 'E401' | 'E5XX' | 'ETIME' | 'EOTHER' | null
  detail: string | null
  lastCheckedAtMs: number | null
  successes: number
  failures: number
}

/** Every code the panel can show, in the order an operator should act on them:
 *  the ones no waiting will fix first. */
const HEALTH_CODES = ['E403', 'E404', 'E401', 'E5XX', 'ETIME', 'E429', 'EOTHER'] as const

interface Row {
  modelDbId: number
  platform: string
  modelId: string
  /** Relay a custom row belongs to (normalised base URL); '' for catalogue rows. */
  endpointScope?: string
  /** Operator's unlimited flag, and whether it is in force (a guarded platform
   *  needs a $0 price from the provider). */
  unlimited?: { flagged: boolean; effective: boolean }
  displayName: string
  enabled: boolean
  contextWindow: number | null
  supportsTools: boolean
  supportsVision: boolean
  keyScope: 'none' | 'disabled' | 'unscoped' | 'in' | 'out'
  /** Why a switched-off row is off (server/src/services/analysis.ts). */
  offReason: null | { kind: 'override'; since: string } | { kind: 'upstream' } | { kind: 'switched' }
  /** Benched right now by the provider, not failing: when it can serve again. */
  pause: { source: 'credit' | 'tier' | 'authoritative' | 'heuristic'; untilMs: number } | null
  /** Chains currently routing to this model. Empty means it can serve and
   *  nothing asks it to. */
  chains: string[]
  /** The operator's note (model_note): why it is parked, when to look again. */
  note?: { text: string; recheckAt: string | null; updatedAt: string } | null
  /** Position within each chain above, same order — the server pairs them in
   *  one concat so they cannot drift apart. */
  chainRanks: number[]
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

interface RateUsageWindow { used: number; limit: number }
interface RateUsageRow {
  modelDbId: number
  rpm: RateUsageWindow | null
  rpd: RateUsageWindow | null
}

interface QuotaProbe {
  modelId: string
  statusCodes: Record<string, number>
  catalogueRpm: number | null
  catalogueRpd: number | null
  ranAt: string
  measuredRpm: number | null
  measuredRpd: number | null
  currentRpm: number | null
  currentRpd: number | null
  finding: string
  recommendation: string | null
}

interface CatalogueEntry {
  slug: string
  name: string
  creator: string | null
  intelligenceIndex: number | null
}

type SortKey = 'intelligence' | 'coding' | 'agentic' | 'speed' | 'name'

/**
 * What this route may still spend today, and where the number came from.
 *
 * The allowance leads because it is the decision: a model with 2 of 20 left is
 * one a chain should stop reaching for, whatever its scores say. The
 * measurement sits behind it in the tooltip — it is how the allowance is known,
 * not what a reader needs at a glance.
 */
function AllowanceCell({ probe, usage }: { probe?: QuotaProbe; usage?: RateUsageRow }) {
  const { t } = useI18n()
  const day = usage?.rpd ?? null
  const minute = usage?.rpm ?? null

  if (!probe && !day && !minute) {
    return <td className="py-1 pr-2 text-right text-[10px] text-muted-foreground">–</td>
  }

  const part = (was: number | null, now: number | null, unit: string) =>
    now == null ? null
    : was != null && was !== now ? `${was}→${now}${unit}`
    : `${now}${unit}`
  const parts = [
    part(probe?.catalogueRpm ?? null, probe?.measuredRpm ?? null, '/min'),
    part(probe?.catalogueRpd ?? null, probe?.measuredRpd ?? null, '/day'),
  ].filter(Boolean)

  // Serving nothing because the model is gone is not the same as serving
  // everything sent and finding no ceiling. Same empty measurement, opposite
  // meanings.
  const codes = Object.keys(probe?.statusCodes ?? {})
  const delisted = codes.length > 0 && codes.every(c => c === '404' || c === '410')

  // Spent fraction decides the colour: amber past two thirds, red past nine
  // tenths. A chain reaching for a route at 19 of 20 will be refused on the
  // next call but one.
  const spent = day && day.limit > 0 ? day.used / day.limit : 0
  const tone = spent >= 0.9 ? 'text-rose-600 dark:text-rose-400'
    : spent >= 0.67 ? 'text-amber-700 dark:text-amber-400'
    : 'text-foreground'

  const detail = [
    probe?.finding,
    parts.length > 0 ? t('keys.allowanceMeasuredAs', { measured: parts.join(' · ') }) : null,
    minute ? t('keys.allowancePerMinute', { used: minute.used, limit: minute.limit }) : null,
  ].filter(Boolean).join('\n')

  return (
    <td className="py-1 pr-2 text-right text-[10px] tabular-nums">
      <Tooltip text={detail || t('keys.panelMeasuredNoCeiling')} wide>
        {day ? (
          <span className={tone}>
            {t('keys.allowanceLeft', { left: Math.max(0, day.limit - day.used), limit: day.limit })}
          </span>
        ) : (
          <span className="text-muted-foreground">
            {delisted ? t('quota.probeDelisted')
              : parts.length > 0 ? parts.join(' · ')
              : t('keys.panelMeasuredNoCeiling')}
          </span>
        )}
      </Tooltip>
    </td>
  )
}

export function ProviderModelsPanel({ platform, endpointScope }: {
  platform: string
  /** One OpenAI-compatible account's rows only; every custom endpoint shares
   *  platform 'custom'. Undefined = the whole platform. */
  endpointScope?: string
}) {
  // `provider-models-panel` off: the panel is hidden and upstream's provider view is used; saved scope is untouched.
  if (!useExtensionEnabled('provider-models-panel')) return null
  const { t } = useI18n()
  const queryClient = useQueryClient()
  const [sort, setSort] = useState<SortKey>('intelligence')
  // One filter, asking whether a row can serve at all: switched on in the
  // catalogue AND reachable by a key we hold. It replaced a pair — "Hide
  // disabled" tested only the catalogue flag, so on HuggingFace (121 rows, none
  // switched off) it hid nothing while every row was grey and unreachable.
  //
  // Remembered PER PROVIDER: HuggingFace with 121 rows wants hiding and Groq
  // with 4 does not, and re-hiding on every expand made the control feel
  // broken. Kept in localStorage rather than server settings because it is view
  // state — hiding a row here changes nothing about what routes, unlike the
  // Quota panel's hidden pools, which are a property of the install.
  const [hideDisabled, setHideDisabled] = useState(() => readHideDisabled(platform))
  // Re-read during render when the panel is pointed at another provider,
  // rather than in an effect. An effect would render once with the previous
  // provider's preference and then again with the right one — a visible flash
  // of the wrong table, and the cascading-render the hooks lint rejects.
  const [prevPlatform, setPrevPlatform] = useState(platform)
  if (platform !== prevPlatform) {
    setPrevPlatform(platform)
    setHideDisabled(readHideDisabled(platform))
  }
  const toggleHideDisabled = () => {
    setHideDisabled(prev => {
      const next = !prev
      writeHideDisabled(platform, next)
      return next
    })
  }

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
  // Rename a model where it is listed. A relay's /v1/models gives raw ids
  // ("coding-glm-4.6-free"), so this is where a bad name is noticed and fixed.
  const [renaming, setRenaming] = useState<{ id: number; value: string } | null>(null)
  const rename = useMutation({
    mutationFn: ({ id, displayName }: { id: number; displayName: string }) =>
      apiFetch(`/api/models/${id}`, { method: 'PATCH', body: JSON.stringify({ displayName }) }),
    onSuccess: () => { setRenaming(null); invalidate() },
  })
  const saveRename = (r: Row) => {
    const value = renaming?.value.trim() ?? ''
    // Blank or unchanged is a cancel, not a save: displayName cannot be empty.
    if (!value || value === r.displayName) { setRenaming(null); return }
    rename.mutate({ id: r.modelDbId, displayName: value })
  }

  // The operator's note on a model: why it is parked and when to look again.
  // Saved by button or Enter, never on blur: a blur-save is how the key
  // pencil's dialog used to close itself.
  const [noteEdit, setNoteEdit] = useState<{ id: number; text: string; recheckAt: string } | null>(null)
  const saveNote = useMutation({
    mutationFn: ({ id, text, recheckAt }: { id: number; text: string; recheckAt: string }) =>
      apiFetch(`/api/models/${id}`, { method: 'PATCH', body: JSON.stringify({ note: text.trim() || null, recheckAt: recheckAt || null }) }),
    onSuccess: () => { setNoteEdit(null); invalidate() },
  })
  const today = new Date().toISOString().slice(0, 10)

  const unlimitedOn = useExtensionEnabled('unlimited-models')
  const setUnlimited = useMutation({
    mutationFn: ({ row, on }: { row: Row; on: boolean }) =>
      apiFetch(`/api/models/${row.modelDbId}`, { method: 'PATCH', body: JSON.stringify({ unlimited: on }) }),
    onSuccess: () => invalidate(),
  })

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
  // Proxies the upstream has caught up with. Shared cache with Compare, so the
  // same prompt reaches whichever screen the operator is on.
  const { data: upgrades } = useQuery<{ upgrades: { platform: string; modelId: string; realName: string; matchReason: string }[] }>({
    queryKey: ['analysis', 'proxy-upgrades'],
    queryFn: () => apiFetch('/api/analysis/proxy-upgrades'),
  })
  const upgradeFor = (r: Row) =>
    upgrades?.upgrades.find(u => u.platform === r.platform && u.modelId === r.modelId)
  const acceptUpgrade = useMutation({
    mutationFn: (body: { platform: string; modelId: string }) =>
      apiFetch('/api/analysis/proxy-upgrades/accept', { method: 'POST', body: JSON.stringify(body) }),
    onSuccess: invalidate,
  })

  // Chain membership, the same control Compare carries. Judging a provider's
  // menu and then placing the winner is one motion here too; sending the reader
  // to a third screen to act on what this table just told them is the gap.
  const { data: probeData } = useQuery<{ probes: QuotaProbe[] }>({
    queryKey: ['quota', 'probes', platform],
    queryFn: () => apiFetch(`/api/quota/probes?platform=${encodeURIComponent(platform)}`),
  })
  // Newest first from the API, but the two halves of a limit are usually found
  // by different runs: a burst finds the per-minute ceiling, a paced walk finds
  // the daily one. Taking only the latest run would hide whichever was measured
  // first, so each figure keeps the newest run that actually established it.
  const latestProbe = useMemo(() => {
    const byModel = new Map<string, QuotaProbe>()
    for (const p of probeData?.probes ?? []) {
      const seen = byModel.get(p.modelId)
      if (!seen) { byModel.set(p.modelId, { ...p }); continue }
      if (seen.measuredRpm == null && p.measuredRpm != null) {
        seen.measuredRpm = p.measuredRpm
        seen.catalogueRpm = p.catalogueRpm
      }
      if (seen.measuredRpd == null && p.measuredRpd != null) {
        seen.measuredRpd = p.measuredRpd
        seen.catalogueRpd = p.catalogueRpd
      }
    }
    return byModel
  }, [probeData?.probes])

  // Has each route ever answered? Read from attempt history, so a model in
  // daily use needs no probe and a model that 403s is visible BEFORE someone
  // switches it on. Dead routes were being enabled by hand because nothing here
  // told them apart from working ones.
  const { data: health } = useQuery<{ rows: ModelHealthRow[] }>({
    queryKey: ['keys', 'model-health', platform],
    queryFn: () => apiFetch(`/api/keys/model-health?platform=${encodeURIComponent(platform)}`),
  })
  const healthByModel = useMemo(
    () => new Map((health?.rows ?? []).map(r => [r.modelId, r])),
    [health?.rows],
  )

  const position = useMutation({
    mutationFn: (body: { chain: string; modelDbId: number; position: number }) =>
      apiFetch('/api/fallback/position', { method: 'POST', body: JSON.stringify(body) }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['fallback'] })
      void queryClient.invalidateQueries({ queryKey: ['analysis'] })
    },
  })

  const probe = useMutation({
    mutationFn: (modelIds: string[]) =>
      apiFetch('/api/keys/model-health/probe', { method: 'POST', body: JSON.stringify({ platform, modelIds }) }),
    onSuccess: () => { void queryClient.invalidateQueries({ queryKey: ['keys', 'model-health', platform] }) },
  })

  const { data: usage } = useQuery<{ rows: RateUsageRow[] }>({
    queryKey: ['fallback', 'rate-limit-usage'],
    queryFn: () => apiFetch('/api/fallback/rate-limit-usage'),
  })
  const usageByModel = useMemo(() => {
    const byId = new Map<number, RateUsageRow>()
    for (const r of usage?.rows ?? []) byId.set(r.modelDbId, r)
    return byId
  }, [usage?.rows])

  const { data: profiles } = useQuery<{ id: number; name: string }[]>({
    queryKey: ['profiles'],
    queryFn: () => apiFetch('/api/profiles'),
  })
  const membership = useMutation({
    mutationFn: (body: { chain: string; modelDbIds: number[]; member: boolean }) =>
      apiFetch('/api/fallback/membership', { method: 'POST', body: JSON.stringify(body) }),
    onSuccess: invalidate,
  })

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

  // Declared before the memo that uses it: `const` here would be in its
  // temporal dead zone during render, which is exactly the TDZ crash this
  // panel shipped once already.
  function routable(r: Row) {
    return r.enabled && (r.keyScope === 'in' || r.keyScope === 'unscoped')
  }

  const rows = useMemo(() => {
    const mine = (data?.rows ?? []).filter(r => r.platform === platform && (endpointScope === undefined || r.endpointScope === endpointScope))
    const value = (r: Row) =>
      sort === 'name' ? null
      : sort === 'speed' ? r.analysis?.medianOutputTokensPerSecond ?? null
      : sort === 'coding' ? r.analysis?.codingIndex ?? null
      : sort === 'agentic' ? r.analysis?.agenticIndex ?? null
      : r.analysis?.intelligenceIndex ?? null
    const sorted = [...mine]
      // The filter now asks whether the row can serve a request at all, which
      // is the union of the two old tests: switched on in the catalogue AND
      // reachable by a key we hold.
      .filter(r => !hideDisabled || routable(r))
      // Unmeasured last in every ordering: a model with no score is not a zero.
      .sort((a, b) => {
        if (sort === 'name') return a.displayName.localeCompare(b.displayName)
        const x = value(a); const y = value(b)
        if (x == null && y == null) return a.displayName.localeCompare(b.displayName)
        if (x == null) return 1
        if (y == null) return -1
        return y - x || a.displayName.localeCompare(b.displayName)
      })
    // Working rows first, then the Parked section: what can serve is what the
    // operator is here to look at, and a parked row keeps its note beside it.
    return [...sorted.filter(routable), ...sorted.filter(r => !routable(r))]
  }, [data?.rows, platform, endpointScope, sort, hideDisabled])


  // Only what this key can actually reach: probing a model outside the key's
  // scope would report the credential's limits as the model's.
  const untestedIds = useMemo(
    () => rows.filter(r => routable(r) && !healthByModel.has(r.modelId)).map(r => r.modelId),
    [rows, healthByModel],
  )
  // Only the codes actually present. A glossary of eight lines under a table
  // showing one of them is noise.
  const shownCodes = useMemo(() => {
    const present = new Set(rows.map(r => healthByModel.get(r.modelId)?.code).filter(Boolean))
    return HEALTH_CODES.filter(c => present.has(c))
  }, [rows, healthByModel])

  // Counted from the UNFILTERED catalogue, so the number does not vanish the
  // moment the filter it describes is switched on. Counts what the filter now
  // hides — everything that cannot serve — so a provider with nothing switched
  // off but a table of unreachable rows finally reports a number.
  const unroutableCount = useMemo(
    // THIS provider's rows. The payload carries every platform, so counting it
    // whole reported 42 hidden on a panel that had four.
    () => (data?.rows ?? []).filter(r => r.platform === platform && (endpointScope === undefined || r.endpointScope === endpointScope) && !routable(r)).length,
    [data?.rows, platform, endpointScope],
  )

  // Arrivals on this provider not yet seen (same window and store as the key
  // row's tag). New models usually land outside the key's scope, which is
  // exactly what "Hide can't route" hides - so the chip lights up whenever it
  // is the reason a new model is not on screen.
  const churnEnabled = useExtensionEnabled('provider-churn')
  const { data: catalogueChanges } = useCatalogueChanges()
  const unseenArrivals = useUnseenArrivals(churnEnabled ? churnByPlatform(catalogueChanges).get(platform)?.arrived : undefined)
  const newModelIds = new Set(unseenArrivals.map(m => m.modelId))
  // This panel's rows: the platform, narrowed to one endpoint for an
  // OpenAI-compatible account row.
  const ours = (r: Row) => r.platform === platform && (endpointScope === undefined || r.endpointScope === endpointScope)
  // Highlights scores against the chain picked in the chain-minimums panel.
  const tone = useScoreTone()
  const hiddenNewCount = hideDisabled
    ? (data?.rows ?? []).filter(r => ours(r) && newModelIds.has(r.modelId) && !routable(r)).length
    : 0

  // The soonest reset among this platform's quota pools, from the same payload
  // the Quota page reads — including a window folded behind a binding one,
  // which is where OpenRouter's daily reset lives. Null when every window is
  // rolling: there is no instant to name, and inventing one is the failure this
  // codebase keeps correcting.
  const { data: quotaData } = useQuery<{ providers: ProviderQuotaRow[] }>({
    queryKey: ['quota', 'providers'],
    queryFn: () => apiFetch('/api/quota/providers'),
  })
  const nextReset = useMemo(() => {
    const seconds = (quotaData?.providers ?? [])
      .filter(p => p.platform === platform)
      .flatMap(p => [p.seconds_until_reset, ...(p.alsoBound ?? []).map(w => w.seconds_until_reset)])
      .filter((n): n is number => typeof n === 'number' && n > 0)
    return seconds.length > 0 ? Math.min(...seconds) : null
  }, [quotaData?.providers, platform])

  const deadCount = useMemo(
    () => rows.filter(r => healthByModel.get(r.modelId)?.verdict === 'dead').length,
    [rows, healthByModel],
  )

  if (isLoading) return <p className="px-3 py-2 text-xs text-muted-foreground">{t('common.loading')}</p>
  // Only when the provider genuinely has no catalogue rows. Testing the
  // FILTERED list here told HuggingFace "no models discovered" while 121 sat in
  // the catalogue, and took the filter chip with it — the one control that
  // could undo the filter, gone, with the preference persisted. The filtered
  // case falls through and is handled under the table, chip intact.
  const provider = (data?.rows ?? []).filter(ours)
  if (provider.length === 0) return <p className="px-3 py-2 text-xs text-muted-foreground">{t('keys.panelNoModels')}</p>

  const scoped = rows.filter(routable).length
  // Only routable rows count: measuring a model this key cannot serve is not
  // coverage of anything.
  const probedScoped = rows.filter(r => routable(r) && latestProbe.has(r.modelId)).length
  const busy = setRoutable.isPending

  return (
    <div className="mt-2 rounded-2xl border bg-card p-3">
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <span className="text-xs font-medium">{t('keys.panelTitle', { count: rows.length })}</span>
        <span className="text-[11px] text-muted-foreground tabular-nums">
          {t('keys.panelScopedCount', { scoped, total: rows.length })}
        </span>
        {probedScoped > 0 && (
          <span className="text-[11px] text-muted-foreground tabular-nums" title={t('keys.panelProbedHint')}>
            {t('keys.panelProbedCount', { probed: probedScoped, scoped })}
          </span>
        )}
        {/* When this provider's allowance next returns.

            The table already says how much is left today, per model, and said
            nothing about when that becomes untrue — so a row reading "0 of 20"
            was indistinguishable from a dead route. The figure is the Quota
            page's own: the soonest reset across this platform's pools, which
            for Google is one anchor (midnight Pacific) shared by every Flash
            route.

            Absent for a provider whose windows are all rolling: there is no
            instant to name, and inventing one is the failure this codebase
            keeps correcting. */}
        {nextReset != null && (
          <span className="text-[11px] text-muted-foreground tabular-nums" title={t('keys.panelResetHint')}>
            {t('keys.panelResetIn', { countdown: formatCountdown(nextReset) })}
          </span>
        )}
        {deadCount > 0 && (
          <span className="rounded-full bg-rose-500/10 px-2 py-0.5 text-[10px] text-rose-700 dark:text-rose-400"
                title={t('keys.healthDeadHint')}>
            {t('keys.healthDeadCount', { count: deadCount })}
          </span>
        )}
        <span className="flex-1" />
        {/* Establish verdicts for the routes nothing has ever called. One
            four-token request each, in series — a burst would trip the rate
            limits it is trying to tell apart from dead routes. Capped so a
            press cannot walk a whole catalogue. */}
        {untestedIds.length > 0 && (
          <Button
            size="sm"
            variant="outline"
            className="h-6 rounded-full px-2 text-[10px]"
            disabled={probe.isPending}
            onClick={() => probe.mutate(untestedIds.slice(0, 25))}
          >
            {probe.isPending
              ? t('keys.healthTesting')
              : t('keys.healthTest', { count: Math.min(untestedIds.length, 25) })}
          </Button>
        )}
        {/* One filter, because the old pair measured overlapping things and the
            weaker one wore the obvious name. "Hide disabled" tested only the
            catalogue flag, so on a provider where nothing is switched off it
            hid nothing while the table was full of grey rows — 121 on
            HuggingFace, 27 on Cloudflare — unreachable because the key's scope
            excludes them or there is no key at all. "Only in scope" was the one
            that hid those, and its test was a strict superset.

            Now the question is the one worth asking: can this row serve a
            request? Hidden rows are counted in the label, so a filter can never
            make a model quietly cease to exist. */}
        {/* Nothing to hide: the control says so rather than accepting a press
            that changes nothing. Still pressable while it is ON, so a filter
            left on from another provider can always be turned off. */}
        <button
          type="button"
          onClick={toggleHideDisabled}
          aria-pressed={hideDisabled}
          disabled={!hideControlPressable(unroutableCount, hideDisabled)}
          title={hideControlPressable(unroutableCount, hideDisabled) ? undefined : t('keys.panelHideNothing')}
          className={`rounded-full border px-2 py-0.5 text-[10px] ${hiddenNewCount > 0 ? 'border-amber-500 bg-amber-500/15 ring-1 ring-amber-500/60 text-amber-800 dark:text-amber-300' : hideDisabled ? 'bg-muted' : 'hover:bg-muted/50'} disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent`}
        >
          {t('keys.panelHideUnroutable')}
          {unroutableCount > 0 && (
            <span className="ml-1 text-muted-foreground tabular-nums">{unroutableCount}</span>
          )}
          {hiddenNewCount > 0 && (
            <span className="ml-1 font-medium tabular-nums">{t('keys.newArrivalsHidden', { count: hiddenNewCount })}</span>
          )}
        </button>
        {unseenArrivals.length > 0 && (
          <button
            type="button"
            onClick={() => markArrivalsSeen(unseenArrivals)}
            className="rounded-full border border-amber-500/50 px-2 py-0.5 text-[10px] text-amber-800 hover:bg-amber-500/15 dark:text-amber-300"
          >
            {t('keys.newArrivalsMarkSeen', { count: unseenArrivals.length })}
          </button>
        )}
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
            <th className="py-1 pr-2 text-right font-normal">{t('keys.panelColAllowance')}</th>
            <th className="py-1 pr-2 text-left font-normal">{t('keys.panelColChains')}</th>
            <th className="py-1 pr-2 text-left font-normal">{t('compare.colMatch')}</th>
            <th className="py-1 text-center font-normal">{t('keys.panelColEnabled')}</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => {
            const parkedStart = !routable(r) && (i === 0 || routable(rows[i - 1]))
            return (
              <Fragment key={r.modelDbId}>
              {parkedStart && (
                <tr className="border-t-2">
                  <td colSpan={10} className="bg-muted/40 px-2 py-1.5 text-[11px]">
                    <span className="font-semibold">{t('keys.parkedTitle', { count: rows.length - i })}</span>
                    <span className="ml-2 text-muted-foreground">{t('keys.parkedHint')}</span>
                  </td>
                </tr>
              )}
              {/* Faded when it cannot route — switched off, or outside the
                  key's scope. The row stays readable and stops competing with
                  the models that are actually in play. The switch keeps full
                  contrast so it is still obviously operable. */}
              <tr
                className={`group/row border-t ${verdictEdge(healthByModel.get(r.modelId))} ${newModelIds.has(r.modelId) ? 'bg-amber-500/10' : routable(r) ? '' : 'opacity-45'}`}
              >
                <td className="py-1 pr-2">
                  <span className="flex max-w-[260px] items-center gap-1">
                    {renaming?.id === r.modelDbId ? (
                      <Input
                        autoFocus
                        value={renaming.value}
                        onChange={e => setRenaming({ id: r.modelDbId, value: e.target.value })}
                        onKeyDown={e => {
                          if (e.key === 'Enter') saveRename(r)
                          if (e.key === 'Escape') setRenaming(null)
                        }}
                        onBlur={() => saveRename(r)}
                        disabled={rename.isPending}
                        aria-label={t('keys.renameModel')}
                        className="h-6 w-[220px] text-xs"
                      />
                    ) : (
                      <button
                        type="button"
                        onClick={() => { rename.reset(); setRenaming({ id: r.modelDbId, value: r.displayName }) }}
                        title={t('keys.renameModelHint')}
                        className="truncate text-left font-medium decoration-dotted underline-offset-2 hover:underline"
                      >
                        {r.displayName}
                      </button>
                    )}
                    {newModelIds.has(r.modelId) && (
                      <span className="shrink-0 rounded-full bg-amber-500 px-1.5 text-[9px] font-semibold uppercase tracking-wide text-white">{t('keys.newArrivalBadge')}</span>
                    )}
                  </span>
                  <code className="block max-w-[260px] truncate text-[10px] text-muted-foreground" title={r.modelId}>{r.modelId}</code>
                  {rename.isError && rename.variables?.id === r.modelDbId && (
                    <span className="block text-[10px] text-destructive">{(rename.error as Error).message}</span>
                  )}
                  {/* Why the row is greyed. Without this a tested-good route
                      that is switched off looks like the router ignoring it. */}
                  {(() => {
                    const why = blockedReason(r)
                    // "Switched off" alone hid three different situations with
                    // three different fixes. Name the one this row is in.
                    const text = why !== 'panelWhyCatalogueOff' || !r.offReason ? (why && t(`keys.${why}`))
                      : r.offReason.kind === 'override' ? t('keys.offOverride', { date: r.offReason.since.slice(0, 10) })
                      : r.offReason.kind === 'upstream' ? t('keys.offUpstream')
                      : t('keys.offSwitched')
                    return text && (
                      <span className="mt-0.5 inline-block rounded-full bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
                        {text}
                      </span>
                    )
                  })()}
                  {/* Benched, not broken: the provider said wait. Shown only on
                      rows that could otherwise serve, where "why is nothing
                      coming from this" is the live question. */}
                  {routable(r) && r.pause && r.pause.untilMs > Date.now() && (
                    <span className="mt-0.5 ml-1 inline-block rounded-full bg-sky-500/15 px-1.5 py-0.5 text-[10px] text-sky-800 dark:text-sky-300">
                      {t(`keys.pause_${r.pause.source}`)} · {t('keys.pauseBackIn', { time: formatCountdown(Math.round((r.pause.untilMs - Date.now()) / 1000)) })}
                    </span>
                  )}
                  {/* The verdict sits ON the name, where the decision to enable
                      is made — not in a column that can be scrolled past. Only
                      failures are marked: a working route needs no badge, and
                      untested is left blank because it is not evidence. */}
                  <HealthMark health={healthByModel.get(r.modelId)} />
                  {unlimitedOn && (
                    <button
                      type="button"
                      disabled={setUnlimited.isPending}
                      onClick={() => setUnlimited.mutate({ row: r, on: !r.unlimited?.flagged })}
                      aria-pressed={!!r.unlimited?.flagged}
                      title={t(r.unlimited?.flagged ? 'keys.unlimitedOffHint' : 'keys.unlimitedOnHint')}
                      className={`mt-0.5 ml-1 inline-block rounded-full border px-1.5 py-0.5 text-[10px] ${
                        !r.unlimited?.flagged ? 'border-dashed text-muted-foreground/70 opacity-0 transition-opacity group-hover/row:opacity-100 hover:bg-muted focus-visible:opacity-100'
                        : r.unlimited.effective ? 'border-emerald-500/50 bg-emerald-500/12 text-emerald-800 dark:text-emerald-300'
                        : 'border-amber-500/50 bg-amber-500/15 text-amber-800 dark:text-amber-300'}`}
                    >
                      {!r.unlimited?.flagged ? t('keys.unlimitedSet') : r.unlimited.effective ? t('keys.unlimitedEffective') : t('keys.unlimitedWaiting')}
                    </button>
                  )}
                  <span className="mt-0.5 block"><ChainFit score={scoreRowOf(r)} chains={r.chains} /></span>
                  {noteEdit?.id === r.modelDbId ? (
                    <span className="mt-1 flex max-w-[300px] flex-wrap items-center gap-1">
                      <Input
                        autoFocus
                        value={noteEdit.text}
                        maxLength={500}
                        placeholder={t('keys.notePlaceholder')}
                        onChange={e => setNoteEdit({ ...noteEdit, text: e.target.value })}
                        onKeyDown={e => {
                          if (e.key === 'Enter') saveNote.mutate(noteEdit)
                          if (e.key === 'Escape') setNoteEdit(null)
                        }}
                        aria-label={t('keys.noteLabel')}
                        className="h-6 min-w-0 flex-1 text-[11px]"
                      />
                      <input
                        type="date"
                        value={noteEdit.recheckAt}
                        onChange={e => setNoteEdit({ ...noteEdit, recheckAt: e.target.value })}
                        aria-label={t('keys.noteRecheck')}
                        title={t('keys.noteRecheck')}
                        className="h-6 rounded-md border bg-background px-1 text-[10px]"
                      />
                      <Button size="xs" disabled={saveNote.isPending} onClick={() => saveNote.mutate(noteEdit)}>{t('common.save')}</Button>
                      <Button size="xs" variant="ghost" onClick={() => setNoteEdit(null)}>{t('common.cancel')}</Button>
                      {saveNote.isError && <span className="w-full text-[10px] text-destructive">{(saveNote.error as Error).message}</span>}
                    </span>
                  ) : r.note ? (
                    <button
                      type="button"
                      onClick={() => { saveNote.reset(); setNoteEdit({ id: r.modelDbId, text: r.note!.text, recheckAt: r.note!.recheckAt ?? '' }) }}
                      title={t('keys.noteEditHint', { date: r.note.updatedAt.slice(0, 10) })}
                      className="mt-0.5 block max-w-[300px] text-left text-[10px] text-muted-foreground hover:text-foreground"
                    >
                      <span className="font-medium">{t('keys.noteLabel')}:</span> {r.note.text}
                      {r.note.recheckAt && (
                        <span className={r.note.recheckAt <= today ? ' font-medium text-amber-700 dark:text-amber-400' : ''}>
                          {' · '}{t(r.note.recheckAt <= today ? 'keys.noteRecheckDue' : 'keys.noteRecheckOn', { date: r.note.recheckAt })}
                        </span>
                      )}
                    </button>
                  ) : (
                    <button
                      type="button"
                      onClick={() => { saveNote.reset(); setNoteEdit({ id: r.modelDbId, text: '', recheckAt: '' }) }}
                      className="mt-0.5 block text-[10px] text-muted-foreground/70 opacity-0 transition-opacity hover:text-foreground focus-visible:opacity-100 group-hover/row:opacity-100"
                    >
                      {t('keys.noteAdd')}
                    </button>
                  )}
                </td>
                <Num v={r.analysis?.intelligenceIndex} row={r} metric="intelligence" onNudge={nudge.mutate} busy={busy} tone={tone('general', r.analysis?.intelligenceIndex)} />
                <Num v={r.analysis?.codingIndex} row={r} metric="coding" onNudge={nudge.mutate} busy={busy} tone={tone('coding', r.analysis?.codingIndex)} />
                <Num v={r.analysis?.agenticIndex} row={r} metric="agentic" onNudge={nudge.mutate} busy={busy} tone={tone('agentic', r.analysis?.agenticIndex)} />
                <Num v={r.analysis?.medianOutputTokensPerSecond} digits={0} row={r} metric="speed" onNudge={nudge.mutate} busy={busy} />
                <td className="py-1 pr-2 text-right tabular-nums text-muted-foreground">
                  {r.contextWindow ? `${Math.round(r.contextWindow / 1000)}K` : '–'}
                </td>
                {/* What this route was measured to allow, newest run. Blank is
                    a real answer: nobody has checked, and the number beside it
                    in the catalogue is only a claim. */}
                <AllowanceCell probe={latestProbe.get(r.modelId)} usage={usageByModel.get(r.modelDbId)} />
                {/* Which chains actually route here. An enabled, in-scope model
                    serving nothing is the state worth seeing beside the switch:
                    it is available and idle. */}
                <td className="py-1 pr-2 text-[10px]">
                  <ChainPicker
                    chains={(profiles ?? []).map(p => p.name)}
                    member={r.chains}
                    // Same control as Compare, same data: deciding a provider's
                    // menu and ordering it are one motion, and sending the
                    // reader to another page to type a number was the gap.
                    ranks={Object.fromEntries(r.chains.map((chain, i) => [
                      chain, { rank: r.chainRanks[i], modelDbId: r.modelDbId },
                    ]))}
                    disabled={membership.isPending || position.isPending}
                    onRank={(chain, modelDbId, next) => position.mutate({ chain, modelDbId, position: next })}
                    onApply={changes => changes.forEach(c => membership.mutate({
                      chain: c.chain,
                      modelDbIds: [r.modelDbId],
                      member: c.member,
                    }))}
                  />
                  {/* Available and unused is the state worth naming, and only
                      says anything once the model could actually route. */}
                  {r.chains.length === 0 && routable(r) && (
                    <span className="ml-1 text-muted-foreground">{t('keys.panelIdle')}</span>
                  )}
                </td>
                <td className="py-1 pr-2">
                  <MappingCell
                    row={r}
                    catalogue={data?.catalogue ?? []}
                    disabled={link.isPending || nudge.isPending}
                    onLink={(slug, proxy) => link.mutate({ platform: r.platform, modelId: r.modelId, aaSlug: slug, proxy })}
                  />
                  {/* The estimate has stopped being the best answer available.
                      Offered here as well as on Compare, since this is where a
                      proxy is set in the first place. */}
                  {(() => {
                    const u = upgradeFor(r)
                    if (!u) return null
                    return (
                      <Tooltip text={t('keys.panelUpgradeHint', { name: u.realName, reason: u.matchReason })}>
                        <button
                          type="button"
                          disabled={acceptUpgrade.isPending}
                          onClick={() => acceptUpgrade.mutate({ platform: r.platform, modelId: r.modelId })}
                          className="mt-0.5 block rounded-full border border-amber-500/50 px-1.5 text-[10px] text-amber-600 dark:text-amber-400"
                        >
                          {t('keys.panelUpgrade')}
                        </button>
                      </Tooltip>
                    )
                  })()}
                </td>
                <td className="py-1 text-center opacity-100">
                  {REFERENCE_ONLY_PLATFORMS[r.platform]
                    ? (
                      <Tooltip text={t('models.referenceOnlyHint')}>
                        <span className="rounded-full bg-muted px-2 py-0.5 text-[10px] text-muted-foreground">
                          {t('models.referenceOnly')}
                        </span>
                      </Tooltip>
                    )
                    : (
                      <Switch
                        checked={routable(r)}
                        disabled={busy}
                        aria-label={t('keys.panelColEnabled')}
                        onCheckedChange={on => setRoutable.mutate({ row: r, on })}
                      />
                    )}
                </td>
              </tr>
              </Fragment>
            )
          })}
          {/* Hidden, the Parked section still says it exists and how big it is. */}
          {hideDisabled && unroutableCount > 0 && (
            <tr className="border-t-2">
              <td colSpan={10} className="bg-muted/40 px-2 py-1.5 text-[11px]">
                <span className="font-semibold">{t('keys.parkedTitle', { count: unroutableCount })}</span>
                <button type="button" onClick={toggleHideDisabled} className="ml-2 text-muted-foreground underline-offset-2 hover:text-foreground hover:underline">
                  {t('keys.parkedShow')}
                </button>
              </td>
            </tr>
          )}
        </tbody>
      </table>
      {/* Every row filtered out. Said here rather than in place of the panel,
          so the chip that hid them stays on screen and the state is one click
          from reversible — and phrased as what it is, not as "nothing
          discovered", which is what a provider with 121 hidden rows was told. */}
      {rows.length === 0 && (
        <p className="px-1 py-2 text-xs text-muted-foreground">
          {t('keys.panelAllFiltered', { count: provider.length })}
        </p>
      )}
      {/* The legend sits under the codes it explains, and only appears once a
          code is on screen: a permanent glossary for a table that is usually
          all green is clutter. Ordered as an operator should act — the
          refusals no waiting will fix come first. */}
      {shownCodes.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 border-t pt-2 text-[10px] text-muted-foreground">
          {shownCodes.map(code => (
            <span key={code}>
              <code className="rounded bg-muted px-1">{code}</code>{' '}
              {t(`keys.healthCode_${code}`)}
            </span>
          ))}
        </div>
      )}
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
function Num({ v, digits = 1, row, metric, onNudge, busy, tone }: {
  v: number | null | undefined
  /** Highlight against the chain-minimums panel's chosen chain. */
  tone?: string
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
    <td className={`group/num py-1 pr-2 text-right tabular-nums ${tone ?? ''}`}>
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
  // Selection is provisional until OK. Writing on select meant the "closest
  // match" tick had to be set BEFORE choosing — get the order wrong and the
  // only way back was to pick the model again — and changing your mind about
  // the flag alone cost a reselect.
  const [pending, setPending] = useState<string | null>(null)
  const isProxy = row.link?.source === 'proxy'

  const commit = () => {
    const slug = pending ?? row.link?.slug ?? NO_COUNTERPART
    onLink(slug === NO_COUNTERPART ? null : slug, proxy)
    setPending(null)
    setEditing(false)
  }

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
        value={pending ?? row.link?.slug ?? NO_COUNTERPART}
        options={[
          { value: NO_COUNTERPART, label: t('compare.matchNoneOption') },
          ...catalogue.map(c => ({
            value: c.slug,
            label: c.name,
            sub: c.intelligenceIndex == null ? (c.creator ?? undefined) : c.intelligenceIndex.toFixed(0),
            platforms: c.creator ? [c.creator] : undefined,
          })),
        ]}
        renderLabel={label => <ModelName name={label} />}
        onSelect={setPending}
        stayOpen
        footer={
          // Inside the popover, not beside it: a button outside would be an
          // outside-click, closing the list before it could fire.
          <span className="flex items-center justify-between gap-2 border-t pt-2">
            <label className="inline-flex items-center gap-1 text-[10px] text-muted-foreground" title={t('keys.proxyHint')}>
              <input type="checkbox" checked={proxy} onChange={e => setProxy(e.target.checked)} className="size-3 accent-foreground" />
              {t('keys.proxyLabel')}
            </label>
            <Button size="xs" disabled={disabled} onClick={commit}>{t('common.ok')}</Button>
          </span>
        }
        ariaLabel={t('compare.mapAriaLabel')}
        placeholder={t('compare.mapSearchPlaceholder')}
        emptyText={t('compare.mapNoResults')}
        triggerPlaceholder={t('compare.matchNoneOption')}
        triggerClassName="h-6 max-w-[160px] text-[11px]"
        ariaInvalid={false}
        align="start"
      />
      <button
        type="button"
        onClick={() => { setPending(null); setEditing(false) }}
        disabled={disabled}
        aria-label={t('common.cancel')}
        className="text-muted-foreground"
      >×</button>
    </span>
  )
}

/** "No counterpart" is a decision, so it needs a value of its own: an empty
 *  string would read as "nothing picked yet". */
const NO_COUNTERPART = '__none__'
