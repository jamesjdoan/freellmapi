// Migration: routing_decision — what the router considered, chose, and would have chosen
// Created: 2026-09-05
//
// DOWN: reversible — drops only what it creates.
//
// `request_attempts` records what was DISPATCHED and how it went. It has no
// room for what was CONSIDERED, what each candidate scored, or why one won
// (ADR ARCH-20260905, F7) — so a quota-aware router could not be compared
// against the incumbent without asserting the comparison rather than recording
// it.
//
// This table is written in shadow mode, where the quota-aware choice is
// computed and stored but never acted on. It answers exactly two questions:
// do the two routers disagree, and on what basis. It cannot answer whether the
// shadow choice would have SUCCEEDED — that request never ran, which is why a
// bounded canary follows shadow rather than active mode doing so.

import type { Db } from '../types.js';

export function up(db: Db): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS routing_decision (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      created_at_ms INTEGER NOT NULL,
      -- The logical model the candidates all serve (normalized group key), so a
      -- disagreement can be read per model family rather than per provider row.
      logical_model TEXT NOT NULL,
      -- 'shadow' while the incumbent still decides; 'active' once the
      -- quota-aware choice is the one served.
      mode TEXT NOT NULL CHECK (mode IN ('shadow', 'active')),

      -- What actually served the request.
      actual_platform TEXT NOT NULL,
      actual_model_id TEXT NOT NULL,

      -- What quota-aware scoring preferred. NULL when it had no opinion —
      -- one candidate, or no usable quota signal for any of them.
      shadow_platform TEXT,
      shadow_model_id TEXT,

      -- Denormalized so the agreement rate is an indexed count, not a per-row
      -- string comparison over the whole table.
      agreed INTEGER NOT NULL CHECK (agreed IN (0, 1)),

      -- Why the shadow router preferred what it did, in operator-readable form.
      reason TEXT,
      -- Compact per-candidate scores: [{platform, modelId, score, ...}].
      -- Never contains key material — candidates are identified by platform and
      -- model id only.
      candidates_json TEXT,

      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- The two reads this table exists for: recent decisions, and the agreement
    -- rate for one logical model over a window.
    CREATE INDEX IF NOT EXISTS idx_routing_decision_created
      ON routing_decision(created_at_ms);
    CREATE INDEX IF NOT EXISTS idx_routing_decision_model
      ON routing_decision(logical_model, created_at_ms);
  `);
}

export function down(db: Db): void {
  db.exec(`
    DROP INDEX IF EXISTS idx_routing_decision_model;
    DROP INDEX IF EXISTS idx_routing_decision_created;
    DROP TABLE IF EXISTS routing_decision;
  `);
}
