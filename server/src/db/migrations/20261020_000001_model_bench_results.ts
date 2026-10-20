// Migration: model_bench_result — a screening benchmark run, imported by hand.
// Created: 2026-10-20
//
// The screening benchmark (server/src/scripts/model-bench.ts) never writes to
// the live database: it runs against a COPY of it and leaves a passport JSON
// file behind. That is the right default — a benchmark that could write
// straight into the catalogue would be able to overwrite a routing decision
// with a six-scenario screen.
//
// This table is the way that measurement reaches the dashboard: the operator
// imports ONE passport at a time, deliberately, and the result becomes the
// model's token efficiency (ADR ARCH-20261020).
//
// Keyed (platform, model_id) rather than by models.id, like model_note and
// model_benchmark_entry: the catalogue rebuilds model rows, and a measurement
// must outlive that. Re-importing a route replaces its row, because the newer
// run is the one the operator wanted.
//
// The raw counts are kept, not just the derived rate: "1.4K tokens per task"
// is only meaningful next to how many scenarios it covers and which bench
// version measured it.
//
// DOWN: reversible — drops only what it creates.

import type { Db } from '../types.js';

export function up(db: Db): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS model_bench_result (
      platform TEXT NOT NULL,
      model_id TEXT NOT NULL,
      -- Which bench version measured it. The scenarios change between
      -- versions, so a number from an older bench is not the same measure.
      bench_version TEXT NOT NULL,
      prompt_tokens INTEGER NOT NULL DEFAULT 0,
      -- Completion tokens ALREADY include the reasoning tokens, so
      -- prompt + completion is the total. Adding reasoning again would
      -- double-count it.
      completion_tokens INTEGER NOT NULL DEFAULT 0,
      reasoning_tokens INTEGER NOT NULL DEFAULT 0,
      calls INTEGER NOT NULL DEFAULT 0,
      -- Scenarios that actually ran to a verdict. A run where every scenario
      -- was inconclusive has no rate to show, and is refused at import.
      scenarios_completed INTEGER NOT NULL DEFAULT 0,
      reasoning_effort TEXT,
      -- When the bench run started, which is what "the most recent run" is
      -- read from when several routes of one model carry a result.
      run_at TEXT NOT NULL,
      imported_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (platform, model_id)
    );
  `);
}

export function down(db: Db): void {
  db.exec('DROP TABLE IF EXISTS model_bench_result;');
}
