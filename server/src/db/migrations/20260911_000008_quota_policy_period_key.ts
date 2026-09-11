// Migration: let one subject hold one limit PER PERIOD.
// Created: 2026-09-11
//
// `idx_quota_policy_subject` was unique on
// (platform, model_id, endpoint_scope, scope, metric) — no period. So a subject
// could hold exactly one requests limit, and a provider that states two of them
// could not be described.
//
// Google states both in the same refusal, on the same metric name,
// distinguished only by value:
//
//   limit: 5,  model: gemini-3.8-flash   ← per minute
//   limit: 20, model: gemini-3.8-flash   ← per day
//
// Writing the daily one silently replaced the per-minute one via the upsert's
// ON CONFLICT, which is worse than refusing it: the row still looked right, and
// the limit that actually binds intraday was gone.
//
// Adding `period_kind` to the key is the smallest change that makes both
// expressible. It does not widen what a single period can say, so no existing
// row changes meaning, and duplicates cannot exist today — the old index
// already forbade them.
//
// DOWN: reversible, but only when no subject holds two periods. Collapsing them
// would have to pick one limit and silently discard the other, which is the bug
// this migration exists to remove, so it refuses instead.

import type { Db } from '../types.js';

export function up(db: Db): void {
  db.exec(`
    DROP INDEX IF EXISTS idx_quota_policy_subject;
    CREATE UNIQUE INDEX idx_quota_policy_subject
      ON quota_policy(platform, IFNULL(model_id, ''), IFNULL(endpoint_scope, ''), scope, metric, period_kind);
  `);
}

export function down(db: Db): void {
  const clash = db.prepare(`
    SELECT COUNT(*) AS n FROM (
      SELECT 1 FROM quota_policy
       GROUP BY platform, IFNULL(model_id, ''), IFNULL(endpoint_scope, ''), scope, metric
      HAVING COUNT(*) > 1
    )
  `).get() as { n: number };
  if (clash.n > 0) {
    throw new Error(
      `Cannot narrow idx_quota_policy_subject: ${clash.n} subject(s) hold a limit for more than one period. ` +
      'Delete the extra periods first — this migration cannot choose which limit to discard.',
    );
  }

  db.exec(`
    DROP INDEX IF EXISTS idx_quota_policy_subject;
    CREATE UNIQUE INDEX idx_quota_policy_subject
      ON quota_policy(platform, IFNULL(model_id, ''), IFNULL(endpoint_scope, ''), scope, metric);
  `);
}
