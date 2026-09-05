import { getDb } from '../db/index.js';
import type { Db } from '../db/types.js';
import {
  getProviderDailyRequestCap,
  getProviderMinuteRequestCap,
  getProviderDailyTokenCap,
} from './ratelimit.js';
import {
  resolveQuotaWindow,
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
export type EffectiveQuotaSource = 'provider_header' | 'operator' | 'documentation' | 'provider_api' | 'catalog' | 'provider_cap_env';

const SOURCE_RANK: Record<EffectiveQuotaSource, number> = {
  provider_header: 100,
  provider_api: 80,
  operator: 60,
  documentation: 40,
  catalog: 20,
  provider_cap_env: 10,
};

export interface QuotaPolicy {
  id: number;
  platform: string;
  modelId: string | null;
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
  metric: QuotaPolicyMetric;
  scope: QuotaPolicyScope;
  limit: number;
  period: QuotaPeriod;
  window: QuotaWindow;
  source: EffectiveQuotaSource;
  confidence: number;
}

interface PolicyRow {
  id: number;
  platform: string;
  model_id: string | null;
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

export function listQuotaPolicies(platform?: string): QuotaPolicy[] {
  let db: Db;
  try {
    db = getDb();
  } catch {
    return [];
  }
  const rows = platform
    ? db.prepare('SELECT * FROM quota_policy WHERE platform = ? ORDER BY platform, IFNULL(model_id, \'\'), metric').all(platform)
    : db.prepare('SELECT * FROM quota_policy ORDER BY platform, IFNULL(model_id, \'\'), metric').all();
  return (rows as PolicyRow[]).map(toPolicy);
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
      platform, model_id, scope, metric, limit_value, period_kind, period_ms,
      timezone, anchor_day, priority, enabled, source, confidence, notes, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
    ON CONFLICT(platform, IFNULL(model_id, ''), scope, metric) DO UPDATE SET
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
    input.platform, input.modelId, input.scope, input.metric, input.limit,
    input.periodKind, input.periodMs, input.timezone, input.anchorDay,
    input.priority ?? 0, input.enabled === false ? 0 : 1,
    input.source ?? 'operator', input.confidence ?? 0.8, input.notes ?? null,
  );
  const row = db.prepare(`
    SELECT * FROM quota_policy
     WHERE platform = ? AND IFNULL(model_id, '') = IFNULL(?, '') AND scope = ? AND metric = ?
  `).get(input.platform, input.modelId, input.scope, input.metric) as PolicyRow;
  return toPolicy(row);
}

export function deleteQuotaPolicy(id: number): boolean {
  const db = getDb();
  const info = db.prepare('DELETE FROM quota_policy WHERE id = ?').run(id);
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
}

interface ObservationRow {
  metric: string;
  limit_value: number | null;
  reset_at: string | null;
  confidence: number;
}

/**
 * Every limit that currently binds `(platform, modelId)`, one per axis, each
 * from the most trustworthy source that has an opinion about it.
 *
 * A model is metered on several axes at once — the existing gates check RPM,
 * RPD, TPM and TPD independently — so this returns a list, not a single number.
 * Collapsing them to "the limit" is what makes a dashboard say 999/1000 while
 * the request is actually being rejected on tokens-per-minute.
 */
export function resolveEffectiveQuotas(
  platform: string,
  modelId: string | null,
  now: number = Date.now(),
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
  ): void => {
    if (!Number.isFinite(limit) || limit <= 0) return;
    considerCandidate(best, {
      platform, modelId: subjectModelId, metric, scope, limit,
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

  // ── 3. Catalog limits (per model, rolling — the semantics the gates use) ──
  if (modelId) {
    const row = db.prepare(
      'SELECT rpm_limit, tpm_limit, rpd_limit, tpd_limit FROM models WHERE platform = ? AND model_id = ? LIMIT 1',
    ).get(platform, modelId) as ModelLimitRow | undefined;
    if (row) {
      if (row.rpm_limit != null) add('requests', 'model', row.rpm_limit, { kind: 'rolling', windowMs: MINUTE_MS }, 'catalog', 0.4, modelId);
      if (row.rpd_limit != null) add('requests', 'model', row.rpd_limit, { kind: 'rolling', windowMs: DAY_MS }, 'catalog', 0.4, modelId);
      if (row.tpm_limit != null) add('total_tokens', 'model', row.tpm_limit, { kind: 'rolling', windowMs: MINUTE_MS }, 'catalog', 0.4, modelId);
      if (row.tpd_limit != null) add('total_tokens', 'model', row.tpd_limit, { kind: 'rolling', windowMs: DAY_MS }, 'catalog', 0.4, modelId);
    }
  }

  // ── 2. Operator policy (platform-wide first, then the per-model override) ──
  for (const policy of listQuotaPolicies(platform)) {
    if (!policy.enabled) continue;
    if (policy.modelId != null && policy.modelId !== modelId) continue;
    add(policy.metric, policy.scope, policy.limit, periodForPolicy(policy), policy.source === 'catalog' ? 'catalog' : policy.source, policy.confidence, policy.modelId);
  }

  // ── 1. Live provider headers (a measurement, so it outranks every claim) ──
  // The observation carries the provider's own reset instant; that beats any
  // period we could model, so it is expressed as a provider_reported window.
  const observations = db.prepare(`
    SELECT metric, limit_value, reset_at, confidence
      FROM provider_quota_state
     WHERE platform = ? AND limit_value IS NOT NULL AND source IN ('header', 'quota_api')
  `).all(platform) as ObservationRow[];
  for (const obs of observations) {
    if (obs.limit_value == null) continue;
    const metric: QuotaPolicyMetric = obs.metric === 'tokens' ? 'total_tokens' : 'requests';
    const resetMs = obs.reset_at ? Date.parse(obs.reset_at) : NaN;
    // Without a reset the provider has told us a size but not a window; keep
    // the number and inherit the period from whatever else claims this axis.
    const period: QuotaPeriod = Number.isFinite(resetMs)
      ? { kind: 'provider_reported', resetAtMs: resetMs }
      : (best.get(axisKey(metric, { kind: 'rolling', windowMs: DAY_MS }))?.period ?? { kind: 'rolling', windowMs: DAY_MS });
    add(metric, 'provider_account', obs.limit_value, period, 'provider_header', obs.confidence, null);
  }

  return [...best.values()];
}
