/**
 * Free CLI-agent fleet telemetry — accept a machine's snapshot, read the fleet.
 *
 * POST /  one machine replaces its own rows
 * GET  /  every machine's current view, for the panel
 *
 * The server checks its own gate. Hiding the panel is presentation; refusing a
 * delivery is enforcement, so the POST returns 404 when the extension is off
 * rather than quietly accepting rows nobody will see.
 *
 * 🛑 OBSERVATION ONLY. Every route these rows describe is one FreeLLM cannot
 * call: Zen's free tier answers 403 to callers outside OpenCode, and Cline's
 * free models are not served through its API. This data must never be joined
 * into routing, fallback, curation or model-picker queries.
 *
 * Reachable only on the loopback bind, like the rest of the dashboard. The
 * second machine delivers over SSH and a host-side reporter posts to
 * 127.0.0.1 — see ARCH-20260922-clifree-fleet-telemetry, which rejected
 * listening on the tailnet because it turns the dashboard into a network
 * service that every later change inherits.
 */
import { Router, type Request, type Response, type NextFunction } from 'express';
import { getDb, getUnifiedApiKey } from '../db/index.js';
import { timingSafeStringEqual } from '../lib/system-prompt.js';
import { isExtensionEnabled } from '../services/extension-state.js';
import { validateSession } from '../services/auth.js';
import {
  parseDelivery,
  recordDelivery,
  listFleet,
  listFleetValue,
  getFleetGroups,
  setFleetLink,
  FleetDeliveryError,
} from '../services/clifree-fleet.js';

/**
 * Session OR unified API key.
 *
 * The rest of `/api/*` takes a dashboard session token and nothing else, which
 * is right for a human at a browser. This endpoint is driven by a SCRIPT on a
 * second machine, and sessions expire after 30 days — so a reporter wired to a
 * timer would authenticate happily and then fail silently a month later, with
 * the panel showing that machine as stale rather than broken. Telemetry that
 * dies quietly is worse than telemetry nobody built, because an empty column
 * reads as "this machine has no free routes".
 *
 * The unified key is already this app's machine-to-machine credential and does
 * not expire. Accepting it here widens nothing meaningful: it can already spend
 * inference on /v1, which is strictly more dangerous than writing telemetry.
 *
 * `url_tokens` was rejected — it exists for tokenized share URLs and explicitly
 * refuses raw unified keys in that context.
 */
function requireSessionOrUnifiedKey(req: Request, res: Response, next: NextFunction): void {
  const token = req.headers.authorization?.replace(/^Bearer\s+/i, '')
    ?? (req.headers['x-dashboard-token'] as string | undefined);
  if (!token) {
    res.status(401).json({ error: 'authentication required' });
    return;
  }
  if (validateSession(token)) { next(); return; }

  const unified = getUnifiedApiKey();
  // Constant-time, like the proxy: a length-or-prefix leak here would help an
  // attacker recover the key that can spend inference.
  if (unified && timingSafeStringEqual(token, unified)) { next(); return; }

  res.status(401).json({ error: 'authentication required' });
}
const EXTENSION_ID = 'clifree-fleet-telemetry';

export const clifreeFleetRouter = Router();

// Applied here, not at the mount, so the mount cannot silently revert to the
// session-only gate the rest of /api/* uses.
clifreeFleetRouter.use(requireSessionOrUnifiedKey);

clifreeFleetRouter.post('/', (req: Request, res: Response) => {
  if (!isExtensionEnabled(EXTENSION_ID)) {
    res.status(404).json({ error: 'clifree fleet telemetry is disabled' });
    return;
  }
  try {
    const delivery = parseDelivery(req.body);
    const stored = recordDelivery(getDb(), delivery);
    // `usage` echoes what the reporter sent, so a machine wired up for the
    // first time can tell "delivered with no usage" from "usage delivered".
    res.json({ machine: delivery.machine, routes: stored, usage: delivery.usage.length });
  } catch (err) {
    if (err instanceof FleetDeliveryError) {
      res.status(400).json({ error: err.message });
      return;
    }
    throw err;
  }
});

clifreeFleetRouter.get('/', (_req: Request, res: Response) => {
  if (!isExtensionEnabled(EXTENSION_ID)) {
    // Rows are retained when the extension is off, so this reports "no fleet"
    // rather than 404: the panel is hidden by the client, and a reader hitting
    // the API directly should see an empty fleet, not a missing endpoint.
    res.json({ routes: [], groups: [], value: [] });
    return;
  }
  const db = getDb();
  // `groups` carries the same routes shaped as comparison entries, so the page
  // can rank and plot them beside the catalogue without a second request or a
  // client-side join it would have to keep in step with the server's shape.
  // `value` is per MACHINE, not per route: the question it answers is "what
  // was this machine given", which no per-row figure states.
  res.json({ routes: listFleet(db), groups: getFleetGroups(db), value: listFleetValue(db) });
});

/**
 * Remap one free route to a different benchmark, or to none.
 *
 * The catalogue's own /api/analysis/link keys on platform+modelId and cannot
 * serve these: a Cline route has no catalogue row at all, which is the same
 * reason its capability needed a synthetic entry in the first place.
 */
clifreeFleetRouter.put('/link', (req: Request, res: Response) => {
  if (!isExtensionEnabled(EXTENSION_ID)) {
    res.status(404).json({ error: 'clifree fleet telemetry is disabled' });
    return;
  }
  const body: unknown = req.body;
  if (typeof body !== 'object' || body === null || !('spec' in body)) {
    res.status(400).json({ error: 'spec is required' });
    return;
  }
  const spec = (body as { spec: unknown }).spec;
  const aaSlug = 'aaSlug' in body ? (body as { aaSlug: unknown }).aaSlug : null;
  if (typeof spec !== 'string' || !spec.includes(':')) {
    res.status(400).json({ error: 'spec must be provider:id' });
    return;
  }
  if (aaSlug !== null && typeof aaSlug !== 'string') {
    res.status(400).json({ error: 'aaSlug must be a string or null' });
    return;
  }
  const db = getDb();
  setFleetLink(db, spec, aaSlug);
  res.json({ groups: getFleetGroups(db) });
});
