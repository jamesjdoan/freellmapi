// Temporary bonus grants (ADR ARCH-20261016-xkiro-allowance-and-temporary-bonus).
//
// A grant is extra provider capacity on top of a normal daily allowance, held
// by one account (a set of keys that share it). The operator spends it through
// a spending window — a quantity and a duration — so a 30-day pool can be
// rationed instead of drained on the first busy afternoon.
//
// Order of consumption, per grant, per request:
//   1. The normal daily allowance, every day, until it is spent.
//   2. Only the part of a request beyond it is excess. Excess needs an open
//      spending window and is debited from the window AND the pool, once.
//   3. No window, a spent window, a spent pool, or an expired grant: the route
//      is held to the normal allowance, exactly as if there were no grant.
//
// What this module never does:
//   - override a provider refusal. A 429 still benches the key through the
//     cooldown path; a grant only stops OUR normal-allowance gates from
//     refusing a request the operator has funded.
//   - invent a cost. Only requests and tokens are countable here. Credits and
//     money need the actual price of a request, which nothing in this install
//     meters, so they are refused at creation rather than tracked as zero.
//
// Persistence: grants, windows and the debit ledger are rows. Consumption is
// only ever the ledger's sum, so an edit to a grant can never reset it. The
// reservations held by requests still in flight are memory-only, like the
// rate-limit leases they ride on: a restart ends those requests, so there is
// nothing to restore and nothing to strand.

import { getDb } from '../db/index.js';
import type { Db } from '../db/types.js';
import type {
  BonusAllowanceStatus,
  BonusAllowanceView,
  BonusGrantView,
  BonusMetric,
  BonusPoolStatus,
  CreateBonusAllowanceInput,
  CreateBonusGrantInput,
  UpdateBonusGrantInput,
} from '@freellmapi/shared/bonus-types.js';
import { resolveQuotaWindow, parseStoredUtc, HOUR_MS, MINUTE_MS } from './quota-clock.js';
import { isValidTimezone } from './scoring.js';
import { endpointScopeForBaseUrl } from '../lib/endpoint-scope.js';
import { isExtensionEnabled } from './extension-state.js';

export class BonusInputError extends Error {
  constructor(message: string, readonly status: 400 | 404 | 409 = 400) {
    super(message);
  }
}

interface GrantRow {
  id: number;
  label: string;
  platform: string;
  key_ids_json: string;
  metric: BonusMetric;
  quantity: number;
  starts_at_ms: number;
  expires_at_ms: number;
  normal_limit: number;
  timezone: string;
}

interface Grant extends GrantRow {
  keyIds: number[];
}

interface AllowanceRow {
  id: number;
  grant_id: number;
  quantity: number;
  starts_at_ms: number;
  expires_at_ms: number;
  cancelled_at_ms: number | null;
}

function toGrant(row: GrantRow): Grant {
  let keyIds: number[] = [];
  try {
    const parsed = JSON.parse(row.key_ids_json) as unknown;
    if (Array.isArray(parsed)) keyIds = parsed.filter((v): v is number => Number.isInteger(v));
  } catch {
    // A malformed row covers no key rather than taking routing down.
  }
  return { ...row, keyIds };
}

// ── Grant lookup (memoised: consulted for every candidate key) ───────────────

const GRANT_CACHE_TTL_MS = 5_000;
let grantCache: { db: Db; at: number; grants: Grant[] } | null = null;

function invalidateGrantCache(): void {
  grantCache = null;
}

/** Every grant that has not yet expired, including ones still to start. */
function liveGrants(db: Db, now: number): Grant[] {
  if (!grantCache || grantCache.db !== db || now - grantCache.at > GRANT_CACHE_TTL_MS) {
    const rows = db.prepare('SELECT * FROM bonus_grants WHERE expires_at_ms > ?').all(now) as GrantRow[];
    grantCache = { db, at: now, grants: rows.map(toGrant) };
  }
  return grantCache.grants;
}

function grantActive(grant: Grant, now: number): boolean {
  return grant.starts_at_ms <= now && now < grant.expires_at_ms;
}

function grantsCovering(db: Db, platform: string, keyId: number, now: number): Grant[] {
  return liveGrants(db, now).filter(g => g.platform === platform && grantActive(g, now) && g.keyIds.includes(keyId));
}

function readGrant(db: Db, id: number): Grant | null {
  const row = db.prepare('SELECT * FROM bonus_grants WHERE id = ?').get(id) as GrantRow | undefined;
  return row ? toGrant(row) : null;
}

function latestAllowance(db: Db, grantId: number): AllowanceRow | null {
  return (db.prepare('SELECT * FROM bonus_allowances WHERE grant_id = ? ORDER BY id DESC LIMIT 1')
    .get(grantId) as AllowanceRow | undefined) ?? null;
}

function grantUsed(db: Db, grantId: number): number {
  const row = db.prepare('SELECT COALESCE(SUM(amount), 0) AS total FROM bonus_usage WHERE grant_id = ?')
    .get(grantId) as { total: number };
  return row.total;
}

function allowanceUsed(db: Db, allowanceId: number): number {
  const row = db.prepare('SELECT COALESCE(SUM(amount), 0) AS total FROM bonus_usage WHERE allowance_id = ?')
    .get(allowanceId) as { total: number };
  return row.total;
}

/** The window that can fund excess right now, or null. Never outlives its grant. */
function openAllowance(db: Db, grant: Grant, now: number): AllowanceRow | null {
  const row = latestAllowance(db, grant.id);
  if (!row || row.cancelled_at_ms != null) return null;
  if (now < row.starts_at_ms || now >= row.expires_at_ms || now >= grant.expires_at_ms) return null;
  return row;
}

// ── In-flight reservations ────────────────────────────────────────────────────

interface Hold {
  grantId: number;
  /** The window that funded the excess at admission; settlement debits it
   *  even if it has since been cancelled, expired or replaced. */
  allowanceId: number | null;
  metric: BonusMetric;
  /** The request's whole estimated cost on this grant's axis. */
  cost: number;
  /** The part of `cost` beyond the normal allowance. */
  excess: number;
}

interface Reservation {
  createdAt: number;
  holds: Hold[];
}

const reservations = new Map<number, Reservation>();

// In-flight counting mirrors the rate-limit lease backstop: a request that has
// not settled in this long no longer holds normal or bonus headroom. The entry
// itself is kept longer so a slow stream still settles against the window that
// admitted it.
const HOLD_COUNTED_MS = 2 * MINUTE_MS;
const HOLD_RETAINED_MS = HOUR_MS;

function pruneReservations(now: number): void {
  for (const [id, r] of reservations) {
    if (now - r.createdAt > HOLD_RETAINED_MS) reservations.delete(id);
  }
}

function inFlight(grantId: number, now: number): { cost: number; excess: number; byAllowance: Map<number, number> } {
  let cost = 0;
  let excess = 0;
  const byAllowance = new Map<number, number>();
  for (const r of reservations.values()) {
    if (now - r.createdAt > HOLD_COUNTED_MS) continue;
    for (const h of r.holds) {
      if (h.grantId !== grantId) continue;
      cost += h.cost;
      excess += h.excess;
      if (h.allowanceId != null) byAllowance.set(h.allowanceId, (byAllowance.get(h.allowanceId) ?? 0) + h.excess);
    }
  }
  return { cost, excess, byAllowance };
}

/** Test seam. */
export function resetBonusReservations(): void {
  reservations.clear();
  invalidateGrantCache();
}

// ── Normal allowance ─────────────────────────────────────────────────────────

interface NormalState {
  limit: number;
  limitSource: 'provider' | 'operator';
  used: number;
  resetAtMs: number;
}

const OBSERVATION_SOURCES = ['header', 'quota_api', 'error_body'];
const OBSERVATION_MIN_CONFIDENCE = 0.7;

function localUsage(db: Db, grant: Grant, sinceMs: number): number {
  if (grant.keyIds.length === 0) return 0;
  const keys = grant.keyIds.map(() => '?').join(', ');
  const sql = grant.metric === 'requests'
    ? `SELECT COUNT(*) AS total FROM rate_limit_usage
        WHERE platform = ? AND kind = 'request' AND created_at_ms >= ? AND key_id IN (${keys})`
    : `SELECT COALESCE(SUM(tokens), 0) AS total FROM rate_limit_usage
        WHERE platform = ? AND kind = 'tokens' AND created_at_ms >= ? AND key_id IN (${keys})`;
  const row = db.prepare(sql).get(grant.platform, sinceMs, ...grant.keyIds) as { total: number };
  return row.total;
}

/**
 * Normal-allowance consumption today, for the account the grant covers.
 *
 * Local usage is what this install sent. A provider observation taken today is
 * better evidence — it also sees other clients on the same account — so its
 * used figure, plus what this install sent after it was taken, wins when
 * larger. Its limit also replaces the operator's figure: the provider's own
 * number is the one it enforces.
 */
function normalState(db: Db, grant: Grant, now: number): NormalState {
  const window = resolveQuotaWindow({ kind: 'calendar_day', timezone: grant.timezone }, now);
  const startMs = window.periodStartMs ?? now;
  const resetAtMs = window.resetAtMs ?? now;
  let used = localUsage(db, grant, startMs);
  let limit = grant.normal_limit;
  let limitSource: NormalState['limitSource'] = 'operator';

  if (grant.keyIds.length > 0) {
    const keys = grant.keyIds.map(() => '?').join(', ');
    const sources = OBSERVATION_SOURCES.map(() => '?').join(', ');
    const rows = db.prepare(`
      SELECT limit_value AS limitValue, remaining_value AS remainingValue, observed_at AS observedAt
        FROM provider_quota_state
       WHERE platform = ?
         AND metric = ?
         AND key_id IN (${keys})
         AND source IN (${sources})
         AND confidence >= ?
         AND limit_value > 0
         AND remaining_value IS NOT NULL
    `).all(
      grant.platform,
      grant.metric === 'requests' ? 'requests' : 'tokens',
      ...grant.keyIds,
      ...OBSERVATION_SOURCES,
      OBSERVATION_MIN_CONFIDENCE,
    ) as Array<{ limitValue: number; remainingValue: number; observedAt: string }>;
    for (const row of rows) {
      const observedMs = parseStoredUtc(row.observedAt);
      if (observedMs == null || observedMs < startMs || observedMs > now) continue;
      // A reported limit can only LOWER the normal allowance. A provider that
      // folds the bonus into its daily figure would otherwise turn the whole
      // pool into "normal" capacity and bypass the spending window.
      if (row.limitValue < limit) {
        limit = row.limitValue;
        limitSource = 'provider';
      }
      const reported = Math.max(0, row.limitValue - row.remainingValue) + localUsage(db, grant, observedMs + 1);
      if (reported > used) used = reported;
    }
  }
  return { limit, limitSource, used, resetAtMs };
}

function beyond(limit: number, used: number): number {
  return Math.max(0, used - limit);
}

// ── Admission ────────────────────────────────────────────────────────────────

export interface BonusFundedAxis {
  metric: BonusMetric;
  /** When the normal allowance this grant extends resets. */
  normalResetMs: number;
}

export interface BonusAdmission {
  admitted: boolean;
  /** Short diagnostic code when refused. */
  reason: string | null;
  holds: Hold[];
  /** Axes on which the request draws on a spending window: the normal
   *  allowance there is expected to be spent, so the gates that enforce it must
   *  not refuse this request. */
  funded: BonusFundedAxis[];
}

const NO_GRANT: BonusAdmission = { admitted: true, reason: null, holds: [], funded: [] };

/**
 * Whether every active grant on this key admits a request of this size.
 *
 * In-flight requests count against both the normal allowance and the windows,
 * so N concurrent requests cannot each see the same headroom.
 */
export function evaluateBonusAdmission(
  platform: string,
  keyId: number,
  estimatedTokens: number,
  now = Date.now(),
  db: Db = getDb(),
): BonusAdmission {
  // `bonus-grants` off: a covered key routes as if it had no grant. Rows stay.
  if (!isExtensionEnabled('bonus-grants')) return NO_GRANT;
  let grants: Grant[];
  try {
    grants = grantsCovering(db, platform, keyId, now);
  } catch {
    // No bonus tables (or no DB) means no grant applies.
    return NO_GRANT;
  }
  if (grants.length === 0) return NO_GRANT;
  pruneReservations(now);

  const holds: Hold[] = [];
  const funded: BonusFundedAxis[] = [];
  for (const grant of grants) {
    const cost = grant.metric === 'requests' ? 1 : Math.max(0, estimatedTokens);
    const normal = normalState(db, grant, now);
    const flying = inFlight(grant.id, now);
    const base = normal.used + flying.cost;
    const excess = beyond(normal.limit, base + cost) - beyond(normal.limit, base);
    if (excess <= 0) {
      holds.push({ grantId: grant.id, allowanceId: null, metric: grant.metric, cost, excess: 0 });
      continue;
    }

    const poolLeft = grant.quantity - grantUsed(db, grant.id) - flying.excess;
    if (poolLeft < excess) return refuse('bonus-pool-spent');
    const window = openAllowance(db, grant, now);
    if (!window) return refuse('no-spending-window');
    const windowLeft = window.quantity - allowanceUsed(db, window.id) - (flying.byAllowance.get(window.id) ?? 0);
    if (windowLeft < excess) return refuse('spending-window-spent');

    holds.push({ grantId: grant.id, allowanceId: window.id, metric: grant.metric, cost, excess });
    funded.push({ metric: grant.metric, normalResetMs: normal.resetAtMs });
  }
  return { admitted: true, reason: null, holds, funded };
}

function refuse(reason: string): BonusAdmission {
  return { admitted: false, reason, holds: [], funded: [] };
}

/**
 * Whether a funded window covers an exhausted normal allowance on this axis.
 * Matches on metric and on the reset instant (within an hour, which absorbs a
 * provider that reports its reset slightly off midnight), so a per-minute
 * limit on the same axis is still enforced.
 */
export function bonusCoversExhaustion(
  funded: readonly BonusFundedAxis[],
  metric: string,
  resetAtMs: number | null,
): boolean {
  if (funded.length === 0 || resetAtMs == null) return false;
  const axis: BonusMetric | null = metric === 'requests'
    ? 'requests'
    : metric === 'tokens' || metric === 'total_tokens' ? 'total_tokens' : null;
  if (!axis) return false;
  return funded.some(f => f.metric === axis && Math.abs(f.normalResetMs - resetAtMs) <= HOUR_MS);
}

/** Hold the admitted request's normal and bonus headroom until it settles. */
export function reserveBonusLease(leaseId: number, admission: BonusAdmission, now = Date.now()): void {
  if (admission.holds.length === 0) return;
  reservations.set(leaseId, { createdAt: now, holds: admission.holds });
}

export function releaseBonusLease(leaseId: number): void {
  reservations.delete(leaseId);
}

export interface BonusSettlement {
  leaseId?: number;
  modelId: string;
  keyId: number;
  requests: number;
  tokens: number;
}

/**
 * Debit the excess a finished attempt actually used, on every grant that
 * admitted it.
 *
 * MUST be called synchronously right after the attempt's usage was written to
 * rate_limit_usage: the excess is the attempt's share of today's usage beyond
 * the normal limit, read from the counts that now include it. Nothing can
 * interleave in between, so concurrent attempts are each charged only for
 * what they pushed past the limit.
 *
 * Only grants that admitted the attempt are charged. A grant that expired
 * mid-flight still settles it, and the window that admitted it is debited even
 * if it was cancelled or replaced. An attempt no grant admitted (an unlimited
 * model, a route chosen before the grant existed) charges nothing.
 */
export function settleBonusUsage(s: BonusSettlement, now = Date.now(), db: Db = getDb()): void {
  const reservation = s.leaseId != null ? reservations.get(s.leaseId) : undefined;
  if (!reservation) return;
  // The attempt's usage is now in rate_limit_usage; holding its estimate too
  // would count it twice until the route is released.
  reservations.delete(s.leaseId!);
  try {
    const insert = db.prepare(`
      INSERT INTO bonus_usage (grant_id, allowance_id, amount, key_id, model_id, created_at_ms)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    for (const hold of reservation.holds) {
      const grant = readGrant(db, hold.grantId);
      if (!grant) continue;
      const cost = grant.metric === 'requests' ? s.requests : s.tokens;
      if (!(cost > 0)) continue;
      const normal = normalState(db, grant, now);
      const excess = beyond(normal.limit, normal.used) - beyond(normal.limit, normal.used - cost);
      if (excess <= 0) continue;
      // Admitted on the normal allowance alone but ran past it (the token
      // estimate was low): the provider drew on the grant all the same, so it
      // is debited, against whatever window is open now.
      const allowanceId = hold.allowanceId ?? openAllowance(db, grant, now)?.id ?? null;
      insert.run(grant.id, allowanceId, excess, s.keyId, s.modelId, now);
    }
  } catch (err) {
    // Settlement must never fail a request the provider already served.
    console.warn('[bonus] settlement failed:', (err as Error).message);
  }
}

// ── Views ────────────────────────────────────────────────────────────────────

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

function allowanceView(db: Db, grant: Grant, row: AllowanceRow, now: number): BonusAllowanceView {
  const used = allowanceUsed(db, row.id);
  const reserved = inFlight(grant.id, now).byAllowance.get(row.id) ?? 0;
  const status: BonusAllowanceStatus = row.cancelled_at_ms != null
    ? 'cancelled'
    : now >= row.expires_at_ms || now >= grant.expires_at_ms
      ? 'expired'
      : used >= row.quantity ? 'exhausted' : 'active';
  return {
    id: row.id,
    quantity: row.quantity,
    used,
    reserved,
    remaining: Math.max(0, row.quantity - used - reserved),
    startsAt: iso(row.starts_at_ms),
    expiresAt: iso(Math.min(row.expires_at_ms, row.cancelled_at_ms ?? Infinity)),
    status,
  };
}

function grantView(db: Db, grant: Grant, now: number): BonusGrantView {
  const used = grantUsed(db, grant.id);
  const reserved = inFlight(grant.id, now).excess;
  const status: BonusPoolStatus = now >= grant.expires_at_ms
    ? 'expired'
    : used >= grant.quantity ? 'exhausted' : 'active';
  const normal = normalState(db, grant, now);
  const allowance = latestAllowance(db, grant.id);
  return {
    id: grant.id,
    label: grant.label,
    platform: grant.platform,
    keyIds: grant.keyIds,
    metric: grant.metric,
    quantity: grant.quantity,
    used,
    reserved,
    remaining: Math.max(0, grant.quantity - used - reserved),
    startsAt: iso(grant.starts_at_ms),
    expiresAt: iso(grant.expires_at_ms),
    status,
    normal: {
      limit: normal.limit,
      limitSource: normal.limitSource,
      used: normal.used,
      remaining: Math.max(0, normal.limit - normal.used),
      resetAt: iso(normal.resetAtMs),
      timezone: grant.timezone,
    },
    allowance: allowance ? allowanceView(db, grant, allowance, now) : null,
    accounting: 'local',
  };
}

export function listBonusGrants(now = Date.now(), db: Db = getDb()): BonusGrantView[] {
  const rows = db.prepare('SELECT * FROM bonus_grants ORDER BY expires_at_ms <= ? ASC, id DESC').all(now) as GrantRow[];
  return rows.map(row => grantView(db, toGrant(row), now));
}

// ── Mutations ────────────────────────────────────────────────────────────────

const MAX_DURATION_HOURS = 24 * 366;

function hoursToMs(hours: number): number {
  return Math.round(hours * HOUR_MS);
}

function requirePositive(value: number, field: string): void {
  if (!Number.isFinite(value) || value <= 0) throw new BonusInputError(`${field} must be a positive number`);
}

function requireDuration(hours: number, field: string): void {
  requirePositive(hours, field);
  if (hours > MAX_DURATION_HOURS) throw new BonusInputError(`${field} must be at most ${MAX_DURATION_HOURS} hours`);
}

/** Every key exists, is on the platform, and shares one endpoint: an account
 *  pool cannot span two custom endpoints. */
function validateKeys(db: Db, platform: string, keyIds: number[]): void {
  if (keyIds.length === 0) throw new BonusInputError('Select at least one key');
  const unique = [...new Set(keyIds)];
  const rows = db.prepare(`SELECT id, platform, base_url FROM api_keys WHERE id IN (${unique.map(() => '?').join(', ')})`)
    .all(...unique) as Array<{ id: number; platform: string; base_url: string | null }>;
  if (rows.length !== unique.length) throw new BonusInputError('One or more keys do not exist');
  const scopes = new Set<string>();
  for (const row of rows) {
    if (row.platform !== platform) throw new BonusInputError(`Key ${row.id} belongs to ${row.platform}, not ${platform}`);
    scopes.add(endpointScopeForBaseUrl(row.base_url));
  }
  if (scopes.size > 1) throw new BonusInputError('All keys in one grant must share the same endpoint');
}

/** Two live grants on the same key and metric would each claim the same
 *  normal allowance as theirs to extend. */
function assertNoOverlap(db: Db, platform: string, keyIds: number[], metric: BonusMetric, now: number, excludeId?: number): void {
  const live = db.prepare('SELECT * FROM bonus_grants WHERE platform = ? AND metric = ? AND expires_at_ms > ?')
    .all(platform, metric, now) as GrantRow[];
  for (const row of live) {
    if (row.id === excludeId) continue;
    const other = toGrant(row);
    if (keyIds.some(id => other.keyIds.includes(id))) {
      throw new BonusInputError(`A live grant (#${row.id}) already covers one of these keys for this metric`, 409);
    }
  }
}

function viewOf(db: Db, id: number, now: number): BonusGrantView {
  const grant = readGrant(db, id);
  if (!grant) throw new BonusInputError(`Bonus grant ${id} not found`, 404);
  return grantView(db, grant, now);
}

export function createBonusGrant(input: CreateBonusGrantInput, now = Date.now(), db: Db = getDb()): BonusGrantView {
  if (input.metric !== 'requests' && input.metric !== 'total_tokens') {
    throw new BonusInputError('Only request and token grants can be enforced: credit and money grants need per-request cost metering, which this install does not have');
  }
  requirePositive(input.quantity, 'quantity');
  requireDuration(input.durationHours, 'durationHours');
  requirePositive(input.normalLimit, 'normalLimit');
  if (!isValidTimezone(input.timezone)) throw new BonusInputError(`Unknown timezone: ${input.timezone}`);
  const keyIds = [...new Set(input.keyIds)].sort((a, b) => a - b);
  validateKeys(db, input.platform, keyIds);
  assertNoOverlap(db, input.platform, keyIds, input.metric, now);

  const res = db.prepare(`
    INSERT INTO bonus_grants (label, platform, key_ids_json, metric, quantity, starts_at_ms, expires_at_ms, normal_limit, timezone)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    input.label?.trim() ?? '', input.platform, JSON.stringify(keyIds), input.metric, input.quantity,
    now, now + hoursToMs(input.durationHours), input.normalLimit, input.timezone,
  );
  invalidateGrantCache();
  return viewOf(db, Number(res.lastInsertRowid), now);
}

/** Edits change limits and labels only. Consumption is the ledger, which no
 *  edit touches, and the expiry is always measured from the original start. */
export function updateBonusGrant(id: number, input: UpdateBonusGrantInput, now = Date.now(), db: Db = getDb()): BonusGrantView {
  const grant = readGrant(db, id);
  if (!grant) throw new BonusInputError(`Bonus grant ${id} not found`, 404);

  const quantity = input.quantity ?? grant.quantity;
  requirePositive(quantity, 'quantity');
  const spent = grantUsed(db, id) + inFlight(id, now).excess;
  if (quantity < spent) throw new BonusInputError(`quantity cannot drop below what is already used or in flight (${spent})`);

  let expiresAt = grant.expires_at_ms;
  if (input.durationHours !== undefined) {
    requireDuration(input.durationHours, 'durationHours');
    expiresAt = grant.starts_at_ms + hoursToMs(input.durationHours);
    if (expiresAt > now && grant.expires_at_ms <= now) {
      assertNoOverlap(db, grant.platform, grant.keyIds, grant.metric, now, id);
    }
  }
  const normalLimit = input.normalLimit ?? grant.normal_limit;
  requirePositive(normalLimit, 'normalLimit');
  const label = input.label !== undefined ? input.label.trim() : grant.label;

  db.prepare(`
    UPDATE bonus_grants
       SET label = ?, quantity = ?, expires_at_ms = ?, normal_limit = ?, updated_at = datetime('now')
     WHERE id = ?
  `).run(label, quantity, expiresAt, normalLimit, id);
  invalidateGrantCache();
  return viewOf(db, id, now);
}

/**
 * Open a spending window, closing any open one. The new window draws on what
 * the pool has left: it never refills the pool and never moves its expiry.
 */
export function openBonusAllowance(grantId: number, input: CreateBonusAllowanceInput, now = Date.now(), db: Db = getDb()): BonusGrantView {
  const grant = readGrant(db, grantId);
  if (!grant) throw new BonusInputError(`Bonus grant ${grantId} not found`, 404);
  if (!grantActive(grant, now)) throw new BonusInputError('The grant has expired');
  requirePositive(input.quantity, 'quantity');
  requireDuration(input.durationHours, 'durationHours');

  const poolLeft = grant.quantity - grantUsed(db, grantId) - inFlight(grantId, now).excess;
  if (input.quantity > poolLeft) {
    throw new BonusInputError(`The window (${input.quantity}) is larger than what the pool has left (${Math.max(0, poolLeft)})`);
  }
  const expiresAt = now + hoursToMs(input.durationHours);
  if (expiresAt > grant.expires_at_ms) {
    throw new BonusInputError(`The window would outlast the grant, which expires ${iso(grant.expires_at_ms)}`);
  }

  db.transaction(() => {
    db.prepare(`
      UPDATE bonus_allowances SET cancelled_at_ms = ?
       WHERE grant_id = ? AND cancelled_at_ms IS NULL AND expires_at_ms > ?
    `).run(now, grantId, now);
    db.prepare('INSERT INTO bonus_allowances (grant_id, quantity, starts_at_ms, expires_at_ms) VALUES (?, ?, ?, ?)')
      .run(grantId, input.quantity, now, expiresAt);
  })();
  return viewOf(db, grantId, now);
}

/** Close the open window. Requests already in flight still settle against it. */
export function closeBonusAllowance(grantId: number, now = Date.now(), db: Db = getDb()): BonusGrantView {
  if (!readGrant(db, grantId)) throw new BonusInputError(`Bonus grant ${grantId} not found`, 404);
  db.prepare(`
    UPDATE bonus_allowances SET cancelled_at_ms = ?
     WHERE grant_id = ? AND cancelled_at_ms IS NULL AND expires_at_ms > ?
  `).run(now, grantId, now);
  return viewOf(db, grantId, now);
}
