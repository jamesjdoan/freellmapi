// Migration: who set each lead's status, and models the operator ignores
// Created: 2026-10-14
//
// DOWN: reversible - drops the table and the column (SQLite 3.35+).
//
// Two gaps a scheduled agent would otherwise open:
//
//   - status_set_by: an agent re-posting a lead it recorded used to overwrite
//     the status, so the operator's "rejected" reverted to "candidate" on the
//     next run. Once the operator sets a status, it is theirs; the agent can
//     add notes but not change it. Existing rows take their recorder as the
//     setter, which is what happened.
//
//   - external_model_ignores: deleting a lead does not stop the next run from
//     adding it again, and the same model found at another URL is another lead.
//     An ignore is keyed on (provider, model_id), not on the source, so it
//     holds wherever the model turns up. Like a catalog tombstone, it means
//     "keep this out", and it is reversible.

import type { Db } from '../types.js';

export function up(db: Db): void {
  const columns = db.prepare('PRAGMA table_info(external_model_leads)').all() as Array<{ name: string }>;
  if (!columns.some(c => c.name === 'status_set_by')) {
    db.exec("ALTER TABLE external_model_leads ADD COLUMN status_set_by TEXT NOT NULL DEFAULT 'user'");
    db.exec('UPDATE external_model_leads SET status_set_by = added_by');
  }
  db.exec(`
    CREATE TABLE IF NOT EXISTS external_model_ignores (
      -- Lower-cased provider; '' when the lead had none and none could be
      -- derived from its source.
      provider TEXT NOT NULL,
      model_id TEXT NOT NULL,
      at TEXT NOT NULL DEFAULT (datetime('now')),
      reason TEXT,
      PRIMARY KEY (provider, model_id)
    );
  `);
}

export function down(db: Db): void {
  db.exec('DROP TABLE IF EXISTS external_model_ignores');
  db.exec('ALTER TABLE external_model_leads DROP COLUMN status_set_by');
}
