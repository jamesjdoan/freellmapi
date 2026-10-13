// Migration: external model discovery leads table
// Created: 2026-10-14
//
// DOWN: reversible - drops the table.
//
// Leads discovered OUTSIDE the signed catalog: a provider blog announcing a
// free stealth model, an agent report, a console UIs listing something the
// feed does not carry yet. The catalog feed is authoritative for what this
// router serves; this table is the shopping list beside it — what an operator
// (or an agent) found, where they found it, and whether anyone has tested it.
//
// No seeded rows. A fabricated lead is worse than an empty table.
//
import type { Db } from '../types.js';

export function up(db: Db): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS external_model_leads (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      at TEXT NOT NULL DEFAULT (datetime('now')),
      source TEXT NOT NULL,
      model_id TEXT NOT NULL,
      display_name TEXT,
      kind TEXT,
      status TEXT NOT NULL DEFAULT 'candidate',
      notes TEXT,
      added_by TEXT NOT NULL DEFAULT 'user'
    );
    CREATE INDEX IF NOT EXISTS idx_external_model_leads_at ON external_model_leads(at DESC, id DESC);
    CREATE INDEX IF NOT EXISTS idx_external_model_leads_status ON external_model_leads(status, at DESC);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_external_model_leads_unique
      ON external_model_leads(source, model_id);
  `);
}

export function down(db: Db): void {
  db.exec(`
    DROP INDEX IF EXISTS idx_external_model_leads_unique;
    DROP INDEX IF EXISTS idx_external_model_leads_status;
    DROP INDEX IF EXISTS idx_external_model_leads_at;
    DROP TABLE IF EXISTS external_model_leads;
  `);
}
