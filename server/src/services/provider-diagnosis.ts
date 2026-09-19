import { getDb } from '../db/index.js';
import type { Db } from '../db/types.js';
import { parseModelScope, scopeAllows } from '../lib/model-scope.js';
import { codeForErrorText, type ModelHealthCode } from './model-health.js';

/**
 * One verdict per provider: is this key working, and if not, whose fault is it.
 *
 * The model-level health in model-health.ts answers "can this route serve".
 * That is the wrong grain for the question an operator actually asks, which is
 * about the KEY: is the provider limiting me, has it blocked the account, has
 * it retired the models, or am I simply not calling it?
 *
 * OpenCode is the case that motivated this. Every one of its 11 scoped models
 * answers 403 "free tier" or 404 "not supported" — the whole provider is gone,
 * not eleven separate route failures. Read one model at a time that reads as
 * eleven unrelated problems; rolled up it is one sentence: the promo ended.
 *
 * Derived from `requests`, which the proxy writes for every call including
 * failures, so a provider in daily use is judged on real traffic. Nothing here
 * calls a provider: diagnosis must never cost the allowance it is diagnosing.
 */

export type ProviderVerdict =
  /** Serving. Some routes may be individually unhappy; the key is fine. */
  | 'healthy'
  /** No credential held for this provider at all. */
  | 'no_key'
  /** A credential we hold, switched off or marked unhealthy. */
  | 'key_unusable'
  /** The credential was rejected: 401 dominant. About the KEY. */
  | 'key_rejected'
  /** The account may not use these models: 403/402 dominant. Plan or promo. */
  | 'account_blocked'
  /** The provider does not know these ids: 404 dominant. Models retired. */
  | 'models_gone'
  /** Allowance spent: 429 dominant, or cooldowns currently held. */
  | 'rate_limited'
  /** Failing for mixed or provider-side reasons: 5xx, timeouts. */
  | 'degraded'
  /** Keyed, reachable, and never called in the window. Not a fault. */
  | 'untested';

export interface ProviderDiagnosis {
  platform: string;
  verdict: ProviderVerdict;
  /** The code that decided the verdict, so the reason survives the rollup. */
  dominantCode: ModelHealthCode | null;
  /** The provider's own words for the dominant failure, truncated upstream. */
  sample: string | null;
  keyed: boolean;
  keyEnabled: boolean;
  keyStatus: string | null;
  /** Models in the catalogue this key is scoped to reach. */
  scopedModels: number;
  /** Of those, how many have a verdict at all. */
  testedModels: number;
  okModels: number;
  failingModels: number;
  /** Cooldowns held right now — a rate limit that is still in force. */
  activeCooldowns: number;
  counts: Partial<Record<ModelHealthCode, number>>;
}

interface KeyRow {
  platform: string;
  enabled: number;
  status: string;
  model_scope_json: string | null;
}

/**
 * Which code decides the verdict when several appear.
 *
 * Ordered by what an operator must act on first, NOT by frequency. A single
 * 401 means the credential is rejected and every other symptom is downstream
 * of it; ten 429s next to one 403 is a provider rationing us, which is normal
 * and self-healing. Frequency ordering would bury the actionable signal under
 * the routine one.
 */
const CODE_PRIORITY: ModelHealthCode[] = ['E401', 'E403', 'E404', 'E429', 'E5XX', 'ETIME', 'EOTHER'];

const CODE_VERDICT: Record<string, ProviderVerdict> = {
  E401: 'key_rejected',
  E403: 'account_blocked',
  E404: 'models_gone',
  E429: 'rate_limited',
  E5XX: 'degraded',
  ETIME: 'degraded',
  EOTHER: 'degraded',
};

/**
 * A provider is only judged by a code when that code covers most of what it
 * refused. One dead model among thirty working ones is a model problem; the
 * same code on nearly everything is a provider problem, which is the
 * distinction this whole file exists to draw.
 */
const DOMINANCE = 0.6;

export function diagnoseProviders(db: Db = getDb()): ProviderDiagnosis[] {
  const keys = db.prepare(
    'SELECT platform, enabled, status, model_scope_json FROM api_keys',
  ).all() as KeyRow[];

  // 14 days: long enough that a weekly-used provider still has a verdict,
  // short enough that an outage fixed last week stops counting.
  const windowStart = new Date(Date.now() - 14 * 86_400_000).toISOString().replace('T', ' ').slice(0, 19);

  // Keyed platforms are included even when every model row is switched off:
  // b.ai holds a key and has both models disabled, and a provider you hold a
  // credential for must not vanish from the view that explains credentials.
  const platforms = db.prepare(`
    SELECT DISTINCT platform FROM models WHERE enabled = 1
    UNION
    SELECT DISTINCT platform FROM api_keys
  `).all() as { platform: string }[];

  const byPlatform = new Map<string, KeyRow[]>();
  for (const key of keys) {
    const list = byPlatform.get(key.platform) ?? [];
    list.push(key);
    byPlatform.set(key.platform, list);
  }

  const cooldowns = db.prepare(`
    SELECT platform, COUNT(*) AS held
      FROM rate_limit_cooldowns
     WHERE expires_at_ms > ?
     GROUP BY platform
  `).all(Date.now()) as { platform: string; held: number }[];
  const cooldownByPlatform = new Map(cooldowns.map(row => [row.platform, row.held]));

  const out: ProviderDiagnosis[] = [];
  for (const { platform } of platforms) {
    const mine = byPlatform.get(platform) ?? [];
    const usable = mine.filter(k => k.enabled === 1 && (k.status === 'healthy' || k.status === 'unknown'));
    const scope = usable.length > 0 ? parseModelScope(usable[0]!.model_scope_json) : null;

    const scopedModels = (db.prepare(
      'SELECT model_id FROM models WHERE platform = ? AND enabled = 1',
    ).all(platform) as { model_id: string }[])
      .filter(row => usable.length > 0 && scopeAllows(scope, row.model_id)).length;

    // The LATEST attempt per model, not the 14-day tally.
    //
    // Found immediately on live data: OpenCode read `healthy` with ok=5,
    // fail=6, because successes from before its promotion ended were still
    // inside the window and outvoted the 403s that came after. A provider that
    // died on Tuesday is not healthy because it worked on Monday. Aggregates
    // describe a period; an operator asking "what is happening with this key"
    // is asking about now.
    const health = usable.length === 0 ? [] : (db.prepare(`
      SELECT r.model_id,
             r.status,
             r.error,
             r.created_at
        FROM requests r
        JOIN (
          SELECT model_id, MAX(id) AS id
            FROM requests
           WHERE platform = ? AND created_at >= ?
           GROUP BY model_id
        ) latest ON latest.id = r.id
    `).all(platform, windowStart) as {
      model_id: string; status: string; error: string | null; created_at: string;
    }[]).map(row => ({
      modelId: row.model_id,
      verdict: row.status === 'success' ? 'ok' as const : 'failed' as const,
      code: row.status === 'success' ? null : codeForErrorText(row.error),
      detail: row.error?.slice(0, 160) ?? null,
    }));
    const counts: Partial<Record<ModelHealthCode, number>> = {};
    let ok = 0;
    let failing = 0;
    let sample: string | null = null;
    for (const row of health) {
      if (row.verdict === 'ok') { ok++; continue; }
      failing++;
      if (row.code) counts[row.code] = (counts[row.code] ?? 0) + 1;
      if (!sample && row.detail) sample = row.detail;
    }

    const tested = ok + failing;
    const activeCooldowns = cooldownByPlatform.get(platform) ?? 0;

    // Credential state first: it outranks every model-level symptom, because a
    // key that cannot be used explains all of them.
    let verdict: ProviderVerdict;
    let dominantCode: ModelHealthCode | null = null;
    if (mine.length === 0) {
      verdict = 'no_key';
    } else if (usable.length === 0) {
      verdict = 'key_unusable';
    } else if (tested === 0) {
      verdict = 'untested';
    } else {
      const ranked = CODE_PRIORITY.filter(code => (counts[code] ?? 0) > 0);
      const leading = ranked[0] ?? null;
      const share = leading ? (counts[leading] ?? 0) / tested : 0;
      if (leading && share >= DOMINANCE) {
        verdict = CODE_VERDICT[leading] ?? 'degraded';
        dominantCode = leading;
      } else if (leading && ok === 0) {
        // Nothing serves. OpenCode splits 403 "free tier" and 404 "not
        // supported" across its eleven models, so neither code clears the
        // dominance bar — but "degraded" implies partial service, and there is
        // none. With no working route the leading code IS the reason, and
        // CODE_PRIORITY has already put the actionable one first.
        verdict = CODE_VERDICT[leading] ?? 'degraded';
        dominantCode = leading;
      } else if (activeCooldowns > 0 && ok === 0) {
        // Everything is benched right now and nothing has answered: the
        // provider is rationing us even if no single code dominates.
        verdict = 'rate_limited';
        dominantCode = 'E429';
      } else {
        verdict = ok > 0 ? 'healthy' : 'degraded';
        dominantCode = ok > 0 ? null : leading;
      }
    }

    out.push({
      platform,
      verdict,
      dominantCode,
      sample: verdict === 'healthy' || verdict === 'untested' ? null : sample,
      keyed: mine.length > 0,
      keyEnabled: usable.length > 0,
      keyStatus: mine[0]?.status ?? null,
      scopedModels,
      testedModels: tested,
      okModels: ok,
      failingModels: failing,
      activeCooldowns,
      counts,
    });
  }

  // Worst first: an operator opening this wants the provider that needs a
  // decision, not an alphabetical list.
  const SEVERITY: ProviderVerdict[] = [
    'key_rejected', 'account_blocked', 'models_gone', 'key_unusable',
    'degraded', 'rate_limited', 'no_key', 'untested', 'healthy',
  ];
  out.sort((a, b) => SEVERITY.indexOf(a.verdict) - SEVERITY.indexOf(b.verdict)
    || a.platform.localeCompare(b.platform));
  return out;
}

/**
 * What the verdict means and what to do about it.
 *
 * A code beside a provider name tells an operator that something is wrong, not
 * what it is or whether they can fix it. The difference that matters here is
 * whether waiting helps: a 429 clears itself and a 403 never will, and those
 * two demand opposite responses from the person reading the row.
 *
 * Deliberately one sentence each. Advice nobody finishes reading is advice
 * nobody takes.
 */
export interface ProviderAdvice {
  cause: string;
  action: string;
  /** Does waiting fix this? Drives whether the UI nags or merely notes. */
  selfHealing: boolean;
}

export function adviceFor(d: Pick<ProviderDiagnosis, 'verdict' | 'dominantCode' | 'activeCooldowns' | 'failingModels' | 'okModels'>): ProviderAdvice {
  switch (d.verdict) {
    case 'healthy':
      return { cause: 'Serving normally.', action: 'Nothing to do.', selfHealing: true };
    case 'untested':
      return {
        cause: 'Keyed and reachable, but nothing has called it recently.',
        action: 'Probe a model, or leave it — silence is not a fault.',
        selfHealing: true,
      };
    case 'no_key':
      return {
        cause: 'No credential is held for this provider.',
        action: 'Add a key if its models are worth routing; otherwise ignore it.',
        selfHealing: false,
      };
    case 'key_unusable':
      return {
        cause: 'A credential is held but it is switched off or marked unhealthy.',
        action: 'Enable it, or re-check it — until then nothing here can route.',
        selfHealing: false,
      };
    case 'key_rejected':
      return {
        cause: 'The provider rejected the credential itself (401).',
        action: 'Replace the key. Every other symptom on this provider is downstream of it.',
        selfHealing: false,
      };
    case 'account_blocked':
      return {
        cause: 'The account may not use these models (403/402) — a plan, a promotion that ended, or a region block.',
        action: 'Waiting will not fix this. Remove it from chains, or restore access with the provider.',
        selfHealing: false,
      };
    case 'models_gone':
      return {
        cause: 'The provider does not recognise these model ids (404) — they were renamed or retired.',
        action: 'Re-sync the catalogue, then re-check which ids it actually serves.',
        selfHealing: false,
      };
    case 'rate_limited':
      return {
        cause: d.activeCooldowns > 0
          ? `Allowance spent; ${d.activeCooldowns} route(s) are on cooldown right now.`
          : 'Allowance spent — the routes work, the quota does not.',
        action: 'Wait for the reset. If it is constant, lower concurrency or add an independent pool.',
        selfHealing: true,
      };
    case 'degraded':
      return {
        cause: d.okModels > 0
          ? 'Failing on several routes for mixed reasons — provider errors or timeouts.'
          : 'Nothing is serving, and no single cause accounts for it.',
        action: 'Check the provider\'s status; if it persists, treat the routes as unreliable and re-rank them.',
        selfHealing: true,
      };
  }
}

export interface DiagnosisTransition {
  platform: string;
  verdict: ProviderVerdict;
  dominantCode: ModelHealthCode | null;
  sample: string | null;
  okModels: number;
  failingModels: number;
  startedAtMs: number;
  lastSeenAtMs: number;
}

/**
 * Write a row only when a provider's state CHANGES; otherwise extend the one
 * that holds.
 *
 * A transition log answers "when did this start, and is it getting better or
 * worse" in a handful of rows per provider. Sampling on a timer would answer
 * the same questions with thousands of rows a week, and this codebase deleted
 * one of those this morning.
 *
 * Idempotent: calling it twice with no change in between bumps a timestamp and
 * writes nothing.
 */
export function recordDiagnosisTransitions(
  current: ProviderDiagnosis[] = diagnoseProviders(),
  db: Db = getDb(),
  now: number = Date.now(),
): { changed: string[] } {
  const latest = db.prepare(`
    SELECT h.platform, h.verdict, h.dominant_code, h.id
      FROM provider_diagnosis_history h
      JOIN (SELECT platform, MAX(id) AS id FROM provider_diagnosis_history GROUP BY platform) m
        ON m.id = h.id
  `).all() as { platform: string; verdict: string; dominant_code: string | null; id: number }[];
  const byPlatform = new Map(latest.map(row => [row.platform, row]));

  const insert = db.prepare(`
    INSERT INTO provider_diagnosis_history
      (platform, verdict, dominant_code, sample, ok_models, failing_models, started_at_ms, last_seen_at_ms)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const touch = db.prepare('UPDATE provider_diagnosis_history SET last_seen_at_ms = ? WHERE id = ?');

  const changed: string[] = [];
  db.transaction(() => {
    for (const d of current) {
      // Only keyed providers have a state worth tracking. Logging `no_key`
      // would write 31 rows on this install for providers nobody has ever
      // configured, and bury the three that matter.
      if (!d.keyed) continue;
      const prev = byPlatform.get(d.platform);
      const same = prev && prev.verdict === d.verdict && (prev.dominant_code ?? null) === (d.dominantCode ?? null);
      if (same) {
        touch.run(now, prev.id);
        continue;
      }
      insert.run(d.platform, d.verdict, d.dominantCode ?? null, d.sample ?? null,
        d.okModels, d.failingModels, now, now);
      changed.push(d.platform);
    }
  })();
  return { changed };
}

/** Transitions for one provider or all, newest first. */
export function listDiagnosisHistory(platform?: string, limit = 50, db: Db = getDb()): DiagnosisTransition[] {
  const rows = platform
    ? db.prepare(`SELECT * FROM provider_diagnosis_history WHERE platform = ? ORDER BY id DESC LIMIT ?`).all(platform, limit)
    : db.prepare(`SELECT * FROM provider_diagnosis_history ORDER BY id DESC LIMIT ?`).all(limit);
  return (rows as Record<string, unknown>[]).map(row => ({
    platform: String(row.platform),
    verdict: row.verdict as ProviderVerdict,
    dominantCode: (row.dominant_code as ModelHealthCode | null) ?? null,
    sample: (row.sample as string | null) ?? null,
    okModels: Number(row.ok_models),
    failingModels: Number(row.failing_models),
    startedAtMs: Number(row.started_at_ms),
    lastSeenAtMs: Number(row.last_seen_at_ms),
  }));
}
