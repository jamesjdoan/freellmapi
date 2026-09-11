import { getDb, getSetting, setSetting } from '../db/index.js';
import { parseModelScope, scopeAllows } from '../lib/model-scope.js';
import type { Db } from '../db/types.js';
import { encrypt, decrypt } from '../lib/crypto.js';
import { matchAaModel, type AaCandidate } from './analysis-match.js';
import { getModelGroups } from './model-groups.js';

// Artificial Analysis benchmark data, cached locally and mapped to our models.
//
// `models.intelligence_rank` and `speed_rank` are OUR numbers: per-provider,
// hand-tuned, good for ordering a chain and nothing else. They cannot answer
// "is Kimi K3 actually better at coding than GPT-OSS 120B" — nothing in this
// database has ever measured that. Artificial Analysis has.
//
// The free endpoint is used deliberately, not the Pro one: it carries the three
// headline indices, which is the whole question here, and it accepts a key of
// any tier. Reaching for `/language/models` instead would 403 every Free key
// for data this feature does not use.
//
// Their terms require visible attribution wherever the data is shown. The
// Compare Models panel carries it; do not remove it.

const AA_BASE = 'https://artificialanalysis.ai/api/v2';

// settings keys
const SETTING_KEY = 'aa_api_key_encrypted'; // JSON { encrypted, iv, authTag }
const SETTING_LAST_SYNC = 'aa_last_sync_ms';
const SETTING_LAST_ERROR = 'aa_last_error';
const SETTING_TIER = 'aa_tier';
const SETTING_RATE = 'aa_rate_limit'; // JSON { limit, remaining, resetAt }

/**
 * The key is encrypted at rest, unlike `premium_license_key` beside it in
 * settings. Artificial Analysis document theirs as a production secret whose
 * leak requires rotation, and this repo already encrypts provider keys with the
 * same helpers — storing this one in clear would be the odd choice, not this.
 */
export function setAnalysisKey(key: string): void {
  const trimmed = key.trim();
  if (!trimmed) throw new Error('Key is empty');
  setSetting(SETTING_KEY, JSON.stringify(encrypt(trimmed)));
}

export function clearAnalysisKey(): void {
  const db = getDb();
  db.prepare('DELETE FROM settings WHERE key IN (?, ?, ?, ?)')
    .run(SETTING_KEY, SETTING_TIER, SETTING_RATE, SETTING_LAST_ERROR);
}

export function getAnalysisKey(): string | null {
  const stored = getSetting(SETTING_KEY);
  if (!stored) return null;
  try {
    const parsed = JSON.parse(stored) as { encrypted: string; iv: string; authTag: string };
    return decrypt(parsed.encrypted, parsed.iv, parsed.authTag);
  } catch {
    // A key encrypted under a different ENCRYPTION_KEY cannot be recovered and
    // must not read as "no key configured": the operator needs to know it is
    // there and unreadable, which is what the status surface reports.
    return null;
  }
}

export interface AnalysisStatus {
  configured: boolean;
  /** True when a key is stored but will not decrypt — a changed
   *  ENCRYPTION_KEY, which is a different problem from having no key. */
  unreadable: boolean;
  tier: string | null;
  lastSyncMs: number | null;
  lastError: string | null;
  rateLimit: { limit: number | null; remaining: number | null; resetAt: string | null } | null;
  /** Cached rows and how many of our models are linked. */
  cachedModels: number;
  linkedModels: number;
  indexVersion: string | null;
}

export function getAnalysisStatus(db: Db = getDb()): AnalysisStatus {
  const stored = getSetting(SETTING_KEY);
  const rate = getSetting(SETTING_RATE);
  const lastSync = getSetting(SETTING_LAST_SYNC);
  const cached = (db.prepare('SELECT COUNT(*) AS c FROM aa_model').get() as { c: number }).c;
  const linked = (db.prepare('SELECT COUNT(*) AS c FROM aa_model_link WHERE aa_slug IS NOT NULL')
    .get() as { c: number }).c;
  const version = (db.prepare('SELECT index_version FROM aa_model WHERE index_version IS NOT NULL LIMIT 1')
    .get() as { index_version: string } | undefined)?.index_version ?? null;
  return {
    configured: Boolean(stored),
    unreadable: Boolean(stored) && getAnalysisKey() === null,
    tier: getSetting(SETTING_TIER) ?? null,
    lastSyncMs: lastSync ? Number(lastSync) : null,
    lastError: getSetting(SETTING_LAST_ERROR) ?? null,
    rateLimit: rate ? JSON.parse(rate) : null,
    cachedModels: cached,
    linkedModels: linked,
    indexVersion: version,
  };
}

interface FreeModel {
  slug: string;
  name: string;
  release_date: string | null;
  model_creator?: { name?: string } | null;
  evaluations?: {
    artificial_analysis_intelligence_index?: number | null;
    artificial_analysis_coding_index?: number | null;
    artificial_analysis_agentic_index?: number | null;
  } | null;
  pricing?: { price_1m_input_tokens?: number | null; price_1m_output_tokens?: number | null } | null;
  performance?: {
    median_output_tokens_per_second?: number | null;
    median_time_to_first_token_seconds?: number | null;
  } | null;
}

interface FreeResponse {
  tier?: string;
  intelligence_index_version?: number;
  pagination?: { page: number; total_pages: number; has_more?: boolean };
  data?: FreeModel[];
}

export interface SyncResult {
  ok: boolean;
  fetched: number;
  linked: number;
  unmatched: number;
  error?: string;
}

/**
 * Refetch every page and rebuild the cache.
 *
 * The rate limit is a fixed 100 requests per 24h on the Free tier, shared
 * across the whole organisation — so this is manual, never scheduled. A poller
 * would spend the operator's daily quota on data that changes weekly.
 */
export async function syncAnalysis(db: Db = getDb()): Promise<SyncResult> {
  const key = getAnalysisKey();
  if (!key) {
    const stored = getSetting(SETTING_KEY);
    return {
      ok: false, fetched: 0, linked: 0, unmatched: 0,
      error: stored
        ? 'The stored key could not be decrypted — ENCRYPTION_KEY has changed since it was saved.'
        : 'No Artificial Analysis key configured.',
    };
  }

  const models: FreeModel[] = [];
  let version: string | null = null;
  try {
    let page = 1;
    // Bounded: a runaway `has_more` must not spend the whole daily quota in a
    // loop. Their catalogue is a few hundred models at a few dozen per page.
    for (; page <= 20; page++) {
      const res = await fetch(`${AA_BASE}/language/models/free?page=${page}`, {
        headers: { 'x-api-key': key },
        signal: AbortSignal.timeout(30_000),
      });
      recordRateLimit(res);
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        throw new Error(describeFailure(res.status, body));
      }
      const payload = await res.json() as FreeResponse;
      if (payload.tier) setSetting(SETTING_TIER, payload.tier);
      if (payload.intelligence_index_version != null) {
        version = `v${payload.intelligence_index_version}`;
      }
      models.push(...(payload.data ?? []));
      const pag = payload.pagination;
      const more = pag?.has_more ?? (pag ? pag.page < pag.total_pages : false);
      if (!more) break;
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    setSetting(SETTING_LAST_ERROR, message);
    return { ok: false, fetched: 0, linked: 0, unmatched: 0, error: message };
  }

  const upsert = db.prepare(`
    INSERT INTO aa_model (slug, name, creator, release_date, intelligence_index, coding_index,
                          agentic_index, price_1m_input, price_1m_output,
                          median_output_tokens_per_second, median_time_to_first_token_seconds,
                          index_version, fetched_at)
    VALUES (@slug, @name, @creator, @releaseDate, @intelligence, @coding, @agentic,
            @priceIn, @priceOut, @tps, @ttft, @version, datetime('now'))
    ON CONFLICT(slug) DO UPDATE SET
      name = excluded.name, creator = excluded.creator, release_date = excluded.release_date,
      intelligence_index = excluded.intelligence_index, coding_index = excluded.coding_index,
      agentic_index = excluded.agentic_index, price_1m_input = excluded.price_1m_input,
      price_1m_output = excluded.price_1m_output,
      median_output_tokens_per_second = excluded.median_output_tokens_per_second,
      median_time_to_first_token_seconds = excluded.median_time_to_first_token_seconds,
      index_version = excluded.index_version, fetched_at = excluded.fetched_at
  `);

  db.transaction(() => {
    for (const m of models) {
      if (!m.slug) continue;
      upsert.run({
        slug: m.slug,
        name: m.name ?? m.slug,
        creator: m.model_creator?.name ?? null,
        releaseDate: m.release_date ?? null,
        intelligence: m.evaluations?.artificial_analysis_intelligence_index ?? null,
        coding: m.evaluations?.artificial_analysis_coding_index ?? null,
        agentic: m.evaluations?.artificial_analysis_agentic_index ?? null,
        priceIn: m.pricing?.price_1m_input_tokens ?? null,
        priceOut: m.pricing?.price_1m_output_tokens ?? null,
        tps: m.performance?.median_output_tokens_per_second ?? null,
        ttft: m.performance?.median_time_to_first_token_seconds ?? null,
        version,
      });
    }
    // Slugs that vanished upstream: the cache is a mirror, so a stale row would
    // keep serving scores AA has withdrawn. Links to them survive - see
    // relinkAll, which reports them as unresolved rather than deleting the
    // operator's mapping.
    if (models.length > 0) {
      const keep = models.map(m => m.slug).filter(Boolean);
      const placeholders = keep.map(() => '?').join(',');
      db.prepare(`DELETE FROM aa_model WHERE slug NOT IN (${placeholders})`).run(...keep);
    }
  })();

  setSetting(SETTING_LAST_SYNC, String(Date.now()));
  const db2 = getDb();
  db2.prepare('DELETE FROM settings WHERE key = ?').run(SETTING_LAST_ERROR);

  const { linked, unmatched } = relinkAll(db);
  return { ok: true, fetched: models.length, linked, unmatched };
}

function describeFailure(status: number, body: string): string {
  // Their documented status meanings, said plainly - "403" alone sends the
  // operator to the docs to learn they are on the wrong tier.
  switch (status) {
    case 401: return 'Artificial Analysis rejected the key (401). Check it in API key management.';
    case 403: return 'The key is valid but its tier does not cover this endpoint (403).';
    case 429: return 'Daily rate limit exhausted (429). The quota resets on a fixed 24-hour window.';
    default: return `Artificial Analysis returned ${status}${body ? `: ${body.slice(0, 200)}` : ''}`;
  }
}

function recordRateLimit(res: Response): void {
  const limit = res.headers.get('x-ratelimit-limit');
  const remaining = res.headers.get('x-ratelimit-remaining');
  const reset = res.headers.get('x-ratelimit-reset');
  if (!limit && !remaining && !reset) return;
  setSetting(SETTING_RATE, JSON.stringify({
    limit: limit ? Number(limit) : null,
    remaining: remaining ? Number(remaining) : null,
    // Documented as a Unix timestamp; stored as ISO so the client needs no
    // knowledge of which unit it arrived in.
    resetAt: reset ? new Date(Number(reset) * 1000).toISOString() : null,
  }));
}

/**
 * Re-run the matcher across the catalogue.
 *
 * Manual links are never touched, and neither is a manual "no counterpart"
 * (an `aa_slug IS NULL` row with source `manual`) — that is the operator
 * telling the matcher to stop proposing, and it has to stick.
 */
export function relinkAll(db: Db = getDb()): { linked: number; unmatched: number } {
  const candidates = db.prepare('SELECT slug, name FROM aa_model').all() as AaCandidate[];
  const rows = db.prepare(`
    SELECT m.platform, m.model_id, m.display_name, l.source AS link_source
      FROM models m
      LEFT JOIN aa_model_link l ON l.platform = m.platform AND l.model_id = m.model_id
  `).all() as { platform: string; model_id: string; display_name: string; link_source: string | null }[];

  const upsert = db.prepare(`
    INSERT INTO aa_model_link (platform, model_id, aa_slug, source, match_reason)
    VALUES (?, ?, ?, 'auto', ?)
    ON CONFLICT(platform, model_id) DO UPDATE SET
      aa_slug = excluded.aa_slug, source = 'auto', match_reason = excluded.match_reason,
      created_at = datetime('now')
    WHERE aa_model_link.source = 'auto'
  `);

  let linked = 0;
  let unmatched = 0;
  db.transaction(() => {
    for (const row of rows) {
      // Operator decisions of either kind are left alone; only 'auto' rows are
      // re-proposed. A proxy is as deliberate as a manual match.
      if (row.link_source === 'manual' || row.link_source === 'proxy') { linked++; continue; }
      const hit = matchAaModel(row.model_id, row.display_name, candidates);
      if (hit) {
        upsert.run(row.platform, row.model_id, hit.slug, hit.reason);
        linked++;
      } else {
        upsert.run(row.platform, row.model_id, null, null);
        unmatched++;
      }
    }
  })();
  return { linked, unmatched };
}

/** Point one of our models at an AA slug by hand, or at nothing. */
/**
 * Pin a model to a benchmark by hand.
 *
 * `source: 'proxy'` records a DIFFERENT claim: not "this is that model", but
 * "nothing here measures this one, so read it as roughly this". A model absent
 * from the upstream catalogue has no scores at all, and a stand-in is more
 * useful than a dash — but it is an estimate, and everything downstream has to
 * keep being able to tell the two apart. In particular a proxy must never imply
 * two routes are the same model.
 *
 * Both survive a re-match: relinkAll only overwrites rows whose source is
 * 'auto'.
 */
export function setManualLink(
  platform: string,
  modelId: string,
  aaSlug: string | null,
  db: Db = getDb(),
  source: 'manual' | 'proxy' = 'manual',
): void {
  db.prepare(`
    INSERT INTO aa_model_link (platform, model_id, aa_slug, source, match_reason, proxy_delta)
    VALUES (?, ?, ?, ?, NULL, 0)
    ON CONFLICT(platform, model_id) DO UPDATE SET
      aa_slug = excluded.aa_slug, source = excluded.source, match_reason = NULL,
      -- The adjustment described the OLD stand-in; carrying it onto a new one
      -- would silently mis-state the new estimate.
      proxy_delta = 0,
      created_at = datetime('now')
  `).run(platform, modelId, aaSlug, source);
}

/** Hand a model back to the matcher, discarding a manual decision. */
export function clearManualLink(platform: string, modelId: string, db: Db = getDb()): void {
  db.prepare('DELETE FROM aa_model_link WHERE platform = ? AND model_id = ?').run(platform, modelId);
}

export interface CompareRow {
  /** Catalogue row id, so a caller can toggle the model itself and not only
   *  its key scope. */
  modelDbId: number;
  platform: string;
  modelId: string;
  displayName: string;
  enabled: boolean;
  contextWindow: number | null;
  /** A usable key exists for this route's platform, so it can actually serve.
   *  False means catalogue knowledge rather than supply. */
  hasKey: boolean;
  /** Whether the platform's key scope is what stands in the way, and so whether
   *  widening it is an available move. */
  keyScope: 'none' | 'disabled' | 'unscoped' | 'in' | 'out';
  supportsTools: boolean;
  supportsVision: boolean;
  /** Our own ordering numbers, kept alongside deliberately: seeing a
   *  hand-tuned rank next to a measured index is how you find out the rank was
   *  wrong. */
  intelligenceRank: number;
  speedRank: number;
  /** Chains this model currently serves, so a comparison can be read against
   *  what it is actually being used for. */
  chains: string[];
  /** Null when unlinked, or linked to a slug the last sync no longer returned. */
  analysis: {
    slug: string;
    name: string;
    creator: string | null;
    intelligenceIndex: number | null;
    codingIndex: number | null;
    agenticIndex: number | null;
    price1mInput: number | null;
    price1mOutput: number | null;
    medianOutputTokensPerSecond: number | null;
    medianTimeToFirstTokenSeconds: number | null;
  } | null;
  link: {
    /** 'proxy' is a stand-in for a model the upstream does not publish: the
     *  scores are an estimate and do NOT say two routes are the same model. */
    slug: string | null;
    /** Index points added to a PROXY's borrowed scores. Nothing but an estimate
     *  can carry one: on a measurement it would be editing the measurement. */
    proxyDelta: number;
    source: 'auto' | 'manual' | 'proxy';
    matchReason: string | null;
    /** True when the link names a slug the cache no longer has — AA withdrew
     *  it, or the operator mapped to a stale one. Distinct from unlinked. */
    unresolved: boolean;
  } | null;
}

export interface ComparePayload {
  rows: CompareRow[];
  /** Every cached slug, for the manual mapping picker. */
  catalogue: { slug: string; name: string; creator: string | null; intelligenceIndex: number | null }[];
  status: AnalysisStatus;
}

/**
 * Our models with their AA counterpart attached.
 *
 * Only chat models: media and embedding rows live in their own tables and AA's
 * language endpoint has nothing to say about them.
 */
export function getComparePayload(db: Db = getDb()): ComparePayload {
  const rows = db.prepare(`
    SELECT m.id AS model_db_id, m.platform, m.model_id, m.display_name, m.enabled, m.context_window,
           m.supports_tools, m.supports_vision, m.intelligence_rank, m.speed_rank,
           l.aa_slug, l.source AS link_source, l.match_reason, l.proxy_delta,
           a.slug AS aa_present, a.name AS aa_name, a.creator, a.intelligence_index,
           a.coding_index, a.agentic_index, a.price_1m_input, a.price_1m_output,
           a.median_output_tokens_per_second, a.median_time_to_first_token_seconds,
           (SELECT GROUP_CONCAT(p.name, '|')
              FROM profile_models pm JOIN profiles p ON p.id = pm.profile_id
             WHERE pm.model_db_id = m.id AND pm.enabled = 1) AS chains
      FROM models m
      LEFT JOIN aa_model_link l ON l.platform = m.platform AND l.model_id = m.model_id
      LEFT JOIN aa_model a ON a.slug = l.aa_slug
     ORDER BY m.platform, m.model_id
  `).all() as Record<string, unknown>[];

  // Keys we could actually serve with. Holding a key for a platform is NOT the
  // same as being able to call a given model on it: keys carry a model scope,
  // and a scoped key covers only the ids it names. Judged with the same
  // `scopeAllows` routing uses, so this column cannot claim a route is
  // reachable that the router would reject for want of a key.
  const usableKeys = db.prepare(
    "SELECT platform, model_scope_json FROM api_keys WHERE enabled = 1 AND status IN ('healthy', 'unknown')",
  ).all() as { platform: string; model_scope_json: string | null }[];
  const keysByPlatform = new Map<string, (Set<string> | null)[]>();
  for (const k of usableKeys) {
    const list = keysByPlatform.get(k.platform) ?? [];
    list.push(parseModelScope(k.model_scope_json));
    keysByPlatform.set(k.platform, list);
  }
  // Platforms where a key EXISTS but cannot serve — switched off, or in a
  // failed state. Telling an operator to "add a key" for one of these is wrong
  // twice over: they already have one, and switching it off was a decision
  // (a provider whose free allowance is not worth spending, say). The useful
  // move there is the Keys page, not the add dialog.
  const platformsWithUnusableKey = new Set((db.prepare(
    `SELECT DISTINCT platform FROM api_keys
      WHERE enabled = 0 OR status NOT IN ('healthy', 'unknown')`,
  ).all() as { platform: string }[]).map(r => r.platform));
  const hasUsableKey = (platform: string, modelId: string) =>
    (keysByPlatform.get(platform) ?? []).some(scope => scopeAllows(scope, modelId));

  // Why a route is or is not reachable, which is what decides whether an
  // operator can do anything about it:
  //   none      no key for the platform at all — adding one is the move
  //   disabled  a key exists but is switched off or unhealthy — enabling is
  //   unscoped  a key that already covers every model here
  //   in        named by a scoped key
  //   out       a scoped key exists and does not name it — one edit away
  const keyScopeOf = (platform: string, modelId: string): 'none' | 'disabled' | 'unscoped' | 'in' | 'out' => {
    const scopes = keysByPlatform.get(platform);
    if (!scopes || scopes.length === 0) {
      return platformsWithUnusableKey.has(platform) ? 'disabled' : 'none';
    }
    if (scopes.some(sc => sc === null)) return 'unscoped';
    return scopes.some(sc => scopeAllows(sc, modelId)) ? 'in' : 'out';
  };

  const catalogue = db.prepare(`
    SELECT slug, name, creator, intelligence_index
      FROM aa_model
     ORDER BY intelligence_index IS NULL, intelligence_index DESC, name
  `).all() as { slug: string; name: string; creator: string | null; intelligence_index: number | null }[];

  return {
    rows: rows.map(r => ({
      modelDbId: Number(r.model_db_id ?? r.id),
      platform: String(r.platform),
      modelId: String(r.model_id),
      displayName: String(r.display_name ?? r.model_id),
      enabled: r.enabled === 1,
      contextWindow: r.context_window == null ? null : Number(r.context_window),
      hasKey: hasUsableKey(String(r.platform), String(r.model_id)),
      keyScope: keyScopeOf(String(r.platform), String(r.model_id)),
      supportsTools: r.supports_tools === 1,
      supportsVision: r.supports_vision === 1,
      intelligenceRank: Number(r.intelligence_rank ?? 0),
      speedRank: Number(r.speed_rank ?? 0),
      chains: r.chains ? String(r.chains).split('|') : [],
      analysis: r.aa_present
        ? {
          slug: String(r.aa_slug),
          name: String(r.aa_name),
          creator: r.creator == null ? null : String(r.creator),
          // The adjustment is applied HERE, not in the UI, so every table sorts
          // on the number it prints. Only a proxy carries one; on a measurement
          // it would be editing the measurement.
          intelligenceIndex: nudge(numberOrNull(r.intelligence_index), r),
          codingIndex: nudge(numberOrNull(r.coding_index), r),
          agenticIndex: nudge(numberOrNull(r.agentic_index), r),
          price1mInput: numberOrNull(r.price_1m_input),
          price1mOutput: numberOrNull(r.price_1m_output),
          medianOutputTokensPerSecond: numberOrNull(r.median_output_tokens_per_second),
          medianTimeToFirstTokenSeconds: numberOrNull(r.median_time_to_first_token_seconds),
        }
        : null,
      link: r.link_source
        ? {
          slug: r.aa_slug == null ? null : String(r.aa_slug),
          source: r.link_source === 'manual' || r.link_source === 'proxy'
            ? r.link_source
            : 'auto' as const,
          proxyDelta: Number(r.proxy_delta ?? 0),
          matchReason: r.match_reason == null ? null : String(r.match_reason),
          unresolved: r.aa_slug != null && !r.aa_present,
        }
        : null,
    })),
    catalogue: catalogue.map(c => ({
      slug: c.slug, name: c.name, creator: c.creator, intelligenceIndex: c.intelligence_index,
    })),
    status: getAnalysisStatus(db),
  };
}

function numberOrNull(value: unknown): number | null {
  // NULL is "not measured" in their data and must never become 0 here: a model
  // with no agentic score would plot as the worst instead of as absent.
  return value == null ? null : Number(value);
}

export interface CompareGroup {
  /** The router's grouping identity: the normalised display name. This is what
   *  `unifyOverrides.merges` keys on, so the UI can merge with it directly. */
  groupKey: string;
  /** The id advertised on /v1/models for this logical model. */
  canonicalId: string;
  name: string;
  /** True when an operator merge built this group rather than the catalogue's
   *  names matching by themselves. */
  userDefined: boolean;
  /** Every route this group condenses, newest-capable first is NOT implied:
   *  order is the members' own, so the reader can see all of them. */
  members: CompareRow[];
  /** Routes backed by a usable provider key. Zero means the entry cannot serve
   *  a request however it is configured. */
  keyedMembers?: number;
  /** A pinned baseline rather than something we serve: no routes, no chains,
   *  no rank of ours. Rendered apart so it reads as a yardstick, not supply. */
  reference?: boolean;
  /** The AA data the whole group is compared on. */
  analysis: CompareRow['analysis'];
  /** Where the score came from: this model's own link, or inherited from a
   *  merged sibling. A reader deciding on an unmatched provider route needs to
   *  know the number is not that route's own measurement. */
  analysisSource: 'inherited' | 'own' | null;
  /** True when members carry links to DIFFERENT slugs. The group still shows
   *  one score, but silently picking one of two would be a fabrication. */
  conflicted: boolean;
  /** Union across members, since a group serves wherever any member does. */
  chains: string[];
  enabledMembers: number;
}

/**
 * The comparison, condensed: one entry per LOGICAL model.
 *
 * The grouping is the router's own — `getModelGroups()`, the unification that
 * decides what a request for a unified id resolves to and which providers it
 * fails over across. Compare deliberately mirrors it rather than keeping a
 * grouping of its own: two grouping systems would drift, and the whole point of
 * comparing is to compare the things that actually route.
 *
 * So a merge made on the Models page shows up here, and the benchmark scores
 * attach to the logical model rather than to each provider's copy of it.
 */
const REFERENCE_SLUGS_KEY = 'analysis_reference_slugs';

/**
 * Benchmarks pinned as a baseline to read the catalogue against.
 *
 * A reference is a model we do NOT serve — a paid frontier model, typically —
 * kept on the page so "12.3 coding" means something. Stored as slugs rather
 * than copied scores: a sync refreshes them like everything else, and a slug
 * the upstream withdrew resolves to nothing rather than to a stale number.
 */
export function getReferenceSlugs(): string[] {
  const raw = getSetting(REFERENCE_SLUGS_KEY);
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === 'string') : [];
  } catch { return []; }
}

export function setReferenceSlugs(slugs: string[]): string[] {
  const unique = [...new Set(slugs.map(s => s.trim()).filter(Boolean))];
  setSetting(REFERENCE_SLUGS_KEY, JSON.stringify(unique));
  return unique;
}

/**
 * References shaped as memberless groups, so they sort, render and chart
 * through exactly the same path as a real entry. Nothing downstream needs a
 * second code path; a reference simply has no routes, no chains and no rank of
 * ours — which is honest, because we do not serve it.
 */
export function getReferenceGroups(db: Db = getDb()): CompareGroup[] {
  // Strongest first, unmeasured last, ties on slug. Insertion order would mean
  // the same set of baselines read differently depending on the order they
  // happened to be pinned in, which is not a property a yardstick should have.
  const byIndex = (a: CompareGroup, b: CompareGroup) => {
    const x = a.analysis?.intelligenceIndex ?? null;
    const y = b.analysis?.intelligenceIndex ?? null;
    if (x == null && y == null) return (a.analysis?.slug ?? '').localeCompare(b.analysis?.slug ?? '');
    if (x == null) return 1;
    if (y == null) return -1;
    return y - x || (a.analysis?.slug ?? '').localeCompare(b.analysis?.slug ?? '');
  };
  return getReferenceSlugs().flatMap(slug => {
    const analysis = lookupAa(db, slug);
    if (!analysis) return [];
    return [{
      groupKey: `ref:${slug}`,
      canonicalId: `ref:${slug}`,
      name: analysis.name,
      userDefined: false,
      members: [],
      analysis,
      analysisSource: 'own' as const,
      conflicted: false,
      chains: [],
      enabledMembers: 0,
      keyedMembers: 0,
      reference: true,
    }];
  }).sort(byIndex);
}

export function getGroupedCompare(db: Db = getDb()): CompareGroup[] {
  const { rows } = getComparePayload(db);
  const byKey = new Map(rows.map(r => [`${r.platform}:${r.modelId}`, r]));

  return getModelGroups().map(g => {
    const members = g.members
      .map(m => byKey.get(`${m.platform}:${m.model_id}`))
      .filter((r): r is CompareRow => r !== undefined);
    // Slugs the members' own links name. More than one means the merge put
    // together models Artificial Analysis considers different — worth saying
    // rather than silently showing one of them.
    // Proxies excluded: a stand-in disagreeing with a real match is not the
    // group disagreeing about what it is, it is one route being estimated.
    const linkedSlugs = [...new Set(
      members.filter(m => m.link?.source !== 'proxy').map(m => m.analysis?.slug).filter(Boolean),
    )] as string[];
    const inherited = members.find(m => m.analysis)?.analysis ?? null;
    const solo = members.length === 1;
    return {
      groupKey: g.groupKey,
      canonicalId: g.canonicalId,
      name: g.groupLabel,
      // Whether an operator override put this group together, as opposed to
      // the catalogue's display names doing it by accident.
      userDefined: g.userDefined,
      members,
      analysis: inherited,
      analysisSource: inherited ? (solo ? 'own' as const : 'inherited' as const) : null,
      conflicted: linkedSlugs.length > 1,
      chains: [...new Set(members.flatMap(m => m.chains))],
      enabledMembers: members.filter(m => m.enabled).length,
      /** Routes on a platform we hold a key for: how much of this entry is
       *  reachable at all, as opposed to merely switched on. */
      keyedMembers: members.filter(m => m.hasKey).length,
      reference: false,
    };
  }).filter(g => g.members.length > 0);
}

/**
 * A proxy's borrowed score, shifted by the operator's adjustment.
 *
 * Clamped at zero: a stand-in nudged below nothing is not information, and a
 * negative index would sort beneath models that genuinely scored zero. Absent
 * scores stay absent — an estimate of nothing is still nothing.
 */
function nudge(value: number | null, row: Record<string, unknown>): number | null {
  if (value == null) return null;
  if (row.link_source !== 'proxy') return value;
  const delta = Number(row.proxy_delta ?? 0);
  if (!Number.isFinite(delta) || delta === 0) return value;
  return Math.max(0, Math.round((value + delta) * 10) / 10);
}

function lookupAa(db: Db, slug: string): CompareRow['analysis'] {
  const r = db.prepare(`
    SELECT slug, name, creator, intelligence_index, coding_index, agentic_index,
           price_1m_input, price_1m_output, median_output_tokens_per_second,
           median_time_to_first_token_seconds
      FROM aa_model WHERE slug = ?
  `).get(slug) as Record<string, unknown> | undefined;
  if (!r) return null;
  return {
    slug: String(r.slug),
    name: String(r.name),
    creator: r.creator == null ? null : String(r.creator),
    intelligenceIndex: numberOrNull(r.intelligence_index),
    codingIndex: numberOrNull(r.coding_index),
    agenticIndex: numberOrNull(r.agentic_index),
    price1mInput: numberOrNull(r.price_1m_input),
    price1mOutput: numberOrNull(r.price_1m_output),
    medianOutputTokensPerSecond: numberOrNull(r.median_output_tokens_per_second),
    medianTimeToFirstTokenSeconds: numberOrNull(r.median_time_to_first_token_seconds),
  };
}

/**
 * Add or remove one model from the scope of every usable key on its platform.
 *
 * Refuses to narrow an UNSCOPED key. A null scope means "every model on this
 * platform", and removing one id from that would have to materialise the whole
 * catalogue into a list — turning a standing permission into a snapshot, and
 * silently revoking access to every model discovered afterwards. That is a
 * different decision from the one the button offers, so it is not taken here.
 */
/**
 * Shift a proxy's borrowed scores by `delta` index points.
 *
 * Only a proxy may carry one: on an auto or manual link the numbers are a
 * measurement of the model itself, and "adjusting" those would be falsifying
 * them rather than estimating.
 */
export function setProxyDelta(platform: string, modelId: string, delta: number, db: Db = getDb()): boolean {
  const row = db.prepare(
    'SELECT source FROM aa_model_link WHERE platform = ? AND model_id = ?',
  ).get(platform, modelId) as { source: string } | undefined;
  if (row?.source !== 'proxy') return false;
  const clamped = Math.max(-50, Math.min(50, Math.round(delta * 10) / 10));
  db.prepare('UPDATE aa_model_link SET proxy_delta = ? WHERE platform = ? AND model_id = ?')
    .run(clamped, platform, modelId);
  return true;
}

export function setModelKeyScope(platform: string, modelId: string, allow: boolean, db: Db = getDb()): {
  changed: number; refused: number;
} {
  const keys = db.prepare(
    "SELECT id, model_scope_json FROM api_keys WHERE platform = ? AND enabled = 1 AND status IN ('healthy', 'unknown')",
  ).all(platform) as { id: number; model_scope_json: string | null }[];

  let changed = 0;
  let refused = 0;
  const write = db.prepare('UPDATE api_keys SET model_scope_json = ? WHERE id = ?');
  for (const k of keys) {
    const scope = parseModelScope(k.model_scope_json);
    if (scope === null) {
      // Already permits it; narrowing is out of scope for this operation.
      if (!allow) refused++;
      continue;
    }
    const has = scope.has(modelId);
    if (allow === has) continue;
    // Removing the last id would store NULL, and NULL means unscoped — the key
    // would go from naming one model to permitting every model on the platform.
    // Refuse rather than invert the operator's intent.
    if (!allow && scope.size === 1) { refused++; continue; }
    if (allow) scope.add(modelId);
    else scope.delete(modelId);
    write.run(JSON.stringify([...scope]), k.id);
    changed++;
  }
  return { changed, refused };
}
