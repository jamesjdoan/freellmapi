import { getDb } from '../db/index.js';
import type { Db } from '../db/types.js';
import { parseModelScope, scopeAllows } from '../lib/model-scope.js';

/**
 * Whether a chain position points at a route any key can actually call.
 *
 * Written because three did not, and nothing noticed. On 2026-09-18 a probe of
 * all 30 chain members found:
 *
 *   - the Mistral key switched off, stranding three members, one of them at
 *     Fast-Lane #2;
 *   - Google's model scope missing a Fast-Lane member;
 *   - NVIDIA's missing a Workhorse member.
 *
 * Each was reported by the probe as "No enabled key is scoped to this model" -
 * a state no chain view could show, because membership lives in
 * `profile_models` and reachability lives in `api_keys.model_scope_json`, and
 * nothing joined them. A chain position pointing nowhere is worse than a short
 * chain: it reads as depth and is not, and the failure only appears when the
 * routes above it are exhausted and the fallback is needed.
 *
 * Deliberately NOT health: a route that is keyed and rate-limited is working
 * capacity on a cooldown. This asks the narrower question the router asks
 * first, before health, quota or cooldown - is there a credential that may call
 * this model at all?
 *
 * "Usable key" is `enabled = 1 AND status IN ('healthy','unknown')`, matching
 * the router, the scorer and /api/fallback (fallback.ts:252). Unknown counts:
 * an unprobed key is not a broken one.
 */

export type UnreachableCause = 'no_key' | 'key_disabled' | 'out_of_scope';

export interface UnreachableMember {
  chain: string;
  priority: number;
  platform: string;
  modelId: string;
  modelDbId: number;
  cause: UnreachableCause;
}

interface KeyRow {
  platform: string;
  enabled: number;
  status: string;
  model_scope_json: string | null;
}

/** Why this platform/model cannot be called, or null when it can. */
export function unreachableCause(keys: KeyRow[], platform: string, modelId: string): UnreachableCause | null {
  const mine = keys.filter(k => k.platform === platform);
  if (mine.length === 0) return 'no_key';
  const usable = mine.filter(k => k.enabled === 1 && (k.status === 'healthy' || k.status === 'unknown'));
  // Held but unusable is a different repair from never held: one is a toggle or
  // a re-probe, the other is a credential you do not have.
  if (usable.length === 0) return 'key_disabled';
  const allowed = usable.some(k => scopeAllows(parseModelScope(k.model_scope_json), modelId));
  return allowed ? null : 'out_of_scope';
}

/**
 * Every enabled chain position whose route no key can call.
 *
 * Empty is the healthy answer. Ordered by chain position so the earliest - and
 * therefore most damaging - appears first.
 */
export function unreachableChainMembers(db: Db = getDb()): UnreachableMember[] {
  const keys = db.prepare(
    'SELECT platform, enabled, status, model_scope_json FROM api_keys',
  ).all() as KeyRow[];

  const members = db.prepare(`
    SELECT p.name AS chain, pm.priority, m.platform, m.model_id, m.id AS model_db_id
      FROM profile_models pm
      JOIN profiles p ON p.id = pm.profile_id
      JOIN models m ON m.id = pm.model_db_id
     WHERE pm.enabled = 1 AND m.enabled = 1
     ORDER BY p.sort_order, pm.priority
  `).all() as { chain: string; priority: number; platform: string; model_id: string; model_db_id: number }[];

  const out: UnreachableMember[] = [];
  for (const row of members) {
    const cause = unreachableCause(keys, row.platform, row.model_id);
    if (cause) {
      out.push({
        chain: row.chain,
        priority: row.priority,
        platform: row.platform,
        modelId: row.model_id,
        modelDbId: row.model_db_id,
        cause,
      });
    }
  }
  return out;
}
