/**
 * record-google-daily-caps — the per-day half of the Google limits.
 *
 * The per-minute caps came from 429 bodies. The daily one is harder: reaching
 * it costs a model's whole allowance, so it was never bursted. It does not have
 * to be. On 2026-08-27 three separate API keys each stopped at EXACTLY 20
 * successes on the same model on the same day, and `gemini-3.8-flash` later
 * named `limit: 20` outright in a refusal. Three independent counters agreeing
 * on a round number is a measurement, not a coincidence — and it also says the
 * counter is per key per model, which is why the account totalled 60 that day.
 *
 * Recorded ONLY where this install's own traffic shows a key stopping at 20.
 * Four models qualify. The others have never been pushed that far, and a
 * plausible number written into a limit is indistinguishable from a measured
 * one once it is in the table — which is the failure this whole subsystem
 * exists to prevent.
 *
 * Usage:
 *   tsx src/scripts/record-google-daily-caps.ts            # dry run
 *   tsx src/scripts/record-google-daily-caps.ts --apply
 */
import { initDb, getDb } from '../db/index.js';
import { upsertQuotaPolicy } from '../services/quota-policy.js';
import { recordQuotaProbe } from '../services/quota-probe-log.js';

const DAILY_LIMIT = 20;

interface KeyDay { d: string; key_id: number; ok: number }

function keyDaysAtLimit(modelId: string): KeyDay[] {
  return getDb().prepare(`
    SELECT date(created_at) AS d, key_id, SUM(status = 'success') AS ok
      FROM requests
     WHERE platform = 'google' AND model_id = ?
     GROUP BY d, key_id
    HAVING ok = ?
     ORDER BY d DESC
  `).all(modelId, DAILY_LIMIT) as KeyDay[];
}

function main(): void {
  const dbArg = process.argv.indexOf('--db');
  initDb(dbArg !== -1 ? process.argv[dbArg + 1]! : process.env.DB_PATH ?? 'server/data/freeapi.db');
  const db = getDb();
  const apply = process.argv.includes('--apply');

  // Provenance repair: the backfill recorded Gemma's 1000/day as measured. It
  // was not — it came from the shipped catalogue, and Gemma has never served
  // more than one request in a day here. A claim wearing a measurement's badge
  // is worse than no record.
  const gemma = db.prepare(
    "SELECT id FROM quota_probe_run WHERE platform = 'google' AND model_id = 'gemma-4-26b-a4b-it' AND measured_rpd IS NOT NULL",
  ).get() as { id: number } | undefined;
  if (gemma) {
    if (apply) {
      db.prepare(`
        UPDATE quota_probe_run
           SET measured_rpd = NULL,
               notes = COALESCE(notes || ' ', '') || 'Correction: the 1000/day first recorded here was the catalogue''s claim, never measured. This burst only established the per-minute ceiling.'
         WHERE id = ?
      `).run(gemma.id);
    }
    console.log(`gemma-4-26b-a4b-it: ${apply ? 'cleared' : 'would clear'} an unmeasured 1000/day from the probe record`);
  }

  const models = db.prepare("SELECT model_id FROM models WHERE platform = 'google' ORDER BY model_id")
    .all() as { model_id: string }[];

  for (const { model_id: modelId } of models) {
    const evidence = keyDaysAtLimit(modelId);
    // One key-day at the limit could be a coincidence of demand. Two or more,
    // especially across different keys, is the counter.
    if (evidence.length < 2) continue;

    const keys = [...new Set(evidence.map(e => e.key_id))];
    const note = `${DAILY_LIMIT}/day observed: ${evidence.length} key-days stopped at exactly ${DAILY_LIMIT} ` +
      `across ${keys.length} key(s) (${evidence.slice(0, 3).map(e => `${e.d} key ${e.key_id}`).join(', ')}). ` +
      'Per key per model — three keys each reached 20 on the same model on 2026-08-27.';

    if (!apply) {
      console.log(`${modelId}: would record ${DAILY_LIMIT}/day — ${evidence.length} key-days`);
      continue;
    }

    upsertQuotaPolicy({
      platform: 'google', modelId, endpointScope: null, scope: 'model', metric: 'requests',
      limit: DAILY_LIMIT, periodKind: 'calendar_day', periodMs: null, timezone: 'UTC', anchorDay: null,
    });
    db.prepare(`
      UPDATE quota_policy SET notes = ?, confidence = 0.75
       WHERE platform = 'google' AND model_id = ? AND metric = 'requests' AND period_kind = 'calendar_day'
    `).run(note, modelId);

    // The test behind the limit, in the same place the bursts are. `observed`
    // is the method for a ceiling read off traffic rather than provoked.
    recordQuotaProbe({
      platform: 'google', model_id: modelId, method: 'observed', concurrency: null,
      served: DAILY_LIMIT, refused: 0, status_codes_json: '{}',
      measured_rpm: null, measured_rpd: DAILY_LIMIT,
      catalogue_rpm: null, catalogue_rpd: null,
      retry_hint_ms: null, quota_bucket: null, verbatim: null, notes: note,
    }, db);

    console.log(`${modelId}: ${DAILY_LIMIT}/day from ${evidence.length} key-days across ${keys.length} key(s)`);
  }

  if (!apply) console.log('Re-run with --apply to write.');
}

if (process.argv[1] && /record-google-daily-caps\.(ts|js)$/.test(process.argv[1])) main();
