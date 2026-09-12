// Migration: let a policy describe a REFILLING BUCKET.
// Created: 2026-09-12
//
// Measured on this install, 2026-09-12:
//
//   Groq   `x-ratelimit-reset-requests` grows by exactly 86.4s for every
//          request spent, and `remaining` never climbs while idle.
//          86,400 ÷ 1,000 = 86.4 — capacity 1,000, one request back every
//          86.4 seconds, continuously.
//   Google exhausted at 09:12 and then served single calls at 09:40, 11:42 and
//          11:53, each immediately followed by a refusal: one token roughly
//          every 11-12 minutes, not a day that resets.
//
// Neither is a calendar day and neither is a rolling lookback. A rolling window
// returns a call exactly `windowMs` after it was made — spend 1,000 at once and
// you wait a full day for the first one back. A bucket returns the first in
// 86 seconds. Modelling Groq as `1000/calendar_day` says "resets in 14h" about
// a provider that cannot lock you out for more than a minute and a half.
//
// `period_ms` on a bucket is the refill interval for ONE unit; `limit_value`
// stays the capacity, so nothing about existing readers changes meaning.
//
// SQLite cannot alter a CHECK constraint in place, so the table is rebuilt.
// DOWN rewrites any bucket row as a rolling window over the time it takes to
// refill completely — the closest honest approximation the old vocabulary has.

import type { Db } from '../types.js';

const COLUMNS = `
  id, platform, model_id, scope, metric, limit_value, period_kind, period_ms,
  timezone, anchor_day, priority, enabled, source, confidence, notes,
  created_at, updated_at, endpoint_scope
`;

function rebuild(db: Db, periodKinds: string): void {
  db.exec(`
    CREATE TABLE quota_policy_rebuild (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      platform TEXT NOT NULL,
      model_id TEXT,
      scope TEXT NOT NULL DEFAULT 'provider_account'
        CHECK (scope IN ('provider_account', 'provider_key', 'model', 'shared_pool')),
      metric TEXT NOT NULL DEFAULT 'requests'
        CHECK (metric IN ('requests', 'input_tokens', 'output_tokens', 'total_tokens', 'credits')),
      limit_value INTEGER NOT NULL CHECK (limit_value > 0),
      period_kind TEXT NOT NULL DEFAULT 'calendar_day'
        CHECK (period_kind IN (${periodKinds})),
      period_ms INTEGER CHECK (period_ms IS NULL OR period_ms > 0),
      timezone TEXT,
      anchor_day INTEGER CHECK (anchor_day IS NULL OR (anchor_day >= 1 AND anchor_day <= 31)),
      priority INTEGER NOT NULL DEFAULT 0,
      enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
      source TEXT NOT NULL DEFAULT 'operator'
        CHECK (source IN ('operator', 'catalog', 'documentation', 'provider_api')),
      confidence REAL NOT NULL DEFAULT 0.8 CHECK (confidence >= 0 AND confidence <= 1),
      notes TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      endpoint_scope TEXT
    );
    INSERT INTO quota_policy_rebuild (${COLUMNS}) SELECT ${COLUMNS} FROM quota_policy;
    DROP TABLE quota_policy;
    ALTER TABLE quota_policy_rebuild RENAME TO quota_policy;
    CREATE INDEX idx_quota_policy_lookup ON quota_policy(platform, enabled);
    CREATE UNIQUE INDEX idx_quota_policy_subject
      ON quota_policy(platform, IFNULL(model_id, ''), IFNULL(endpoint_scope, ''), scope, metric, period_kind);
  `);
}

export function up(db: Db): void {
  rebuild(db, `'rolling', 'calendar_day', 'calendar_week', 'calendar_month', 'billing_cycle', 'bucket'`);
}

export function down(db: Db): void {
  // A bucket becomes the rolling window it takes to refill from empty, which
  // keeps the ceiling right and loses only the refill rate.
  db.prepare(`
    UPDATE quota_policy
       SET period_kind = 'rolling',
           period_ms = MAX(1, COALESCE(period_ms, 1) * limit_value),
           notes = COALESCE(notes || ' ', '') || 'Downgraded from a refilling bucket: the refill rate is not expressible here.'
     WHERE period_kind = 'bucket'
  `).run();
  rebuild(db, `'rolling', 'calendar_day', 'calendar_week', 'calendar_month', 'billing_cycle'`);
}
