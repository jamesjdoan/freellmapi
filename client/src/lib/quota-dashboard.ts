// Provider allowance cards for Keys → Quota, modelled on Atrium's provider
// widgets: one card per provider the operator holds an enabled key for, one
// row per allowance with a headroom bar, a waiting badge on a spent row, and a
// footer with the next reset and how fresh the reading is.
//
// Pure: everything here is a function of the server overview, the key list,
// the raw observations and the clock, so the card logic is testable without a
// DOM.

/** One row of GET /api/quota/providers — only the fields the cards read. */
export interface OverviewPool {
  platform: string
  pool: string | null
  limit: number | null
  remaining: number | null
  reset_at: string | null
  metered: boolean
  usedSource: 'provider' | 'local' | null
  metric: string | null
  unit: string | null
}

export interface KeyRef { id: number; platform: string; enabled: boolean }
export interface ObservationRef {
  platform: string
  keyId: number
  observedAt: string
  /** A reading with neither is a probe that measured nothing; it does not
   *  make a card's numbers any fresher. Absent counts as a measurement. */
  limit?: number | null
  remaining?: number | null
}

export type Tone = 'good' | 'warn' | 'low'

export interface PoolRow {
  id: string
  label: string
  /** Percent of the allowance left, 0..100; null when the size is unknown. */
  left: number | null
  /** "812 / 1,000", "$12.00 / $12.00", "68% of allowance". */
  amount: string
  tone: Tone | null
  spent: boolean
  /** Counted by this install against a declared limit, not reported. */
  local: boolean
  /** The provider never states this limit; it was learned from its refusals
   *  or declared by the operator. */
  learned: boolean
  /** The reset has rolled over since this reading: the window is full again
   *  until the next measured request, however the stale reading read. */
  refilled: boolean
}

export interface ProviderCard {
  platform: string
  rows: PoolRow[]
  /** Pools whose free allowance is zero: paid-only models, not a broken pool. */
  paidOnly: number
  /** Some row is spent and waiting for its reset. */
  waiting: boolean
  /** Earliest reset still ahead, epoch ms. */
  nextResetMs: number | null
  /** Newest reading for this provider's live keys, epoch ms. */
  updatedMs: number | null
  stale: boolean
}
/** One entry of GET /api/quota/usage-credentials — how a key's account-usage
 *  credential last read went. The secret itself never comes back. */
export interface UsageCredentialStatus {
  keyId: number
  platform: string
  setAt: string
  lastReadAt: string | null
  lastStatus: 'ok' | 'error' | null
  lastMessage: string | null
}

export interface UsageCredentialsResponse {
  /** Field names each platform's credential takes, in display order. */
  supported: Record<string, string[]>
  credentials: UsageCredentialStatus[]
}

/** A card's usage-credential line: the newest read's outcome for the
 *  platform, with a refusal taking precedence over a balance note. */
export interface UsageCredLine {
  /** Newest read attempt across the platform's keys, epoch ms. */
  readMs: number | null
  message: string | null
  /** Some credential's latest read failed; its message is the reason. */
  errorMessage: string | null
}

/** Aggregated status for one platform's usage credentials, or null when none
 *  of its keys is connected yet. */
export function summarizeUsageCredentials(
  credentials: UsageCredentialStatus[],
  platform: string,
): UsageCredLine | null {
  const mine = credentials.filter(c => c.platform === platform)
  if (mine.length === 0) return null
  const byRead = (a: UsageCredentialStatus, b: UsageCredentialStatus) =>
    (parseStamp(b.lastReadAt) ?? 0) - (parseStamp(a.lastReadAt) ?? 0)
  const newest = [...mine].sort(byRead)[0]
  const failed = mine.filter(c => c.lastStatus === 'error').sort(byRead)[0]
  return { readMs: parseStamp(newest.lastReadAt), message: newest.lastMessage, errorMessage: failed?.lastMessage ?? null }
}

export const STALE_AFTER_MS = 24 * 60 * 60 * 1000

/** Same thresholds as Atrium: red at 20% left or less, amber at half. */
export function headroomTone(left: number): Tone {
  if (left <= 20) return 'low'
  if (left <= 50) return 'warn'
  return 'good'
}

/** SQLite `YYYY-MM-DD HH:MM:SS` is UTC without a marker; ISO passes through. */
export function parseStamp(value: string | null | undefined): number | null {
  if (!value) return null
  const bare = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(\.\d+)?$/.test(value.trim())
  const ms = Date.parse(bare ? `${value.trim().replace(' ', 'T')}Z` : value)
  return Number.isNaN(ms) ? null : ms
}

/** The pool's own name without the provider prefix or its kind. */
export function poolName(platform: string, pool: string | null): string {
  if (!pool) return '—'
  const rest = pool.startsWith(`${platform}::`) ? pool.slice(platform.length + 2) : pool
  if (rest === 'calendar_day') return 'daily'
  return rest.replace(/^(model|project-model)::/, '')
}

function amountOf(p: OverviewPool, locale: string, remaining: number): string {
  const n = (v: number) => new Intl.NumberFormat(locale, { notation: v >= 100_000 ? 'compact' : 'standard', maximumFractionDigits: 1 }).format(v)
  if (p.unit === 'cents') {
    const usd = (v: number) => new Intl.NumberFormat(locale, { style: 'currency', currency: 'USD' }).format(v / 100)
    return `${usd(remaining)} / ${usd(p.limit ?? 0)}`
  }
  // An unsized allowance reported as a fraction has nothing to add beside its percentage.
  if (p.unit === 'per_10k') return ''
  const what = p.metric === 'tokens' ? ' tokens' : ''
  return `${n(remaining)} / ${n(p.limit ?? 0)}${what}`
}

/**
 * One card per enabled keyed provider, spent and lowest first, providers with
 * nothing measured last. Pools of providers without an enabled key are left
 * out: they cannot be spent from here.
 */
export function buildCards(
  pools: OverviewPool[],
  keys: KeyRef[],
  observations: ObservationRef[],
  nowMs: number,
  locale = 'en',
): ProviderCard[] {
  const liveKeys = new Set(keys.filter(k => k.enabled).map(k => k.id))
  const platforms = [...new Set(keys.filter(k => k.enabled).map(k => k.platform))]

  const cards = platforms.map((platform): ProviderCard => {
    const mine = pools.filter(p => p.platform === platform && p.limit != null && p.remaining != null)
    const rows: PoolRow[] = []
    let paidOnly = 0
    let nextResetMs: number | null = null
    let waiting = false
    for (const p of mine) {
      if (p.limit === 0) { paidOnly++; continue }
      // A reset in the past means the window rolled over after this reading
      // was taken (Google sends no headers on a successful request, so a
      // spent model would otherwise read "used up" forever). The stale
      // numbers are discarded: the row shows a full window until the next
      // measured request says otherwise.
      const reset = parseStamp(p.reset_at)
      const refilled = reset != null && reset <= nowMs
      const left = refilled ? 100 : Math.max(0, Math.min(100, Math.round(((p.remaining ?? 0) / (p.limit ?? 1)) * 100)))
      const spent = !refilled && (p.remaining ?? 0) <= 0
      if (reset != null && reset > nowMs) {
        nextResetMs = nextResetMs == null ? reset : Math.min(nextResetMs, reset)
        if (spent) waiting = true
      }
      rows.push({
        id: `${p.pool}:${p.metric}`,
        label: poolName(platform, p.pool),
        left,
        amount: amountOf(p, locale, refilled ? (p.limit ?? 0) : (p.remaining ?? 0)),
        tone: headroomTone(left),
        spent,
        refilled,
        local: p.usedSource === 'local',
        learned: !p.metered,
      })
    }
    rows.sort((a, b) => Number(b.spent) - Number(a.spent) || (a.left ?? 101) - (b.left ?? 101) || a.label.localeCompare(b.label))

    const stamps = observations
      .filter(o => o.platform === platform && liveKeys.has(o.keyId))
      .filter(o => !('limit' in o || 'remaining' in o) || o.limit != null || o.remaining != null)
      .map(o => parseStamp(o.observedAt))
      .filter((ms): ms is number => ms != null)
    const updatedMs = stamps.length > 0 ? Math.max(...stamps) : null
    return {
      platform,
      rows,
      paidOnly,
      waiting,
      nextResetMs,
      updatedMs,
      stale: updatedMs != null && nowMs - updatedMs > STALE_AFTER_MS,
    }
  })

  const worst = (c: ProviderCard) => (c.rows.length === 0 ? 1000 : Math.min(...c.rows.map(r => r.left ?? 100)))
  return cards.sort((a, b) =>
    Number(b.waiting) - Number(a.waiting)
    || worst(a) - worst(b)
    || a.platform.localeCompare(b.platform))
}

/** A reset countdown: "17h 46m", "4m 05s" under an hour, so the card does not
 *  tick seconds on a reset most of a day away. */
export function formatReset(seconds: number): string {
  if (seconds <= 0) return '0m'
  const h = Math.floor(seconds / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  if (h > 0) return `${h}h ${m}m`
  return `${m}m ${String(seconds % 60).padStart(2, '0')}s`
}

/** "4m", "3h", "2d": how long ago, at the coarsest useful unit. */
export function formatAge(ms: number): string {
  const minutes = Math.max(0, Math.floor(ms / 60_000))
  if (minutes < 60) return `${minutes}m`
  if (minutes < 24 * 60) return `${Math.floor(minutes / 60)}h`
  return `${Math.floor(minutes / (24 * 60))}d`
}

/** Raw observations worth listing: rows for a key that still exists and is on.
 *  Everything else is history about a credential the operator removed. */
export function liveObservations<T extends ObservationRef>(rows: T[], keys: KeyRef[]): { live: T[]; hidden: number } {
  const liveKeys = new Set(keys.filter(k => k.enabled).map(k => k.id))
  const live = rows.filter(r => liveKeys.has(r.keyId))
  return { live, hidden: rows.length - live.length }
}
