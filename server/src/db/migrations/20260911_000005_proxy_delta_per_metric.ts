import type { Db } from '../types.js';

// Migration: per-metric proxy adjustments.
// Created: 2026-09-11
//
// The single `proxy_delta` assumed a stand-in is uniformly close, and it is
// not: a model can code like its proxy and reason worse, which is exactly the
// judgement worth recording. One number per index instead.
//
// The old column's value carries into all three, which is what it meant.
//
// DOWN: reversible - rebuilds the table with the single column, taking the
// intelligence adjustment as the survivor.

const COLUMNS = ['proxy_delta_intelligence', 'proxy_delta_coding', 'proxy_delta_agentic'] as const;

function columnNames(db: Db): string[] {
  return (db.prepare('PRAGMA table_info(aa_model_link)').all() as { name: string }[]).map(c => c.name);
}

export function up(db: Db): void {
  const existing = columnNames(db);
  for (const col of COLUMNS) {
    if (!existing.includes(col)) db.exec(`ALTER TABLE aa_model_link ADD COLUMN ${col} REAL NOT NULL DEFAULT 0`);
  }
  if (existing.includes('proxy_delta')) {
    db.exec(`
      UPDATE aa_model_link SET
        proxy_delta_intelligence = proxy_delta,
        proxy_delta_coding = proxy_delta,
        proxy_delta_agentic = proxy_delta
      WHERE proxy_delta <> 0
    `);
    rebuildWithout(db, 'proxy_delta');
  }
}

export function down(db: Db): void {
  const existing = columnNames(db);
  if (!existing.includes('proxy_delta')) {
    db.exec('ALTER TABLE aa_model_link ADD COLUMN proxy_delta REAL NOT NULL DEFAULT 0');
    if (existing.includes('proxy_delta_intelligence')) {
      db.exec('UPDATE aa_model_link SET proxy_delta = proxy_delta_intelligence');
    }
  }
  for (const col of COLUMNS) rebuildWithout(db, col);
}

/** SQLite before 3.35 has no DROP COLUMN, and the shipped driver is not
 *  guaranteed newer, so the table is rebuilt with the column omitted. */
function rebuildWithout(db: Db, drop: string): void {
  const cols = columnNames(db).filter(c => c !== drop);
  if (cols.length === columnNames(db).length) return;
  const defs = cols.map(c => {
    if (c === 'platform' || c === 'model_id') return `${c} TEXT NOT NULL`;
    if (c === 'source') return `${c} TEXT NOT NULL DEFAULT 'auto'`;
    if (c === 'created_at') return `${c} TEXT NOT NULL DEFAULT (datetime('now'))`;
    if (c.startsWith('proxy_delta')) return `${c} REAL NOT NULL DEFAULT 0`;
    return `${c} TEXT`;
  });
  const list = cols.join(', ');
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
