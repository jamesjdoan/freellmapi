// Per-request attempt trace: the durable record of the failover ladder one
// proxied request walked (groq 429 → google timeout → cerebras ok). The
// fallback loop collects one AttemptTraceRecord per dispatched attempt —
// including the SUCCESSFUL final one — and request-log.ts persists the batch
// into `request_attempts`, keyed to the terminal `requests` row.
//
// The trace travels on AsyncLocalStorage (same pattern as client-context.ts)
// so logRequest() can report back the id of each `requests` row it writes
// without threading a parameter through every surface's dispatch closure.
// The LAST id noted during a loop run is the terminal row — the success row,
// a committed mid-stream error row, or the final per-attempt failure row —
// and that is the row the batch is keyed to. Calls to logRequest outside a
// fallback-loop run (fusion sub-calls, embeddings, media) see no trace and
// are unaffected.

import { AsyncLocalStorage } from 'async_hooks';
import type { AttemptErrorClass } from './fallback-loop.js';

// 'ok'           — the attempt produced the client's response ('done').
// 'committed'    — a stream flushed real bytes, then ended without a clean
//                  finish (mid-stream error the surface rendered honestly, or
//                  a pre-commit client disconnect the surface swallowed); the
//                  parent requests row carries the specifics.
// 'client_abort' — the client hung up mid-attempt; the upstream call was
//                  canceled and no failure bookkeeping ran.
// AttemptErrorClass — the failure class of a failed-and-failed-over attempt.
export type AttemptOutcome = 'ok' | 'committed' | 'client_abort' | AttemptErrorClass;

/**
 * What the router was looking at when it picked this route, recorded AT
 * DECISION TIME.
 *
 * A later `/api/fallback/routing` snapshot cannot answer this. It reports the
 * scores as they are now, on quota that has since moved and with a different
 * set of requests in flight — so it can show that the machinery exists, but it
 * can never show that a particular past request was decided by it. The
 * question an operator actually has ("why did THIS go to Groq") is only
 * answerable if the inputs are captured at the moment of the choice.
 *
 * Every field is a number the scorer already computed and previously threw
 * away. Nothing here is re-derived, so the record cannot disagree with the
 * decision it describes.
 */
export interface RoutingDecisionTrace {
  /** Which ordering rule ran: 'priority' or a bandit preset. */
  strategy: string;
  /** The quota domain this route draws on, e.g. `nvidia::credit-pool`. What
   *  makes a shared allowance legible after the fact. */
  poolKey: string | null;
  /** Scarcity guardrail, ≤1. 1 = the pool had no reason to hold back. */
  scarcity: number;
  /** Reset-urgency preference, ≥1. >1 = an unspent allowance was expiring. */
  harvest: number;
  /** Spreading preference, ≤1. <1 = concurrent work was already on this pool. */
  diversity: number;
  /**
   * This pool's share of the attempts in flight when the choice was made.
   * Null when fewer than two were open — which is the common case, and the
   * reason a "run three curls and watch them differ" test proves nothing:
   * with no concurrency the diversity term is inert by design.
   */
  inFlightShare: number | null;
  /**
   * 1-based position after scoring, and the position the same scoring pass
   * would have produced with the quota-domain guardrail and both preferences
   * removed.
   *
   * SCORING STAGE ONLY, and named that way deliberately. `routeRequest` then
   * reorders on top of this — the exploration probe, a sticky-session pin, an
   * explicitly pinned model — and finally walks the result skipping anything
   * the gates reject. So `scoringRank` is not where the route was attempted;
   * `selectionRank` below is.
   *
   * The counterfactual removes the three terms TOGETHER. A move therefore
   * proves the quota-aware terms decided the route, not which one of them did.
   * Where exactly one of scarcity/harvest/diversity is off-neutral the
   * attribution is unambiguous from those fields; where several are, it is not,
   * and this record does not pretend otherwise.
   */
  scoringRank: number;
  scoringRankWithoutQuotaTerms: number;
  /** 1-based position in the walk at which this route was actually attempted,
   *  after every reorder and after skipping gated candidates. */
  selectionRank: number;
  /** Set when something moved this route ahead of its scored position. */
  selectionOverride: 'explore' | 'sticky' | 'pinned' | null;
  /**
   * Verbatim dispositions of the candidates passed over before this one —
   * `platform/model: reason` lines straight from the router's diagnostics,
   * which is where an admission block names its scope, metric and source.
   *
   * Recorded because a request that SUCCEEDS on hop two otherwise leaves no
   * trace at all of why hop one was refused, and "the gate is working" and
   * "the gate is misfiring" look identical from a successful response.
   */
  skipped: string[];
}

export interface AttemptTraceRecord {
  // 0-based position in the ladder; the persistence order key.
  ordinal: number;
  platform: string;
  modelId: string;
  // Per-request key ordinal (key1, key2…), same anonymization as the
  // X-Fallback-Trail header — never the internal key id.
  keyOrdinal: number;
  // Operator-facing key label (api_keys.label) at attempt time (#869). Null
  // when the key had no label — the dashboard shows the ordinal alone then.
  // A snapshot, not a live join: renaming the key later must not rewrite
  // history. Deliberately NOT the internal key id or the key itself.
  keyLabel: string | null;
  outcome: AttemptOutcome;
  // Milliseconds from the ladder's start to this attempt's dispatch.
  startOffsetMs: number;
  // Milliseconds this attempt ran (for 'ok' streams: until the response
  // finished, i.e. including streaming time).
  durationMs: number;
  // Short, REDACTED summary of the error that ended this attempt (see
  // lib/error-redaction.ts summarizeAttemptError — secrets scrubbed, capped at
  // 200 chars). Null for successful hops ('ok'/'committed').
  /**
   * The routing inputs at the moment this hop was chosen. Null for a route
   * that arrived without them — a test double, or a surface that constructs a
   * RouteResult directly — so its absence never breaks the ladder record.
   */
  routing: RoutingDecisionTrace | null;
  errorSummary: string | null;
}

export interface RequestTrace {
  records: AttemptTraceRecord[];
  /**
   * Verbatim dispositions of candidates the router passed over on this
   * request, accumulated across attempts.
   *
   * Held here rather than read off `records` because of when headers flush: the
   * hop currently being served is pushed to `records` only AFTER dispatch
   * returns, so at flush time the served hop — the one carrying the skip
   * reasons — is not in the list yet. Keeping them on the trace also means
   * `setFallbackHeaders` reads them from the same AsyncLocalStorage scope it
   * already reads `records` from, instead of a new parameter through five
   * surfaces.
   */
  skipped: string[];
  // Rowid of the most recent `requests` row logged during this trace's run;
  // null until the first logRequest lands (e.g. a client abort on attempt 1).
  lastRequestRowId: number | null;
}

const storage = new AsyncLocalStorage<RequestTrace>();

export function newRequestTrace(): RequestTrace {
  return { records: [], skipped: [], lastRequestRowId: null };
}

/** Record candidates passed over before the route about to be dispatched.
 *  Union, not replace: a later attempt skips its own set, and the caller wants
 *  everything the request stepped around. No-op outside a trace. */
export function noteSkippedCandidates(lines: readonly string[]): void {
  const trace = storage.getStore();
  if (!trace || lines.length === 0) return;
  for (const line of lines) {
    if (!trace.skipped.includes(line)) trace.skipped.push(line);
  }
}

export function runWithRequestTrace<T>(trace: RequestTrace, fn: () => T): T {
  return storage.run(trace, fn);
}

export function getRequestTrace(): RequestTrace | undefined {
  return storage.getStore();
}

/** Called by logRequest() after inserting a `requests` row; no-op outside a trace. */
export function noteRequestRowId(id: number | bigint): void {
  const trace = storage.getStore();
  if (trace) trace.lastRequestRowId = Number(id);
}
