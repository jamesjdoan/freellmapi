import type { Db } from '../types.js';

// Migration: a proxy adjustment for speed.
// Created: 2026-09-11
//
// The three index adjustments are in points, which works because the indices
// share a scale. Speed does not: it is tokens per second and runs from about 30
// to 350 on this catalogue, so a one-point step would be noise on a fast route
// and decisive on a slow one. Stored the same way and applied proportionally
// instead - see `nudge` in services/analysis.ts.
//
// DOWN: reversible - rebuilds the table without the column.

export function up(db: Db): void {
  const columns = db.prepare('PRAGMA table_info(aa_model_link)').all() as { name: string }[];
  if (columns.some(c => c.name === 'proxy_delta_speed')) return;
  db.exec('ALTER TABLE aa_model_link ADD COLUMN proxy_delta_speed REAL NOT NULL DEFAULT 0');
}

export function down(db: Db): void {
  const columns = (db.prepare('PRAGMA table_info(aa_model_link)').all() as { name: string }[]).map(c => c.name);
  if (!columns.includes('proxy_delta_speed')) return;
  const kept = columns.filter(c => c !== 'proxy_delta_speed');
  const defs = kept.map(c => {
    if (c === 'platform' || c === 'model_id') return `${c} TEXT NOT NULL`;
    if (c === 'source') return `${c} TEXT NOT NULL DEFAULT 'auto'`;
    if (c === 'created_at') return `${c} TEXT NOT NULL DEFAULT (datetime('now'))`;
    if (c.startsWith('proxy_delta')) return `${c} REAL NOT NULL DEFAULT 0`;
    return `${c} TEXT`;
  });
  const list = kept.join(', ');
  db.exec(`
    CREATE TABLE aa_model_link_rebuild (
      ${defs.join(',\n      ')},
      PRIMARY KEY (platform, model_id)
    );
    INSERT INTO aa_model_link_rebuild (${list}) SELECT ${list} FROM aa_model_link;
    DROP TABLE aa_model_link;
    ALTER TABLE aa_model_link_rebuild RENAME TO aa_model_link;
    CREATE INDEX IF NOT EXISTS idx_aa_model_link_slug ON aa_model_link(aa_slug);
  `);
}
