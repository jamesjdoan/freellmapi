import { describe, it, expect, beforeEach } from 'vitest';
import { initDb, getDb } from '../../db/index.js';
import { encrypt } from '../../lib/crypto.js';
import { unreachableChainMembers, unreachableCause } from '../../services/chain-reachability.js';

/**
 * The invariant: a chain position must point at a route some key can call.
 *
 * Three positions violated it on 2026-09-18 and nothing reported it - the
 * Mistral key was disabled behind Fast-Lane #2, and two model scopes omitted a
 * member each. Membership lives in `profile_models`, reachability in
 * `api_keys.model_scope_json`, and nothing joined them.
 */

let fastLaneId = 0;

function reset(): void {
  process.env.ENCRYPTION_KEY = '0'.repeat(64);
  initDb(':memory:');
  // The eight chains are seeded by migration; Fast-Lane is one of them, and its
  // id is whatever the migration assigned.
  const db = getDb();
  // The baseline migration seeds a whole catalogue and the Default chain. This
  // audit reads every chain, so the seed would drown the rows under test.
  // Children first: models has several dependents, and the audit reads every
  // chain, so the seeded catalogue would drown the rows under test.
  for (const table of ['profile_models', 'fallback_config', 'model_overrides', 'rate_limit_usage', 'api_keys']) {
    try { db.prepare(`DELETE FROM ${table}`).run(); } catch { /* table absent in this schema */ }
  }
  db.prepare('DELETE FROM models').run();
  fastLaneId = Number(db.prepare("INSERT INTO profiles (name, type) VALUES ('Fast-Lane', 'custom')").run().lastInsertRowid);
}

function addModel(platform: string, modelId: string): number {
  const db = getDb();
  return Number(db.prepare(`
    INSERT INTO models (platform, model_id, display_name, intelligence_rank, speed_rank, size_label, monthly_token_budget, context_window, enabled, supports_vision, supports_tools)
    VALUES (?, ?, ?, 10, 10, 'Medium', 0, 131072, 1, 0, 1)
  `).run(platform, modelId, `${modelId} (${platform})`).lastInsertRowid);
}

function addKey(platform: string, opts: { enabled?: number; status?: string; scope?: string[] | null } = {}): void {
  const db = getDb();
  const secret = encrypt(`${platform}-test`);
  db.prepare(`
    INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled, model_scope_json)
    VALUES (?, 'k', ?, ?, ?, ?, ?, ?)
  `).run(
    platform, secret.encrypted, secret.iv, secret.authTag,
    opts.status ?? 'healthy',
    opts.enabled ?? 1,
    opts.scope === undefined || opts.scope === null ? null : JSON.stringify(opts.scope),
  );
}

function addMember(modelDbId: number, priority: number): void {
  getDb().prepare('INSERT INTO profile_models (profile_id, model_db_id, priority, enabled) VALUES (?, ?, ?, 1)').run(fastLaneId, modelDbId, priority);
}

describe('chain reachability', () => {
  beforeEach(reset);

  it('reports nothing when an unscoped key covers the chain', () => {
    const id = addModel('groq', 'qwen/qwen3.8-27b');
    addKey('groq', { scope: null });
    addMember(id, 1);
    expect(unreachableChainMembers(getDb())).toEqual([]);
  });

  it('catches the Mistral case: a key switched off behind a chain position', () => {
    // The exact shape that shipped: three members, healthy scope, key disabled.
    const a = addModel('mistral', 'ministral-3b-latest');
    const b = addModel('mistral', 'ministral-8b-2512');
    addKey('mistral', { enabled: 0, scope: null });
    addMember(a, 1);
    addMember(b, 2);
    const found = unreachableChainMembers(getDb());
    expect(found).toHaveLength(2);
    expect(found[0]).toMatchObject({ chain: 'Fast-Lane', priority: 1, cause: 'key_disabled' });
  });

  it('catches a scope that omits a member, which is a different repair', () => {
    const inScope = addModel('google', 'gemini-3.5-flash');
    const omitted = addModel('google', 'gemini-3.1-flash-lite-preview');
    addKey('google', { scope: ['gemini-3.5-flash'] });
    addMember(inScope, 1);
    addMember(omitted, 2);
    const found = unreachableChainMembers(getDb());
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ modelId: 'gemini-3.1-flash-lite-preview', cause: 'out_of_scope' });
  });

  it('separates a credential never held from one held and unusable', () => {
    // Different fixes: add a key, versus toggle or re-probe the one you have.
    expect(unreachableCause([], 'mistral', 'x')).toBe('no_key');
    expect(unreachableCause([{ platform: 'mistral', enabled: 0, status: 'healthy', model_scope_json: null }], 'mistral', 'x')).toBe('key_disabled');
    expect(unreachableCause([{ platform: 'mistral', enabled: 1, status: 'invalid', model_scope_json: null }], 'mistral', 'x')).toBe('key_disabled');
  });

  it('counts an unprobed key as usable, since unknown is not broken', () => {
    // Matches the router and scorer: status IN ('healthy','unknown').
    expect(unreachableCause([{ platform: 'groq', enabled: 1, status: 'unknown', model_scope_json: null }], 'groq', 'x')).toBeNull();
  });

  it('ignores positions the router would not walk anyway', () => {
    // A disabled model row or a disabled membership row is not a broken chain
    // position - it is not a position. Reporting it would bury the real ones.
    const off = addModel('mistral', 'ministral-3b-latest');
    getDb().prepare('UPDATE models SET enabled = 0 WHERE id = ?').run(off);
    addKey('mistral', { enabled: 0, scope: null });
    addMember(off, 1);
    expect(unreachableChainMembers(getDb())).toEqual([]);
  });

  it('does not confuse a rate-limited route with an unreachable one', () => {
    // Health and quota are separate questions, asked later by the router. A
    // keyed route on cooldown is working capacity, not a dead position.
    const id = addModel('groq', 'qwen/qwen3.8-27b');
    addKey('groq', { status: 'rate_limited', scope: null });
    addMember(id, 1);
    // status not in (healthy, unknown) -> the KEY is unusable, and that is the
    // honest answer; a cooldown lives on the model, not the credential.
    expect(unreachableChainMembers(getDb())[0]?.cause).toBe('key_disabled');
  });
});
