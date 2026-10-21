// Migration: mark the Extra-Tier overflow on the request log
// Created: 2026-10-22
//
// DOWN: reversible (DROP COLUMN)

import type { Db } from '../types.js';

function hasColumn(db: Db, table: string, column: string): boolean {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  return columns.some((candidate) => candidate.name === column);
}

// ADR ARCH-20261022-extra-tier-overflow: a chain that runs out of routes now
// tries Extra-Tier's members before refusing the request, and every hop
// served from that tail is recorded.
//
// Two columns, both 0/1, both defaulting to 0 so every historical row reads
// as "not an overflow hop":
//
//   requests.overflow        1 when this request leaned on Extra-Tier — at
//                            least one of its attempts was dispatched to an
//                            overflow row. This is the number the dashboard
//                            counts: a chain that overflows often is a chain
//                            that needs more of its own depth.
//   request_attempts.overflow 1 when THIS hop was dispatched to an overflow
//                            row, so the request drill-down shows which hop
//                            left the chain and went to Extra-Tier.
//
// No existing column fits. `requests.failure_attribution` is a different
// question (was the failure a provider moment) and is written only for
// failures; `requests.unlimited` is about pricing, not routing. The mark is
// about which POOL served the request, which nothing recorded.
export function up(db: Db): void {
  if (!hasColumn(db, 'requests', 'overflow')) {
    db.prepare('ALTER TABLE requests ADD COLUMN overflow INTEGER NOT NULL DEFAULT 0').run();
  }
  if (!hasColumn(db, 'request_attempts', 'overflow')) {
    db.prepare('ALTER TABLE request_attempts ADD COLUMN overflow INTEGER NOT NULL DEFAULT 0').run();
  }
}

export function down(db: Db): void {
  if (hasColumn(db, 'request_attempts', 'overflow')) {
    db.prepare('ALTER TABLE request_attempts DROP COLUMN overflow').run();
  }
  if (hasColumn(db, 'requests', 'overflow')) {
    db.prepare('ALTER TABLE requests DROP COLUMN overflow').run();
  }
}
