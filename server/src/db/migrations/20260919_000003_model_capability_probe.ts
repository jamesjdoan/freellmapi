// Migration: model_capability_probe — can this route do the thing its chain requires?
// Created: 2026-09-19
//
// DOWN: reversible — drops only what it creates.
//
// Written because a route can serve text perfectly and still be useless to the
// chain holding it. nvidia/nemotron-parse-2.0 was added to Vision on 2026-09-19
// after probing ok in 696ms, and removed four minutes later:
//
//   01:50:06  error    in=9  out=0   empty completion
//   01:49:52  success  in=2  out=8
//   01:49:42  error    in=9  out=0   empty completion
//
// Both outcomes, same model, same window, from two different QUESTIONS. A
// per-model health verdict reduces that tally to one word and every available
// word is wrong: `dead` libels a working text route, `ok` sends a blind model
// to the one chain that needs eyes. The fact is per-CAPABILITY, so it is stored
// per capability.
//
// A table, not columns on `models`, and not for room to grow. `models` is
// rewritten by catalogue sync — yesterday's added 254 rows — and a probe result
// is measured evidence. Measured evidence does not live in a table an upstream
// sync churns, the same rule that keeps quota observations out of the catalogue.
//
// `endpoint_scope` is in the key because `models` is UNIQUE(platform, model_id,
// endpoint_scope): without it two relay endpoints serving one model id collapse
// into a single row and overwrite each other's verdict. chain-reachability and
// the quota ledger both learned that one the hard way.

import type { Db } from '../types.js';

export function up(db: Db): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS model_capability_probe (
      platform TEXT NOT NULL,
      model_id TEXT NOT NULL,
      -- '' for catalogue routes, matching models.endpoint_scope.
      endpoint_scope TEXT NOT NULL DEFAULT '',
      -- The chain contract this answers: 'vision' or 'tools'.
      capability TEXT NOT NULL,
      -- 'ok' or 'failed'. Absence of a row is the third state, 'unverified',
      -- and is deliberately NOT stored: unknown is not a measurement, and a
      -- row saying so would be indistinguishable from a stale one.
      verdict TEXT NOT NULL CHECK (verdict IN ('ok', 'failed')),
      -- The provider's own words on failure. The reason has to outlive the
      -- requests window, exactly as provider_diagnosis_history keeps its sample.
      detail TEXT,
      latency_ms INTEGER,
      probed_at_ms INTEGER NOT NULL,
      PRIMARY KEY (platform, model_id, endpoint_scope, capability)
    );
    CREATE INDEX IF NOT EXISTS idx_model_capability_probe_capability
      ON model_capability_probe(capability, verdict);
  `);
}

export function down(db: Db): void {
  db.exec(`
    DROP INDEX IF EXISTS idx_model_capability_probe_capability;
    DROP TABLE IF EXISTS model_capability_probe;
  `);
}
