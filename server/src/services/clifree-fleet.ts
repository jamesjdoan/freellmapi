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

/** One route's consumption on one UTC day, as the reporting machine last read
 *  it from the agent's own store. Each delivery carries the machine's FULL
 *  history in these buckets — never deltas. See the per-day migration. */
export type FleetUsage = {
  spec: string;
  /** UTC calendar day, YYYY-MM-DD. */
  day: string;
  requests: number;
  inputTokens: number;
  outputTokens: number;
  /** What the AGENT said it billed. Diagnostic only: a non-zero figure on a
   *  free route means a free route charged money. Never a term in the value. */
  reportedCostUsd: number;
};

export type FleetDelivery = {
  /** `hostname -s` on the reporting machine. */
  machine: string;
  observedAtMs: number;
  routes: FleetRoute[];
  /** Empty from a reporter that predates usage reporting, which is a machine
   *  with no usage on record rather than a malformed delivery. */
  usage: FleetUsage[];
  /** Why a delivery's usage was set aside while its roster was kept, or null. */
  usageIgnored: string | null;
};

const DAY = /^\d{4}-\d{2}-\d{2}$/;
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

  // Usage is optional: an older reporter sends none, and refusing its roster
  // over a field it cannot know about would blind the panel to that machine
  // entirely. A present `usage` must still be well formed.
  //
  // Undated usage is a LIFETIME total from a reporter that predates per-day
  // buckets. It is set aside, not folded into one day: filing a machine's whole
  // history under today would inflate every window that includes today.
  let usageIgnored: string | null = null;
  const rawUsage: unknown[] = !('usage' in b) || b.usage == null ? [] : (() => {
    if (!Array.isArray(b.usage)) throw new FleetDeliveryError('usage must be an array');
    return b.usage;
  })();
  const undated = rawUsage.some(raw => typeof raw === 'object' && raw !== null && !('day' in raw));
  if (undated) usageIgnored = 'usage without `day` is lifetime totals from an older reporter; update clifree-report.sh';
  const usage: FleetUsage[] = undated ? [] : rawUsage.map((raw, i) => {
    if (typeof raw !== 'object' || raw === null) throw new FleetDeliveryError(`usage[${i}] must be an object`);
    const u = raw as Record<string, unknown>;
    const spec = typeof u.spec === 'string' ? u.spec.trim() : '';
    if (!spec.includes(':')) {
      throw new FleetDeliveryError(`usage[${i}].spec must be provider:id, got ${JSON.stringify(u.spec)}`);
    }
    if (typeof u.day !== 'string' || !DAY.test(u.day)) {
      throw new FleetDeliveryError(`usage[${i}].day must be YYYY-MM-DD, got ${JSON.stringify(u.day)}`);
    }
    // Counters floor at zero rather than throwing: a negative total is
    // nonsense the reporter should never send, and dropping the machine's
    // whole delivery over one is worse than recording it as no usage.
    const count = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0);
    return {
      spec,
      day: u.day,
      requests: Math.trunc(count(u.requests)),
      inputTokens: Math.trunc(count(u.inputTokens)),
      outputTokens: Math.trunc(count(u.outputTokens)),
      reportedCostUsd: count(u.reportedCostUsd),
    };
  });

  return { machine, observedAtMs, routes, usage, usageIgnored };
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
  const delUsage = db.prepare('DELETE FROM clifree_fleet_usage WHERE machine = ?');
  // A delivery naming the same (spec, day) twice is summed, not a constraint
  // failure: one malformed bucket must not throw away the machine's roster.
  const insUsage = db.prepare(`
    INSERT INTO clifree_fleet_usage
      (machine, spec, provider, day, requests, input_tokens, output_tokens, reported_cost_usd, observed_at_ms)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(machine, spec, day) DO UPDATE SET
      requests = requests + excluded.requests,
      input_tokens = input_tokens + excluded.input_tokens,
      output_tokens = output_tokens + excluded.output_tokens,
      reported_cost_usd = reported_cost_usd + excluded.reported_cost_usd
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

    // Usage is replaced in the SAME transaction and only when the delivery
    // carried some. A reporter that sends no usage leaves the machine's
    // existing totals alone: it is reporting a roster, not asserting that the
    // machine has never done any work.
    if (d.usage.length > 0) {
      delUsage.run(d.machine);
      for (const u of d.usage) {
        const provider = u.spec.slice(0, u.spec.indexOf(':'));
        insUsage.run(
          d.machine, u.spec, provider, u.day, u.requests, u.inputTokens,
          u.outputTokens, u.reportedCostUsd, d.observedAtMs,
        );
      }
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

/**
 * Dashboard device for a fleet machine's `hostname -s`.
 *
 * The Analytics page tabs by device, and `deviceSql` in routes/analytics.ts
 * derives it from the proxy's user agent (`omp-mbp…`, `omp-studio…`). Fleet
 * rows carry a hostname instead, so the two must land on the SAME labels or a
 * device tab would show one machine's proxy traffic beside another's CLI work.
 */
export function fleetDevice(machine: string): string {
  if (/macbook-?pro/i.test(machine)) return 'MacBook Pro';
  if (/mac-?studio/i.test(machine)) return 'Mac Studio';
  return machine;
}

/** One machine's consumption and what that inference was worth. */
export type FleetValueRow = {
  machine: string;
  /** Dashboard device label — see fleetDevice. */
  device: string;
  /** The machine's last delivery, from its snapshot rows; null if it never sent one. */
  reportedAtMs: number | null;
  requests: number;
  inputTokens: number;
  outputTokens: number;
  /**
   * USD market value of the inference this machine was given: the published
   * per-million rates of the model each route is benchmarked against, applied
   * to the tokens actually consumed.
   *
   * NOT what we paid, which is approximately nothing. `null` when no route on
   * this machine maps to a benchmark that publishes a price — a dash, never a
   * zero, because unpriced and worthless are different claims.
   */
  valueUsd: number | null;
  /** Specs excluded from `valueUsd` for want of a published price. Shown so a
   *  partial figure is never read as a complete one. */
  unpricedSpecs: number;
  /** What the agents said they billed. A free route billing money is an alarm;
   *  it is reported beside the value and never summed into it. */
  reportedCostUsd: number;
};

/** One route on one machine over the window, with the quality of the model. */
export type FleetUsageRow = {
  machine: string;
  device: string;
  spec: string;
  provider: string;
  /** From the machine's current roster; null once the route has left it. */
  class: string | null;
  intelligence: number | null;
  benchmarkSlug: string | null;
  requests: number;
  inputTokens: number;
  outputTokens: number;
  valueUsd: number | null;
  reportedCostUsd: number;
};

type Rate = { input: number; output: number };

/**
 * Spec -> benchmark slug and published rate, resolved the way the comparison
 * table resolves it: the route's `benchmark_slug`, overridden by an operator
 * link. Otherwise remapping a route on the panel would silently leave its value
 * computed against the old model.
 */
function makePricer(db: Db): { slugBySpec: Map<string, string | null>; rateFor: (spec: string) => Rate | null } {
  // Grouped rather than per machine: the benchmark is a property of the
  // model, identical on every machine that can reach it.
  const slugBySpec = new Map<string, string | null>();
  for (const r of db.prepare(
    'SELECT spec, benchmark_slug AS slug FROM clifree_fleet_snapshot GROUP BY spec, benchmark_slug',
  ).all() as { spec: string; slug: string | null }[]) {
    slugBySpec.set(r.spec, r.slug);
  }
  const links = getFleetLinks(db);
  for (const spec of Object.keys(links)) slugBySpec.set(spec, links[spec]);

  // One lookup per distinct benchmark, not per usage row.
  const priced = new Map<string, Rate | null>();
  const rateFor = (spec: string): Rate | null => {
    const slug = slugBySpec.get(spec);
    if (!slug) return null;
    const cached = priced.get(slug);
    if (cached !== undefined) return cached;
    const aa = lookupAa(db, slug);
    // Both halves required: pricing only one side would undercount every
    // route asymmetrically and still look like a real number.
    const rate = aa && aa.price1mInput != null && aa.price1mOutput != null
      ? { input: aa.price1mInput, output: aa.price1mOutput }
      : null;
    priced.set(slug, rate);
    return rate;
  };
  return { slugBySpec, rateFor };
}

/** Usage summed per (machine, spec) from `sinceDay` (YYYY-MM-DD, inclusive). */
function readUsage(db: Db, sinceDay: string) {
  return db.prepare(`
    SELECT machine, spec, provider,
           SUM(requests) AS requests,
           SUM(input_tokens) AS inputTokens, SUM(output_tokens) AS outputTokens,
           SUM(reported_cost_usd) AS reportedCostUsd
      FROM clifree_fleet_usage
     WHERE day >= ?
     GROUP BY machine, spec, provider
  `).all(sinceDay) as {
    machine: string; spec: string; provider: string; requests: number;
    inputTokens: number; outputTokens: number; reportedCostUsd: number;
  }[];
}

/**
 * Per-machine usage over the window, priced at the benchmark equivalent's
 * published rates.
 *
 * `sinceDay` is a UTC calendar day, so the window is day-granular: "24h" on the
 * page includes all of yesterday's bucket. The proxy's own figures are exact to
 * the second; the fleet's cannot be finer than the buckets the reporter sends.
 * Omitted, it covers all history.
 */
export function listFleetValue(db: Db, sinceDay = '0000-00-00'): FleetValueRow[] {
  const usage = readUsage(db, sinceDay);
  if (usage.length === 0) return [];
  const { rateFor } = makePricer(db);
  const reportedAt = new Map<string, number>();
  for (const r of db.prepare(
    'SELECT machine, MAX(observed_at_ms) AS at FROM clifree_fleet_snapshot GROUP BY machine',
  ).all() as { machine: string; at: number }[]) {
    reportedAt.set(r.machine, r.at);
  }

  const byMachine = new Map<string, FleetValueRow & { anyPriced: boolean }>();
  for (const u of usage) {
    let row = byMachine.get(u.machine);
    if (!row) {
      row = {
        machine: u.machine, device: fleetDevice(u.machine),
        reportedAtMs: reportedAt.get(u.machine) ?? null,
        requests: 0, inputTokens: 0, outputTokens: 0,
        valueUsd: 0, unpricedSpecs: 0, reportedCostUsd: 0, anyPriced: false,
      };
      byMachine.set(u.machine, row);
    }
    row.requests += u.requests;
    row.inputTokens += u.inputTokens;
    row.outputTokens += u.outputTokens;
    row.reportedCostUsd += u.reportedCostUsd;

    const rate = rateFor(u.spec);
    if (!rate) {
      row.unpricedSpecs += 1;
      continue;
    }
    row.anyPriced = true;
    row.valueUsd = (row.valueUsd ?? 0)
      + (u.inputTokens * rate.input + u.outputTokens * rate.output) / 1_000_000;
  }

  return [...byMachine.values()]
    .map(({ anyPriced, ...row }) => ({
      ...row,
      // Nothing priced at all is unknown, not zero.
      valueUsd: anyPriced ? Math.round((row.valueUsd ?? 0) * 100) / 100 : null,
      reportedCostUsd: Math.round(row.reportedCostUsd * 100) / 100,
    }))
    .sort((a, b) => a.machine.localeCompare(b.machine));
}

/**
 * Per-route usage over the window, with the class and AA score the machine's
 * roster currently gives that route — "which models did the work, and how good
 * are they". Most input tokens first, the order an operator scans in. Value is
 * kept to four places: a single delegation is often worth under a cent, and
 * rounding it to $0.00 would read as worthless.
 */
export function listFleetUsage(db: Db, sinceDay = '0000-00-00'): FleetUsageRow[] {
  const usage = readUsage(db, sinceDay);
  if (usage.length === 0) return [];
  const { slugBySpec, rateFor } = makePricer(db);
  const quality = db.prepare(
    'SELECT class, intelligence FROM clifree_fleet_snapshot WHERE machine = ? AND spec = ?',
  );
  return usage
    .map(u => {
      const q = quality.get(u.machine, u.spec) as { class: string | null; intelligence: number | null } | undefined;
      const rate = rateFor(u.spec);
      return {
        machine: u.machine,
        device: fleetDevice(u.machine),
        spec: u.spec,
        provider: u.provider,
        class: q?.class ?? null,
        intelligence: q?.intelligence ?? null,
        benchmarkSlug: slugBySpec.get(u.spec) ?? null,
        requests: u.requests,
        inputTokens: u.inputTokens,
        outputTokens: u.outputTokens,
        valueUsd: rate
          ? Math.round((u.inputTokens * rate.input + u.outputTokens * rate.output) / 1_000_000 * 10_000) / 10_000
          : null,
        reportedCostUsd: Math.round(u.reportedCostUsd * 100) / 100,
      };
    })
    .sort((a, b) => b.inputTokens - a.inputTokens || a.spec.localeCompare(b.spec));
}
