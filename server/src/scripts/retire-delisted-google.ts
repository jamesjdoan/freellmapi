/**
 * retire-delisted-google — record the two Gemini 2.5 routes as gone upstream.
 *
 * Both were probed on 2026-09-11 and returned HTTP 404 on all 40 requests:
 *
 *   This model models/gemini-2.5-flash is no longer available to new users.
 *
 * They were already switched off, so nothing was routing to them — but nothing
 * said WHY, and a model that is merely disabled is indistinguishable from one
 * an operator turned off on purpose. `retireCatalogModelUpstream` is the path
 * the sync uses for exactly this: it keeps the catalogue row and its overrides,
 * switches off the chain entries, and writes the tombstone and catalogue event
 * that make the departure readable afterwards.
 *
 * Usage:
 *   tsx src/scripts/retire-delisted-google.ts            # dry run
 *   tsx src/scripts/retire-delisted-google.ts --apply
 */
import { initDb, getDb } from '../db/index.js';
import { retireCatalogModelUpstream } from '../services/model-state.js';

const DELISTED: { modelId: string; reason: string }[] = [
  {
    modelId: 'gemini-2.5-flash',
    reason: 'Google API error 404: This model models/gemini-2.5-flash is no longer available to new users. ' +
      'Google recommends models/gemini-3.6-flash. Confirmed 2026-09-11: 40 of 40 probe requests returned 404.',
  },
  {
    modelId: 'gemini-2.5-flash-lite',
    reason: 'Google API error 404: This model models/gemini-2.5-flash-lite is no longer available to new users. ' +
      'Confirmed 2026-09-11: 40 of 40 probe requests returned 404.',
  },
];

function main(): void {
  const dbArg = process.argv.indexOf('--db');
  initDb(dbArg !== -1 ? process.argv[dbArg + 1]! : process.env.DB_PATH ?? 'server/data/freeapi.db');
  const db = getDb();
  const apply = process.argv.includes('--apply');

  for (const { modelId, reason } of DELISTED) {
    const row = db.prepare("SELECT id FROM models WHERE platform = 'google' AND model_id = ?").get(modelId) as
      { id: number } | undefined;
    if (!row) {
      console.log(`${modelId}: not in the catalogue`);
      continue;
    }
    if (!apply) {
      console.log(`DRY RUN ${modelId}: would record the upstream retirement`);
      continue;
    }
    const retired = retireCatalogModelUpstream(db, row.id, 'google', modelId, reason);
    console.log(`${modelId}: ${retired ? 'retired' : 'already recorded'}`);
  }

  if (!apply) console.log('Re-run with --apply to write.');
}

if (process.argv[1] && /retire-delisted-google\.(ts|js)$/.test(process.argv[1])) main();
