// Migration: quota probe run table
// Created: 2026-09-11
//
// Table to store quota probe results, used for measuring real rate limits.
//
// DOWN: reversible - drops the table.

import type { Db } from '../types.js';

export function up(db: Db): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS quota_probe_run (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      platform TEXT NOT NULL,
      model_id TEXT NOT NULL,
      ran_at TEXT NOT NULL DEFAULT (datetime('now')),
      method TEXT NOT NULL CHECK (method IN ('burst', 'observed')),
      concurrency INTEGER, -- NULL for 'observed'
      served INTEGER NOT NULL,
      refused INTEGER NOT NULL,
      status_codes_json TEXT NOT NULL DEFAULT '{}',
      measured_rpm INTEGER,
      measured_rpd INTEGER,
      catalogue_rpm INTEGER,
      catalogue_rpd INTEGER,
      retry_hint_ms INTEGER,
      quota_bucket TEXT,
      verbatim TEXT, -- NULL when the probe never tripped a limit
      notes TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_quota_probe_run_platform_model_id_ran_at ON quota_probe_run(platform, model_id, ran_at DESC);
  `);
}

export function down(db: Db): void {
  db.exec(`
    DROP INDEX IF EXISTS idx_quota_probe_run_platform_model_id_ran_at;
    DROP TABLE IF EXISTS quota_probe_run;
  `);
}