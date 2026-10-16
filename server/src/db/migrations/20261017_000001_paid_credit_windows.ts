// Migration: paid_credit_models, paid_credit_windows — operator-selected paid
// models and the bounded credit windows that let automatic routing spend on
// them (extension `paid-credit-windows`).
//
// A window stores the provider-reported usage at the moment it opened
// (`baseline_used`); spend is always the reported usage now minus that, so no
// counter can drift from what the provider measured.
//
// DOWN: reversible — drops only what it creates.

import type { Db } from '../types.js';

export function up(db: Db): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS paid_credit_models (
      platform TEXT NOT NULL,
      model_id TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (platform, model_id)
    );

    CREATE TABLE IF NOT EXISTS paid_credit_windows (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      platform TEXT NOT NULL,
      key_id INTEGER NOT NULL,
      unit TEXT NOT NULL,
      quantity REAL NOT NULL CHECK (quantity > 0),
      baseline_used REAL NOT NULL,
      starts_at_ms INTEGER NOT NULL,
      expires_at_ms INTEGER NOT NULL CHECK (expires_at_ms > starts_at_ms),
      cancelled_at_ms INTEGER,
      last_attempt_at_ms INTEGER,
      confirmed_at TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_paid_credit_windows_key ON paid_credit_windows(platform, key_id, id);
  `);
}

export function down(db: Db): void {
  db.exec(`
    DROP TABLE IF EXISTS paid_credit_windows;
    DROP TABLE IF EXISTS paid_credit_models;
  `);
}
