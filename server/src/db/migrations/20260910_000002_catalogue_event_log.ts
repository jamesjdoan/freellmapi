// Migration: append-only log of models entering and leaving the catalogue
// Created: 2026-09-10
//
// DOWN: reversible - drops the table.
//
// The two existing surfaces both report CURRENT state and cannot answer "what
// has this provider done over time":
//   - `models.first_seen_at` is an arrival date that lives on the model row, so
//     it dies with the row. A model that arrived and then left leaves nothing.
//   - `catalog_model_tombstones` is keyed by (kind, platform, model_id): ONE row
//     per model, whose `created_at` is overwritten on every re-retirement. A
//     model that has come and gone three times reads as one departure.
//
// Worse, one departure path records nothing at all. Catalog sync prunes models
// the upstream catalogue no longer lists with a bare `DELETE FROM models`
// (catalog-sync.ts, the prune pass) - no tombstone, no trace. A provider
// dropping a model simply makes it disappear.
//
// So this is an event log, not a state table: one row per thing that happened,
// never updated, never keyed by model. Growth is a few rows per sync.
//
// Existing tombstones are backfilled as `retired` events using their own
// `created_at`, which is real evidence we already hold. Arrivals are NOT
// backfilled: `first_seen_at` is null for every row that predates it, and a
// fabricated date in a log is worse than a short log.

import type { Db } from '../types.js';

export function up(db: Db): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS catalogue_event (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      at TEXT NOT NULL DEFAULT (datetime('now')),
      -- arrived | retired | relisted | removed
      --   retired  = provider reports it gone, row stays, disabled
      --   removed  = row deleted (sync prune, or the operator deleting it)
      --   relisted = a retirement lifted, the model is serving again
      kind TEXT NOT NULL,
      platform TEXT NOT NULL,
      model_id TEXT NOT NULL,
      -- Copied, not joined: the model row may be gone by the time anyone reads
      -- this, and "gemini-2.5-pro" alone is not a name a person recognises.
      display_name TEXT,
      -- catalog | user | upstream_eol: who caused it, which is the difference
      -- between "the provider withdrew this" and "I deleted it".
      source TEXT,
      -- The provider's own words for a retirement, verbatim.
      reason TEXT,
      -- What it was serving when it left, captured at that moment.
      chains_json TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_catalogue_event_at ON catalogue_event(at DESC, id DESC);
    CREATE INDEX IF NOT EXISTS idx_catalogue_event_platform ON catalogue_event(platform, at DESC);
  `);

  // Backfill from the tombstones, which hold a real date and the provider's
  // real wording. `relist_count` is deliberately not expanded into separate
  // events: the table records only the LATEST retirement per model, so the
  // earlier ones have no dates to give them.
  const backfilled = db.prepare(`
    INSERT INTO catalogue_event (at, kind, platform, model_id, display_name, source, reason, chains_json)
    SELECT t.created_at, 'retired', t.platform, t.model_id, m.display_name, t.source, t.reason, t.chains_json
      FROM catalog_model_tombstones t
      LEFT JOIN models m ON m.platform = t.platform AND m.model_id = t.model_id
     WHERE t.kind = 'chat'
       AND NOT EXISTS (
         SELECT 1 FROM catalogue_event e
          WHERE e.kind = 'retired' AND e.platform = t.platform
            AND e.model_id = t.model_id AND e.at = t.created_at
       )
  `).run();
  if (backfilled.changes > 0) {
    console.log(`[catalogue-log] backfilled ${backfilled.changes} retirement(s) from tombstones`);
  }
}

export function down(db: Db): void {
  db.exec(`
    DROP INDEX IF EXISTS idx_catalogue_event_platform;
    DROP INDEX IF EXISTS idx_catalogue_event_at;
    DROP TABLE IF EXISTS catalogue_event;
  `);
}
