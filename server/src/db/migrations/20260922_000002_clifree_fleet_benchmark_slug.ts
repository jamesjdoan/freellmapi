// Migration: clifree_fleet_snapshot.benchmark_slug — which AA row scored this.
// Created: 2026-09-22
//
// DOWN: reversible — drops only the column it adds.
//
// The first cut stored `intelligence` and nothing else, which is enough for a
// standalone table and not enough for the comparison the page exists for. To
// place a free CLI route on the same graph and rank list as everything else it
// needs coding, agentic, speed and price too — and those live in `aa_model`,
// reachable only from the slug the ranker already matched and then discarded.
//
// Storing the slug rather than copying the metrics: `aa_model` is refreshed by
// benchmark sync, and a copy taken at delivery time would drift silently while
// still looking authoritative. The slug is the stable fact the machine
// observed; every score is derived from it at read time.
//
// Nullable, because a route with no benchmark match is a real state — a third
// of Cline's free roster is unrated — and an empty string would be
// indistinguishable from a slug nobody has looked up yet.

import type { Db } from '../types.js';

// Guarded, because migrations are re-run against a live database rather than
// only against a fresh one: catalog-sync replays the baseline set to rebuild
// catalogue state, and a bare ALTER threw `duplicate column name` and aborted
// the whole transaction — taking every later migration with it. The same guard
// is why 000001 uses IF NOT EXISTS and aa_cost_per_task reads table_info first.
export function up(db: Db): void {
  const columns = db.prepare('PRAGMA table_info(clifree_fleet_snapshot)').all() as { name: string }[];
  if (columns.some(c => c.name === 'benchmark_slug')) return;
  db.exec(`ALTER TABLE clifree_fleet_snapshot ADD COLUMN benchmark_slug TEXT`);
}

export function down(db: Db): void {
  // SQLite has supported DROP COLUMN since 3.35; better-sqlite3 ships newer.
  db.exec(`ALTER TABLE clifree_fleet_snapshot DROP COLUMN benchmark_slug`);
}
