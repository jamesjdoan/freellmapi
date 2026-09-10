// Migration: manual grouping of catalogue rows that are the same model
// Created: 2026-09-11
//
// DOWN: reversible - drops both tables.
//
// The catalogue lists one row per provider route, so a single model appears
// many times under names that agree about nothing:
//
//   ollama/nemotron-3-ultra                        "Nemotron 3 Ultra (Ollama)"
//   nvidia/nvidia/nemotron-3-ultra-550b-a55b       "Nemotron-3 Ultra 550B (NV)"
//   openrouter/nvidia/nemotron-3-ultra-550b-a55b   "Nemotron 3 Ultra 550B (free, slow)"
//   opencode/nemotron-3-ultra-free                 "Nemotron 3 Ultra Free"
//
// The matcher links the two that carry the parameter count and misses the two
// that do not - correctly, since it refuses to guess. Grouping is how the
// operator says "these four are one model", and it buys two things at once:
// the comparison shows one entry instead of four near-duplicates, and members
// with no link of their own inherit the group's, which is the only honest way
// to give `nemotron-3-ultra` a score.
//
// Membership is keyed on (platform, model_id) rather than on models.id: a
// catalogue sync deletes and reinserts rows, and a grouping the operator made
// must not evaporate because upstream republished the model with a new rowid.
// The cost is that a member can name a row that no longer exists, which the
// read path reports rather than hides.

import type { Db } from '../types.js';

export function up(db: Db): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS model_group (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      -- Set only when the operator pins the group to a specific Artificial
      -- Analysis slug. NULL means "inherit from whichever member has a link",
      -- which is the common case and keeps working when the matcher improves.
      aa_slug TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS model_group_member (
      group_id INTEGER NOT NULL REFERENCES model_group(id) ON DELETE CASCADE,
      platform TEXT NOT NULL,
      model_id TEXT NOT NULL,
      -- One group per model: a row that belonged to two groups would have no
      -- single answer for which entry it condenses into.
      PRIMARY KEY (platform, model_id)
    );

    CREATE INDEX IF NOT EXISTS idx_model_group_member_group ON model_group_member(group_id);
  `);
}

export function down(db: Db): void {
  db.exec(`
    DROP INDEX IF EXISTS idx_model_group_member_group;
    DROP TABLE IF EXISTS model_group_member;
    DROP TABLE IF EXISTS model_group;
  `);
}
