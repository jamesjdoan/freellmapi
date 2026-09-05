// Migration: quota_policy — declared quota limits with scope, period and timezone
// Created: 2026-09-05
//
// DOWN: reversible — drops only what it creates.
//
// Why a new table rather than more columns on `models` (ADR ARCH-20260905, F6):
// `models.rpm_limit`/`rpd_limit`/`tpm_limit`/`tpd_limit` already hold per-model
// numbers, but they carry no period semantics — "rpd" hardcodes both the metric
// AND a 24h window, and there is nowhere to say "resets at midnight Pacific" or
// "this is one pool shared across the whole account". Expressing those on
// `models` would need a column per (metric x period x scope) combination.
//
// This does NOT replace those columns. It sits above them in the precedence
// chain: a live provider header beats an operator policy, which beats the
// catalog default. Operator-entered limits keep `source='operator'` so they are
// never mistaken downstream for something measured.

import type { Db } from '../types.js';

export function up(db: Db): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS quota_policy (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      platform TEXT NOT NULL,
      -- NULL = every model on the platform, which is how an account-wide pool
      -- (OpenRouter's shared free request allowance) is expressed.
      model_id TEXT,
      scope TEXT NOT NULL DEFAULT 'provider_account'
        CHECK (scope IN ('provider_account', 'provider_key', 'model', 'shared_pool')),
      metric TEXT NOT NULL DEFAULT 'requests'
        CHECK (metric IN ('requests', 'input_tokens', 'output_tokens', 'total_tokens', 'credits')),
      limit_value INTEGER NOT NULL CHECK (limit_value > 0),
      period_kind TEXT NOT NULL DEFAULT 'calendar_day'
        CHECK (period_kind IN ('rolling', 'calendar_day', 'calendar_week', 'calendar_month', 'billing_cycle')),
      -- Width for period_kind='rolling'; NULL otherwise.
      period_ms INTEGER CHECK (period_ms IS NULL OR period_ms > 0),
      -- IANA name for the calendar kinds. NULL means UTC.
      timezone TEXT,
      -- Day-of-month anchor for period_kind='billing_cycle'; clamped by the
      -- clock in months too short to contain it.
      anchor_day INTEGER CHECK (anchor_day IS NULL OR (anchor_day >= 1 AND anchor_day <= 31)),
      -- Higher wins when two policies match with equal specificity.
      priority INTEGER NOT NULL DEFAULT 0,
      enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
      -- Provenance: an operator-typed limit is control-plane configuration, not
      -- a measurement, and must never be written back as though it were one.
      source TEXT NOT NULL DEFAULT 'operator'
        CHECK (source IN ('operator', 'catalog', 'documentation', 'provider_api')),
      confidence REAL NOT NULL DEFAULT 0.8 CHECK (confidence >= 0 AND confidence <= 1),
      notes TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- One policy per subject+metric. A platform-wide row (model_id IS NULL) and
    -- a per-model row coexist; the resolver prefers the more specific one.
    -- IFNULL because SQLite treats every NULL as distinct in a UNIQUE index,
    -- which would otherwise allow unlimited duplicate platform-wide rows.
    CREATE UNIQUE INDEX IF NOT EXISTS idx_quota_policy_subject
      ON quota_policy(platform, IFNULL(model_id, ''), scope, metric);

    -- The resolver's read: every enabled policy for one platform, both the
    -- per-model and platform-wide rows, in one indexed scan.
    CREATE INDEX IF NOT EXISTS idx_quota_policy_lookup
      ON quota_policy(platform, enabled);
  `);
}

export function down(db: Db): void {
  db.exec(`
    DROP INDEX IF EXISTS idx_quota_policy_lookup;
    DROP INDEX IF EXISTS idx_quota_policy_subject;
    DROP TABLE IF EXISTS quota_policy;
  `);
}
