// clifree-gate-watch — detect OpenCode Zen's free-tier gate lifting for the
// API path FreeLLM actually uses.
//
// OpenCode Zen's free roster is gated per MODEL: most ids answer
// `403 FreeTierError: "OpenCode's free tier can only be used from within
// OpenCode"` to any direct call. The gate MOVES — `space-bunny-free` answered
// 200 on 2026-10-08 after other ids had refused for weeks (docs/GOTCHAS.md).
// When a gated id starts answering, it is real, free capacity that FreeLLM
// cannot use, because the custom-model sync will not register a tombstoned id.
//
// This job is the counterpart to that tombstone. It re-probes every tombstoned
// Zen id on the custom endpoint and logs gate movement to the log viewer:
//
//   - a tombstoned id answering 200 means the tombstone is factually stale and
//     worth removing (the operator decides; this job never unmutes a route);
//   - a live id that stops answering means the gate closed again.
//
// What it will never do:
//   - register a model: the sync owns that, and the tombstone is the
//     operator's record of "we tried, it refused";
//   - probe the OPEN endpoint (key #35 only, the one FreeLLM routes through);
//   - treat `$0` pricing as reachability — the price is a catalogue fact;
//   - hammer Zen: one cheap 16-token call per id, and only tombstoned ids, so
//     the pass is bounded by the tombstone count.
//
// Kill switch: CLIFREE_GATE_WATCH_DISABLED=1 (same convention as
// CATALOG_SYNC_DISABLED / COOLDOWN_PROBE_DISABLED).
//
// NOTE ON THE DECRYPT: this must match lib/crypto.ts decrypt() exactly — utf8
// output AND final(). final() is what verifies the GCM auth tag; omitting it
// (or reading hex->base64) yields garbage, and Zen answers a bare
// `401 Invalid API key.` that reads exactly like a revoked credential.

import { createHash } from 'node:crypto';
import { getDb } from '../db/index.js';
import { decrypt } from '../lib/crypto.js';
import { decryptProxyUrl, type EncryptedProxyColumns } from '../lib/key-proxy.js';
import { providerLog } from '../lib/server-logs.js';
import type { Scheduler } from '../lib/scheduler.js';
import { withKeyProxy } from '../lib/proxy.js';

const PLATFORM = 'custom';
/** Zen's API base — the endpoint scope the tombstones are keyed on. */
const ZEN_BASE_URL = 'https://opencode.ai/zen/v1';
const WATCH_INTERVAL_MS = 6 * 60 * 60 * 1000; // four times a day
const PROBE_TIMEOUT_MS = 45_000;
const PROBE_MAX_TOKENS = 16;
const PROBE_PROMPT = 'Reply with the single word: ok';

interface TombstoneRow { model_id: string }
interface KeyRow {
  id: number;
  encrypted_key: string;
  iv: string;
  auth_tag: string;
  base_url: string | null;
  proxy_encrypted: string | null;
  proxy_iv: string | null;
  proxy_auth_tag: string | null;
}

export interface GateProbeResult {
  modelId: string;
  status: number | null;
  /** 'open' | 'gated' | 'retired' | 'other' | 'error' */
  verdict: 'open' | 'gated' | 'retired' | 'other' | 'error';
  detail: string;
}

/** The custom key that serves the Zen endpoint, or null. */
export function findZenKey(db = getDb()): KeyRow | null {
  const row = db.prepare(`
    SELECT id, encrypted_key, iv, auth_tag, base_url,
           proxy_encrypted, proxy_iv, proxy_auth_tag
    FROM api_keys
    WHERE platform = ? AND enabled = 1 AND status IN ('healthy', 'unknown')
      AND base_url = ?
    ORDER BY id
  `).get(PLATFORM, ZEN_BASE_URL) as KeyRow | undefined;
  return row ?? null;
}

/** Tombstoned ids for the Zen endpoint. The tombstone is the mute list the
 *  sync honours, so it is exactly the set whose gate state is worth watching. */
export function tombstonedModelIds(db = getDb()): string[] {
  return (db.prepare(
    'SELECT model_id FROM custom_model_tombstones WHERE endpoint_scope = ? ORDER BY model_id'
  ).all(ZEN_BASE_URL) as TombstoneRow[]).map(r => r.model_id);
}

/** Same derivation OpenAICompatProvider uses (openai-compat.ts:355-357). */
function sessionHeader(apiKey: string): string {
  return createHash('sha256').update(`key:${apiKey}`).digest('hex').slice(0, 32);
}

export function classify(status: number, body: string): GateProbeResult['verdict'] {
  if (status === 200) return 'open';
  if (status === 410) return 'retired';
  if (status === 403 && /free tier can only be used from within/i.test(body)) return 'gated';
  return 'other';
}

/** One probe per id. Fire-and-forget semantics: never throws. */
export async function probeGate(
  apiKey: string,
  modelId: string,
  base = ZEN_BASE_URL,
  proxyRow?: Partial<EncryptedProxyColumns>,
): Promise<GateProbeResult> {
  const url = `${base}/chat/completions`;
  const headers: Record<string, string> = {
    Authorization: `Bearer ${apiKey}`,
    'Content-Type': 'application/json',
    'x-opencode-session': sessionHeader(apiKey),
  };
  const body = JSON.stringify({
    model: modelId,
    messages: [{ role: 'user', content: PROBE_PROMPT }],
    max_tokens: PROBE_MAX_TOKENS,
  });
  try {
    const res = await withKeyProxy(decryptProxyUrl(proxyRow), () =>
      fetch(url, {
        method: 'POST',
        headers,
        body,
        signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
      }),
    );
    const text = await res.text();
    let detail = '';
    try {
      const j = JSON.parse(text) as { error?: { message?: string }; message?: string };
      detail = j?.error?.message ?? j?.message ?? '';
    } catch {
      detail = text;
    }
    return { modelId, status: res.status, verdict: classify(res.status, text), detail: detail.slice(0, 200) };
  } catch (err) {
    return {
      modelId,
      status: null,
      verdict: 'error',
      detail: err instanceof Error ? err.message.slice(0, 200) : 'unknown error',
    };
  }
}

/** Probe every tombstoned id. Returns null when there is nothing to probe
 *  (no key, or no tombstones) so callers can skip logging an empty pass. */
export async function runGateWatch(db = getDb()): Promise<GateProbeResult[] | null> {
  const keyRow = findZenKey(db);
  if (!keyRow) return null;

  let apiKey: string;
  try {
    // decrypt() is utf8 + final(): a wrong ENCRYPTION_KEY or a corrupt row
    // fails here, instead of reaching Zen as garbage and reading as a revoked
    // credential (the bare `401 Invalid API key.` trap in docs/GOTCHAS.md).
    apiKey = decrypt(keyRow.encrypted_key, keyRow.iv, keyRow.auth_tag);
  } catch {
    return null;
  }

  const ids = tombstonedModelIds(db).filter(id => id.endsWith('-free'));
  if (ids.length === 0) return null;

  const results: GateProbeResult[] = [];
  for (const id of ids) {
    results.push(await probeGate(apiKey, id, ZEN_BASE_URL, keyRow));
  }
  return results;
}

function logPass(results: GateProbeResult[]): void {
  const open = results.filter(r => r.verdict === 'open');
  const gone = results.filter(r => r.verdict === 'gated');
  const retired = results.filter(r => r.verdict === 'retired');
  const parts = [
    `${open.length} open`,
    `${gone.length} gated`,
    `${retired.length} retired`,
    `${results.length - open.length - gone.length - retired.length} other/error`,
  ].join(', ');

  // Gate movement is the only thing an operator needs to act on, so it is the
  // only line that escalates. The log table only stores 'warn' and 'error'
  // (server_logs migration CHECK), so a stable pass warns too: it is the
  // proof the watcher ran, and the digest is one line either way.
  const message = open.length > 0
    ? `[ZenGate] ${open.length} tombstoned Zen free id(s) now answer on the API path: `
      + open.map(r => r.modelId).join(', ')
      + ` — consider removing the tombstone (${parts})`
    : `[ZenGate] pass: ${parts}`;
  providerLog('warn', message, {
    provider: PLATFORM,
    event: open.length > 0 ? 'clifree_gate_open' : 'clifree_gate_pass',
  });
}

let cancelWatchJob: (() => void) | null = null;

/** Wire the watcher to the shared scheduler. Idempotent, same contract as
 *  startCooldownProbe(). */
export function startZenGateWatch(scheduler: Scheduler): void {
  if (cancelWatchJob) return;
  if (process.env.CLIFREE_GATE_WATCH_DISABLED === '1') {
    console.log('[ZenGate] disabled via CLIFREE_GATE_WATCH_DISABLED=1');
    return;
  }
  // A baseline at boot: setInterval alone stays silent for the first 6h, and
  // the gate moving before that is exactly the signal worth catching. The
  // first pass runs 20s in, after the health checker has had its turn.
  const pass = async () => {
    try {
      const results = await runGateWatch();
      if (results) logPass(results);
    } catch (err) {
      console.error('[ZenGate] pass failed:', err);
    }
  };
  cancelWatchJob = scheduler.every(WATCH_INTERVAL_MS, pass, { name: 'zen-gate-watch' });
  scheduler.after(20_000, pass);
}

export function stopZenGateWatch(): void {
  if (cancelWatchJob) {
    cancelWatchJob();
    cancelWatchJob = null;
  }
}
