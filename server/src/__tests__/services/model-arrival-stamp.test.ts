import { describe, it, expect, beforeEach } from 'vitest';
import { initDb, getDb } from '../../db/index.js';

// Every path that inserts a `models` row must stamp `first_seen_at`, because
// the Keys page churn chip and the chain page's changes panel both report
// arrivals from that column alone. A row inserted without it is invisible to
// both — which is the exact failure the feature exists to prevent, and it
// happened: the stamp shipped on catalog-sync only, so a model registered
// through a custom endpoint or declarative config never showed up as new.
//
// Asserted against the SQL rather than by driving each service, because the
// point is coverage of the write sites: a fifth insert path added later fails
// here whether or not anyone thinks to test its behaviour.

const INSERT_SITES = [
  'services/catalog-sync.ts',
  'services/custom-model-register.ts',
  'services/declarative-config.ts',
];

describe('models.first_seen_at', () => {
  beforeEach(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
  });

  it('is a column the catalogue carries', () => {
    const columns = (getDb().prepare('PRAGMA table_info(models)').all() as { name: string }[])
      .map(c => c.name);
    expect(columns).toContain('first_seen_at');
  });

  it('defaults to NULL rather than to the migration date', async () => {
    // A backfilled `now` would date every pre-existing model to the moment the
    // column landed and read exactly like a measurement. NULL means "was here
    // before we started counting", which is the truth and is reported as a
    // count instead of as an arrival.
    const db = getDb();
    db.prepare(`
      INSERT INTO models (platform, model_id, display_name, intelligence_rank, speed_rank, size_label,
                          monthly_token_budget, enabled)
      VALUES ('groq', 'unstamped', 'Unstamped', 50, 50, 'Medium', '', 1)
    `).run();
    const row = db.prepare('SELECT first_seen_at FROM models WHERE model_id = ?').get('unstamped') as { first_seen_at: string | null };
    expect(row.first_seen_at).toBeNull();
  });

  it('is written by every service that inserts a model', async () => {
    const { readFile } = await import('node:fs/promises');
    const { fileURLToPath } = await import('node:url');
    const { dirname, join } = await import('node:path');
    const srcDir = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

    const missing: string[] = [];
    for (const site of INSERT_SITES) {
      const source = await readFile(join(srcDir, site), 'utf8');
      // Each INSERT INTO models statement in the file must name the column.
      const statements = source.split(/INSERT INTO models/).slice(1);
      expect(statements.length).toBeGreaterThan(0);
      statements.forEach((statement, i) => {
        const valuesAt = statement.indexOf('VALUES');
        // The column list ends at the first `VALUES`; the row of values runs to
        // the end of the statement (ON CONFLICT, where present, follows it).
        const columns = statement.slice(0, valuesAt);
        const values = statement.slice(valuesAt, statement.indexOf('`', valuesAt));
        // Naming the column is not enough: a first cut of this test passed
        // while one site bound NULL into it. The stamp has to be written.
        if (!columns.includes('first_seen_at')) missing.push(`${site} statement ${i + 1}: column not listed`);
        else if (!values.includes("datetime('now')")) missing.push(`${site} statement ${i + 1}: no datetime('now') bound`);
      });
    }
    expect(missing).toEqual([]);
  });
});
