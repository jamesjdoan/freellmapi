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
import { z } from 'zod';
import { getDb, getUnifiedApiKey } from '../db/index.js';
import { timingSafeStringEqual } from '../lib/system-prompt.js';
import { isExtensionEnabled } from '../services/extension-state.js';
import { validateSession } from '../services/auth.js';
import { getSinceTimestamp } from './analytics.js';
import {
  parseDelivery,
  recordDelivery,
  listFleet,
  listFleetValue,
  listFleetUsage,
  getFleetGroups,
  setFleetLink,
  FleetDeliveryError,
  FleetLinkError,
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
    // first time can tell "delivered with no usage" from "usage delivered";
    // `usageIgnored` says why dated-less usage from an old reporter was kept out.
    res.json({
      machine: delivery.machine, routes: stored,
      usage: delivery.usage.length, usageIgnored: delivery.usageIgnored,
    });
  } catch (err) {
    if (err instanceof FleetDeliveryError) {
      res.status(400).json({ error: err.message });
      return;
    }
    throw err;
  }
});

clifreeFleetRouter.get('/', (req: Request, res: Response) => {
  if (!isExtensionEnabled(EXTENSION_ID)) {
    // Rows are retained when the extension is off, so this reports "no fleet"
    // rather than 404: the panel is hidden by the client, and a reader hitting
    // the API directly should see an empty fleet, not a missing endpoint.
    res.json({ routes: [], groups: [], value: [], usage: [] });
    return;
  }
  const db = getDb();
  // `?range=` uses the Analytics ranges so the offloaded-inference card can add
  // the fleet to the proxy's own figures for one window. Usage is bucketed by
  // UTC day, so the window starts at the start of the cutoff's day. Absent, the
  // read covers all history — what the Compare page has always shown.
  const sinceDay = typeof req.query.range === 'string'
    ? getSinceTimestamp(req.query.range).slice(0, 10)
    : undefined;
  // `groups` carries the same routes shaped as comparison entries, so the page
  // can rank and plot them beside the catalogue without a second request or a
  // client-side join it would have to keep in step with the server's shape.
  // `value` is per MACHINE ("what was this machine given"); `usage` is per
  // route on a machine ("which models did the work, and how good are they").
  res.json({
    routes: listFleet(db),
    groups: getFleetGroups(db),
    value: listFleetValue(db, sinceDay),
    usage: listFleetUsage(db, sinceDay),
  });
});

/**
 * Remap one free route to a different benchmark, to none, or to a closest
 * match (`proxy: true`) for a model nobody publishes.
 *
 * Writes the same `aa_model_link` row the Keys page writes, keyed on provider
 * and id. That table needs no catalogue row, which a Cline route never has.
 */
const fleetLinkSchema = z.object({
  spec: z.string().includes(':', { message: 'spec must be provider:id' }),
  aaSlug: z.string().nullable().default(null),
  proxy: z.boolean().default(false),
});

clifreeFleetRouter.put('/link', (req: Request, res: Response) => {
  if (!isExtensionEnabled(EXTENSION_ID)) {
    res.status(404).json({ error: 'clifree fleet telemetry is disabled' });
    return;
  }
  const parsed = fleetLinkSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.errors.map(e => e.message).join(', ') });
    return;
  }
  const db = getDb();
  try {
    setFleetLink(db, parsed.data.spec, parsed.data.aaSlug, parsed.data.proxy);
  } catch (err) {
    if (err instanceof FleetLinkError) {
      res.status(400).json({ error: err.message });
      return;
    }
    throw err;
  }
  res.json({ groups: getFleetGroups(db) });
});
