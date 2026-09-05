import crypto from 'crypto';
import { getDb } from '../db/index.js';
import { decrypt } from '../lib/crypto.js';
import { resolveProvider, hasProvider } from '../providers/index.js';
import { recordRequest, recordTokens } from './ratelimit.js';
import { recordLearnedCeiling, runWithQuotaObservationContext, inferQuotaPoolKey } from './provider-quota.js';
import type { Scheduler } from '../lib/scheduler.js';
import { MINUTE_MS, HOUR_MS, DAY_MS } from './quota-clock.js';

// Deliberate limit discovery: spend a provider's allowance until it refuses, so
// we learn what the allowance IS.
//
// Most of the catalogue publishes no limit, no remaining and no reset. Passive
// inference gets us the window CLASS (quota-inference.ts) and a ceiling when a
// 429 happens to land during real traffic (recordLearnedCeiling), but neither
// answers "what is the number" on demand. Reaching the limit on purpose does.
//
// Two things about this are load-bearing enough to state before the code:
//
// 1. IT DOES NOT USE THE FALLBACK LOOP. Every request goes straight to
//    provider.chatCompletion, the way probeEndpointModel already does
//    (model-discovery.ts:534). That single choice is what makes the feature
//    safe: the loop's failure paths bench the key, permanently retire the model
//    after two corroborations, feed reliability and latency scoring, and let
//    learnLimitFromError overwrite the catalogue's own rpm/rpd/tpm/tpd. A burn
//    run is a deliberate 429 storm, so routed through the loop it would take
//    the provider out of live service as its first act.
//
// 2. IT DISCOVERS THE TIGHTEST BINDING LIMIT, not every limit. Sent at speed
//    against NVIDIA it finds the 40 RPM cap, not a daily cap, because the
//    minute limit binds first — reaching a daily allowance by brute force would
//    take tens of thousands of requests. Which limit was hit is then revealed
//    by how long the refusal LASTS: clears in a minute and it was per-minute;
//    still refusing hours later and it was daily. Pacing below a known
//    per-minute cap (`intervalMs`) is how an operator hunts the longer one.

export type BurnPhase = 'burning' | 'recovering' | 'complete' | 'cancelled' | 'failed';
export type BurnMaxPeriod = 'day' | 'week' | 'month';

/** How long recovery polling is willing to wait before giving up on a run. A
 *  monthly pool can legitimately take a month to come back, and a poller with
 *  no horizon would watch a dead experiment forever. */
const PERIOD_HORIZON_MS: Record<BurnMaxPeriod, number> = {
  day: 30 * HOUR_MS,
  week: 8 * DAY_MS,
  month: 32 * DAY_MS,
};

/** Ceilings on what one run may spend. An operator picks within these; nothing
 *  can ask for more. Free allowances are small and irreplaceable until reset. */
export const BURN_LIMITS = {
  maxRequests: 500,
  maxSeconds: 900,
} as const;

/** Smallest completion the provider will still count. A burn test is looking
 *  for the request ceiling, so every token it spends beyond proving the call
 *  happened is waste. */
const BURN_PROMPT = 'hi';
const BURN_MAX_TOKENS = 1;

export interface BurnRun {
  id: string;
  platform: string;
  modelId: string;
  keyId: number | null;
  phase: BurnPhase;
  maxRequests: number;
  maxSeconds: number;
  maxPeriod: BurnMaxPeriod;
  requestsSent: number;
  requestsSucceeded: number;
  tokensSpent: number;
  refusedAt: string | null;
  refusalStatus: number | null;
  refusalError: string | null;
  recoveredAt: string | null;
  observedPeriod: string | null;
  failureError: string | null;
  startedAt: string;
  updatedAt: string;
}

interface BurnRunRow {
  id: string;
  platform: string;
  model_id: string;
  key_id: number | null;
  phase: string;
  max_requests: number;
  max_seconds: number;
  max_period: string;
  requests_sent: number;
  requests_succeeded: number;
  tokens_spent: number;
  refused_at: string | null;
  refusal_status: number | null;
  refusal_error: string | null;
  recovered_at: string | null;
  observed_period: string | null;
  failure_error: string | null;
  started_at: string;
  updated_at: string;
}

function toRun(row: BurnRunRow): BurnRun {
  return {
    id: row.id,
    platform: row.platform,
    modelId: row.model_id,
    keyId: row.key_id,
    phase: row.phase as BurnPhase,
    maxRequests: row.max_requests,
    maxSeconds: row.max_seconds,
    maxPeriod: row.max_period as BurnMaxPeriod,
    requestsSent: row.requests_sent,
    requestsSucceeded: row.requests_succeeded,
    tokensSpent: row.tokens_spent,
    refusedAt: row.refused_at,
    refusalStatus: row.refusal_status,
    refusalError: row.refusal_error,
    recoveredAt: row.recovered_at,
    observedPeriod: row.observed_period,
    failureError: row.failure_error,
    startedAt: row.started_at,
    updatedAt: row.updated_at,
  };
}

export function listBurnRuns(platform?: string): BurnRun[] {
  const db = getDb();
  const rows = (platform
    ? db.prepare('SELECT * FROM quota_burn_run WHERE platform = ? ORDER BY started_at DESC LIMIT 50').all(platform)
    : db.prepare('SELECT * FROM quota_burn_run ORDER BY started_at DESC LIMIT 50').all()) as BurnRunRow[];
  return rows.map(toRun);
}

export function getBurnRun(id: string): BurnRun | null {
  const row = getDb().prepare('SELECT * FROM quota_burn_run WHERE id = ?').get(id) as BurnRunRow | undefined;
  return row ? toRun(row) : null;
}

/** A run still spending or still waiting to recover. One per platform: two
 *  concurrent burns on the same account cannot attribute the refusal, and their
 *  counts would each be wrong by the other's traffic. */
export function activeBurnRun(platform: string): BurnRun | null {
  const row = getDb().prepare(`
    SELECT * FROM quota_burn_run
     WHERE platform = ? AND phase IN ('burning', 'recovering')
     ORDER BY started_at DESC LIMIT 1
  `).get(platform) as BurnRunRow | undefined;
  return row ? toRun(row) : null;
}

export function cancelBurnRun(id: string): BurnRun | null {
  const db = getDb();
  // Cancellation is cooperative: the burn loop re-reads its own phase between
  // requests, so a cancel lands after at most one more call rather than
  // aborting a request already in flight.
  db.prepare(`
    UPDATE quota_burn_run SET phase = 'cancelled', updated_at = datetime('now')
     WHERE id = ? AND phase IN ('burning', 'recovering')
  `).run(id);
  return getBurnRun(id);
}

interface KeyRow { id: number; encrypted_key: string; iv: string; auth_tag: string; base_url: string | null }

/** A relay's upstream lives on its own api_keys row, so the provider must be
 *  resolved per key rather than looked up by platform alone — `getProvider`
 *  returns a 'custom' singleton bound to no endpoint at all. */
interface BurnKey { keyId: number; apiKey: string; baseUrl: string | null }

function resolveKey(platform: string): BurnKey | null {
  const row = getDb().prepare(`
    SELECT id, encrypted_key, iv, auth_tag, base_url FROM api_keys
     WHERE platform = ? AND enabled = 1 AND status != 'invalid'
     ORDER BY id LIMIT 1
  `).get(platform) as KeyRow | undefined;
  if (!row) return null;
  try {
    return { keyId: row.id, apiKey: decrypt(row.encrypted_key, row.iv, row.auth_tag), baseUrl: row.base_url };
  } catch {
    return null;
  }
}

function resolveModel(platform: string, requested: string | null): string | null {
  if (requested) return requested;
  const row = getDb().prepare(`
    SELECT model_id FROM models WHERE platform = ? AND enabled = 1 ORDER BY id LIMIT 1
  `).get(platform) as { model_id: string } | undefined;
  return row?.model_id ?? null;
}

export interface StartBurnInput {
  platform: string;
  modelId?: string | null;
  maxRequests: number;
  maxSeconds: number;
  maxPeriod?: BurnMaxPeriod;
  /** Delay between requests. Sending flat out finds the per-minute cap; pacing
   *  under a known one is how a longer window is reached instead. */
  intervalMs?: number;
}

export class BurnStartError extends Error {
  constructor(message: string, readonly status = 400) {
    super(message);
  }
}

/**
 * Create the run and start burning. Returns as soon as the row exists so the
 * caller is not held open for the whole experiment; progress is read back from
 * `listBurnRuns`.
 */
export function startBurnRun(input: StartBurnInput): BurnRun {
  if (!hasProvider(input.platform as never)) {
    throw new BurnStartError(`Unknown platform '${input.platform}'`);
  }
  const existing = activeBurnRun(input.platform);
  if (existing) {
    throw new BurnStartError(`A burn run is already ${existing.phase} on ${input.platform}`, 409);
  }
  const key = resolveKey(input.platform);
  if (!key) {
    throw new BurnStartError(`No usable enabled key for ${input.platform}`);
  }
  const modelId = resolveModel(input.platform, input.modelId ?? null);
  if (!modelId) {
    throw new BurnStartError(`No enabled model for ${input.platform}`);
  }

  const maxRequests = Math.max(1, Math.min(BURN_LIMITS.maxRequests, Math.floor(input.maxRequests)));
  const maxSeconds = Math.max(5, Math.min(BURN_LIMITS.maxSeconds, Math.floor(input.maxSeconds)));
  const maxPeriod = input.maxPeriod ?? 'day';

  const id = crypto.randomUUID();
  getDb().prepare(`
    INSERT INTO quota_burn_run (id, platform, model_id, key_id, phase, max_requests, max_seconds, max_period)
    VALUES (?, ?, ?, ?, 'burning', ?, ?, ?)
  `).run(id, input.platform, modelId, key.keyId, maxRequests, maxSeconds, maxPeriod);

  // Detached on purpose: the HTTP caller gets the run id immediately, and an
  // unhandled rejection here must not take the process down. The promise is
  // retained so a caller that DOES need to know when the burn finished can
  // await it instead of polling the row on a guessed interval.
  const loop = runBurnLoop(id, input.platform, modelId, key, maxRequests, maxSeconds, input.intervalMs ?? 0)
    .catch(err => {
      getDb().prepare(`
        UPDATE quota_burn_run SET phase = 'failed', failure_error = ?, updated_at = datetime('now')
         WHERE id = ? AND phase = 'burning'
      `).run(String(err?.message ?? err).slice(0, 500), id);
    })
    .finally(() => { inFlight.delete(id); });
  inFlight.set(id, loop);

  return getBurnRun(id)!;
}

/** In-flight burn loops, so `burnRunSettled` can await the real completion. */
const inFlight = new Map<string, Promise<void>>();

/** Resolves when the burn phase for `id` has finished, immediately if it
 *  already has. The burn phase only; recovery is the poller's job and outlives
 *  this process. */
export function burnRunSettled(id: string): Promise<void> {
  return inFlight.get(id) ?? Promise.resolve();
}

/** Log the attempt the way the proxy would, but tagged. The tokens really were
 *  spent, so quota counting must see them; the deliberate refusals say nothing
 *  about provider quality, so reliability and organic recovery inference must
 *  not. `request_type = 'burn_test'` is what separates the two. */
function logBurnAttempt(run: { platform: string; modelId: string; keyId: number }, outcome: {
  status: 'success' | 'error';
  inputTokens: number;
  outputTokens: number;
  latencyMs: number;
  error: string | null;
}): void {
  getDb().prepare(`
    INSERT INTO requests (platform, model_id, key_id, status, input_tokens, output_tokens, latency_ms, error, request_type)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'burn_test')
  `).run(run.platform, run.modelId, run.keyId, outcome.status, outcome.inputTokens, outcome.outputTokens,
    outcome.latencyMs, outcome.error);
}

function currentPhase(id: string): BurnPhase | null {
  const row = getDb().prepare('SELECT phase FROM quota_burn_run WHERE id = ?').get(id) as { phase: string } | undefined;
  return (row?.phase as BurnPhase) ?? null;
}

async function runBurnLoop(
  id: string,
  platform: string,
  modelId: string,
  key: BurnKey,
  maxRequests: number,
  maxSeconds: number,
  intervalMs: number,
): Promise<void> {
  const provider = resolveProvider(platform as never, key.baseUrl);
  if (!provider) throw new Error(`No provider endpoint resolved for '${platform}'`);
  const deadline = Date.now() + maxSeconds * 1000;
  const db = getDb();
  let sent = 0;
  let succeeded = 0;
  let tokens = 0;

  for (let i = 0; i < maxRequests; i++) {
    // Cooperative cancellation and the wall-clock cap, both checked before
    // spending anything further.
    if (currentPhase(id) !== 'burning') return;
    if (Date.now() >= deadline) break;

    const startedAt = Date.now();
    try {
      // Sequential by design: parallel requests overshoot the ceiling, and the
      // count at refusal is the whole measurement.
      const response = await runWithQuotaObservationContext(
        { platform: platform as never, keyId: key.keyId, modelId, origin: 'probe' },
        () => provider.chatCompletion(key.apiKey, [{ role: 'user', content: BURN_PROMPT }], modelId, {
          max_tokens: BURN_MAX_TOKENS,
        }),
      );
      sent++;
      succeeded++;
      const inputTokens = response.usage?.prompt_tokens ?? 0;
      const outputTokens = response.usage?.completion_tokens ?? 0;
      tokens += inputTokens + outputTokens;
      logBurnAttempt({ platform, modelId, keyId: key.keyId }, {
        status: 'success', inputTokens, outputTokens, latencyMs: Date.now() - startedAt, error: null,
      });
      // Usage counting must include this: the allowance was genuinely consumed,
      // and local counting that ignores it would report a balance we no longer
      // have.
      recordRequest(platform, modelId, key.keyId);
      if (inputTokens + outputTokens > 0) recordTokens(platform, modelId, key.keyId, inputTokens + outputTokens);
    } catch (err: any) {
      sent++;
      const status: number | undefined = err?.status;
      const message = String(err?.message ?? err).slice(0, 500);
      logBurnAttempt({ platform, modelId, keyId: key.keyId }, {
        status: 'error', inputTokens: 0, outputTokens: 0, latencyMs: Date.now() - startedAt, error: message,
      });
      recordRequest(platform, modelId, key.keyId);

      if (status === 429) {
        // The measurement: how much this account had spent when the provider
        // said no. Recorded as an observation at the lowest precedence rank,
        // never as provider state — see recordLearnedCeiling.
        db.prepare(`
          UPDATE quota_burn_run
             SET phase = 'recovering', requests_sent = ?, requests_succeeded = ?, tokens_spent = ?,
                 refused_at = datetime('now'), refusal_status = 429, refusal_error = ?,
                 updated_at = datetime('now')
           WHERE id = ?
        `).run(sent, succeeded, tokens, message, id);
        try {
          recordLearnedCeiling({
            platform: platform as never,
            keyId: key.keyId,
            quotaPoolKey: inferQuotaPoolKey(platform as never, modelId),
            modelId,
            observedRequests: succeeded,
          });
        } catch { /* the run is still a valid result without the ceiling write */ }
        return;
      }

      // Anything else — auth, network, a model the provider will not serve — is
      // a broken experiment rather than a discovered limit, and must not be
      // reported as one.
      db.prepare(`
        UPDATE quota_burn_run
           SET phase = 'failed', requests_sent = ?, requests_succeeded = ?, tokens_spent = ?,
               failure_error = ?, updated_at = datetime('now')
         WHERE id = ?
      `).run(sent, succeeded, tokens, `HTTP ${status ?? '?'}: ${message}`, id);
      return;
    }

    db.prepare(`
      UPDATE quota_burn_run SET requests_sent = ?, requests_succeeded = ?, tokens_spent = ?,
             updated_at = datetime('now')
       WHERE id = ?
    `).run(sent, succeeded, tokens, id);

    if (intervalMs > 0) await new Promise(resolve => setTimeout(resolve, intervalMs));
  }

  // Never refused. That is a real result — it bounds the limit from BELOW
  // (at least `sent`) without discovering it — and must not be dressed up as a
  // measured ceiling.
  db.prepare(`
    UPDATE quota_burn_run
       SET phase = 'complete', requests_sent = ?, requests_succeeded = ?, tokens_spent = ?,
           updated_at = datetime('now')
     WHERE id = ? AND phase = 'burning'
  `).run(sent, succeeded, tokens, id);
}

/** Recovery time to a window class. Deliberately coarse: the question is which
 *  allowance was hit, and the boundaries are wide enough that our own polling
 *  cadence cannot move an answer between them. */
export function classifyRecovery(elapsedMs: number): string {
  if (elapsedMs <= 5 * MINUTE_MS) return 'minute';
  if (elapsedMs <= 3 * HOUR_MS) return 'hour';
  if (elapsedMs <= 2 * DAY_MS) return 'day';
  if (elapsedMs <= 9 * DAY_MS) return 'week';
  return 'month';
}

/**
 * One pass of the recovery phase: for each refused run, try a single request.
 * A success ends the experiment and dates the window; still being refused just
 * leaves the run for the next pass.
 *
 * This is why the run is a table row. A monthly pool takes a month to come
 * back, and no in-process job survives that.
 */
export async function pollBurnRecovery(now: number = Date.now()): Promise<void> {
  const db = getDb();
  const rows = db.prepare(`
    SELECT * FROM quota_burn_run WHERE phase = 'recovering' AND refused_at IS NOT NULL
  `).all() as BurnRunRow[];

  for (const row of rows) {
    const run = toRun(row);
    const refusedAtMs = Date.parse(`${run.refusedAt!.replace(' ', 'T')}Z`);
    if (!Number.isFinite(refusedAtMs)) continue;
    const elapsed = now - refusedAtMs;

    if (elapsed > PERIOD_HORIZON_MS[run.maxPeriod]) {
      // Waited out the agreed horizon without recovering. Reporting no period
      // is the honest outcome; guessing 'month' from a day-scoped run would
      // manufacture a finding.
      db.prepare(`
        UPDATE quota_burn_run SET phase = 'complete', updated_at = datetime('now') WHERE id = ?
      `).run(run.id);
      continue;
    }

    const key = run.keyId != null ? resolveKeyById(run.keyId) : null;
    if (!key) continue;

    try {
      const provider = resolveProvider(run.platform as never, key.baseUrl);
      if (!provider) continue;
      await runWithQuotaObservationContext(
        { platform: run.platform as never, keyId: key.keyId, modelId: run.modelId, origin: 'probe' },
        () => provider.chatCompletion(key.apiKey, [{ role: 'user', content: BURN_PROMPT }], run.modelId, {
          max_tokens: BURN_MAX_TOKENS,
        }),
      );
      db.prepare(`
        UPDATE quota_burn_run
           SET phase = 'complete', recovered_at = datetime('now'), observed_period = ?,
               updated_at = datetime('now')
         WHERE id = ?
      `).run(classifyRecovery(elapsed), run.id);
      recordRequest(run.platform, run.modelId, key.keyId);
    } catch {
      // Still refused, or a transient failure. Either way the run stays in
      // 'recovering' and the next pass tries again.
    }
  }
}

function resolveKeyById(keyId: number): BurnKey | null {
  const row = getDb().prepare(
    'SELECT id, encrypted_key, iv, auth_tag, base_url FROM api_keys WHERE id = ?',
  ).get(keyId) as KeyRow | undefined;
  if (!row) return null;
  try {
    return { keyId: row.id, apiKey: decrypt(row.encrypted_key, row.iv, row.auth_tag), baseUrl: row.base_url };
  } catch {
    return null;
  }
}

const RECOVERY_SCAN_MS = 60_000;
let cancelRecoveryJob: (() => void) | null = null;
let scanInFlight = false;

export function startBurnRecoveryPoller(scheduler: Scheduler): void {
  if (cancelRecoveryJob) return;
  if (process.env.QUOTA_BURN_DISABLED === '1') {
    console.log('[QuotaBurn] recovery polling disabled via QUOTA_BURN_DISABLED=1');
    return;
  }
  cancelRecoveryJob = scheduler.every(RECOVERY_SCAN_MS, async () => {
    if (scanInFlight) return;
    scanInFlight = true;
    try {
      await pollBurnRecovery();
    } catch (err) {
      console.error('[QuotaBurn] recovery scan failed:', err);
    } finally {
      scanInFlight = false;
    }
  }, { name: 'quota-burn-recovery' });
}

export function stopBurnRecoveryPoller(): void {
  cancelRecoveryJob?.();
  cancelRecoveryJob = null;
  scanInFlight = false;
}
