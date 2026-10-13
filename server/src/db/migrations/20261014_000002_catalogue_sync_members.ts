// Migration: which models each catalog update added and removed
// Created: 2026-10-14
//
// DOWN: reversible - drops the column (SQLite 3.35+).
//
// catalogue_sync recorded how MANY models each update added and removed, per
// provider, but not WHICH: details_json holds only field edits on models both
// documents carried. members_json closes that: { added: [...], removed: [...] }
// with registry, platform, model id and display name, written by sync from now
// on.
//
// Rows written before this column existed are backfilled from catalogue_event,
// which logged every chat arrival and catalog prune with its own timestamp,
// inside the same apply. A row is filled only when the events between the
// previous sync row and this one match its counts EXACTLY; anything else stays
// null and the dashboard says the names were not recorded. A guessed list
// would be worse than an honest gap. Rows that added and removed nothing get
// empty lists, which is simply true.

import type { Db } from '../types.js';

interface SyncRow { id: number; at: string; doc_added: number; doc_removed: number }
interface EventRow { kind: string; platform: string; model_id: string; display_name: string | null }

export function up(db: Db): void {
  const columns = db.prepare('PRAGMA table_info(catalogue_sync)').all() as Array<{ name: string }>;
  if (!columns.some(c => c.name === 'members_json')) {
    db.exec('ALTER TABLE catalogue_sync ADD COLUMN members_json TEXT');
  }

  const rows = db.prepare('SELECT id, at, doc_added, doc_removed FROM catalogue_sync ORDER BY at, id').all() as SyncRow[];
  const pending = db.prepare('SELECT members_json FROM catalogue_sync WHERE id = ?');
  const write = db.prepare('UPDATE catalogue_sync SET members_json = ? WHERE id = ?');
  const events = db.prepare(`
    SELECT kind, platform, model_id, display_name
      FROM catalogue_event
     WHERE source = 'catalog' AND kind IN ('arrived', 'removed')
       AND at > ? AND at <= ?
     ORDER BY at, id
  `);

  let previousAt = '';
  let filled = 0;
  for (const row of rows) {
    const windowStart = previousAt;
    previousAt = row.at;
    const current = pending.get(row.id) as { members_json: string | null };
    if (current.members_json !== null) continue;
    if (row.doc_added === 0 && row.doc_removed === 0) {
      write.run(JSON.stringify({ added: [], removed: [] }), row.id);
      continue;
    }
    const found = events.all(windowStart, row.at) as EventRow[];
    const toMember = (e: EventRow) => ({ r: 'chat', p: e.platform, m: e.model_id, n: e.display_name });
    const added = found.filter(e => e.kind === 'arrived').map(toMember);
    const removed = found.filter(e => e.kind === 'removed').map(toMember);
    if (added.length === row.doc_added && removed.length === row.doc_removed) {
      write.run(JSON.stringify({ added, removed }), row.id);
      filled++;
    }
  }
  if (filled > 0) console.log(`[catalogue-sync-log] backfilled model names for ${filled} update(s) from catalogue_event`);
}

export function down(db: Db): void {
  db.exec('ALTER TABLE catalogue_sync DROP COLUMN members_json');
}
