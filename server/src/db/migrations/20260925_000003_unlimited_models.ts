// Migration: unlimited_models — a model may be marked as "unlimited" so it never
// counts toward limits and is tried first in its chains.
//
// Created: 2026-09-25
//
// DOWN: drops the column, the history table, and restores the original trigger.
//       The `unlimited` column is restored to 0/false by dropping it. The
//       model_price_check table is dropped; the old trigger is recreated.
//       `aa_model` is unchanged.
//
// WHY
//
// OpenRouter's stealth models (Space Bunny) are free with no meter. The flag
// lets one skip every local usage gate, stay out of every counter (this
// trigger is one of them), be tried first in its chains and pass the
// paid-balance guard. On a guarded platform it only takes effect while the
// provider's public listing prices the model at $0: model_price_check holds
// the last price seen - 0 = free, >0 = charging, NULL = unknown/never
// checked - and anything but 0 keeps the exemption off
// (services/unlimited-models.ts).

import type { Db } from '../types.js';

function hasColumn(db: Db, table: string, column: string): boolean {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).some(c => c.name === column);
}

export function up(db: Db): void {
  // 1) The `unlimited` flag on the model row. True = operator declared this
  // model unlimited (subject to the live price check).
  if (!hasColumn(db, 'models', 'unlimited')) {
    // Nullable, no default: NULL = not unlimited, and every reader tests
    // `unlimited = 1`. The models-table rebuild in 20260729_000001 carries
    // later columns across only as plain nullable columns, so a NOT NULL
    // DEFAULT here would not survive it (endpoint-identity round-trip test).
    db.prepare('ALTER TABLE models ADD COLUMN unlimited INTEGER').run();
  }

  // 2) Historical price checks for models we ever checked.
  // price_found_usd: USD per 1M tokens (prompt + completion); 0 = free, >0 = charging, NULL = unknown.
  db.exec(`
    CREATE TABLE IF NOT EXISTS model_price_check (
      platform TEXT NOT NULL,
      model_id TEXT NOT NULL,
      last_checked_at TEXT NOT NULL,
      price_found_usd REAL,
      PRIMARY KEY (platform, model_id)
    );
    CREATE INDEX IF NOT EXISTS idx_price_check_checked ON model_price_check(last_checked_at);
  `);

  // 3) Each request row records whether THAT call was unlimited, decided when
  // it was logged. Counters read this column instead of joining to `models`:
  // a trigger that referenced `models` broke every migration that rebuilds
  // that table, and the column is exact history - calls made while the model
  // was free stay excluded after it starts charging.
  if (!hasColumn(db, 'requests', 'unlimited')) {
    db.prepare('ALTER TABLE requests ADD COLUMN unlimited INTEGER NOT NULL DEFAULT 0').run();
  }
  db.exec(`
    DROP TRIGGER IF EXISTS requests_key_monthly_usage;
    CREATE TRIGGER IF NOT EXISTS requests_key_monthly_usage
    AFTER INSERT ON requests
    WHEN NEW.key_id IS NOT NULL
         AND NEW.status = 'success'
         AND NEW.unlimited = 0
         AND strftime('%Y-%m', NEW.created_at) IS NOT NULL
    BEGIN
      INSERT INTO key_monthly_usage (key_id, month, requests, tokens)
      VALUES (NEW.key_id, strftime('%Y-%m', NEW.created_at), 1,
              MAX(0, NEW.input_tokens) + MAX(0, NEW.output_tokens))
      ON CONFLICT(key_id, month) DO UPDATE SET
        requests = requests + 1,
        tokens = tokens + excluded.tokens;
    END;
  `);
}

export function down(db: Db): void {
  db.exec(`
    DROP TRIGGER IF EXISTS requests_key_monthly_usage;
    CREATE TRIGGER IF NOT EXISTS requests_key_monthly_usage
    AFTER INSERT ON requests
    WHEN NEW.key_id IS NOT NULL
         AND NEW.status = 'success'
         AND strftime('%Y-%m', NEW.created_at) IS NOT NULL
    BEGIN
      INSERT INTO key_monthly_usage (key_id, month, requests, tokens)
      VALUES (NEW.key_id, strftime('%Y-%m', NEW.created_at), 1,
              MAX(0, NEW.input_tokens) + MAX(0, NEW.output_tokens))
      ON CONFLICT(key_id, month) DO UPDATE SET
        requests = requests + 1,
        tokens = tokens + excluded.tokens;
    END;

    DROP TABLE IF EXISTS model_price_check;
  `);
  if (hasColumn(db, 'requests', 'unlimited')) db.prepare('ALTER TABLE requests DROP COLUMN unlimited').run();
  if (hasColumn(db, 'models', 'unlimited')) db.prepare('ALTER TABLE models DROP COLUMN unlimited').run();
}