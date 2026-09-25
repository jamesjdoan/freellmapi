// Migration: clifree_fleet_usage_per_day — bucket CLI-fleet usage by UTC day.
// Created: 2026-09-23
//
// DOWN: reversible — restores the lifetime table exactly as it was renamed.
//
// WHY
//
// The Analytics page windows FreeLLM's own traffic by range (24h/7d/30d/90d).
// Lifetime totals per (machine, spec) cannot be windowed, so an "all offloaded
// inference" figure would have to add a 7-day number to a lifetime one — a sum
// that is neither. Per-day buckets let one range select both.
//
// Each delivery still carries the machine's FULL history, now split by day,
// and still replaces that machine's rows wholesale, so a missed or repeated
// delivery stays a no-op rather than a lost or doubled count.
//
// NOTHING IS DROPPED. The lifetime table is renamed, not deleted: its rows
// carry no day and cannot be placed in one without inventing a date, and the
// next delivery from each machine rebuilds its history from the agent's own
// store anyway. It held 0 rows in production when this was written
// (checked 2026-09-23), so the archive is expected to be empty.
//
// NOT ROUTABLE. See docs/adr/ARCH-20260922-clifree-fleet-telemetry.md.

import type { Db } from '../types.js';

export function up(db: Db): void {
  // Idempotent like upstream's migrations: a second pass over a database that
  // already has the per-day table would otherwise rename it onto the archive.
  const columns = db.prepare('PRAGMA table_info(clifree_fleet_usage)').all() as { name: string }[];
  if (columns.some(c => c.name === 'day')) return;
  db.exec(`
    DROP INDEX IF EXISTS idx_clifree_fleet_usage_provider;
    ALTER TABLE clifree_fleet_usage RENAME TO clifree_fleet_usage_lifetime_archive;

    CREATE TABLE clifree_fleet_usage (
      machine TEXT NOT NULL,
      spec TEXT NOT NULL,
      provider TEXT NOT NULL,
      -- UTC calendar day of the work, YYYY-MM-DD, as the agent's store dated it.
      day TEXT NOT NULL,
      requests INTEGER NOT NULL DEFAULT 0,
      input_tokens INTEGER NOT NULL DEFAULT 0,
      output_tokens INTEGER NOT NULL DEFAULT 0,
      -- What the agent said it billed. Diagnostic, never a value term.
      reported_cost_usd REAL NOT NULL DEFAULT 0,
      observed_at_ms INTEGER NOT NULL,
      PRIMARY KEY (machine, spec, day)
    );
    CREATE INDEX idx_clifree_fleet_usage_day ON clifree_fleet_usage(day);
    CREATE INDEX idx_clifree_fleet_usage_provider ON clifree_fleet_usage(provider);
  `);
}

export function down(db: Db): void {
  db.exec(`
    DROP INDEX IF EXISTS idx_clifree_fleet_usage_day;
    DROP INDEX IF EXISTS idx_clifree_fleet_usage_provider;
    DROP TABLE IF EXISTS clifree_fleet_usage;
    ALTER TABLE clifree_fleet_usage_lifetime_archive RENAME TO clifree_fleet_usage;
    CREATE INDEX IF NOT EXISTS idx_clifree_fleet_usage_provider ON clifree_fleet_usage(provider);
  `);
}
