// Migration: quota unit — what a 'credits' number is actually counted in
// Created: 2026-09-06
//
// DOWN: reversible — drops both columns. Nothing else reads them, and the
// numbers they describe stay in place.
//
// Two providers report the metric 'credits' in units that are not comparable:
//
//   openrouter::credits   1200   cents of account balance
//   ollama::session       8290   ten-thousandths of an allowance whose size
//                                Ollama never states
//
// Both landed in the same column with nothing to tell them apart, so the
// dashboard could only show bare integers. Formatting on the metric alone
// rendered Ollama's 82.9% remaining as "$82.90" against an invented $100.00
// limit — worse than showing nothing, because it looked like a fact.
//
// `unit` is deliberately separate from `metric`. The metric says what is being
// counted (requests, tokens, credits); the unit says in what denomination, and
// only the pair can be rendered. NULL means the plain count the column always
// implied, so every existing row keeps its current meaning.

import type { Db } from '../types.js';

function hasColumn(db: Db, table: string, column: string): boolean {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  return columns.some((candidate) => candidate.name === column);
}

export function up(db: Db): void {
  for (const table of ['provider_quota_observations', 'provider_quota_state']) {
    if (!hasColumn(db, table, 'unit')) {
      db.prepare(`ALTER TABLE ${table} ADD COLUMN unit TEXT`).run();
    }
  }
}

export function down(db: Db): void {
  for (const table of ['provider_quota_observations', 'provider_quota_state']) {
    if (hasColumn(db, table, 'unit')) {
      db.prepare(`ALTER TABLE ${table} DROP COLUMN unit`).run();
    }
  }
}
