// Migration: routing_decision endpoint identity
// Created: 2026-09-05
//
// DOWN: reversible
//
// For a relay model, `platform` does not identify the provider. Two custom
// endpoints serving the same model id both record platform='custom',
// model_id='nemotron-3-ultra' — so the ledger held two rows that looked
// identical, `shadow_platform` meant nothing, and the `agreed` flag comparing
// them was vacuously true.
//
// Found by driving real traffic through two stub relays: five decisions, five
// agreements, and no way to tell whether the two routers had picked the same
// endpoint or different ones. This is the same subject-identity defect as the
// quota ledger's (ADR F8), in the routing ledger.
//
// `endpoint_scope` is the discriminator the chain already carries: '' for a
// catalog platform, 'custom:<base_url_hash>' for a relay. Storing it alongside
// each side of the comparison makes `agreed` mean what it claims. Existing rows
// keep NULL, which reads as "endpoint not recorded" rather than "same endpoint".

import type { Db } from '../types.js';

function hasColumn(db: Db, table: string, column: string): boolean {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  return columns.some((candidate) => candidate.name === column);
}

export function up(db: Db): void {
  if (!hasColumn(db, 'routing_decision', 'actual_endpoint')) {
    db.prepare('ALTER TABLE routing_decision ADD COLUMN actual_endpoint TEXT').run();
  }
  if (!hasColumn(db, 'routing_decision', 'shadow_endpoint')) {
    db.prepare('ALTER TABLE routing_decision ADD COLUMN shadow_endpoint TEXT').run();
  }
}

export function down(db: Db): void {
  if (hasColumn(db, 'routing_decision', 'shadow_endpoint')) {
    db.prepare('ALTER TABLE routing_decision DROP COLUMN shadow_endpoint').run();
  }
  if (hasColumn(db, 'routing_decision', 'actual_endpoint')) {
    db.prepare('ALTER TABLE routing_decision DROP COLUMN actual_endpoint').run();
  }
}
