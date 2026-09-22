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
       reachability, cooling_until_ms, cooling_reason, observed_at_ms)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const run = db.transaction((d: FleetDelivery) => {
    del.run(d.machine);
    for (const r of d.routes) {
      // Split on the FIRST colon only. `cline:cohere/north-mini-code:free`
      // is provider `cline`, id `cohere/north-mini-code:free`.
      const provider = r.spec.slice(0, r.spec.indexOf(':'));
      ins.run(
        d.machine, r.spec, provider, r.class, r.intelligence, r.matchQuality,
        r.reachability, r.coolingUntilMs, r.coolingReason, d.observedAtMs,
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
           observed_at_ms AS observedAtMs
      FROM clifree_fleet_snapshot
     ORDER BY observed_at_ms DESC, machine, intelligence DESC
  `).all() as FleetRow[];
  return rows;
}
