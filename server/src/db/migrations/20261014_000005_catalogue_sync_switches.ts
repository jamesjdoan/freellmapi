// Migration: count models the feed switched off or on, apart from edits
// Created: 2026-10-14
//
// DOWN: reversible - drops the two columns (SQLite 3.35+).
//
// The sync log counted a model whose `enabled` flag flipped as "changed",
// next to quota and name edits. A feed switching a model off is not an edit:
// the router stops serving it, so for the operator it has left the free pool.
// It now has its own counts, and "changed" means a real field edit.
//
// Existing rows are recounted from their own details_json, which records every
// field change including the enabled flips. A row whose details hit the storage
// cap cannot be recounted exactly; it keeps its old numbers and zero switches.

import type { Db } from '../types.js';

const DETAILS_CAP = 400;

interface Detail { r: string; p: string; m: string; f: string; o: unknown; n: unknown }
interface Churn { a: number; r: number; c: number; off?: number; on?: number }

export function up(db: Db): void {
  const columns = db.prepare('PRAGMA table_info(catalogue_sync)').all() as Array<{ name: string }>;
  if (!columns.some(c => c.name === 'doc_switched_off')) {
    db.exec('ALTER TABLE catalogue_sync ADD COLUMN doc_switched_off INTEGER NOT NULL DEFAULT 0');
  }
  if (!columns.some(c => c.name === 'doc_switched_on')) {
    db.exec('ALTER TABLE catalogue_sync ADD COLUMN doc_switched_on INTEGER NOT NULL DEFAULT 0');
  }

  const rows = db.prepare('SELECT id, by_platform_json, details_json FROM catalogue_sync').all() as Array<{
    id: number; by_platform_json: string | null; details_json: string | null;
  }>;
  const write = db.prepare(`
    UPDATE catalogue_sync
       SET doc_changed = ?, doc_switched_off = ?, doc_switched_on = ?, by_platform_json = ?
     WHERE id = ?
  `);
  for (const row of rows) {
    let details: Detail[];
    let byPlatform: Record<string, Churn>;
    try {
      details = JSON.parse(row.details_json ?? '[]') as Detail[];
      byPlatform = JSON.parse(row.by_platform_json ?? '{}') as Record<string, Churn>;
    } catch {
      continue;
    }
    if (details.length >= DETAILS_CAP) continue;

    const edited = new Set<string>();
    const recount: Record<string, Churn> = {};
    for (const [platform, churn] of Object.entries(byPlatform)) {
      recount[platform] = { a: churn.a, r: churn.r, c: 0, off: 0, on: 0 };
    }
    let off = 0;
    let on = 0;
    for (const d of details) {
      const churn = (recount[d.p] ??= { a: 0, r: 0, c: 0, off: 0, on: 0 });
      if (d.f !== 'enabled') {
        const key = `${d.r}:${d.p}:${d.m}`;
        if (!edited.has(key)) {
          edited.add(key);
          churn.c++;
        }
      } else if (d.o === true && d.n === false) {
        off++;
        churn.off!++;
      } else if (d.o === false && d.n === true) {
        on++;
        churn.on!++;
      }
    }
    for (const [platform, churn] of Object.entries(recount)) {
      if (churn.a + churn.r + churn.c + churn.off! + churn.on! === 0) delete recount[platform];
    }
    write.run(edited.size, off, on, JSON.stringify(recount), row.id);
  }
}

export function down(db: Db): void {
  db.exec('ALTER TABLE catalogue_sync DROP COLUMN doc_switched_on');
  db.exec('ALTER TABLE catalogue_sync DROP COLUMN doc_switched_off');
}
