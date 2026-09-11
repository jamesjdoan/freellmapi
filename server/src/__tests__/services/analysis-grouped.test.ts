import { describe, it, expect, beforeEach } from 'vitest';
import { initDb, getDb } from '../../db/index.js';
import {
  getGroupedCompare,
  getReferenceGroups,
  getReferenceSlugs,
  relinkAll,
  setManualLink,
  setReferenceSlugs,
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
