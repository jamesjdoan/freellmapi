import { z } from 'zod';
import { getDb } from '../db/index.js';
import { getProvider } from '../providers/index.js';
import { RadeonProvider } from '../providers/radeon.js';
import { getQuotaStateForKeys, type QuotaObservationView } from './provider-quota.js';
import { getActiveCooldownsForKeys } from './ratelimit.js';
import { parseStoredUtc } from './quota-clock.js';
import { parseModelScope, scopeAllows } from '../lib/model-scope.js';
import type {
  CapacityFreshness,
  ProviderCapacityReading,
  ProviderCapacityPool,
  ProviderCapacityResponse,
  ProviderModelCapacity,
} from '@freellmapi/shared/types.js';

const ALLOCATION_MAX_AGE_MS = 15 * 60_000;
const RPM_MAX_AGE_MS = 60_000;
const POOL_KEY = 'radeon::daily-free';
const Keys = z.array(z.object({
  id: z.number().int().positive(), label: z.string(), enabled: z.number().int(),
  status: z.string(), model_scope_json: z.string().nullable(),
}));
const Models = z.array(z.object({
  id: z.number().int().positive(), model_id: z.string(), enabled: z.number().int(),
}));

/** Expired samples remain last-reported values; no refill is invented. */
function capacityReading(row: QuotaObservationView | undefined, divisor: number, maxAgeMs: number, now: number): ProviderCapacityReading {
  const observedMs = parseStoredUtc(row?.observedAt);
  const resetMs = parseStoredUtc(row?.resetAt);
  const limit = row?.limit == null ? null : row.limit / divisor;
  const remaining = row?.remaining == null ? null : row.remaining / divisor;
  const measured = observedMs != null && observedMs <= now && remaining != null && (row?.confidence ?? 0) >= 0.7;
  const freshness: CapacityFreshness = !measured
    ? 'unknown'
    : now - observedMs >= maxAgeMs || (resetMs != null && resetMs <= now) ? 'stale' : 'fresh';
  return {
    limit,
    remaining,
    used: limit == null || remaining == null ? null : Math.max(0, limit - remaining),
    remainingPct: limit == null || limit <= 0 || remaining == null ? null : Math.max(0, Math.min(100, remaining / limit * 100)),
    resetAt: resetMs == null ? null : new Date(resetMs).toISOString(),
    observedAt: observedMs == null ? null : new Date(observedMs).toISOString(),
    source: row?.source ?? null,
    freshness,
  };
}

/** Read-only capacity facts. Key eligibility, allocation and fleet load do not blend. */
export async function getProviderCapacity(): Promise<ProviderCapacityResponse> {
  const db = getDb();
  const keys = Keys.parse(db.prepare(`
    SELECT id, label, enabled, status, model_scope_json FROM api_keys
    WHERE platform = 'radeon' AND id > 0 ORDER BY id
  `).all());
  if (keys.length === 0) return { generatedAt: new Date().toISOString(), pools: [], models: [] };

  const provider = getProvider('radeon');
  if (!(provider instanceof RadeonProvider)) throw new Error('Radeon capacity provider is not registered');
  const pressure = provider.getModelPressure();
  const now = Date.now();
  const keyIds = keys.map(key => key.id);
  const keySet = new Set(keyIds);
  const observations = new Map<string, QuotaObservationView>();
  for (const row of getQuotaStateForKeys({ normalizeExpired: false })) {
    // Anonymous probes and deleted keys cannot create extra account allowances.
    if (row.platform !== 'radeon' || row.quotaPoolKey !== POOL_KEY || !keySet.has(row.keyId)) continue;
    observations.set(`${row.keyId}:${row.metric}`, row);
  }
  const cooldowns = getActiveCooldownsForKeys(keyIds, now);
  const pools: ProviderCapacityPool[] = keys.map(key => {
    const credit = observations.get(`${key.id}:credits`);
    return {
      platform: 'radeon', keyId: key.id, keyLabel: key.label || null,
      keyEnabled: key.enabled === 1, keyStatus: key.status, quotaPoolKey: POOL_KEY,
      // AMD reports USD-equivalent free usage points, stored in fractional cents.
      allocation: capacityReading(credit?.unit === 'cents' ? credit : undefined, 100, ALLOCATION_MAX_AGE_MS, now),
      rpm: capacityReading(observations.get(`${key.id}:requests`), 1, RPM_MAX_AGE_MS, now),
      cooldowns: (cooldowns.get(key.id) ?? []).filter(row => row.platform === 'radeon')
        .map(row => ({ modelId: row.modelId, expiresAtMs: row.expiresAtMs })),
    };
  });
  const scopedKeys = keys.map(key => ({ ...key, scope: parseModelScope(key.model_scope_json) }));
  const modelRows = Models.parse(db.prepare(`
    SELECT id, model_id, enabled FROM models WHERE platform = 'radeon' ORDER BY intelligence_rank, id
  `).all());
  const models: ProviderModelCapacity[] = modelRows.map(model => {
    const eligible = scopedKeys.filter(key => scopeAllows(key.scope, model.model_id));
    const reading = Object.hasOwn(pressure.models, model.model_id) ? pressure.models[model.model_id] : undefined;
    return {
      modelDbId: model.id, platform: 'radeon', modelId: model.model_id,
      modelEnabled: model.enabled === 1,
      keyIds: eligible.map(key => key.id),
      usableKeyIds: eligible.filter(key => key.enabled === 1 && (key.status === 'healthy' || key.status === 'unknown')).map(key => key.id),
      pressure: {
        state: reading?.state ?? null,
        utilizationPct: reading?.utilization ?? null,
        observedAt: reading ? pressure.observedAt : null,
        freshness: reading ? pressure.freshness : 'unknown',
        source: 'provider_api', scope: 'fleet',
      },
    };
  });
  return { generatedAt: new Date(now).toISOString(), pools, models };
}
