import { getDb } from '../db/index.js';
import { decrypt } from '../lib/crypto.js';
import { recordQuotaObservation } from './provider-quota.js';
import type { Scheduler } from '../lib/scheduler.js';
import type { Platform } from '@freellmapi/shared/types.js';

// Reading quota from a provider's own usage API — the second-highest source of
// truth in the precedence order, above anything configured or documented and
// below only a header on the response we just made.
//
// Worth having because the alternative is estimating. Ollama Cloud publishes no
// figure for its free allowance and sends no rate-limit headers, so the ledger
// was carrying the low end of a documented token range at confidence 0.25. Its
// undocumented /api/usage endpoint answers the question directly:
//
//   "limits": { "session": { "usage": 0.121 }, "weekly": { "usage": 0.05 } }
//
// Fractions of the real allowance, per window, from the account itself. That
// also settles the shape: the free tier binds on a session window and a weekly
// one, not the monthly cycle the pricing page describes for paid plans.

/** Scale for a provider that reports a fraction rather than a count. Ten
 *  thousand units keeps 0.01% of resolution through integer columns, which is
 *  finer than any provider's own reporting. */
const FRACTION_UNITS = 10_000;

interface UsageObservation {
  quotaPoolKey: string;
  /** Whatever unit the provider counts in, already scaled to integers. */
  limit: number;
  remaining: number;
  /** Denomination of those integers, so a reader is displayable: 'cents' for a
   *  currency balance, 'per_10k' for a fraction of an unsized allowance. */
  unit: 'cents' | 'per_10k';
  notes: string;
}

/**
 * Ollama Cloud. Undocumented, so treated as best-effort: a shape change makes
 * this return nothing rather than throwing, and the ledger falls back to the
 * documented estimate it used before.
 */
async function readOllamaUsage(apiKey: string): Promise<UsageObservation[]> {
  const res = await fetch('https://ollama.com/api/usage', {
    headers: { Authorization: `Bearer ${apiKey}` },
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) return [];
  const body = await res.json() as {
    limits?: Record<string, { usage?: unknown } | undefined>;
  };
  const out: UsageObservation[] = [];
  for (const window of ['session', 'weekly'] as const) {
    const usage = body?.limits?.[window]?.usage;
    // 0 is a legitimate reading — a freshly reset window — so only a
    // non-number is missing data.
    if (typeof usage !== 'number' || !Number.isFinite(usage)) continue;
    const usedFraction = Math.max(0, Math.min(1, usage));
    out.push({
      quotaPoolKey: `ollama::${window}`,
      limit: FRACTION_UNITS,
      remaining: Math.round((1 - usedFraction) * FRACTION_UNITS),
      unit: 'per_10k',
      notes: `ollama /api/usage limits.${window}.usage=${usage}`,
    });
  }
  return out;
}

/**
 * OpenRouter. Documented, unlike Ollama's: /api/v1/credits returns the credit
 * balance in dollars, and /api/v1/auth/key returns spend per period.
 *
 * Recorded in cents, because the columns are integers and a balance is not.
 *
 * `is_free_tier` is the field that decides which free-model request allowance
 * applies - 50 a day on the free tier, 1000 once the account holds credit - so
 * it is captured in the note rather than guessed at.
 */
async function readOpenRouterUsage(apiKey: string): Promise<UsageObservation[]> {
  const headers = { Authorization: `Bearer ${apiKey}` };
  const res = await fetch('https://openrouter.ai/api/v1/credits', {
    headers, signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) return [];
  const body = await res.json() as { data?: { total_credits?: unknown; total_usage?: unknown } };
  const total = body?.data?.total_credits;
  const used = body?.data?.total_usage;
  if (typeof total !== 'number' || !Number.isFinite(total) || total <= 0) return [];
  if (typeof used !== 'number' || !Number.isFinite(used)) return [];

  let tier = '';
  try {
    const keyRes = await fetch('https://openrouter.ai/api/v1/auth/key', {
      headers, signal: AbortSignal.timeout(15_000),
    });
    if (keyRes.ok) {
      const keyBody = await keyRes.json() as { data?: { is_free_tier?: unknown; usage_daily?: unknown } };
      // Never the key label or id - those identify the credential.
      tier = ` is_free_tier=${keyBody?.data?.is_free_tier} usage_daily=${keyBody?.data?.usage_daily}`;
    }
  } catch { /* the balance alone is still worth recording */ }

  const cents = (dollars: number): number => Math.round(dollars * 100);
  return [{
    quotaPoolKey: 'openrouter::credits',
    limit: cents(total),
    remaining: Math.max(0, cents(total) - cents(used)),
    unit: 'cents',
    notes: `openrouter /api/v1/credits total=${total} used=${used}${tier}`,
  }];
}

const USAGE_READERS: Partial<Record<Platform, (apiKey: string) => Promise<UsageObservation[]>>> = {
  ollama: readOllamaUsage,
  openrouter: readOpenRouterUsage,
};

export function platformsWithUsageApi(): Platform[] {
  return Object.keys(USAGE_READERS) as Platform[];
}

interface KeyRow { id: number; platform: string; encrypted_key: string; iv: string; auth_tag: string }

/**
 * Poll every configured key whose provider exposes a usage API and record what
 * it says. One pass; returns how many observations were written so a caller can
 * tell "nothing to read" from "read nothing".
 */
export async function pollProviderUsageApis(): Promise<number> {
  let rows: KeyRow[];
  try {
    const platforms = platformsWithUsageApi();
    if (platforms.length === 0) return 0;
    rows = getDb().prepare(`
      SELECT id, platform, encrypted_key, iv, auth_tag FROM api_keys
       WHERE enabled = 1 AND status != 'invalid'
         AND platform IN (${platforms.map(() => '?').join(', ')})
    `).all(...platforms) as KeyRow[];
  } catch {
    return 0;
  }

  let written = 0;
  for (const row of rows) {
    const reader = USAGE_READERS[row.platform as Platform];
    if (!reader) continue;
    let apiKey: string;
    try {
      apiKey = decrypt(row.encrypted_key, row.iv, row.auth_tag);
    } catch {
      continue;
    }
    let observations: UsageObservation[];
    try {
      observations = await reader(apiKey);
    } catch {
      // An undocumented endpoint is allowed to disappear. Losing it costs the
      // measurement, not the request path.
      continue;
    }
    for (const observation of observations) {
      try {
        recordQuotaObservation({
          platform: row.platform as Platform,
          keyId: row.id,
          quotaPoolKey: observation.quotaPoolKey,
          // The allowance is credit, not requests or tokens: Ollama meters
          // dollars of usage at per-model token rates.
          metric: 'credits',
          limit: observation.limit,
          remaining: observation.remaining,
          unit: observation.unit,
          // The provider reports how much is left but not when it comes back.
          // Inventing a reset instant would be the one thing worse than not
          // having one.
          resetAt: null,
          resetStrategy: 'rolling_window',
          source: 'quota_api',
          confidence: 0.9,
          notes: observation.notes,
          endpoint: 'usage',
        });
        written++;
      } catch {
        // Recording is best-effort; a failed write must not stop the next key.
      }
    }
  }
  return written;
}

const SCAN_INTERVAL_MS = 5 * 60_000;
let cancelJob: (() => void) | null = null;
let inFlight = false;

export function startProviderUsagePolling(scheduler: Scheduler): void {
  if (cancelJob) return;
  if (process.env.PROVIDER_USAGE_API_DISABLED === '1') {
    console.log('[ProviderUsage] polling disabled via PROVIDER_USAGE_API_DISABLED=1');
    return;
  }
  console.log(`[ProviderUsage] polling provider usage APIs every ${SCAN_INTERVAL_MS / 1000}s`);
  const pass = async (): Promise<void> => {
    if (inFlight) return;
    inFlight = true;
    try {
      await pollProviderUsageApis();
    } catch (err) {
      console.error('[ProviderUsage] poll failed:', err);
    } finally {
      inFlight = false;
    }
  };
  // Read once at startup so a restart does not leave the ledger stale for five
  // minutes.
  void pass();
  cancelJob = scheduler.every(SCAN_INTERVAL_MS, pass, { name: 'provider-usage-api' });
}

export function stopProviderUsagePolling(): void {
  cancelJob?.();
  cancelJob = null;
  inFlight = false;
}
