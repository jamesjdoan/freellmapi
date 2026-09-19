// Migration: drop routing_decision — the shadow ledger the shadow router filled
// Created: 2026-09-19
//
// DOWN: recreates the table EMPTY. The rows are not recoverable from here, and
// that is stated rather than hidden: a down migration that silently returns an
// empty table where 3,946 rows used to be is worse than one that says so.
//
// The shadow router was deleted in the preceding commit. It ran on every routed
// request, recorded which provider quota-aware scoring WOULD have preferred,
// and never acted on the answer. The ledger it filled cannot say whether the
// preference was right, because the route it preferred never ran — and 167 of
// its recorded disagreements preferred OpenCode, a provider whose whole key
// surface answers 403 or 404.
//
// Nothing reads this table now. Left in place it is a schema the next reader
// has to understand before discovering it is dead.

import type { Db } from '../types.js';

export function up(db: Db): void {
  db.exec(`
    DROP INDEX IF EXISTS idx_routing_decision_model;
    DROP INDEX IF EXISTS idx_routing_decision_created;
    DROP TABLE IF EXISTS routing_decision;
  `);
}

export function down(db: Db): void {
  // Shape restored from 20260905_000002 plus the endpoint columns added by
  // 20260905_000003, so a rollback lands on the schema those two produced.
  db.exec(`
    CREATE TABLE IF NOT EXISTS routing_decision (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      created_at_ms INTEGER NOT NULL,
      logical_model TEXT NOT NULL,
      mode TEXT NOT NULL CHECK (mode IN ('shadow', 'active')),
      actual_platform TEXT NOT NULL,
      actual_model_id TEXT NOT NULL,
      actual_endpoint TEXT,
      shadow_platform TEXT,
      shadow_model_id TEXT,
      shadow_endpoint TEXT,
      agreed INTEGER NOT NULL,
      reason TEXT,
      candidates_json TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_routing_decision_created
      ON routing_decision(created_at_ms);
    CREATE INDEX IF NOT EXISTS idx_routing_decision_model
      ON routing_decision(logical_model, created_at_ms);
  `);
}
