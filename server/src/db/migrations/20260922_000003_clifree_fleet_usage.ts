// Migration: clifree_fleet_usage — how much inference each MACHINE drew from
// the free CLI rosters, so its market value can be stated.
// Created: 2026-09-22
//
// DOWN: reversible — drops only what it creates.
//
// clifree_fleet_snapshot answers "what can this machine reach". It carries no
// tokens, so it cannot answer the question this table exists for: what was the
// inference we were given actually worth. The Analytics savings figure prices
// FreeLLM's own traffic and reads $0 for every clifree run, because a clifree
// run never touches the proxy — Zen's free tier answers 403 to callers outside
// OpenCode. The work happened, it had a market value, and nothing recorded it.
//
// VALUE, NOT SPEND
//
// The figure derived from these rows is the published price of the equivalent
// model's inference — what this volume of tokens sells for — not what we paid.
// What we paid is approximately nothing, which is the point and is not worth a
// column. `reported_cost_usd` is kept for the opposite reason: it is what the
// AGENT said the run billed (Cline reports it, Zen does not), and a non-zero
// value on a supposedly free route is an alarm. It is a diagnostic, never a
// term in the value figure, and the two must never be summed.
//
// WHY A SECOND TABLE, NOT COLUMNS ON THE SNAPSHOT
//
// The snapshot is REPLACED per machine on every delivery, because a route that
// left the free roster must leave the panel. Usage does not share that
// lifetime: a model dropped from the roster yesterday still did work last
// week, and folding usage into a row that vanishes with the roster would erase
// the record of exactly the routes most worth knowing about.
//
// TOTALS AS REPORTED, NOT DELTAS
//
// Each delivery carries the machine's lifetime totals per spec, read from the
// agent's own durable store, and replaces that machine's usage rows wholesale.
// Deltas would require trusting that no delivery was ever missed or replayed;
// totals are idempotent, so re-delivering the same snapshot is a no-op rather
// than a double count.
//
// NOT ROUTABLE. Like the snapshot, nothing here may be joined into routing,
// fallback or model-picker queries. See
// docs/adr/ARCH-20260922-clifree-fleet-telemetry.md.

import type { Db } from '../types.js';

export function up(db: Db): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS clifree_fleet_usage (
      -- \`hostname -s\` on the reporting machine.
      machine TEXT NOT NULL,
      -- provider:id, split on the FIRST colon, as in clifree_fleet_snapshot.
      spec TEXT NOT NULL,
      -- Denormalised from spec so the panel can total by agent without
      -- re-parsing a format whose delimiter is ambiguous by construction.
      provider TEXT NOT NULL,
      -- Lifetime totals as the reporting machine last observed them.
      requests INTEGER NOT NULL DEFAULT 0,
      input_tokens INTEGER NOT NULL DEFAULT 0,
      output_tokens INTEGER NOT NULL DEFAULT 0,
      -- What the agent itself said it billed. A diagnostic, not a value term:
      -- non-zero on a free route means a free route charged money.
      reported_cost_usd REAL NOT NULL DEFAULT 0,
      observed_at_ms INTEGER NOT NULL,
      PRIMARY KEY (machine, spec)
    );
    CREATE INDEX IF NOT EXISTS idx_clifree_fleet_usage_provider
      ON clifree_fleet_usage(provider);
  `);
}

export function down(db: Db): void {
  db.exec(`
    DROP INDEX IF EXISTS idx_clifree_fleet_usage_provider;
    DROP TABLE IF EXISTS clifree_fleet_usage;
  `);
}
