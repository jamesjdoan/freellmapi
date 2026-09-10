// Migration: drop the standalone model-group tables
// Created: 2026-09-11
//
// DOWN: reversible — recreates the empty tables.
//
// `20260911_000002_model_groups.ts` added a grouping of its own for the model
// comparison. That was a mistake: this project already unifies models at the
// ROUTING level (services/model-groups.ts — always on, keyed on the normalised
// display name, with operator overrides in `model_unify_overrides`), and that
// grouping is what decides which providers one logical model fails over
// across.
//
// Two groupings would drift, and the comparison would end up describing models
// that do not route the way it says. So merging moved onto the Models page,
// where it writes the router's overrides, and Compare now mirrors
// `getModelGroups()`. These tables have no remaining reader.
//
// The earlier migration is deliberately left in place rather than deleted: it
// ran on deployed databases and its row is in the ledger. Removing the file
// would leave that row naming nothing.
//
// `down()` recreates them empty, which is what the repo's round-trip contract
// requires and is honest here: the groupings themselves were migrated into
// unify overrides, so there is no data to bring back — only the shape.

import type { Db } from '../types.js';

export function up(db: Db): void {
  db.exec(`
    DROP INDEX IF EXISTS idx_model_group_member_group;
    DROP TABLE IF EXISTS model_group_member;
    DROP TABLE IF EXISTS model_group;
  `);
}

export function down(db: Db): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS model_group (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      aa_slug TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS model_group_member (
      group_id INTEGER NOT NULL REFERENCES model_group(id) ON DELETE CASCADE,
      platform TEXT NOT NULL,
      model_id TEXT NOT NULL,
      PRIMARY KEY (platform, model_id)
    );
    CREATE INDEX IF NOT EXISTS idx_model_group_member_group ON model_group_member(group_id);
  `);
}
