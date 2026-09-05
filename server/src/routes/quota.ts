import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import {
  listQuotaPolicies,
  upsertQuotaPolicy,
  deleteQuotaPolicy,
  resolveEffectiveQuotas,
} from '../services/quota-policy.js';
import { getQuotaForecast } from '../services/quota-forecast.js';

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
  const quotas = resolveEffectiveQuotas(platform, modelId).map(q => ({
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
