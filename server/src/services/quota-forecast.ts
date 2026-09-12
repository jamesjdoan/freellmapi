import type { QuotaObservationView } from './provider-quota.js';
import { getQuotaStateForKeys } from './provider-quota.js';
import { parseStoredUtc, DAY_MS, MINUTE_MS } from './quota-clock.js';
import { getDb } from '../db/index.js';
import { inferQuotaShape, inferAllowanceFromFraction, inferWindowFromResets, type InferredWindow, type InferredAllowance } from './quota-inference.js';
import { resolveEffectiveQuotas, effectiveRouteWindows } from './quota-policy.js';
import { resolveQuotaPolicy, consumesPaidBalance, legacyPoolKey } from './provider-quota.js';
import type { Platform } from '@freellmapi/shared/types.js';
import { countRequestsInWindow, countPlatformUsageInWindow } from './ratelimit.js';

// Daily free-tier balance forecast (#1104). Free tiers reset on a per-account
// window (usually UTC midnight) and the only way to know how much headroom is
// left before that reset is to read what the providers themselves reported.
// This is a pure aggregation over `getQuotaStateForKeys()` — no new tables, no
// extra probes — so it costs nothing beyond the query the health view already
// runs.
//
// The value it adds over the raw rows: one number per platform that answers
// "can I keep calling this platform for the rest of today?", plus a
// low-balance warning an agent can gate on BEFORE sending a request that would
// 429.

export const LOW_BALANCE_THRESHOLD = 0.1; // <10% of the daily window left → warn
export const LOW_BALANCE_ABSOLUTE = 20; // ...or fewer than 20 requests left
// The absolute floor is a statement about big windows: "20 left" is alarming
// out of 14400/day and unremarkable out of 30/day. Below this limit the
// percentage rule alone decides, otherwise a small tier would warn from its
// first request onwards and the flag would mean nothing.
export const LOW_BALANCE_ABSOLUTE_MIN_LIMIT = 200;

export interface QuotaForecastEntry {
  /** Platform the pool belongs to, e.g. 'groq'. */
  platform: string;
  /** Human-readable pool label (platform::scope), e.g. 'groq::account'. */
  pool: string;
  /** Requests used in the current window. Null when `remaining` is unknown,
   *  since used is only ever derived from it. */
  used: number | null;
  /** Requests remaining in the current window. Null when unknown. */
  remaining: number | null;
  /** Window total. Null when the provider never reported a limit. */
  limit: number | null;
  /** 0..100 share of the window still available (best-effort). */
  remaining_pct: number | null;
  /** ISO timestamp of the window reset, or null when never observed. */
  reset_at: string | null;
  /** True when less than LOW_BALANCE_THRESHOLD of the window remains, or —
   *  on a window of at least LOW_BALANCE_ABSOLUTE_MIN_LIMIT — fewer than
   *  LOW_BALANCE_ABSOLUTE requests do. Always false when remaining is unknown. */
  low_balance: boolean;
  /** Seconds until reset_at, or null when reset_at is unknown/expired. */
  seconds_until_reset: number | null;
}

function secondsUntilReset(resetAt: string | null): number | null {
  // parseStoredUtc, not `new Date()`: reset_at is stored as a zone-less UTC
  // string, which `new Date()` reads as local time. On a UTC+10 host that made
  // every reset under ten hours away look like it had already passed.
  const at = parseStoredUtc(resetAt);
  if (at == null) return null;
  const ms = at - Date.now();
  if (ms <= 0) return null;
  return Math.floor(ms / 1000);
}

function entryFor(row: QuotaObservationView): QuotaForecastEntry | null {
  // Only request-based windows are predictable from quota headers; token pools
  // reset semantics vary too much across providers to forecast honestly.
  if (row.metric !== 'requests') return null;
  // Without a known limit there is no window to forecast — nothing to warn on.
  if (typeof row.limit !== 'number' || row.limit <= 0) return null;

  const limit = row.limit;
  const remaining = typeof row.remaining === 'number' ? row.remaining : null;

  // An unknown `remaining` says nothing about consumption: reporting the whole
  // limit as used would read as an exhausted pool when it may be untouched.
  const used = remaining === null ? null : Math.max(0, limit - remaining);
  let remainingPct: number | null = null;
  let lowBalance = false;
  if (remaining !== null) {
    remainingPct = Math.max(0, Math.min(100, Math.round((remaining / limit) * 100)));
    const absoluteApplies = limit >= LOW_BALANCE_ABSOLUTE_MIN_LIMIT;
    lowBalance = (absoluteApplies && remaining <= LOW_BALANCE_ABSOLUTE)
      || remaining / limit < LOW_BALANCE_THRESHOLD;
  }

  return {
    platform: row.platform,
    pool: row.quotaPoolKey ?? `${row.platform}::default`,
    used,
    remaining,
    limit,
    remaining_pct: remainingPct,
    reset_at: row.resetAt ?? null,
    low_balance: lowBalance,
    seconds_until_reset: secondsUntilReset(row.resetAt ?? null),
  };
}

// Dedupe to the TIGHTEST row per platform+pool: a platform with several keys
// sharing one account pool reports the same window per key, and the number that
// matters for "can I keep calling" is the least headroom left.
export function getQuotaForecast(): QuotaForecastEntry[] {
  const byKey = new Map<string, QuotaForecastEntry>();
  for (const row of getQuotaStateForKeys()) {
    const entry = entryFor(row);
    if (!entry) continue;
    // `pool` already carries its platform ("groq::account"), so it is the key.
    const key = entry.pool;
    const prev = byKey.get(key);
    if (!prev || (entry.remaining_pct ?? Infinity) < (prev.remaining_pct ?? Infinity)) {
      byKey.set(key, entry);
    }
  }
  return [...byKey.values()].sort((a, b) => {
    // Low-balance pools first — the ones the caller most needs to see.
    if (a.low_balance !== b.low_balance) return a.low_balance ? -1 : 1;
    return a.platform.localeCompare(b.platform);
  });
}

// ── Provider overview (dashboard) ───────────────────────────────────────────
// getQuotaForecast() is a WARNING feed: it drops any pool without a numeric
// limit, because you cannot warn on a number you do not have. Driving a
// provider-overview panel from it made every provider except Groq disappear —
// Groq is the only one that reports a parseable limit — which reads as "you
// have one provider" rather than "we have numbers for one provider".
//
// This returns a row for every platform with an enabled key, whether or not we
// know anything about its quota, so an unmeasured provider is visibly unknown
// instead of absent.

export interface ProviderQuotaOverviewRow {
  platform: string;
  /** Null when we have no pool identity for this platform yet. */
  pool: string | null;
  used: number | null;
  remaining: number | null;
  limit: number | null;
  remaining_pct: number | null;
  reset_at: string | null;
  seconds_until_reset: number | null;
  low_balance: boolean;
  /** Where the numbers came from: 'header', 'error_body', 'probe', or null when
   *  nothing has ever been observed for this platform. */
  source: string | null;
  confidence: number | null;
  /** False when the provider has never reported a usable limit. The panel shows
   *  these as Unknown rather than implying a healthy pool. */
  metered: boolean;
  /** Who counted the consumption. 'provider' = its own remaining figure.
   *  'local' = we hold a declared limit and counted our own requests against
   *  it, which is an estimate and must not be presented as confirmed. */
  usedSource: 'provider' | 'local' | null;
  /**
   * What the numbers COUNT. Without it a credit balance and a request
   * allowance sit in the same column looking identical: OpenRouter's
   * openrouter::credits reads 1200 (cents of balance) beside a 1000/day
   * free-model request cap, and nothing on the row says they answer different
   * questions.
   */
  metric: string | null;
  /**
   * The routed models that draw on this pool, display names, alphabetical.
   *
   * The panel showed `ollama::weekly 540/10000` and never said which models
   * spend it, which is the one thing a reader needs to act: a pool at 5% is a
   * different problem depending on whether one overflow route or four chain
   * heads are behind it. It is also where a shared allowance stops looking like
   * depth — three NVIDIA models on `nvidia::credit-pool` render as three names
   * on ONE row, which is exactly what they are.
   *
   * Only ENABLED chain members, because a catalogue model nobody routes to
   * cannot drain anything. Empty for a pool no routed model resolves to.
   */
  members: string[];
  /** True when used/limit are the SUM of this pool's members rather than one
   *  account-wide ceiling. Only correct where each member holds its own
   *  allowance; summing a genuinely shared pool would multiply it. */
  aggregated?: boolean;
  /** The same models as `members`, by id. A label cannot be joined to usage
   *  data, and the expansion under a pool row needs to find each model's
   *  counters. Same order, so the two lists line up. */
  memberModelIds: string[];
  /** Denomination of the numbers: 'cents', 'per_10k', or null for a count. */
  unit: string | null;
  /**
   * What the allowance actually holds, for a pool the provider only reports as
   * a fraction. Derived by dividing our own measured usage by the fraction it
   * consumed, so the 'limit' column has something real to show instead of the
   * synthetic 100%. Null until three usable intervals exist.
   */
  derivedAllowance: InferredAllowance | null;
  /**
   * Where `seconds_until_reset` came from. 'provider' is a reset the provider
   * sent; 'inferred' is predicted from observed reset boundaries, which is the
   * only countdown available for a pool whose 429 carries no reset time and
   * whose retry-after header is empty.
   */
  resetSource: 'provider' | 'inferred' | null;
  /** What behaviour suggests, for providers that publish nothing. Empty when
   *  there is no evidence, or when the provider reports its own numbers and
   *  guessing would add nothing. Never merged into `limit`/`remaining` — an
   *  estimate of the window is not a measurement of the balance. */
  inferred: InferredWindowSummary[];
}

export interface InferredWindowSummary {
  period: string;
  method: string;
  samples: number;
  confidence: number;
  note: string;
}

export function getProviderQuotaOverview(now: number = Date.now()): ProviderQuotaOverviewRow[] {
  let db;
  try {
    db = getDb();
  } catch {
    return [];
  }

  const platforms = (db.prepare(
    'SELECT DISTINCT platform FROM api_keys WHERE enabled = 1 ORDER BY platform',
  ).all() as { platform: string }[]).map(r => r.platform);

  const measured = getQuotaForecast();
  const states = getQuotaStateForKeys();
  const rows: ProviderQuotaOverviewRow[] = [];

  for (const platform of platforms) {
    // 1. Pools the PROVIDER reported on. Its own remaining figure beats any
    //    local count, so these are taken as-is.
    const reported = measured.filter(m => m.platform === platform);
    const seenMeasured = new Set<string>(reported.map(r => r.pool ?? ''));
    for (const pool of reported) {
      const state = states.find(s => s.platform === platform && s.quotaPoolKey === pool.pool);
      rows.push({ ...pool, source: state?.source ?? null, confidence: state?.confidence ?? null, metered: true, usedSource: 'provider', inferred: [], members: [], memberModelIds: [], metric: 'requests', unit: null, derivedAllowance: null, resetSource: pool.reset_at ? 'provider' : null });
    }

    // 1b. Pools the provider measured in some OTHER unit — Ollama Cloud reports
    //     credit usage, not requests. The forecast deliberately keeps only
    //     request windows, because token resets vary too much between providers
    //     to predict; but a provider handing us limit AND remaining needs no
    //     prediction, and dropping it made a measured pool read "Unknown"
    //     beside estimates that read as facts.
    for (const state of states) {
      if (state.platform !== platform) continue;
      if (state.limit == null || state.remaining == null) continue;
      if (state.source !== 'quota_api' && state.source !== 'header') continue;
      if (seenMeasured.has(state.quotaPoolKey)) continue;
      seenMeasured.add(state.quotaPoolKey);
      const predicted = predictedResetFor(platform, state.quotaPoolKey, state.metric, now);
      const remainingPct = Math.max(0, Math.min(100, Math.round((state.remaining / state.limit) * 100)));
      rows.push({
        platform,
        pool: state.quotaPoolKey,
        used: Math.max(0, state.limit - state.remaining),
        remaining: state.remaining,
        limit: state.limit,
        remaining_pct: remainingPct,
        reset_at: state.resetAt ?? (predicted == null ? null : new Date(predicted).toISOString()),
        // A predicted countdown, when the provider sends none. Marked via
        // resetSource so it is never mistaken for the provider's own.
        seconds_until_reset: state.resetAt != null || predicted == null
          ? null
          : Math.max(0, Math.floor((predicted - now) / 1000)),
        low_balance: state.remaining / state.limit < LOW_BALANCE_THRESHOLD,
        source: state.source,
        confidence: state.confidence ?? null,
        metered: true,
        usedSource: 'provider',
        inferred: [],
        members: [], memberModelIds: [],
        metric: state.metric,
        unit: state.unit ?? null,
        derivedAllowance: state.unit === 'per_10k' ? allowanceFor(platform, state.quotaPoolKey, now) : null,
        resetSource: state.resetAt ? 'provider' : (predicted == null ? null : 'inferred'),
      });
    }

    // 2. Limits we KNOW but the provider never reports — an env cap, a catalog
    //    figure, an operator policy. Previously these read as Unknown despite
    //    the limit being in hand: nothing was counting local usage against it.
    //    Only request-metric axes; token windows are not reliably comparable
    //    to the request counters.
    const seenAxes = new Set(reported.map(r => r.pool));
    for (const quota of resolveEffectiveQuotas(platform, null, now)) {
      if (quota.metric !== 'requests') continue;
      if (quota.source === 'provider_header' || quota.source === 'provider_api') continue;
      const poolLabel = `${platform}::${quota.period.kind === 'rolling' ? `rolling-${Math.round(quota.period.windowMs / 1000)}s` : quota.period.kind}`;
      if (seenAxes.has(poolLabel)) continue;
      seenAxes.add(poolLabel);

      const windowMs = quota.window.periodStartMs == null
        ? (quota.period.kind === 'rolling' ? quota.period.windowMs : null)
        : Math.max(1, now - quota.window.periodStartMs);
      if (windowMs == null) continue;

      const used = countPlatformUsageInWindow(platform, 'request', windowMs, now);
      const remaining = Math.max(0, quota.limit - used);
      const secondsUntilReset = quota.window.resetAtMs == null
        ? null
        : Math.max(0, Math.floor((quota.window.resetAtMs - now) / 1000));
      const remainingPct = Math.max(0, Math.min(100, Math.round((remaining / quota.limit) * 100)));

      rows.push({
        platform,
        members: [], memberModelIds: [],
        pool: poolLabel,
        used,
        remaining,
        limit: quota.limit,
        remaining_pct: remainingPct,
        reset_at: quota.window.resetAtMs == null ? null : new Date(quota.window.resetAtMs).toISOString(),
        seconds_until_reset: secondsUntilReset,
        low_balance: remaining / quota.limit < LOW_BALANCE_THRESHOLD,
        source: quota.source,
        confidence: quota.confidence,
        metered: true,
        // The limit is declared; the consumption is ours. Marked so the panel
        // never implies the provider confirmed this number.
        usedSource: 'local',
        inferred: [],
        metric: quota.metric,
        unit: null,
        derivedAllowance: null,
        resetSource: quota.window.resetAtMs == null ? null : 'provider',
      });
    }

    // 3. Nothing measurable at all. Report the strongest observation we have,
    //    so the row says "we called it and learned nothing" instead of vanishing.
    if (!rows.some(r => r.platform === platform)) {
      const seen = states.filter(s => s.platform === platform);
      const best = seen.find(s => s.source === 'header') ?? seen.find(s => s.source === 'error_body') ?? seen[0];
      rows.push({
        platform,
        pool: best?.quotaPoolKey ?? null,
        used: null, remaining: null, limit: null, remaining_pct: null,
        reset_at: null, seconds_until_reset: null, low_balance: false,
        source: best?.source ?? null,
        confidence: best?.confidence ?? null,
        metered: false,
        usedSource: null,
        inferred: [],
        members: [], memberModelIds: [],
        metric: null,
        unit: null,
        derivedAllowance: null,
        resetSource: null,
      });
    }
  }

  // Behavioural inference, only where it adds something. A provider reporting
  // its own remaining figure needs no estimate, and running this for every
  // platform would scan the request history on every dashboard poll.
  for (const row of rows) {
    if (row.metered && row.usedSource === 'provider') continue;
    row.inferred = inferredWindowsFor(row.platform, now).map(w => ({
      period: w.period,
      method: w.method,
      samples: w.samples,
      confidence: w.confidence,
      note: w.note,
    }));
  }

  // Who actually spends each pool. One query for the whole panel, then a map
  // lookup per row — resolveQuotaPolicy is pure, so this is the same answer the
  // router reaches at request time rather than a second guess at it.
  // Pools that a later split retired. `groq::account` and `google::project`
  // predate the move to per-model identities: every observation under them
  // carries a model id and the SAME limits the per-model rows now report, and
  // nothing has written to them since the cutover. Listing them beside the live
  // rows invents an account-wide cap that does not exist — and the platform-wide
  // membership fallback then attributed every routed model to it, which is
  // exactly how a phantom pool comes to look like a real shared ceiling.
  //
  // Superseded only where the replacement has actually been observed:
  // `legacyPoolKey` is still the deliberate read-compat path for an install that
  // has not yet recorded a per-model row, and dropping the legacy row there
  // would hide the only figure in hand.
  const superseded = new Set<string>();
  for (const state of states) {
    const legacy = legacyPoolKey(state.platform as Platform, state.quotaPoolKey);
    if (legacy) superseded.add(`${state.platform}\u0000${legacy}`);
  }
  const liveRows = rows.filter(r => r.pool == null || !superseded.has(`${r.platform}\u0000${r.pool}`));
  rows.length = 0;
  rows.push(...liveRows);

  const { byPool, byPlatform } = routedMembers();
  for (const row of rows) {
    // Two kinds of row, two correct answers.
    //
    // A provider-reported row names a real quota pool (`groq::model::<id>`,
    // `ollama::weekly`), so its members are the models that resolve to exactly
    // that pool — which is how a per-model allowance stays on its own row.
    //
    // A locally-limited row names a WINDOW, not a pool: `nvidia::calendar_day`,
    // `nvidia::rolling-60s`. Those axes are account-scoped by construction —
    // an env RPM cap or an operator's provider-wide daily limit — so every
    // routed model on the platform spends them, and platform-wide is the
    // truthful membership rather than the empty set string matching produces.
    const members = row.pool == null
      ? []
      : (byPool.get(row.pool) ?? platformMembersFor(row.pool, byPlatform.get(row.platform) ?? []));
    row.members = members.map(m => m.displayName);
    row.memberModelIds = members.map(m => m.modelId);
  }

  aggregateMemberLimits(rows, now);
  addMemberSumRows(rows, now);

  // Measured pools first, then unknowns — the rows a reader can act on lead.
  return rows.sort((a, b) => (Number(b.metered) - Number(a.metered)) || a.platform.localeCompare(b.platform));
}

/**
 * Narrow the platform-wide fallback to the models that can actually spend a
 * given axis.
 *
 * One pool needs it. `openrouter::credits` is the operator's paid balance, and
 * OpenRouter serves free and paid capacity through the SAME credential — so
 * falling back to "every routed OpenRouter model" listed six `:free` routes as
 * spenders of a $12 balance that none of them can touch. That is the identical
 * free/paid conflation the admission gate had to be fixed for twice, and
 * `consumesPaidBalance` is the predicate that already answers it.
 *
 * Deliberately keyed on `::credits` and nothing else. Ollama's weekly balance
 * is also denominated in credits but has no free/paid split — every Ollama
 * model spends it — so a broader rule would have emptied the very row that
 * motivated showing membership at all.
 */
function platformMembersFor(pool: string, platformMembers: readonly PlatformMember[]): PlatformMember[] {
  // Identity kept rather than flattened to a label: the caller needs both the
  // name to show and the id to join usage against.
  return pool.endsWith('::credits')
    ? platformMembers.filter(m => consumesPaidBalance(m.platform as Platform, m.modelId))
    : [...platformMembers];
}

interface PlatformMember { platform: string; modelId: string; displayName: string }

/**
 * Routed models grouped by the quota pool they draw on.
 *
 * Enabled chain members only. `resolveQuotaPolicy` is the same pure function
 * the router uses to pick a pool, so the grouping cannot disagree with the
 * accounting — deriving it from the pool-key STRING instead would break the
 * first time a provider's identity changes shape, which has already happened
 * once (Groq moved from `groq::account` to `groq::model::<id>`).
 */
/**
 * Replace an account-window row with the sum of its members, where the members
 * are what actually hold the allowance.
 *
 * Google is the case that forces it. `google::calendar_day` reads 45/day from a
 * learned 429, while its seven routed models each carry their OWN measured
 * daily limit — 20 for Flash, 500 for Flash-Lite — totalling 2,580. The pool
 * row understated the account by fiftyfold and no member of it was ever bound
 * by 45.
 *
 * The guard is the whole design: this only applies when EVERY member resolves
 * its own model-scoped limit for the same window. A genuinely shared pool —
 * NVIDIA's account-wide 40 RPM, OpenRouter's credit balance, Ollama's weekly
 * session — has no such per-member limits, so it is left exactly as it was.
 * Summing one of those would multiply an allowance the provider grants once,
 * which is the error this file warns about everywhere else.
 */
function aggregateMemberLimits(rows: ProviderQuotaOverviewRow[], now: number): void {
  for (const row of rows) {
    if (row.metric !== 'requests' || row.pool == null || row.memberModelIds.length === 0) continue;

    const isDay = row.pool.endsWith('::calendar_day') || row.pool.endsWith('::rolling-86400s');
    const isMinute = row.pool.endsWith('::rolling-60s');
    if (!isDay && !isMinute) continue;

    // Independence is the question, and the pool key already answers it. Two
    // models that resolve to the SAME quota pool spend one counter, so their
    // allowances are the same allowance counted twice. NVIDIA is the trap: each
    // of its models carries a 40 RPM catalogue column, but all six resolve to
    // `nvidia::credit-pool` and the account grants 40 once — summing produced
    // 240 RPM that does not exist.
    const poolKeys = new Set(row.memberModelIds.map(
      modelId => resolveQuotaPolicy(row.platform as Platform, modelId).poolKey));
    if (poolKeys.size !== row.memberModelIds.length) continue;

    const windowMs = isDay ? DAY_MS : MINUTE_MS;
    let limit = 0;
    let used = 0;
    let soonestReset: number | null = null;
    let everyMemberHasOwn = true;

    for (const modelId of row.memberModelIds) {
      const windows = effectiveRouteWindows(row.platform, modelId, now);
      const quota = isDay ? windows.rpd : windows.rpm;
      // One member without its own allowance means the account ceiling is
      // still the binding constraint for it, and the sum would be a fiction.
      if (!quota) { everyMemberHasOwn = false; break; }
      limit += quota.limit;
      used += countRequestsInWindow(row.platform, modelId, windowMs, now);
      const reset = quota.window.resetAtMs;
      if (reset != null) soonestReset = soonestReset == null ? reset : Math.min(soonestReset, reset);
    }
    if (!everyMemberHasOwn) continue;

    const remaining = Math.max(0, limit - used);
    row.used = used;
    row.limit = limit;
    row.remaining = remaining;
    row.remaining_pct = limit > 0 ? Math.max(0, Math.min(100, Math.round((remaining / limit) * 100))) : null;
    row.low_balance = limit > 0 && remaining / limit < LOW_BALANCE_THRESHOLD;
    row.aggregated = true;
    row.usedSource = 'local';
    if (soonestReset != null) {
      row.reset_at = new Date(soonestReset).toISOString();
      row.seconds_until_reset = Math.max(0, Math.floor((soonestReset - now) / 1000));
    }
  }
}

/**
 * A provider row built FROM its models, where the account itself declares
 * nothing.
 *
 * Google is the case. It publishes no account quota — no headers, no documented
 * figure — so the only account-level row this panel ever had came from a single
 * learned 429, and deleting that (it was wrong) removed the provider from the
 * overview altogether. Meanwhile every routed Google model carries a measured
 * daily limit on its own counter. Their sum IS the account allowance, and it is
 * the number an operator is looking for.
 *
 * Same independence guard as everywhere else: distinct pool keys, each with its
 * own limit. A shared pool synthesises nothing, because its account figure is
 * already the truth and summing it would invent capacity.
 */
function addMemberSumRows(rows: ProviderQuotaOverviewRow[], now: number): void {
  const { byPlatform } = routedMembers();

  for (const [platform, members] of byPlatform) {
    if (members.length === 0) continue;
    // Something already speaks for this platform's day. Leave it: a provider
    // that reports its own ceiling outranks anything derived here.
    if (rows.some(r => r.platform === platform && r.metric === 'requests' && r.pool?.endsWith('::calendar_day'))) continue;
    // Or the provider already reports each model as its own pool — Groq sends a
    // header per `model::` pool. Those rows ARE these models; adding a total
    // beside them lists the same allowance twice.
    const covered = new Set(rows.filter(r => r.platform === platform).flatMap(r => r.memberModelIds));
    if (members.every(m => covered.has(m.modelId))) continue;

    const poolKeys = new Set(members.map(m => resolveQuotaPolicy(platform as Platform, m.modelId).poolKey));
    if (poolKeys.size !== members.length) continue;

    let limit = 0;
    let used = 0;
    let soonestReset: number | null = null;
    let complete = true;
    for (const member of members) {
      const quota = effectiveRouteWindows(platform, member.modelId, now).rpd;
      if (!quota) { complete = false; break; }
      limit += quota.limit;
      used += countRequestsInWindow(platform, member.modelId, DAY_MS, now);
      const reset = quota.window.resetAtMs;
      if (reset != null) soonestReset = soonestReset == null ? reset : Math.min(soonestReset, reset);
    }
    if (!complete || limit <= 0) continue;

    const remaining = Math.max(0, limit - used);
    rows.push({
      platform,
      pool: `${platform}::calendar_day`,
      used,
      remaining,
      limit,
      remaining_pct: Math.max(0, Math.min(100, Math.round((remaining / limit) * 100))),
      reset_at: soonestReset == null ? null : new Date(soonestReset).toISOString(),
      seconds_until_reset: soonestReset == null ? null : Math.max(0, Math.floor((soonestReset - now) / 1000)),
      low_balance: remaining / limit < LOW_BALANCE_THRESHOLD,
      // Every figure in it was measured per model; none was stated by the
      // account, and the row says so rather than implying the provider agreed.
      source: 'operator',
      confidence: 0.8,
      metered: true,
      usedSource: 'local',
      inferred: [],
      members: members.map(m => m.displayName),
      memberModelIds: members.map(m => m.modelId),
      aggregated: true,
      metric: 'requests',
      unit: null,
      derivedAllowance: null,
      resetSource: soonestReset == null ? null : 'provider',
    });
  }
}

function routedMembers(): { byPool: Map<string, PlatformMember[]>; byPlatform: Map<string, PlatformMember[]> } {
  const byPool = new Map<string, PlatformMember[]>();
  // Platform-wide members keep their identity, not just a label: narrowing a
  // credit pool needs the model id the predicate is written against.
  const byPlatform = new Map<string, PlatformMember[]>();
  try {
    const rows = getDb().prepare(`
      SELECT DISTINCT m.platform, m.model_id, m.display_name
        FROM profile_models pm
        JOIN models m ON m.id = pm.model_db_id
       WHERE pm.enabled = 1 AND m.enabled = 1
    `).all() as { platform: string; model_id: string; display_name: string }[];
    for (const row of rows) {
      const poolKey = resolveQuotaPolicy(row.platform as Platform, row.model_id).poolKey;
      const member: PlatformMember = { platform: row.platform, modelId: row.model_id, displayName: row.display_name };
      const pooled = byPool.get(poolKey);
      if (pooled) pooled.push(member);
      else byPool.set(poolKey, [member]);

      const platformed = byPlatform.get(row.platform);
      if (platformed) platformed.push(member);
      else byPlatform.set(row.platform, [member]);
    }
    for (const list of byPool.values()) list.sort((a, b) => a.displayName.localeCompare(b.displayName));
    for (const list of byPlatform.values()) list.sort((a, b) => a.displayName.localeCompare(b.displayName));
  } catch {
    // A panel annotation is never a reason the panel fails to render.
  }
  return { byPool, byPlatform };
}

/** Inference reads the whole request history for a platform, and the dashboard
 *  polls. A minute of staleness is invisible in an estimate whose own window is
 *  measured in factors. */
const INFERENCE_TTL_MS = 60_000;
const inferenceCache = new Map<string, { at: number; windows: InferredWindow[] }>();

function inferredWindowsFor(platform: string, now: number): InferredWindow[] {
  const hit = inferenceCache.get(platform);
  if (hit && now - hit.at < INFERENCE_TTL_MS) return hit.windows;
  let windows: InferredWindow[] = [];
  try {
    windows = inferQuotaShape(platform).windows;
  } catch {
    windows = [];
  }
  inferenceCache.set(platform, { at: now, windows });
  return windows;
}

/** Test seam: drop the memoised inferences. */
export function invalidateQuotaInference(): void {
  inferenceCache.clear();
}

/** Deriving an allowance walks the observation series and counts request rows,
 *  and the dashboard polls. A minute of staleness is invisible in a figure
 *  whose own error bar is tens of percent. */
const ALLOWANCE_TTL_MS = 60_000;
const allowanceCache = new Map<string, { at: number; value: InferredAllowance | null }>();

function allowanceFor(platform: string, quotaPoolKey: string, now: number): InferredAllowance | null {
  const cacheKey = `${platform}:${quotaPoolKey}`;
  const hit = allowanceCache.get(cacheKey);
  if (hit && now - hit.at < ALLOWANCE_TTL_MS) return hit.value;
  let value: InferredAllowance | null = null;
  try {
    const all = inferAllowanceFromFraction(platform, quotaPoolKey);
    // Dollars first: measured on real traffic, the token figure swung 4.9x
    // between traffic mixes while the priced one moved 1.3x, because dollars
    // are what the provider is metering. Tokens are the fallback for a mix we
    // cannot price.
    value = all.find(a => a.metric === 'credit_usd')
      ?? all.find(a => a.metric === 'total_tokens')
      ?? all[0] ?? null;
  } catch {
    value = null;
  }
  allowanceCache.set(cacheKey, { at: now, value });
  return value;
}

/** Test seam: drop the memoised allowance derivations. */
export function invalidateDerivedAllowances(): void {
  allowanceCache.clear();
}

/** The next reset predicted from observed boundaries, memoised like the rest —
 *  it walks an observation series and the dashboard polls. */
const RESET_TTL_MS = 60_000;
const predictedResetCache = new Map<string, { at: number; value: number | null }>();

function predictedResetFor(platform: string, quotaPoolKey: string, metric: string, now: number): number | null {
  const cacheKey = `${platform}:${quotaPoolKey}:${metric}`;
  const hit = predictedResetCache.get(cacheKey);
  if (hit && now - hit.at < RESET_TTL_MS) return hit.value;
  let value: number | null = null;
  try {
    value = inferWindowFromResets(platform, quotaPoolKey, metric)?.nextResetAtMs ?? null;
  } catch {
    value = null;
  }
  predictedResetCache.set(cacheKey, { at: now, value });
  return value;
}

/** Test seam: drop the memoised reset predictions. */
export function invalidatePredictedResets(): void {
  predictedResetCache.clear();
}
