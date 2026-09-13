import type { Db } from '../types.js';

// Migration: Artificial Analysis's OWN cost per task.
// Created: 2026-09-13
//
// The compare page priced work by blending the per-million input and output
// prices we already store. Any blend is a choice of token mix, and the one
// chosen here reordered the ranking relative to AA's published figures — which
// is indefensible on a page whose every other number comes from AA.
//
// Their API has carried the answer all along, in a field we never read:
//
//   artificial_analysis_intelligence_index_cost: {
//     total_cost: 2172.43,
//     cost_per_task: { total_cost: 1.5625 }     <- USD, gemini-3-5-flash
//   }
//
// That is the cost of running one task of their intelligence-index evaluation
// on the model: a real measured spend over a fixed workload, not a ratio we
// picked. NULL where AA publishes none, which is most of the free catalogue and
// must stay distinguishable from free.
//
// DOWN: reversible — rebuilds the table without the column.

export function up(db: Db): void {
  const columns = db.prepare('PRAGMA table_info(aa_model)').all() as { name: string }[];
  if (columns.some(c => c.name === 'index_cost_per_task')) return;
  db.exec('ALTER TABLE aa_model ADD COLUMN index_cost_per_task REAL');
}

export function down(db: Db): void {
  const columns = (db.prepare('PRAGMA table_info(aa_model)').all() as { name: string }[]).map(c => c.name);
  if (!columns.includes('index_cost_per_task')) return;
  const kept = columns.filter(c => c !== 'index_cost_per_task');
  const defs = kept.map(c => {
    if (c === 'slug') return 'slug TEXT PRIMARY KEY';
    if (c === 'name') return 'name TEXT NOT NULL';
    if (c === 'creator' || c === 'release_date' || c === 'updated_at') return `${c} TEXT`;
    if (c === 'index_version') return `${c} INTEGER`;
    return `${c} REAL`;
  });
  // No BEGIN here: the migration runner already holds a transaction, and
  // opening a second one fails outright ("cannot start a transaction within a
  // transaction"). Atomicity is the runner's to provide.
  db.exec(`CREATE TABLE aa_model_new (${defs.join(', ')})`);
  db.exec(`INSERT INTO aa_model_new (${kept.join(', ')}) SELECT ${kept.join(', ')} FROM aa_model`);
  db.exec('DROP TABLE aa_model');
  db.exec('ALTER TABLE aa_model_new RENAME TO aa_model');
}
