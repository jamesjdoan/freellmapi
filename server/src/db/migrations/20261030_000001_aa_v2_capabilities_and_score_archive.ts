// Migration: Artificial Analysis v2 fields, and an archive that keeps every
// index score AA has stopped publishing.
//
// Created: 2026-10-30 (ADR ARCH-20261030-aa-score-archive-and-scoring-version)
//
// WHY
//
// On 2026-10-29 AA's /language/models/free moved the Intelligence Index from
// v4.3 to v5.0 and stopped publishing the Coding and Agentic indices (both
// documented "always null"). Measured on the live key that day: of 718
// models, v5.0 scores 80 for intelligence where the v4.3 cache held 698; 0 for
// coding (was 258) and 0 for agentic (was 167). For the 80 models scored on
// both versions the median v5/v4.3 ratio was 0.74, so the scales differ and
// cannot be ranked together.
//
// aa_model is a mirror that each sync overwrites in place, so the next sync
// would erase those scores. Every chain minimum (imperium_chain_minimums) is
// set in v4.3 units, and the hourly chain arranger orders Apex by
// intelligence and Coding by coding. aa_measurement does keep history, but has
// no reader.
//
// WHAT
//
// aa_score_archive holds the last non-null value AA published for each
// (slug, metric, index_version). It is append-or-replace per key and is never
// pruned. It is seeded here from aa_measurement and aa_model. Sync then keeps
// it current (services/analysis.ts). Scores are read from it:
//   - intelligence and index_cost_per_task: under the scoring version the
//     operator has pinned (`aa_scoring_version`). Both depend on the index
//     version, since cost per task is the cost of that version's workload.
//   - coding and agentic: the last value AA published, labelled as archived.
//
// `aa_scoring_version` is pinned to whichever version holds the most archived
// intelligence scores, so a deploy changes no ranking. An install that has
// never synced gets no pin, and its first sync sets one.
//
// aa_model and aa_measurement also gain the v2 fields we now read: time to
// first ANSWER token (the legacy API's `median_time_to_first_answer_token`,
// renamed, so not a new capability), the six capability indices, the
// prompt basis of the performance medians, and the response shape. Shape
// records how rich the response was; that is separate from the account tier.
//
// DOWN: reversible. Drops the archive and the added columns and clears the
// pin. aa_model and aa_measurement keep every row they had before.

import type { Db } from '../types.js';

const NEW_COLUMNS: readonly [string, string][] = [
  ['median_time_to_first_answer_token_seconds', 'REAL'],
  ['finance_index', 'REAL'],
  ['strategy_ops_index', 'REAL'],
  ['legal_index', 'REAL'],
  ['healthcare_index', 'REAL'],
  ['engineering_index', 'REAL'],
  ['economics_index', 'REAL'],
  // 'medium' | 'long' | ... as AA names it; NULL where the endpoint does not
  // state one. /language/models/free does not.
  ['prompt_type', 'TEXT'],
  // 'free' | 'pro': the response shape, which is not the same as the tier.
  ['response_shape', 'TEXT'],
];

function columnsOf(db: Db, table: string): Set<string> {
  return new Set((db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map(c => c.name));
}

export function up(db: Db): void {
  for (const table of ['aa_model', 'aa_measurement']) {
    const have = columnsOf(db, table);
    for (const [name, type] of NEW_COLUMNS) {
      if (!have.has(name)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${type}`);
    }
  }

  db.exec(`
    CREATE TABLE IF NOT EXISTS aa_score_archive (
      slug TEXT NOT NULL,
      metric TEXT NOT NULL CHECK (metric IN ('intelligence', 'coding', 'agentic', 'index_cost_per_task')),
      index_version TEXT NOT NULL,
      value REAL NOT NULL,
      -- fetched_at of the sync that last published this value.
      measured_at TEXT NOT NULL,
      PRIMARY KEY (slug, metric, index_version)
    );
  `);

  // Seed: the newest non-null value for each (slug, metric, version), taken
  // from history first and then from the live mirror, so the mirror's newer
  // value overwrites an older one from history.
  const metrics: [string, string][] = [
    ['intelligence', 'intelligence_index'],
    ['coding', 'coding_index'],
    ['agentic', 'agentic_index'],
    ['index_cost_per_task', 'index_cost_per_task'],
  ];
  const upsert = (source: string, metric: string, column: string) => db.exec(`
    INSERT INTO aa_score_archive (slug, metric, index_version, value, measured_at)
    SELECT slug, '${metric}', index_version, ${column}, fetched_at
      FROM ${source} s
     WHERE ${column} IS NOT NULL AND index_version IS NOT NULL
       AND fetched_at = (SELECT MAX(fetched_at) FROM ${source} t
                          WHERE t.slug = s.slug AND t.index_version = s.index_version
                            AND t.${column} IS NOT NULL)
    ON CONFLICT(slug, metric, index_version) DO UPDATE SET
      value = excluded.value, measured_at = excluded.measured_at
    WHERE excluded.measured_at >= aa_score_archive.measured_at
  `);
  for (const [metric, column] of metrics) {
    upsert('aa_measurement', metric, column);
    upsert('aa_model', metric, column);
  }

  const pinned = db.prepare("SELECT 1 FROM settings WHERE key = 'aa_scoring_version'").get();
  if (!pinned) {
    const widest = db.prepare(`
      SELECT index_version FROM aa_score_archive WHERE metric = 'intelligence'
       GROUP BY index_version ORDER BY COUNT(*) DESC, MAX(measured_at) DESC LIMIT 1
    `).get() as { index_version: string } | undefined;
    if (widest) {
      db.prepare("INSERT INTO settings (key, value) VALUES ('aa_scoring_version', ?)").run(widest.index_version);
    }
  }
}

export function down(db: Db): void {
  db.exec('DROP TABLE IF EXISTS aa_score_archive;');
  db.prepare("DELETE FROM settings WHERE key IN ('aa_scoring_version', 'aa_snapshot_version', 'aa_response_shape', 'aa_prompt_type', 'aa_last_attempt_ms', 'aa_next_allowed_ms', 'aa_total_pages')").run();
  for (const table of ['aa_model', 'aa_measurement']) {
    const have = columnsOf(db, table);
    for (const [name] of NEW_COLUMNS) {
      if (have.has(name)) db.exec(`ALTER TABLE ${table} DROP COLUMN ${name}`);
    }
  }
}
