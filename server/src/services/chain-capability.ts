import { getDb } from '../db/index.js';
import type { Db } from '../db/types.js';
import { probeModelVision, type ProbeResult } from './model-health.js';
import { CHAIN_CONTRACTS } from '../data/routing-curation.js';

/**
 * Whether a chain position can do what its chain REQUIRES.
 *
 * The sibling of chain-reachability.ts, and deliberately shaped like it. That
 * one asks whether a credential may call a route at all; this asks the next
 * question, which nothing asked before 2026-09-19: granted we can call it, can
 * it do the job the chain exists for?
 *
 * The case that produced it. nvidia/nemotron-parse-2.0 probed ok in 696ms, was
 * added to Vision, and was removed four minutes later after returning
 * `empty_completion` on a real 8x8 PNG. Its recorded history:
 *
 *   01:50:06  error    in=9  out=0   empty completion
 *   01:49:52  success  in=2  out=8
 *
 * Both outcomes in one window, from two different questions. That is why this
 * is not a ModelHealthVerdict: a per-model tally averages "can read text" with
 * "cannot see" into a single word, and every candidate word is a lie. It is
 * also why the fact attaches to chain MEMBERSHIP rather than to the model - the
 * model is fine, its presence in Vision is not.
 *
 * Three states, and `unverified` is a real one:
 *
 *   ok          a probe of that capability succeeded
 *   failed      a probe of that capability failed, and it is on record
 *   unverified  nobody has asked. NOT a failure - unknown is not zero, the same
 *               rule the quota ledger keeps.
 *
 * Only `failed` blocks a membership write. Probing synchronously inside the
 * write would fail closed whenever a provider is merely slow, turning a network
 * wobble into "you may not add this model" - the worst possible trade for a UI
 * action. The consequence is stated plainly because it is the honest cost:
 * nemotron-parse-2.0 would STILL have been added, because nobody had probed it.
 * What catches that case is the audit, which lists it the moment the probe
 * lands - the same drift path reachability already relies on.
 */

/** The contract predicates that exist. Generic over these two and no further:
 *  a plugin framework for predicates nobody has declared is speculation, and
 *  `CHAIN_CONTRACTS` declares exactly these. */
export type Capability = 'vision' | 'tools';

export const CAPABILITIES: readonly Capability[] = ['vision', 'tools'];

export type CapabilityState = 'ok' | 'failed' | 'unverified';

export interface CapabilityProbeRow {
  platform: string;
  modelId: string;
  endpointScope: string;
  capability: Capability;
  verdict: 'ok' | 'failed';
  detail: string | null;
  latencyMs: number | null;
  probedAtMs: number;
}

export interface CapabilityMember {
  chain: string;
  priority: number;
  platform: string;
  modelId: string;
  endpointScope: string;
  modelDbId: number;
  /** The contract this member is failing or has never been checked against. */
  capability: Capability;
  state: Exclude<CapabilityState, 'ok'>;
  detail: string | null;
  probedAtMs: number | null;
}

export interface ChainCapabilitySummary {
  chain: string;
  /** Contracts this chain declares, from CHAIN_CONTRACTS. */
  requires: Capability[];
  members: number;
  ok: number;
  failed: number;
  unverified: number;
}

export interface CapabilityAudit {
  /** Members whose recorded probe CONTRADICTS their chain. Repair these. */
  failed: CapabilityMember[];
  /** Members nobody has probed for a contract their chain requires. Not a
   *  fault, but the number that says how much of a chain is unevidenced. */
  unverified: CapabilityMember[];
  /** Per chain, so fifteen unprobed Vision members read as fifteen and not as
   *  one line in a long list. */
  chains: ChainCapabilitySummary[];
}

/** Which capabilities a chain's contract demands of every member. */
export function requiredCapabilities(chain: string): Capability[] {
  const contract = CHAIN_CONTRACTS.find(c => c.name === chain);
  if (!contract) return [];
  const out: Capability[] = [];
  if (contract.requiresVision) out.push('vision');
  if (contract.requiresTools) out.push('tools');
  return out;
}

interface ProbeKey {
  platform: string;
  modelId: string;
  endpointScope: string;
  capability: Capability;
}

function probeMapKey(platform: string, modelId: string, endpointScope: string, capability: string): string {
  // NUL-joined: model ids contain ':' and '/', and endpoint scopes are URLs.
  return `${platform}\u0000${modelId}\u0000${endpointScope}\u0000${capability}`;
}

/** Every recorded capability verdict, keyed for O(1) lookup during an audit. */
function probeIndex(db: Db): Map<string, CapabilityProbeRow> {
  const rows = db.prepare(`
    SELECT platform, model_id, endpoint_scope, capability, verdict, detail, latency_ms, probed_at_ms
      FROM model_capability_probe
  `).all() as {
    platform: string; model_id: string; endpoint_scope: string; capability: Capability;
    verdict: 'ok' | 'failed'; detail: string | null; latency_ms: number | null; probed_at_ms: number;
  }[];
  const map = new Map<string, CapabilityProbeRow>();
  for (const r of rows) {
    map.set(probeMapKey(r.platform, r.model_id, r.endpoint_scope, r.capability), {
      platform: r.platform,
      modelId: r.model_id,
      endpointScope: r.endpoint_scope,
      capability: r.capability,
      verdict: r.verdict,
      detail: r.detail,
      latencyMs: r.latency_ms,
      probedAtMs: r.probed_at_ms,
    });
  }
  return map;
}

/** The recorded verdict for one route and capability, or 'unverified'. */
export function capabilityState(
  platform: string,
  modelId: string,
  endpointScope: string,
  capability: Capability,
  db: Db = getDb(),
): CapabilityState {
  const row = db.prepare(`
    SELECT verdict FROM model_capability_probe
     WHERE platform = ? AND model_id = ? AND endpoint_scope = ? AND capability = ?
  `).get(platform, modelId, endpointScope, capability) as { verdict: 'ok' | 'failed' } | undefined;
  return row ? row.verdict : 'unverified';
}

interface MemberRow {
  chain: string;
  priority: number;
  platform: string;
  model_id: string;
  endpoint_scope: string;
  model_db_id: number;
}

/** Enabled chain positions, same join and same enabled filter as reachability. */
function chainMembers(db: Db, chain?: string): MemberRow[] {
  const sql = `
    SELECT p.name AS chain, pm.priority, m.platform, m.model_id,
           COALESCE(m.endpoint_scope, '') AS endpoint_scope, m.id AS model_db_id
      FROM profile_models pm
      JOIN profiles p ON p.id = pm.profile_id
      JOIN models m ON m.id = pm.model_db_id
     WHERE pm.enabled = 1 AND m.enabled = 1
       ${chain ? 'AND p.name = ?' : ''}
     ORDER BY p.sort_order, pm.priority
  `;
  const stmt = db.prepare(sql);
  return (chain ? stmt.all(chain) : stmt.all()) as MemberRow[];
}

/**
 * Every enabled chain position measured against its chain's own contract.
 *
 * Empty `failed` is the healthy answer; `unverified` being large is not a fault
 * but is the thing worth seeing, because it is exactly how a blind route gets
 * into Vision unnoticed.
 */
export function auditChainCapabilities(db: Db = getDb(), chain?: string): CapabilityAudit {
  const probes = probeIndex(db);
  const failed: CapabilityMember[] = [];
  const unverified: CapabilityMember[] = [];
  const summaries = new Map<string, ChainCapabilitySummary>();

  for (const row of chainMembers(db, chain)) {
    const requires = requiredCapabilities(row.chain);
    let summary = summaries.get(row.chain);
    if (!summary) {
      summary = { chain: row.chain, requires, members: 0, ok: 0, failed: 0, unverified: 0 };
      summaries.set(row.chain, summary);
    }
    summary.members += 1;
    // A chain with no declared contract has nothing to violate. Its members
    // still count toward `members`, so the summary reports the whole chain.
    for (const capability of requires) {
      const probe = probes.get(probeMapKey(row.platform, row.model_id, row.endpoint_scope, capability));
      if (probe?.verdict === 'ok') {
        summary.ok += 1;
        continue;
      }
      const member: CapabilityMember = {
        chain: row.chain,
        priority: row.priority,
        platform: row.platform,
        modelId: row.model_id,
        endpointScope: row.endpoint_scope,
        modelDbId: row.model_db_id,
        capability,
        state: probe ? 'failed' : 'unverified',
        detail: probe?.detail ?? null,
        probedAtMs: probe?.probedAtMs ?? null,
      };
      if (probe) {
        summary.failed += 1;
        failed.push(member);
      } else {
        summary.unverified += 1;
        unverified.push(member);
      }
    }
  }

  return { failed, unverified, chains: [...summaries.values()] };
}

/**
 * Why this route may not join this chain, or null when nothing on record says
 * it may not.
 *
 * Only a RECORDED failure blocks. `unverified` deliberately does not: see the
 * header - a write path that probes synchronously fails closed on a slow
 * provider, and the audit is what catches the unprobed case.
 */
export function capabilityBlock(
  platform: string,
  modelId: string,
  endpointScope: string,
  chain: string,
  db: Db = getDb(),
): { capability: Capability; detail: string | null } | null {
  for (const capability of requiredCapabilities(chain)) {
    const row = db.prepare(`
      SELECT verdict, detail FROM model_capability_probe
       WHERE platform = ? AND model_id = ? AND endpoint_scope = ? AND capability = ?
    `).get(platform, modelId, endpointScope, capability) as { verdict: string; detail: string | null } | undefined;
    if (row?.verdict === 'failed') return { capability, detail: row.detail };
  }
  return null;
}

/** Persist one capability verdict, replacing any earlier one for that route. */
export function recordCapabilityProbe(
  key: ProbeKey,
  result: Pick<ProbeResult, 'verdict' | 'detail' | 'latencyMs'>,
  db: Db = getDb(),
  now: number = Date.now(),
): CapabilityState {
  // `untested` means no key was scoped to the model — a statement about our
  // credentials, not about the model's eyes. Recording it as failed would
  // libel the route, so nothing is written and it stays unverified.
  if (result.verdict === 'untested') return 'unverified';
  // `limited` is a 429 or a transport wobble: the capability question was never
  // actually answered, so it is not an answer to store either.
  if (result.verdict === 'limited') return 'unverified';
  const verdict: 'ok' | 'failed' = result.verdict === 'ok' ? 'ok' : 'failed';
  db.prepare(`
    INSERT INTO model_capability_probe
      (platform, model_id, endpoint_scope, capability, verdict, detail, latency_ms, probed_at_ms)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(platform, model_id, endpoint_scope, capability) DO UPDATE SET
      verdict = excluded.verdict,
      detail = excluded.detail,
      latency_ms = excluded.latency_ms,
      probed_at_ms = excluded.probed_at_ms
  `).run(
    key.platform, key.modelId, key.endpointScope, key.capability,
    verdict, result.detail, result.latencyMs, now,
  );
  return verdict;
}

export interface CapabilityProbeOutcome {
  platform: string;
  modelId: string;
  endpointScope: string;
  capability: Capability;
  state: CapabilityState;
  detail: string | null;
  latencyMs: number | null;
}

/**
 * Probe one route for one capability and record the answer.
 *
 * `tools` is declared by six of the eight chains and is NOT probed here. A
 * tools probe means sending a function schema and then deciding whether the
 * absence of a tool_call is a refusal or a model legitimately choosing not to
 * call one — a real design question, and a stub that guessed would put a wrong
 * verdict on record, which is worse than the honest `unverified` the audit
 * already reports. The audit's unverified count for tool-requiring chains is
 * the measurement that decides whether designing it is worth it.
 */
export async function probeCapability(
  platform: string,
  modelId: string,
  endpointScope: string,
  capability: Capability,
  db: Db = getDb(),
): Promise<CapabilityProbeOutcome> {
  if (capability !== 'vision') {
    return { platform, modelId, endpointScope, capability, state: 'unverified', detail: 'No probe implemented for this capability', latencyMs: null };
  }
  const result = await probeModelVision(platform, modelId, db);
  const state = recordCapabilityProbe({ platform, modelId, endpointScope, capability }, result, db);
  return { platform, modelId, endpointScope, capability, state, detail: result.detail, latencyMs: result.latencyMs };
}

/**
 * Verify every member of one chain against that chain's contracts.
 *
 * The deliberate, bounded action an operator reaches for after a recuration —
 * which is precisely when the nemotron-parse-2.0 route was introduced. Bounded
 * by construction: one chain, one call per member per unprobed contract.
 */
export async function verifyChain(chain: string, db: Db = getDb()): Promise<CapabilityProbeOutcome[]> {
  const requires = requiredCapabilities(chain);
  const out: CapabilityProbeOutcome[] = [];
  if (!requires.length) return out;
  for (const row of chainMembers(db, chain)) {
    for (const capability of requires) {
      out.push(await probeCapability(row.platform, row.model_id, row.endpoint_scope, capability, db));
    }
  }
  return out;
}
