import { z } from 'zod';
import type { Db } from '../db/types.js';
import { CHAIN_CONTRACTS, type ChainName } from '../data/routing-curation.js';

// Operator-set minimum AA scores per chain, used ONLY to recommend where a
// model fits. Nothing here routes, admits or removes anything: chains keep
// their own membership (profile_models) and this document never touches it.
//
// Capability is AA's alone (aa_model, via aa_model_link). Price, free status,
// quota and provider availability are not inputs, by construction: the
// document has nowhere to put them.
//
// The live document is one JSON value in settings; every save is also
// appended to chain_minimum_revision, so a past recommendation can be
// reconstructed from the revision in force plus aa_measurement at the time.

export const SETTING_KEY = 'imperium_chain_minimums';

/** Every chain takes minimums. Fast-Lane was once reserved because it is
 *  ordered on measured latency rather than capability; it takes floors now so
 *  its members can be compared on capability too (James, 2026-10-21). */
export type GradedChain = ChainName;
export const GRADED_CHAINS: readonly GradedChain[] = ['Apex', 'Frontier', 'Workhorse', 'Default', 'Coding', 'Vision', 'Extra-Tier', 'Fast-Lane'];

const score = z.number().min(0).max(100).nullable();
export const MINIMUM_METRICS = ['general', 'coding', 'agentic'] as const;
export type MinimumMetric = typeof MINIMUM_METRICS[number];
const chainMinimums = z.object({
  /** AA Intelligence Index floor; null = no requirement on this metric. */
  general: score,
  coding: score,
  agentic: score,
  /** Whether an operator-set proxy estimate may satisfy a minimum. */
  acceptEstimated: z.boolean(),
  /** Metrics that are alternatives rather than requirements: a model needs
   *  every set minimum NOT listed here, plus at least ONE that is ("general
   *  AND (coding OR agentic)"). Empty = every set minimum is required, which
   *  is how a document saved before this field reads. */
  either: z.array(z.enum(MINIMUM_METRICS)).max(MINIMUM_METRICS.length).default([]),
}).strict();
export type ChainMinimums = z.infer<typeof chainMinimums>;

const chainsSchema = z.object(Object.fromEntries(GRADED_CHAINS.map(c => [c, chainMinimums])) as Record<GradedChain, typeof chainMinimums>).strict();

export interface ChainMinimumsDoc {
  version: 1;
  /** 0 = never saved (the defaults below, not yet a decision anyone made). */
  revision: number;
  savedAt: string | null;
  chains: Record<GradedChain, ChainMinimums>;
}

// Starting points from the 2026-09-25 distribution audit of AA v4.3. They are
// a draft to tune, not a policy: revision 0 is marked as never saved.
const off = { general: null, coding: null, agentic: null, acceptEstimated: false, either: [] };
export const DEFAULT_CHAINS: Record<GradedChain, ChainMinimums> = {
  Apex: { ...off, general: 45 },
  Frontier: { ...off, general: 35 },
  Workhorse: { ...off, general: 25 },
  Default: { ...off, general: 25 },
  Coding: { ...off, coding: 45, agentic: 30 },
  Vision: { ...off, general: 25 },
  'Extra-Tier': { ...off, general: 20 },
  // Short, bounded work (commit messages, summaries): a low general floor
  // keeps a fast but weak route out without ruling out small models.
  'Fast-Lane': { ...off, general: 15 },
};

function defaults(): ChainMinimumsDoc {
  return { version: 1, revision: 0, savedAt: null, chains: structuredClone(DEFAULT_CHAINS) };
}

/** Parse a stored chains object. A chain the document predates (Fast-Lane,
 *  before 2026-10-21) takes its default rather than invalidating the rest. */
function readChains(raw: unknown): Record<GradedChain, ChainMinimums> | null {
  if (raw == null || typeof raw !== 'object') return null;
  const parsed = chainsSchema.safeParse({ ...structuredClone(DEFAULT_CHAINS), ...raw });
  return parsed.success ? parsed.data : null;
}

export function getChainMinimums(db: Db): ChainMinimumsDoc {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(SETTING_KEY) as { value: string } | undefined;
  if (!row) return defaults();
  try {
    const parsed = JSON.parse(row.value) as ChainMinimumsDoc;
    const chains = readChains(parsed.chains);
    if (parsed.version === 1 && chains && Number.isInteger(parsed.revision)) {
      return { version: 1, revision: parsed.revision, savedAt: parsed.savedAt ?? null, chains };
    }
  } catch { /* unreadable document: fall through to defaults, loudly below */ }
  console.warn(`[chain-minimums] ${SETTING_KEY} is unreadable; showing defaults until the next save`);
  return defaults();
}

export const saveSchema = z.object({
  /** Compare-and-set: the revision the editor started from. */
  expectedRevision: z.number().int().min(0),
  chains: chainsSchema,
}).strict();

export class RevisionConflict extends Error {
  constructor(readonly current: number) { super(`Minimums were saved elsewhere (now revision ${current})`); }
}

export function saveChainMinimums(db: Db, input: z.infer<typeof saveSchema>): ChainMinimumsDoc {
  return db.transaction(() => {
    const current = getChainMinimums(db);
    if (current.revision !== input.expectedRevision) throw new RevisionConflict(current.revision);
    const next: ChainMinimumsDoc = {
      version: 1,
      revision: current.revision + 1,
      savedAt: new Date().toISOString(),
      chains: input.chains,
    };
    const json = JSON.stringify(next);
    db.prepare(`INSERT INTO settings (key, value) VALUES (?, ?)
                ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(SETTING_KEY, json);
    db.prepare('INSERT INTO chain_minimum_revision (revision, saved_at, doc_json) VALUES (?, ?, ?)')
      .run(next.revision, next.savedAt, json);
    return next;
  })();
}

export function listRevisions(db: Db, limit = 50): { revision: number; savedAt: string }[] {
  return db.prepare('SELECT revision, saved_at AS savedAt FROM chain_minimum_revision ORDER BY revision DESC LIMIT ?')
    .all(limit) as { revision: number; savedAt: string }[];
}

export function getRevision(db: Db, revision: number): ChainMinimumsDoc | null {
  const row = db.prepare('SELECT doc_json FROM chain_minimum_revision WHERE revision = ?').get(revision) as { doc_json: string } | undefined;
  if (!row) return null;
  const doc = JSON.parse(row.doc_json) as ChainMinimumsDoc;
  return { ...doc, chains: readChains(doc.chains) ?? doc.chains };
}

/** What each chain structurally requires, from the curation contracts, so a
 *  recommendation never says "fits Apex" for a model that cannot call tools. */
export function chainRequirements(): { name: ChainName; requiresTools: boolean; requiresVision: boolean }[] {
  return CHAIN_CONTRACTS.map(c => ({
    name: c.name,
    requiresTools: c.requiresTools,
    requiresVision: c.requiresVision,
  }));
}
