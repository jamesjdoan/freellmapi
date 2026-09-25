import { Router, type Request, type Response } from 'express';
import { getDb } from '../db/index.js';
import {
  RevisionConflict,
  chainRequirements,
  getChainMinimums,
  getRevision,
  listRevisions,
  saveChainMinimums,
  saveSchema,
} from '../services/chain-minimums.js';

// Dashboard-only (mounted behind requireAuth). Reading and saving minimums
// changes recommendations shown in the dashboard and nothing else.
export const chainMinimumsRouter = Router();

chainMinimumsRouter.get('/', (_req: Request, res: Response) => {
  const db = getDb();
  res.json({ doc: getChainMinimums(db), requirements: chainRequirements(), revisions: listRevisions(db) });
});

chainMinimumsRouter.put('/', (req: Request, res: Response) => {
  const parsed = saveSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: { message: parsed.error.issues.map(e => `${e.path.join('.')}: ${e.message}`).join(', ') } });
    return;
  }
  try {
    res.json({ doc: saveChainMinimums(getDb(), parsed.data) });
  } catch (err) {
    if (err instanceof RevisionConflict) {
      res.status(409).json({ error: { message: err.message, type: 'revision_conflict', current: err.current } });
      return;
    }
    throw err;
  }
});

chainMinimumsRouter.get('/revisions/:revision', (req: Request, res: Response) => {
  const n = Number(req.params.revision);
  const doc = Number.isInteger(n) ? getRevision(getDb(), n) : null;
  if (!doc) {
    res.status(404).json({ error: { message: `No revision ${req.params.revision}` } });
    return;
  }
  res.json({ doc });
});
