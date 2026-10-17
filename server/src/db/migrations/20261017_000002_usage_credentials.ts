// Migration: provider_usage_credentials — one encrypted credential per key that
// reads the provider's ACCOUNT usage where the inference key cannot (extension
// `provider-usage-apis`). UnoRouter needs a dashboard access token, AMD a
// console session, Google a service account.
//
// Deleting the key deletes its credential (foreign keys are on). The last read
// outcome lives beside it so the dashboard can say "rejected" rather than
// silently showing nothing.
//
// DOWN: reversible — drops only what it creates.

import type { Db } from '../types.js';

export function up(db: Db): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS provider_usage_credentials (
      key_id INTEGER PRIMARY KEY REFERENCES api_keys(id) ON DELETE CASCADE,
      encrypted TEXT NOT NULL,
      iv TEXT NOT NULL,
      auth_tag TEXT NOT NULL,
      set_at TEXT NOT NULL DEFAULT (datetime('now')),
      last_read_at TEXT,
      last_status TEXT CHECK (last_status IN ('ok', 'error')),
      last_message TEXT
    );
  `);
}

export function down(db: Db): void {
  db.exec('DROP TABLE IF EXISTS provider_usage_credentials;');
}
