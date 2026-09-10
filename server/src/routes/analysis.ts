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

const linkSchema = z.object({
  platform: z.string().min(1),
  modelId: z.string().min(1),
  // Null is meaningful: "this model has no counterpart", which stops the
  // matcher proposing one on every sync.
  aaSlug: z.string().min(1).nullable(),
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

analysisRouter.get('/compare', (_req: Request, res: Response) => {
  res.json(getComparePayload());
});

analysisRouter.put('/link', (req: Request, res: Response) => {
  const parsed = linkSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: { message: parsed.error.errors.map(e => e.message).join(', ') } });
    return;
  }
  setManualLink(parsed.data.platform, parsed.data.modelId, parsed.data.aaSlug);
  res.json({ success: true });
});

/** Hand a model back to the matcher, discarding the manual decision. */
analysisRouter.delete('/link', (req: Request, res: Response) => {
  const parsed = linkSchema.omit({ aaSlug: true }).safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: { message: parsed.error.errors.map(e => e.message).join(', ') } });
    return;
  }
  clearManualLink(parsed.data.platform, parsed.data.modelId);
  res.json({ success: true });
});
