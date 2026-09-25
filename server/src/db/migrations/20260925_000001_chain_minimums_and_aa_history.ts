// Migration: chain_minimums_and_aa_history — keep every AA snapshot, and every
// saved set of chain minimums.
// Created: 2026-09-25
//
// DOWN: drops both tables. Nothing else reads them: aa_model stays the "latest"
// view every existing surface uses, and the current minimums document lives in
// `settings`, so dropping the history loses history and nothing else.
//
// WHY
//
// aa_model is updated in place on every sync: one row per slug, one
// fetched_at. So "what did AA say about this model on 1 September" had no
// answer the moment the next sync ran, and neither did "why was it recommended
// for Workhorse then". aa_measurement is append-only, one row per slug per
// sync, so a recommendation can always be explained by the measurement it was
// computed from plus the revision of the minimums in force. Scores are stored
// raw, never rescaled against the frontier, so capability can be tracked over
// time within one index_version.
//
// chain_minimum_revision holds every saved minimums document, numbered. The
// live one is also in settings (`imperium_chain_minimums`), which is what the
// dashboard reads; this table is the audit trail and is never edited.

import type { Db } from '../types.js';

export function up(db: Db): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS aa_measurement (
      slug TEXT NOT NULL,
      index_version TEXT,
      fetched_at TEXT NOT NULL,
      intelligence_index REAL,
      coding_index REAL,
      agentic_index REAL,
      median_output_tokens_per_second REAL,
      median_time_to_first_token_seconds REAL,
      index_cost_per_task REAL,
      PRIMARY KEY (slug, fetched_at)
    );
    CREATE INDEX IF NOT EXISTS idx_aa_measurement_fetched ON aa_measurement(fetched_at);

    CREATE TABLE IF NOT EXISTS chain_minimum_revision (
      revision INTEGER PRIMARY KEY,
      saved_at TEXT NOT NULL DEFAULT (datetime('now')),
      doc_json TEXT NOT NULL
    );
  `);
  // The snapshot already cached is the first point of the history. Without it
  // the series would start at the next sync and today's values would be lost.
  db.exec(`
    INSERT OR IGNORE INTO aa_measurement (
      slug, index_version, fetched_at, intelligence_index, coding_index, agentic_index,
      median_output_tokens_per_second, median_time_to_first_token_seconds, index_cost_per_task
    )
    SELECT slug, index_version, fetched_at, intelligence_index, coding_index, agentic_index,
           median_output_tokens_per_second, median_time_to_first_token_seconds, index_cost_per_task
      FROM aa_model
  `);
}

export function down(db: Db): void {
  db.exec(`
    DROP INDEX IF EXISTS idx_aa_measurement_fetched;
    DROP TABLE IF EXISTS aa_measurement;
    DROP TABLE IF EXISTS chain_minimum_revision;
  `);
}
