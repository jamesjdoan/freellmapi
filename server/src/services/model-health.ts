// model-health — does this route actually answer?
//
// Separate from provider health (is the KEY good) and from quota (is there room
// RIGHT NOW). This asks the third question, the one that had no answer on the
// Keys pane: has this model ever served us, and if it last refused, was it a
// refusal that time will fix?
//
// It exists because dead routes were being enabled and chained by hand, and
// nothing on screen distinguished them from working ones. Live examples from a
// single afternoon on this install:
//
//   groq/qwen3.8-27b        403 blocked at the organization level
//   opencode/hy3-free       401 model not supported — removed from the roster
//   opencode/muse-spark-…   500 on every attempt for six days
//   opencode/ling-3.0-flash-free   the id itself was wrong
//
// Each sat enabled in a chain, consuming a failover attempt on every request
// that reached it.
//
// Verdicts come from attempt history — the proxy already records every call —
// so a model that has been used needs no probe at all. `probeModel` is for the
// rest: one four-token call, the cheapest question that gets a real answer.
import type { Db } from '../db/types.js';
import { getDb } from '../db/index.js';
import { getProvider } from '../providers/index.js';
import type { Platform } from '@freellmapi/shared/types.js';
import { decrypt } from '../lib/crypto.js';
import { parseModelScope, scopeAllows } from '../lib/model-scope.js';
import {
  isModelNotFoundError,
  isModelAccessForbiddenError,
  isRateLimitSignal,
  isRetryableError,
} from '../lib/error-classify.js';

/**
 * What a verdict means for the decision the operator is making.
 *
 * The split that matters is `dead` vs `limited`: both are failures, and only
 * one of them is a reason not to enable the route. A 429 says "not now"; a 403
 * says "not ever, until something outside this app changes".
 */
export type ModelHealthVerdict =
  /** Served a real response. */
  | 'ok'
  /** Refused in a way no amount of waiting fixes: 401/403/404, or a 5xx that
   *  has never once succeeded. Enabling it spends a failover slot on nothing. */
  | 'dead'
  /** Rate-limited or briefly unavailable. The route works; the allowance does
   *  not, right now. */
  | 'limited'
  /** Never called. Not evidence of anything — and must not be shown as if it
   *  were, which is the same unknown-is-not-zero rule the quota ledger keeps. */
  | 'untested';

/**
 * A short, stable reason code.
 *
 * The verdict says whether to enable a route; the code says WHY in a form that
 * fits beside a model name and can be looked up in one legend. Deliberately
 * few: an operator scanning forty rows needs to group them, not to read forty
 * different sentences. The provider's own words stay on hover for the one row
 * that matters.
 */
export type ModelHealthCode =
  /** Served. */
  | 'OK'
  /** Allowance spent — the route works, the quota does not. */
  | 'E429'
  /** The account may not use this model: 403 org-level block, 402. */
  | 'E403'
  /** The provider does not know this id: 404, or a 401 naming the model. */
  | 'E404'
  /** The credential was rejected, which is about the KEY, not the model. */
  | 'E401'
  /** The provider broke: 5xx. */
  | 'E5XX'
  /** We stopped waiting. Says nothing about the model. */
  | 'ETIME'
  /** Refused for a reason none of the above covers. */
  | 'EOTHER';

export interface ModelHealthRow {
  platform: string;
  modelId: string;
  verdict: ModelHealthVerdict;
  code: ModelHealthCode | null;
  /** The provider's own words, truncated. An operator deciding whether to
   *  enable a route needs the reason, not a colour. */
  detail: string | null;
  lastCheckedAtMs: number | null;
  successes: number;
  failures: number;
}

/** How far back attempts are counted. Long enough that a model used weekly
 *  still has a verdict, short enough that a provider fixing an outage shows up
 *  within days rather than being outvoted by a month of old failures. */
const HISTORY_DAYS = 14;
const DETAIL_CHARS = 160;

/**
 * Classify one failure. Ordered by how much authority the signal carries: a
 * rate limit is a statement about NOW, so it is read before the permanent
 * refusals even though its status code is numerically larger.
 */
export function verdictForError(err: unknown): Exclude<ModelHealthVerdict, 'ok' | 'untested'> {
  if (isRateLimitSignal(err)) return 'limited';
  if (isModelNotFoundError(err) || isModelAccessForbiddenError(err)) return 'dead';
  const status = typeof (err as { status?: unknown })?.status === 'number' ? (err as { status: number }).status : 0;
  if (status === 401 || status === 402) return 'dead';
  // A transport wobble is not a dead model. Everything else — a 400 the model
  // itself rejected, a 5xx that keeps coming — is.
  return isRetryableError(err) ? 'limited' : 'dead';
}

/**
 * Read the code off a stored error string. Ordered by authority, not by status
 * number: a rate limit is a statement about now and is read first, and a model
 * named in a 401 ("Model hy3-free is not supported") is a missing model rather
 * than a bad key.
 */
export function codeForErrorText(text: string | null): ModelHealthCode {
  const t = (text ?? '').toLowerCase();
  if (!t) return 'EOTHER';
  if (/\b429\b|rate.?limit|usage limit|quota exceeded/.test(t)) return 'E429';
  if (/abort|timed? ?out|econnreset|socket|network|fetch failed|terminated/.test(t)) return 'ETIME';
  // "Upstream request failed: Model is unavailable" arrives as a 400 and names
  // the MODEL, so it is read before the generic upstream/5xx rule — which
  // otherwise claimed a provider outage for a route that simply is not served.
  if (/\b404\b|not supported|unknown model|does not exist|no such model|model_not_found|model is unavailable|model unavailable/.test(t)) return 'E404';
  if (/\b403\b|blocked at the organization|not authorized|forbidden/.test(t)) return 'E403';
  if (/\b402\b|insufficient|payment required|balance/.test(t)) return 'E403';
  if (/\b401\b|invalid api key|unauthorized/.test(t)) return 'E401';
  if (/\b5\d\d\b|internal server error|bad gateway|upstream/.test(t)) return 'E5XX';
  return 'EOTHER';
}

function verdictFromCounts(successes: number, failures: number, lastError: string | null): ModelHealthVerdict {
  if (successes === 0 && failures === 0) return 'untested';
  // One success outranks any number of failures: the route demonstrably works,
  // and what follows is a quota or availability story the quota panel owns.
  if (successes > 0) return 'ok';
  const text = (lastError ?? '').toLowerCase();
  if (/\b429\b|rate.?limit|quota|usage limit/.test(text)) return 'limited';
  // A timeout is not a verdict about the route. `big-pickle` was marked dead
  // off "The operation was aborted (opencode, chat, 60s)" — a slow answer we
  // stopped waiting for, and the same model served a direct probe seconds
  // later. Transport failures say something about the minute, not the model.
  if (/abort|timed? ?out|econnreset|socket|network|fetch failed|terminated/.test(text)) return 'limited';
  return 'dead';
}

/**
 * Verdict per model for one platform, from attempt history.
 *
 * Reads `requests`, which the proxy writes for every call including failures —
 * so a model in daily use is judged on real traffic rather than on a synthetic
 * ping that proves less.
 */
export function listModelHealth(platform: string, db: Db = getDb()): ModelHealthRow[] {
  const since = new Date(Date.now() - HISTORY_DAYS * 86_400_000).toISOString().replace('T', ' ').slice(0, 19);
  const rows = db.prepare(`
    SELECT r.model_id,
           SUM(CASE WHEN r.status = 'success' THEN 1 ELSE 0 END) AS successes,
           SUM(CASE WHEN r.status = 'success' THEN 0 ELSE 1 END) AS failures,
           MAX(r.created_at) AS last_at,
           (SELECT r2.error FROM requests r2
             WHERE r2.platform = r.platform AND r2.model_id = r.model_id AND r2.error IS NOT NULL
             ORDER BY r2.id DESC LIMIT 1) AS last_error
      FROM requests r
     WHERE r.platform = ? AND r.created_at >= ?
     GROUP BY r.model_id
  `).all(platform, since) as {
    model_id: string; successes: number; failures: number; last_at: string | null; last_error: string | null;
  }[];

  return rows.map(row => {
    const verdict = verdictFromCounts(row.successes, row.failures, row.last_error);
    return {
    platform,
    modelId: row.model_id,
    verdict,
    code: verdict === 'ok' ? 'OK' as const : verdict === 'untested' ? null : codeForErrorText(row.last_error),
    detail: row.successes > 0 ? null : row.last_error?.slice(0, DETAIL_CHARS) ?? null,
    lastCheckedAtMs: row.last_at ? Date.parse(`${row.last_at.replace(' ', 'T')}Z`) : null,
    successes: row.successes,
    failures: row.failures,
    };
  });
}

export interface ProbeResult {
  modelId: string;
  verdict: ModelHealthVerdict;
  code: ModelHealthCode | null;
  detail: string | null;
  latencyMs: number | null;
}

/** Four, not one: several relays enforce a floor above 1 and 400 the request
 *  outright, which would report a working model as broken (#903). */
const PROBE_MAX_TOKENS = 4;

/**
 * Ask one model, once, whether it answers.
 *
 * Recorded in `requests` like any other call, so the verdict above sees it and
 * the probe is not a separate truth that can disagree with traffic. Deliberately
 * tiny: the point is reachability, not quality, and a free allowance should not
 * be spent proving a route exists.
 */
export async function probeModel(platform: string, modelId: string, db: Db = getDb()): Promise<ProbeResult> {
  const provider = getProvider(platform as Platform);
  if (!provider) return { modelId, verdict: 'dead', code: 'EOTHER', detail: `No provider registered for ${platform}`, latencyMs: null };

  const keys = db.prepare(`
    SELECT id, encrypted_key, iv, auth_tag, model_scope_json
      FROM api_keys
     WHERE platform = ? AND enabled = 1 AND status IN ('healthy', 'unknown')
  `).all(platform) as { id: number; encrypted_key: string; iv: string; auth_tag: string; model_scope_json: string | null }[];

  const usable = keys.find(k => scopeAllows(parseModelScope(k.model_scope_json), modelId));
  // No key is not a verdict about the MODEL. Saying "dead" here would blame the
  // route for a missing credential.
  if (!usable) return { modelId, verdict: 'untested', code: null, detail: 'No enabled key is scoped to this model', latencyMs: null };

  const apiKey = decrypt(usable.encrypted_key, usable.iv, usable.auth_tag);
  const startedAt = Date.now();
  const record = db.prepare(`
    INSERT INTO requests (platform, model_id, key_id, status, input_tokens, output_tokens, latency_ms, error, created_at)
    VALUES (?, ?, ?, ?, 0, 0, ?, ?, datetime('now'))
  `);

  try {
    await provider.chatCompletion(apiKey, [{ role: 'user', content: 'ping' }], modelId, {
      max_tokens: PROBE_MAX_TOKENS,
      timeoutMs: 30_000,
    });
    const latencyMs = Date.now() - startedAt;
    record.run(platform, modelId, usable.id, 'success', latencyMs, null);
    return { modelId, verdict: 'ok', code: 'OK', detail: null, latencyMs };
  } catch (err) {
    const latencyMs = Date.now() - startedAt;
    const message = (err as Error)?.message ?? String(err);
    const verdict = verdictForError(err);
    record.run(platform, modelId, usable.id, verdict === 'limited' ? 'rate_limited' : 'error', latencyMs, message.slice(0, 500));
    return { modelId, verdict, code: codeForErrorText(message), detail: message.slice(0, DETAIL_CHARS), latencyMs };
  }
}
