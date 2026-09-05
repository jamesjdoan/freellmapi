// Migration: quota_burn_run — deliberate limit-discovery experiments
// Created: 2026-09-06
//
// DOWN: reversible — drops the table. The rows are experiment records, not
// ledger history: the usage they caused is already in `requests` and
// `rate_limit_usage` and survives independently.
//
// A burn run is an operator saying "spend this provider's allowance until it
// refuses, so we learn what the allowance IS". Providers like NVIDIA, OpenCode
// Zen and Ollama publish no limit, no remaining and no reset, so the only way
// to find the number is to reach it.
//
// The run has two phases on wildly different timescales, which is why it needs
// a table rather than an in-memory job:
//
//   1. BURN — minutes. Send minimal completions until one is refused. The count
//      at refusal is the observed ceiling.
//   2. RECOVER — up to a month. Poll until a request succeeds again. The
//      elapsed time is what distinguishes a per-minute cap from a daily,
//      weekly or monthly one, and no in-process job survives that long.
//
// `phase` is therefore the resumption point after a restart, and every
// timestamp needed to reconstruct the experiment is persisted as it happens
// rather than derived at the end.

import type { Db } from '../types.js';

export function up(db: Db): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS quota_burn_run (
      id TEXT PRIMARY KEY,
      platform TEXT NOT NULL,
      model_id TEXT NOT NULL,
      key_id INTEGER,
      -- 'burning' | 'recovering' | 'complete' | 'cancelled' | 'failed'
      phase TEXT NOT NULL DEFAULT 'burning',
      -- The caps the operator agreed to. Stored per run: a later change to the
      -- defaults must not rewrite what a past experiment was allowed to spend.
      max_requests INTEGER NOT NULL,
      max_seconds INTEGER NOT NULL,
      -- Longest period worth waiting for: 'day' | 'week' | 'month'. Recovery
      -- polling stops here rather than watching a dead run forever.
      max_period TEXT NOT NULL DEFAULT 'day',
      requests_sent INTEGER NOT NULL DEFAULT 0,
      requests_succeeded INTEGER NOT NULL DEFAULT 0,
      tokens_spent INTEGER NOT NULL DEFAULT 0,
      -- What the provider said no to, and when. NULL means it never refused —
      -- the run hit its own cap first, which bounds the limit from below
      -- without discovering it.
      refused_at TEXT,
      refusal_status INTEGER,
      refusal_error TEXT,
      -- First success after the refusal, and the window that implies.
      recovered_at TEXT,
      observed_period TEXT,
      -- Set when the run itself broke (auth, network, bad model), as opposed to
      -- the provider legitimately refusing on quota.
      failure_error TEXT,
      started_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    -- The recovery poller's only query: runs still waiting to come back.
    CREATE INDEX IF NOT EXISTS idx_quota_burn_run_phase
      ON quota_burn_run(phase, refused_at);
    CREATE INDEX IF NOT EXISTS idx_quota_burn_run_platform
      ON quota_burn_run(platform, started_at DESC);
  `);
}

export function down(db: Db): void {
  db.exec(`
    DROP INDEX IF EXISTS idx_quota_burn_run_platform;
    DROP INDEX IF EXISTS idx_quota_burn_run_phase;
    DROP TABLE IF EXISTS quota_burn_run;
  `);
}
