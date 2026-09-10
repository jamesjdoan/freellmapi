import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import {
  addMembers,
  createGroup,
  deleteGroup,
  listGroups,
  removeMember,
  renameGroup,
  setGroupSlug,
} from '../services/model-groups-manual.js';
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

const memberSchema = z.object({ platform: z.string().min(1), modelId: z.string().min(1) });

const createGroupSchema = z.object({
  name: z.string().min(1),
  members: z.array(memberSchema).min(1, 'A group needs at least one model'),
  aaSlug: z.string().min(1).nullable().optional(),
});

const patchGroupSchema = z.object({
  name: z.string().min(1).optional(),
  // Explicit null pins nothing and hands the group back to inheritance, which
  // is different from omitting the field.
  aaSlug: z.string().min(1).nullable().optional(),
  addMembers: z.array(memberSchema).optional(),
  removeMembers: z.array(memberSchema).optional(),
});

/** One entry per group, plus every ungrouped model standing alone. */
analysisRouter.get('/grouped', (_req: Request, res: Response) => {
  res.json({ groups: getGroupedCompare() });
});

analysisRouter.get('/groups', (_req: Request, res: Response) => {
  res.json({ groups: listGroups() });
});

analysisRouter.post('/groups', (req: Request, res: Response) => {
  const parsed = createGroupSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: { message: parsed.error.errors.map(e => e.message).join(', ') } });
    return;
  }
  try {
    const id = createGroup(parsed.data.name, parsed.data.members, parsed.data.aaSlug ?? null);
    res.json({ id });
  } catch (error) {
    res.status(400).json({ error: { message: error instanceof Error ? error.message : String(error) } });
  }
});

analysisRouter.patch('/groups/:id', (req: Request, res: Response) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) {
    res.status(400).json({ error: { message: 'Invalid id' } });
    return;
  }
  const parsed = patchGroupSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: { message: parsed.error.errors.map(e => e.message).join(', ') } });
    return;
  }
  const { name, aaSlug, addMembers: adds, removeMembers: removes } = parsed.data;
  if (name !== undefined) renameGroup(id, name);
  if (aaSlug !== undefined) setGroupSlug(id, aaSlug);
  if (adds?.length) addMembers(id, adds);
  for (const m of removes ?? []) removeMember(m);
  res.json({ success: true });
});

analysisRouter.delete('/groups/:id', (req: Request, res: Response) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) {
    res.status(400).json({ error: { message: 'Invalid id' } });
    return;
  }
  deleteGroup(id);
  res.json({ success: true });
});
