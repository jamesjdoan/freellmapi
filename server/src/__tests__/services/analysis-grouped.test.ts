import { describe, it, expect, beforeEach } from 'vitest';
import { initDb, getDb } from '../../db/index.js';
import {
  getGroupedCompare,
  getReferenceGroups,
  getReferenceSlugs,
  relinkAll,
  setManualLink,
  setReferenceSlugs,
  setModelKeyScope,
} from '../../services/analysis.js';
import { setUnifyOverrides } from '../../services/model-groups.js';

// Compare mirrors the ROUTER's grouping — the unification that decides which
// providers one logical model fails over across. It deliberately keeps no
// grouping of its own: two would drift, and a comparison describing models that
// do not route the way it says is worse than no comparison.

function addModel(platform: string, modelId: string, displayName: string) {
  getDb().prepare(`
    INSERT INTO models (platform, model_id, display_name, intelligence_rank, speed_rank, size_label,
                        monthly_token_budget, enabled)
    VALUES (?, ?, ?, 50, 50, 'Large', '', 1)
  `).run(platform, modelId, displayName);
}

function addAa(slug: string, name: string, score: number | null) {
  getDb().prepare(`
    INSERT INTO aa_model (slug, name, intelligence_index, coding_index, agentic_index, index_version)
    VALUES (?, ?, ?, ?, ?, 'v4.3')
  `).run(slug, name, score, score, score);
}

const find = (name: RegExp) => getGroupedCompare().find(g => name.test(g.name));

describe('grouped compare', () => {
  beforeEach(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
    const db = getDb();
    db.prepare('DELETE FROM profile_models').run();
    db.prepare('DELETE FROM fallback_config').run();
    db.prepare('DELETE FROM models').run();
    db.prepare('DELETE FROM aa_model').run();
    db.prepare('DELETE FROM aa_model_link').run();
    setUnifyOverrides({ merges: [], splits: [] });
  });

  it('condenses the providers the router already unifies', () => {
    // Same display name on two providers is one logical model to the router,
    // so it must be one row here without anyone merging anything.
    addModel('groq', 'openai/gpt-oss-120b', 'GPT-OSS 120B (Groq)');
    addModel('nvidia', 'openai/gpt-oss-120b', 'GPT-OSS 120B (NV)');
    addAa('gpt-oss-120b', 'gpt-oss-120b', 12.3);
    relinkAll();

    const entry = find(/GPT-OSS 120B/)!;
    expect(entry.members).toHaveLength(2);
    expect(entry.analysis?.intelligenceIndex).toBe(12.3);
    expect(entry.userDefined).toBe(false);
  });

  it('follows an operator merge, and says the group was operator-made', () => {
    // The merge is written on the Models page as a unify override; Compare
    // must show what that override produced, not what the names alone would.
    addModel('nvidia', 'nvidia/nemotron-3-ultra-550b-a55b', 'Nemotron-3 Ultra 550B (NV)');
    addModel('ollama', 'nemotron-3-ultra', 'Nemotron 3 Ultra (Ollama)');
    expect(find(/Nemotron 3 Ultra \(/)).toBeUndefined(); // stripped of its suffix
    expect(getGroupedCompare().filter(g => /Nemotron/.test(g.name))).toHaveLength(2);

    setUnifyOverrides({
      merges: [{ into: 'Nemotron-3 Ultra 550B', keys: ['nemotron 3 ultra'] }],
      splits: [],
    });

    const merged = getGroupedCompare().filter(g => /Nemotron/.test(g.name));
    expect(merged).toHaveLength(1);
    expect(merged[0].members).toHaveLength(2);
    expect(merged[0].userDefined).toBe(true);
  });

  it('gives a merged sibling the score, and marks it inherited', () => {
    // The Ollama name carries no parameter count, so the matcher refuses it —
    // correctly. The merge is what supplies the answer, and the row has to say
    // the number is not that route's own measurement.
    addModel('nvidia', 'nvidia/nemotron-3-ultra-550b-a55b', 'Nemotron-3 Ultra 550B (NV)');
    addModel('ollama', 'nemotron-3-ultra', 'Nemotron 3 Ultra (Ollama)');
    addAa('nemotron-3-ultra-550b', 'Nemotron 3 Ultra 550B', 48.1);
    relinkAll();
    expect(find(/Nemotron 3 Ultra$/)?.analysis).toBeNull();

    setUnifyOverrides({
      merges: [{ into: 'Nemotron-3 Ultra 550B', keys: ['nemotron 3 ultra'] }],
      splits: [],
    });
    const merged = getGroupedCompare().find(g => /Nemotron/.test(g.name))!;
    expect(merged.analysis?.intelligenceIndex).toBe(48.1);
    expect(merged.analysisSource).toBe('inherited');
  });

  it('calls a single model its own source, not inherited', () => {
    addModel('groq', 'openai/gpt-oss-20b', 'GPT-OSS 20B (Groq)');
    addAa('gpt-oss-20b', 'gpt-oss-20b', 9);
    relinkAll();
    expect(find(/GPT-OSS 20B/)!.analysisSource).toBe('own');
  });

  it('flags a merge whose members map to different benchmarks', () => {
    // Still shows one score, but silently picking one of two would be a
    // fabrication dressed as a measurement.
    addModel('nvidia', 'nvidia/nemotron-3-ultra-550b-a55b', 'Nemotron-3 Ultra 550B (NV)');
    addModel('ollama', 'nemotron-3-ultra', 'Nemotron 3 Ultra (Ollama)');
    addAa('nemotron-3-ultra-550b', 'Nemotron 3 Ultra 550B', 48.1);
    addAa('kimi-k3', 'Kimi K3', 52.6);
    relinkAll();
    setManualLink('ollama', 'nemotron-3-ultra', 'kimi-k3');
    setUnifyOverrides({
      merges: [{ into: 'Nemotron-3 Ultra 550B', keys: ['nemotron 3 ultra'] }],
      splits: [],
    });
    expect(getGroupedCompare().find(g => /Nemotron/.test(g.name))!.conflicted).toBe(true);
  });

  it('unions the chains its providers serve', () => {
    // A merged model is available wherever any of its routes is.
    const db = getDb();
    addModel('groq', 'openai/gpt-oss-120b', 'GPT-OSS 120B (Groq)');
    addModel('nvidia', 'openai/gpt-oss-120b', 'GPT-OSS 120B (NV)');
    const p = db.prepare("INSERT INTO profiles (name, type) VALUES ('Apex', 'custom') RETURNING id").get() as { id: number };
    const q = db.prepare("INSERT INTO profiles (name, type) VALUES ('Coding', 'custom') RETURNING id").get() as { id: number };
    const rows = db.prepare('SELECT id, platform FROM models').all() as { id: number; platform: string }[];
    for (const [i, r] of rows.entries()) {
      db.prepare('INSERT INTO profile_models (profile_id, model_db_id, priority, enabled) VALUES (?, ?, 1, 1)')
        .run(i === 0 ? p.id : q.id, r.id);
    }
    expect(find(/GPT-OSS 120B/)!.chains.sort()).toEqual(['Apex', 'Coding']);
  });

  it('drops an entry whose rows the catalogue no longer has', () => {
    // getModelGroups reads the catalogue directly; an entry with no surviving
    // member would render as a blank row.
    addModel('groq', 'openai/gpt-oss-120b', 'GPT-OSS 120B (Groq)');
    expect(getGroupedCompare()).toHaveLength(1);
    getDb().prepare('DELETE FROM models').run();
    expect(getGroupedCompare()).toHaveLength(0);
  });
});

describe('reference baselines', () => {
  beforeEach(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
    addAa('kimi-k3', 'Kimi K3', 44);
  });

  it('shapes a pinned slug as an entry with no supply behind it', () => {
    setReferenceSlugs(['kimi-k3']);
    const [ref] = getReferenceGroups();

    expect(ref.reference).toBe(true);
    expect(ref.analysis?.slug).toBe('kimi-k3');
    // A baseline is a yardstick, not something we serve. Anything that reads
    // these as available capacity would be wrong.
    expect(ref.members).toEqual([]);
    expect(ref.chains).toEqual([]);
    expect(ref.enabledMembers).toBe(0);
  });

  it('drops a slug the upstream no longer publishes, rather than showing a stale score', () => {
    setReferenceSlugs(['kimi-k3', 'withdrawn-slug']);

    expect(getReferenceGroups().map(g => g.analysis?.slug)).toEqual(['kimi-k3']);
    // The slug stays stored: it may come back, and silently editing the
    // operator's list on read would hide that it ever existed.
    expect(getReferenceSlugs()).toEqual(['kimi-k3', 'withdrawn-slug']);
  });

  it('de-duplicates and keeps references out of the routed catalogue', () => {
    expect(setReferenceSlugs(['kimi-k3', 'kimi-k3', ' '])).toEqual(['kimi-k3']);
    expect(getGroupedCompare().some(g => g.reference)).toBe(false);
  });
})

describe('reference ordering', () => {
  beforeEach(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
    addAa('weak', 'Weak', 10);
    addAa('strong', 'Strong', 50);
    addAa('unscored', 'Unscored', null);
  });

  it('reads strongest first whatever order they were pinned in', () => {
    // The same set of baselines must read the same way; insertion order would
    // make a yardstick depend on when it happened to be added.
    setReferenceSlugs(['weak', 'unscored', 'strong']);
    expect(getReferenceGroups().map(g => g.analysis?.slug)).toEqual(['strong', 'weak', 'unscored']);

    setReferenceSlugs(['strong', 'weak', 'unscored']);
    expect(getReferenceGroups().map(g => g.analysis?.slug)).toEqual(['strong', 'weak', 'unscored']);
  });
})

describe('reachability', () => {
  beforeEach(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
    const db = getDb();
    db.prepare('DELETE FROM profile_models').run();
    // Ids of our own: initDb seeds a default catalogue, and reusing a shipped
    // id collides rather than testing anything.
    addModel('groq', 'probe/reach-1', 'Reach Probe');
    addModel('cerebras', 'probe/reach-1', 'Reach Probe (Cerebras)');
    db.prepare(`
      INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, enabled, status)
      VALUES ('groq', 'k', 'x', 'x', 'x', 1, 'healthy')
    `).run();
  });

  it('counts only the routes whose provider we hold a key for', () => {
    const g = getGroupedCompare().find(x => /Reach Probe/.test(x.name));

    // Both routes are enabled and merged into one logical model, but only one
    // can serve: "enabled" and "reachable" are different questions.
    expect(g?.members).toHaveLength(2);
    expect(g?.enabledMembers).toBe(2);
    expect(g?.keyedMembers).toBe(1);
  });

  it('reports zero for a model on a provider with no usable key', () => {
    getDb().prepare("UPDATE api_keys SET status = 'invalid'").run();

    const g = getGroupedCompare().find(x => /Reach Probe/.test(x.name));
    expect(g?.enabledMembers).toBe(2);
    expect(g?.keyedMembers).toBe(0);
  });
})

describe('key scope', () => {
  beforeEach(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
    addModel('groq', 'probe/in-scope', 'In Scope');
    addModel('groq', 'probe/out-of-scope', 'Out Of Scope');
    getDb().prepare(`
      INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, enabled, status, model_scope_json)
      VALUES ('groq', 'k', 'x', 'x', 'x', 1, 'healthy', '["probe/in-scope"]')
    `).run();
  });

  it('does not call a model reachable when the key is scoped to other models', () => {
    // Holding a key for a platform is not the same as being able to call a
    // given model on it. A scoped key that omits the id is exactly the case
    // that made an unreachable model look available on the Compare page.
    const groups = getGroupedCompare();
    expect(groups.find(g => /In Scope/.test(g.name))?.keyedMembers).toBe(1);
    expect(groups.find(g => /Out Of Scope/.test(g.name))?.keyedMembers).toBe(0);
  });

  it('treats an unscoped key as covering every model on its platform', () => {
    getDb().prepare('UPDATE api_keys SET model_scope_json = NULL').run();

    expect(getGroupedCompare().find(g => /Out Of Scope/.test(g.name))?.keyedMembers).toBe(1);
  });
})

describe('editing key scope', () => {
  const scopeOf = () => {
    const raw = (getDb().prepare("SELECT model_scope_json s FROM api_keys WHERE platform='groq'").get() as { s: string | null }).s;
    return raw === null ? null : JSON.parse(raw) as string[];
  };

  beforeEach(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
    addModel('groq', 'probe/in-scope', 'In Scope');
    addModel('groq', 'probe/out-of-scope', 'Out Of Scope');
    getDb().prepare(`
      INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, enabled, status, model_scope_json)
      VALUES ('groq', 'k', 'x', 'x', 'x', 1, 'healthy', '["probe/in-scope","probe/other"]')
    `).run();
  });

  it('widens the scope and makes the route reachable', () => {
    expect(setModelKeyScope('groq', 'probe/out-of-scope', true).changed).toBe(1);

    expect(scopeOf()).toContain('probe/out-of-scope');
    expect(getGroupedCompare().find(g => /Out Of Scope/.test(g.name))?.keyedMembers).toBe(1);
  });

  it('narrows the scope again, leaving the other ids alone', () => {
    setModelKeyScope('groq', 'probe/out-of-scope', true);

    expect(setModelKeyScope('groq', 'probe/out-of-scope', false).changed).toBe(1);
    expect(scopeOf()).toEqual(['probe/in-scope', 'probe/other']);
  });

  it('refuses to narrow an unscoped key, which would revoke every other model', () => {
    // NULL scope means "every model on this platform". Removing one id would
    // have to freeze the rest into a list, quietly revoking everything
    // discovered later — a different decision from the one being asked for.
    getDb().prepare('UPDATE api_keys SET model_scope_json = NULL').run();

    expect(setModelKeyScope('groq', 'probe/in-scope', false)).toEqual({ changed: 0, refused: 1 });
    expect(scopeOf()).toBeNull();
  });

  it('refuses to remove the last id, which would read as unscoped', () => {
    getDb().prepare(`UPDATE api_keys SET model_scope_json = '["probe/in-scope"]'`).run();

    expect(setModelKeyScope('groq', 'probe/in-scope', false)).toEqual({ changed: 0, refused: 1 });
    expect(scopeOf()).toEqual(['probe/in-scope']);
  });

  it('is a no-op when the scope already says what was asked', () => {
    expect(setModelKeyScope('groq', 'probe/in-scope', true)).toEqual({ changed: 0, refused: 0 });
  });
})
