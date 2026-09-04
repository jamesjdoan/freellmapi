import type { Db } from '../types.js';

function hasColumn(db: Db, table: string, column: string): boolean {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  return columns.some((candidate) => candidate.name === column);
}

/** Reconciliation state for an upstream retirement.
 *
 *  A provider that retires a model keeps advertising it: NVIDIA answers 410
 *  "has reached its end of life" while `/v1/models` still lists it, and the
 *  published catalogue — built from those same rosters — lists it enabled. The
 *  gateway used to treat that listing as newer evidence and lift its own
 *  retirement on every sync and every boot, so the model went back into
 *  routing and 410'd again. The provider's refusal is the server's own
 *  first-hand result, so it wins; the catalogue's claim is recorded as a
 *  DISAGREEMENT to be reconciled, not as an instruction.
 *
 *  - `relisted_at` / `relist_count` — when, and how often, a synced catalogue
 *    re-listed a model this server has retired. Their presence is what makes a
 *    retirement "unreconciled" and worth showing.
 *  - `acknowledged_at` — the operator read the disagreement and chose to leave
 *    the retirement standing. The row stays retired and drops off the list.
 *
 *  Lifting a retirement stays an explicit act: re-enabling routing from the
 *  dashboard deletes the tombstone outright, which clears all three. */
export function up(db: Db): void {
  if (!hasColumn(db, 'catalog_model_tombstones', 'relisted_at')) {
    db.prepare('ALTER TABLE catalog_model_tombstones ADD COLUMN relisted_at TEXT').run();
  }
  if (!hasColumn(db, 'catalog_model_tombstones', 'relist_count')) {
    db.prepare('ALTER TABLE catalog_model_tombstones ADD COLUMN relist_count INTEGER NOT NULL DEFAULT 0').run();
  }
  if (!hasColumn(db, 'catalog_model_tombstones', 'acknowledged_at')) {
    db.prepare('ALTER TABLE catalog_model_tombstones ADD COLUMN acknowledged_at TEXT').run();
  }
}

export function down(db: Db): void {
  for (const column of ['relisted_at', 'relist_count', 'acknowledged_at']) {
    if (hasColumn(db, 'catalog_model_tombstones', column)) {
      db.prepare(`ALTER TABLE catalog_model_tombstones DROP COLUMN ${column}`).run();
    }
  }
}
