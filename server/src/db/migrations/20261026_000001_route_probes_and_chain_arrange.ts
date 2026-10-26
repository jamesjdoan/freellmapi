// Migration: route_probe_result and chain_arrange_run — evidence for routes
// nobody calls, and a record of every automatic chain arrangement.
//
// Created: 2026-10-26 (ADR ARCH-20261026-chain-auto-arrange)
//
// route_probe_result is append-only history, one row per graded screening
// scenario a route answered (or failed to answer). Two writers:
//   - the scheduled probe (services/route-probe.ts): one agentic scenario per
//     call, streamed, straight to the provider adapter, source 'probe';
//   - the bench import (POST /api/analysis/bench-results): every scenario of a
//     CLI run, non-streamed, source 'import' — which is how the coding
//     scenarios, graded only on the host, keep a history too.
// It is history rather than a last-status row so drift can be read: the same
// route scoring 90 in September and 40 in October is the point of keeping it.
//
// Keyed by ROUTE — (platform, model_id, endpoint_scope) — not by models.id:
// the catalogue rebuilds model rows, and evidence must outlive that (the
// model_expiry / model_bench_result convention). key_id is recorded because
// one route can be served by more than one key; it is NULL for an import,
// where the CLI does not report which key it used.
//
// chain_arrange_run records each APPLIED arrangement of one chain: what the
// order was, what it became, every move with its reason, and the settings
// revision in force. Routes are stored with their identity as well as their
// model row id for the same rebuild reason.
//
// DOWN: reversible — drops both tables and the history in them. Nothing that
// existed before is altered by up().

import type { Db } from '../types.js';

export function up(db: Db): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS route_probe_result (
      id INTEGER PRIMARY KEY,
      platform TEXT NOT NULL,
      model_id TEXT NOT NULL,
      -- '' for catalogue routes; the relay's base URL for custom ones.
      endpoint_scope TEXT NOT NULL DEFAULT '',
      key_id INTEGER,
      -- Screening scenario id from services/model-bench/fixtures.ts.
      scenario_id TEXT NOT NULL CHECK (scenario_id IN ('A1','A2','A3','C1','C2','C3')),
      bench_version TEXT NOT NULL,
      source TEXT NOT NULL CHECK (source IN ('probe','import')),
      streamed INTEGER NOT NULL CHECK (streamed IN (0,1)),
      -- Did the route answer at all? Separate from the graded status: a route
      -- can answer and fail the scenario, or never answer.
      --   ok            answered with content or tool calls
      --   empty         answered with neither (the step-5-preview failure)
      --   timeout       aborted at the probe's ceiling
      --   rate_limited  429 / quota refusal: says nothing about the model
      --   refused       401/402/403/404: access, not quality
      --   error         anything else
      outcome TEXT NOT NULL CHECK (outcome IN ('ok','empty','timeout','rate_limited','refused','error')),
      -- Bench status: PASS | FAIL | INCONCLUSIVE | UNSUPPORTED.
      status TEXT NOT NULL CHECK (status IN ('PASS','FAIL','INCONCLUSIVE','UNSUPPORTED')),
      -- 0..100 on the bench's internal scale; NULL when nothing was gradable.
      score REAL,
      -- native | simulated | none, as the bench transcript records it.
      mode TEXT NOT NULL,
      latency_ms INTEGER,
      ttfb_ms INTEGER,
      prompt_tokens INTEGER NOT NULL DEFAULT 0,
      completion_tokens INTEGER NOT NULL DEFAULT 0,
      error TEXT,
      probed_at_ms INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_route_probe_result_route
      ON route_probe_result(platform, model_id, endpoint_scope, probed_at_ms);
    CREATE INDEX IF NOT EXISTS idx_route_probe_result_time
      ON route_probe_result(probed_at_ms);

    CREATE TABLE IF NOT EXISTS chain_arrange_run (
      id INTEGER PRIMARY KEY,
      -- profiles.name, e.g. 'Apex'.
      chain TEXT NOT NULL,
      ran_at_ms INTEGER NOT NULL,
      -- schedule: the hourly pass; manual: an operator pressed Arrange now.
      trigger TEXT NOT NULL CHECK (trigger IN ('schedule','manual')),
      -- Revision of settings.imperium_chain_arrange in force for this run.
      settings_revision INTEGER NOT NULL,
      -- JSON arrays of { modelDbId, platform, modelId, endpointScope }.
      before_json TEXT NOT NULL,
      after_json TEXT NOT NULL,
      -- JSON array of { modelDbId, platform, modelId, endpointScope, from, to,
      -- eligibility, tier, reasons[] } for every route in the new order.
      moves_json TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_chain_arrange_run_chain
      ON chain_arrange_run(chain, ran_at_ms);
  `);
}

export function down(db: Db): void {
  db.exec(`
    DROP TABLE IF EXISTS chain_arrange_run;
    DROP TABLE IF EXISTS route_probe_result;
  `);
}
