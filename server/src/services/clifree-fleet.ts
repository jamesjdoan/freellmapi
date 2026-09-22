// Free CLI-agent fleet telemetry — store what each machine reports, and read
// it back for the panel.
//
// The server never goes and looks. It cannot: the container has exactly one
// mount, the data volume, so it has no access to ~/.clifree-cooldowns, the
// `opencode` or `cline` binaries, or clifree-rank.sh. Each machine reports its
// own state and this module stores what it is told. See
// docs/adr/ARCH-20260922-clifree-fleet-telemetry.md.
//
// 🛑 OBSERVATION ONLY. Every route described here is one FreeLLM cannot call —
// Zen's free tier answers 403 to callers outside OpenCode, and Cline's free
// models are not served through its API at all. Nothing in this module may be
// joined into routing, fallback, curation or model-picker queries. It exists so
// an operator can SEE the free fleet, never so the router can reach it.

import type { Db } from '../db/types.js';
import type { CompareGroup } from './analysis.js';
import { lookupAa } from './analysis.js';

/** One route as a reporting machine observed it. */
export type FleetRoute = {
  /** `provider:id`, split on the FIRST colon — Cline ids contain their own. */
  spec: string;
  class: string | null;
  intelligence: number | null;
  /** 'exact' | 'proxy'. A proxy score is an estimate for a related variant. */
  matchQuality: string | null;
  /** 'ok' | 'fail' | 'notools' | 'unprobed'. */
  reachability: string;
  /** Absolute epoch ms, or null when not benched. Never "minutes left". */
  coolingUntilMs: number | null;
  coolingReason: string | null;
  /** The aa_model slug the ranker matched, or null when unrated. Stored rather
   *  than the metrics themselves: aa_model is refreshed by benchmark sync, and
   *  a copy taken at delivery would drift while still looking authoritative. */
  benchmarkSlug: string | null;
};

export type FleetDelivery = {
  /** `hostname -s` on the reporting machine. */
  machine: string;
  observedAtMs: number;
  routes: FleetRoute[];
};
const REACHABILITY: Record<string, true> = { ok: true, fail: true, notools: true, unprobed: true };

/** Thrown for a malformed delivery. The caller maps this to a 400. */
export class FleetDeliveryError extends Error {}

/**
 * Validate a delivery before it touches the database.
 *
 * Deliberately strict about `spec`: a spec with no colon cannot be split into
 * provider and id, and storing one would produce a row the panel cannot group
 * and nobody can trace back to a provider.
 */
export function parseDelivery(body: unknown): FleetDelivery {
  if (typeof body !== 'object' || body === null) throw new FleetDeliveryError('body must be an object');
  const b = body as Record<string, unknown>;

  const machine = typeof b.machine === 'string' ? b.machine.trim() : '';
  if (!machine) throw new FleetDeliveryError('machine is required');

  const observedAtMs = typeof b.observedAtMs === 'number' ? b.observedAtMs : NaN;
  if (!Number.isFinite(observedAtMs)) throw new FleetDeliveryError('observedAtMs must be a number');

  if (!Array.isArray(b.routes)) throw new FleetDeliveryError('routes must be an array');

  const routes: FleetRoute[] = b.routes.map((raw, i) => {
    if (typeof raw !== 'object' || raw === null) throw new FleetDeliveryError(`routes[${i}] must be an object`);
    const r = raw as Record<string, unknown>;

    const spec = typeof r.spec === 'string' ? r.spec.trim() : '';
    if (!spec.includes(':')) {
      throw new FleetDeliveryError(`routes[${i}].spec must be provider:id, got ${JSON.stringify(r.spec)}`);
    }

    const reachability = typeof r.reachability === 'string' ? r.reachability : 'unprobed';
    if (!REACHABILITY[reachability]) {
      throw new FleetDeliveryError(`routes[${i}].reachability must be one of ${Object.keys(REACHABILITY).join(', ')}`);
    }

    const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
    const str = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null);

    return {
      spec,
      class: str(r.class),
      intelligence: num(r.intelligence),
      matchQuality: str(r.matchQuality),
      reachability,
      coolingUntilMs: num(r.coolingUntilMs),
      coolingReason: str(r.coolingReason),
      benchmarkSlug: str(r.benchmarkSlug),
    };
  });

  return { machine, observedAtMs, routes };
}

/**
 * Replace one machine's rows wholesale.
 *
 * A roster is a statement about NOW, so a delivery REPLACES rather than merges:
 * a route that has left the free roster must disappear from the panel, not
 * linger because the last delivery that mentioned it is still the newest row
 * for that spec. Scoped to the reporting machine only — one machine reporting
 * must never disturb another's rows, which is the whole point of the fleet view.
 *
 * Transactional so a failed delivery cannot leave a machine with its old rows
 * deleted and its new ones missing, which would read as "this machine has no
 * free routes" — indistinguishable from a real and alarming state.
 */
export function recordDelivery(db: Db, delivery: FleetDelivery): number {
  const del = db.prepare('DELETE FROM clifree_fleet_snapshot WHERE machine = ?');
  const ins = db.prepare(`
    INSERT INTO clifree_fleet_snapshot
      (machine, spec, provider, class, intelligence, match_quality,
       reachability, cooling_until_ms, cooling_reason, observed_at_ms, benchmark_slug)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const run = db.transaction((d: FleetDelivery) => {
    del.run(d.machine);
    for (const r of d.routes) {
      // Split on the FIRST colon only. `cline:cohere/north-mini-code:free`
      // is provider `cline`, id `cohere/north-mini-code:free`.
      const provider = r.spec.slice(0, r.spec.indexOf(':'));
      ins.run(
        d.machine, r.spec, provider, r.class, r.intelligence, r.matchQuality,
        r.reachability, r.coolingUntilMs, r.coolingReason, d.observedAtMs, r.benchmarkSlug,
      );
    }
    return d.routes.length;
  });

  return run(delivery);
}

export type FleetRow = FleetRoute & { machine: string; provider: string; observedAtMs: number };

/**
 * Every machine's current view, newest observation first.
 *
 * Returns rows as delivered, including cooldowns that have since expired. The
 * caller renders staleness from `observedAtMs`; this module does not quietly
 * hide a row for being old, because a machine that stopped reporting is itself
 * the finding.
 */
export function listFleet(db: Db): FleetRow[] {
  const rows = db.prepare(`
    SELECT machine, spec, provider, class, intelligence, match_quality AS matchQuality,
           reachability, cooling_until_ms AS coolingUntilMs, cooling_reason AS coolingReason,
           observed_at_ms AS observedAtMs, benchmark_slug AS benchmarkSlug
      FROM clifree_fleet_snapshot
     ORDER BY observed_at_ms DESC, machine, intelligence DESC
  `).all() as FleetRow[];
  return rows;
}

/**
 * Fleet routes shaped as comparison entries, so they rank and plot alongside
 * everything else.
 *
 * `reference: true` is not a label of convenience — it is the page's existing
 * contract for "a row we do not serve", and it is what suppresses the chain
 * and scope controls. A free CLI route must never carry those: FreeLLM cannot
 * call it, so a chain assignment would produce a slot that silently never
 * serves. Pinned baselines already work exactly this way, which is why fleet
 * routes and baselines can sit in one comparison without special-casing either.
 *
 * One entry per SPEC, not per machine-and-spec. Capability is a property of the
 * model; which machines can currently reach it is a property of the fleet, and
 * belongs in the fleet table rather than duplicated down the rank list.
 */
/**
 * Operator overrides of the benchmark a free route maps to, spec -> slug.
 *
 * A settings document rather than a table: it is bounded by the roster (28
 * routes today), it is a decision the operator made rather than measured data,
 * and it must survive the snapshot being replaced on every delivery -- which a
 * column on clifree_fleet_snapshot would not, since a delivery deletes the
 * machine's rows wholesale.
 *
 * `null` is a meaningful value: "this route has no counterpart", which stops
 * the reporter's automatic match being reapplied on the next delivery.
 */
const LINKS_KEY = 'clifree_fleet_links';

export function getFleetLinks(db: Db): Record<string, string | null> {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(LINKS_KEY) as { value: string } | undefined;
  if (!row) return {};
  try {
    const parsed: unknown = JSON.parse(row.value);
    return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, string | null>) : {};
  } catch {
    // A corrupt document must not take the panel down with it. An empty map
    // means "no overrides", which is the same state as a fresh install.
    return {};
  }
}

export function setFleetLink(db: Db, spec: string, aaSlug: string | null): Record<string, string | null> {
  const links = getFleetLinks(db);
  links[spec] = aaSlug;
  db.prepare(`INSERT INTO settings (key, value) VALUES (?, ?)
              ON CONFLICT(key) DO UPDATE SET value = excluded.value`)
    .run(LINKS_KEY, JSON.stringify(links));
  return links;
}

export function getFleetGroups(db: Db): CompareGroup[] {
  const specs = db.prepare(`
    SELECT spec, provider, class, benchmark_slug AS benchmarkSlug
      FROM clifree_fleet_snapshot
     GROUP BY spec, provider, class, benchmark_slug
  `).all() as { spec: string; provider: string; class: string | null; benchmarkSlug: string | null }[];

  // Merged on the BENCHMARK, not the spec. Several free routes resolve to one
  // model -- opencode:nemotron-3-ultra-free and
  // cline:nvidia/nemotron-3-ultra-550b-a55b:free are the same 22.9 -- and
  // listing each separately answers "how many ways can I reach it", which is
  // not the question a capability table is read for. One row per capability;
  // the specs that reach it travel on the row.
  //
  // Unrated routes have no benchmark to merge on and stay per-spec: collapsing
  // them would fuse genuinely different models under one empty score.
  const links = getFleetLinks(db);
  for (const s of specs) {
    // An override wins over the reporter's automatic match, including an
    // explicit null meaning "no counterpart".
    if (Object.prototype.hasOwnProperty.call(links, s.spec)) s.benchmarkSlug = links[s.spec];
  }

  const byBenchmark = new Map<string, typeof specs>();
  for (const s of specs) {
    const key = s.benchmarkSlug ?? `unrated:${s.spec}`;
    const list = byBenchmark.get(key);
    if (list) list.push(s);
    else byBenchmark.set(key, [s]);
  }

  return [...byBenchmark.entries()].map(([key, group]) => {
    const first = group[0];
    const analysis = first.benchmarkSlug ? lookupAa(db, first.benchmarkSlug) : null;
    return {
      groupKey: `fleet:${key}`,
      canonicalId: `fleet:${key}`,
      // The benchmark's name where there is one: `cline:qwen/qwen3.8-27b:free`
      // is a route identifier, not something a person reads down a column.
      name: analysis?.name ?? first.spec.slice(first.spec.indexOf(':') + 1),
      userDefined: false,
      members: [],
      analysis,
      analysisSource: analysis ? ('own' as const) : null,
      conflicted: false,
      chains: [],
      chainRanks: {},
      enabledMembers: 0,
      keyedMembers: 0,
      reference: true,
      /** Every free route that reaches this capability. */
      fleetSpecs: group.map(g => g.spec).sort(),
    };
  });
}
