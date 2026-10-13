// Migration: append-only log of catalog sync applications
// Created: 2026-10-13
//
// DOWN: reversible - drops the table.
//
// `catalogue_event` records one row per MODEL that arrived, retired, was
// removed or relisted. Nothing records the SYNC itself: which document was
// applied, when, from which tier, and — the question this table exists for —
// what actually changed from the previously applied document to this one.
//
// `syncCatalog`'s own counts cannot answer it. `counts.updated` increments for
// every row the document still lists, whether or not anything about it moved,
// and a provider quietly tightening a quota or a context window on an
// existing model leaves no event at all: the row survives, updated in place.
//
// The diff is computed document-against-document (the previous
// `catalog_applied_json` vs the newly applied one), so it reports the FEED's
// changes verbatim — including ones a local disable or override masked in the
// DB. The DB-side counts are stored alongside as what the database actually
// did.
//
// One baseline row is backfilled when the install already has an applied
// catalog: the log starts here, with nothing diffed yet. Like catalogue_event,
// rows are written once and never updated, and nothing here is load-bearing
// for routing.

import type { Db } from '../types.js';

export function up(db: Db): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS catalogue_sync (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      at TEXT NOT NULL DEFAULT (datetime('now')),
      -- The document version this sync applied, e.g. 2026.10.12.daddd7e6.
      version TEXT NOT NULL,
      -- The version the PREVIOUS sync had applied; NULL = the log started
      -- here (baseline row, or a genuine first sync).
      previous_version TEXT,
      -- live | monthly
      tier TEXT NOT NULL,
      -- The document's own generatedAt, verbatim from the feed.
      generated_at TEXT,
      -- What the database actually did (applyCatalog's counts).
      updated INTEGER NOT NULL DEFAULT 0,
      inserted INTEGER NOT NULL DEFAULT 0,
      removed INTEGER NOT NULL DEFAULT 0,
      skipped_unknown_platform INTEGER NOT NULL DEFAULT 0,
      quirks INTEGER NOT NULL DEFAULT 0,
      -- What the document actually changed vs the previous document,
      -- summed across every registry (chat, media, stt, video, embedding).
      doc_added INTEGER NOT NULL DEFAULT 0,
      doc_removed INTEGER NOT NULL DEFAULT 0,
      doc_changed INTEGER NOT NULL DEFAULT 0,
      -- Per-platform doc churn: { "<platform>": {a, r, c} }.
      by_platform_json TEXT,
      -- Capped field-level diff rows:
      -- [{ r: registry, p: platform, m: modelId, f: field, o: old, n: new }].
      details_json TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_catalogue_sync_at ON catalogue_sync(at DESC, id DESC);
    CREATE INDEX IF NOT EXISTS idx_catalogue_sync_version ON catalogue_sync(version);
  `);

  // Baseline for installs that already run a catalog: mark where the log
  // started rather than leaving the first real diff to look like the whole
  // story. Genuine first syncs write their own row later, with the same
  // previous_version = NULL but non-zero doc_added.
  const appliedVersion = db.prepare(
    "SELECT value FROM settings WHERE key = 'catalog_applied_version'",
  ).get() as { value: string } | undefined;
  if (appliedVersion?.value) {
    const tier = (db.prepare(
      "SELECT value FROM settings WHERE key = 'catalog_applied_tier'",
    ).get() as { value: string } | undefined)?.value ?? 'monthly';
    const doc = db.prepare(
      "SELECT value FROM settings WHERE key = 'catalog_applied_json'",
    ).get() as { value: string } | undefined;
    let generatedAt: string | null = null;
    if (doc?.value) {
      try {
        const parsed: unknown = JSON.parse(doc.value);
        if (parsed && typeof parsed === 'object' && 'generatedAt' in parsed
          && typeof parsed.generatedAt === 'string') {
          generatedAt = parsed.generatedAt;
        }
      } catch {
        // The cached document is opaque here; the baseline row only needs the
        // version. A malformed cache is sync's problem, not the log's.
      }
    }
    db.prepare(`
      INSERT INTO catalogue_sync (version, previous_version, tier, generated_at)
      VALUES (?, NULL, ?, ?)
    `).run(appliedVersion.value, tier, generatedAt);
    console.log(`[catalogue-sync-log] baseline row recorded at v${appliedVersion.value}`);
  }
}

export function down(db: Db): void {
  db.exec(`
    DROP INDEX IF EXISTS idx_catalogue_sync_version;
    DROP INDEX IF EXISTS idx_catalogue_sync_at;
    DROP TABLE IF EXISTS catalogue_sync;
  `);
}
