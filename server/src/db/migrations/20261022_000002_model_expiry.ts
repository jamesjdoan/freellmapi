// Migration: model_expiry — when a model's free access ends.
//
// Created: 2026-10-22
//
// Some models are free because of a promotion with an end date: Vercel AI
// Gateway's MiniMax M3.1 Flash at $0 until 22 October 2026, for example. The
// operator wants a countdown on the row, so the end has to be a fact the
// dashboard can read rather than a line in a note.
//
// This is NOT the same as `model_note.recheck_at`, which is a date the operator
// set to say when to look again ("check this in a week"). An expiry is a
// promise made by the provider, and it carries a time, because a promotion
// usually ends at midnight rather than at the end of a day.
//
// Keyed (platform, model_id) like model_note and model_bench_result: the
// catalogue rebuilds model rows, and an expiry must outlive that.
//
// DOWN: reversible — drops the table and its dates with it.

import type { Db } from '../types.js';

export function up(db: Db): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS model_expiry (
      platform TEXT NOT NULL,
      model_id TEXT NOT NULL,
      -- ISO 8601 UTC, e.g. 2026-10-22T23:59:00.000Z.
      expires_at TEXT NOT NULL,
      -- What the date means, in the operator's words: "Vercel $0 promotion
      -- ends". Shown beside the countdown.
      label TEXT,
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (platform, model_id)
    );
  `);
}

export function down(db: Db): void {
  db.exec('DROP TABLE IF EXISTS model_expiry;');
}
