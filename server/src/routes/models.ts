import { Router } from 'express';
import { getCatalogueChanges, acknowledgeDeparture } from '../services/catalogue-changes.js';
import { listCatalogueEvents } from '../services/catalogue-log.js';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { getDb } from '../db/index.js';
import { hasProvider } from '../providers/index.js';
import { deleteUnusedCustomEndpointKey } from '../lib/custom-provider-cleanup.js';
import {
  isCatalogManagedModel,
  overriddenFieldNames,
  recordCatalogModelTombstone,
  upsertModelOverrides,
  type ModelOverridePatch,
} from '../services/model-state.js';
import { pruneUnavailableSavedFusionConfig } from '../services/fusion.js';
import { getActiveProfileId } from '../services/profile-models.js';
import { endpointScopeOfKey, qualifiedModelMemberId } from '../lib/endpoint-scope.js';
import { recordCustomModelTombstone } from '../services/custom-model-tombstone.js';

export const modelsRouter = Router();

const modelUpdateSchema = z.object({
  displayName: z.string().min(1).max(200).optional(),
  intelligenceRank: z.number().int().min(1).max(1000).optional(),
  speedRank: z.number().int().min(1).max(1000).optional(),
  // '' is a legal value: size_label is TEXT NOT NULL DEFAULT '' and the empty
  // string is the canonical "unscored" tier (scores 0 on the intelligence
  // axis), so the dashboard's "None" option must be able to send it.
  sizeLabel: z.string().max(40).optional(),
  rpmLimit: z.number().int().positive().nullable().optional(),
  rpdLimit: z.number().int().positive().nullable().optional(),
  tpmLimit: z.number().int().positive().nullable().optional(),
  tpdLimit: z.number().int().positive().nullable().optional(),
  monthlyTokenBudget: z.string().max(80).optional(),
  contextWindow: z.number().int().positive().nullable().optional(),
  enabled: z.boolean().optional(),
  supportsVision: z.boolean().optional(),
  supportsTools: z.boolean().optional(),
  fallbackEnabled: z.boolean().optional(),
}).strict();

const MODEL_FIELD_COLUMNS: Record<keyof ModelOverridePatch | 'enabled', string> = {
  displayName: 'display_name',
  intelligenceRank: 'intelligence_rank',
  speedRank: 'speed_rank',
  sizeLabel: 'size_label',
  rpmLimit: 'rpm_limit',
  rpdLimit: 'rpd_limit',
  tpmLimit: 'tpm_limit',
  tpdLimit: 'tpd_limit',
  monthlyTokenBudget: 'monthly_token_budget',
  contextWindow: 'context_window',
  supportsVision: 'supports_vision',
  supportsTools: 'supports_tools',
  enabled: 'enabled',
};

type ModelRow = {
  id: number;
  platform: string;
  model_id: string;
  key_id: number | null;
  source: string;
};

function dbValue(key: keyof typeof MODEL_FIELD_COLUMNS, value: unknown): unknown {
  if (key === 'enabled' || key === 'supportsVision' || key === 'supportsTools') return value ? 1 : 0;
  return value;
}

function fetchModelRow(id: number): ModelRow | undefined {
  return getDb()
    .prepare('SELECT id, platform, model_id, key_id, source FROM models WHERE id = ?')
    .get(id) as ModelRow | undefined;
}

modelsRouter.delete('/custom/:id', (req: Request, res: Response) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) {
    res.status(400).json({ error: { message: 'Invalid id' } });
    return;
  }

  const db = getDb();
  const row = db.prepare("SELECT id, key_id, model_id FROM models WHERE id = ? AND platform = 'custom'").get(id) as { id: number; key_id: number | null; model_id: string } | undefined;
  if (!row) {
    res.status(404).json({ error: { message: `Unknown custom model ${id}` } });
    return;
  }

  const remove = db.transaction(() => {
    // #926: keep this deletion across the scheduled custom-model sync, or the
    // next daily pass re-registers a model the operator removed on purpose.
    recordCustomModelTombstone(db, endpointScopeOfKey(db, row.key_id), row.model_id);
    db.prepare('DELETE FROM fallback_config WHERE model_db_id = ?').run(id);
    db.prepare("DELETE FROM models WHERE id = ? AND platform = 'custom'").run(id);
    deleteUnusedCustomEndpointKey(db, row.key_id);
  });
  remove();
  res.json({ success: true });
});

modelsRouter.patch('/:id', (req: Request, res: Response) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) {
    res.status(400).json({ error: { message: 'Invalid id' } });
    return;
  }

  const parsed = modelUpdateSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: { message: parsed.error.errors.map(e => e.message).join(', ') } });
    return;
  }

  const db = getDb();
  const row = fetchModelRow(id);
  if (!row) {
    res.status(404).json({ error: { message: `Unknown model ${id}` } });
    return;
  }

  const modelPatch: Partial<typeof parsed.data> = { ...parsed.data };
  delete modelPatch.fallbackEnabled;
  const modelKeys = Object.keys(modelPatch) as Array<keyof typeof modelPatch>;
  if (modelKeys.length === 0 && parsed.data.fallbackEnabled === undefined) {
    res.status(400).json({ error: { message: 'No model fields provided' } });
    return;
  }

  const applyUpdate = db.transaction(() => {
    const disablesModel = modelPatch.enabled === false;

    if (modelKeys.length > 0) {
      const assignments: string[] = [];
      const values: unknown[] = [];
      for (const key of modelKeys) {
        assignments.push(`${MODEL_FIELD_COLUMNS[key as keyof typeof MODEL_FIELD_COLUMNS]} = ?`);
        values.push(dbValue(key as keyof typeof MODEL_FIELD_COLUMNS, modelPatch[key]));
      }
      values.push(id);
      db.prepare(`UPDATE models SET ${assignments.join(', ')} WHERE id = ?`).run(...values);

      if (isCatalogManagedModel(row)) {
        const overridePatch: ModelOverridePatch = {};
        for (const key of [
          'displayName', 'intelligenceRank', 'speedRank', 'sizeLabel',
          'rpmLimit', 'rpdLimit', 'tpmLimit', 'tpdLimit',
          'monthlyTokenBudget', 'contextWindow', 'supportsVision', 'supportsTools',
        ] as const) {
          if (Object.prototype.hasOwnProperty.call(modelPatch, key)) {
            overridePatch[key] = modelPatch[key] as never;
          }
        }
        upsertModelOverrides(db, row.platform, row.model_id, overridePatch);
      }

      if (disablesModel) {
        db.prepare('UPDATE profile_models SET enabled = 0 WHERE model_db_id = ?').run(id);
        pruneUnavailableSavedFusionConfig();
      }
    }

    if (disablesModel || parsed.data.fallbackEnabled !== undefined) {
      const next = disablesModel ? 0 : parsed.data.fallbackEnabled ? 1 : 0;
      db.prepare('UPDATE fallback_config SET enabled = ? WHERE model_db_id = ?')
        .run(next, id);
      const activeProfileId = getActiveProfileId(db);
      if (activeProfileId != null) {
        db.prepare('UPDATE profile_models SET enabled = ? WHERE profile_id = ? AND model_db_id = ?')
          .run(next, activeProfileId, id);
      }
    }
  });
  applyUpdate();

  res.json({ success: true, id });
});

modelsRouter.delete('/:id', (req: Request, res: Response) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) {
    res.status(400).json({ error: { message: 'Invalid id' } });
    return;
  }

  const db = getDb();
  const row = fetchModelRow(id);
  if (!row) {
    res.status(404).json({ error: { message: `Unknown model ${id}` } });
    return;
  }

  const remove = db.transaction(() => {
    if (isCatalogManagedModel(row)) {
      recordCatalogModelTombstone(db, 'chat', row.platform, row.model_id);
    } else if (row.platform === 'custom') {
      // #926: same "keep it deleted" contract for custom relay models — the
      // scheduled custom-model sync must not resurrect this row.
      recordCustomModelTombstone(db, endpointScopeOfKey(db, row.key_id), row.model_id);
    }
    db.prepare('DELETE FROM fallback_config WHERE model_db_id = ?').run(id);
    db.prepare('DELETE FROM models WHERE id = ?').run(id);
    if (row.platform === 'custom') deleteUnusedCustomEndpointKey(db, row.key_id);
  });
  remove();

  res.json({ success: true, tombstoned: isCatalogManagedModel(row) });
});

// List all models with availability info
modelsRouter.get('/', (_req: Request, res: Response) => {
  const db = getDb();
  const activeProfileId = getActiveProfileId(db);
  const models = activeProfileId == null ? db.prepare(`
    SELECT m.*, fc.priority, fc.enabled as fallback_enabled,
           mo.overrides_json IS NOT NULL AS has_overrides, mo.overrides_json,
           ak.label AS key_label
    FROM models m
    LEFT JOIN fallback_config fc ON fc.model_db_id = m.id
    LEFT JOIN model_overrides mo ON mo.platform = m.platform AND mo.model_id = m.model_id
    LEFT JOIN api_keys ak ON ak.id = m.key_id
    ORDER BY COALESCE(fc.priority, m.intelligence_rank) ASC
  `).all() as any[] : db.prepare(`
    SELECT m.*, COALESCE(pm.priority, fc.priority) AS priority,
           COALESCE(pm.enabled, fc.enabled) AS fallback_enabled,
           mo.overrides_json IS NOT NULL AS has_overrides, mo.overrides_json,
           ak.label AS key_label
    FROM models m
    LEFT JOIN fallback_config fc ON fc.model_db_id = m.id
    LEFT JOIN profile_models pm ON pm.profile_id = ? AND pm.model_db_id = m.id
    LEFT JOIN model_overrides mo ON mo.platform = m.platform AND mo.model_id = m.model_id
    LEFT JOIN api_keys ak ON ak.id = m.key_id
    ORDER BY COALESCE(pm.priority, fc.priority, m.intelligence_rank) ASC
  `).all(activeProfileId) as any[];

  // Count keys per platform
  const keyCounts = db.prepare(`
    SELECT platform, COUNT(*) as count
    FROM api_keys
    WHERE enabled = 1
    GROUP BY platform
  `).all() as { platform: string; count: number }[];

  const keyCountMap = new Map(keyCounts.map(k => [k.platform, k.count]));

  const result = models.map(m => ({
    id: m.id,
    platform: m.platform,
    modelId: m.model_id,
    displayName: m.display_name,
    intelligenceRank: m.intelligence_rank,
    speedRank: m.speed_rank,
    sizeLabel: m.size_label,
    rpmLimit: m.rpm_limit,
    rpdLimit: m.rpd_limit,
    tpmLimit: m.tpm_limit,
    tpdLimit: m.tpd_limit,
    monthlyTokenBudget: m.monthly_token_budget,
    contextWindow: m.context_window,
    enabled: m.enabled === 1,
    supportsVision: m.supports_vision === 1,
    supportsTools: m.supports_tools === 1,
    priority: m.priority,
    fallbackEnabled: m.fallback_enabled === 1,
    // Real provenance from models.source ('catalog' | 'user'). The dashboard's
    // existing vocabulary for user-added rows is 'custom', so map 1:1 here —
    // this now also flags user models on native platforms (declarative
    // config / admin adds), which the old platform/key_id heuristic missed.
    source: m.source === 'user' ? 'custom' : 'catalog',
    keyId: m.key_id ?? null,
    keyLabel: m.key_label ?? null,
    // Endpoint identity for custom rows (#651); null for catalog models and for
    // custom rows that carry no endpoint scope.
    endpointScope: m.endpoint_scope || null,
    qualifiedModelId: qualifiedModelMemberId(m.platform, m.model_id, m.endpoint_scope),
    hasOverrides: Boolean(m.has_overrides),
    overrideFields: overriddenFieldNames(m.overrides_json),
    hasProvider: hasProvider(m.platform),
    keyCount: keyCountMap.get(m.platform) ?? 0,
  }));

  res.json(result);
});

/**
 * What the catalogue gained and lost.
 *
 * Read-only, and deliberately so: it reports that two models arrived and are
 * already serving, or that a retirement took a chain head with it, and leaves
 * the decision to the operator. Chain membership lives in a reviewed source
 * file (`data/routing-curation.ts`); a panel that edited it from here would
 * recreate `auto_include_new_models` — the very drift this surface exists to
 * make visible — behind a different button.
 */
modelsRouter.get('/changes', (req: Request, res: Response) => {
  const raw = typeof req.query.sinceDays === 'string' ? Number(req.query.sinceDays) : NaN;
  // Clamped rather than rejected: this is a dashboard control, and a nonsense
  // value should show the default window, not a 400.
  const sinceDays = Number.isFinite(raw) && raw > 0 ? Math.min(365, Math.floor(raw)) : 30;
  res.json(getCatalogueChanges(sinceDays));
});

const logQuerySchema = z.object({
  platform: z.string().min(1).optional(),
  kind: z.enum(['arrived', 'retired', 'removed', 'relisted']).optional(),
  // Coerced because these arrive as query strings.
  limit: z.coerce.number().int().positive().max(500).optional(),
  offset: z.coerce.number().int().nonnegative().optional(),
});

const acknowledgeSchema = z.object({
  platform: z.string().min(1, 'platform is required'),
  modelId: z.string().min(1, 'modelId is required'),
});

/** Mark a retirement as dealt with, so the panel stops reporting it as news.
 *  Without this every departure stays listed forever and the surface meant to
 *  say "something broke" becomes a list nobody reads. */
/**
 * The catalogue's history: what arrived, was retired, removed or relisted, and
 * when. Read-only and append-only at the source, so this needs no writes.
 *
 * Separate from `/changes` above, which is a worklist of the recent and the
 * unacknowledged. This is the whole record, for the question "what has this
 * provider been doing".
 */
modelsRouter.get('/changes/log', (req: Request, res: Response) => {
  const parsed = logQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: { message: parsed.error.errors.map(e => e.message).join(', ') } });
    return;
  }
  res.json(listCatalogueEvents(parsed.data));
});

modelsRouter.post('/changes/acknowledge', (req: Request, res: Response) => {
  const parsed = acknowledgeSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: { message: parsed.error.errors.map(e => e.message).join(', ') } });
    return;
  }
  const ok = acknowledgeDeparture(parsed.data.platform, parsed.data.modelId);
  if (!ok) {
    res.status(404).json({ error: { message: 'No upstream retirement recorded for that model' } });
    return;
  }
  res.json({ success: true });
});
