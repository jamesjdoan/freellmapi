import crypto from 'crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import { getDb } from '../db/index.js';
import { parseStoredUtc } from './quota-clock.js';
import type { Db } from '../db/types.js';
// Single shared Retry-After parser (was duplicated here and in providers/base.ts).
import { parseRetryAfterMs } from '../providers/base.js';
import type {
  Platform,
  QuotaMetric,
  QuotaObservationSource,
  QuotaResetStrategy,
  ProviderQuotaObservation,
  ProviderQuotaState,
  QuotaPolicy,
} from '@freellmapi/shared/types.js';
import { isLoopbackOrPrivateUrl } from '../lib/url-guard.js';

export interface QuotaObservationContext {
  platform: Platform;
  keyId?: number;
  providerAccountId?: string | null;
  modelId?: string | null;
  quotaPoolKey?: string | null;
  endpoint?: string | null;
  origin?: 'health' | 'proxy' | 'responses' | 'manual' | 'probe';
}

export interface QuotaObservationInput {
  platform?: Platform;
  keyId?: number;
  providerAccountId?: string | null;
  modelId?: string | null;
  quotaPoolKey?: string | null;
  metric?: QuotaMetric;
  /**
   * Denomination of `limit`/`remaining` when the bare count would be
   * ambiguous: 'cents' for a currency balance, 'per_10k' for a fraction of an
   * allowance the provider never sizes. Absent means a plain count.
   */
  unit?: string | null;
  limit?: number | null;
  remaining?: number | null;
  resetAt?: string | null;
  retryAfterMs?: number | null;
  resetStrategy?: QuotaResetStrategy;
  source?: QuotaObservationSource;
  statusCode?: number | null;
  notes?: string | null;
  rawJson?: string | null;
  endpoint?: string | null;
  confidence?: number;
  observedAt?: string;
}

export interface QuotaObservationView extends ProviderQuotaState {
  providerAccountId: string | null;
  modelId: string | null;
  endpoint: string | null;
  statusCode: number | null;
  retryAfterMs: number | null;
  rawJson: string | null;
  createdAt: string;
}

const contextStore = new AsyncLocalStorage<QuotaObservationContext>();

const DEFAULT_CONFIDENCE: Record<QuotaObservationSource, number> = {
  header: 1,
  quota_api: 1,
  error_body: 0.75,
  local_usage: 0.45,
  documentation: 0.35,
  probe: 0.6,
};

const SOURCE_PRIORITY: Record<QuotaObservationSource, number> = {
  header: 5,
  quota_api: 5,
  error_body: 4,
  probe: 3,
  local_usage: 2,
  documentation: 1,
};

export function runWithQuotaObservationContext<T>(context: QuotaObservationContext, fn: () => T): T {
  return contextStore.run(context, fn);
}

export function getQuotaObservationContext(): QuotaObservationContext | undefined {
  return contextStore.getStore();
}

function isoNow(): string {
  return new Date().toISOString();
}

function toSqliteUtc(value: Date | string | number): string {
  const date = value instanceof Date ? value : new Date(value);
  return date.toISOString().replace('T', ' ').replace('Z', '');
}

function parseHeaderNumber(raw: string | null): number | null {
  if (!raw) return null;
  const n = Number(raw.trim());
  return Number.isFinite(n) ? n : null;
}

function parseResetAtFromHeader(raw: string | null, now = Date.now()): string | null {
  if (!raw) return null;

  // First, try to parse as a duration string (e.g., "2m59.56s", "59.56s", "1h2m3s", "750ms", "1m", "45s").
  // This is safe because the raw value is retained (see captureRawHeaders), so any parsing error is auditable.
  const durationRegex = /^(\d+(?:\.\d+)?(ms|h|m|s))+$/;
  if (durationRegex.test(raw)) {
    const timePartRegex = /(\d+(?:\.\d+)?)(ms|h|m|s)/g;
    let totalMs = 0;
    let match;
    while ((match = timePartRegex.exec(raw)) !== null) {
      const value = parseFloat(match[1]);
      const unit = match[2];
      let ms;
      switch (unit) {
        case 'h': ms = value * 3600 * 1000; break;
        case 'm': ms = value * 60 * 1000; break;
        case 's': ms = value * 1000; break;
        case 'ms': ms = value; break;
        default: return null; // Should not happen due to outer regex
      }
      totalMs += ms;
    }
    return new Date(now + totalMs).toISOString();
  }

  // Fall back to existing numeric parsing.
  const parsed = parseHeaderNumber(raw);
  if (parsed === null) return null;
  if (parsed > 1_000_000_000_000) return new Date(parsed).toISOString();
  if (parsed > 1_000_000_000) return new Date(parsed * 1000).toISOString();
  return new Date(now + parsed * 1000).toISOString();
}

function pickBetterSource(existing: QuotaObservationSource | null | undefined, next: QuotaObservationSource): QuotaObservationSource {
  if (!existing) return next;
  return SOURCE_PRIORITY[next] >= SOURCE_PRIORITY[existing] ? next : existing;
}

function modelPool(platform: Platform, modelId?: string | null, prefix = 'model'): string {
  const normalizedModelId = modelId?.trim() ?? '';
  return normalizedModelId ? `${platform}::${prefix}::${normalizedModelId}` : `${platform}::account`;
}

/** Pool names used before quota scope became explicit. Only providers whose
 * corrected economics required a new identity need a read fallback. Once an
 * exact new-pool observation exists for a key, it takes precedence. */
function legacyPoolKey(platform: Platform, poolKey: string): string | null {
  if (platform === 'groq' && poolKey.startsWith('groq::model::')) return 'groq::account';
  if (platform === 'google' && poolKey.startsWith('google::project-model::')) return 'google::project';
  return null;
}

/**
 * Resolve quota economics for one provider endpoint. This is intentionally a
 * small provider-knowledge table, not a cost optimiser: Phase 1 only needs a
 * stable pool identity and enough metadata to avoid treating shared and
 * independent allowances as the same thing.
 */
export function resolveQuotaPolicy(
  platform: Platform,
  modelId?: string | null,
  endpoint?: string | null,
): QuotaPolicy {
  const normalizedModelId = modelId?.trim() ?? '';
  const policy = (
    poolKey: string,
    scope: QuotaPolicy['scope'],
    accounting: QuotaPolicy['accounting'],
    metrics: QuotaPolicy['metrics'],
    strategy: QuotaPolicy['reset']['strategy'] = 'unknown',
    period?: QuotaPolicy['reset']['period'],
  ): QuotaPolicy => ({ poolKey, scope, accounting, metrics, reset: { strategy, ...(period ? { period } : {}) } });

  if (platform === 'custom' && endpoint && isLoopbackOrPrivateUrl(endpoint)) {
    return policy(`custom::local::${endpoint}`, 'account', 'unmetered', []);
  }
  if (platform === 'openrouter') {
    return normalizedModelId.endsWith(':free')
      ? policy('openrouter::free', 'shared_pool', 'metered', ['requests'], 'provider_reported')
      : policy('openrouter::account', 'account', 'metered', ['requests', 'tokens'], 'provider_reported');
  }
  // Groq publishes independent model limits at organisation/account level.
  if (platform === 'groq') return policy(modelPool(platform, modelId), 'model', 'metered', ['requests', 'tokens'], 'provider_reported');
  // The key identifies the Google project; the model suffix preserves each
  // model's independently published project allowance.
  if (platform === 'google') return policy(modelPool(platform, modelId, 'project-model'), 'project', 'metered', ['requests', 'tokens'], 'provider_reported');
  if (platform === 'huggingface') return policy('huggingface::router', 'shared_pool', 'metered', ['credits'], 'provider_reported', 'month');
  if (platform === 'opencode') return policy('opencode::promo', 'shared_pool', 'unknown', [], 'unknown');
  if (platform === 'cerebras') return policy('cerebras::shared', 'shared_pool', 'metered', ['requests', 'tokens'], 'provider_reported');
  if (platform === 'sail') return policy('sail::monthly-credit', 'shared_pool', 'metered', ['credits'], 'fixed_calendar', 'month');
  if (platform === 'bai') return policy('bai::promo', 'shared_pool', 'unknown', [], 'unknown');
  // AMD Radeon Cloud TokenFactory (upstream v0.9.6): one recurring daily
  // allowance, reported in USD, plus a user-level RPM ceiling. Both numbers
  // arrive on every response, so the pool is metered and provider-reported.
  // 'shared_pool', not 'account': the allowance is per key/user, so ranking
  // keys by remaining is meaningful — matching upstream, whose
  // 'radeon::daily-free' key was never account-scoped.
  if (platform === 'radeon') return policy('radeon::daily-free', 'shared_pool', 'metered', ['requests', 'credits'], 'provider_reported');
  if (platform === 'sambanova') return policy('sambanova::shared', 'shared_pool', 'metered', ['requests', 'tokens'], 'provider_reported');
  if (platform === 'nvidia') return policy('nvidia::credit-pool', 'shared_pool', 'metered', ['requests'], 'provider_reported');
  if (platform === 'mistral') return policy('mistral::experiment-pool', 'shared_pool', 'metered', ['requests', 'tokens'], 'provider_reported');
  if (platform === 'github') return policy('github::account', 'account', 'metered', ['requests'], 'provider_reported');
  if (platform === 'cohere') return policy('cohere::trial-pool', 'shared_pool', 'metered', ['requests', 'tokens'], 'provider_reported');
  if (platform === 'cloudflare') return policy('cloudflare::account', 'account', 'metered', ['neurons'], 'provider_reported');
  if (platform === 'zhipu') return policy('zhipu::account', 'account', 'metered', ['tokens'], 'provider_reported');
  if (platform === 'ollama') return policy('ollama::cloud', 'account', 'metered', ['requests'], 'provider_reported');
  if (platform === 'kilo') return policy('kilo::anonymous', 'shared_pool', 'unknown', [], 'unknown');
  if (platform === 'pollinations') return policy('pollinations::account', 'account', 'unknown', [], 'unknown');
  if (platform === 'llm7') return policy('llm7::anonymous', 'shared_pool', 'unknown', [], 'unknown');
  // AI Horde: anonymous requests share one queue priority (the 0000000000 key),
  // so they pool together; a registered key has its own kudos priority but we
  // still bucket per-platform here.
  if (platform === 'aihorde') return policy('aihorde::anonymous', 'shared_pool', 'unknown', ['neurons'], 'unknown');
  // Aggregators with a single shared free pool across all ':free'/'auto:free' models.
  if (platform === 'routeway') return policy('routeway::free', 'shared_pool', 'metered', ['requests'], 'provider_reported');
  if (platform === 'bazaarlink') return policy('bazaarlink::free', 'shared_pool', 'unknown', [], 'unknown');
  if (platform === 'ainative') return policy('ainative::account', 'account', 'metered', ['tokens'], 'provider_reported', 'month');
  if (platform === 'aion') return policy('aion::free', 'shared_pool', 'unknown', [], 'unknown');
  if (platform === 'requesty') return policy('requesty::free', 'shared_pool', 'unknown', [], 'unknown');
  if (platform === 'navy') return policy('navy::free', 'shared_pool', 'metered', ['tokens'], 'fixed_calendar', 'day');
  if (platform === 'nara') return policy('nara::free', 'shared_pool', 'unknown', [], 'unknown');
  if (platform === 'sealion') return policy('sealion::free', 'shared_pool', 'metered', ['requests'], 'provider_reported');
  // OrcaRouter: one rate-limited free allowance across all `*-free` aliases
  // and the `orcarouter/free` auto route (limits unpublished; 429 on cap).
  if (platform === 'orcarouter') return policy('orcarouter::free', 'shared_pool', 'unknown', [], 'unknown');
  // UnoRouter: the docs say 1 req/min per free model, but live-probed
  // 2026-08-23 a burst across many `:free` models put the whole account into
  // 429 on every model for several minutes — so one pool, and a 429 on any
  // model backs off the platform as a whole.
  if (platform === 'unorouter') return policy('unorouter::free', 'shared_pool', 'metered', ['requests'], 'provider_reported');
  // xkiro: one account-level allowance shared across its free models (the
  // free tier is a per-account grant, not per-model), so one pool.
  if (platform === 'xkiro') return policy('xkiro::free', 'shared_pool', 'metered', ['tokens'], 'fixed_calendar', 'day');
  // AnyAPI: the free tier is one 100K-tokens/day budget for the whole account,
  // shared across every free/basic model — so one pool, not one per model.
  if (platform === 'anyapi') return policy('anyapi::free', 'shared_pool', 'metered', ['tokens'], 'fixed_calendar', 'day');
  // ModelScope: one 2000-requests/day quota across the whole account.
  if (platform === 'modelscope') return policy('modelscope::account', 'account', 'metered', ['requests'], 'fixed_calendar', 'day');
  // Volcengine's recurring reward is published per model; other unknown
  // providers retain the legacy per-model pool fallback when a model is known.
  if (platform === 'volcengine') return policy(normalizedModelId ? `volcengine::${normalizedModelId}` : 'volcengine::account', 'model', 'metered', ['tokens'], 'fixed_calendar', 'day');
  if (platform === 'custom') return policy(normalizedModelId ? `custom::${normalizedModelId}` : 'custom::account', 'model', 'unknown', [], 'unknown');
  return policy(normalizedModelId ? `${platform}::${normalizedModelId}` : `${platform}::account`, normalizedModelId ? 'model' : 'account', 'unknown', [], 'unknown');
}

/**
 * True when one quota bucket covers every KEY on the platform, so every key
 * reports the same remaining number. Callers that rank keys against each other
 * (the 'least-remaining' key strategy, #919) must skip these pools — reordering
 * on an identical number only churns the rotation.
 *
 * Derived from `resolveQuotaPolicy`, not from the pool-key string. The string is
 * a label whose shape already changed once (Groq is now `groq::model::<id>`),
 * and a routing rule must not move with it.
 *
 * NOTE: this is a deliberate behaviour change from the previous
 * `endsWith('::account')` test. Pools whose key does not end in `::account` but
 * whose scope genuinely IS account-wide — `ollama::cloud`, `custom::local::…` —
 * now correctly skip key ranking. Inert unless a platform has several keys AND
 * the least-remaining strategy is on.
 */
export function isAccountScopedPool(platform: Platform, modelId?: string | null): boolean {
  return resolveQuotaPolicy(platform, modelId).scope === 'account';
}

function isSharedPool(platform: Platform): boolean {
  return resolveQuotaPolicy(platform).scope !== 'model';
}

type HeaderSpec = { metric: QuotaMetric; limit: string; remaining?: string; reset?: string; strategy?: QuotaResetStrategy };

const HEADER_SPECS: Partial<Record<Platform, HeaderSpec[]>> = {
  groq: [
    { metric: 'requests', limit: 'x-ratelimit-limit-requests', remaining: 'x-ratelimit-remaining-requests', reset: 'x-ratelimit-reset-requests', strategy: 'provider_reported' },
    { metric: 'tokens', limit: 'x-ratelimit-limit-tokens', remaining: 'x-ratelimit-remaining-tokens', reset: 'x-ratelimit-reset-tokens', strategy: 'provider_reported' },
  ],
  cerebras: [
    { metric: 'requests', limit: 'x-ratelimit-limit-requests-day', remaining: 'x-ratelimit-remaining-requests-day', reset: 'x-ratelimit-reset-requests-day', strategy: 'provider_reported' },
    { metric: 'tokens', limit: 'x-ratelimit-limit-tokens-minute', remaining: 'x-ratelimit-remaining-tokens-minute', reset: 'x-ratelimit-reset-tokens-minute', strategy: 'token_bucket' },
  ],
  openrouter: [
    { metric: 'requests', limit: 'x-ratelimit-limit-requests', remaining: 'x-ratelimit-remaining-requests', reset: 'x-ratelimit-reset-requests', strategy: 'provider_reported' },
    { metric: 'tokens', limit: 'x-ratelimit-limit-tokens', remaining: 'x-ratelimit-remaining-tokens', reset: 'x-ratelimit-reset-tokens', strategy: 'provider_reported' },
  ],
  radeon: [
    { metric: 'requests', limit: 'x-ratelimit-limit-user-rpm', remaining: 'x-ratelimit-remaining-user-rpm', reset: 'x-ratelimit-reset', strategy: 'provider_reported' },
    { metric: 'credits', limit: 'x-ratelimit-limit-user-daily-usd', remaining: 'x-ratelimit-remaining-user-daily-usd', reset: 'x-ratelimit-reset-user-daily-usd', strategy: 'provider_reported' },
  ],
  // ModelScope reportedly returns `modelscope-ratelimit-*`-style headers on
  // authenticated responses. UNCONFIRMED: no real token exists for this
  // platform yet (auth needs an Alibaba Cloud cn-site binding, #581), and the
  // keyless probes we could run (401s, unauthenticated /v1/models) carry no
  // ratelimit headers at all. Absent headers are a no-op in
  // maybeAddObservation, so a wrong guess here costs nothing; community
  // testers should dump response headers (see the #581 tester guide) and
  // correct these names.
  modelscope: [
    { metric: 'requests', limit: 'modelscope-ratelimit-requests-limit', remaining: 'modelscope-ratelimit-requests-remaining', reset: 'modelscope-ratelimit-requests-reset', strategy: 'provider_reported' },
  ],
};

/** The subject an observation is attributed to: which account, key, model and
 *  pool the numbers belong to. Named because it is the contract every
 *  observation builder consumes, and (ADR ARCH-20260905, F8) the shape that
 *  changes when quota gains a per-model subject. */
export interface QuotaObservationSubject {
  platform: Platform;
  keyId: number;
  providerAccountId: string | null;
  modelId: string | null;
  quotaPoolKey: string;
  endpoint: string | null;
}

function extractContext(
  opts: Pick<QuotaObservationInput, 'platform' | 'modelId' | 'quotaPoolKey' | 'keyId' | 'providerAccountId' | 'endpoint'> = {},
): QuotaObservationSubject | null {
  const context = getQuotaObservationContext();
  const platform = opts.platform ?? context?.platform;
  if (!platform) return null;
  return {
    platform,
    keyId: opts.keyId ?? context?.keyId ?? 0,
    providerAccountId: opts.providerAccountId ?? context?.providerAccountId ?? null,
    modelId: opts.modelId ?? context?.modelId ?? null,
    quotaPoolKey: opts.quotaPoolKey ?? context?.quotaPoolKey ?? resolveQuotaPolicy(platform, opts.modelId ?? context?.modelId, opts.endpoint ?? context?.endpoint).poolKey,
    endpoint: opts.endpoint ?? context?.endpoint ?? null,
  };
}

// ── Raw header capture (ADR ARCH-20260905, F3/F10) ──────────────────────────
// `parseResetAtFromHeader` accepts only numerics, so a provider that states its
// reset as a duration ("2m59.56s") has that value silently dropped — and until
// now nothing retained the original, which made "the provider omits it" and
// "our parser rejected it" indistinguishable after the fact. Capture the raw
// values so the question is answerable from the log instead of from a live
// packet capture.
//
// Whitelist + pattern, never a full header dump: a blind snapshot can carry
// Set-Cookie or similar, and telemetry must not hold credential material.
// The deny-list wins over the pattern, so a quota-shaped header that names a
// token is still refused.
const RAW_CAPTURE_PATTERN = /ratelimit|rate-limit|quota|retry|reset|remaining|credit/i;
const RAW_CAPTURE_DENY = /authorization|cookie|token|secret|api-?key|bearer|session|password|signature/i;
/** Defensive ceiling. Real header sets are a few hundred bytes; anything larger
 *  is a provider doing something unexpected and is not worth persisting. */
const RAW_CAPTURE_MAX_CHARS = 2048;

function captureRawHeaders(headers: Headers | undefined, explicit: (string | undefined)[]): string | null {
  if (!headers) return null;
  const captured: Record<string, string> = {};
  const take = (name: string, value: string | null | undefined) => {
    if (value === null || value === undefined) return;
    const lower = name.toLowerCase();
    if (RAW_CAPTURE_DENY.test(lower)) return;
    captured[lower] = value;
  };

  // The headers this observation was actually derived from, present or not —
  // an absent one is itself the finding, so it is recorded as null below.
  for (const name of explicit) {
    if (!name) continue;
    const lower = name.toLowerCase();
    if (RAW_CAPTURE_DENY.test(lower)) continue;
    captured[lower] = headers.get?.(name) ?? '';
  }

  // Discovery: anything quota-shaped the provider sent that we have no spec
  // for. This is how the header names for platforms with no HEADER_SPECS entry
  // get found, rather than guessed.
  headers.forEach?.((value, name) => {
    if (!RAW_CAPTURE_PATTERN.test(name)) return;
    take(name, value);
  });

  if (Object.keys(captured).length === 0) return null;
  const json = JSON.stringify(captured);
  return json.length > RAW_CAPTURE_MAX_CHARS ? json.slice(0, RAW_CAPTURE_MAX_CHARS) : json;
}

function maybeAddObservation(
  observations: QuotaObservationInput[],
  base: QuotaObservationSubject,
  metric: QuotaMetric,
  limitRaw: string | null,
  remainingRaw: string | null | undefined,
  resetRaw: string | null | undefined,
  strategy: QuotaResetStrategy,
  rawJson: string | null,
  statusCode: number | null,
): void {
  const limit = parseHeaderNumber(limitRaw);
  const remaining = parseHeaderNumber(remainingRaw ?? null);
  const resetAt = parseResetAtFromHeader(resetRaw ?? null);
  // A reset the parser could not read is still evidence: keep the observation
  // when the raw header was present, so the unparsed value reaches the log
  // instead of vanishing with the response (F3).
  const unparsedReset = resetAt === null && (resetRaw ?? null) !== null;
  if (limit === null && remaining === null && resetAt === null && !unparsedReset) return;
  observations.push({
    ...base,
    metric,
    limit,
    remaining,
    resetAt,
    resetStrategy: strategy,
    source: 'header',
    confidence: 1,
    notes: unparsedReset ? 'reset header present but unparsed' : null,
    rawJson,
    statusCode,
  });
}

export function inferQuotaPoolKey(platform: Platform, modelId?: string | null, endpoint?: string | null): string {
  return resolveQuotaPolicy(platform, modelId, endpoint).poolKey;
}

export function parseQuotaObservationsFromResponse(
  response: Response,
  opts: Pick<QuotaObservationInput, 'platform' | 'modelId' | 'quotaPoolKey' | 'keyId' | 'providerAccountId' | 'endpoint'> = {},
): QuotaObservationInput[] {
  const base = extractContext(opts);
  if (!base) return [];

  const headers = response.headers;
  const get = (name: string) => headers?.get?.(name) ?? null;
  const observations: QuotaObservationInput[] = [];
  const specs = HEADER_SPECS[base.platform];
  // Every header name this platform is known to use, so the discovery capture
  // below records them as explicitly absent rather than merely unmentioned.
  const specNames = (specs ?? []).flatMap(spec => [spec.limit, spec.remaining, spec.reset]);
  if (specs) {
    for (const spec of specs) {
      maybeAddObservation(
        observations, base, spec.metric,
        get(spec.limit),
        spec.remaining ? get(spec.remaining) : null,
        spec.reset ? get(spec.reset) : null,
        spec.strategy ?? 'provider_reported',
        captureRawHeaders(headers, [spec.limit, spec.remaining, spec.reset]),
        response.status,
      );
    }
  }

  const retryAfterMs = parseRetryAfterMs(get('retry-after')) ?? null;
  if (retryAfterMs !== null) {
    observations.push({
      ...base,
      metric: 'requests',
      limit: parseHeaderNumber(get('x-ratelimit-limit-requests')),
      remaining: 0,
      resetAt: new Date(Date.now() + retryAfterMs).toISOString(),
      retryAfterMs,
      resetStrategy: 'provider_reported',
      source: response.status === 429 ? 'header' : 'error_body',
      confidence: response.status === 429 ? 1 : 0.8,
      notes: `retry-after=${retryAfterMs}ms`,
      statusCode: response.status,
      rawJson: captureRawHeaders(headers, ['retry-after', 'x-ratelimit-limit-requests']),
    });
  }

  if (response.status === 429 || response.status === 402) {
    observations.push({
      ...base,
      metric: 'requests',
      limit: parseHeaderNumber(get('x-ratelimit-limit-requests')),
      remaining: 0,
      resetAt: get('x-ratelimit-reset-requests') ? parseResetAtFromHeader(get('x-ratelimit-reset-requests')) : null,
      retryAfterMs,
      resetStrategy: 'unknown',
      source: 'error_body',
      confidence: 0.55,
      notes: response.status === 402 ? 'upstream payment/credit exhaustion' : 'rate limited',
      statusCode: response.status,
      rawJson: captureRawHeaders(headers, ['retry-after', 'x-ratelimit-limit-requests', 'x-ratelimit-reset-requests', ...specNames]),
    });
  }

  if (observations.length === 0 && response.status === 200) {
    // Two different questions were being answered by one condition. Recording a
    // synthetic "we called it and nothing was reported" row is about POOLING —
    // it only means something for a platform whose models share one account
    // budget. Capturing quota-shaped headers we have no spec for is about
    // DISCOVERY, and applies to every platform.
    //
    // Gating both on isSharedPool meant a relay or a platform outside that list
    // could return textbook x-ratelimit-* headers and we would record nothing
    // at all — found by driving real traffic through a stub provider that sent
    // exactly those headers (F3).
    const discovered = captureRawHeaders(headers, []);
    if (discovered || isSharedPool(base.platform)) {
      observations.push({
        ...base,
        metric: 'requests',
        limit: null,
        remaining: null,
        resetAt: null,
        resetStrategy: 'unknown',
        source: 'probe',
        confidence: 0.1,
        notes: discovered ? 'unrecognised quota-shaped headers present' : 'no quota headers exposed',
        statusCode: response.status,
        rawJson: discovered,
      });
    }
  }

  return observations;
}

/**
 * Would this observation be an exact repeat of the newest one for the same
 * subject?
 *
 * Only the fields that carry information are compared. `observed_at` is
 * excluded by definition, and confidence/notes are excluded because they are
 * derived from the source rather than measured — a poll that returns the same
 * numbers is the same reading whatever it says about itself.
 *
 * A refusal is never treated as a repeat: two 429s a minute apart are two
 * events, and the learned-ceiling and recovery estimators both count them.
 */
/**
 * How stale the newest row may get before an unchanged reading is recorded
 * anyway.
 *
 * Deduping repeats saved 82.6% of the rows for a polled pool, and then broke
 * something subtler: two later guards use the spacing between rows to decide
 * whether we were WATCHING at a given moment - a reset bracketed by readings
 * far apart cannot be timed, and a run spanning such a gap cannot size a pool.
 * With repeats suppressed, an idle stretch looks identical to an outage, so a
 * reset after a quiet afternoon would be discarded despite a perfectly healthy
 * poller.
 *
 * A heartbeat restores the proxy: shorter than the 20-minute boundary bracket,
 * so an idle period never masquerades as downtime, while still dropping the
 * great majority of repeats.
 */
const OBSERVATION_HEARTBEAT_MS = 15 * 60_000;

function isRepeatObservation(db: ReturnType<typeof getDb>, row: {
  platform: string;
  keyId: number;
  quotaPoolKey: string;
  metric: string;
  limitValue: number | null;
  remainingValue: number | null;
  resetAt: string | null;
  statusCode: number | null;
  source: QuotaObservationSource;
  observedAt: string;
}): boolean {
  if (row.statusCode != null && row.statusCode >= 400) return false;
  if (row.source === 'error_body') return false;
  try {
    const previous = db.prepare(`
      SELECT limit_value, remaining_value, reset_at, status_code, observed_at
        FROM provider_quota_observations
       WHERE platform = ? AND key_id = ? AND quota_pool_key = ? AND metric = ?
       ORDER BY observed_at DESC, created_at DESC
       LIMIT 1
    `).get(row.platform, row.keyId, row.quotaPoolKey, row.metric) as {
      limit_value: number | null; remaining_value: number | null;
      reset_at: string | null; status_code: number | null; observed_at: string;
    } | undefined;
    if (!previous) return false;
    const identical = previous.limit_value === row.limitValue
      && previous.remaining_value === row.remainingValue
      && previous.reset_at === row.resetAt
      && previous.status_code === row.statusCode;
    if (!identical) return false;
    // Identical, but record it anyway if the series has gone quiet: the gap
    // between rows is what later tells an idle stretch from an outage.
    const previousAt = parseStoredUtc(previous.observed_at);
    const nowAt = parseStoredUtc(row.observedAt);
    if (previousAt == null || nowAt == null) return true;
    return nowAt - previousAt < OBSERVATION_HEARTBEAT_MS;
  } catch {
    // Unable to compare is not a reason to drop a measurement.
    return false;
  }
}

export function recordQuotaObservation(input: QuotaObservationInput): ProviderQuotaObservation | null {
  const context = getQuotaObservationContext();
  const platform = input.platform ?? context?.platform;
  if (!platform) return null;

  const keyId = input.keyId ?? context?.keyId ?? 0;
  const quotaPoolKey = input.quotaPoolKey ?? context?.quotaPoolKey ?? resolveQuotaPolicy(platform, input.modelId ?? context?.modelId, input.endpoint ?? context?.endpoint).poolKey;
  const metric = input.metric ?? 'requests';
  const source = input.source ?? 'probe';
  const resetStrategy = input.resetStrategy ?? 'unknown';
  const confidence = input.confidence ?? DEFAULT_CONFIDENCE[source];
  const observedAt = input.observedAt ?? isoNow();
  const unit = input.unit ?? null;
  const limitValue = input.limit ?? null;
  const remainingValue = input.remaining ?? null;
  const resetAt = input.resetAt ?? null;
  const retryAfterMs = input.retryAfterMs ?? null;
  const notes = input.notes ?? null;
  const providerAccountId = input.providerAccountId ?? context?.providerAccountId ?? null;
  const modelId = input.modelId ?? context?.modelId ?? null;
  const endpoint = input.endpoint ?? context?.endpoint ?? null;
  const statusCode = input.statusCode ?? null;
  const rawJson = input.rawJson ?? null;
  let db;
  try {
    db = getDb();
  } catch {
    return null;
  }
  const id = crypto.randomUUID();
  const nowSql = toSqliteUtc(observedAt);
  const updatedAt = nowSql;

  const prev = db.prepare(`
    SELECT confidence, notes, source
      FROM provider_quota_state
     WHERE platform = ?
       AND key_id = ?
       AND quota_pool_key = ?
       AND metric = ?
  `).get(platform, keyId, quotaPoolKey, metric) as { confidence: number; notes: string | null; source: QuotaObservationSource } | undefined;

  const nextConfidence = Math.max(prev?.confidence ?? 0, confidence);
  const nextNotes = notes ?? prev?.notes ?? null;
  const nextSource = pickBetterSource(prev?.source, source);

  db.transaction(() => {
    db.prepare(`
      INSERT INTO provider_quota_state (
        platform, key_id, quota_pool_key, metric, unit, limit_value, remaining_value,
        reset_at, reset_strategy, source, confidence, notes, observed_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(platform, key_id, quota_pool_key, metric) DO UPDATE SET
        unit = COALESCE(excluded.unit, provider_quota_state.unit),
        limit_value = COALESCE(excluded.limit_value, provider_quota_state.limit_value),
        remaining_value = COALESCE(excluded.remaining_value, provider_quota_state.remaining_value),
        reset_at = COALESCE(excluded.reset_at, provider_quota_state.reset_at),
        reset_strategy = CASE
          WHEN excluded.reset_strategy != 'unknown' THEN excluded.reset_strategy
          ELSE provider_quota_state.reset_strategy
        END,
        confidence = MAX(provider_quota_state.confidence, excluded.confidence),
        notes = COALESCE(excluded.notes, provider_quota_state.notes),
        observed_at = excluded.observed_at,
        updated_at = datetime('now')
    `).run(
      platform, keyId, quotaPoolKey, metric, unit, limitValue, remainingValue, resetAt, resetStrategy, source, nextConfidence, nextNotes, nowSql, updatedAt,
    );

    db.prepare(`
      UPDATE provider_quota_state
         SET source = ?
       WHERE platform = ?
         AND key_id = ?
         AND quota_pool_key = ?
         AND metric = ?
    `).run(nextSource, platform, keyId, quotaPoolKey, metric);

    // The observations table is an append-only history, so a row is only worth
    // adding when something CHANGED. Polling a usage API every five minutes was
    // writing an identical row each time: 82.6% of the rows for a polled pool
    // carried no information, and they dilute the series the reset detector
    // reads. The state row above still updates its observed_at, so "last seen"
    // stays fresh; and a changed value keeps its own timestamp, so nothing is
    // lost from the history either.
    if (!isRepeatObservation(db, { platform, keyId, quotaPoolKey, metric, limitValue, remainingValue, resetAt, statusCode, source, observedAt: nowSql })) {
      db.prepare(`
        INSERT INTO provider_quota_observations (
          id, platform, key_id, provider_account_id, model_id, quota_pool_key, metric, unit,
          status_code, limit_value, remaining_value, reset_at, retry_after_ms,
          reset_strategy, source, confidence, notes, raw_json, endpoint, observed_at, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        id, platform, keyId, providerAccountId, modelId, quotaPoolKey, metric, unit,
        statusCode, limitValue, remainingValue, resetAt, retryAfterMs,
        resetStrategy, source, confidence, notes, rawJson, endpoint, nowSql, nowSql,
      );
    }
  })();

  // The row just moved, so the memoised headroom for this platform is wrong —
  // drop it rather than let a 5s window hide a fresh 429 from the router.
  invalidateKeyQuotaHeadroom(platform);

  return {
    id,
    platform,
    keyId,
    providerAccountId,
    modelId,
    quotaPoolKey,
    metric,
    statusCode,
    limit: limitValue,
    remaining: remainingValue,
    resetAt,
    retryAfterMs,
    resetStrategy,
    source,
    confidence: nextConfidence,
    notes: nextNotes,
    observedAt: nowSql,
    updatedAt,
    endpoint,
    rawJson,
    createdAt: nowSql,
  };
}

export function recordQuotaObservationsFromResponse(
  response: Response,
  opts: Pick<QuotaObservationInput, 'platform' | 'modelId' | 'quotaPoolKey' | 'keyId' | 'providerAccountId' | 'endpoint'> = {},
): ProviderQuotaObservation[] {
  return parseQuotaObservationsFromResponse(response, opts)
    .map(recordQuotaObservation)
    .filter((row): row is ProviderQuotaObservation => row !== null);
}

// A quota window whose reset_at has passed has replenished at the provider, but
// remaining_value is only ever written on a fresh observation — so a key that hit
// remaining=0 reads as "exhausted" forever on the dashboard health view until the
// next live call (#453). Restore remaining to the known limit (or clear it to
// unknown when the limit isn't known — `= limit_value` yields NULL in that case)
// and drop the stale reset_at so the row stops reading as exhausted and this
// fix-up doesn't recur. Runs on read; a new observation re-populates reset_at.
function normalizeExpiredQuotaState(db: Db): void {
  db.prepare(`
    UPDATE provider_quota_state
       SET remaining_value = limit_value,
           reset_at = NULL,
           updated_at = datetime('now')
     WHERE reset_at IS NOT NULL
       AND julianday(reset_at) < julianday('now')
  `).run();
}

// ── Per-key headroom (routing signal) ───────────────────────────────────────
// getQuotaStateForKeys is a panel query: it takes a write (the expiry fix-up)
// and window-functions the whole observation log. The router needs a far
// smaller answer — "how much of its budget does each key of ONE platform have
// left" — on a path that runs per chain entry per request, so it gets its own
// read-only, platform-filtered query behind a short TTL.

/** Confidence floor for letting an observation steer routing. Keeps headers,
 *  quota APIs and 429 bodies in; leaves local estimates and probes out. */
const HEADROOM_MIN_CONFIDENCE = 0.7;
/** Quota moves on the timescale of a rate-limit window, not a request, so a
 *  few seconds of staleness is invisible while the query count drops to ~one
 *  per platform per burst. Writes bust the entry outright (see below). */
const HEADROOM_TTL_MS = 5_000;

// The Db handle is part of the cache identity: reconnecting (tests, a restore)
// hands back a different object, which invalidates every entry at once.
const headroomCache = new Map<string, { db: unknown; at: number; map: Map<number, number> }>();

/**
 * Fraction of the observed budget still available for each key of `platform`,
 * as keyId → 0..1, where 1 is untouched and 0 exhausted. Keys with no usable
 * observation are simply absent — that is not the same as "empty", and callers
 * must treat a miss as unknown rather than as zero headroom.
 *
 * A key metered on several metrics takes the WORST of them: the binding
 * constraint is what 429s, so a key with 90% of its requests but 2% of its
 * tokens left has 2% of headroom, not 90%.
 */
export function getKeyQuotaHeadroom(platform: Platform, quotaPoolKey?: string): Map<number, number> {
  let db;
  try {
    db = getDb();
  } catch {
    return new Map();
  }
  const now = Date.now();
  const cacheKey = `${platform}\u0000${quotaPoolKey ?? '*'}`;
  const cached = headroomCache.get(cacheKey);
  if (cached && cached.db === db && now - cached.at < HEADROOM_TTL_MS) return cached.map;

  const legacyPool = quotaPoolKey ? legacyPoolKey(platform, quotaPoolKey) : null;
  const rows = db.prepare(`
    SELECT key_id AS keyId,
           quota_pool_key AS poolKey,
           limit_value AS limitValue,
           remaining_value AS remainingValue,
           CASE WHEN reset_at IS NOT NULL AND julianday(reset_at) < julianday('now')
                THEN 1 ELSE 0 END AS expired
      FROM provider_quota_state
     WHERE platform = ?
       AND (? IS NULL OR quota_pool_key = ? OR quota_pool_key = ?)
       AND confidence >= ?
       AND limit_value IS NOT NULL
       AND limit_value > 0
       AND remaining_value IS NOT NULL
  `).all(platform, quotaPoolKey ?? null, quotaPoolKey ?? null, legacyPool, HEADROOM_MIN_CONFIDENCE) as {
    keyId: number; poolKey: string; limitValue: number; remainingValue: number; expired: number;
  }[];

  const map = new Map<number, number>();
  const exactKeys = quotaPoolKey
    ? new Set(rows.filter(row => row.poolKey === quotaPoolKey).map(row => row.keyId))
    : new Set<number>();
  for (const row of rows) {
    if (quotaPoolKey && exactKeys.has(row.keyId) && row.poolKey !== quotaPoolKey) continue;
    // A window that already reset is a full budget again. Same rule as
    // normalizeExpiredQuotaState, minus the write — this path must not take
    // one just to answer a routing question.
    const ratio = row.expired
      ? 1
      : Math.max(0, Math.min(1, row.remainingValue / row.limitValue));
    const prev = map.get(row.keyId);
    if (prev === undefined || ratio < prev) map.set(row.keyId, ratio);
  }
  headroomCache.set(cacheKey, { db, at: now, map });
  return map;
}

/** Whether the exact pool consumed by this endpoint has a high-confidence,
 * still-active exhaustion observation. Unknown capacity remains eligible;
 * only a concrete zero with a future reset is a hard routing gate, avoiding
 * permanent lockout when a provider omits reset metadata. */
export function isQuotaPoolAvailable(
  platform: Platform,
  keyId: number,
  modelId?: string | null,
  endpoint?: string | null,
): boolean {
  const quota = resolveQuotaPolicy(platform, modelId, endpoint);
  if (quota.accounting === 'unmetered') return true;
  let db;
  try {
    db = getDb();
  } catch {
    return true;
  }
  const legacyPool = legacyPoolKey(platform, quota.poolKey);
  const exactExists = db.prepare(`
    SELECT 1
      FROM provider_quota_state
     WHERE platform = ?
       AND key_id = ?
       AND quota_pool_key = ?
       AND confidence >= ?
       AND remaining_value IS NOT NULL
     LIMIT 1
  `).get(platform, keyId, quota.poolKey, HEADROOM_MIN_CONFIDENCE);
  const poolKey = exactExists || !legacyPool ? quota.poolKey : legacyPool;
  const exhausted = db.prepare(`
    SELECT 1
      FROM provider_quota_state
     WHERE platform = ?
       AND key_id = ?
       AND quota_pool_key = ?
       AND confidence >= ?
       AND remaining_value = 0
       AND reset_at IS NOT NULL
       AND julianday(reset_at) >= julianday('now')
     LIMIT 1
  `).get(platform, keyId, poolKey, HEADROOM_MIN_CONFIDENCE);
  return !exhausted;
}

/** Drop the memoised headroom for one platform (or all of them). Called on
 *  every write so a fresh observation is visible to the very next route. */
export function invalidateKeyQuotaHeadroom(platform?: Platform): void {
  if (!platform) {
    headroomCache.clear();
    return;
  }
  for (const key of headroomCache.keys()) {
    if (key.startsWith(`${platform}\u0000`)) headroomCache.delete(key);
  }
}

export function getQuotaStateForKeys(): QuotaObservationView[] {
  let db;
  try {
    db = getDb();
  } catch {
    return [];
  }
  normalizeExpiredQuotaState(db);
  // One seek per state row for its newest observation. The log is append-only
  // and grows into the hundreds of thousands of rows, so this must never scan
  // it: the correlated subquery walks idx_provider_quota_observations_latest
  // (platform, key_id, quota_pool_key, metric, observed_at DESC, created_at
  // DESC) and stops at the first entry. The window-function form it replaces
  // ranked the entire table, raw_json included, on every dashboard poll.
  return db.prepare(`
    SELECT
      pqs.platform,
      pqs.key_id AS keyId,
      -- The panel identifies a row by its key. A bare "key #7" says nothing, so
      -- carry the operator's own name for it (#705).
      k.label AS keyLabel,
      pqs.quota_pool_key AS quotaPoolKey,
      pqs.metric,
      pqs.unit AS unit,
      pqs.limit_value AS "limit",
      pqs.remaining_value AS remaining,
      pqs.reset_at AS resetAt,
      pqs.reset_strategy AS resetStrategy,
      pqs.source,
      pqs.confidence,
      pqs.notes,
      pqs.observed_at AS observedAt,
      pqs.updated_at AS updatedAt,
      NULL AS providerAccountId,
      latest.model_id AS modelId,
      latest.endpoint AS endpoint,
      latest.status_code AS statusCode,
      latest.retry_after_ms AS retryAfterMs,
      -- raw_json is deliberately NOT projected. It is a verbatim slice of the
      -- provider's response headers, kept so a parse failure stays auditable in
      -- the DB — but this view is served straight to the dashboard by
      -- routes/health.ts, and raw upstream headers are not something to hand a
      -- client by default. The capture filters (whitelist + deny-list) reduce
      -- the risk at write time; not serving it removes the egress path.
      NULL AS rawJson,
      latest.created_at AS createdAt
    FROM provider_quota_state pqs
    LEFT JOIN api_keys k ON k.id = pqs.key_id
    LEFT JOIN provider_quota_observations latest
      ON latest.id = (
        SELECT o.id
          FROM provider_quota_observations o
         WHERE o.platform = pqs.platform
           AND o.key_id = pqs.key_id
           AND o.quota_pool_key = pqs.quota_pool_key
           AND o.metric = pqs.metric
         ORDER BY o.observed_at DESC, o.created_at DESC
         LIMIT 1
      )
    ORDER BY pqs.platform ASC, pqs.key_id ASC, pqs.quota_pool_key ASC, pqs.metric ASC
  `).all() as QuotaObservationView[];
}

// ── Learned ceilings (429 with no published limit) ──────────────────────────
// Some providers publish nothing and only ever tell us "no" — OpenCode Zen,
// Ollama Cloud, Google on some models. For those the only evidence of a ceiling
// is the point at which they started refusing, so record it: how much this
// account had spent on the platform when the 429 arrived.
//
// This is an OBSERVED CEILING, not a limit. It is deliberately written to the
// observation log ONLY, never to provider_quota_state:
//   - state.limit_value feeds the forecast and the headroom cache, and a 429
//     also writes remaining=0, so a learned limit there would pin the pool at
//     "Exhausted" with no reset_at to ever clear it.
//   - one refusal is weak evidence. The ADR is explicit that a single 429 must
//     not permanently mutate a provider's limits.
// It surfaces at the lowest precedence rank, below even a shipped env default.

export const LEARNED_CEILING_NOTE = 'learned ceiling from 429';

export function recordLearnedCeiling(input: {
  platform: Platform;
  keyId: number;
  quotaPoolKey: string;
  modelId?: string | null;
  /** Requests this account had spent on the platform when it was refused. */
  observedRequests: number;
}): void {
  // Zero tells us nothing — a refusal on the first request of a window means
  // the ceiling is elsewhere (a minute window, another key, a stale cooldown).
  if (!Number.isFinite(input.observedRequests) || input.observedRequests <= 0) return;
  try {
    const db = getDb();
    db.prepare(`
      INSERT INTO provider_quota_observations (
        id, platform, key_id, provider_account_id, model_id, quota_pool_key, metric,
        status_code, limit_value, remaining_value, reset_at, retry_after_ms,
        reset_strategy, source, confidence, notes, raw_json, endpoint, observed_at, created_at
      ) VALUES (?, ?, ?, NULL, ?, ?, 'requests', 429, ?, 0, NULL, NULL, 'unknown', 'error_body', 0.3, ?, NULL, NULL, ?, ?)
    `).run(
      crypto.randomUUID(), input.platform, input.keyId, input.modelId ?? null,
      input.quotaPoolKey, input.observedRequests, LEARNED_CEILING_NOTE,
      toSqliteUtc(new Date()), toSqliteUtc(new Date()),
    );
  } catch {
    // Learning is best-effort; never fail a request over it.
  }
}

/** The highest ceiling we have ever been refused at, per platform. Highest
 *  because a lower refusal is explained by a narrower window (a per-minute cap
 *  inside a daily pool); the largest observed spend is the tightest lower bound
 *  on the daily allowance we can honestly claim. */
export function getLearnedCeiling(platform: Platform): { limit: number; observations: number } | null {
  try {
    const db = getDb();
    const row = db.prepare(`
      SELECT MAX(limit_value) AS ceiling, COUNT(*) AS n
        FROM provider_quota_observations
       WHERE platform = ? AND notes = ? AND limit_value IS NOT NULL
    `).get(platform, LEARNED_CEILING_NOTE) as { ceiling: number | null; n: number };
    if (row?.ceiling == null || row.ceiling <= 0) return null;
    return { limit: row.ceiling, observations: row.n };
  } catch {
    return null;
  }
}
