// Migration: clifree fleet route mappings move into aa_model_link.
// Created: 2026-10-12
//
// The fleet panel stored its remaps as one JSON document in settings
// (`clifree_fleet_links`, spec -> slug), with no closest-match option. The Keys
// page stores the same kind of decision in aa_model_link, with proxy support
// and per-metric nudges, and clifree-rank reads aa_model_link. Two stores meant
// a remap on the panel never reached delegation, and on the day this shipped
// they disagreed about space-bunny-free: the panel said "no counterpart", the
// link table said a glm-5-3-flash proxy.
//
// Each settings entry becomes a `manual` row under platform `opencode` or
// `cline` (a null slug stays null: "no counterpart" is a decision). Where a
// `manual` or `proxy` row already exists for that route, it wins: it is the
// newer decision, and the settings map could not express a proxy at all. An
// `auto` row is an automatic match, not a decision, and is replaced.
//
// DOWN: rebuilds the settings document from every opencode/cline manual or
// proxy row. A proxy comes back as a plain slug, because the old document had
// no way to say "closest match"; the nudges are not carried back either.

import type { Db } from '../types.js';

const LINKS_KEY = 'clifree_fleet_links';
const PROVIDERS = ['opencode', 'cline'];

/** Moves rows, never schema: on a database with no fleet links, both
 *  directions are correctly no-ops. See the roundtrip harness. */
export const dataOnly = true;

function readLegacy(db: Db): Record<string, unknown> {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(LINKS_KEY) as { value: string } | undefined;
  if (!row) return {};
  try {
    const parsed: unknown = JSON.parse(row.value);
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? { ...parsed } : {};
  } catch {
    return {};
  }
}

export function up(db: Db): void {
  const legacy = readLegacy(db);
  const existing = db.prepare('SELECT source FROM aa_model_link WHERE platform = ? AND model_id = ?');
  const write = db.prepare(`
    INSERT INTO aa_model_link (platform, model_id, aa_slug, source, match_reason)
    VALUES (?, ?, ?, 'manual', NULL)
    ON CONFLICT(platform, model_id) DO UPDATE SET aa_slug = excluded.aa_slug, source = 'manual', match_reason = NULL
  `);
  for (const [spec, slug] of Object.entries(legacy)) {
    const at = spec.indexOf(':');
    const provider = spec.slice(0, at);
    if (at < 1 || !PROVIDERS.includes(provider)) continue;
    if (slug !== null && typeof slug !== 'string') continue;
    const current = existing.get(provider, spec.slice(at + 1)) as { source: string } | undefined;
    if (current && current.source !== 'auto') continue;
    write.run(provider, spec.slice(at + 1), slug);
  }
  db.prepare('DELETE FROM settings WHERE key = ?').run(LINKS_KEY);
}

export function down(db: Db): void {
  const rows = db.prepare(`
    SELECT platform, model_id, aa_slug FROM aa_model_link
     WHERE platform IN (?, ?) AND source IN ('manual', 'proxy')
  `).all(...PROVIDERS) as { platform: string; model_id: string; aa_slug: string | null }[];
  if (rows.length === 0) return;
  const doc: Record<string, string | null> = {};
  for (const r of rows) doc[`${r.platform}:${r.model_id}`] = r.aa_slug;
  db.prepare(`INSERT INTO settings (key, value) VALUES (?, ?)
              ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(LINKS_KEY, JSON.stringify(doc));
}