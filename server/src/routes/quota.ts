import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { listQuotaProbes } from '../services/quota-probe-log.js';
import {
  listQuotaPolicies,
  upsertQuotaPolicy,
  deleteQuotaPolicy,
  resolveEffectiveQuotas,
} from '../services/quota-policy.js';
import { getQuotaForecast, getProviderQuotaOverview } from '../services/quota-forecast.js';
import { listBurnRuns, startBurnRun, cancelBurnRun, BurnStartError, BURN_LIMITS } from '../services/quota-burn.js';
import {
  getQuotaRoutingMode,
  setQuotaRoutingMode,
  getShadowAgreementStats,
  listRoutingDecisions,
  getReservationWeights,
  setReservationWeights,
  type QuotaRoutingMode,
} from '../services/quota-routing.js';

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
  periodKind: z.enum(['rolling', 'calendar_day', 'calendar_week', 'calendar_month', 'billing_cycle']).default('calendar_day'),
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

/**
 * Shadow-mode summary: how often quota-aware scoring would have chosen
 * differently. This can only report DIVERGENCE — the provider it preferred
 * never ran, so nothing here says the other choice would have been better.
 * That needs the bounded canary, not a longer shadow.
 */
quotaRouter.get('/shadow', (req: Request, res: Response) => {
  const days = Number(req.query.days);
  const since = Number.isFinite(days) && days > 0 ? Date.now() - days * 86_400_000 : undefined;
  res.json({ mode: getQuotaRoutingMode(), stats: getShadowAgreementStats(since) });
});

/** Routing decision history. `disagreed=1` narrows it to the rows worth
 *  reading — the ones where the two routers differed. */
quotaRouter.get('/decisions', (req: Request, res: Response) => {
  const days = Number(req.query.days);
  const limit = Number(req.query.limit);
  res.json({
    decisions: listRoutingDecisions({
      disagreedOnly: req.query.disagreed === '1' || req.query.disagreed === 'true',
      logicalModel: typeof req.query.model === 'string' ? req.query.model : undefined,
      sinceMs: Number.isFinite(days) && days > 0 ? Date.now() - days * 86_400_000 : undefined,
      limit: Number.isFinite(limit) ? limit : undefined,
    }),
  });
});

quotaRouter.get('/mode', (_req: Request, res: Response) => {
  res.json({ mode: getQuotaRoutingMode() });
});

/**
 * Switch off → shadow → active. `active` is reachable only by an explicit call
 * here: it is never a default and never reached by upgrade, because the whole
 * point of the sequence is that the operator decides when quota data starts
 * steering real traffic.
 */
quotaRouter.put('/mode', (req: Request, res: Response) => {
  const parsed = z.object({ mode: z.enum(['off', 'shadow', 'active']) }).strict().safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: { message: 'mode must be one of: off, shadow, active' } });
    return;
  }
  setQuotaRoutingMode(parsed.data.mode as QuotaRoutingMode);
  res.json({ mode: getQuotaRoutingMode() });
});

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
quotaRouter.get('/probes', (req: Request, res: Response) => {
  const platform = typeof req.query.platform === 'string' ? req.query.platform : undefined;
  const asked = typeof req.query.limit === 'string' ? Number.parseInt(req.query.limit, 10) : NaN;
  const limit = Number.isFinite(asked) && asked > 0 ? Math.min(asked, 500) : 500;
  const probes = listQuotaProbes({ platform, limit });
  res.json({ probes });
});
