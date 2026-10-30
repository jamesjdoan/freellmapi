import { beforeEach, expect, it } from 'vitest';
import { getDb, initDb } from '../../db/index.js';
import { up, down } from '../../db/migrations/20261030_000001_aa_v2_capabilities_and_score_archive.js';

// The deploy-time half of ADR ARCH-20261030: before any v2 sync can run, every
// score AA has published is copied into the archive and the scale the chain
// minimums were set on is pinned.

beforeEach(() => {
  process.env.ENCRYPTION_KEY = '0'.repeat(64);
  initDb(':memory:');
  const db = getDb();
  db.prepare('DELETE FROM aa_score_archive').run();
  db.prepare("DELETE FROM settings WHERE key = 'aa_scoring_version'").run();
});

const measure = (slug: string, version: string, at: string, intelligence: number | null, coding: number | null) => getDb().prepare(`
  INSERT INTO aa_measurement (slug, index_version, fetched_at, intelligence_index, coding_index) VALUES (?, ?, ?, ?, ?)
`).run(slug, version, at, intelligence, coding);
const archived = (slug: string, metric: string, version: string) => getDb().prepare(
  'SELECT value, measured_at FROM aa_score_archive WHERE slug = ? AND metric = ? AND index_version = ?',
).get(slug, metric, version);
const pinned = () => (getDb().prepare("SELECT value FROM settings WHERE key = 'aa_scoring_version'").get() as { value: string } | undefined)?.value;

it('archives the newest published value per version, keeps a retired one, and pins the widest version', () => {
  measure('alpha', 'v4.3', '2026-09-25 03:52:28', 48, 44);
  measure('alpha', 'v4.3', '2026-10-26 09:53:02', 50, null); // coding withdrawn later
  measure('beta', 'v4.3', '2026-10-26 09:53:02', 30, 20);
  measure('alpha', 'v5.0', '2026-10-30 00:00:00', 37, null);
  // The mirror is newer than history: an old sync against a newer image.
  getDb().prepare(`
    INSERT INTO aa_model (slug, name, intelligence_index, coding_index, index_version, fetched_at)
    VALUES ('gamma', 'gamma', 21, 9, 'v4.3', '2026-10-26 09:53:02')
  `).run();

  up(getDb());

  expect(archived('alpha', 'intelligence', 'v4.3')).toEqual({ value: 50, measured_at: '2026-10-26 09:53:02' });
  // Last value AA published for alpha's coding, even though a later sync had none.
  expect(archived('alpha', 'coding', 'v4.3')).toEqual({ value: 44, measured_at: '2026-09-25 03:52:28' });
  expect(archived('alpha', 'intelligence', 'v5.0')).toEqual({ value: 37, measured_at: '2026-10-30 00:00:00' });
  expect(archived('gamma', 'coding', 'v4.3')).toEqual({ value: 9, measured_at: '2026-10-26 09:53:02' });
  expect(archived('alpha', 'agentic', 'v4.3')).toBeUndefined();
  // v4.3 holds three intelligence scores, v5.0 one: rankings stay on v4.3.
  expect(pinned()).toBe('v4.3');
});

it('leaves an operator pin alone, pins nothing on an empty install, and is safe to run twice', () => {
  up(getDb());
  expect(pinned()).toBeUndefined();

  getDb().prepare("INSERT INTO settings (key, value) VALUES ('aa_scoring_version', 'v5.0')").run();
  measure('alpha', 'v4.3', '2026-10-26 09:53:02', 50, 44);
  up(getDb());
  up(getDb());
  expect(pinned()).toBe('v5.0');
  expect(archived('alpha', 'coding', 'v4.3')).toEqual({ value: 44, measured_at: '2026-10-26 09:53:02' });
});

it('rolls back to the pre-v2 schema without touching mirror or history rows', () => {
  measure('alpha', 'v4.3', '2026-10-26 09:53:02', 50, 44);
  down(getDb());
  const columns = (getDb().prepare('PRAGMA table_info(aa_model)').all() as { name: string }[]).map(c => c.name);
  expect(columns).not.toContain('legal_index');
  expect(columns).not.toContain('median_time_to_first_answer_token_seconds');
  expect(getDb().prepare("SELECT name FROM sqlite_master WHERE name = 'aa_score_archive'").get()).toBeUndefined();
  expect(getDb().prepare('SELECT intelligence_index FROM aa_measurement').get()).toEqual({ intelligence_index: 50 });
});
