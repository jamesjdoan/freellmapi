import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { getDb } from '../db/index.js';
import {
  ArrangeRevisionConflict,
  CHAIN_ARRANGE_EXTENSION_ID,
  applyChainArrangement,
  arrangeOverview,
  getArrangeRun,
  listArrangeRuns,
  planChainArrangement,
  saveArrangeSchema,
  saveArrangeSettings,
} from '../services/chain-arrange.js';
import { isExtensionEnabled } from '../services/extension-state.js';
import { listRouteHistory, loadRouteEvidence, routeKeyOf } from '../services/route-evidence.js';
import { ROUTE_PROBE_EXTENSION_ID, probeRouteNow } from '../services/route-probe.js';

// Dashboard-only (mounted behind requireAuth): the chain arranger's settings,
// previews, manual runs and history, and the per-route evidence it ranks on
// (ADR ARCH-20261026-chain-auto-arrange).
export const chainArrangeRouter = Router();

const issues = (err: z.ZodError) => err.issues.map(e => `${e.path.join('.')}: ${e.message}`).join(', ');
const chainBody = z.object({ chain: z.string().min(1) }).strict();
const routeBody = z.object({ platform: z.string().min(1), modelId: z.string().min(1), endpointScope: z.string() }).strict();

chainArrangeRouter.get('/', (_req: Request, res: Response) => {
  res.json({
    ...arrangeOverview(getDb()),
    extensions: { arrange: isExtensionEnabled(CHAIN_ARRANGE_EXTENSION_ID), probe: isExtensionEnabled(ROUTE_PROBE_EXTENSION_ID) },
  });
});

chainArrangeRouter.put('/', (req: Request, res: Response) => {
  const parsed = saveArrangeSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: { message: issues(parsed.error) } });
    return;
  }
  try {
    res.json({ settings: saveArrangeSettings(getDb(), parsed.data) });
  } catch (err) {
    if (err instanceof ArrangeRevisionConflict) {
      res.status(409).json({ error: { message: err.message, type: 'revision_conflict', current: err.current } });
      return;
    }
    throw err;
  }
});

chainArrangeRouter.post('/preview', (req: Request, res: Response) => {
  const parsed = chainBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: { message: issues(parsed.error) } });
    return;
  }
  const plan = planChainArrangement(parsed.data.chain);
  if (!plan) {
    res.status(404).json({ error: { message: `Unknown chain ${parsed.data.chain}` } });
    return;
  }
  res.json(plan);
});

// An explicit operator action, so it runs on a chain whose auto is off — but
// not while the arranger itself is switched off in Extensions.
chainArrangeRouter.post('/run', (req: Request, res: Response) => {
  const parsed = chainBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: { message: issues(parsed.error) } });
    return;
  }
  if (!isExtensionEnabled(CHAIN_ARRANGE_EXTENSION_ID)) {
    res.status(409).json({ error: { message: 'Chain auto-arrange is switched off in Extensions', type: 'extension_disabled' } });
    return;
  }
  const result = applyChainArrangement(parsed.data.chain, 'manual');
  if (!result) {
    res.status(404).json({ error: { message: `Unknown chain ${parsed.data.chain}` } });
    return;
  }
  res.json(result);
});

chainArrangeRouter.get('/runs', (req: Request, res: Response) => {
  const chain = typeof req.query.chain === 'string' && req.query.chain ? req.query.chain : undefined;
  const limit = Math.min(Math.max(Number(req.query.limit) || 20, 1), 200);
  res.json({ runs: listArrangeRuns(getDb(), chain, limit) });
});

chainArrangeRouter.get('/runs/:id', (req: Request, res: Response) => {
  const run = getArrangeRun(Number(req.params.id));
  if (!run) {
    res.status(404).json({ error: { message: `No run ${req.params.id}` } });
    return;
  }
  res.json({ run });
});

chainArrangeRouter.get('/route-history', (req: Request, res: Response) => {
  const parsed = routeBody.extend({ days: z.coerce.number().int().min(1).max(365).default(90) }).safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: { message: issues(parsed.error) } });
    return;
  }
  const { days, ...route } = parsed.data;
  const db = getDb();
  res.json({ ...listRouteHistory(route, days, db), evidence: loadRouteEvidence(db).get(routeKeyOf(route)) ?? null });
});

chainArrangeRouter.post('/probe', async (req: Request, res: Response) => {
  const parsed = routeBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: { message: issues(parsed.error) } });
    return;
  }
  res.json(await probeRouteNow(parsed.data));
});
