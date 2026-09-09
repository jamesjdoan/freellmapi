// Migration: decision-time routing trace on request_attempts
// Created: 2026-09-09
//
// DOWN: reversible — drops the column. Only the drill-down reads it, and the
// hops it annotates stay in place with their provider, outcome and timings.
//
// `request_attempts` already records what HAPPENED on each hop: provider,
// model, key ordinal, outcome, timings, redacted error. It records nothing
// about why that hop was chosen, and the quota-aware routing work made that
// gap expensive: scarcity, reset-urgency harvesting and provider spreading all
// shift the ordering, all of them are computed per request, and all of them
// were discarded the instant the choice was made.
//
// A later `/api/fallback/routing` snapshot cannot fill it in. That endpoint
// reports the scores as they are NOW — on quota that has since moved, with a
// different set of requests in flight — so it can show the machinery exists
// but never that a particular past request was decided by it. The only place
// the answer exists is the moment of the decision, which is what this column
// captures.
//
// One JSON column rather than six typed ones, deliberately: these are
// diagnostic values read by a human or a drill-down, never joined, filtered or
// aggregated in SQL. Six nullable REALs would pay migration and schema cost on
// every future signal added or renamed, for query shapes nothing performs.

import type { Db } from '../types.js';

function hasColumn(db: Db, table: string, column: string): boolean {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  return rows.some(r => r.name === column);
}

export function up(db: Db): void {
  if (!hasColumn(db, 'request_attempts', 'routing_json')) {
    db.prepare('ALTER TABLE request_attempts ADD COLUMN routing_json TEXT').run();
  }
}

export function down(db: Db): void {
  if (hasColumn(db, 'request_attempts', 'routing_json')) {
    db.prepare('ALTER TABLE request_attempts DROP COLUMN routing_json').run();
  }
}
