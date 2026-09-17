import type { Db } from '../types.js';

/**
 * Migration: archive pre-upgrade provider_quota_state rows.
 *
 * The upstream migration 20260915_000001_quota_snapshot_freshness.ts updates
 * provider_quota_state rows in-place (limit_value, remaining_value, reset_at,
 * reset_strategy, source, confidence, notes, observed_at) and zeroes confidence
 * where no fresh observation exists. To keep the original values recoverable,
 * this migration copies the complete pre-upgrade state into a migration-owned
 * archive table. It runs immediately before the freshness migration so the
 * archive captures the state as it existed before any in-place repair.
 *
 * The archive table mirrors provider_quota_state columns and adds an
 * archived_at timestamp. The INSERT is guarded with INSERT OR IGNORE so that
 * re-running the migration (e.g. during a round-trip test) inserts nothing on
 * subsequent executions.
 */
export function up(db: Db): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS provider_quota_state_pre_v0_11_0 (
      platform TEXT NOT NULL,
      key_id INTEGER NOT NULL,
      quota_pool_key TEXT NOT NULL,
      metric TEXT NOT NULL,
      limit_value INTEGER,
      remaining_value INTEGER,
      reset_at TEXT,
      reset_strategy TEXT NOT NULL DEFAULT 'unknown',
      source TEXT NOT NULL DEFAULT 'probe',
      confidence REAL NOT NULL DEFAULT 0,
      notes TEXT,
      observed_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      unit TEXT,
      archived_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (platform, key_id, quota_pool_key, metric)
    );
  `);

  db.exec(`
    INSERT OR IGNORE INTO provider_quota_state_pre_v0_11_0 (
      platform,
      key_id,
      quota_pool_key,
      metric,
      limit_value,
      remaining_value,
      reset_at,
      reset_strategy,
      source,
      confidence,
      notes,
      observed_at,
      updated_at,
      unit,
      archived_at
    )
    SELECT
      platform,
      key_id,
      quota_pool_key,
      metric,
      limit_value,
      remaining_value,
      reset_at,
      reset_strategy,
      source,
      confidence,
      notes,
      observed_at,
      updated_at,
      unit,
      datetime('now')
    FROM provider_quota_state;
  `);
}

export function down(db: Db): void {
  db.exec('DROP TABLE IF EXISTS provider_quota_state_pre_v0_11_0;');
}