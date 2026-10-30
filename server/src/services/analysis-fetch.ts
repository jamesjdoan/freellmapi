import { setTimeout as delay } from 'node:timers/promises';
import { formatIndexVersion } from './aa-scoring.js';

// Fetching and validating one complete Artificial Analysis catalogue.
//
// Nothing is written here. The caller publishes the snapshot only after every
// page has arrived and passed validation, so a failure on page 3 leaves the
// last good snapshot in place (services/analysis.ts, syncAnalysis).
//
// Contract: https://artificialanalysis.ai/api/v2/openapi (fetched 2026-10-30).
//   - /language/models/free accepts a key of any tier and returns the Free shape.
//     /language/models is Pro+ and returns 403 to a Free key. That was confirmed
//     on our key on 2026-10-30, and the extra Pro fields are per-benchmark
//     scores this app does not store. Pro would not restore Coding or Agentic
//     either: AA documents both as always null on every tier.
//   - Pages are 1-indexed. `pagination` holds page, page_size, total_pages
//     and has_more.
//   - The quota is a fixed 24-hour window: Free 100, Pro 500, shared by every
//     key of the user or organisation. A 429 carries Retry-After in seconds, and
//     X-RateLimit-Reset holds the reset as a Unix timestamp.
//   - Null means "not measured" and never zero.
//   - The legacy /api/v2/data/llms/models endpoint returns 410 after
//     2026-11-04 23:59:59 UTC. This module never calls it.

export const AA_BASE = 'https://artificialanalysis.ai/api/v2';
export const AA_FREE_PATH = '/language/models/free';

/** Their catalogue was 718 models in 4 pages of 200 on 2026-10-30. A has_more
 *  that never ends must not spend the whole daily quota. */
export const MAX_PAGES = 20;
/** Attempts per page, the first included. */
export const MAX_ATTEMPTS = 3;
/** Retry-After is honoured in-process only up to this long. A longer one
 *  means the daily window is spent, and waiting in a request handler for
 *  hours helps nobody. */
export const MAX_RETRY_AFTER_SECONDS = 60;

export const CAPABILITY_FIELDS = {
  finance: 'artificial_analysis_finance_and_accounting_index',
  strategyOps: 'artificial_analysis_strategy_and_ops_index',
  legal: 'artificial_analysis_legal_index',
  healthcare: 'artificial_analysis_healthcare_and_medical_index',
  engineering: 'artificial_analysis_engineering_index',
  economics: 'artificial_analysis_economics_index',
} as const;
export type CapabilityMetric = keyof typeof CAPABILITY_FIELDS;
export const CAPABILITY_METRICS = Object.keys(CAPABILITY_FIELDS) as CapabilityMetric[];

export interface AaRow {
  slug: string;
  id: string | null;
  name: string;
  creator: string | null;
  releaseDate: string | null;
  intelligence: number | null;
  coding: number | null;
  agentic: number | null;
  capabilities: Record<CapabilityMetric, number | null>;
  priceIn: number | null;
  priceOut: number | null;
  indexCostPerTask: number | null;
  tps: number | null;
  ttft: number | null;
  /** Time to first ANSWER token. The legacy API called it
   *  `median_time_to_first_answer_token`; v2 nests it under `performance` as
   *  `median_time_to_first_answer_token_seconds`. */
  ttfa: number | null;
}

export interface AaSnapshot {
  /** The account's tier, from X-AA-Tier and the body. */
  tier: string | null;
  /** The shape of the response. A Pro key on /free still gets 'free'. */
  responseShape: 'free';
  /** Prompt basis of the performance medians. /free does not state one. */
  promptType: string | null;
  indexVersion: string;
  totalPages: number;
  rows: AaRow[];
  /** The same model seen on two pages, e.g. when the list shifted between
   *  requests. It is kept once. */
  duplicates: number;
}

export type AaFailureKind =
  | 'auth' | 'tier' | 'rate' | 'gone' | 'bad-request' | 'http'
  | 'server' | 'network' | 'malformed' | 'incomplete';

export class AaFetchError extends Error {
  constructor(
    readonly kind: AaFailureKind,
    message: string,
    readonly status: number | null = null,
    /** When a retry may succeed (ms since epoch), if AA said. */
    readonly retryAtMs: number | null = null,
  ) {
    super(message);
    this.name = 'AaFetchError';
  }
}

export interface FetchOptions {
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  /** Every response, error or not, so rate-limit and tier headers are
   *  recorded even when the sync fails. */
  onResponse?: (res: Response) => void;
}

/** Fetch every page and return the complete, validated catalogue, or throw. */
export async function fetchAaCatalogue(key: string, opts: FetchOptions = {}): Promise<AaSnapshot> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const sleep = opts.sleep ?? ((ms: number) => delay(ms));
  const now = opts.now ?? Date.now;

  const rows: AaRow[] = [];
  const seen = new Map<string, string | null>();
  let duplicates = 0;
  let tier: string | null = null;
  let version: string | null = null;
  let totalPages: number | null = null;

  for (let page = 1; page <= MAX_PAGES; page++) {
    const body = await fetchPage(`${AA_BASE}${AA_FREE_PATH}?page=${page}`, key, {
      fetchImpl, sleep, now,
      onResponse: res => {
        tier = res.headers.get('x-aa-tier') ?? tier;
        opts.onResponse?.(res);
      },
    });
    if (!isObject(body)) throw malformed(page, 'the body is not a JSON object');
    if (!Array.isArray(body.data)) throw malformed(page, '`data` is not an array');

    const pag = body.pagination;
    if (!isObject(pag) || !Number.isInteger(pag.page) || !Number.isInteger(pag.total_pages)) {
      throw malformed(page, '`pagination` is missing page or total_pages');
    }
    if (pag.page !== page) throw malformed(page, `asked for page ${page}, got page ${String(pag.page)}`);
    if (totalPages == null) totalPages = pag.total_pages as number;
    else if (pag.total_pages !== totalPages) {
      throw new AaFetchError('incomplete', `The catalogue changed during the refresh (page count ${totalPages} became ${String(pag.total_pages)}). Nothing was saved; try again.`);
    }

    if (typeof body.intelligence_index_version !== 'number' || !Number.isFinite(body.intelligence_index_version)) {
      throw malformed(page, '`intelligence_index_version` is missing');
    }
    const pageVersion = formatIndexVersion(body.intelligence_index_version);
    if (version == null) version = pageVersion;
    else if (pageVersion !== version) {
      throw new AaFetchError('incomplete', `The Intelligence Index version changed during the refresh (${version} on page 1, ${pageVersion} on page ${page}). Nothing was saved; try again.`);
    }
    if (typeof body.tier === 'string') tier = body.tier;

    body.data.forEach((raw, i) => {
      const row = parseRow(raw, `page ${page} item ${i + 1}`);
      if (seen.has(row.slug)) {
        const firstId = seen.get(row.slug);
        if (firstId != null && row.id != null && firstId !== row.id) {
          throw malformed(page, `two different models share the slug "${row.slug}"`);
        }
        duplicates++;
        return;
      }
      seen.set(row.slug, row.id);
      rows.push(row);
    });

    const hasMore = typeof pag.has_more === 'boolean' ? pag.has_more : page < (pag.total_pages as number);
    if (!hasMore) {
      if (page !== totalPages) {
        throw malformed(page, `has_more is false on page ${page} of ${totalPages}`);
      }
      if (rows.length === 0) throw malformed(page, 'the catalogue is empty');
      return {
        tier, responseShape: 'free', promptType: null,
        indexVersion: version, totalPages, rows, duplicates,
      };
    }
  }
  throw new AaFetchError('incomplete', `Stopped after ${MAX_PAGES} pages with more still reported. Nothing was saved.`);
}

async function fetchPage(
  url: string,
  key: string,
  opts: Required<Pick<FetchOptions, 'fetchImpl' | 'sleep' | 'now' | 'onResponse'>>,
): Promise<unknown> {
  for (let attempt = 1; ; attempt++) {
    const last = attempt >= MAX_ATTEMPTS;
    let res: Response;
    try {
      res = await opts.fetchImpl(url, { headers: { 'x-api-key': key }, signal: AbortSignal.timeout(30_000) });
    } catch (error) {
      if (!last) { await opts.sleep(backoffMs(attempt)); continue; }
      throw new AaFetchError('network', `Could not reach Artificial Analysis: ${error instanceof Error ? error.message : String(error)}`);
    }
    opts.onResponse(res);

    if (res.ok) {
      try {
        return await res.json();
      } catch {
        throw new AaFetchError('malformed', `Artificial Analysis returned a body that is not JSON (${url.slice(url.indexOf('?'))}).`, res.status);
      }
    }

    if (res.status === 429) {
      const retryAfter = parseSeconds(res.headers.get('retry-after'));
      const reset = parseSeconds(res.headers.get('x-ratelimit-reset'));
      if (retryAfter != null && retryAfter <= MAX_RETRY_AFTER_SECONDS && !last) {
        await opts.sleep(retryAfter * 1000);
        continue;
      }
      const retryAtMs = retryAfter != null ? opts.now() + retryAfter * 1000 : reset != null ? reset * 1000 : null;
      throw new AaFetchError(
        'rate',
        `Rate limit exhausted (429).${retryAtMs ? ` The quota resets at ${new Date(retryAtMs).toISOString()}.` : ''} The fixed 24-hour window is shared by every key on the account.`,
        429, retryAtMs,
      );
    }
    if (res.status >= 500) {
      if (!last) { await opts.sleep(backoffMs(attempt)); continue; }
      throw new AaFetchError('server', `Artificial Analysis returned ${res.status} after ${MAX_ATTEMPTS} attempts.`, res.status);
    }

    const text = await res.text().catch(() => '');
    throw describeFailure(res.status, text);
  }
}

function describeFailure(status: number, body: string): AaFetchError {
  switch (status) {
    case 401: return new AaFetchError('auth', 'Artificial Analysis rejected the key (401). Check it in API key management.', status);
    case 403: return new AaFetchError('tier', 'The key is valid but its tier does not cover this endpoint (403).', status);
    case 410: return new AaFetchError('gone', 'Artificial Analysis has retired this endpoint (410 Gone). See https://artificialanalysis.ai/data-api/migrate-v2-data.', status);
    case 400: return new AaFetchError('bad-request', `Artificial Analysis refused the request (400)${body ? `: ${body.slice(0, 200)}` : ''}`, status);
    default: return new AaFetchError('http', `Artificial Analysis returned ${status}${body ? `: ${body.slice(0, 200)}` : ''}`, status);
  }
}

/** 1s, then 2s. */
function backoffMs(attempt: number): number {
  return 1000 * 2 ** (attempt - 1);
}

function parseSeconds(value: string | null): number | null {
  if (value == null || value.trim() === '') return null;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function malformed(page: number, what: string): AaFetchError {
  return new AaFetchError('malformed', `Artificial Analysis sent a malformed page ${page}: ${what}. Nothing was saved.`);
}

/** An absent or null number is "not measured". Anything else that is not a finite
 *  number is a broken response, not a zero. */
function num(v: unknown, where: string): number | null {
  if (v === undefined || v === null) return null;
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  throw new AaFetchError('malformed', `Artificial Analysis sent a malformed ${where}: expected a number or null, got ${JSON.stringify(v)?.slice(0, 40)}. Nothing was saved.`);
}

/** An absent or null group reads as all-unmeasured. A group of the wrong type
 *  is broken. */
function group(v: unknown, where: string): Record<string, unknown> {
  if (v === undefined || v === null) return {};
  if (isObject(v)) return v;
  throw new AaFetchError('malformed', `Artificial Analysis sent a malformed ${where}: expected an object. Nothing was saved.`);
}

function parseRow(raw: unknown, where: string): AaRow {
  if (!isObject(raw) || typeof raw.slug !== 'string' || raw.slug.trim() === '') {
    throw new AaFetchError('malformed', `Artificial Analysis sent a model without a slug (${where}). Nothing was saved.`);
  }
  const evaluations = group(raw.evaluations, `${where} evaluations`);
  const pricing = group(raw.pricing, `${where} pricing`);
  const performance = group(raw.performance, `${where} performance`);
  const cost = group(raw.artificial_analysis_intelligence_index_cost, `${where} index cost`);
  const perTask = group(cost.cost_per_task, `${where} index cost per task`);
  const creator = group(raw.model_creator, `${where} model_creator`);
  return {
    slug: raw.slug,
    id: typeof raw.id === 'string' ? raw.id : null,
    name: typeof raw.name === 'string' && raw.name ? raw.name : raw.slug,
    creator: typeof creator.name === 'string' ? creator.name : null,
    releaseDate: typeof raw.release_date === 'string' ? raw.release_date : null,
    intelligence: num(evaluations.artificial_analysis_intelligence_index, `${where} intelligence index`),
    coding: num(evaluations.artificial_analysis_coding_index, `${where} coding index`),
    agentic: num(evaluations.artificial_analysis_agentic_index, `${where} agentic index`),
    capabilities: Object.fromEntries(CAPABILITY_METRICS.map(m =>
      [m, num(evaluations[CAPABILITY_FIELDS[m]], `${where} ${CAPABILITY_FIELDS[m]}`)])) as Record<CapabilityMetric, number | null>,
    priceIn: num(pricing.price_1m_input_tokens, `${where} input price`),
    priceOut: num(pricing.price_1m_output_tokens, `${where} output price`),
    indexCostPerTask: num(perTask.total_cost, `${where} cost per task`),
    tps: num(performance.median_output_tokens_per_second, `${where} output speed`),
    ttft: num(performance.median_time_to_first_token_seconds, `${where} time to first token`),
    ttfa: num(performance.median_time_to_first_answer_token_seconds, `${where} time to first answer token`),
  };
}
