// Migration: model_notes — an operator note and a "recheck by" date per model.
//
// Created: 2026-09-26
//
// WHY
//
// A model parked for a reason ("410 end of life at NVIDIA", "timed out at
// 180s, works again at 28s") had nowhere to say so: the Keys panel showed it
// greyed out and the reason lived in someone's head. The note is the
// operator's own record; nothing routes on it.
//
// Keyed by (platform, model_id), not models.id: the catalogue deletes and
// re-inserts rows, and the models-table rebuild in 20260729_000001 would drop
// a column added here. A note has to outlive both.
//
// DOWN: drops the table. The notes are lost; nothing else reads them.

import type { Db } from '../types.js';

export function up(db: Db): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS model_note (
      platform TEXT NOT NULL,
      model_id TEXT NOT NULL,
      note TEXT NOT NULL,
      recheck_at TEXT,
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (platform, model_id)
    );
  `);
}

export function down(db: Db): void {
  db.exec('DROP TABLE IF EXISTS model_note;');
}
