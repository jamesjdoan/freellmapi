// Migration: quota_policy_unit — say what a declared credits limit is counted in.
// Created: 2026-09-25
//
// DOWN: reversible — drops the column; every row returns to the bare count it
// meant before.
//
// WHY
//
// A declared allowance like Mistral's "$10 of usage a month" is metric
// 'credits', and 'credits' alone does not say whether 10 means ten credits,
// ten dollars or ten cents. The observation tables already carry a `unit`
// (20260906_000002_quota_unit); the operator's own declarations did not. NULL
// keeps every existing row meaning exactly what it did.

import type { Db } from '../types.js';

function hasColumn(db: Db, table: string, column: string): boolean {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).some(c => c.name === column);
}

export function up(db: Db): void {
  if (!hasColumn(db, 'quota_policy', 'unit')) db.prepare('ALTER TABLE quota_policy ADD COLUMN unit TEXT').run();
}

export function down(db: Db): void {
  if (hasColumn(db, 'quota_policy', 'unit')) db.prepare('ALTER TABLE quota_policy DROP COLUMN unit').run();
}
