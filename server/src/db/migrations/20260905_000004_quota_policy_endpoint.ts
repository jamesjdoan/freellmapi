// Migration: quota_policy.endpoint_scope — per-relay limits
// Created: 2026-09-05
//
// DOWN: reversible — drops the column and restores the original index.
//
// Third instance of the same subject-identity defect (ADR F8). The quota state
// could not tell two relays apart, then the routing ledger could not, and this
// is the policy table: keyed on (platform, model_id, scope, metric), so two
// endpoints behind platform='custom' serving the same model id are one subject
// and no limit can apply to one without applying to the other.
//
// `endpoint_scope` is the discriminator the chain already carries: '' (or NULL
// here) for a catalog platform, 'custom:<base_url_hash>' for a relay. NULL
// means "every endpoint of this platform+model", which is what every existing
// row means today — so the column is additive in meaning as well as in schema.
//
// The unique index has to be rebuilt rather than added to: it defines what a
// policy subject IS, and leaving the old one in place would forbid a second
// policy that differs only by endpoint — exactly what this migration exists to
// allow.

import type { Db } from '../types.js';

function hasColumn(db: Db, table: string, column: string): boolean {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  return columns.some((candidate) => candidate.name === column);
}

export function up(db: Db): void {
  if (!hasColumn(db, 'quota_policy', 'endpoint_scope')) {
    db.prepare('ALTER TABLE quota_policy ADD COLUMN endpoint_scope TEXT').run();
  }
  db.exec(`
    DROP INDEX IF EXISTS idx_quota_policy_subject;
    CREATE UNIQUE INDEX IF NOT EXISTS idx_quota_policy_subject
      ON quota_policy(platform, IFNULL(model_id, ''), IFNULL(endpoint_scope, ''), scope, metric);
  `);
}

export function down(db: Db): void {
  db.exec('DROP INDEX IF EXISTS idx_quota_policy_subject;');
  if (hasColumn(db, 'quota_policy', 'endpoint_scope')) {
    // Rows that differ only by endpoint would violate the narrower index the
    // moment it is recreated, so the most specific ones go first. Dropping data
    // on a down-migration is a real cost; it is stated here rather than hidden.
    db.prepare("DELETE FROM quota_policy WHERE endpoint_scope IS NOT NULL AND endpoint_scope != ''").run();
    db.prepare('ALTER TABLE quota_policy DROP COLUMN endpoint_scope').run();
  }
  db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_quota_policy_subject
      ON quota_policy(platform, IFNULL(model_id, ''), scope, metric);
  `);
}
