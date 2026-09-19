import { describe, it, expect, beforeEach } from 'vitest';
import { initDb, getDb } from '../../db/index.js';
import {
  auditChainCapabilities,
  capabilityBlock,
  capabilityState,
  recordCapabilityProbe,
  requiredCapabilities,
} from '../../services/chain-capability.js';

/**
 * The invariant: a chain position must be able to do what its chain requires.
 *
 * nvidia/nemotron-parse-2.0 probed ok on text, entered Vision, and returned
 * `empty_completion` on a real PNG four minutes later. It had successes AND
 * failures in one window from two different questions, which is why the fact
 * cannot be a per-model health verdict.
 */

let visionId = 0;
let codingId = 0;

function reset(): void {
  process.env.ENCRYPTION_KEY = '0'.repeat(64);
  initDb(':memory:');
  const db = getDb();
  // The baseline migration seeds a catalogue and the Default chain; the audit
  // reads every chain, so the seed would drown the rows under test.
  for (const table of ['profile_models', 'fallback_config', 'model_overrides', 'rate_limit_usage', 'api_keys', 'model_capability_probe']) {
    try { db.prepare(`DELETE FROM ${table}`).run(); } catch { /* table absent in this schema */ }
  }
  db.prepare('DELETE FROM models').run();
  db.prepare('DELETE FROM profiles').run();
  visionId = Number(db.prepare("INSERT INTO profiles (name, type) VALUES ('Vision', 'custom')").run().lastInsertRowid);
  codingId = Number(db.prepare("INSERT INTO profiles (name, type) VALUES ('Coding', 'custom')").run().lastInsertRowid);
}

function addModel(platform: string, modelId: string, endpointScope = ''): number {
  const db = getDb();
  return Number(db.prepare(`
    INSERT INTO models (platform, model_id, display_name, intelligence_rank, speed_rank, size_label, monthly_token_budget, context_window, enabled, supports_vision, supports_tools, endpoint_scope)
    VALUES (?, ?, ?, 10, 10, 'Medium', 0, 131072, 1, 1, 1, ?)
  `).run(platform, modelId, `${modelId} (${platform})`, endpointScope).lastInsertRowid);
}

function addMember(profileId: number, modelDbId: number, priority: number): void {
  getDb().prepare('INSERT INTO profile_models (profile_id, model_db_id, priority, enabled) VALUES (?, ?, ?, 1)').run(profileId, modelDbId, priority);
}

describe('chain capability', () => {
  beforeEach(reset);

  it('reads each chain its own contract, not a global one', () => {
    // Vision is the only chain requiring sight; Coding requires tools. A single
    // global predicate would report Coding members as blind.
    expect(requiredCapabilities('Vision')).toContain('vision');
    expect(requiredCapabilities('Coding')).toEqual(['tools']);
    expect(requiredCapabilities('Extra-Tier')).toEqual([]);
  });

  it('reports an unprobed member as unverified, never as failed', () => {
    // Unknown is not zero. An unprobed route is an absence of evidence, and
    // counting it as a fault would make every fresh chain look broken.
    addMember(visionId, addModel('nvidia', 'nemotron-parse-2.0'), 1);
    const audit = auditChainCapabilities();
    expect(audit.failed).toEqual([]);
    expect(audit.unverified).toHaveLength(1);
    expect(audit.unverified[0]).toMatchObject({ chain: 'Vision', capability: 'vision', state: 'unverified' });
  });

  it('separates failed from unverified and never sums them', () => {
    const blind = addModel('nvidia', 'nemotron-parse-2.0');
    addMember(visionId, blind, 1);
    addMember(visionId, addModel('google', 'gemini-3.7-flash'), 2);
    recordCapabilityProbe(
      { platform: 'nvidia', modelId: 'nemotron-parse-2.0', endpointScope: '', capability: 'vision' },
      { verdict: 'dead', detail: 'empty completion from Nemotron Parse 2.0', latencyMs: 696 },
    );

    const audit = auditChainCapabilities();
    expect(audit.failed.map(m => m.modelId)).toEqual(['nemotron-parse-2.0']);
    expect(audit.unverified.map(m => m.modelId)).toEqual(['gemini-3.7-flash']);
    const vision = audit.chains.find(c => c.chain === 'Vision');
    expect(vision).toMatchObject({ members: 2, ok: 0, failed: 1, unverified: 1 });
  });

  it('counts unverified per chain, so a bulk unprobed add reads as its own size', () => {
    // The number that makes "fifteen unprobed members in Vision" visible as
    // fifteen rather than as one more line in a list.
    for (let i = 0; i < 15; i++) addMember(visionId, addModel('nvidia', `unprobed-${i}`), i + 1);
    const vision = auditChainCapabilities().chains.find(c => c.chain === 'Vision');
    expect(vision).toMatchObject({ members: 15, unverified: 15, failed: 0 });
  });

  it('blocks a membership add only on a RECORDED failure', () => {
    recordCapabilityProbe(
      { platform: 'nvidia', modelId: 'blind', endpointScope: '', capability: 'vision' },
      { verdict: 'dead', detail: 'empty completion', latencyMs: 700 },
    );
    expect(capabilityBlock('nvidia', 'blind', '', 'Vision')).toMatchObject({ capability: 'vision' });
    // Never probed: allowed through, because probing inside the write would
    // fail closed on a slow provider.
    expect(capabilityBlock('nvidia', 'unprobed', '', 'Vision')).toBeNull();
    // A passing probe is not a block either.
    recordCapabilityProbe(
      { platform: 'google', modelId: 'seeing', endpointScope: '', capability: 'vision' },
      { verdict: 'ok', detail: null, latencyMs: 300 },
    );
    expect(capabilityBlock('google', 'seeing', '', 'Vision')).toBeNull();
  });

  it('does not block a chain that never asked for the capability', () => {
    // The same blind model is perfectly valid in a chain with no vision
    // contract — the model is fine, its presence in Vision was not.
    recordCapabilityProbe(
      { platform: 'nvidia', modelId: 'blind', endpointScope: '', capability: 'vision' },
      { verdict: 'dead', detail: 'empty completion', latencyMs: 700 },
    );
    expect(capabilityBlock('nvidia', 'blind', '', 'Extra-Tier')).toBeNull();
  });

  it('refuses to record a verdict the probe did not actually establish', () => {
    // No key scoped to the model says something about our credentials; a 429
    // says something about the minute. Neither answered the capability
    // question, and storing either as `failed` would libel the route.
    const untested = recordCapabilityProbe(
      { platform: 'nvidia', modelId: 'm', endpointScope: '', capability: 'vision' },
      { verdict: 'untested', detail: 'No enabled key is scoped to this model', latencyMs: null },
    );
    const limited = recordCapabilityProbe(
      { platform: 'nvidia', modelId: 'm2', endpointScope: '', capability: 'vision' },
      { verdict: 'limited', detail: '429', latencyMs: 40 },
    );
    expect(untested).toBe('unverified');
    expect(limited).toBe('unverified');
    expect(capabilityState('nvidia', 'm', '', 'vision')).toBe('unverified');
    expect(capabilityState('nvidia', 'm2', '', 'vision')).toBe('unverified');
  });

  it('keeps two endpoints serving one model id apart', () => {
    // models is UNIQUE(platform, model_id, endpoint_scope). Without the scope in
    // the key, two relays collapse into one row and overwrite each other.
    recordCapabilityProbe(
      { platform: 'custom', modelId: 'gpt-oss:20b', endpointScope: 'https://relay-a', capability: 'vision' },
      { verdict: 'dead', detail: 'empty completion', latencyMs: 10 },
    );
    recordCapabilityProbe(
      { platform: 'custom', modelId: 'gpt-oss:20b', endpointScope: 'https://relay-b', capability: 'vision' },
      { verdict: 'ok', detail: null, latencyMs: 10 },
    );
    expect(capabilityState('custom', 'gpt-oss:20b', 'https://relay-a', 'vision')).toBe('failed');
    expect(capabilityState('custom', 'gpt-oss:20b', 'https://relay-b', 'vision')).toBe('ok');
  });

  it('re-probing replaces the old verdict rather than accumulating rows', () => {
    const key = { platform: 'nvidia', modelId: 'm', endpointScope: '', capability: 'vision' } as const;
    recordCapabilityProbe(key, { verdict: 'dead', detail: 'empty completion', latencyMs: 10 });
    recordCapabilityProbe(key, { verdict: 'ok', detail: null, latencyMs: 20 });
    expect(capabilityState('nvidia', 'm', '', 'vision')).toBe('ok');
    const count = getDb().prepare('SELECT COUNT(*) AS n FROM model_capability_probe').get() as { n: number };
    expect(count.n).toBe(1);
  });

  it('ignores a disabled member and a disabled model', () => {
    // Same enabled filter as reachability: the audit judges what the router
    // would actually walk.
    const off = addModel('nvidia', 'switched-off');
    getDb().prepare('UPDATE models SET enabled = 0 WHERE id = ?').run(off);
    addMember(visionId, off, 1);
    const removed = addModel('nvidia', 'removed-member');
    getDb().prepare('INSERT INTO profile_models (profile_id, model_db_id, priority, enabled) VALUES (?, ?, 2, 0)').run(visionId, removed);
    expect(auditChainCapabilities().unverified).toEqual([]);
  });

  it('scopes the audit to one chain when asked', () => {
    addMember(visionId, addModel('nvidia', 'v'), 1);
    addMember(codingId, addModel('nvidia', 'c'), 1);
    const audit = auditChainCapabilities(getDb(), 'Vision');
    expect(audit.chains.map(c => c.chain)).toEqual(['Vision']);
    expect(audit.unverified.map(m => m.modelId)).toEqual(['v']);
  });
});
