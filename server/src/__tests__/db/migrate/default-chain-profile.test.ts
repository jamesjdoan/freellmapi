import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { up, down } from '../../../db/migrations/20261021_000001_default_chain_profile.js';

// Editing a chain must not move plain-auto traffic (#1409), so routing gets its
// own setting. The upgrade copies the value the install was ALREADY routing
// with, which is the whole safety argument for the split — and the reason `down`
// deletes the row instead of restoring anything.
function makeDb(): Database.Database {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);
  return db;
}

function setting(db: Database.Database, key: string): string | undefined {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined;
  return row?.value;
}

const dbs: Database.Database[] = [];
afterEach(() => {
  for (const db of dbs.splice(0)) db.close();
});

describe('default_chain_profile migration (#1409)', () => {
  it('copies the active chain into the routing default when absent', () => {
    const db = makeDb();
    dbs.push(db);
    db.prepare("INSERT INTO settings (key, value) VALUES ('active_profile_id', '4')").run();

    up(db);

    expect(setting(db, 'default_chain_profile_id')).toBe('4');
  });

  it('leaves an operator value alone', () => {
    const db = makeDb();
    dbs.push(db);
    db.prepare("INSERT INTO settings (key, value) VALUES ('active_profile_id', '4')").run();
    db.prepare("INSERT INTO settings (key, value) VALUES ('default_chain_profile_id', '7')").run();

    up(db);

    expect(setting(db, 'default_chain_profile_id')).toBe('7');
    expect(setting(db, 'active_profile_id')).toBe('4');
  });

  it('stays absent when no chain is active', () => {
    const db = makeDb();
    dbs.push(db);
    // An install that cleared its active chain routes over fallback_config, and
    // inventing a routing default here would move it.

    up(db);

    expect(setting(db, 'default_chain_profile_id')).toBeUndefined();
  });

  it('is idempotent, and round-trips through down()', () => {
    const db = makeDb();
    dbs.push(db);
    db.prepare("INSERT INTO settings (key, value) VALUES ('active_profile_id', '1')").run();

    up(db);
    up(db);
    expect(setting(db, 'default_chain_profile_id')).toBe('1');

    down(db);
    expect(setting(db, 'default_chain_profile_id')).toBeUndefined();

    up(db);
    expect(setting(db, 'default_chain_profile_id')).toBe('1');
  });
});
