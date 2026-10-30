import { getSetting } from '../db/index.js';
import type { Db } from '../db/types.js';
import { deriveEstimates, type AaEstimate, type EstimateInput } from './aa-derive.js';
import type { CapabilityMetric } from './analysis-fetch.js';

// Which Artificial Analysis number each index cell shows, and how old it is
// (ADR ARCH-20261030-aa-score-archive-and-scoring-version).
//
// aa_model holds what AA publishes NOW. aa_score_archive holds the last value
// AA published for each (slug, metric, index_version), including versions and
// metrics AA has since stopped publishing. Every reader that ranks, grades or
// prints an AA index goes through here, so all of them show the same number
// with the same version.
//
// Two rules:
//
// - intelligence and index_cost_per_task are read under the PINNED scoring
//   version (`aa_scoring_version`). Scores from different major versions are
//   on different scales: v5.0 read 0.74x v4.3 at the median on 2026-10-29, and
//   some models moved up while others moved down. The chain minimums are set
//   on one scale. Changing the pin is an operator action, so a new upstream
//   version never re-ranks the chains by itself.
// - coding and agentic are no longer published by AA. When the current
//   snapshot has no value for a metric on any model, each model's last
//   published value is served from the archive, marked archived. While AA
//   still publishes a metric, a null stays null: AA has not measured that model.

export interface AaSourced {
  value: number | null;
  /** Index version the value belongs to, e.g. 'v4.3'. */
  version: string | null;
  /** When AA published it: the fetched_at of the sync that saw it. */
  asOf: string | null;
  /** True when the value is not in what AA publishes today. */
  archived: boolean;
  /** Coding and agentic only, and only when `value` is null: an estimate
   *  from a score AA does publish (services/aa-derive.ts). It is never
   *  copied into `value`, so nothing can mistake it for a measurement. */
  estimate?: AaEstimate | null;
}

export interface AaScoring {
  intelligence: AaSourced;
  coding: AaSourced;
  agentic: AaSourced;
  costPerTask: AaSourced;
}

export const SCORING_VERSION_SETTING = 'aa_scoring_version';

type ArchiveMetric = 'intelligence' | 'coding' | 'agentic' | 'index_cost_per_task';

const NONE: AaSourced = { value: null, version: null, asOf: null, archived: false };

/** The pinned scoring version, or null when no sync has pinned one yet. */
export function getScoringVersion(): string | null {
  return getSetting(SCORING_VERSION_SETTING) ?? null;
}

/** AA's `intelligence_index_version` number (4.3, 5) as the label we store
 *  ('v4.3', 'v5.0'). Always major.minor, so 5 and 5.0 are the same version. */
export function formatIndexVersion(n: number): string {
  return `v${Number.isInteger(n) ? n.toFixed(1) : String(n)}`;
}

/**
 * The scoring values for every slug in the current snapshot.
 *
 * A slug that AA has withdrawn from the snapshot gets no entry, even if the
 * archive still holds scores for it. That matches the mirror's existing rule:
 * a model AA no longer lists has no scores.
 */
export function loadAaScoring(db: Db, pinned: string | null = getScoringVersion()): Map<string, AaScoring> {
  const rows = db.prepare(`
    SELECT slug, index_version, fetched_at, intelligence_index, coding_index, agentic_index, index_cost_per_task,
           finance_index, strategy_ops_index, legal_index, healthcare_index, engineering_index, economics_index
      FROM aa_model
  `).all() as ({
    slug: string; index_version: string | null; fetched_at: string;
    intelligence_index: number | null; coding_index: number | null; agentic_index: number | null;
    index_cost_per_task: number | null;
  } & Record<string, unknown>)[];

  const archive = new Map<string, Map<ArchiveMetric, { version: string; value: number; measuredAt: string }[]>>();
  for (const a of db.prepare(`
    SELECT slug, metric, index_version, value, measured_at FROM aa_score_archive
     ORDER BY measured_at DESC, index_version DESC
  `).all() as { slug: string; metric: ArchiveMetric; index_version: string; value: number; measured_at: string }[]) {
    const bySlug = archive.get(a.slug) ?? new Map();
    const list = bySlug.get(a.metric) ?? [];
    list.push({ version: a.index_version, value: a.value, measuredAt: a.measured_at });
    bySlug.set(a.metric, list);
    archive.set(a.slug, bySlug);
  }

  // A metric counts as retired when the snapshot has no value for it on ANY
  // model. That is how coding and agentic look since 2026-10-29. It is read
  // from the data rather than hard-coded, so a metric AA brings back is
  // served fresh again.
  const published = db.prepare(`
    SELECT COUNT(coding_index) AS coding, COUNT(agentic_index) AS agentic FROM aa_model
  `).get() as { coding: number; agentic: number };
  const retired = { coding: rows.length > 0 && published.coding === 0, agentic: rows.length > 0 && published.agentic === 0 };

  const versioned = (
    r: (typeof rows)[number], metric: ArchiveMetric, current: number | null,
  ): AaSourced => {
    if (pinned == null || pinned === r.index_version) {
      return current == null ? { ...NONE, version: r.index_version } : { value: current, version: r.index_version, asOf: r.fetched_at, archived: false };
    }
    const hit = archive.get(r.slug)?.get(metric)?.find(a => a.version === pinned);
    return hit
      ? { value: hit.value, version: hit.version, asOf: hit.measuredAt, archived: true }
      : { ...NONE, version: pinned };
  };
  const lastPublished = (
    r: (typeof rows)[number], metric: 'coding' | 'agentic', current: number | null,
  ): AaSourced => {
    if (current != null) return { value: current, version: r.index_version, asOf: r.fetched_at, archived: false };
    if (!retired[metric]) return NONE;
    const hit = archive.get(r.slug)?.get(metric)?.[0];
    return hit ? { value: hit.value, version: hit.version, asOf: hit.measuredAt, archived: true } : NONE;
  };

  const out = new Map<string, AaScoring>();
  for (const r of rows) {
    out.set(r.slug, {
      intelligence: versioned(r, 'intelligence', r.intelligence_index),
      coding: lastPublished(r, 'coding', r.coding_index),
      agentic: lastPublished(r, 'agentic', r.agentic_index),
      costPerTask: versioned(r, 'index_cost_per_task', r.index_cost_per_task),
    });
  }
  attachEstimates(rows, out, pinned);
  return out;
}

const CAPABILITY_COLUMN: Record<CapabilityMetric, string> = {
  finance: 'finance_index',
  strategyOps: 'strategy_ops_index',
  legal: 'legal_index',
  healthcare: 'healthcare_index',
  engineering: 'engineering_index',
  economics: 'economics_index',
};

/**
 * Fill `estimate` on every coding and agentic cell that has no value.
 *
 * Inputs: intelligence on the pinned scale, intelligence as AA publishes it
 * now (when that is a different version), and the six capability indices.
 * Targets: the coding or agentic values held, which since 2026-10-29 are the
 * archived v4.3 ones. Only real values are inputs; an estimate never feeds
 * another estimate.
 */
function attachEstimates(
  rows: ({ slug: string; index_version: string | null; intelligence_index: number | null } & Record<string, unknown>)[],
  out: Map<string, AaScoring>,
  pinned: string | null,
): void {
  const inputs: EstimateInput[] = [];
  const scored = new Map<string, number>();
  let scoredVersion: string | null = null;
  for (const [slug, s] of out) {
    if (s.intelligence.value != null) { scored.set(slug, s.intelligence.value); scoredVersion ??= s.intelligence.version; }
  }
  if (scoredVersion) inputs.push({ basis: { kind: 'intelligence', version: scoredVersion }, values: scored });
  const current = new Map<string, number>();
  let currentVersion: string | null = null;
  for (const r of rows) {
    if (r.intelligence_index != null && r.index_version != null && r.index_version !== (pinned ?? r.index_version)) {
      current.set(r.slug, r.intelligence_index);
      currentVersion ??= r.index_version;
    }
  }
  if (currentVersion) inputs.push({ basis: { kind: 'intelligence', version: currentVersion }, values: current });
  for (const [capability, column] of Object.entries(CAPABILITY_COLUMN) as [CapabilityMetric, string][]) {
    const values = new Map<string, number>();
    for (const r of rows) if (typeof r[column] === 'number') values.set(r.slug, r[column] as number);
    inputs.push({ basis: { kind: 'capability', capability }, values });
  }

  for (const metric of ['coding', 'agentic'] as const) {
    const targets = new Map<string, number>();
    const versions = new Map<string, number>();
    for (const [slug, s] of out) {
      const cell = s[metric];
      if (cell.value == null) continue;
      targets.set(slug, cell.value);
      if (cell.version) versions.set(cell.version, (versions.get(cell.version) ?? 0) + 1);
    }
    const targetVersion = [...versions].sort((x, y) => y[1] - x[1])[0]?.[0] ?? null;
    for (const [slug, estimate] of deriveEstimates(out.keys(), targets, inputs, targetVersion)) {
      const s = out.get(slug)!;
      s[metric] = { ...s[metric], estimate };
    }
  }
}

/** Archived intelligence coverage per version, for the status surface. */
export function archiveCoverage(db: Db): { version: string; intelligence: number; coding: number; agentic: number }[] {
  return db.prepare(`
    SELECT index_version AS version,
           SUM(metric = 'intelligence') AS intelligence,
           SUM(metric = 'coding') AS coding,
           SUM(metric = 'agentic') AS agentic
      FROM aa_score_archive
     GROUP BY index_version
     ORDER BY MAX(measured_at) DESC
  `).all() as { version: string; intelligence: number; coding: number; agentic: number }[];
}
