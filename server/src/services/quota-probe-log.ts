import { getDb } from '../db/index.js';
import type { Db } from '../db/types.js';
import { resolveEffectiveQuotas } from './quota-policy.js';
import { MINUTE_MS, DAY_MS } from './quota-clock.js';

export interface QuotaProbeRun {
  id: number;
  platform: string;
  model_id: string;
  ran_at: string;
  method: 'burst' | 'observed';
  concurrency: number | null;
  served: number;
  refused: number;
  status_codes_json: string; // JSON string
  measured_rpm: number | null;
  measured_rpd: number | null;
  catalogue_rpm: number | null;
  catalogue_rpd: number | null;
  retry_hint_ms: number | null;
  quota_bucket: string | null;
  verbatim: string | null;
  notes: string | null;
}

export interface QuotaProbe {
  id: number;
  platform: string;
  modelId: string;
  ranAt: string;
  method: 'burst' | 'observed';
  concurrency: number | null;
  served: number;
  refused: number;
  statusCodes: Record<string, number>;
  measuredRpm: number | null;
  measuredRpd: number | null;
  /** What the catalogue claimed when the probe ran — history, not current. */
  catalogueRpm: number | null;
  catalogueRpd: number | null;
  /** The limit the router would ENFORCE now, resolved through the usual
   *  precedence (provider header > operator > documentation > catalogue). The
   *  recommendation is derived from these, so recording the measurement
   *  anywhere the resolver respects clears the finding instead of leaving a
   *  sentence telling the reader to do something already done. */
  currentRpm: number | null;
  currentRpd: number | null;
  /** Whether any chain would still hand a request to this route. A delisted
   *  model already switched off needs no instruction, only its record. */
  routed: boolean;
  retryHintMs: number | null;
  quotaBucket: string | null;
  verbatim: string | null;
  notes: string | null;
  finding: string;
  recommendation: string | null;
}

export function recordQuotaProbe(
  input: Omit<QuotaProbeRun, 'id' | 'ran_at'>,
  db: Db = getDb(),
): number {
  const stmt = db.prepare(`
    INSERT INTO quota_probe_run (
      platform, model_id, method, concurrency, served, refused,
      status_codes_json, measured_rpm, measured_rpd,
      catalogue_rpm, catalogue_rpd, retry_hint_ms,
      quota_bucket, verbatim, notes
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const info = stmt.run(
    input.platform,
    input.model_id,
    input.method,
    input.concurrency,
    input.served,
    input.refused,
    input.status_codes_json,
    input.measured_rpm,
    input.measured_rpd,
    input.catalogue_rpm,
    input.catalogue_rpd,
    input.retry_hint_ms,
    input.quota_bucket,
    input.verbatim,
    input.notes
  );

  return info.lastInsertRowid as number;
}

export function listQuotaProbes(
  opts: { platform?: string; limit?: number } = {},
  db: Db = getDb(),
): QuotaProbe[] {
  const limit = opts.limit ?? 500;
  // `ran_at` has one-second resolution, so two probes in the same second tie
  // and "newest first" degrades to whatever order SQLite returns. The id
  // breaks it: callers read [0] as the current answer for a model.
  const order = 'ORDER BY ran_at DESC, id DESC LIMIT ?';
  const rows = (opts.platform
    ? db.prepare(`SELECT * FROM quota_probe_run WHERE platform = ? ${order}`).all(opts.platform, limit)
    : db.prepare(`SELECT * FROM quota_probe_run ${order}`).all(limit)) as QuotaProbeRun[];

  // One resolve per model, not per row: a model with six runs has one current
  // limit, and the resolver reads policies and the catalogue on each call.
  const current = new Map<string, { rpm: number | null; rpd: number | null; routed: boolean }>();
  return rows.map(row => {
    const key = `${row.platform}/${row.model_id}`;
    let state = current.get(key);
    if (!state) {
      state = { ...effectiveRequestLimits(row.platform, row.model_id), routed: isRouted(row.platform, row.model_id, db) };
      current.set(key, state);
    }
    return mapToQuotaProbe({ ...row, current_rpm: state.rpm, current_rpd: state.rpd, routed: state.routed });
  });
}

/** Enabled in the catalogue AND holding a live position in some chain. Either
 *  switch being off means no request reaches it. */
function isRouted(platform: string, modelId: string, db: Db): boolean {
  const row = db.prepare(`
    SELECT COUNT(*) AS n
      FROM models m
      JOIN profile_models pm ON pm.model_db_id = m.id AND pm.enabled = 1
     WHERE m.platform = ? AND m.model_id = ? AND m.enabled = 1
  `).get(platform, modelId) as { n: number } | undefined;
  return (row?.n ?? 0) > 0;
}

/**
 * The per-minute and per-day request limits as the router would apply them.
 *
 * Deliberately NOT `models.rpm_limit`: that column belongs to catalogue sync
 * and is rewritten from the shipped catalogue on the next one, so a measured
 * correction written there disappears and the panel reports the same finding
 * as outstanding forever. An operator policy survives, and the resolver is the
 * one place that knows which source wins.
 */
function effectiveRequestLimits(platform: string, modelId: string): { rpm: number | null; rpd: number | null } {
  // Model scope only. An account-wide or shared-pool allowance also governs
  // this model, but it is not this model's limit: comparing a measured
  // per-model ceiling against the account's daily budget reports a mismatch
  // that no catalogue edit could ever resolve.
  const quotas = resolveEffectiveQuotas(platform, modelId)
    .filter(q => q.metric === 'requests' && q.scope === 'model');
  // A daily allowance arrives either as a rolling 24h window or as a calendar
  // day, depending on which source declared it; both mean "per day" here.
  const tightest = (matches: (q: (typeof quotas)[number]) => boolean): number | null => {
    const hit = quotas.filter(matches);
    return hit.length > 0 ? Math.min(...hit.map(q => q.limit)) : null;
  };
  return {
    rpm: tightest(q => q.period.kind === 'rolling' && q.period.windowMs === MINUTE_MS),
    rpd: tightest(q =>
      q.period.kind === 'calendar_day' || (q.period.kind === 'rolling' && q.period.windowMs === DAY_MS)),
  };
}

type CurrentLimits = QuotaProbeRun & {
  current_rpm: number | null;
  current_rpd: number | null;
  routed: boolean;
};

/** One malformed row must not take the whole log down: the status breakdown is
 *  detail, and the measurement beside it is the part worth reading. */
function parseStatusCodes(json: string): Record<string, number> {
  try {
    const parsed = JSON.parse(json) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    return parsed as Record<string, number>;
  } catch {
    return {};
  }
}

function mapToQuotaProbe(row: CurrentLimits): QuotaProbe {
  const statusCodes = parseStatusCodes(row.status_codes_json);
  const { finding, recommendation } = deriveFindingAndRecommendation(row);
  return {
    id: row.id,
    platform: row.platform,
    modelId: row.model_id,
    ranAt: row.ran_at,
    method: row.method,
    concurrency: row.concurrency,
    served: row.served,
    refused: row.refused,
    statusCodes,
    measuredRpm: row.measured_rpm,
    measuredRpd: row.measured_rpd,
    catalogueRpm: row.catalogue_rpm,
    catalogueRpd: row.catalogue_rpd,
    currentRpm: row.current_rpm ?? null,
    currentRpd: row.current_rpd ?? null,
    routed: row.routed ?? false,
    retryHintMs: row.retry_hint_ms,
    quotaBucket: row.quota_bucket,
    verbatim: row.verbatim,
    notes: row.notes,
    finding,
    recommendation,
  };
}

export function deriveFindingAndRecommendation(row: QuotaProbeRun & Partial<Pick<CurrentLimits, 'current_rpm' | 'current_rpd' | 'routed'>>): {
  finding: string;
  recommendation: string | null;
} {
  const total = row.served + row.refused;
  const codes = Object.keys(parseStatusCodes(row.status_codes_json));

  // Delisted, not merely busy. Serving nothing is ambiguous on its own: a model
  // at its daily ceiling refuses everything too, and recommending removal for
  // that would delete a route that works again after the reset. Only the
  // provider saying the model is gone means gone.
  const gone = codes.length > 0 && codes.every(c => c === '404' || c === '410');
  if (gone) {
    const finding = `${total} requests, all refused with ${codes.join('/')} — the provider no longer serves this model.`;
    // Already switched off: the probe is then the RECORD of why it went, not a
    // job to do. A panel repeating an instruction nobody can act on teaches the
    // reader to stop reading it.
    return row.routed === false
      ? { finding, recommendation: null }
      : { finding, recommendation: 'Delisted upstream: remove from routing. Correcting a limit cannot help a route that no longer exists.' };
  }

  const measured = [
    row.measured_rpm == null ? null : `${row.measured_rpm}/min`,
    row.measured_rpd == null ? null : `${row.measured_rpd}/day`,
  ].filter(Boolean).join(' and ');

  // A burst states what it sent, because the split is the evidence. An
  // observation has no such split — the counts would read as "nothing was
  // refused", when a refusal is precisely how the ceiling showed itself.
  let finding: string;
  if (row.method === 'observed') {
    finding = measured
      ? `${measured} observed in live traffic, where usage stopped.`
      : `No ceiling observed in live traffic.`;
  } else {
    const sent = `${row.concurrency} concurrent (${row.served} served, ${row.refused} refused)`;
    finding = measured
      ? `${measured} measured from ${sent}.`
      : `No limit reached from ${sent} — the ceiling is above what was sent.`;
  }

  // Both directions are worth saying, because they fail differently: an
  // overstated catalogue makes the router pace too fast and earn refusals it
  // could have avoided, an understated one leaves capacity unspent.
  const parts: string[] = [];
  for (const [unit, m, c] of [
    ['min', row.measured_rpm, row.current_rpm ?? row.catalogue_rpm],
    ['day', row.measured_rpd, row.current_rpd ?? row.catalogue_rpd],
  ] as const) {
    if (m == null || c == null || m === c) continue;
    parts.push(m < c
      ? `catalogue claims ${c}/${unit} but ${m}/${unit} was measured, so the router paces too fast and earns refusals it need not`
      : `catalogue claims ${c}/${unit} but ${m}/${unit} was measured, so usable capacity is going unspent`);
  }
  const recommendation = parts.length > 0
    ? `Correct the catalogue: ${parts.join('; ')}.`
    : null;

  return { finding, recommendation };
}
