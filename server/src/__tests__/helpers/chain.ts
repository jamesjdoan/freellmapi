import { getDb } from '../../db/index.js';
import { getActiveProfileId, getDefaultChainProfileId } from '../../services/profile-models.js';

/**
 * Put a model in the fallback chains, the way a catalog sync does.
 *
 * A fixture that seeds `models` + `fallback_config` by hand has only built half
 * an install: on a real one every catalog model is mirrored into the active
 * profile's chain (services/profile-models.ts), and that chain — not the global
 * table — is what the router walks (#1021). No-op when nothing is active, which
 * is the legacy shape where `fallback_config` IS the chain.
 *
 * Since #1409 the chain a fixture edits and the chain plain `auto` routes over
 * are two settings, so a fixture that means "this model is routable" names both.
 * In the default test install they are the same profile and this writes one row.
 */
export function addToActiveChain(modelDbId: number, priority: number, enabled = true): void {
  const db = getDb();
  const profileIds = [...new Set([
    getActiveProfileId(db),
    getDefaultChainProfileId(db),
  ])].filter((id): id is number => id != null);
  if (profileIds.length === 0) return;
  const upsert = db.prepare(`
    INSERT INTO profile_models (profile_id, model_db_id, priority, enabled)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(profile_id, model_db_id) DO UPDATE SET priority = excluded.priority, enabled = excluded.enabled
  `);
  for (const profileId of profileIds) upsert.run(profileId, modelDbId, priority, enabled ? 1 : 0);
}
