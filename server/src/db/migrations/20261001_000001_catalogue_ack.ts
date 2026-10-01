// Migration: catalogue_ack — which catalogue ARRIVALS the operator has read.
//
// Created: 2026-10-01
//
// WHY
//
// `getCatalogueChanges` returns every model that arrived inside its window, on
// every visit, forever. The panel that reads it therefore shows the same 50
// rows each time, with no way to say "I have been through these", and the
// urgent rows — an arrival already serving traffic — stop standing out from a
// month of history.
//
// `models.first_seen_at` records WHEN a model appeared, never that anyone has
// read about it, and the client-side seen-arrival store is per-browser, so the
// same install would disagree with itself between machines.
//
// ARRIVALS ONLY, and that is a decision rather than an omission. Departures
// already have a permanent marker that means the right thing:
// `catalog_model_tombstones.acknowledged_at` lives ON the tombstone, and
// relisting DELETES the tombstone (services/model-state.ts), so a retire →
// relist → retire-again cycle produces a new retirement with nothing
// acknowledged about it. An identity-only mark in this table would survive that
// delete and hide a second loss of routing forever, which is the opposite of
// what the panel exists to report.
//
// WHY SO FEW COLUMNS
//
// This is a mark-off set, not a log. `(platform, model_id)` and nothing else:
// no timestamp, no record of who acknowledged what. The history lives in
// `catalogue_event`, which already has it, and the ADR records the honest
// consequence — an acknowledged arrival that is later relisted stays
// acknowledged. Adding a timestamp later is additive at the schema level, but
// existing rows carry no time to backfill and the real moment of
// acknowledgement cannot be reconstructed.
//
// Not deleted by any sync path: no foreign key, no cascade. A model that leaves
// the catalogue keeps its mark, which is correct — the operator read it once,
// and that stays true whether or not the provider still lists it.
//
// DOWN: drops the table, so every arrival reads as unread again.
//
// ADR: docs/adr/ARCH-20260930-catalogue-panel-unread-worklist.md

import type { Db } from '../types.js';

export function up(db: Db): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS catalogue_ack (
      platform TEXT NOT NULL,
      model_id TEXT NOT NULL,
      PRIMARY KEY (platform, model_id)
    );
  `);
}

export function down(db: Db): void {
  db.exec('DROP TABLE IF EXISTS catalogue_ack;');
}