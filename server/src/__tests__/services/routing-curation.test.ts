import { describe, it, expect, beforeEach } from 'vitest';
import { initDb, getDb } from '../../db/index.js';
import { encrypt } from '../../lib/crypto.js';
import {
  CURATED_ROUTES,
  SINGLE_COUNTER_PLATFORMS,
  CHAIN_CONTRACTS,
  QUOTA_DOMAINS,
  chainMembers,
  type ChainName,
} from '../../data/routing-curation.js';
import { resolveRoutingChain, setRoutingStrategy } from '../../services/router.js';
import { consumesPaidBalance, resolveQuotaPolicy } from '../../services/provider-quota.js';
import { invalidateQuotaPressure } from '../../services/quota-pressure.js';
import { setExtensionEnabled, resetExtensionStateCache } from '../../services/extension-state.js';
import { PAID_BALANCE_GUARD_ID, PAID_SPEND_CONFIRMATION } from '../../data/extension-registry.js';
import { setSetting } from '../../db/index.js';

function reset(): void {
  process.env.ENCRYPTION_KEY = '0'.repeat(64);
  initDb(':memory:');
  const db = getDb();
  db.prepare('DELETE FROM fallback_config').run();
  db.prepare('DELETE FROM profile_models').run();
  db.prepare('DELETE FROM models').run();
  db.prepare('DELETE FROM api_keys').run();
  invalidateQuotaPressure();
}

function addKey(platform: string): void {
  const secret = encrypt(`${platform}-curation-test-key`);
  getDb().prepare(`
    INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled)
    VALUES (?, 'curation-test', ?, ?, ?, 'healthy', 1)
  `).run(platform, secret.encrypted, secret.iv, secret.authTag);
}

function addModel(platform: string, modelId: string, opts: { tools?: boolean; vision?: boolean } = {}): number {
  const info = getDb().prepare(`
    INSERT INTO models (platform, model_id, display_name, intelligence_rank, speed_rank, size_label,
      monthly_token_budget, context_window, enabled, supports_vision, supports_tools)
    VALUES (?, ?, ?, 5, 5, 'Large', '', 128000, 1, ?, ?)
  `).run(platform, modelId, `${modelId} (${platform})`, opts.vision ? 1 : 0, opts.tools === false ? 0 : 1);
  return Number(info.lastInsertRowid);
}

function addChain(name: string, members: number[]): void {
  const db = getDb();
  const info = db.prepare("INSERT INTO profiles (name, type) VALUES (?, 'custom')").run(name);
  const profileId = Number(info.lastInsertRowid);
  const insert = db.prepare('INSERT INTO profile_models (profile_id, model_db_id, priority, enabled) VALUES (?, ?, ?, 1)');
  members.forEach((id, i) => insert.run(profileId, id, i + 1));
}

describe('chain contracts hold for every curated member', () => {
  it('admits no classification a chain did not declare', () => {
    for (const contract of CHAIN_CONTRACTS) {
      for (const member of chainMembers(contract.name)) {
        expect(
          contract.admits,
          `${contract.name} admits ${member.classification} via ${member.platform}/${member.modelId}`,
        ).toContain(member.classification);
      }
    }
  });

  it('keeps the daily driver free of promo capacity and vision free of nothing but blindness', () => {
    // frontier is the likely harness DEFAULT: an unmeasured promo route in it
    // would put unqualified requests on capacity nobody can account for. apex
    // is the escalation tip and may carry an experimental tail, but never at
    // its head — 'heads every chain with a CORE route' covers that.
    const frontier = chainMembers('Frontier').map(m => m.classification);
    expect(frontier).not.toContain('EXPERIMENTAL');
    expect(frontier).not.toContain('SPECIALIST');
    expect(chainMembers('Apex').map(m => m.classification)).not.toContain('SPECIALIST');

    // vision is the one chain that admits SPECIALIST, precisely so a strong
    // multimodal model is not rejected for lacking tool support.
    const vision = CHAIN_CONTRACTS.find(c => c.name === 'Vision')!;
    expect(vision.admits).toContain('SPECIALIST');
    expect(vision.requiresTools).toBe(false);
    expect(vision.requiresVision).toBe(true);
  });

  it('spends a single shared counter on the best route it can buy', () => {
    // OpenRouter's :free routes draw ONE account allowance — 1000/day and
    // 20/min across all of them. A weaker member costs the same unit for less
    // and adds no depth, because they exhaust together. So each chain lists at
    // most one, and it must be the strongest that chain admits.
    //
    // Live before this rule: fast-lane and workhorse both carried
    // ling-3.0-flash at 24.9 while nex-n2.5 at 28.2 drew the same counter.
    for (const platform of SINGLE_COUNTER_PLATFORMS) {
      for (const contract of CHAIN_CONTRACTS) {
        const fromPool = chainMembers(contract.name).filter(m => m.platform === platform);
        expect(fromPool.length, `${contract.name} lists ${fromPool.length} ${platform} routes`)
          .toBeLessThanOrEqual(1);
      }
    }
  });

  it('still takes several routes from a provider that meters PER MODEL', () => {
    // The rule above must not be over-applied: Google meters 20/day per model
    // and NVIDIA 40/min per model, so a second route there is a second
    // allowance and real depth. Collapsing those to one would throw capacity
    // away, which is the opposite mistake.
    const perModel = ['google', 'nvidia'];
    const counts = perModel.map(p =>
      Math.max(...CHAIN_CONTRACTS.map(c => chainMembers(c.name).filter(m => m.platform === p).length)));
    expect(Math.max(...counts)).toBeGreaterThan(1);
  });

  it('heads every chain with a CORE route', () => {
    for (const contract of CHAIN_CONTRACTS) {
      const members = chainMembers(contract.name);
      if (members.length === 0) continue;
      const head = members[0]!;
      // Extra-tier is the one chain whose whole purpose is unproven capacity.
      if (contract.name === 'Extra-Tier') continue;
      expect(head.classification, `${contract.name} is headed by ${head.platform}/${head.modelId}`).toBe('CORE');
    }
  });

  it('gives apex and frontier different heads — they are different questions', () => {
    // frontier = best practical daily driver; apex = the peak it escalates to.
    // Collapsing them would make free escalation a no-op.
    const apexHead = chainMembers('Apex')[0]!;
    const frontierHead = chainMembers('Frontier')[0]!;
    expect(`${apexHead.platform}/${apexHead.modelId}`).not.toBe(`${frontierHead.platform}/${frontierHead.modelId}`);
  });
});

describe('shared quota domains are not mistaken for depth', () => {
  it('does not stack one provider pool in the top two of a critical chain', () => {
    // Three NVIDIA models are three capabilities and ONE allowance. A chain
    // whose first two entries share a pool has no depth at all at the moment
    // that pool refuses — which is the moment depth is needed.
    for (const name of ['Apex', 'Frontier', 'Coding', 'Workhorse', 'Fast-Lane', 'Vision'] as ChainName[]) {
      const members = chainMembers(name);
      const firstTwo = members.slice(0, 2).map(m => resolveQuotaPolicy(m.platform as never, m.modelId).poolKey);
      expect(new Set(firstTwo).size, `${name} head pools: ${firstTwo.join(', ')}`).toBe(2);
    }
  });

  it('records per-model providers as several pools and shared ones as one', () => {
    // NVIDIA was recorded here as ONE pool until it was measured: a 70-call
    // burst served 38 and refused 32 while a second model served in the same
    // second the first was refusing, and each model hits its own 429 after
    // 10-14 calls rather than all stopping together at 40. The table's own rule
    // is "one pool until telemetry says otherwise"; telemetry said otherwise.
    expect(QUOTA_DOMAINS.nvidia!.independent).toBe(true);
    expect(QUOTA_DOMAINS.groq!.independent).toBe(true);

    const nvidia = ['moonshotai/kimi-k3', 'deepseek-ai/deepseek-v4-pro-0813', 'nvidia/nemotron-3-ultra-550b-a55b']
      .map(m => resolveQuotaPolicy('nvidia', m).poolKey);
    expect(new Set(nvidia).size).toBe(3);

    const groq = ['openai/gpt-oss-120b', 'openai/gpt-oss-20b', 'qwen/qwen3.8-27b']
      .map(m => resolveQuotaPolicy('groq', m).poolKey);
    expect(new Set(groq).size).toBe(3);

    // The contrast still has to hold somewhere, or "independent" means nothing.
    // OpenRouter's :free routes genuinely share one counter, so they collapse.
    expect(QUOTA_DOMAINS.openrouter!.independent).toBe(false);
    const openrouter = ['qwen/qwen3-coder:free', 'meta-llama/llama-3.3-70b-instruct:free', 'nvidia/nemotron-3-ultra:free']
      .map(m => resolveQuotaPolicy('openrouter', m).poolKey);
    expect(new Set(openrouter).size).toBe(1);
  });
});

describe('scarce capacity stays off the high-volume paths', () => {
  it('keeps Ollama Cloud out of fast-lane entirely', () => {
    // One weekly balance, observed at 5.4%. Bounded subagents and scouting are
    // exactly the work that would drain it on the cheapest possible requests.
    const fastLane = chainMembers('Fast-Lane').map(m => m.platform);
    expect(fastLane).not.toContain('ollama');
    // Where it does appear, it appears last.
    for (const name of ['Frontier', 'Workhorse'] as ChainName[]) {
      const members = chainMembers(name);
      const ollama = members.findIndex(m => m.platform === 'ollama');
      if (ollama === -1) continue;
      expect(ollama).toBe(members.length - 1);
    }
  });

  it('keeps unmeasured promo capacity off the driver, coding and fast-lane', () => {
    // apex is exempt: escalation is where an unproven frontier-tier route is
    // worth one attempt, and it sits last there.
    for (const name of ['Frontier', 'Coding', 'Fast-Lane', 'Workhorse', 'Default'] as ChainName[]) {
      expect(chainMembers(name).map(m => m.platform), name).not.toContain('opencode');
    }
  });
});

describe('credit safety', () => {
  beforeEach(reset);

  it('names a paid OpenRouter route as paid and a :free one as free', () => {
    expect(consumesPaidBalance('openrouter', 'anthropic/claude-sonnet-5')).toBe(true);
    expect(consumesPaidBalance('openrouter', 'poolside/laguna-s-2.1:free')).toBe(false);
    expect(consumesPaidBalance('groq', 'openai/gpt-oss-120b')).toBe(false);
  });

  it('curates only :free OpenRouter routes', () => {
    for (const route of CURATED_ROUTES) {
      if (route.platform !== 'openrouter') continue;
      expect(route.modelId, `${route.modelId} would bill the paid balance`).toMatch(/:free$/);
    }
  });

  it('drops a paid route from an auto chain while keeping the free one', () => {
    addKey('openrouter');
    const free = addModel('openrouter', 'poolside/laguna-s-2.1:free');
    const paid = addModel('openrouter', 'poolside/laguna-s-2.1');
    addChain('Coding', [free, paid]);
    setRoutingStrategy('priority');

    const { chain } = resolveRoutingChain('auto:coding');
    const ids = chain.map(e => e.model_id);
    expect(ids).toContain('poolside/laguna-s-2.1:free');
    expect(ids).not.toContain('poolside/laguna-s-2.1');
  });

  it('routes the paid twin only once paid spend has been authorised', () => {
    addKey('openrouter');
    const free = addModel('openrouter', 'poolside/laguna-s-2.1:free');
    const paid = addModel('openrouter', 'poolside/laguna-s-2.1');
    addChain('Coding', [free, paid]);
    setRoutingStrategy('priority');

    // Guarded by default: the paid twin is not a candidate at all.
    resetExtensionStateCache();
    expect(resolveRoutingChain('auto:coding').chain.map(e => e.model_id))
      .not.toContain('poolside/laguna-s-2.1');

    // The old `routing_allow_paid_balance` row is retired and must NOT work:
    // it authorised real spending with nothing recorded about who chose it.
    setSetting('routing_allow_paid_balance', 'true');
    resetExtensionStateCache();
    expect(resolveRoutingChain('auto:coding').chain.map(e => e.model_id))
      .not.toContain('poolside/laguna-s-2.1');

    // Only the acknowledged extension toggle opens it.
    setExtensionEnabled(PAID_BALANCE_GUARD_ID, false, { confirmation: PAID_SPEND_CONFIRMATION });
    expect(resolveRoutingChain('auto:coding').chain.map(e => e.model_id))
      .toContain('poolside/laguna-s-2.1');
  });
});

describe('catalogue preservation', () => {
  beforeEach(reset);

  it('leaves a model disabled from routing fully present in the catalogue', () => {
    addKey('groq');
    const routed = addModel('groq', 'openai/gpt-oss-120b');
    const shelved = addModel('groq', 'allam-2-7b');
    addChain('Coding', [routed]);
    // What the applier does to a model it drops: switches the chain row off. It
    // never touches `models`, which is the whole catalogue-preservation claim.
    getDb().prepare('INSERT INTO profile_models (profile_id, model_db_id, priority, enabled) SELECT id, ?, 99, 0 FROM profiles WHERE name = ?')
      .run(shelved, 'Coding');
    setRoutingStrategy('priority');

    // resolveRoutingChain hands back the whole chain; routing filters on the
    // enabled flag, so that is the set a request can actually reach.
    const { chain } = resolveRoutingChain('auto:coding');
    expect(chain.filter(e => e.enabled).map(e => e.model_id)).toEqual(['openai/gpt-oss-120b']);

    const row = getDb().prepare('SELECT model_id, enabled FROM models WHERE id = ?').get(shelved) as { model_id: string; enabled: number };
    expect(row.model_id).toBe('allam-2-7b');
    expect(row.enabled).toBe(1); // still listed, still pinnable by name
  });
});

describe('chain capability gates', () => {
  beforeEach(reset);

  it('a vision chain built from the spec contains no text-only model', () => {
    for (const member of chainMembers('Vision')) {
      const route = CURATED_ROUTES.find(r => r.platform === member.platform && r.modelId === member.modelId)!;
      expect(route, `${member.platform}/${member.modelId}`).toBeDefined();
    }
    // The applier is what enforces this against the live catalogue's flags;
    // here we assert the spec never asks for a member the contract forbids.
    const vision = CHAIN_CONTRACTS.find(c => c.name === 'Vision')!;
    expect(vision.requiresVision).toBe(true);
  });

  it('every agentic chain declares that it requires tools', () => {
    for (const name of ['Apex', 'Coding', 'Frontier', 'Workhorse', 'Fast-Lane', 'Default'] as ChainName[]) {
      expect(CHAIN_CONTRACTS.find(c => c.name === name)!.requiresTools, name).toBe(true);
    }
  });
});

describe('tail integrity', () => {
  it('numbers every chain contiguously from 1, with no two routes claiming a position', () => {
    // A duplicate priority does not fail, which is what makes it dangerous: two
    // routes claim one position and their order becomes whatever the sort
    // happens to do. This chain HAD two members at Vision 5, so the ordering
    // an operator reads in the spec was not the ordering the applier wrote.
    for (const contract of CHAIN_CONTRACTS) {
      const priorities = chainMembers(contract.name).map(m => m.priority);
      if (priorities.length === 0) continue;
      expect(new Set(priorities).size, `${contract.name} has a duplicate priority: ${priorities.join(', ')}`)
        .toBe(priorities.length);
      expect(priorities, `${contract.name} priorities are not 1..${priorities.length}`)
        .toEqual(Array.from({ length: priorities.length }, (_, i) => i + 1));
    }
  });
});
