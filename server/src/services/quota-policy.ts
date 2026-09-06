import { getDb } from '../db/index.js';
import type { Db } from '../db/types.js';
import { getLearnedCeiling } from './provider-quota.js';
import {
  getProviderDailyRequestCap,
  getProviderMinuteRequestCap,
  getProviderDailyTokenCap,
  countTokensInWindow,
} from './ratelimit.js';
import {
  resolveQuotaWindow,
  parseStoredUtc,
  DAY_MS,
  MINUTE_MS,
  type QuotaPeriod,
  type QuotaWindow,
} from './quota-clock.js';

// Effective quota policy resolution (ADR ARCH-20260905, W2 / F6).
//
// Four sources already claim to know a limit and none of them agreed:
//   - live provider headers      → provider_quota_state
//   - operator configuration     → quota_policy (this migration)
//   - the catalog                → models.rpm_limit / rpd_limit / tpm_limit / tpd_limit
//   - provider-wide env caps     → PROVIDER_*_CAP_<PLATFORM>
//
// This module is the single place that ranks them. Precedence follows the
// operator's Q2 condition: a measured provider reading always outranks a typed
// one, and an operator's typed limit outranks the shipped catalog default —
// they know their account, we shipped a guess.
//
// It answers a READ question and does not touch the hard gates. Consolidating
// enforcement onto these windows changes what gets rejected, live, on every
// model; that is deliberately sequenced after shadow mode so the effect is
// observed before it is felt.

export type QuotaPolicyScope = 'provider_account' | 'provider_key' | 'model' | 'shared_pool';
export type QuotaPolicyMetric = 'requests' | 'input_tokens' | 'output_tokens' | 'total_tokens' | 'credits';
export type QuotaPolicyPeriodKind = 'rolling' | 'calendar_day' | 'calendar_week' | 'calendar_month' | 'billing_cycle';
export type QuotaPolicySource = 'operator' | 'catalog' | 'documentation' | 'provider_api';

/** Where an effective limit came from, ordered by how much it should be
 *  trusted. `provider_header` is a measurement; everything below it is a
 *  declaration. */
export type EffectiveQuotaSource = 'provider_header' | 'operator' | 'documentation' | 'provider_api' | 'catalog' | 'provider_cap_env' | 'learned_429';
const SOURCE_RANK: Record<EffectiveQuotaSource, number> = {
  provider_header: 100,
  provider_api: 80,
  operator: 60,
  documentation: 40,
  catalog: 20,
  provider_cap_env: 10,
  // Lowest of all: a ceiling inferred from being refused is weaker than a
  // number anyone actually stated, including a shipped default.
  learned_429: 5,
};

export interface QuotaPolicy {
  id: number;
  platform: string;
  modelId: string | null;
  /** Null = every endpoint of this platform+model. For a relay, the platform is
   *  always 'custom', so this is what names the provider. */
  endpointScope: string | null;
  scope: QuotaPolicyScope;
  metric: QuotaPolicyMetric;
  limit: number;
  periodKind: QuotaPolicyPeriodKind;
  periodMs: number | null;
  timezone: string | null;
  anchorDay: number | null;
  priority: number;
  enabled: boolean;
  source: QuotaPolicySource;
  confidence: number;
  notes: string | null;
}

export type QuotaPolicyInput = Omit<QuotaPolicy, 'id' | 'enabled' | 'priority' | 'source' | 'confidence' | 'notes'>
  & Partial<Pick<QuotaPolicy, 'enabled' | 'priority' | 'source' | 'confidence' | 'notes'>>;

export interface EffectiveQuota {
  platform: string;
  /** Null when the limit belongs to the whole platform rather than one model. */
  modelId: string | null;
  endpointScope: string | null;
  metric: QuotaPolicyMetric;
  scope: QuotaPolicyScope;
  limit: number;
  /**
   * What the PROVIDER said is left, when it said anything. Only ever set from a
   * measured source. A provider-reported window has no period start, so there
   * is no span to count local usage over — without this the highest-confidence
   * source we have was silently skipped by every consumer that works from
   * "usage counted since period start".
   */
  reportedRemaining: number | null;
  /**
   * Consumption this policy worked out itself, because no single counter can
   * express it. Distinct from reportedRemaining, which is only ever what the
   * provider measured.
   *
   * Needed for a pool shared across models priced differently: Ollama Cloud
   * bills one dollar balance at per-model token rates, so tokens are not
   * additive across models — 1M nemotron-3-ultra tokens cost about eight times
   * 1M gpt-oss:20b tokens. Summing raw tokens would understate the spend and
   * summing per-model fractions is the only correct reduction.
   */
  derivedUsed: number | null;
  period: QuotaPeriod;
  window: QuotaWindow;
  source: EffectiveQuotaSource;
  confidence: number;
}

interface PolicyRow {
  id: number;
  platform: string;
  model_id: string | null;
  endpoint_scope: string | null;
  scope: QuotaPolicyScope;
  metric: QuotaPolicyMetric;
  limit_value: number;
  period_kind: QuotaPolicyPeriodKind;
  period_ms: number | null;
  timezone: string | null;
  anchor_day: number | null;
  priority: number;
  enabled: number;
  source: QuotaPolicySource;
  confidence: number;
  notes: string | null;
}

function toPolicy(row: PolicyRow): QuotaPolicy {
  return {
    id: row.id,
    platform: row.platform,
    modelId: row.model_id,
    endpointScope: row.endpoint_scope,
    scope: row.scope,
    metric: row.metric,
    limit: row.limit_value,
    periodKind: row.period_kind,
    periodMs: row.period_ms,
    timezone: row.timezone,
    anchorDay: row.anchor_day,
    priority: row.priority,
    enabled: row.enabled === 1,
    source: row.source,
    confidence: row.confidence,
    notes: row.notes,
  };
}

/** The clock description a stored policy denotes. A calendar policy with no
 *  timezone means UTC — stated here rather than left to the clock's fallback,
 *  which exists for invalid input, not for absent input. */
export function periodForPolicy(policy: Pick<QuotaPolicy, 'periodKind' | 'periodMs' | 'timezone' | 'anchorDay'>): QuotaPeriod {
  const timezone = policy.timezone ?? 'UTC';
  switch (policy.periodKind) {
    case 'rolling':
      return { kind: 'rolling', windowMs: policy.periodMs ?? DAY_MS };
    case 'calendar_week':
      return { kind: 'calendar_week', timezone };
    case 'calendar_month':
      return { kind: 'calendar_month', timezone };
    case 'billing_cycle':
      return { kind: 'billing_cycle', timezone, anchorDay: policy.anchorDay ?? 1 };
    case 'calendar_day':
    default:
      return { kind: 'calendar_day', timezone };
  }
}

// Policies change when an operator edits them — which is to say, almost never
// relative to request rate. The shadow evaluator reads them once per candidate
// per routed request, so an uncached read turns one routing decision into a
// query per provider. Same short-TTL discipline as getKeyQuotaHeadroom, and
// writes bust it outright so an API edit is visible immediately.
const POLICY_CACHE_TTL_MS = 5_000;
const policyCache = new Map<string, { db: unknown; at: number; rows: QuotaPolicy[] }>();

/** Drop the memoised policies for one platform, or all of them. */
export function invalidateQuotaPolicyCache(platform?: string): void {
  if (platform) {
    policyCache.delete(platform);
    policyCache.delete('*');
  } else {
    policyCache.clear();
  }
}

export function listQuotaPolicies(platform?: string): QuotaPolicy[] {
  let db: Db;
  try {
    db = getDb();
  } catch {
    return [];
  }
  // The Db handle is part of the cache identity: reconnecting (tests, a
  // restore) hands back a different object and invalidates every entry.
  const cacheKey = platform ?? '*';
  const hit = policyCache.get(cacheKey);
  const now = Date.now();
  if (hit && hit.db === db && now - hit.at < POLICY_CACHE_TTL_MS) return hit.rows;

  const rows = platform
    ? db.prepare('SELECT * FROM quota_policy WHERE platform = ? ORDER BY platform, IFNULL(model_id, \'\'), metric').all(platform)
    : db.prepare('SELECT * FROM quota_policy ORDER BY platform, IFNULL(model_id, \'\'), metric').all();
  const policies = (rows as PolicyRow[]).map(toPolicy);
  policyCache.set(cacheKey, { db, at: now, rows: policies });
  return policies;
}

/**
 * Create or replace the policy for one subject+metric. Upsert rather than
 * insert because the unique index defines a subject as
 * (platform, model_id, scope, metric) — an operator editing OpenRouter's daily
 * allowance means to change that number, not to accumulate a second opinion.
 */
export function upsertQuotaPolicy(input: QuotaPolicyInput): QuotaPolicy {
  const db = getDb();
  db.prepare(`
    INSERT INTO quota_policy (
      platform, model_id, endpoint_scope, scope, metric, limit_value, period_kind, period_ms,
      timezone, anchor_day, priority, enabled, source, confidence, notes, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
    ON CONFLICT(platform, IFNULL(model_id, ''), IFNULL(endpoint_scope, ''), scope, metric) DO UPDATE SET
      limit_value = excluded.limit_value,
      period_kind = excluded.period_kind,
      period_ms   = excluded.period_ms,
      timezone    = excluded.timezone,
      anchor_day  = excluded.anchor_day,
      priority    = excluded.priority,
      enabled     = excluded.enabled,
      source      = excluded.source,
      confidence  = excluded.confidence,
      notes       = excluded.notes,
      updated_at  = datetime('now')
  `).run(
    input.platform, input.modelId, input.endpointScope ?? null, input.scope, input.metric, input.limit,
    input.periodKind, input.periodMs, input.timezone, input.anchorDay,
    input.priority ?? 0, input.enabled === false ? 0 : 1,
    input.source ?? 'operator', input.confidence ?? 0.8, input.notes ?? null,
  );
  const row = db.prepare(`
    SELECT * FROM quota_policy
     WHERE platform = ? AND IFNULL(model_id, '') = IFNULL(?, '')
       AND IFNULL(endpoint_scope, '') = IFNULL(?, '') AND scope = ? AND metric = ?
  `).get(input.platform, input.modelId, input.endpointScope ?? null, input.scope, input.metric) as PolicyRow;
  invalidateQuotaPolicyCache(input.platform);
  return toPolicy(row);
}

export function deleteQuotaPolicy(id: number): boolean {
  const db = getDb();
  const info = db.prepare('DELETE FROM quota_policy WHERE id = ?').run(id);
  invalidateQuotaPolicyCache();
  return Number(info.changes) > 0;
}

/** Key an effective quota by what it actually constrains: the same metric over
 *  a different period is a different limit, and both bind at once. */
function axisKey(metric: QuotaPolicyMetric, period: QuotaPeriod): string {
  return period.kind === 'rolling'
    ? `${metric}:rolling:${period.windowMs}`
    : `${metric}:${period.kind}`;
}

function considerCandidate(
  best: Map<string, EffectiveQuota>,
  candidate: EffectiveQuota,
): void {
  const key = axisKey(candidate.metric, candidate.period);
  const held = best.get(key);
  // Strictly greater: the first source to claim an axis at a given rank keeps
  // it, so iteration order within a rank is not load-bearing.
  if (held && SOURCE_RANK[held.source] >= SOURCE_RANK[candidate.source]) return;
  best.set(key, candidate);
}

interface ModelLimitRow {
  rpm_limit: number | null;
  rpd_limit: number | null;
  tpm_limit: number | null;
  tpd_limit: number | null;
  monthly_token_budget: string | null;
}

interface ObservationRow {
  metric: string;
  limit_value: number | null;
  remaining_value: number | null;
  reset_at: string | null;
  confidence: number;
}

/** How narrowly a policy names its subject. Higher wins when two policies
 *  claim the same axis: an endpoint-specific limit is a statement about one
 *  relay, a platform-wide one is a fallback for everything else. */
function policySpecificity(policy: QuotaPolicy): number {
  return (policy.endpointScope != null ? 2 : 0) + (policy.modelId != null ? 1 : 0);
}

/**
 * Every limit that currently binds `(platform, modelId, endpointScope)`, one
 * per axis, each from the most trustworthy source that has an opinion about it.
 *
 * A model is metered on several axes at once — the existing gates check RPM,
 * RPD, TPM and TPD independently — so this returns a list, not a single number.
 * Collapsing them to "the limit" is what makes a dashboard say 999/1000 while
 * the request is actually being rejected on tokens-per-minute.
 */
/**
 * The LOW end of a documented token range, in tokens.
 *
 * `models.monthly_token_budget` is prose, not data: real values are '~10-20M',
 * '~5-10M', 'unlimited'. profiles.ts reads the same column for ranking and
 * takes the MAX of the range, which is right for "which model is roomiest" and
 * wrong for a ceiling - claiming 20M when the allowance might be 10M would
 * report headroom that does not exist and spend past the real limit.
 *
 * So: the minimum, treated as "at least this much", carried at low confidence
 * because a range is not a measurement. 'unlimited' yields null rather than
 * Infinity - an unbounded limit makes headroom meaningless (always 100%), which
 * is worse than having no opinion.
 */
const POOL_TTL_MS = 5_000;
const poolFractionCache = new Map<string, { at: number; fraction: number | null }>();

/**
 * How much of a platform's shared credit pool has been spent, as a fraction.
 *
 * Each model's documented budget answers "how many tokens of THIS model would
 * the whole pool buy". So spending t tokens on model k consumes t/budget_k of
 * the pool, and the pool's total consumption is the sum of those fractions.
 * That reduction is what makes tokens comparable across models the provider
 * prices differently.
 *
 * Without it every model reports its own budget independently: spend the entire
 * pool on one model and the other five still read full.
 */
function sharedPoolFractionUsed(platform: string, windowMs: number, now: number): number | null {
  const cacheKey = `${platform}:${windowMs}`;
  const hit = poolFractionCache.get(cacheKey);
  if (hit && now - hit.at < POOL_TTL_MS) return hit.fraction;

  let fraction: number | null = null;
  try {
    const siblings = getDb().prepare(
      "SELECT model_id, monthly_token_budget FROM models WHERE platform = ? AND enabled = 1",
    ).all(platform) as { model_id: string; monthly_token_budget: string | null }[];
    let total = 0;
    let counted = 0;
    for (const sibling of siblings) {
      const budget = conservativeMonthlyBudget(sibling.monthly_token_budget);
      if (budget == null) continue;
      counted++;
      total += countTokensInWindow(platform, sibling.model_id, windowMs, now) / budget;
    }
    // One model with a budget is not a pool worth modelling — the per-model
    // quota already says the same thing.
    fraction = counted >= 2 ? Math.min(1, total) : null;
  } catch {
    fraction = null;
  }
  poolFractionCache.set(cacheKey, { at: now, fraction });
  return fraction;
}

/** Test seam: drop the memoised pool fractions. */
export function invalidateSharedPoolCache(): void {
  poolFractionCache.clear();
}

export function conservativeMonthlyBudget(raw: string | null | undefined): number | null {
  if (!raw) return null;
  const text = raw.split('(')[0]!;
  if (/unlimited|∞/i.test(text)) return null;
  const numbers = text.match(/[\d.]+/g);
  if (!numbers) return null;
  const low = Math.min(...numbers.map(Number).filter(n => Number.isFinite(n) && n > 0));
  if (!Number.isFinite(low)) return null;
  const upper = text.toUpperCase();
  const multiplier = upper.includes('B') ? 1_000_000_000
    : upper.includes('M') ? 1_000_000
    : upper.includes('K') ? 1_000
    : 1;
  const tokens = Math.floor(low * multiplier);
  return tokens > 0 ? tokens : null;
}

export function resolveEffectiveQuotas(
  platform: string,
  modelId: string | null,
  now: number = Date.now(),
  endpointScope: string | null = null,
): EffectiveQuota[] {
  let db: Db;
  try {
    db = getDb();
  } catch {
    return [];
  }

  const best = new Map<string, EffectiveQuota>();
  const add = (
    metric: QuotaPolicyMetric,
    scope: QuotaPolicyScope,
    limit: number,
    period: QuotaPeriod,
    source: EffectiveQuotaSource,
    confidence: number,
    subjectModelId: string | null,
    reportedRemaining: number | null = null,
    derivedUsed: number | null = null,
  ): void => {
    if (!Number.isFinite(limit) || limit <= 0) return;
    considerCandidate(best, {
      platform, modelId: subjectModelId, endpointScope, metric, scope, limit, reportedRemaining,
      derivedUsed,
      period, window: resolveQuotaWindow(period, now), source, confidence,
    });
  };

  // ── 4. Provider-wide env caps (weakest: a shipped default or an env var) ──
  // Daily caps are counted from UTC midnight by the existing gates, so they are
  // described that way here rather than as a rolling day.
  const dailyRequests = getProviderDailyRequestCap(platform);
  if (dailyRequests != null) {
    add('requests', 'provider_account', dailyRequests, { kind: 'calendar_day', timezone: 'UTC' }, 'provider_cap_env', 0.5, null);
  }
  const minuteRequests = getProviderMinuteRequestCap(platform);
  if (minuteRequests != null) {
    add('requests', 'provider_account', minuteRequests, { kind: 'rolling', windowMs: MINUTE_MS }, 'provider_cap_env', 0.5, null);
  }
  const dailyTokens = getProviderDailyTokenCap(platform);
  if (dailyTokens != null) {
    add('total_tokens', 'provider_account', dailyTokens, { kind: 'calendar_day', timezone: 'UTC' }, 'provider_cap_env', 0.5, null);
  }

  // ── 5. Learned ceiling (weakest: inferred from a refusal, never stated) ──
  const learned = getLearnedCeiling(platform as never);
  if (learned) {
    add('requests', 'provider_account', learned.limit, { kind: 'calendar_day', timezone: 'UTC' }, 'learned_429', 0.3, null);
  }

  // ── 3. Catalog limits (per model, rolling — the semantics the gates use) ──
  if (modelId) {
    const row = db.prepare(
      'SELECT rpm_limit, tpm_limit, rpd_limit, tpd_limit, monthly_token_budget FROM models WHERE platform = ? AND model_id = ? LIMIT 1',
    ).get(platform, modelId) as ModelLimitRow | undefined;
    if (row) {
      if (row.rpm_limit != null) add('requests', 'model', row.rpm_limit, { kind: 'rolling', windowMs: MINUTE_MS }, 'catalog', 0.4, modelId);
      if (row.rpd_limit != null) add('requests', 'model', row.rpd_limit, { kind: 'rolling', windowMs: DAY_MS }, 'catalog', 0.4, modelId);
      if (row.tpm_limit != null) add('total_tokens', 'model', row.tpm_limit, { kind: 'rolling', windowMs: MINUTE_MS }, 'catalog', 0.4, modelId);
      // A documented monthly pool, e.g. Ollama Cloud's '~10-20M'. Without this
      // such a provider has no numeric quota at all, so scoring pins it at
      // UNKNOWN_HEADROOM forever - it can never be seen filling up, which for a
      // monthly pool is the one thing worth knowing.
      const monthly = conservativeMonthlyBudget(row.monthly_token_budget);
      if (monthly != null) {
        const period: QuotaPeriod = { kind: 'calendar_month', timezone: 'UTC' };
        // Consumption is the POOL's, not this model's. Ollama Cloud bills one
        // dollar balance, so the catalogue's per-model budgets are several
        // descriptions of a single allowance: spend it all on one model and the
        // rest would otherwise still read full. Expressed in this model's own
        // tokens so limit and used stay in the same unit.
        const window = resolveQuotaWindow(period, now);
        const spent = window.periodStartMs == null
          ? null
          : sharedPoolFractionUsed(platform, Math.max(1, now - window.periodStartMs), now);
        add('total_tokens', 'model', monthly, period, 'catalog', 0.25, modelId, null,
          spent == null ? null : Math.round(spent * monthly));
      }
      if (row.tpd_limit != null) add('total_tokens', 'model', row.tpd_limit, { kind: 'rolling', windowMs: DAY_MS }, 'catalog', 0.4, modelId);
    }
  }

  // ── 2. Operator policy, most specific first ────────────────────────────────
  // All operator policies share one source rank, and considerCandidate only
  // replaces on a STRICTLY better rank — so on an axis claimed twice the FIRST
  // one wins. Sorting most-specific-first is therefore what makes a
  // per-endpoint policy beat a per-model one, and that beat a platform-wide one.
  const applicable = listQuotaPolicies(platform)
    .filter(policy => policy.enabled)
    .filter(policy => policy.modelId == null || policy.modelId === modelId)
    // A policy naming an endpoint applies only to that endpoint. One naming
    // none applies to all of them, which is what every pre-existing row means.
    .filter(policy => policy.endpointScope == null || policy.endpointScope === endpointScope)
    // Specificity first, then `priority` descending. The tie is real, not
    // theoretical: axisKey is (metric, period), so two policies differing only
    // by `scope` claim the same axis at equal specificity — and without a
    // tiebreak the winner would be whatever order SQLite happened to return.
    .sort((a, b) => policySpecificity(b) - policySpecificity(a) || b.priority - a.priority);
  for (const policy of applicable) {
    add(
      policy.metric, policy.scope, policy.limit, periodForPolicy(policy),
      policy.source === 'catalog' ? 'catalog' : policy.source, policy.confidence, policy.modelId,
    );
  }

  // ── 1. Live provider headers (a measurement, so it outranks every claim) ──
  // The observation carries the provider's own reset instant; that beats any
  // period we could model, so it is expressed as a provider_reported window.
  const observations = db.prepare(`
    SELECT metric, limit_value, remaining_value, reset_at, confidence
      FROM provider_quota_state
     WHERE platform = ? AND limit_value IS NOT NULL AND source IN ('header', 'quota_api')
  `).all(platform) as ObservationRow[];
  for (const obs of observations) {
    if (obs.limit_value == null) continue;
    // 'credits' is its own axis: a provider metering dollars of usage is not
    // counting requests, and collapsing it to 'requests' would put an opaque
    // allowance in competition with a real request limit.
    const metric: QuotaPolicyMetric = obs.metric === 'tokens' ? 'total_tokens'
      : obs.metric === 'credits' ? 'credits'
      : 'requests';
    // Same zone-less-UTC trap as the forecast: Date.parse would read this as
    // local time and shift every provider-reported reset by the host offset.
    const resetMs = parseStoredUtc(obs.reset_at) ?? NaN;
    // Without a reset the provider has told us a size but not a window. Inherit
    // the period from whatever already claims this METRIC, whichever period
    // that is — looking only for a rolling-day axis missed an operator policy
    // written as calendar_day, and the two then coexisted as separate axes.
    const sameMetric = [...best.values()].find(q => q.metric === metric);
    const period: QuotaPeriod = Number.isFinite(resetMs)
      ? { kind: 'provider_reported', resetAtMs: resetMs }
      : (sameMetric?.period ?? { kind: 'rolling', windowMs: DAY_MS });
    add(metric, 'provider_account', obs.limit_value, period, 'provider_header', obs.confidence, null, obs.remaining_value);
  }

  return [...best.values()];
}
