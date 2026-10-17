import { createHash, createSign } from 'node:crypto';
import { getDb } from '../db/index.js';
import { decrypt } from '../lib/crypto.js';
import { recordQuotaObservation, resolveQuotaPolicy } from './provider-quota.js';
import { resolveQuotaWindow } from './quota-clock.js';
import type { Scheduler } from '../lib/scheduler.js';
import type { Platform } from '@freellmapi/shared/types.js';
import { isExtensionEnabled } from './extension-state.js';
import {
  USAGE_CREDENTIAL_FIELDS,
  parseServiceAccount,
  readUsageCredential,
  recordUsageCredentialRead,
  type GoogleServiceAccount,
  type UsageCredentialFields,
  UsageCredentialError,
} from './usage-credentials.js';

// Reading quota from a provider's own usage API — the second-highest source of
// truth in the precedence order, above anything configured or documented and
// below only a header on the response we just made.
//
// Worth having because the alternative is estimating: several providers send
// no rate-limit headers at all, so without this their allowance is a guess.
// Endpoints were re-verified against each provider's docs and a live key on
// 2026-10-17; an endpoint that changes shape makes its reader return nothing
// rather than a wrong number, and the card goes stale instead of lying.

/** Scale for a provider that reports a fraction rather than a count. Ten
 *  thousand units keeps 0.01% of resolution through integer columns, which is
 *  finer than any provider's own reporting. */
const FRACTION_UNITS = 10_000;

interface UsageObservation {
  quotaPoolKey: string;
  /** What the integers count. Defaults to credits. */
  metric?: 'credits' | 'requests' | 'tokens';
  /** Whatever unit the provider counts in, already scaled to integers. */
  limit: number;
  remaining: number;
  /** Denomination of those integers, so a reader is displayable: 'cents' for a
   *  currency balance, 'per_10k' for a fraction of an unsized allowance, null
   *  for a plain count. */
  unit: 'cents' | 'per_10k' | null;
  /** When the allowance comes back, if the provider says or documents it. */
  resetAt?: string | null;
  /** Below 0.9 when part of the reading is documented rather than reported. */
  confidence?: number;
  notes: string;
}

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const cents = (dollars: number): number => Math.round(dollars * 100);

async function getJson(url: string, apiKey: string): Promise<unknown> {
  const res = await fetch(url, { headers: { Authorization: `Bearer ${apiKey}` }, signal: AbortSignal.timeout(15_000) });
  if (!res.ok) return null;
  return res.json().catch(() => null);
}

function field(body: unknown, ...path: string[]): unknown {
  let at: unknown = body;
  for (const p of path) {
    if (!at || typeof at !== 'object' || !(p in at)) return undefined;
    at = (at as Record<string, unknown>)[p];
  }
  return at;
}

/** The next instant at `hour`:00 UTC on `weekday` (0 = Sunday). */
export function nextWeeklyUtc(weekday: number, hour: number, now = Date.now()): string {
  const d = new Date(now);
  const target = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + ((weekday - d.getUTCDay() + 7) % 7), hour));
  if (target.getTime() <= now) target.setUTCDate(target.getUTCDate() + 7);
  return target.toISOString();
}

/** 00:00 UTC on the 1st of next month. */
export function nextMonthUtc(now = Date.now()): string {
  const d = new Date(now);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1)).toISOString();
}

/** The next 00:00 UTC. */
export function nextDayUtc(now = Date.now()): string {
  const d = new Date(now);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1)).toISOString();
}

/**
 * Ollama Cloud, `GET /api/balance` (docs.ollama.com/api/balance). Current
 * plans report the included monthly credit in dollars with its period; legacy
 * plans report `session`/`weekly` windows as a percentage left with their own
 * reset. The undocumented `/api/usage` `limits.*` fractions this used to read
 * were withdrawn around 2026-10-07: that endpoint now returns usage history
 * only, which is why the Ollama reading stopped updating.
 */
export function parseOllamaBalance(body: unknown): UsageObservation[] {
  const out: UsageObservation[] = [];
  const included = field(body, 'included');
  const balance = num(field(included, 'balance_usd'));
  const allowance = num(field(included, 'allowance_usd'));
  if (balance != null && allowance != null && allowance > 0) {
    const until = field(included, 'period', 'until');
    out.push({
      quotaPoolKey: 'ollama::monthly',
      limit: cents(allowance),
      remaining: Math.max(0, cents(balance)),
      unit: 'cents',
      resetAt: typeof until === 'string' ? until : null,
      notes: `ollama /api/balance included ${balance}/${allowance} USD`,
    });
  }
  for (const window of ['session', 'weekly']) {
    const pct = num(field(included, window, 'remaining_percent'));
    if (pct == null) continue;
    const resets = field(included, window, 'resets_at');
    out.push({
      quotaPoolKey: `ollama::${window}`,
      limit: FRACTION_UNITS,
      remaining: Math.round(Math.max(0, Math.min(100, pct)) / 100 * FRACTION_UNITS),
      unit: 'per_10k',
      resetAt: typeof resets === 'string' ? resets : null,
      notes: `ollama /api/balance included.${window}.remaining_percent=${pct}`,
    });
  }
  return out;
}

async function readOllamaUsage(apiKey: string): Promise<UsageObservation[]> {
  return parseOllamaBalance(await getJson('https://ollama.com/api/balance', apiKey));
}

/**
 * OpenRouter. `GET /api/v1/key` carries `free_model_daily_requests`
 * ({used, limit, remaining}) for the `:free` allowance, counted per UTC day —
 * the provider's own number, where the local count only sees this install.
 * `GET /api/v1/credits` adds the credit balance, in cents.
 */
export function parseOpenRouterKey(body: unknown, now = Date.now()): UsageObservation[] {
  const free = field(body, 'data', 'free_model_daily_requests');
  const limit = num(field(free, 'limit'));
  const remaining = num(field(free, 'remaining'));
  if (limit == null || remaining == null || limit <= 0) return [];
  return [{
    quotaPoolKey: 'openrouter::free',
    metric: 'requests',
    limit,
    remaining: Math.max(0, remaining),
    unit: null,
    resetAt: nextDayUtc(now),
    notes: `openrouter /api/v1/key free_model_daily_requests used=${num(field(free, 'used'))} is_free_tier=${field(body, 'data', 'is_free_tier')}`,
  }];
}

async function readOpenRouterUsage(apiKey: string): Promise<UsageObservation[]> {
  const out = parseOpenRouterKey(await getJson('https://openrouter.ai/api/v1/key', apiKey));
  const credits = await getJson('https://openrouter.ai/api/v1/credits', apiKey);
  const total = num(field(credits, 'data', 'total_credits'));
  const used = num(field(credits, 'data', 'total_usage'));
  if (total != null && used != null && total > 0) {
    out.push({
      quotaPoolKey: 'openrouter::credits',
      limit: cents(total),
      remaining: Math.max(0, cents(total) - cents(used)),
      unit: 'cents',
      notes: `openrouter /api/v1/credits total=${total} used=${used}`,
    });
  }
  return out;
}

/**
 * ElectronHub, `GET /v1/user/me` (docs.electronhub.ai/api-reference/usage):
 * `credits` left of `weekly_credits`, refilled every Sunday 21:00 UTC
 * (docs.electronhub.ai/billing/subscriptions).
 */
export function parseElectronHubMe(body: unknown, now = Date.now()): UsageObservation[] {
  const credits = num(field(body, 'credits'));
  const weekly = num(field(body, 'weekly_credits'));
  if (credits == null || weekly == null || weekly <= 0) return [];
  return [{
    quotaPoolKey: 'electronhub::weekly-credit',
    limit: cents(weekly),
    remaining: Math.max(0, cents(credits)),
    unit: 'cents',
    resetAt: nextWeeklyUtc(0, 21, now),
    notes: `electronhub /v1/user/me credits=${credits} weekly_credits=${weekly} subscription=${field(body, 'subscription')}`,
  }];
}

async function readElectronHubUsage(apiKey: string): Promise<UsageObservation[]> {
  return parseElectronHubMe(await getJson('https://api.electronhub.ai/v1/user/me', apiKey));
}

/** Inferbase free plan: 5,000 requests a month, resetting 00:00 UTC on the 1st
 *  (inferbase.ai/pricing). Documented, not reported, hence the confidence. */
const INFERBASE_FREE_MONTHLY_REQUESTS = 5000;

/** Inferbase, `GET /api/v1/inference/credits`: `requests_this_month` against
 *  the documented free-plan allowance. */
export function parseInferbaseCredits(body: unknown, now = Date.now()): UsageObservation[] {
  const used = num(field(body, 'requests_this_month'));
  if (used == null) return [];
  return [{
    quotaPoolKey: 'inferbase::managed-free',
    metric: 'requests',
    limit: INFERBASE_FREE_MONTHLY_REQUESTS,
    remaining: Math.max(0, INFERBASE_FREE_MONTHLY_REQUESTS - used),
    unit: null,
    resetAt: nextMonthUtc(now),
    confidence: 0.75,
    notes: `inferbase /api/v1/inference/credits requests_this_month=${used}; limit ${INFERBASE_FREE_MONTHLY_REQUESTS}/month from inferbase.ai/pricing`,
  }];
}

async function readInferbaseUsage(apiKey: string): Promise<UsageObservation[]> {
  return parseInferbaseCredits(await getJson('https://api.inferbase.ai/api/v1/inference/credits', apiKey));
}

// No account usage API for the inference key, verified 2026-10-17: Mistral
// (admin API is Enterprise-only), NVIDIA and Groq (headers only), Agnes and
// Zhipu (none for a free account). UnoRouter, AMD and Google answer only a
// second credential — see CREDENTIAL_READERS.
const USAGE_READERS: Partial<Record<Platform, (apiKey: string) => Promise<UsageObservation[]>>> = {
  ollama: readOllamaUsage,
  openrouter: readOpenRouterUsage,
  electronhub: readElectronHubUsage,
  inferbase: readInferbaseUsage,
};

export function platformsWithUsageApi(): Platform[] {
  return Object.keys(USAGE_READERS) as Platform[];
}

// ── Readers that need a usage credential ────────────────────────────────────

/** A refusal worth showing the operator: the credential is wrong or expired. */
export class UsageReadError extends Error {}

export interface CredentialReading {
  observations: UsageObservation[];
  /** One line for the dashboard: what was read, in the provider's terms. */
  note: string;
}

const usd = (dollars: number): string => `$${dollars.toFixed(2)}`;

/** new-api reports quota in internal units; `/api/status` publishes the rate
 *  (500,000 per dollar by default, and on UnoRouter as probed 2026-10-17). */
const NEW_API_DEFAULT_QUOTA_PER_UNIT = 500_000;

export function parseUnoRouterSelf(body: unknown, quotaPerUnit: number): CredentialReading {
  if (field(body, 'success') === false) {
    throw new UsageReadError(`UnoRouter refused the access token: ${String(field(body, 'message') ?? 'no reason given')}`);
  }
  const quota = num(field(body, 'data', 'quota'));
  const used = num(field(body, 'data', 'used_quota'));
  if (quota == null || used == null) throw new UsageReadError('UnoRouter /api/user/self carried no quota');
  const remaining = quota / quotaPerUnit;
  const total = (quota + used) / quotaPerUnit;
  if (total <= 0) return { observations: [], note: 'balance $0.00 — free models only' };
  return {
    observations: [{
      // Same name as OpenRouter's balance pool, so it reads as one kind of thing.
      quotaPoolKey: 'unorouter::credits',
      limit: cents(total),
      remaining: Math.max(0, cents(remaining)),
      unit: 'cents',
      notes: `unorouter /api/user/self quota=${quota} used_quota=${used} quota_per_unit=${quotaPerUnit}`,
    }],
    note: `balance ${usd(remaining)} of ${usd(total)}`,
  };
}

async function readUnoRouterAccount(_apiKey: string, credential: UsageCredentialFields): Promise<CredentialReading> {
  let quotaPerUnit = NEW_API_DEFAULT_QUOTA_PER_UNIT;
  const status = await fetch('https://api.unorouter.com/api/status', { signal: AbortSignal.timeout(15_000) })
    .then(r => (r.ok ? r.json() : null)).catch(() => null);
  const published = num(field(status, 'data', 'quota_per_unit'));
  if (published != null && published > 0) quotaPerUnit = published;
  const res = await fetch('https://api.unorouter.com/api/user/self', {
    headers: { Authorization: `Bearer ${credential.accessToken}`, 'New-Api-User': credential.userId ?? '' },
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new UsageReadError(`UnoRouter refused the access token (HTTP ${res.status}); check the user id matches it`);
  return parseUnoRouterSelf(await res.json().catch(() => null), quotaPerUnit);
}

/** AMD's daily spend cap resets at 00:00 Asia/Shanghai (radeon-cloud-docs, api/usage). */
const RADEON_RESET_ZONE = 'Asia/Shanghai';

export function parseRadeonUsage(body: unknown, now = Date.now()): CredentialReading {
  const state = field(body, 'status');
  if (state === 'not_configured' || state === 'not_available') {
    return { observations: [], note: `AMD reports usage ${String(state).replace('_', ' ')}` };
  }
  const limit = num(field(body, 'daily_cost_limit_usd'));
  const used = num(field(body, 'daily_cost_used_usd'));
  const left = num(field(body, 'daily_cost_remaining_usd')) ?? (limit != null && used != null ? limit - used : null);
  if (limit == null || left == null || limit <= 0) throw new UsageReadError('AMD model-usage carried no daily cost limit');
  const resetAt = field(body, 'daily_reset_at');
  const fallback = resolveQuotaWindow({ kind: 'calendar_day', timezone: RADEON_RESET_ZONE }, now).resetAtMs;
  const requests = num(field(body, 'today', 'requests'));
  return {
    observations: [{
      quotaPoolKey: 'radeon::daily-cost',
      limit: cents(limit),
      remaining: Math.max(0, cents(left)),
      unit: 'cents',
      resetAt: typeof resetAt === 'string' ? resetAt : (fallback ? new Date(fallback).toISOString() : null),
      notes: `radeon /api/profile/model-usage limit=${limit} used=${used} remaining=${left}`,
    }],
    note: `${usd(Math.max(0, limit - left))} of ${usd(limit)} today${requests == null ? '' : `, ${requests} requests`}`,
  };
}

async function readRadeonAccount(_apiKey: string, credential: UsageCredentialFields): Promise<CredentialReading> {
  const res = await fetch('https://developer.amd.com.cn/radeon/api/profile/model-usage', {
    headers: { Cookie: credential.cookie ?? '' },
    signal: AbortSignal.timeout(15_000),
  });
  if (res.status === 401 || res.status === 403) throw new UsageReadError('AMD console session expired or invalid; paste a fresh Cookie header');
  if (!res.ok) throw new UsageReadError(`AMD usage service answered HTTP ${res.status}`);
  return parseRadeonUsage(await res.json().catch(() => null));
}

// Google: a service account reads Cloud Quotas (each model's free-tier daily
// limit) and Cloud Monitoring (requests counted against it today).
const GOOGLE_SCOPE = 'https://www.googleapis.com/auth/cloud-platform';
const GOOGLE_DAILY_RESET_ZONE = 'America/Los_Angeles';
const FREE_TIER_DAILY_QUOTA_ID = 'GenerateRequestsPerDayPerProjectPerModel-FreeTier';
const FREE_TIER_QUOTA_METRIC = 'generativelanguage.googleapis.com/generate_content_free_tier_requests';
const googleTokens = new Map<string, { token: string; expiresMs: number }>();

const b64url = (s: string | Buffer): string => Buffer.from(s).toString('base64url');

/** RS256 JWT-bearer exchange (developers.google.com/identity/protocols/oauth2/service-account). */
export function serviceAccountAssertion(sa: GoogleServiceAccount, nowMs: number): string {
  const iat = Math.floor(nowMs / 1000);
  const unsigned = `${b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }))}.${b64url(JSON.stringify({
    iss: sa.client_email, scope: GOOGLE_SCOPE, aud: 'https://oauth2.googleapis.com/token', iat, exp: iat + 3600,
  }))}`;
  return `${unsigned}.${createSign('RSA-SHA256').update(unsigned).sign(sa.private_key, 'base64url')}`;
}

async function googleAccessToken(sa: GoogleServiceAccount): Promise<string> {
  const cacheKey = createHash('sha256').update(sa.client_email).update(sa.private_key).digest('hex');
  const cached = googleTokens.get(cacheKey);
  if (cached && cached.expiresMs - Date.now() > 60_000) return cached.token;
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: serviceAccountAssertion(sa, Date.now()) }),
    signal: AbortSignal.timeout(15_000),
  });
  const body: unknown = await res.json().catch(() => null);
  const token = field(body, 'access_token');
  if (!res.ok || typeof token !== 'string') {
    throw new UsageReadError(`Google refused the service account: ${String(field(body, 'error_description') ?? field(body, 'error') ?? `HTTP ${res.status}`)}`);
  }
  googleTokens.set(cacheKey, { token, expiresMs: Date.now() + (num(field(body, 'expires_in')) ?? 3600) * 1000 });
  return token;
}

/** Each model's free-tier requests-per-day limit from a Cloud Quotas quotaInfos page. */
export function parseFreeTierDailyLimits(body: unknown): Map<string, number> {
  const limits = new Map<string, number>();
  const infos = field(body, 'quotaInfos');
  if (!Array.isArray(infos)) return limits;
  for (const info of infos) {
    if (field(info, 'quotaId') !== FREE_TIER_DAILY_QUOTA_ID) continue;
    const dims = field(info, 'dimensionsInfos');
    if (!Array.isArray(dims)) continue;
    for (const dim of dims) {
      const model = field(dim, 'dimensions', 'model');
      const value = Number(field(dim, 'details', 'value'));
      if (typeof model === 'string' && Number.isFinite(value) && value > 0) limits.set(model, value);
    }
  }
  return limits;
}

/** Requests counted today from Monitoring `quota/rate/net_usage` series,
 *  split by model only where a series carries a `model` label. */
export function parseFreeTierUsage(body: unknown): { total: number; byModel: Map<string, number> } {
  const byModel = new Map<string, number>();
  let total = 0;
  const series = field(body, 'timeSeries');
  if (!Array.isArray(series)) return { total, byModel };
  for (const s of series) {
    const points = field(s, 'points');
    let sum = 0;
    if (Array.isArray(points)) for (const p of points) sum += Number(field(p, 'value', 'int64Value') ?? 0) || 0;
    total += sum;
    const model = field(s, 'metric', 'labels', 'model');
    if (typeof model === 'string') byModel.set(model, (byModel.get(model) ?? 0) + sum);
  }
  return { total, byModel };
}

async function googleGet(url: string, token: string, what: string, role: string): Promise<unknown> {
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(15_000) });
  const body: unknown = await res.json().catch(() => null);
  if (!res.ok) {
    const reason = field(body, 'error', 'message');
    throw new UsageReadError(`${what} refused (HTTP ${res.status}${typeof reason === 'string' ? `: ${reason.slice(0, 120)}` : ''}); the service account needs ${role}`);
  }
  return body;
}

async function readGoogleAccount(_apiKey: string, credential: UsageCredentialFields, now = Date.now()): Promise<CredentialReading> {
  const sa = parseServiceAccount(credential.serviceAccountJson ?? '');
  const token = await googleAccessToken(sa);
  const project = encodeURIComponent(sa.project_id);

  const limits = new Map<string, number>();
  let pageToken = '';
  for (let page = 0; page < 5; page++) {
    const body = await googleGet(
      `https://cloudquotas.googleapis.com/v1/projects/${project}/locations/global/services/generativelanguage.googleapis.com/quotaInfos?pageSize=500${pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : ''}`,
      token, 'Cloud Quotas', 'roles/cloudquotas.viewer',
    );
    for (const [model, limit] of parseFreeTierDailyLimits(body)) limits.set(model, limit);
    const next = field(body, 'nextPageToken');
    if (typeof next !== 'string' || !next) break;
    pageToken = next;
  }

  const window = resolveQuotaWindow({ kind: 'calendar_day', timezone: GOOGLE_DAILY_RESET_ZONE }, now);
  const startMs = window.periodStartMs ?? now - 86_400_000;
  const alignSeconds = Math.max(60, Math.ceil((now - startMs) / 1000));
  const query = new URLSearchParams({
    filter: `metric.type="serviceruntime.googleapis.com/quota/rate/net_usage" AND resource.type="consumer_quota" AND resource.label.service="generativelanguage.googleapis.com" AND metric.label.quota_metric="${FREE_TIER_QUOTA_METRIC}"`,
    'interval.startTime': new Date(startMs).toISOString(),
    'interval.endTime': new Date(now).toISOString(),
    'aggregation.alignmentPeriod': `${alignSeconds}s`,
    'aggregation.perSeriesAligner': 'ALIGN_SUM',
  });
  const usage = parseFreeTierUsage(await googleGet(
    `https://monitoring.googleapis.com/v3/projects/${project}/timeSeries?${query}`,
    token, 'Cloud Monitoring', 'roles/monitoring.viewer',
  ));

  const resetAt = window.resetAtMs ? new Date(window.resetAtMs).toISOString() : null;
  const observations: UsageObservation[] = [];
  for (const [model, limit] of limits) {
    // Without a per-model count a limit alone would overwrite what a 429 told
    // us about that model, so only models with both are recorded.
    const used = usage.byModel.get(model);
    if (used == null) continue;
    observations.push({
      quotaPoolKey: resolveQuotaPolicy('google', model).poolKey,
      metric: 'requests',
      limit,
      remaining: Math.max(0, limit - used),
      unit: null,
      resetAt,
      notes: `google Cloud Quotas ${FREE_TIER_DAILY_QUOTA_ID} model=${model} limit=${limit}; Monitoring net_usage today=${used}`,
    });
  }
  const split = usage.byModel.size > 0 ? `, ${observations.length} models measured` : ', not split by model';
  return { observations, note: `${limits.size} model daily limits; ${usage.total} free-tier requests today${split}` };
}

const CREDENTIAL_READERS: Record<keyof typeof USAGE_CREDENTIAL_FIELDS, (apiKey: string, credential: UsageCredentialFields) => Promise<CredentialReading>> = {
  unorouter: readUnoRouterAccount,
  radeon: readRadeonAccount,
  google: (apiKey, credential) => readGoogleAccount(apiKey, credential),
};

interface KeyRow { id: number; platform: string; encrypted_key: string; iv: string; auth_tag: string }

/**
 * Poll every configured key whose provider exposes a usage API and record what
 * it says. One pass; returns how many observations were written so a caller can
 * tell "nothing to read" from "read nothing".
 */
export async function pollProviderUsageApis(): Promise<number> {
  // `provider-usage-apis` off: balances come from headers and inference only.
  // Readings already recorded stay in the observation history.
  if (!isExtensionEnabled('provider-usage-apis')) return 0;
  let rows: KeyRow[];
  try {
    const platforms = platformsWithUsageApi();
    // Keys of a credential-only provider are read only once a credential is set.
    rows = getDb().prepare(`
      SELECT id, platform, encrypted_key, iv, auth_tag FROM api_keys
       WHERE enabled = 1 AND status != 'invalid'
         AND (platform IN (${platforms.map(() => '?').join(', ') || "''"})
              OR id IN (SELECT key_id FROM provider_usage_credentials))
    `).all(...platforms) as KeyRow[];
  } catch {
    return 0;
  }

  let written = 0;
  for (const row of rows) written += await pollKeyRow(row);
  return written;
}

/**
 * Read one key's usage API now, outside the five-minute pass. Used where a
 * fresh balance is the precondition for the next decision (a paid credit
 * window measures spend from it). Returns how many observations were written.
 */
export async function pollProviderUsageForKey(keyId: number): Promise<number> {
  if (!isExtensionEnabled('provider-usage-apis')) return 0;
  let row: KeyRow | undefined;
  try {
    row = getDb().prepare('SELECT id, platform, encrypted_key, iv, auth_tag FROM api_keys WHERE id = ?')
      .get(keyId) as KeyRow | undefined;
  } catch {
    return 0;
  }
  return row ? pollKeyRow(row) : 0;
}

async function pollKeyRow(row: KeyRow): Promise<number> {
  const reader = USAGE_READERS[row.platform as Platform];
  const credentialReader = Object.hasOwn(CREDENTIAL_READERS, row.platform)
    ? CREDENTIAL_READERS[row.platform as keyof typeof CREDENTIAL_READERS]
    : undefined;
  const credential = credentialReader ? readUsageCredential(row.id) : null;
  if (!reader && !credential) return 0;
  let apiKey: string;
  try {
    apiKey = decrypt(row.encrypted_key, row.iv, row.auth_tag);
  } catch {
    return 0;
  }
  let written = 0;
  if (reader) {
    try {
      written += recordUsage(row, await reader(apiKey));
    } catch {
      // An endpoint is allowed to disappear. Losing it costs the measurement,
      // not the request path.
    }
  }
  if (credentialReader && credential) {
    // Unlike the key's own endpoint, a refusal here is the operator's to fix —
    // an expired session, a missing role — so it is kept and shown.
    try {
      const reading = await credentialReader(apiKey, credential);
      written += recordUsage(row, reading.observations);
      recordUsageCredentialRead(row.id, 'ok', reading.note);
    } catch (err) {
      const message = err instanceof UsageReadError || err instanceof UsageCredentialError
        ? err.message
        : `usage read failed: ${err instanceof Error ? err.message : String(err)}`;
      try { recordUsageCredentialRead(row.id, 'error', message); } catch { /* key deleted mid-poll */ }
    }
  }
  return written;
}

function recordUsage(row: KeyRow, observations: UsageObservation[]): number {
  let written = 0;
  for (const observation of observations) {
    try {
      recordQuotaObservation({
        platform: row.platform as Platform,
        keyId: row.id,
        quotaPoolKey: observation.quotaPoolKey,
        metric: observation.metric ?? 'credits',
        limit: observation.limit,
        remaining: observation.remaining,
        unit: observation.unit,
        // Only what the provider reports or documents. Inventing a reset
        // instant would be the one thing worse than not having one.
        resetAt: observation.resetAt ?? null,
        resetStrategy: observation.resetAt ? 'fixed_calendar' : 'rolling_window',
        source: 'quota_api',
        confidence: observation.confidence ?? 0.9,
        notes: observation.notes,
        endpoint: 'usage',
      });
      written++;
    } catch {
      // Recording is best-effort; a failed write must not stop the next key.
    }
  }
  return written;
}

const SCAN_INTERVAL_MS = 5 * 60_000;
let cancelJob: (() => void) | null = null;
let inFlight = false;

export function startProviderUsagePolling(scheduler: Scheduler): void {
  if (cancelJob) return;
  if (process.env.PROVIDER_USAGE_API_DISABLED === '1') {
    console.log('[ProviderUsage] polling disabled via PROVIDER_USAGE_API_DISABLED=1');
    return;
  }
  console.log(`[ProviderUsage] polling provider usage APIs every ${SCAN_INTERVAL_MS / 1000}s`);
  const pass = async (): Promise<void> => {
    if (inFlight) return;
    inFlight = true;
    try {
      await pollProviderUsageApis();
    } catch (err) {
      console.error('[ProviderUsage] poll failed:', err);
    } finally {
      inFlight = false;
    }
  };
  // Read once at startup so a restart does not leave the ledger stale for five
  // minutes.
  void pass();
  cancelJob = scheduler.every(SCAN_INTERVAL_MS, pass, { name: 'provider-usage-api' });
}

export function stopProviderUsagePolling(): void {
  cancelJob?.();
  cancelJob = null;
  inFlight = false;
}
