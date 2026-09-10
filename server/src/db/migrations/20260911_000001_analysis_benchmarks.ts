// Migration: cached Artificial Analysis benchmarks, and the map to our models
// Created: 2026-09-11
//
// DOWN: reversible - drops both tables.
//
// `models.intelligence_rank` and `speed_rank` are OUR numbers: per-provider,
// hand-tuned, and useful only for ordering a chain. They cannot answer "is
// Kimi K3 actually better at coding than GPT-OSS 120B", because nothing in this
// database has ever measured that.
//
// Artificial Analysis publishes exactly those measurements. Two tables:
//
//   `aa_model`      - their data, cached. Keyed by their slug, which is the
//                     only stable identifier they offer; refreshed wholesale on
//                     each sync. Nulls mean "not measured", never zero, which
//                     is their documented convention and matters here: a model
//                     with no agentic score must not plot as the worst.
//
//   `aa_model_link` - which of our (platform, model_id) rows corresponds to
//                     which slug. Separate from `aa_model` because the mapping
//                     survives a refetch, and because a manual link the
//                     operator made must never be overwritten by the matcher
//                     guessing differently next time.
//
// One row per model per platform, deliberately: the same model served by Groq
// and by OpenRouter is one AA slug but two of our rows, and each needs its own
// link so either can be corrected independently.

import type { Db } from '../types.js';

export function up(db: Db): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS aa_model (
      slug TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      creator TEXT,
      release_date TEXT,
      -- The three headline indices. NULL is "not measured" (their convention),
      -- so every consumer must distinguish it from a low score.
      intelligence_index REAL,
      coding_index REAL,
      agentic_index REAL,
      -- USD per million tokens, as published. Ours are free routes, so this is
      -- for reference and for the cost-per-point comparison, not for billing.
      price_1m_input REAL,
      price_1m_output REAL,
      median_output_tokens_per_second REAL,
      median_time_to_first_token_seconds REAL,
      -- The index version the scores belong to. Scores are only comparable
      -- within a major version, so a reader has to be able to see it.
      index_version TEXT,
      fetched_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS aa_model_link (
      platform TEXT NOT NULL,
      model_id TEXT NOT NULL,
      -- NULL is a deliberate "this model has no AA counterpart": it stops the
      -- matcher re-proposing a bad guess on every sync, which an absent row
      -- cannot do.
      aa_slug TEXT,
      -- 'auto' may be replaced by a later sync; 'manual' never is.
      source TEXT NOT NULL DEFAULT 'auto',
      -- How the automatic match was reached, for a reader deciding whether to
      -- trust it. NULL for manual links.
      match_reason TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (platform, model_id)
    );

    CREATE INDEX IF NOT EXISTS idx_aa_model_link_slug ON aa_model_link(aa_slug);
  `);
}

export function down(db: Db): void {
  db.exec(`
    DROP INDEX IF EXISTS idx_aa_model_link_slug;
    DROP TABLE IF EXISTS aa_model_link;
    DROP TABLE IF EXISTS aa_model;
  `);
}
