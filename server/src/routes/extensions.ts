/**
 * Read the extension inventory, and toggle one entry.
 *
 * GET returns registry metadata AND state together, so a client never has to
 * join two payloads to render the list, and never has to guess a default for
 * an id it does not recognise.
 *
 * The server checks its own gates. Hiding a control is presentation; refusing
 * a write is enforcement.
 */
import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { IMPERIUM_EXTENSIONS } from '@freellmapi/shared/extension-registry.js';
import {
  getExtensionState,
  setExtensionEnabled,
  ExtensionStateError,
} from '../services/extension-state.js';

export const extensionsRouter = Router();

extensionsRouter.get('/', (_req: Request, res: Response) => {
  const state = getExtensionState();
  res.json({
    revision: state.revision,
    paidSpendAcknowledgement: state.paidSpendAcknowledgement,
    extensions: IMPERIUM_EXTENSIONS.map(extension => ({
      ...extension,
      enabled: state.enabled[extension.id] === true,
    })),
  });
});

const toggleSchema = z.object({
  enabled: z.boolean(),
  /** Compare-and-set. Omitted = last write wins, for a single-pane operator. */
  expectedRevision: z.number().int().nonnegative().optional(),
  /** Required verbatim to disable a 'paid-spend' extension. */
  confirmation: z.string().optional(),
});

extensionsRouter.put('/:id', (req: Request, res: Response) => {
  const id = String(req.params.id ?? '');
  const parsed = toggleSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: { message: parsed.error.errors[0]?.message ?? 'invalid body' } });
    return;
  }
  try {
    const state = setExtensionEnabled(id, parsed.data.enabled, {
      expectedRevision: parsed.data.expectedRevision,
      confirmation: parsed.data.confirmation,
    });
    res.json({
      revision: state.revision,
      id,
      enabled: state.enabled[id] === true,
      paidSpendAcknowledgement: state.paidSpendAcknowledgement,
    });
  } catch (err) {
    if (err instanceof ExtensionStateError) {
      // 409 for a stale revision so a client refetches rather than retrying
      // blind; 422 for a missing confirmation, which a retry cannot fix.
      const status = err.code === 'unknown_extension' ? 404
        : err.code === 'revision_conflict' ? 409
        : 422;
      res.status(status).json({ error: { message: err.message, code: err.code } });
      return;
    }
    throw err;
  }
});
