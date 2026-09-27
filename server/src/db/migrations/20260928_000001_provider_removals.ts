// Migration: provider_removals — a configured provider taken out of the
// dashboard, with the operator's reason.
//
// Created: 2026-09-28
//
// WHY
//
// A provider you have deliberately given up on (paid, throttled, replaced)
// still occupied a row on the Keys page and still had its models in the
// catalogue, so every sync reported its churn and its new models arrived as
// if they were usable. Removing it needs to say WHY, once, in a place that
// survives the removal, and a refresh must not quietly re-add it.
//
// The models go with it, through the same `DELETE /api/models/:id` path an
// operator already uses per model, so every model is tombstoned (catalog sync
// and the custom sync then leave it alone) and its chain memberships are
// dropped. `removed_by` records whether the provider went by the whole
// provider route or by deleting its keys one at a time.
//
// DOWN: drops the table. A removed provider would then be re-listed on the
// next sync, and the reason lost.
//
// This is an OPERATOR's list, not ours: `model_provider_preferences` holds
// removed providers (opencode, huggingface) and each one keeps its own
// preference group. This table is a plain record — a row here does not by
// itself hide anything; the deletion does.

import type { Db } from '../types.js';

export function up(db: Db): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS provider_removal (
      platform TEXT PRIMARY KEY,
      reason TEXT,
      note TEXT,
      removed_at TEXT NOT NULL DEFAULT (datetime('now')),
      removed_by TEXT NOT NULL,
      models_removed INTEGER NOT NULL DEFAULT 0,
      key_ids_json TEXT NOT NULL DEFAULT '[]',
      restored_at TEXT,
      restored_by TEXT
    );
  `);
}

export function down(db: Db): void {
  db.exec('DROP TABLE IF EXISTS provider_removal;');
}
