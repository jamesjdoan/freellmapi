import { describe, it, expect, beforeEach } from 'vitest';
import { initDb, getDb } from '../../db/index.js';
import {
  clearManualLink, getComparePayload, relinkAll, setManualLink,
  setAnalysisKey, getAnalysisKey, clearAnalysisKey, getAnalysisStatus,
} from '../../services/analysis.js';

function addModel(platform: string, modelId: string, displayName = modelId): number {
  const info = getDb().prepare(`
    INSERT INTO models (platform, model_id, display_name, intelligence_rank, speed_rank, size_label,
                        monthly_token_budget, enabled)
    VALUES (?, ?, ?, 50, 50, 'Medium', '', 1)
  `).run(platform, modelId, displayName);
  return Number(info.lastInsertRowid);
}

function addAa(slug: string, name: string, intelligence: number | null = 50) {
  getDb().prepare(`
    INSERT INTO aa_model (slug, name, intelligence_index, coding_index, agentic_index, index_version)
    VALUES (?, ?, ?, ?, ?, 'v4.3')
  `).run(slug, name, intelligence, intelligence, intelligence);
}

describe('analysis links', () => {
  beforeEach(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
    const db = getDb();
    // Children first: fallback_config and profile_models reference models, and
    // PRAGMA foreign_keys is on.
    db.prepare('DELETE FROM profile_models').run();
    db.prepare('DELETE FROM fallback_config').run();
    db.prepare('DELETE FROM models').run();
    db.prepare('DELETE FROM aa_model').run();
    db.prepare('DELETE FROM aa_model_link').run();
  });

  it('links what it can and records how', () => {
    addModel('groq', 'openai/gpt-oss-120b', 'GPT-OSS 120B (Groq)');
    addAa('gpt-oss-120b', 'gpt-oss-120B');
    expect(relinkAll()).toEqual({ linked: 1, unmatched: 0 });
    const row = getComparePayload().rows[0];
    expect(row.link).toMatchObject({ slug: 'gpt-oss-120b', source: 'auto', matchReason: 'slug' });
    expect(row.analysis?.intelligenceIndex).toBe(50);
  });

  it('records an unmatched model as a NULL link, not as a missing row', () => {
    // An absent row cannot stop the matcher re-proposing on every sync; a row
    // holding NULL can, and it is also what the mapping UI lists.
    addModel('groq', 'vendor/unknown-model');
    addAa('gpt-oss-120b', 'gpt-oss-120B');
    expect(relinkAll()).toEqual({ linked: 0, unmatched: 1 });
    expect(getComparePayload().rows[0].link).toMatchObject({ slug: null, source: 'auto' });
  });

  it('never overwrites a manual link', () => {
    // The operator's decision has to outlive a matcher that would now guess
    // differently — that is the whole point of mapping by hand.
    addModel('groq', 'openai/gpt-oss-120b', 'GPT-OSS 120B (Groq)');
    addAa('gpt-oss-120b', 'gpt-oss-120B');
    addAa('kimi-k3', 'Kimi K3');
    setManualLink('groq', 'openai/gpt-oss-120b', 'kimi-k3');
    relinkAll();
    const row = getComparePayload().rows[0];
    expect(row.link).toMatchObject({ slug: 'kimi-k3', source: 'manual' });
  });

  it('honours a manual "no counterpart"', () => {
    // Otherwise every sync re-attaches scores the operator has rejected.
    addModel('groq', 'openai/gpt-oss-120b', 'GPT-OSS 120B (Groq)');
    addAa('gpt-oss-120b', 'gpt-oss-120B');
    setManualLink('groq', 'openai/gpt-oss-120b', null);
    relinkAll();
    expect(getComparePayload().rows[0].link).toMatchObject({ slug: null, source: 'manual' });
  });

  it('hands a model back to the matcher when the manual link is cleared', () => {
    addModel('groq', 'openai/gpt-oss-120b', 'GPT-OSS 120B (Groq)');
    addAa('gpt-oss-120b', 'gpt-oss-120B');
    setManualLink('groq', 'openai/gpt-oss-120b', null);
    clearManualLink('groq', 'openai/gpt-oss-120b');
    relinkAll();
    expect(getComparePayload().rows[0].link).toMatchObject({ slug: 'gpt-oss-120b', source: 'auto' });
  });

  it('flags a link whose slug the cache no longer holds', () => {
    // AA withdrew the slug, or the mapping was made against a stale one. That
    // is a different state from unlinked and needs saying, or the row silently
    // shows no scores.
    addModel('groq', 'openai/gpt-oss-120b', 'GPT-OSS 120B (Groq)');
    setManualLink('groq', 'openai/gpt-oss-120b', 'withdrawn-slug');
    const row = getComparePayload().rows[0];
    expect(row.link).toMatchObject({ slug: 'withdrawn-slug', unresolved: true });
    expect(row.analysis).toBeNull();
  });

  it('keeps a null score null rather than zero', () => {
    // Their convention: NULL means not measured. As 0 the model would plot as
    // the worst instead of as absent.
    addModel('groq', 'openai/gpt-oss-120b', 'GPT-OSS 120B (Groq)');
    addAa('gpt-oss-120b', 'gpt-oss-120B', null);
    relinkAll();
    expect(getComparePayload().rows[0].analysis?.intelligenceIndex).toBeNull();
  });

  it('reports the chains a model serves alongside the scores', () => {
    const id = addModel('groq', 'openai/gpt-oss-120b', 'GPT-OSS 120B (Groq)');
    const p = getDb().prepare("INSERT INTO profiles (name, type) VALUES ('Fast-Lane', 'custom') RETURNING id").get() as { id: number };
    getDb().prepare('INSERT INTO profile_models (profile_id, model_db_id, priority, enabled) VALUES (?, ?, 1, 1)').run(p.id, id);
    expect(getComparePayload().rows[0].chains).toEqual(['Fast-Lane']);
  });
});

describe('analysis key storage', () => {
  beforeEach(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
  });

  it('round-trips the key through encryption', () => {
    setAnalysisKey('aa-secret-key-value');
    expect(getAnalysisKey()).toBe('aa-secret-key-value');
    expect(getAnalysisStatus().configured).toBe(true);
  });

  it('never stores the key in clear', () => {
    setAnalysisKey('aa-secret-key-value');
    const stored = getDb().prepare("SELECT value FROM settings WHERE key = 'aa_api_key_encrypted'")
      .get() as { value: string };
    expect(stored.value).not.toContain('aa-secret-key-value');
  });

  it('reports a key it cannot decrypt as configured-but-unreadable', () => {
    // A changed ENCRYPTION_KEY is a different problem from having no key, and
    // reading as "not configured" would send the operator to paste a new one
    // without knowing why.
    getDb().prepare("INSERT INTO settings (key, value) VALUES ('aa_api_key_encrypted', ?)")
      .run(JSON.stringify({ encrypted: 'ff', iv: 'ff', authTag: 'ff' }));
    const status = getAnalysisStatus();
    expect(status.configured).toBe(true);
    expect(status.unreadable).toBe(true);
  });

  it('forgets the key and its tier on clear', () => {
    setAnalysisKey('aa-secret-key-value');
    clearAnalysisKey();
    expect(getAnalysisKey()).toBeNull();
    expect(getAnalysisStatus().configured).toBe(false);
  });

  it('refuses an empty key', () => {
    expect(() => setAnalysisKey('   ')).toThrow();
  });
});
