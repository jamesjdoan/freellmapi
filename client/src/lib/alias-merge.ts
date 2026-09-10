// Editing helpers for the model-detail alias merges (issue #790).
//
// The unify overrides store merges as `{ into, keys[] }` entries over the WHOLE
// catalog, while the model detail page only ever shows the entries pointing at
// the group it is rendering. Every edit therefore has to be expressed against
// the full list, not the visible slice — doing it by visible-row index deletes
// whatever unrelated entry happens to sit at that position. Pure functions so
// that mapping is unit-testable away from the page.

export interface AliasMerge {
  into: string
  keys: string[]
}

/** Same normalization the server applies to a merge target: case- and
 *  separator-insensitive, so "Llama 3.3 70B" and "llama-3.3-70b" are one group. */
export function normalizeInto(name: string): string {
  return name.trim().toLowerCase().replace(/[\s\-_]+/g, ' ')
}

/** Every alias currently merged into `label`, flattened across entries. */
export function aliasesFor(merges: AliasMerge[], label: string): string[] {
  const target = normalizeInto(label)
  return merges.filter(m => normalizeInto(m.into) === target).flatMap(m => m.keys)
}

/**
 * Add one alias to `label`'s merge entry, keeping the aliases already there.
 * The group's entries are collapsed into one; other groups are untouched. A
 * blank or duplicate alias is a no-op.
 */
export function addAlias(merges: AliasMerge[], label: string, alias: string): AliasMerge[] {
  const key = alias.trim()
  if (!key) return merges
  const target = normalizeInto(label)
  const mine = merges.filter(m => normalizeInto(m.into) === target)
  const others = merges.filter(m => normalizeInto(m.into) !== target)
  const keys = [...new Set([...mine.flatMap(m => m.keys), key])]
  return [...others, { into: label, keys }]
}

/**
 * Drop one alias from `label`'s merge entry, by value rather than by position.
 * An entry left with no keys is removed entirely (the schema requires at least
 * one), and other groups keep every alias they had.
 */
export function removeAlias(merges: AliasMerge[], label: string, alias: string): AliasMerge[] {
  const target = normalizeInto(label)
  return merges
    .map(m => (normalizeInto(m.into) === target ? { ...m, keys: m.keys.filter(k => k !== alias) } : m))
    .filter(m => m.keys.length > 0)
}

/** The shape of a rendered group this module needs: its grouping key and the
 *  `platform:modelId` identity of each row folded under it. */
export interface GroupIdentity {
  key: string
  members: readonly { platform: string; modelId: string }[]
}

/**
 * The merge entries that built this group.
 *
 * NOT matched on the group's label. The label is the representative member's
 * stripped display name, while `into` is whatever the operator merged toward,
 * and the two routinely differ: a real entry here stored
 * `into: "Nemotron 3 Super 120B"` while the group came out labelled
 * "Nemotron-3 Super", so a label match found nothing and the row offered no
 * undo for a merge that plainly existed.
 *
 * Matched on grouping identity instead: an entry owns this group when its
 * target normalises to the group's key, or when one of its keys is that key or
 * names one of its members. Everything else is another group's business and
 * MUST come back untouched — this list is the whole catalog's overrides.
 */
export function mergesForGroup(merges: readonly AliasMerge[], group: GroupIdentity): AliasMerge[] {
  const memberIds = new Set(group.members.map(m => `${m.platform}:${m.modelId}`))
  return merges.filter(m =>
    normalizeInto(m.into) === group.key
    || m.keys.some(k => k === group.key || normalizeInto(k) === group.key || memberIds.has(k)))
}

/** Every key folded into this group, across whichever entries built it. */
export function foldedKeys(merges: readonly AliasMerge[], group: GroupIdentity): string[] {
  return [...new Set(mergesForGroup(merges, group).flatMap(m => m.keys))]
}

/**
 * Take keys back out of this group: one named key, or every key it holds when
 * `alias` is blank. Entries emptied by the edit are dropped (the schema needs
 * at least one key); entries belonging to other groups are returned as-is.
 */
export function unmergeGroupKeys(merges: readonly AliasMerge[], group: GroupIdentity, alias: string): AliasMerge[] {
  const owning = new Set(mergesForGroup(merges, group))
  const drop = new Set(alias ? [alias] : [...owning].flatMap(m => m.keys))
  return merges
    .map(m => (owning.has(m) ? { ...m, keys: m.keys.filter(k => !drop.has(k)) } : m))
    .filter(m => m.keys.length > 0)
}
