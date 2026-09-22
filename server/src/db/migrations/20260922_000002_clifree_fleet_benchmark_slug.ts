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

export function up(db: Db): void {
  db.exec(`ALTER TABLE clifree_fleet_snapshot ADD COLUMN benchmark_slug TEXT`);
}

export function down(db: Db): void {
  // SQLite has supported DROP COLUMN since 3.35; better-sqlite3 ships newer.
  db.exec(`ALTER TABLE clifree_fleet_snapshot DROP COLUMN benchmark_slug`);
}
