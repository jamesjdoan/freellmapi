import { describe, it, expect, beforeEach } from 'vitest';
import { initDb, getDb } from '../../db/index.js';
import {
  addMembers, createGroup, deleteGroup, listGroups, removeMember, setGroupSlug,
} from '../../services/model-groups-manual.js';
import { getGroupedCompare, relinkAll, setManualLink } from '../../services/analysis.js';

// One model appears once per provider route, under names that agree about
// nothing. Grouping condenses those into one entry — and lets a member the
// matcher rightly refused to guess about inherit the group's benchmark link.

const ULTRA_NV = { platform: 'nvidia', modelId: 'nvidia/nemotron-3-ultra-550b-a55b' };
const ULTRA_OR = { platform: 'openrouter', modelId: 'nvidia/nemotron-3-ultra-550b-a55b:free' };
const ULTRA_OLLAMA = { platform: 'ollama', modelId: 'nemotron-3-ultra' };

function addModel(platform: string, modelId: string, displayName: string) {
  getDb().prepare(`
    INSERT INTO models (platform, model_id, display_name, intelligence_rank, speed_rank, size_label,
                        monthly_token_budget, enabled)
    VALUES (?, ?, ?, 50, 50, 'Large', '', 1)
  `).run(platform, modelId, displayName);
}

function seedCatalogue() {
  addModel(ULTRA_NV.platform, ULTRA_NV.modelId, 'Nemotron-3 Ultra 550B (NV)');
  addModel(ULTRA_OR.platform, ULTRA_OR.modelId, 'Nemotron 3 Ultra 550B (free, slow)');
  addModel(ULTRA_OLLAMA.platform, ULTRA_OLLAMA.modelId, 'Nemotron 3 Ultra (Ollama)');
  getDb().prepare(`
    INSERT INTO aa_model (slug, name, intelligence_index, coding_index, agentic_index, index_version)
    VALUES ('nemotron-3-ultra-550b', 'Nemotron 3 Ultra 550B', 48.1, 44.2, 37.5, 'v4.3')
  `).run();
  relinkAll();
}

describe('model groups', () => {
  beforeEach(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
    const db = getDb();
    db.prepare('DELETE FROM profile_models').run();
    db.prepare('DELETE FROM fallback_config').run();
    db.prepare('DELETE FROM models').run();
    db.prepare('DELETE FROM aa_model').run();
    db.prepare('DELETE FROM aa_model_link').run();
    db.prepare('DELETE FROM model_group').run();
    seedCatalogue();
  });

  it('condenses the routes it groups into one entry, leaving the rest alone', () => {
    createGroup('Nemotron 3 Ultra', [ULTRA_NV, ULTRA_OR]);
    const groups = getGroupedCompare();
    const merged = groups.find(g => g.groupId !== null)!;
    expect(merged.members).toHaveLength(2);
    // The ungrouped Ollama row still stands on its own.
    expect(groups.filter(g => g.groupId === null)).toHaveLength(1);
  });

  it('gives an unmatched member the group\'s score', () => {
    // `nemotron-3-ultra` carries no parameter count, so the matcher refuses it
    // — correctly. Grouping is the operator supplying what it would not guess.
    expect(getGroupedCompare().find(g => g.name.includes('Ollama'))?.analysis).toBeNull();
    createGroup('Nemotron 3 Ultra', [ULTRA_NV, ULTRA_OLLAMA]);
    const merged = getGroupedCompare().find(g => g.groupId !== null)!;
    expect(merged.analysis?.intelligenceIndex).toBe(48.1);
    expect(merged.analysisSource).toBe('inherited');
  });

  it('says when a score was inherited rather than the model\'s own', () => {
    // A reader deciding on an unmatched member needs to know where the number
    // came from.
    const solo = getGroupedCompare().find(g => g.members[0].platform === 'nvidia')!;
    expect(solo.analysisSource).toBe('own');
  });

  it('flags a group whose members point at different slugs', () => {
    getDb().prepare(`
      INSERT INTO aa_model (slug, name, intelligence_index, index_version)
      VALUES ('kimi-k3', 'Kimi K3', 52.6, 'v4.3')
    `).run();
    setManualLink(ULTRA_OLLAMA.platform, ULTRA_OLLAMA.modelId, 'kimi-k3');
    createGroup('Mixed', [ULTRA_NV, ULTRA_OLLAMA]);
    // Still shows one score, but says the members disagree - picking one
    // silently would be a fabrication.
    expect(getGroupedCompare().find(g => g.groupId !== null)!.conflicted).toBe(true);
  });

  it('a pinned slug settles the conflict', () => {
    getDb().prepare(`
      INSERT INTO aa_model (slug, name, intelligence_index, index_version)
      VALUES ('kimi-k3', 'Kimi K3', 52.6, 'v4.3')
    `).run();
    setManualLink(ULTRA_OLLAMA.platform, ULTRA_OLLAMA.modelId, 'kimi-k3');
    const id = createGroup('Mixed', [ULTRA_NV, ULTRA_OLLAMA]);
    setGroupSlug(id, 'nemotron-3-ultra-550b');
    const merged = getGroupedCompare().find(g => g.groupId !== null)!;
    expect(merged.conflicted).toBe(false);
    expect(merged.analysisSource).toBe('pinned');
    expect(merged.analysis?.slug).toBe('nemotron-3-ultra-550b');
  });

  it('unions the chains its members serve', () => {
    const db = getDb();
    const p = db.prepare("INSERT INTO profiles (name, type) VALUES ('Apex', 'custom') RETURNING id").get() as { id: number };
    const q = db.prepare("INSERT INTO profiles (name, type) VALUES ('Frontier', 'custom') RETURNING id").get() as { id: number };
    const nv = db.prepare('SELECT id FROM models WHERE platform = ?').get('nvidia') as { id: number };
    const or = db.prepare('SELECT id FROM models WHERE platform = ?').get('openrouter') as { id: number };
    db.prepare('INSERT INTO profile_models (profile_id, model_db_id, priority, enabled) VALUES (?, ?, 1, 1)').run(p.id, nv.id);
    db.prepare('INSERT INTO profile_models (profile_id, model_db_id, priority, enabled) VALUES (?, ?, 1, 1)').run(q.id, or.id);
    createGroup('Nemotron 3 Ultra', [ULTRA_NV, ULTRA_OR]);
    expect(getGroupedCompare().find(g => g.groupId !== null)!.chains.sort()).toEqual(['Apex', 'Frontier']);
  });

  it('moves a model between groups rather than refusing the merge', () => {
    // Merging is what the operator is reaching for; refusing because a row is
    // already grouped would mean unpicking the old group by hand first.
    const first = createGroup('First', [ULTRA_NV, ULTRA_OR]);
    createGroup('Second', [ULTRA_NV]);
    const groups = listGroups();
    expect(groups.find(g => g.name === 'Second')!.members).toEqual([ULTRA_NV]);
    expect(groups.find(g => g.id === first)!.members).toEqual([ULTRA_OR]);
  });

  it('drops a group whose last member left', () => {
    // An empty group renders as an entry with nothing in it and no way to act.
    const id = createGroup('Solo', [ULTRA_NV]);
    removeMember(ULTRA_NV);
    expect(listGroups().find(g => g.id === id)).toBeUndefined();
  });

  it('returns its members to standing alone when deleted', () => {
    const id = createGroup('Nemotron 3 Ultra', [ULTRA_NV, ULTRA_OR]);
    deleteGroup(id);
    expect(getGroupedCompare().every(g => g.groupId === null)).toBe(true);
    expect(getGroupedCompare()).toHaveLength(3);
  });

  it('survives a member the catalogue no longer lists', () => {
    // Membership is keyed on (platform, model_id) so a sync that reinserts a
    // row keeps the grouping - but a genuinely removed model must not break
    // the read path.
    createGroup('Nemotron 3 Ultra', [ULTRA_NV, ULTRA_OR]);
    getDb().prepare('DELETE FROM models WHERE platform = ?').run('openrouter');
    const merged = getGroupedCompare().find(g => g.groupId !== null)!;
    expect(merged.members).toHaveLength(1);
  });

  it('refuses a group with no members or no name', () => {
    expect(() => createGroup('', [ULTRA_NV])).toThrow();
    expect(() => createGroup('Empty', [])).toThrow();
  });

  it('adds members to an existing group', () => {
    const id = createGroup('Nemotron 3 Ultra', [ULTRA_NV]);
    addMembers(id, [ULTRA_OR, ULTRA_OLLAMA]);
    expect(listGroups().find(g => g.id === id)!.members).toHaveLength(3);
  });
});

describe('removing one route from a group', () => {
  beforeEach(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
    const db = getDb();
    db.prepare('DELETE FROM profile_models').run();
    db.prepare('DELETE FROM fallback_config').run();
    db.prepare('DELETE FROM models').run();
    db.prepare('DELETE FROM aa_model').run();
    db.prepare('DELETE FROM aa_model_link').run();
    db.prepare('DELETE FROM model_group').run();
    seedCatalogue();
  });

  it('returns that route to standing alone and leaves the rest merged', () => {
    // Correcting one wrong member must not cost the grouping of the others.
    const id = createGroup('Nemotron 3 Ultra', [ULTRA_NV, ULTRA_OR, ULTRA_OLLAMA]);
    removeMember(ULTRA_OLLAMA);
    const groups = getGroupedCompare();
    expect(groups.find(g => g.groupId === id)!.members).toHaveLength(2);
    const solo = groups.find(g => g.groupId === null && g.members[0].platform === 'ollama');
    expect(solo).toBeDefined();
    // And it loses the inherited score, because it no longer has a group to
    // inherit from - showing it would be the fabrication this guards against.
    expect(solo!.analysis).toBeNull();
  });

  it('dissolves the group when the second-to-last route leaves', () => {
    // One route is not a merge; leaving a one-member group would show a
    // "1 routes" entry with an unmerge control and nothing to unmerge.
    const id = createGroup('Pair', [ULTRA_NV, ULTRA_OR]);
    removeMember(ULTRA_OR);
    expect(listGroups().find(g => g.id === id)!.members).toHaveLength(1);
    removeMember(ULTRA_NV);
    expect(listGroups()).toHaveLength(0);
    expect(getGroupedCompare().every(g => g.groupId === null)).toBe(true);
  });

  it('ignores a route that is not in any group', () => {
    createGroup('Pair', [ULTRA_NV, ULTRA_OR]);
    expect(() => removeMember(ULTRA_OLLAMA)).not.toThrow();
    expect(listGroups()[0].members).toHaveLength(2);
  });
});
