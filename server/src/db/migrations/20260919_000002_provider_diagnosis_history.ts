// Migration: provider_diagnosis_history — when a key's state CHANGED
// Created: 2026-09-19
//
// DOWN: reversible — drops only what it creates.
//
// A transition log, not a sample log. One row is written when a provider's
// verdict or dominant code changes, and `last_seen_at_ms` on that row is bumped
// while it holds. Sampling every few minutes would answer the same questions
// with thousands of rows a week, and the shadow ledger deleted this morning is
// what a table that accumulates rows nobody reads looks like.
//
// It answers what a single verdict cannot: when did OpenCode stop working,
// has this provider been rate-limited all week or only since noon, and is the
// key recovering or getting worse.

import type { Db } from '../types.js';

export function up(db: Db): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS provider_diagnosis_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      platform TEXT NOT NULL,
      -- The verdict from services/provider-diagnosis.ts at the moment it changed.
      verdict TEXT NOT NULL,
      -- The code that decided it, or NULL for healthy/untested/no_key.
      dominant_code TEXT,
      -- The provider's own words for the failure, so the reason survives even
      -- after the failing traffic ages out of the requests window.
      sample TEXT,
      ok_models INTEGER NOT NULL DEFAULT 0,
      failing_models INTEGER NOT NULL DEFAULT 0,
      -- When this state began, and when it was last confirmed to still hold.
      started_at_ms INTEGER NOT NULL,
      last_seen_at_ms INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_provider_diagnosis_platform
      ON provider_diagnosis_history(platform, started_at_ms);
  `);
}

export function down(db: Db): void {
  db.exec(`
    DROP INDEX IF EXISTS idx_provider_diagnosis_platform;
    DROP TABLE IF EXISTS provider_diagnosis_history;
  `);
}
