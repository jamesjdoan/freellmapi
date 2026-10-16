// Paid credit windows (extension `paid-credit-windows`).
//
// The paid-balance guard keeps automatic routing off every billed model on a
// platform whose free and paid models share one credential (OpenRouter, AnyAPI,
// unorouter). This module is the one bounded exception to it:
//
//   1. The operator SELECTS the paid models automatic routing may use.
//   2. The operator OPENS a credit window on one key — an amount in the
//      provider's balance unit and a duration — with the same typed
//      confirmation that switching the guard off requires.
//   3. Selected models are tried only as a LAST RESORT, after every free
//      route, and only while the window is open and unspent.
//
// Spend is measured, never estimated. A window records the provider-reported
// cumulative usage when it opened; spend is that figure now minus the
// baseline. Catalogue prices (`paid_input_per_m`) are not spend and are never
// used for it. Because a reading lags the request that caused it, a window
// admits ONE paid attempt at a time: after it finishes, the key's balance is
// re-read, and the next paid attempt waits until a reading newer than that
// attempt exists. Overshoot is therefore bounded by one request's cost plus
// any delay in the provider's own accounting.
//
// Only platforms whose usage API reports a credit balance can hold a window
// (today: OpenRouter). Usage by other clients of the same account counts as
// spend, which makes a window stop early, never late.

import { getDb } from '../db/index.js';
import type { Db } from '../db/types.js';
import type {
  OpenPaidCreditWindowInput,
  PaidCreditKeyView,
  PaidCreditOverview,
  PaidCreditWindowStatus,
  PaidCreditWindowView,
  PaidModelOption,
} from '@freellmapi/shared/paid-credit-types.js';
import { hasPaidTier } from './provider-quota.js';
import { platformsWithUsageApi, pollProviderUsageForKey } from './provider-usage-api.js';
import { isExtensionEnabled } from './extension-state.js';
import { PAID_BALANCE_GUARD_ID, PAID_SPEND_CONFIRMATION } from '../data/extension-registry.js';
import { parseStoredUtc } from './quota-clock.js';

export class PaidCreditInputError extends Error {
  constructor(message: string, readonly status: 400 | 404 | 409 | 502 = 400) {
    super(message);
  }
}

const HOUR_MS = 3_600_000;
const MAX_DURATION_HOURS = 24 * 31;
/** A window opens on a balance read at most this long ago. */
const OPENING_READING_MAX_AGE_MS = 2 * 60_000;
/** How long after a paid attempt the balance is re-read, so the provider has
 *  booked the charge before it is measured. */
export const SETTLE_DELAY_MS = 5_000;

/** Platforms whose paid models can be routed through a window: a paid tier on
 *  a shared credential, and a usage API that reports the credit balance. */
export function paidCreditPlatforms(): string[] {
  return platformsWithUsageApi().filter(p => hasPaidTier(p));
}

export function paidCreditActive(): boolean {
  return isExtensionEnabled('paid-credit-windows') && isExtensionEnabled(PAID_BALANCE_GUARD_ID);
}

// ── Balance readings ─────────────────────────────────────────────────────────

interface Balance {
  used: number;
  remaining: number;
  limit: number;
  unit: string;
  observedMs: number;
}

function readBalance(db: Db, platform: string, keyId: number): Balance | null {
  const row = db.prepare(`
    SELECT limit_value AS limitValue, remaining_value AS remainingValue, unit, observed_at AS observedAt
      FROM provider_quota_state
     WHERE platform = ? AND key_id = ? AND quota_pool_key = ? AND metric = 'credits'
       AND source = 'quota_api' AND limit_value IS NOT NULL AND remaining_value IS NOT NULL
  `).get(platform, keyId, `${platform}::credits`) as
    { limitValue: number; remainingValue: number; unit: string | null; observedAt: string } | undefined;
  if (!row || !row.unit) return null;
  const observedMs = parseStoredUtc(row.observedAt);
  if (observedMs == null) return null;
  return {
    used: Math.max(0, row.limitValue - row.remainingValue),
    remaining: row.remainingValue,
    limit: row.limitValue,
    unit: row.unit,
    observedMs,
  };
}

// ── Windows ──────────────────────────────────────────────────────────────────

interface WindowRow {
  id: number;
  platform: string;
  key_id: number;
  unit: string;
  quantity: number;
  baseline_used: number;
  starts_at_ms: number;
  expires_at_ms: number;
  cancelled_at_ms: number | null;
  last_attempt_at_ms: number | null;
}

function latestWindow(db: Db, platform: string, keyId: number): WindowRow | null {
  return (db.prepare('SELECT * FROM paid_credit_windows WHERE platform = ? AND key_id = ? ORDER BY id DESC LIMIT 1')
    .get(platform, keyId) as WindowRow | undefined) ?? null;
}

function spentOf(row: WindowRow, balance: Balance | null): number {
  if (!balance || balance.unit !== row.unit) return 0;
  return Math.max(0, balance.used - row.baseline_used);
}

function statusOf(row: WindowRow, spent: number, now: number): PaidCreditWindowStatus {
  if (row.cancelled_at_ms != null) return 'cancelled';
  if (now >= row.expires_at_ms) return 'expired';
  return spent >= row.quantity ? 'exhausted' : 'active';
}

/** Attempts admitted on each window and not yet finished. Memory only: a
 *  restart ends them, and `last_attempt_at_ms` (persisted) still makes the
 *  next attempt wait for a reading taken after the last one started. */
const inFlight = new Map<number, number>();
const holds = new Map<number, { windowId: number; keyId: number }>();

function awaitingReading(row: WindowRow, balance: Balance | null): boolean {
  if (row.last_attempt_at_ms == null) return false;
  return !balance || balance.observedMs < row.last_attempt_at_ms + SETTLE_DELAY_MS;
}

export interface PaidCreditAdmission {
  admitted: boolean;
  reason: string | null;
  windowId: number | null;
}

/**
 * Whether a selected paid model may be tried on this key right now. Called
 * only for routes the last-resort paid tier added, never for a model the
 * client named.
 */
export function evaluatePaidCredit(platform: string, keyId: number, now = Date.now(), db: Db = getDb()): PaidCreditAdmission {
  const refuse = (reason: string, windowId: number | null = null): PaidCreditAdmission => ({ admitted: false, reason, windowId });
  if (!paidCreditActive()) return refuse('paid-credit-off');
  let row: WindowRow | null;
  let balance: Balance | null;
  try {
    row = latestWindow(db, platform, keyId);
    balance = readBalance(db, platform, keyId);
  } catch {
    return refuse('paid-credit-unreadable');
  }
  if (!row) return refuse('no-credit-window');
  const spent = spentOf(row, balance);
  const status = statusOf(row, spent, now);
  if (status !== 'active') return refuse(`credit-window-${status}`, row.id);
  if (!balance || balance.unit !== row.unit) return refuse('no-credit-reading', row.id);
  if ((inFlight.get(row.id) ?? 0) > 0) return refuse('credit-attempt-in-flight', row.id);
  if (awaitingReading(row, balance)) return refuse('credit-awaiting-reading', row.id);
  return { admitted: true, reason: null, windowId: row.id };
}

const refreshTimers = new Map<number, NodeJS.Timeout>();

/** Hold the window for an admitted attempt. Stamps the attempt durably so a
 *  restart cannot admit the next one on a reading taken before it. */
export function holdPaidCredit(leaseId: number, windowId: number, keyId: number, now = Date.now(), db: Db = getDb()): void {
  holds.set(leaseId, { windowId, keyId });
  inFlight.set(windowId, (inFlight.get(windowId) ?? 0) + 1);
  try {
    db.prepare('UPDATE paid_credit_windows SET last_attempt_at_ms = ? WHERE id = ?').run(now, windowId);
  } catch {
    // The in-memory hold still serialises attempts in this process.
  }
}

/** Release on attempt end (success or failure): stamp it, then re-read the
 *  balance once the provider has had time to book the charge. */
export function releasePaidCredit(leaseId: number, now = Date.now(), db: Db = getDb()): void {
  const hold = holds.get(leaseId);
  if (!hold) return;
  holds.delete(leaseId);
  const left = (inFlight.get(hold.windowId) ?? 1) - 1;
  if (left > 0) inFlight.set(hold.windowId, left);
  else inFlight.delete(hold.windowId);
  try {
    db.prepare('UPDATE paid_credit_windows SET last_attempt_at_ms = ? WHERE id = ?').run(now, hold.windowId);
  } catch {
    // Best effort; the memory state above already blocks a concurrent attempt.
  }
  scheduleRefresh(hold.keyId);
}

function scheduleRefresh(keyId: number): void {
  if (refreshTimers.has(keyId)) return;
  const timer = setTimeout(() => {
    refreshTimers.delete(keyId);
    void pollProviderUsageForKey(keyId).catch(() => 0);
  }, SETTLE_DELAY_MS + 250);
  timer.unref?.();
  refreshTimers.set(keyId, timer);
}

/** Test seam. */
export function resetPaidCreditState(): void {
  inFlight.clear();
  holds.clear();
  for (const t of refreshTimers.values()) clearTimeout(t);
  refreshTimers.clear();
}

// ── Operator actions ─────────────────────────────────────────────────────────

function assertPlatform(platform: string): void {
  if (!paidCreditPlatforms().includes(platform)) {
    throw new PaidCreditInputError(`${platform} cannot hold a credit window: it needs a paid tier and a usage API that reports the credit balance`);
  }
}

export type BalanceReader = (keyId: number) => Promise<unknown>;

/**
 * Open a window. The confirmation is the same phrase that switches the
 * paid-balance guard off: this authorises real spend, so a plain request
 * cannot do it. Re-reads the balance first and refuses on a stale one, since
 * the baseline is what every later spend figure is measured from.
 */
export async function openPaidCreditWindow(
  input: OpenPaidCreditWindowInput,
  now = Date.now(),
  db: Db = getDb(),
  readNow: BalanceReader = pollProviderUsageForKey,
): Promise<PaidCreditKeyView> {
  if (input.confirmation !== PAID_SPEND_CONFIRMATION) {
    throw new PaidCreditInputError(`Type ${PAID_SPEND_CONFIRMATION} to authorise paid spend`);
  }
  assertPlatform(input.platform);
  if (!Number.isFinite(input.quantity) || input.quantity <= 0) throw new PaidCreditInputError('quantity must be a positive number');
  if (!Number.isFinite(input.durationHours) || input.durationHours <= 0 || input.durationHours > MAX_DURATION_HOURS) {
    throw new PaidCreditInputError(`durationHours must be between 0 and ${MAX_DURATION_HOURS}`);
  }
  const key = db.prepare('SELECT id, platform FROM api_keys WHERE id = ?').get(input.keyId) as { id: number; platform: string } | undefined;
  if (!key) throw new PaidCreditInputError(`Key ${input.keyId} not found`, 404);
  if (key.platform !== input.platform) throw new PaidCreditInputError(`Key ${input.keyId} belongs to ${key.platform}, not ${input.platform}`);

  await readNow(input.keyId);
  const balance = readBalance(db, input.platform, input.keyId);
  const opened = Date.now() > now ? Date.now() : now;
  if (!balance || opened - balance.observedMs > OPENING_READING_MAX_AGE_MS) {
    throw new PaidCreditInputError('Could not read a current credit balance for this key, so spend could not be measured. Check the key and the provider-usage-apis extension.', 502);
  }
  if (input.quantity > balance.remaining) {
    throw new PaidCreditInputError(`The window (${input.quantity} ${balance.unit}) is larger than the balance left (${balance.remaining} ${balance.unit})`);
  }

  db.transaction(() => {
    db.prepare(`
      UPDATE paid_credit_windows SET cancelled_at_ms = ?
       WHERE platform = ? AND key_id = ? AND cancelled_at_ms IS NULL AND expires_at_ms > ?
    `).run(opened, input.platform, input.keyId, opened);
    db.prepare(`
      INSERT INTO paid_credit_windows (platform, key_id, unit, quantity, baseline_used, starts_at_ms, expires_at_ms, confirmed_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(input.platform, input.keyId, balance.unit, input.quantity, balance.used, opened,
      opened + Math.round(input.durationHours * HOUR_MS), new Date(opened).toISOString());
  })();
  return keyView(db, input.platform, input.keyId, opened);
}

export function closePaidCreditWindow(id: number, now = Date.now(), db: Db = getDb()): PaidCreditKeyView {
  const row = db.prepare('SELECT * FROM paid_credit_windows WHERE id = ?').get(id) as WindowRow | undefined;
  if (!row) throw new PaidCreditInputError(`Credit window ${id} not found`, 404);
  db.prepare('UPDATE paid_credit_windows SET cancelled_at_ms = ? WHERE id = ? AND cancelled_at_ms IS NULL AND expires_at_ms > ?')
    .run(now, id, now);
  return keyView(db, row.platform, row.key_id, now);
}

// ── Views ────────────────────────────────────────────────────────────────────

function windowView(row: WindowRow, balance: Balance | null, now: number): PaidCreditWindowView {
  const spent = spentOf(row, balance);
  const end = Math.min(row.expires_at_ms, row.cancelled_at_ms ?? Infinity);
  return {
    id: row.id,
    quantity: row.quantity,
    spent,
    remaining: Math.max(0, row.quantity - spent),
    unit: row.unit,
    startsAt: new Date(row.starts_at_ms).toISOString(),
    expiresAt: new Date(end).toISOString(),
    status: statusOf(row, spent, now),
    awaitingReading: (inFlight.get(row.id) ?? 0) > 0 || awaitingReading(row, balance),
  };
}

function keyView(db: Db, platform: string, keyId: number, now: number): PaidCreditKeyView {
  const key = db.prepare('SELECT label FROM api_keys WHERE id = ?').get(keyId) as { label: string | null } | undefined;
  const balance = readBalance(db, platform, keyId);
  const row = latestWindow(db, platform, keyId);
  const selected = db.prepare('SELECT COUNT(*) AS n FROM paid_credit_models WHERE platform = ?').get(platform) as { n: number };
  return {
    keyId,
    keyLabel: key?.label || null,
    platform,
    balance: balance && {
      used: balance.used,
      remaining: balance.remaining,
      limit: balance.limit,
      unit: balance.unit,
      observedAt: new Date(balance.observedMs).toISOString(),
    },
    window: row ? windowView(row, balance, now) : null,
    selectedModels: selected.n,
  };
}

export function paidCreditOverview(now = Date.now(), db: Db = getDb()): PaidCreditOverview {
  const platforms = paidCreditPlatforms();
  const keys = platforms.length === 0 ? [] : db.prepare(`
    SELECT id, platform FROM api_keys WHERE enabled = 1 AND platform IN (${platforms.map(() => '?').join(', ')}) ORDER BY platform, id
  `).all(...platforms) as Array<{ id: number; platform: string }>;
  return {
    keys: keys.map(k => keyView(db, k.platform, k.id, now)),
    platforms,
    guardActive: isExtensionEnabled(PAID_BALANCE_GUARD_ID),
  };
}

// ── Paid model selection ─────────────────────────────────────────────────────

const OPENROUTER_MODELS_URL = 'https://openrouter.ai/api/v1/models';
const LISTING_TTL_MS = 10 * 60_000;
let listingCache: { at: number; models: ListedModel[] } | null = null;

interface ListedModel {
  modelId: string;
  name: string;
  contextLength: number | null;
  promptPerM: number;
  completionPerM: number;
  supportsTools: boolean;
  supportsVision: boolean;
}

function parseListing(body: unknown): ListedModel[] {
  if (!body || typeof body !== 'object' || !('data' in body) || !Array.isArray(body.data)) {
    throw new PaidCreditInputError('OpenRouter returned no model list', 502);
  }
  const out: ListedModel[] = [];
  for (const m of body.data as unknown[]) {
    if (!m || typeof m !== 'object' || !('id' in m) || typeof m.id !== 'string') continue;
    const pricing = 'pricing' in m && m.pricing && typeof m.pricing === 'object' ? m.pricing : null;
    const prompt = Number(pricing && 'prompt' in pricing ? pricing.prompt : NaN);
    const completion = Number(pricing && 'completion' in pricing ? pricing.completion : NaN);
    // Unpriced or free ($0) entries are not paid models; :free ids never are.
    if (!Number.isFinite(prompt) || !Number.isFinite(completion) || prompt + completion <= 0 || m.id.endsWith(':free')) continue;
    const params = 'supported_parameters' in m && Array.isArray(m.supported_parameters) ? m.supported_parameters : [];
    const arch = 'architecture' in m && m.architecture && typeof m.architecture === 'object' ? m.architecture : null;
    const inputs = arch && 'input_modalities' in arch && Array.isArray(arch.input_modalities) ? arch.input_modalities : [];
    const ctx = 'context_length' in m ? Number(m.context_length) : NaN;
    out.push({
      modelId: m.id,
      name: 'name' in m && typeof m.name === 'string' ? m.name : m.id,
      contextLength: Number.isFinite(ctx) && ctx > 0 ? ctx : null,
      promptPerM: prompt * 1_000_000,
      completionPerM: completion * 1_000_000,
      supportsTools: params.includes('tools'),
      supportsVision: inputs.includes('image'),
    });
  }
  return out.sort((a, b) => a.modelId.localeCompare(b.modelId));
}

async function listPaidModels(platform: string, fetchImpl: typeof fetch): Promise<ListedModel[]> {
  // Only OpenRouter publishes priced listings today; any other platform that
  // gains a usage API needs its own listing before it can be offered here.
  if (platform !== 'openrouter') return [];
  if (listingCache && Date.now() - listingCache.at < LISTING_TTL_MS) return listingCache.models;
  let body: unknown;
  try {
    const res = await fetchImpl(OPENROUTER_MODELS_URL, { signal: AbortSignal.timeout(30_000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    body = await res.json();
  } catch (err) {
    throw new PaidCreditInputError(`Could not load OpenRouter's model list: ${(err as Error).message}`, 502);
  }
  const models = parseListing(body);
  listingCache = { at: Date.now(), models };
  return models;
}

/** Test seam. */
export function resetPaidModelListing(): void {
  listingCache = null;
}

export async function paidModelOptions(platform: string, db: Db = getDb(), fetchImpl: typeof fetch = fetch): Promise<PaidModelOption[]> {
  assertPlatform(platform);
  const listed = await listPaidModels(platform, fetchImpl);
  const selected = new Set((db.prepare('SELECT model_id FROM paid_credit_models WHERE platform = ?').all(platform) as Array<{ model_id: string }>)
    .map(r => r.model_id));
  const options = listed.map(m => ({ ...m, selected: selected.has(m.modelId) }));
  // A selection the listing no longer carries still shows, so it can be removed.
  for (const id of selected) {
    if (!listed.some(m => m.modelId === id)) {
      options.push({ modelId: id, name: id, contextLength: null, promptPerM: 0, completionPerM: 0, supportsTools: false, supportsVision: false, selected: true });
    }
  }
  return options;
}

/**
 * Select or deselect a paid model. Selecting ensures a model row exists so the
 * router can dispatch to it (source 'user', so a catalogue sync never prunes
 * it). Deselecting leaves the row: the guard keeps it out of automatic routing
 * on its own, and a client that names it still reaches it, as before.
 */
export async function setPaidModelSelected(
  platform: string,
  modelId: string,
  selected: boolean,
  db: Db = getDb(),
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  assertPlatform(platform);
  if (!selected) {
    db.prepare('DELETE FROM paid_credit_models WHERE platform = ? AND model_id = ?').run(platform, modelId);
    return;
  }
  const listed = (await listPaidModels(platform, fetchImpl)).find(m => m.modelId === modelId);
  if (!listed) throw new PaidCreditInputError(`${modelId} is not a paid model ${platform} currently lists`, 404);
  db.transaction(() => {
    const existing = db.prepare('SELECT id FROM models WHERE platform = ? AND model_id = ? AND endpoint_scope = \'\'').get(platform, modelId) as { id: number } | undefined;
    if (existing) {
      db.prepare('UPDATE models SET enabled = 1 WHERE id = ?').run(existing.id);
    } else {
      db.prepare(`
        INSERT INTO models (platform, model_id, display_name, intelligence_rank, speed_rank, size_label,
          context_window, enabled, supports_vision, supports_tools, paid_input_per_m, paid_output_per_m, source)
        VALUES (?, ?, ?, 999, 999, 'Paid', ?, 1, ?, ?, ?, ?, 'user')
      `).run(platform, modelId, listed.name, listed.contextLength, listed.supportsVision ? 1 : 0, listed.supportsTools ? 1 : 0,
        listed.promptPerM, listed.completionPerM);
    }
    db.prepare('INSERT OR IGNORE INTO paid_credit_models (platform, model_id) VALUES (?, ?)').run(platform, modelId);
  })();
}
