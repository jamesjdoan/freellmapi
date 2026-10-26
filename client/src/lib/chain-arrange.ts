// Auto-arrange (ARCH-20261026): client view of /api/chain-arrange. Mirrors
// server/src/services/chain-arrange.ts and route-evidence.ts — routes are
// (platform, modelId, endpointScope) triples everywhere, never models.id.

export type ChainName = 'Default' | 'Coding' | 'Apex' | 'Fast-Lane' | 'Vision' | 'Extra-Tier'

export interface RouteRef {
  modelDbId: number
  platform: string
  modelId: string
  endpointScope: string
}

/** A pinned route: the position the arranger must keep it at, 1-based. */
export interface RoutePin {
  platform: string
  modelId: string
  endpointScope: string
  position: number
}

export interface ArrangeChainSettings {
  /** false = the arranger never writes this chain. */
  auto: boolean
  /** Models required above the failing tail. */
  minMembers: number
  /** Independent quota pools among the first minMembers. */
  minPools: number
  pins: RoutePin[]
}

export interface ArrangeSettingsDoc {
  version: 1
  /** 0 = defaults, never saved. Compare-and-set on every PUT. */
  revision: number
  savedAt: string | null
  tolerancePct: number
  chains: Record<string, ArrangeChainSettings>
}

export interface ChainArrangeOverview {
  settings: ArrangeSettingsDoc
  extensions: { arrange: boolean; probe: boolean }
  chains: Array<{ chain: ChainName; auto: boolean; lastRun: RunSummary | null }>
}

export interface ArrangeEntry extends RouteRef {
  /** 1-based new and current positions. */
  position: number
  from: number
  displayName: string
  eligibility: 'fit' | 'near' | 'filler' | 'out'
  tier: 'proven' | 'partial' | 'unmeasured' | 'failing'
  pinned: boolean
  pool: string
  metric: { name: 'intelligence' | 'coding' | 'latency' | 'reliability'; value: number | null }
  reliability: { n: number; ok: number; lowerBound: number }
  /** Server-written English: why the route sits here. */
  reasons: string[]
}

export interface ArrangePlan {
  chain: ChainName
  auto: boolean
  computedAtMs: number
  changed: boolean
  before: RouteRef[]
  entries: ArrangeEntry[]
  depth: { required: number; requiredPools: number; eligible: number; pools: number; satisfied: boolean }
}

export interface RunSummary {
  id: number
  chain: ChainName
  ranAtMs: number
  trigger: 'schedule' | 'manual'
  moved: number
}

export interface RunDetail extends RunSummary {
  settingsRevision: number
  before: RouteRef[]
  after: RouteRef[]
  entries: ArrangeEntry[]
}

export interface ProbeRunOutcome {
  ok: boolean
  /** Why no call was made: extension off, paid route, cooldown, no key. */
  refused?: string
  scenarioId?: string
  outcome?: string
  status?: string
  score?: number | null
  latencyMs?: number | null
}

export interface RouteEvidence {
  platform: string
  modelId: string
  endpointScope: string
  real: { n: number; ok: number; avgOkLatencyMs: number | null }
  probe: { n: number; ok: number; avgOkLatencyMs: number | null; lastAtMs: number | null }
  screen: {
    agentic: { mean: number | null; graded: number }
    coding: { mean: number | null; graded: number }
    nativeToolsUnsupported: boolean
  }
}

export interface RouteProbeRow {
  id: number
  keyId: number | null
  scenarioId: string
  benchVersion: string
  source: 'probe' | 'import'
  streamed: boolean
  outcome: string
  status: string
  score: number | null
  mode: string
  latencyMs: number | null
  ttfbMs: number | null
  promptTokens: number
  completionTokens: number
  error: string | null
  probedAtMs: number
}

export interface RouteHistoryDay {
  /** UTC day, YYYY-MM-DD. */
  day: string
  realN: number
  realOk: number
  probeN: number
  probeOk: number
  agenticMean: number | null
  codingMean: number | null
}

/** GET /api/chain-arrange/route-history: history plus the current evidence. */
export interface RouteHistoryResponse {
  route: { platform: string; modelId: string; endpointScope: string }
  probes: RouteProbeRow[]
  daily: RouteHistoryDay[]
  evidence: RouteEvidence | null
}

const BASE = '/api/chain-arrange'

export const chainArrangePaths = {
  overview: BASE,
  preview: `${BASE}/preview`,
  run: `${BASE}/run`,
  runs: (chain: string, limit = 20) => `${BASE}/runs?chain=${encodeURIComponent(chain)}&limit=${limit}`,
  runDetail: (id: number) => `${BASE}/runs/${id}`,
  routeHistory: (route: { platform: string; modelId: string; endpointScope: string }, days = 90) =>
    `${BASE}/route-history?platform=${encodeURIComponent(route.platform)}&modelId=${encodeURIComponent(route.modelId)}&endpointScope=${encodeURIComponent(route.endpointScope)}&days=${days}`,
  probe: `${BASE}/probe`,
}

/** Defaults the server applies to chains a saved document does not name. */
export const CHAIN_DEFAULTS: Record<ChainName, { minMembers: number; minPools: number }> = {
  Default: { minMembers: 8, minPools: 4 },
  Coding: { minMembers: 8, minPools: 4 },
  Apex: { minMembers: 8, minPools: 4 },
  'Fast-Lane': { minMembers: 6, minPools: 3 },
  Vision: { minMembers: 4, minPools: 2 },
  'Extra-Tier': { minMembers: 0, minPools: 0 },
}

/** Display order when the API returns no chain list (an older server). */
export const CHAIN_ORDER: ChainName[] = ['Default', 'Coding', 'Apex', 'Fast-Lane', 'Vision', 'Extra-Tier']

/** A chain absent from a saved document IS its defaults, not an error. */
export function effectiveChainSettings(doc: ArrangeSettingsDoc | undefined, chain: string): ArrangeChainSettings {
  const saved = doc?.chains?.[chain]
  if (saved) return saved
  const defaults = CHAIN_DEFAULTS[chain as ChainName] ?? { minMembers: 0, minPools: 0 }
  return { auto: true, pins: [], ...defaults }
}

/** The route identity a settings pin is keyed by. */
export function routePinKey(pin: Pick<RoutePin, 'platform' | 'modelId' | 'endpointScope'>): string {
  return `${pin.platform}\u0000${pin.modelId}\u0000${pin.endpointScope}`
}

/** Compact endpoint handle for a custom route: the scope IS the base URL, so
 *  strip the protocol and any path tail. Catalogue routes have '' and no handle. */
export function endpointHandle(endpointScope: string): string {
  if (!endpointScope) return ''
  return endpointScope.replace(/^https?:\/\//, '').replace(/\/.*$/, '') || endpointScope
}
