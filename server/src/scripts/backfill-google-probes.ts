/**
 * backfill-google-probes — the 2026-09-11 Google measurement session.
 *
 * These twelve runs were made by hand before `quota_probe_run` existed, by
 * bursting each model and reading the 429 body. They are recorded here rather
 * than left in a chat log because they cost real allowance to obtain: four of
 * the models measured hold twenty requests a day, and the session spent most of
 * that on each of them.
 *
 * `catalogue_*` is what the shipped catalogue claimed AT THE TIME, which is the
 * part worth preserving — the catalogue has since been corrected to these
 * numbers, and without the original claim there is no record that it was ever
 * wrong, or by how much.
 *
 * Usage:
 *   tsx src/scripts/backfill-google-probes.ts            # dry run
 *   tsx src/scripts/backfill-google-probes.ts --apply
 */
import { initDb, getDb } from '../db/index.js';
import { recordQuotaProbe, listQuotaProbes } from '../services/quota-probe-log.js';

const QUOTA_METRIC = 'generativelanguage.googleapis.com/generate_content_free_tier_requests';

/** Google's refusal, reconstructed to the exact shape it was received in. */
function refusal(limit: number, model: string, retrySeconds: number): string {
  return 'You exceeded your current quota, please check your plan and billing details. ' +
    'For more information on this error, head to: https://ai.google.dev/gemini-api/docs/rate-limits. ' +
    'To monitor your current usage, head to: https://ai.dev/rate-limit. ' +
    `* Quota exceeded for metric: ${QUOTA_METRIC}, limit: ${limit}, model: ${model} ` +
    `Please retry in ${retrySeconds}s.`;
}

interface Session {
  model: string;
  sent: number;
  served: number;
  codes: Record<string, number>;
  rpm: number | null;
  rpd?: number | null;
  claimedRpm: number | null;
  claimedRpd: number | null;
  bucket?: string;
  retry?: number;
  notes?: string;
}

const SESSION: Session[] = [
  {
    model: 'gemini-3.7-flash', sent: 40, served: 6, codes: { '200': 6, '429': 34 },
    rpm: 5, claimedRpm: 10, claimedRpd: 20, retry: 38,
  },
  {
    model: 'gemini-3.8-flash', sent: 40, served: 2, codes: { '200': 2, '429': 38 },
    rpm: 5, rpd: 20, claimedRpm: null, claimedRpd: null, retry: 16,
    notes: 'Named both limits in one burst — 5 and 20 on the same metric. Minute and day are distinguishable only by value, which is why the daily figure is measured here and inferred everywhere else.',
  },
  {
    model: 'gemini-3.6-flash', sent: 40, served: 6, codes: { '200': 6, '429': 34 },
    rpm: 5, claimedRpm: 10, claimedRpd: 20, retry: 48,
  },
  {
    model: 'gemini-3.5-flash', sent: 40, served: 6, codes: { '200': 6, '429': 33, '503': 1 },
    rpm: 5, claimedRpm: 10, claimedRpd: 20, retry: 11,
  },
  {
    model: 'gemini-3-flash-preview', sent: 40, served: 6, codes: { '200': 6, '429': 34 },
    rpm: 5, claimedRpm: 10, claimedRpd: 20, bucket: 'gemini-3-flash', retry: 55,
    notes: 'The counter names `gemini-3-flash`, not the preview alias that was called: routing both names shares one allowance rather than adding a second.',
  },
  {
    model: 'gemini-3.1-flash-lite', sent: 40, served: 16, codes: { '200': 16, '429': 24 },
    rpm: 15, claimedRpm: 15, claimedRpd: 20, retry: 16,
  },
  {
    model: 'gemini-3.5-flash-lite', sent: 25, served: 16, codes: { '200': 16, '429': 9 },
    rpm: 15, claimedRpm: 15, claimedRpd: 20, retry: 28,
  },
  {
    model: 'gemini-robotics-er-2-preview', sent: 40, served: 40, codes: { '200': 40 },
    rpm: null, claimedRpm: 10, claimedRpd: 20,
    notes: 'Never refused: 40 of 40 served. The ceiling is above 40/min, so the catalogue claim of 10 understates it by at least fourfold. The most permissive Gemini on this key.',
  },
  {
    model: 'gemma-4-26b-a4b-it', sent: 40, served: 31, codes: { '200': 31, '429': 9 },
    rpm: 30, rpd: 1000, claimedRpm: 15, claimedRpd: 1000, bucket: 'gemma-4-26b', retry: 6,
  },
  {
    model: 'gemma-4-31b-it', sent: 40, served: 10, codes: { '200': 10, '429': 9, '500': 21 },
    rpm: 30, claimedRpm: 15, claimedRpd: 1000, bucket: 'gemma-4-31b', retry: 47,
    notes: 'Same 30/min allowance as the 26B, but 21 of 40 requests returned HTTP 500. Not a quota problem and not a route to depend on.',
  },
  {
    model: 'gemini-2.5-flash', sent: 40, served: 0, codes: { '404': 40 },
    rpm: null, claimedRpm: 10, claimedRpd: 20,
    notes: 'Delisted: "This model is no longer available to new users." Google recommends gemini-3.6-flash.',
  },
  {
    model: 'gemini-2.5-flash-lite', sent: 40, served: 0, codes: { '404': 40 },
    rpm: null, claimedRpm: 15, claimedRpd: 20,
    notes: 'Delisted, same as gemini-2.5-flash.',
  },
];

function main(): void {
  initDb(process.argv[process.argv.indexOf('--db') + 1] || process.env.DB_PATH || 'server/data/freeapi.db');
  const db = getDb();
  const apply = process.argv.includes('--apply');

  // Re-running must not duplicate the session: it is a fixed historical record,
  // not an append-only feed.
  const already = listQuotaProbes({ platform: 'google', limit: 500 }, db).length;
  if (already > 0) {
    console.log(`${already} google probe rows already recorded — nothing to backfill.`);
    return;
  }

  for (const s of SESSION) {
    const verbatim = s.rpm != null
      ? refusal(s.rpm, s.bucket ?? s.model, s.retry ?? 30)
      : s.codes['404']
        ? `This model models/${s.model} is no longer available to new users. Please update your code to use models/gemini-3.6-flash for the latest features and improvements.`
        : null;

    if (!apply) {
      console.log(`${s.model.padEnd(30)} ${s.served}/${s.sent} served -> ${s.rpm ?? 'no limit reached'}${s.rpd ? `/min, ${s.rpd}/day` : s.rpm ? '/min' : ''}`);
      continue;
    }

    recordQuotaProbe({
      platform: 'google',
      model_id: s.model,
      method: 'burst',
      concurrency: s.sent,
      served: s.served,
      refused: s.sent - s.served,
      status_codes_json: JSON.stringify(s.codes),
      measured_rpm: s.rpm,
      measured_rpd: s.rpd ?? null,
      catalogue_rpm: s.claimedRpm,
      catalogue_rpd: s.claimedRpd,
      retry_hint_ms: s.retry != null ? s.retry * 1000 : null,
      quota_bucket: s.bucket ?? (s.rpm != null ? s.model : null),
      verbatim,
      notes: s.notes ?? null,
    }, db);
  }

  console.log(apply ? `Recorded ${SESSION.length} probe runs.` : `DRY RUN — ${SESSION.length} runs. Re-run with --apply.`);
}

if (process.argv[1] && /backfill-google-probes\.(ts|js)$/.test(process.argv[1])) main();
