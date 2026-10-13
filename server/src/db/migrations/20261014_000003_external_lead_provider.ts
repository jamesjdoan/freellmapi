// Migration: a provider for each external model lead
// Created: 2026-10-14
//
// DOWN: reversible - drops the column (SQLite 3.35+).
//
// The Premium page groups leads by provider. A lead names its provider when the
// recorder knows it (`opencode`, `anyrouter`); when it does not, the service
// derives one from the source URL at read time, so rows recorded before this
// column existed group correctly without a backfill that would freeze today's
// derivation rule into the data.

import type { Db } from '../types.js';

export function up(db: Db): void {
  const columns = db.prepare('PRAGMA table_info(external_model_leads)').all() as Array<{ name: string }>;
  if (!columns.some(c => c.name === 'provider')) {
    db.exec('ALTER TABLE external_model_leads ADD COLUMN provider TEXT');
  }
}

export function down(db: Db): void {
  db.exec('ALTER TABLE external_model_leads DROP COLUMN provider');
}
