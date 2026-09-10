// Migration: catalogue change tracking — when a model arrived, what a
// retirement cost us
// Created: 2026-09-10
//
// DOWN: reversible — drops both columns.
//
// Model departures were already recorded: `catalog_model_tombstones` carries
// the provider's own words, the date, and whether the catalogue later relisted
// the model. Arrivals were not recorded at all, and that asymmetry has a cost.
//
// Two `nex-agi/nex-n2.5:free` routes appeared in a catalogue sync, the Default
// profile had `auto_include_new_models = 1`, and they were serving traffic
// before anyone knew they existed. They were found by accident while reading
// pool membership for something else. Rowid order is the only signal today and
// it is a proxy, not a fact: a relisted model gets a fresh id, and nothing
// records WHEN a row arrived.
//
//   models.first_seen_at                    when the catalogue first carried it
//   catalog_model_tombstones.chains_json    which chains it was serving when it left
//   catalog_model_tombstones.acknowledged_at   whether the operator has dealt with it
//
// `acknowledged_at` is created here because nothing on THIS branch creates it.
// The live database already has it (and `relisted_at`/`relist_count`) from a
// sibling EOL branch, so the guard below makes this a no-op there — but a fresh
// install had no such column, and the surface that reads it would have worked
// in production and failed on a clean checkout.
//
// `chains_json` answers the question a bare retirement cannot: a model leaving
// is only interesting because of what went with it. "gemini-2.5-pro retired"
// and "gemini-2.5-pro retired, it was Vision #1 and Frontier #3" are the same
// event and completely different problems. Membership is captured AT
// retirement, not read back later — the retirement disables the chain rows, so
// afterwards a disabled row cannot be told apart from one an operator switched
// off themselves.
//
// first_seen_at is NULL for every row that predates this migration, and stays
// that way. Backfilling `datetime('now')` would date 589 models to the day the
// migration ran and read exactly like a measurement; NULL says "was here before
// we started counting", which is the truth.

import type { Db } from '../types.js';

function hasColumn(db: Db, table: string, column: string): boolean {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  return columns.some(candidate => candidate.name === column);
}

export function up(db: Db): void {
  if (!hasColumn(db, 'models', 'first_seen_at')) {
    db.prepare('ALTER TABLE models ADD COLUMN first_seen_at TEXT').run();
  }
  if (!hasColumn(db, 'catalog_model_tombstones', 'chains_json')) {
    db.prepare('ALTER TABLE catalog_model_tombstones ADD COLUMN chains_json TEXT').run();
  }
  if (!hasColumn(db, 'catalog_model_tombstones', 'acknowledged_at')) {
    db.prepare('ALTER TABLE catalog_model_tombstones ADD COLUMN acknowledged_at TEXT').run();
  }
}

export function down(db: Db): void {
  if (hasColumn(db, 'models', 'first_seen_at')) {
    db.prepare('ALTER TABLE models DROP COLUMN first_seen_at').run();
  }
  if (hasColumn(db, 'catalog_model_tombstones', 'chains_json')) {
    db.prepare('ALTER TABLE catalog_model_tombstones DROP COLUMN chains_json').run();
  }
  if (hasColumn(db, 'catalog_model_tombstones', 'acknowledged_at')) {
    db.prepare('ALTER TABLE catalog_model_tombstones DROP COLUMN acknowledged_at').run();
  }
}
