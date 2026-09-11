import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import {
  clearAnalysisKey,
  clearManualLink,
  getAnalysisStatus,
  getComparePayload,
  relinkAll,
  setAnalysisKey,
  setManualLink,
  syncAnalysis,
  getGroupedCompare,
  getReferenceGroups,
  setModelKeyScope,
  setProxyDelta,
  getReferenceSlugs,
  setReferenceSlugs,
} from '../services/analysis.js';

// Artificial Analysis benchmark data. Read-only against routing: nothing here
// changes what the router does. It exists so a human can compare models on
// measured intelligence, coding and agentic scores instead of on the
// hand-tuned ranks this project ships.
//
// The key is never returned, not even masked — there is nothing a caller can
// do with it that it cannot do through this router.

export const analysisRouter = Router();

const keySchema = z.object({ key: z.string().min(8, 'Key looks too short') });

// A set of routes, not one: a logical model on the Compare page is however many
// provider routes the router unified, and mapping it to a benchmark is one
// decision about the model rather than N decisions about its copies. A single
// route is just a one-element set.
const linkSchema = z.object({
  models: z.array(z.object({
    platform: z.string().min(1),
    modelId: z.string().min(1),
  })).min(1),
  // Null is meaningful: "this model has no counterpart", which stops the
  // matcher proposing one on every sync.
  aaSlug: z.string().min(1).nullable(),
  // A stand-in for a model the upstream does not publish. Scores read as an
  // estimate, and nothing may treat it as evidence that two routes are the
  // same model.
  proxy: z.boolean().optional(),
});

analysisRouter.get('/status', (_req: Request, res: Response) => {
  res.json(getAnalysisStatus());
});

analysisRouter.put('/key', (req: Request, res: Response) => {
  const parsed = keySchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: { message: parsed.error.errors.map(e => e.message).join(', ') } });
    return;
  }
  setAnalysisKey(parsed.data.key);
  res.json(getAnalysisStatus());
});

analysisRouter.delete('/key', (_req: Request, res: Response) => {
  clearAnalysisKey();
  res.json(getAnalysisStatus());
});

/**
 * Manual, never scheduled. The Free tier allows 100 requests per 24 hours
 * shared across the organisation, and a poller would spend that on data that
 * moves weekly.
 */
analysisRouter.post('/sync', async (_req: Request, res: Response) => {
  const result = await syncAnalysis();
  res.status(result.ok ? 200 : 502).json(result);
});

/** Re-run the matcher without spending a request on the upstream API. */
analysisRouter.post('/relink', (_req: Request, res: Response) => {
  res.json(relinkAll());
});

const referencesSchema = z.object({ slugs: z.array(z.string().min(1)).max(20) });

// Baseline models to read the catalogue against. Capped: a baseline is a
// handful of yardsticks, and a list long enough to need scrolling is just a
// second catalogue.
analysisRouter.get('/references', (_req: Request, res: Response) => {
  res.json({ slugs: getReferenceSlugs(), groups: getReferenceGroups() });
});

analysisRouter.put('/references', (req: Request, res: Response) => {
  const parsed = referencesSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: { message: parsed.error.errors.map(e => e.message).join(', ') } });
    return;
  }
  const slugs = setReferenceSlugs(parsed.data.slugs);
  res.json({ slugs, groups: getReferenceGroups() });
});

const keyScopeSchema = z.object({
  platform: z.string().min(1),
  modelId: z.string().min(1),
  allow: z.boolean(),
});

// Widen or narrow a provider key's model scope for ONE model. The Compare page
// can see that a route is unreachable only because the key does not name it,
// and this is the one edit that fixes that without leaving the row.
analysisRouter.put('/key-scope', (req: Request, res: Response) => {
  const parsed = keyScopeSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: { message: parsed.error.errors.map(e => e.message).join(', ') } });
    return;
  }
  const { platform, modelId, allow } = parsed.data;
  const result = setModelKeyScope(platform, modelId, allow);
  if (result.changed === 0 && result.refused > 0) {
    res.status(409).json({ error: {
      message: allow
        ? 'Key already permits every model on this platform.'
        : 'Cannot remove: the key is unscoped, or this is the only model it names. Edit the key on the Keys page.',
      type: 'invalid_request_error',
    } });
    return;
  }
  res.json({ success: true, ...result });
});

const proxyDeltaSchema = z.object({
  platform: z.string().min(1),
  modelId: z.string().min(1),
  // Per metric: a stand-in can code like its proxy and reason worse, and a
  // single adjustment forced one judgement onto all three.
  metric: z.enum(['intelligence', 'coding', 'agentic', 'speed']),
  delta: z.number().int().min(-3).max(3),
});

// Nudge a proxy's borrowed scores. Rejected for auto and manual links: there the
// numbers measure the model itself, and shifting them would be falsification
// rather than estimation.
analysisRouter.put('/proxy-delta', (req: Request, res: Response) => {
  const parsed = proxyDeltaSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: { message: parsed.error.errors.map(e => e.message).join(', ') } });
    return;
  }
  const { platform, modelId, metric, delta } = parsed.data;
  if (!setProxyDelta(platform, modelId, metric, delta)) {
    res.status(409).json({ error: {
      message: 'Only a proxy link can be adjusted. Map this model as a proxy first.',
      type: 'invalid_request_error',
    } });
    return;
  }
  res.json({ success: true, metric, delta });
});

analysisRouter.get('/compare', (_req: Request, res: Response) => {
  res.json(getComparePayload());
});

analysisRouter.put('/link', (req: Request, res: Response) => {
  const parsed = linkSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: { message: parsed.error.errors.map(e => e.message).join(', ') } });
    return;
  }
  const source = parsed.data.proxy ? 'proxy' as const : 'manual' as const;
  for (const m of parsed.data.models) setManualLink(m.platform, m.modelId, parsed.data.aaSlug, undefined, source);
  res.json({ success: true, linked: parsed.data.models.length, source });
});

/** Hand a model back to the matcher, discarding the manual decision. */
analysisRouter.delete('/link', (req: Request, res: Response) => {
  const parsed = linkSchema.omit({ aaSlug: true }).safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: { message: parsed.error.errors.map(e => e.message).join(', ') } });
    return;
  }
  for (const m of parsed.data.models) clearManualLink(m.platform, m.modelId);
  res.json({ success: true, cleared: parsed.data.models.length });
});

/**
 * One entry per LOGICAL model — the router's own unification, so a merge made
 * on the Models page is what shows here.
 */
analysisRouter.get('/grouped', (_req: Request, res: Response) => {
  res.json({ groups: getGroupedCompare() });
});




