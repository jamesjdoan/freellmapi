import { getDb } from '../db/index.js';
import { isExtensionEnabled } from './extension-state.js';
import type { Db } from '../db/types.js';

// "Unlimited" models: an operator flag (models.unlimited) for a model that is
// free without a meter - OpenRouter's stealth models (Space Bunny) are the
// case. An effective unlimited model:
//   - skips every local usage gate (per-model RPM/RPD/TPM/TPD, provider
//     account caps, quota domains, monthly key caps) - cooldowns, health,
//     capability and per-key concurrency still apply;
//   - is not counted toward any limit (router/ratelimit skip recording it, and
//     the key_monthly_usage trigger skips its rows);
//   - is tried first within the chains it is a member of;
//   - passes the paid-balance guard.
//
// On a platform the paid-balance guard covers, a free-looking id proves
// nothing, so the flag is only EFFECTIVE while the provider's own public price
// listing says the model costs $0, re-checked on a timer. If the provider
// starts charging (a stealth period ends), the exemption lapses by itself and
// the guard and every limit apply again - no operator action needed.

/** Platforms whose ids do not say whether a call is billed (see
 *  provider-quota consumesPaidBalance). */
const PRICE_CHECKED_PLATFORMS = new Set(['openrouter', 'anyapi', 'unorouter']);
const OPENROUTER_MODELS_URL = 'https://openrouter.ai/api/v1/models';
const CACHE_TTL_MS = 5_000;
const PRICE_RECHECK_MS = 6 * 60 * 60 * 1000;

const key = (platform: string, modelId: string) => `${platform.toLowerCase()}\u0000${modelId}`;

let cache: { db: unknown; at: number; effective: Set<string> } | null = null;

/** Rebuild the effective set: flagged rows, minus price-checked platforms whose
 *  last recorded price is missing or above zero. */
function effectiveSet(db: Db): Set<string> {
  const now = Date.now();
  if (cache && cache.db === db && now - cache.at < CACHE_TTL_MS) return cache.effective;
  const rows = db.prepare(`
    SELECT m.platform, m.model_id, pc.price_found_usd
      FROM models m
      LEFT JOIN model_price_check pc ON pc.platform = m.platform AND pc.model_id = m.model_id
     WHERE m.unlimited = 1
  `).all() as { platform: string; model_id: string; price_found_usd: number | null }[];
  const effective = new Set<string>();
  for (const r of rows) {
    const checked = PRICE_CHECKED_PLATFORMS.has(r.platform.toLowerCase());
    if (!checked || r.price_found_usd === 0) effective.add(key(r.platform, r.model_id));
  }
  cache = { db, at: now, effective };
  return effective;
}

export function invalidateUnlimitedCache(): void {
  cache = null;
}

/** Whether this route currently gets unlimited treatment. Cheap: a cached set. */
export function isUnlimitedModel(platform: string, modelId: string | null | undefined): boolean {
  if (!modelId) return false;
  // Anything that cannot be read - no database yet, a closed one, a schema
  // before this migration - answers "not unlimited": limits stay on. This
  // sits on the request-recording path, which must never throw.
  try {
    // Off: flags are kept, but every limit and the paid-balance guard apply as normal.
    if (!isExtensionEnabled('unlimited-models')) return false;
    return effectiveSet(getDb()).has(key(platform, modelId));
  } catch {
    return false;
  }
}

export interface UnlimitedStatus {
  flagged: boolean;
  /** Whether the flag is in force right now. */
  effective: boolean;
  /** Needs a $0 price confirmation from the provider to take effect. */
  priceChecked: boolean;
  /** Last price the provider reported (USD per 1M prompt+completion); null = never checked. */
  lastPrice: number | null;
  lastCheckedAt: string | null;
}

export function unlimitedStatus(db: Db, platform: string, modelId: string): UnlimitedStatus {
  const row = db.prepare(`
    SELECT m.unlimited, pc.price_found_usd, pc.last_checked_at
      FROM models m
      LEFT JOIN model_price_check pc ON pc.platform = m.platform AND pc.model_id = m.model_id
     WHERE m.platform = ? AND m.model_id = ?
  `).get(platform, modelId) as { unlimited: number; price_found_usd: number | null; last_checked_at: string | null } | undefined;
  const priceChecked = PRICE_CHECKED_PLATFORMS.has(platform.toLowerCase());
  const flagged = row?.unlimited === 1;
  return {
    flagged,
    effective: flagged && (!priceChecked || row?.price_found_usd === 0),
    priceChecked,
    lastPrice: row?.price_found_usd ?? null,
    lastCheckedAt: row?.last_checked_at ?? null,
  };
}

/**
 * Record the provider's current price for every flagged model on a
 * price-checked platform. OpenRouter publishes pricing on its public model
 * listing; the other two do not, so their flags stay ineffective (treated as
 * paid) - the safe default for a guarded platform.
 *
 * A failed fetch records nothing: the last known price stands, so a network
 * blip neither grants nor revokes an exemption.
 */
export async function refreshUnlimitedPrices(db: Db = getDb(), fetchImpl: typeof fetch = fetch): Promise<number> {
  const flagged = db.prepare("SELECT platform, model_id FROM models WHERE unlimited = 1 AND lower(platform) = 'openrouter'")
    .all() as { platform: string; model_id: string }[];
  if (flagged.length === 0) return 0;
  let listing: { id?: unknown; pricing?: { prompt?: unknown; completion?: unknown } }[];
  try {
    const res = await fetchImpl(OPENROUTER_MODELS_URL, { signal: AbortSignal.timeout(30_000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body = await res.json() as { data?: unknown };
    if (!Array.isArray(body.data)) throw new Error('no data array');
    listing = body.data;
  } catch (err) {
    console.warn(`[unlimited-models] OpenRouter price check failed, keeping last known prices: ${err instanceof Error ? err.message : String(err)}`);
    return 0;
  }
  const price = new Map<string, number>();
  for (const m of listing) {
    if (typeof m.id !== 'string') continue;
    const prompt = Number(m.pricing?.prompt);
    const completion = Number(m.pricing?.completion);
    if (Number.isFinite(prompt) && Number.isFinite(completion)) price.set(m.id, (prompt + completion) * 1_000_000);
  }
  const upsert = db.prepare(`
    INSERT INTO model_price_check (platform, model_id, last_checked_at, price_found_usd)
    VALUES (?, ?, datetime('now'), ?)
    ON CONFLICT(platform, model_id) DO UPDATE SET
      price_found_usd = excluded.price_found_usd, last_checked_at = excluded.last_checked_at
  `);
  db.transaction(() => {
    // A model missing from the listing has no stated price: record it as
    // unknown, which keeps the exemption off rather than trusting a stale $0.
    for (const f of flagged) upsert.run(f.platform, f.model_id, price.has(f.model_id) ? price.get(f.model_id)! : null);
  })();
  invalidateUnlimitedCache();
  return flagged.length;
}

let timer: NodeJS.Timeout | null = null;

/** Check at boot and every six hours. Not unref'd work: a failed check only logs. */
export function startUnlimitedPriceCheck(): void {
  if (timer || process.env.UNLIMITED_PRICE_CHECK_DISABLED) return;
  void refreshUnlimitedPrices();
  timer = setInterval(() => { void refreshUnlimitedPrices() }, PRICE_RECHECK_MS);
  timer.unref();
}
