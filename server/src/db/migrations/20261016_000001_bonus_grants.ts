// Migration: bonus_grants, bonus_allowances, bonus_usage — temporary bonus
// pools, operator spending windows over them, and the debit ledger
// (ADR ARCH-20261016-xkiro-allowance-and-temporary-bonus).
//
// Consumption lives only in the ledger. There is no `used` or `reserved`
// counter on the grant or window: a counter can drift from the ledger, and an
// in-flight reservation belongs to a process that a restart has already ended.
//
// DOWN: reversible — drops only what it creates.

import type { Db } from '../types.js';

export function up(db: Db): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS bonus_grants (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      label TEXT NOT NULL DEFAULT '',
      platform TEXT NOT NULL,
      key_ids_json TEXT NOT NULL,
      metric TEXT NOT NULL CHECK (metric IN ('requests', 'total_tokens')),
      quantity REAL NOT NULL CHECK (quantity > 0),
      starts_at_ms INTEGER NOT NULL,
      expires_at_ms INTEGER NOT NULL CHECK (expires_at_ms > starts_at_ms),
      normal_limit REAL NOT NULL CHECK (normal_limit > 0),
      timezone TEXT NOT NULL DEFAULT 'UTC',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_bonus_grants_platform ON bonus_grants(platform, expires_at_ms);

    CREATE TABLE IF NOT EXISTS bonus_allowances (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      grant_id INTEGER NOT NULL REFERENCES bonus_grants(id) ON DELETE CASCADE,
      quantity REAL NOT NULL CHECK (quantity > 0),
      starts_at_ms INTEGER NOT NULL,
      expires_at_ms INTEGER NOT NULL CHECK (expires_at_ms > starts_at_ms),
      cancelled_at_ms INTEGER,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_bonus_allowances_grant ON bonus_allowances(grant_id, id);

    CREATE TABLE IF NOT EXISTS bonus_usage (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      grant_id INTEGER NOT NULL REFERENCES bonus_grants(id) ON DELETE CASCADE,
      allowance_id INTEGER REFERENCES bonus_allowances(id) ON DELETE SET NULL,
      amount REAL NOT NULL CHECK (amount > 0),
      key_id INTEGER NOT NULL,
      model_id TEXT NOT NULL,
      created_at_ms INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_bonus_usage_grant ON bonus_usage(grant_id);
    CREATE INDEX IF NOT EXISTS idx_bonus_usage_allowance ON bonus_usage(allowance_id);
  `);
}

export function down(db: Db): void {
  db.exec(`
    DROP TABLE IF EXISTS bonus_usage;
    DROP TABLE IF EXISTS bonus_allowances;
    DROP TABLE IF EXISTS bonus_grants;
  `);
}
