import { getDb } from '../db/index.js';
import type { Db } from '../db/types.js';

// Manual grouping of catalogue rows that are the same underlying model.
//
// The catalogue lists one row per provider route, so `nemotron-3-ultra` appears
// four times under four names. Grouping condenses those into one entry and, as
// a side effect that matters more than the tidiness, lets members with no
// Artificial Analysis link of their own inherit the group's — which is the only
// honest way to score `ollama/nemotron-3-ultra`, a name the matcher rightly
// refuses to guess about.
//
// Named `model-groups-manual` because `model-groups.ts` already exists and does
// something else entirely: it is the router's fusion/alias machinery, which
// decides what a request for a unified id resolves to. This module never
// touches routing.

export interface GroupMemberRef {
  platform: string;
  modelId: string;
}

export interface ModelGroup {
  id: number;
  name: string;
  /** Pinned slug, or null to inherit from whichever member is linked. */
  aaSlug: string | null;
  members: GroupMemberRef[];
}

export function listGroups(db: Db = getDb()): ModelGroup[] {
  const groups = db.prepare('SELECT id, name, aa_slug FROM model_group ORDER BY name')
    .all() as { id: number; name: string; aa_slug: string | null }[];
  const members = db.prepare('SELECT group_id, platform, model_id FROM model_group_member')
    .all() as { group_id: number; platform: string; model_id: string }[];
  return groups.map(g => ({
    id: g.id,
    name: g.name,
    aaSlug: g.aa_slug,
    members: members
      .filter(m => m.group_id === g.id)
      .map(m => ({ platform: m.platform, modelId: m.model_id })),
  }));
}

/**
 * Create a group over the given rows.
 *
 * Members already in another group are MOVED, not rejected: merging is the
 * operation the operator is reaching for, and refusing because one row is
 * already grouped would mean unpicking the old group by hand first.
 */
export function createGroup(
  name: string,
  members: readonly GroupMemberRef[],
  aaSlug: string | null = null,
  db: Db = getDb(),
): number {
  const trimmed = name.trim();
  if (!trimmed) throw new Error('Group name is empty');
  if (members.length === 0) throw new Error('A group needs at least one model');

  let id = 0;
  db.transaction(() => {
    id = Number(db.prepare('INSERT INTO model_group (name, aa_slug) VALUES (?, ?)')
      .run(trimmed, aaSlug).lastInsertRowid);
    const add = db.prepare(`
      INSERT INTO model_group_member (group_id, platform, model_id) VALUES (?, ?, ?)
      ON CONFLICT(platform, model_id) DO UPDATE SET group_id = excluded.group_id
    `);
    for (const m of members) add.run(id, m.platform, m.modelId);
    dropEmptyGroups(db);
  })();
  return id;
}

export function renameGroup(id: number, name: string, db: Db = getDb()): void {
  const trimmed = name.trim();
  if (!trimmed) throw new Error('Group name is empty');
  db.prepare('UPDATE model_group SET name = ? WHERE id = ?').run(trimmed, id);
}

/** Pin the group to a slug, or hand it back to inheritance with null. */
export function setGroupSlug(id: number, aaSlug: string | null, db: Db = getDb()): void {
  db.prepare('UPDATE model_group SET aa_slug = ? WHERE id = ?').run(aaSlug, id);
}

export function addMembers(id: number, members: readonly GroupMemberRef[], db: Db = getDb()): void {
  const add = db.prepare(`
    INSERT INTO model_group_member (group_id, platform, model_id) VALUES (?, ?, ?)
    ON CONFLICT(platform, model_id) DO UPDATE SET group_id = excluded.group_id
  `);
  db.transaction(() => {
    for (const m of members) add.run(id, m.platform, m.modelId);
    dropEmptyGroups(db);
  })();
}

export function removeMember(member: GroupMemberRef, db: Db = getDb()): void {
  db.transaction(() => {
    db.prepare('DELETE FROM model_group_member WHERE platform = ? AND model_id = ?')
      .run(member.platform, member.modelId);
    dropEmptyGroups(db);
  })();
}

export function deleteGroup(id: number, db: Db = getDb()): void {
  // Members cascade; the rows return to standing on their own.
  db.prepare('DELETE FROM model_group WHERE id = ?').run(id);
}

/**
 * A group whose last member moved elsewhere is not a group. Left behind it
 * would show as an empty entry the operator cannot act on, so it goes.
 */
function dropEmptyGroups(db: Db): void {
  db.prepare(`
    DELETE FROM model_group
     WHERE NOT EXISTS (SELECT 1 FROM model_group_member m WHERE m.group_id = model_group.id)
  `).run();
}
