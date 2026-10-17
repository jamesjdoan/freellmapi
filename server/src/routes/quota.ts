import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { listQuotaProbes } from '../services/quota-probe-log.js';
import { getDb, getSetting, setSetting } from '../db/index.js';
import {
  listQuotaPolicies,
  upsertQuotaPolicy,
  deleteQuotaPolicy,
  resolveEffectiveQuotas,
} from '../services/quota-policy.js';
import { getQuotaForecast, getProviderQuotaOverview } from '../services/quota-forecast.js';
import { getProviderCapacity } from '../services/provider-capacity.js';
import { listBurnRuns, startBurnRun, cancelBurnRun, BurnStartError, BURN_LIMITS } from '../services/quota-burn.js';
import {
  getReservationWeights,
  setReservationWeights,
} from '../services/quota-routing.js';
import {
  listBonusGrants,
  createBonusGrant,
  updateBonusGrant,
  openBonusAllowance,
  closeBonusAllowance,
  BonusInputError,
} from '../services/bonus.js';
import {
  paidCreditOverview,
  paidModelOptions,
  setPaidModelSelected,
  openPaidCreditWindow,
  closePaidCreditWindow,
  PaidCreditInputError,
} from '../services/paid-credit.js';
import {
  USAGE_CREDENTIAL_FIELDS,
  isUsageCredentialPlatform,
  normalizeUsageCredential,
  setUsageCredential,
  clearUsageCredential,
  listUsageCredentials,
  getUsageCredentialStatus,
  UsageCredentialError,
} from '../services/usage-credentials.js';
import { pollProviderUsageForKey } from '../services/provider-usage-api.js';

// Quota policy + effective-state API (ADR ARCH-20260905, W2).
//
// Read-only against routing: nothing here changes what the gates enforce. It
// exists so the policy is operable and the resolver's answer is auditable —
// without it the policy table is a set of rows nobody can see or edit, and
// shadow-mode output later would be unreviewable.
//
// No secrets: policies are keyed by platform and model id, never by key
// material, and the effective view reports limits and windows only.

export const quotaRouter = Router();

const PolicyBody = z.object({
  platform: z.string().min(1),
  modelId: z.string().min(1).nullable().default(null),
  /** Names one relay endpoint. Null = every endpoint of this platform+model,
   *  which is what a catalog platform always means. */
  endpointScope: z.string().min(1).nullable().default(null),
  scope: z.enum(['provider_account', 'provider_key', 'model', 'shared_pool']).default('provider_account'),
  metric: z.enum(['requests', 'input_tokens', 'output_tokens', 'total_tokens', 'credits']).default('requests'),
  limit: z.number().int().positive(),
  periodKind: z.enum(['rolling', 'calendar_day', 'calendar_week', 'calendar_month', 'billing_cycle', 'bucket']).default('calendar_day'),
  periodMs: z.number().int().positive().nullable().default(null),
  timezone: z.string().min(1).nullable().default(null),
  anchorDay: z.number().int().min(1).max(31).nullable().default(null),
  priority: z.number().int().default(0),
  enabled: z.boolean().default(true),
  // `source` is deliberately NOT accepted from the client. Anything written
  // here is an operator declaration; letting a caller label it 'provider_api'
  // would let a typed number outrank a measured one in the resolver.
  confidence: z.number().min(0).max(1).default(0.8),
  notes: z.string().max(500).nullable().default(null),
  /** Denomination of `limit` where the metric does not say: 'usd_cents' for a
   *  dollar credit allowance. */
  unit: z.enum(['usd_cents']).nullable().default(null),
}).strict();

quotaRouter.get('/policies', (req: Request, res: Response) => {
  const platform = typeof req.query.platform === 'string' ? req.query.platform : undefined;
  res.json({ policies: listQuotaPolicies(platform) });
});

quotaRouter.put('/policies', (req: Request, res: Response) => {
  const parsed = PolicyBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: { message: parsed.error.issues[0]?.message ?? 'Invalid quota policy' } });
    return;
  }
  // A rolling period without a width, or a billing cycle without an anchor,
  // would silently take a default that is not what the operator described.
  if (parsed.data.periodKind === 'bucket' && parsed.data.periodMs == null) {
    res.status(400).json({ error: { message: 'periodMs is required when periodKind is "bucket" — it is the refill interval for one unit' } });
    return;
  }
  if (parsed.data.periodKind === 'rolling' && parsed.data.periodMs == null) {
    res.status(400).json({ error: { message: 'periodMs is required when periodKind is "rolling"' } });
    return;
  }
  if (parsed.data.periodKind === 'billing_cycle' && parsed.data.anchorDay == null) {
    res.status(400).json({ error: { message: 'anchorDay is required when periodKind is "billing_cycle"' } });
    return;
  }
  res.json({ policy: upsertQuotaPolicy({ ...parsed.data, source: 'operator' }) });
});

quotaRouter.delete('/policies/:id', (req: Request, res: Response) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) {
    res.status(400).json({ error: { message: 'Invalid id' } });
    return;
  }
  if (!deleteQuotaPolicy(id)) {
    res.status(404).json({ error: { message: 'No such quota policy' } });
    return;
  }
  res.json({ success: true, id });
});

/**
 * Which limits currently bind a platform (optionally one model), each with the
 * window it resets on and the source that supplied it. Several axes bind at
 * once — RPM and RPD and TPM — so this is a list, and each entry names its own
 * provenance rather than presenting one blended number.
 */
quotaRouter.get('/state', (req: Request, res: Response) => {
  const platform = typeof req.query.platform === 'string' ? req.query.platform : '';
  if (!platform) {
    res.status(400).json({ error: { message: 'platform is required' } });
    return;
  }
  const modelId = typeof req.query.model === 'string' ? req.query.model : null;
  const endpointScope = typeof req.query.endpoint === 'string' ? req.query.endpoint : null;
  const quotas = resolveEffectiveQuotas(platform, modelId, Date.now(), endpointScope).map(q => ({
    platform: q.platform,
    modelId: q.modelId,
    metric: q.metric,
    scope: q.scope,
    limit: q.limit,
    period: q.period,
    periodStart: q.window.periodStartMs == null ? null : new Date(q.window.periodStartMs).toISOString(),
    resetAt: q.window.resetAtMs == null ? null : new Date(q.window.resetAtMs).toISOString(),
    source: q.source,
    confidence: q.confidence,
  }));
  res.json({ platform, modelId, quotas });
});

/** The existing observed-balance forecast, exposed alongside the declared
 *  policies so a caller can compare what we were told against what we declared. */
quotaRouter.get('/forecast', (_req: Request, res: Response) => {
  res.json({ forecast: getQuotaForecast() });
});

// The shadow-mode endpoints (/shadow, /decisions, /mode) were removed
// 2026-09-19 with the shadow router itself. They reported how often a second
// provider-picker would have chosen differently, which is divergence rather
// than evidence: the route it preferred never ran. The routing_decision table
// went with them in 20260919_000001_drop_routing_decision — nothing is kept,
// and that migration's down comment is the one place its row count is stated.

/**
 * Per-platform scarcity multipliers, 0..1, lower meaning "hold this pool back".
 * Empty by default: a shipped weight would be a routing opinion baked into the
 * code, and the right value depends on the operator's own account. For a free
 * OpenRouter account with 50 shared requests/day, something like 0.3 is a
 * sensible starting point.
 */
quotaRouter.get('/reservation', (_req: Request, res: Response) => {
  res.json({ weights: getReservationWeights() });
});

quotaRouter.put('/reservation', (req: Request, res: Response) => {
  const parsed = z.object({ weights: z.record(z.string(), z.number().min(0).max(1)) })
    .strict().safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: { message: 'weights must map platform -> number between 0 and 1' } });
    return;
  }
  res.json({ weights: setReservationWeights(parsed.data.weights) });
});

/**
 * Every provider with an enabled key, whether or not we have quota numbers for
 * it. The forecast alone drops unmeasured pools — correct for a warning feed,
 * misleading as an inventory, because it renders as "you have one provider".
 */
quotaRouter.get('/providers', (_req: Request, res: Response) => {
  res.json({ providers: getProviderQuotaOverview() });
});

// Same measured facts for model, credential and quota surfaces. No routing writes.
quotaRouter.get('/capacity', async (_req: Request, res: Response) => {
  res.json(await getProviderCapacity());
});

/**
 * Deliberate limit discovery. A burn run spends a provider's allowance until it
 * refuses, because for most of the catalogue there is no published number and
 * reaching the limit is the only way to learn it.
 *
 * POST is gated behind an explicit confirmation in the UI: this consumes a real
 * free allowance that does not come back until the provider's own reset.
 */
quotaRouter.get('/burn', (req: Request, res: Response) => {
  const platform = typeof req.query.platform === 'string' ? req.query.platform : undefined;
  res.json({ runs: listBurnRuns(platform), limits: BURN_LIMITS });
});

quotaRouter.post('/burn', (req: Request, res: Response) => {
  const parsed = z.object({
    platform: z.string().min(1),
    model: z.string().min(1).nullable().default(null),
    maxRequests: z.number().int().min(1).max(BURN_LIMITS.maxRequests),
    maxSeconds: z.number().int().min(5).max(BURN_LIMITS.maxSeconds),
    maxPeriod: z.enum(['day', 'week', 'month']).default('day'),
    /** Pacing. Flat out finds the per-minute cap; spacing requests under a
     *  known one is how a longer window is reached instead. */
    intervalMs: z.number().int().min(0).max(60_000).default(0),
    /** The confirmation itself, not decoration: an accidental POST must not be
     *  able to spend an allowance. */
    confirm: z.literal(true),
  }).strict().safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: { message: 'platform, maxRequests, maxSeconds and confirm: true are required' } });
    return;
  }
  try {
    res.json({
      run: startBurnRun({
        platform: parsed.data.platform,
        modelId: parsed.data.model,
        maxRequests: parsed.data.maxRequests,
        maxSeconds: parsed.data.maxSeconds,
        maxPeriod: parsed.data.maxPeriod,
        intervalMs: parsed.data.intervalMs,
      }),
    });
  } catch (err: any) {
    const status = err instanceof BurnStartError ? err.status : 500;
    res.status(status).json({ error: { message: String(err?.message ?? err) } });
  }
});

quotaRouter.post('/burn/:id/cancel', (req: Request, res: Response) => {
  const id = String(req.params.id ?? '');
  const run = id ? cancelBurnRun(id) : null;
  if (!run) {
    res.status(404).json({ error: { message: 'No such burn run' } });
    return;
  }
  res.json({ run });
});

/**
 * Quota probe measurement records, exposed alongside the declared policies.
 * Optional `?platform=` filters by platform, `?limit=` caps the result set.
 */
const HIDDEN_POOLS_KEY = 'quota_hidden_pools';

/** Tolerant of a malformed value: a bad setting should hide nothing, never
 *  take the panel down. */
function readHiddenPools(): string[] {
  try {
    const raw = getSetting(HIDDEN_POOLS_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === 'string') : [];
  } catch {
    return [];
  }
}

/**
 * Pools an operator has taken off the overview.
 *
 * Not every pool a provider reports is one this install wants to look at:
 * OpenRouter publishes a credit balance beside its free request allowance, and
 * on an install that only routes `:free` models the money row is noise on a
 * panel read for free capacity.
 *
 * Presentation only — a hidden pool is still resolved, still gates requests and
 * still appears in the API. Hiding a row must never quietly stop enforcing it.
 */
quotaRouter.get('/hidden-pools', (_req: Request, res: Response) => {
  res.json({ pools: readHiddenPools() });
});

quotaRouter.put('/hidden-pools', (req: Request, res: Response) => {
  const parsed = z.object({ pools: z.array(z.string().min(1)).max(200) }).strict().safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: { message: parsed.error.issues[0]?.message ?? 'Invalid pool list' } });
    return;
  }
  const pools = [...new Set(parsed.data.pools)].sort();
  setSetting(HIDDEN_POOLS_KEY, JSON.stringify(pools));
  res.json({ pools });
});

quotaRouter.get('/probes', (req: Request, res: Response) => {
  const platform = typeof req.query.platform === 'string' ? req.query.platform : undefined;
  const modelId = typeof req.query.modelId === 'string' ? req.query.modelId : undefined;
  const asked = typeof req.query.limit === 'string' ? Number.parseInt(req.query.limit, 10) : NaN;
  const limit = Number.isFinite(asked) && asked > 0 ? Math.min(asked, 500) : 500;
  const probes = listQuotaProbes({ platform, modelId, limit });
  res.json({ probes });
});

// ── Temporary bonus grants (ADR ARCH-20261016) ───────────────────────────────
// Unlike the rest of this router these DO change routing: a grant with an open
// spending window admits requests beyond the normal daily allowance.

const BonusGrantBody = z.object({
  platform: z.string().min(1),
  keyIds: z.array(z.number().int().positive()).min(1).max(100),
  metric: z.enum(['requests', 'total_tokens']),
  quantity: z.number().positive(),
  durationHours: z.number().positive(),
  normalLimit: z.number().positive(),
  timezone: z.string().min(1).default('UTC'),
  label: z.string().max(120).optional(),
}).strict();

const BonusGrantPatch = z.object({
  label: z.string().max(120).optional(),
  quantity: z.number().positive().optional(),
  durationHours: z.number().positive().optional(),
  normalLimit: z.number().positive().optional(),
}).strict();

const BonusAllowanceBody = z.object({
  quantity: z.number().positive(),
  durationHours: z.number().positive(),
}).strict();

function grantId(req: Request): number | null {
  const id = Number(req.params.id);
  return Number.isInteger(id) && id > 0 ? id : null;
}

function bonusFailure(res: Response, err: unknown): void {
  if (err instanceof BonusInputError) {
    res.status(err.status).json({ error: { message: err.message } });
    return;
  }
  res.status(500).json({ error: { message: String((err as Error)?.message ?? err) } });
}

quotaRouter.get('/bonuses', (_req: Request, res: Response) => {
  res.json({ grants: listBonusGrants(), observedAt: new Date().toISOString() });
});

quotaRouter.post('/bonuses', (req: Request, res: Response) => {
  const parsed = BonusGrantBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: { message: parsed.error.issues[0]?.message ?? 'Invalid bonus grant' } });
    return;
  }
  try {
    res.status(201).json({ grant: createBonusGrant(parsed.data) });
  } catch (err) {
    bonusFailure(res, err);
  }
});

quotaRouter.patch('/bonuses/:id', (req: Request, res: Response) => {
  const id = grantId(req);
  const parsed = BonusGrantPatch.safeParse(req.body);
  if (id == null || !parsed.success) {
    res.status(400).json({ error: { message: parsed.success ? 'Invalid grant id' : parsed.error.issues[0]?.message ?? 'Invalid update' } });
    return;
  }
  try {
    res.json({ grant: updateBonusGrant(id, parsed.data) });
  } catch (err) {
    bonusFailure(res, err);
  }
});

quotaRouter.post('/bonuses/:id/allowance', (req: Request, res: Response) => {
  const id = grantId(req);
  const parsed = BonusAllowanceBody.safeParse(req.body);
  if (id == null || !parsed.success) {
    res.status(400).json({ error: { message: parsed.success ? 'Invalid grant id' : parsed.error.issues[0]?.message ?? 'Invalid spending window' } });
    return;
  }
  try {
    res.json({ grant: openBonusAllowance(id, parsed.data) });
  } catch (err) {
    bonusFailure(res, err);
  }
});

quotaRouter.delete('/bonuses/:id/allowance', (req: Request, res: Response) => {
  const id = grantId(req);
  if (id == null) {
    res.status(400).json({ error: { message: 'Invalid grant id' } });
    return;
  }
  try {
    res.json({ grant: closeBonusAllowance(id) });
  } catch (err) {
    bonusFailure(res, err);
  }
});

// ── Usage credentials (extension `provider-usage-apis`) ─────────────────────
// A second, read-only credential per key for providers whose account usage the
// inference key cannot read. Write-only: secrets are never returned.

const UsageCredentialBody = z.object({ fields: z.record(z.string()) });

quotaRouter.get('/usage-credentials', (_req: Request, res: Response) => {
  res.json({ supported: USAGE_CREDENTIAL_FIELDS, credentials: listUsageCredentials() });
});

quotaRouter.put('/usage-credentials/:keyId', async (req: Request, res: Response) => {
  const keyId = Number(req.params.keyId);
  const parsed = UsageCredentialBody.safeParse(req.body);
  if (!Number.isInteger(keyId) || !parsed.success) {
    res.status(400).json({ error: { message: parsed.success ? 'Invalid key id' : 'Expected { fields: { name: value } }' } });
    return;
  }
  const key = getDb().prepare('SELECT platform FROM api_keys WHERE id = ?').get(keyId) as { platform: string } | undefined;
  if (!key || !isUsageCredentialPlatform(key.platform)) {
    res.status(404).json({ error: { message: key ? `${key.platform} has no usage credential` : 'Key not found' } });
    return;
  }
  try {
    setUsageCredential(keyId, normalizeUsageCredential(key.platform, parsed.data.fields));
  } catch (err) {
    if (err instanceof UsageCredentialError) {
      res.status(400).json({ error: { message: err.message } });
      return;
    }
    throw err;
  }
  // Read at once, so the operator learns now whether the provider accepts it.
  await pollProviderUsageForKey(keyId);
  res.json({ credential: getUsageCredentialStatus(keyId) });
});

quotaRouter.delete('/usage-credentials/:keyId', (req: Request, res: Response) => {
  const keyId = Number(req.params.keyId);
  if (!Number.isInteger(keyId)) {
    res.status(400).json({ error: { message: 'Invalid key id' } });
    return;
  }
  res.json({ ok: clearUsageCredential(keyId) });
});

// ── Paid credit windows (extension `paid-credit-windows`) ───────────────────
// The one bounded way automatic routing spends on paid models while the
// paid-balance guard is on. Opening a window needs the typed confirmation.

function paidCreditFailure(res: Response, err: unknown): void {
  if (err instanceof PaidCreditInputError) {
    res.status(err.status).json({ error: { message: err.message } });
    return;
  }
  res.status(500).json({ error: { message: String((err as Error)?.message ?? err) } });
}

quotaRouter.get('/paid-credit', (_req: Request, res: Response) => {
  res.json(paidCreditOverview());
});

quotaRouter.get('/paid-credit/models', async (req: Request, res: Response) => {
  const platform = typeof req.query.platform === 'string' ? req.query.platform : '';
  try {
    res.json({ platform, models: await paidModelOptions(platform) });
  } catch (err) {
    paidCreditFailure(res, err);
  }
});

quotaRouter.put('/paid-credit/models', async (req: Request, res: Response) => {
  const parsed = z.object({
    platform: z.string().min(1),
    modelId: z.string().min(1),
    selected: z.boolean(),
  }).strict().safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: { message: parsed.error.issues[0]?.message ?? 'Invalid selection' } });
    return;
  }
  try {
    await setPaidModelSelected(parsed.data.platform, parsed.data.modelId, parsed.data.selected);
    res.json({ platform: parsed.data.platform, models: await paidModelOptions(parsed.data.platform) });
  } catch (err) {
    paidCreditFailure(res, err);
  }
});

quotaRouter.post('/paid-credit/windows', async (req: Request, res: Response) => {
  const parsed = z.object({
    platform: z.string().min(1),
    keyId: z.number().int().positive(),
    quantity: z.number().positive(),
    durationHours: z.number().positive(),
    confirmation: z.string(),
  }).strict().safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: { message: parsed.error.issues[0]?.message ?? 'Invalid credit window' } });
    return;
  }
  try {
    res.status(201).json({ key: await openPaidCreditWindow(parsed.data) });
  } catch (err) {
    paidCreditFailure(res, err);
  }
});

quotaRouter.delete('/paid-credit/windows/:id', (req: Request, res: Response) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    res.status(400).json({ error: { message: 'Invalid window id' } });
    return;
  }
  try {
    res.json({ key: closePaidCreditWindow(id) });
  } catch (err) {
    paidCreditFailure(res, err);
  }
});
