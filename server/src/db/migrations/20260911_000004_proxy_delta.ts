import type { Db } from '../types.js';

// Migration: an adjustment on a proxy benchmark link.
// Created: 2026-09-11
//
// A proxy says "nothing measures this model, read it as roughly that one". The
// stand-in is rarely exactly right, and an operator who knows the model is a
// little better or a little worse than its proxy has no way to say so — which
// matters because every table here sorts on these numbers, and a column of
// identical borrowed scores sorts arbitrarily.
//
// Stored in index points and applied to the three indices, so "Kimi K3 minus
// two" ranks just below Kimi K3 instead of tying with it. Meaningless for auto
// and manual links, where the numbers are measurements rather than estimates.
//
// DOWN: reversible - drops the column by rebuild.

export function up(db: Db): void {
  const columns = db.prepare('PRAGMA table_info(aa_model_link)').all() as { name: string }[];
  if (columns.some(c => c.name === 'proxy_delta')) return;
  db.exec('ALTER TABLE aa_model_link ADD COLUMN proxy_delta REAL NOT NULL DEFAULT 0');
}

export function down(db: Db): void {
  const columns = db.prepare('PRAGMA table_info(aa_model_link)').all() as { name: string }[];
  if (!columns.some(c => c.name === 'proxy_delta')) return;
  db.exec(`
    CREATE TABLE aa_model_link_down (
      platform TEXT NOT NULL,
      model_id TEXT NOT NULL,
      aa_slug TEXT,
      source TEXT NOT NULL DEFAULT 'auto',
      match_reason TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (platform, model_id)
    );
    INSERT INTO aa_model_link_down (platform, model_id, aa_slug, source, match_reason, created_at)
      SELECT platform, model_id, aa_slug, source, match_reason, created_at FROM aa_model_link;
    DROP TABLE aa_model_link;
    ALTER TABLE aa_model_link_down RENAME TO aa_model_link;
    CREATE INDEX IF NOT EXISTS idx_aa_model_link_slug ON aa_model_link(aa_slug);
  `);
}
