// Migration: seed the plain-auto routing chain (default_chain_profile_id)
// Created: 2026-10-21
//
// DOWN: reversible
//
// `active_profile_id` used to mean two things at once: the chain the dashboard
// shows and edits, and the chain a plain `auto` request routes through. An
// operator who only wanted to LOOK at another chain silently moved all
// plain-auto traffic to it. The split gives routing its own setting,
// `default_chain_profile_id`, while `active_profile_id` keeps only the
// "chain being edited/viewed" meaning.
//
// The default is decided once, here, from what the database already looks like:
//
//   - active_profile_id present -> copy that value, so the upgrade changes
//     nothing: the chain that routed yesterday routes today.
//   - active_profile_id absent  -> leave the new setting absent too. The
//     router then keeps its legacy behaviour (the global fallback_config
//     table), exactly as it did while the setting was missing.
//
// An operator's own value always wins: if the row already exists it is left
// alone.

import type { Db } from '../types.js';

const SETTING_KEY = 'default_chain_profile_id';
const SOURCE_KEY = 'active_profile_id';

export function up(db: Db): void {
  const existing = db.prepare('SELECT value FROM settings WHERE key = ?').get(SETTING_KEY);
  if (existing) return;

  const source = db.prepare('SELECT value FROM settings WHERE key = ?').get(SOURCE_KEY) as
    | { value: string }
    | undefined;
  if (!source) return;

  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run(SETTING_KEY, source.value);
}

export function down(db: Db): void {
  db.prepare('DELETE FROM settings WHERE key = ?').run(SETTING_KEY);
}
