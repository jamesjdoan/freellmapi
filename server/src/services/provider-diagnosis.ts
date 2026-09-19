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
