import { Router, type Request, type Response, type NextFunction } from 'express';
import { z } from 'zod';
import { validateSession } from '../services/auth.js';
import { isExtensionEnabled } from '../services/extension-state.js';
import {
  agentTokenStatus,
  deleteExternalLead,
  isAgentToken,
  listExternalLeads,
  mintAgentToken,
  recordExternalLead,
  revokeAgentToken,
  updateExternalLead,
  type LeadActor,
  type LeadWriteResult,
} from '../services/external-model-discovery.js';

// External model discovery: leads found outside the signed catalog.
//
// Two callers. A dashboard session is the operator and may do anything. The
// discovery agent token (minted on the Premium page) is an unattended agent:
// it may list leads, add them, and change or remove only the ones an agent
// recorded, cannot change a status the operator set, and is skipped for any
// model the operator ignored. It authorises nothing outside this router — not inference, not any
// other /api route — which is why it exists instead of reusing the unified key.

const EXTENSION_ID = 'external-model-discovery';

type ActorLocals = { actor: LeadActor };

function resolveActor(req: Request, res: Response<unknown, ActorLocals>, next: NextFunction): void {
  const token = req.headers.authorization?.replace(/^Bearer\s+/i, '')
    ?? (req.headers['x-dashboard-token'] as string | undefined);
  if (validateSession(token)) {
    res.locals.actor = 'user';
  } else if (isAgentToken(token)) {
    res.locals.actor = 'agent';
  } else {
    res.status(401).json({ error: { message: 'Authentication required', type: 'authentication_error' } });
    return;
  }
  if (!isExtensionEnabled(EXTENSION_ID)) {
    res.status(404).json({ error: { message: 'External model discovery is switched off' } });
    return;
  }
  next();
}

function operatorOnly(_req: Request, res: Response<unknown, ActorLocals>, next: NextFunction): void {
  if (res.locals.actor !== 'user') {
    res.status(403).json({ error: { message: 'Only a signed-in operator can manage the agent token' } });
    return;
  }
  next();
}

const LEAD_STATUSES = ['candidate', 'testing', 'verified', 'rejected', 'added', 'ignored'] as const;
const LEAD_KINDS = ['chat', 'embedding', 'image', 'audio', 'transcription', 'video'] as const;

const listSchema = z.object({
  status: z.enum(LEAD_STATUSES).optional(),
  provider: z.string().min(1).optional(),
  limit: z.coerce.number().int().positive().max(200).optional(),
  offset: z.coerce.number().int().nonnegative().optional(),
});

const createSchema = z.object({
  source: z.string().trim().min(1, 'source is required').max(500),
  modelId: z.string().trim().min(1, 'modelId is required').max(256),
  provider: z.string().max(80).nullish(),
  displayName: z.string().max(200).nullish(),
  kind: z.enum(LEAD_KINDS).nullish(),
  status: z.enum(LEAD_STATUSES).optional(),
  notes: z.string().max(4000).nullish(),
});

const patchSchema = z.object({
  provider: z.string().max(80).nullish(),
  displayName: z.string().max(200).nullish(),
  kind: z.enum(LEAD_KINDS).nullish(),
  status: z.enum(LEAD_STATUSES).optional(),
  notes: z.string().max(4000).nullish(),
});

const idSchema = z.coerce.number().int().positive();

const messageOf = (error: z.ZodError) => error.errors.map(e => e.message).join(', ');

function sendResult(res: Response<unknown, ActorLocals>, result: LeadWriteResult): void {
  if (result.ok) {
    res.json(result.lead);
    return;
  }
  switch (result.reason) {
    case 'not_found':
      res.status(404).json({ error: { message: 'No lead with that id' } });
      return;
    case 'not_yours':
      res.status(403).json({ error: { message: 'An operator recorded this lead; the agent token can only change leads an agent recorded' } });
      return;
    case 'operator_only':
      res.status(403).json({ error: { message: 'Only the operator can ignore a model or lift an ignore' } });
      return;
    case 'status_locked':
      res.status(409).json({ error: { message: 'The operator set this status; an agent can add notes but not change it' } });
      return;
    case 'ignored':
      // An agent re-finding an ignored model is normal, not an error to retry:
      // it gets a plain "skipped". An operator adding one is told why it did
      // not appear.
      if (res.locals.actor === 'agent') {
        res.json({ skipped: 'ignored' });
      } else {
        res.status(409).json({ error: { message: 'This model is ignored; un-ignore it first' } });
      }
  }
}

export const discoveryRouter = Router();

// Applied here, not at the mount, so the mount cannot silently revert to the
// session-only gate the rest of /api/* uses.
discoveryRouter.use(resolveActor);

discoveryRouter.get('/leads', (req: Request, res: Response) => {
  const parsed = listSchema.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: { message: messageOf(parsed.error) } });
    return;
  }
  res.json(listExternalLeads(parsed.data));
});

/** Record a lead. (source, modelId) is unique, so re-posting the same finding
 *  updates it — an agent can re-run safely. `addedBy` is the caller's identity,
 *  never a field the caller sets. */
discoveryRouter.post('/leads', (req: Request, res: Response<unknown, ActorLocals>) => {
  const parsed = createSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: { message: messageOf(parsed.error) } });
    return;
  }
  sendResult(res, recordExternalLead(parsed.data, res.locals.actor));
});

discoveryRouter.patch('/leads/:id', (req: Request, res: Response<unknown, ActorLocals>) => {
  const id = idSchema.safeParse(req.params.id);
  if (!id.success) {
    res.status(400).json({ error: { message: 'Invalid lead id' } });
    return;
  }
  const parsed = patchSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: { message: messageOf(parsed.error) } });
    return;
  }
  sendResult(res, updateExternalLead(id.data, parsed.data, res.locals.actor));
});

discoveryRouter.delete('/leads/:id', (req: Request, res: Response<unknown, ActorLocals>) => {
  const id = idSchema.safeParse(req.params.id);
  if (!id.success) {
    res.status(400).json({ error: { message: 'Invalid lead id' } });
    return;
  }
  sendResult(res, deleteExternalLead(id.data, res.locals.actor));
});

discoveryRouter.get('/agent-token', operatorOnly, (_req: Request, res: Response) => {
  res.json(agentTokenStatus());
});

/** Mint (or replace) the agent token. The raw value is in this response and
 *  nowhere else: only its hash is stored. */
discoveryRouter.post('/agent-token', operatorOnly, (_req: Request, res: Response) => {
  res.json(mintAgentToken());
});

discoveryRouter.delete('/agent-token', operatorOnly, (_req: Request, res: Response) => {
  revokeAgentToken();
  res.json(agentTokenStatus());
});
