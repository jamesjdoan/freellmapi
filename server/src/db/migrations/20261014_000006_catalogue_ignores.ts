// Migration: providers and models the operator never wants to use
// Created: 2026-10-14
//
// DOWN: reversible - drops the table. Ignored keys and models stay switched
// off; un-ignoring before rolling back is what restores them.
//
// One row per ignored provider (model_id = '') or model. Ignoring is both a
// routing decision and a noise filter: it switches the provider's keys and
// the models off (the same flags the router already gates on), keeps them off
// across catalog syncs, and drops them from the catalogue surfaces.
//
// restore_json snapshots which key and model ids were ON at the moment of the
// ignore, so un-ignoring turns exactly those back on and leaves anything that
// was already off - by the operator or by the feed - off.

import type { Db } from '../types.js';

export function up(db: Db): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS catalogue_ignores (
      platform TEXT NOT NULL,
      -- '' ignores the whole provider.
      model_id TEXT NOT NULL DEFAULT '',
      at TEXT NOT NULL DEFAULT (datetime('now')),
      -- { "keys": [ids], "models": [ids] } that were enabled when ignored.
      restore_json TEXT NOT NULL DEFAULT '{"keys":[],"models":[]}',
      PRIMARY KEY (platform, model_id)
    );
  `);
}

export function down(db: Db): void {
  db.exec('DROP TABLE IF EXISTS catalogue_ignores');
}
