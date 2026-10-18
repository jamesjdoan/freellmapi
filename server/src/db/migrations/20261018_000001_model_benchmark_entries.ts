// Migration: model_benchmark_entry — a score the operator typed into a cell
// Artificial Analysis left empty (ADR ARCH-20261018-manual-benchmark-scores).
//
// Every entry carries where the number came from: a related model in the same
// family, the operator's approximation, or the operator's own test. It is never
// written into aa_model, so a measurement and a judgement cannot be confused;
// when a measurement for the same metric arrives it takes over and the entry
// is kept, read as superseded.
//
// Keyed (platform, model_id) rather than by models.id, like model_note: the
// catalogue rebuilds model rows, and the operator's number must outlive that.
//
// DOWN: reversible — drops only what it creates.

import type { Db } from '../types.js';

export function up(db: Db): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS model_benchmark_entry (
      platform TEXT NOT NULL,
      model_id TEXT NOT NULL,
      metric TEXT NOT NULL CHECK (metric IN ('intelligence', 'coding', 'agentic')),
      value REAL NOT NULL CHECK (value >= 0 AND value <= 100),
      provenance TEXT NOT NULL CHECK (provenance IN ('family', 'approximated', 'tested')),
      entered_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (platform, model_id, metric)
    );
  `);
}

export function down(db: Db): void {
  db.exec('DROP TABLE IF EXISTS model_benchmark_entry;');
}
