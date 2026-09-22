// Migration: clifree_fleet_snapshot — what each MACHINE can reach, and spent.
// Created: 2026-09-22
//
// DOWN: reversible — drops only what it creates.
//
// The Mac Studio and the MBP spend the SAME free accounts from different
// machines. Nothing attributed usage, quota exhaustion or reachability to
// either, so "are we out of Cline quota, and who spent it" had no answer:
// each machine holds half the evidence and neither can see the other's.
// That is the question this table exists for, and it is the only one of the
// three gaps in ARCH-20260922-clifree-fleet-telemetry that a better terminal
// command could not have closed.
//
// WHY A TABLE FED BY DELIVERY, NOT A READ AT QUERY TIME
//
// The server cannot go and look. `freellmapi-freellmapi-1` has exactly one
// mount — the data volume at /app/server/data. It cannot read
// ~/.clifree-cooldowns, cannot execute clifree-rank.sh, and cannot reach the
// `opencode` or `cline` binaries. Today data flows the other way: the ranker
// reaches INTO the container for the Artificial Analysis cache. So each
// machine reports its own state and the server stores what it is told.
//
// A host mount was rejected: it would couple the container to one host's
// filesystem layout and break the documented "recreate the container with its
// existing data volume" workflow. Machine-specific is exactly what a FLEET
// view must not be.
//
// SNAPSHOTS, NOT EVENTS
//
// One current row per (machine, spec). A delivery replaces a machine's rows
// wholesale, because a roster is a statement about NOW: a route that vanished
// from the free roster should disappear from the panel, not linger as a stale
// event. History is deliberately out of the wedge — see the ADR. `observed_at_ms`
// is what makes staleness visible, and a fleet view that silently renders
// week-old data is worse than no fleet view.
//
// `machine` is TEXT, not an enum. It is `hostname -s` at report time, so a
// third machine appears by reporting rather than by a migration.
//
// NOT ROUTABLE. These rows describe routes that FreeLLM cannot call — Zen's
// free tier answers 403 to callers outside OpenCode, and Cline's free models
// are not served through its API at all. Nothing here may be joined into
// routing, fallback or model-picker queries. The panel is observation only.

import type { Db } from '../types.js';

export function up(db: Db): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS clifree_fleet_snapshot (
      -- \`hostname -s\` on the reporting machine.
      machine TEXT NOT NULL,
      -- provider:id, split on the FIRST colon. Cline ids contain their own,
      -- e.g. cline:cohere/north-mini-code:free.
      spec TEXT NOT NULL,
      -- Denormalised from spec so the panel can group without re-parsing a
      -- format whose delimiter is ambiguous by construction.
      provider TEXT NOT NULL,
      -- Capability class from the ranker, e.g. 'sol-class'. NULL when the
      -- model carries no benchmark and the ranker calls it unrated.
      class TEXT,
      intelligence REAL,
      -- 'exact' or 'proxy'. A proxy score is an estimate for a related
      -- variant and must not be rendered as measured.
      match_quality TEXT,
      -- Reachability, measured by the reporter: 'ok' | 'fail' | 'notools' |
      -- 'unprobed'. Distinct from availability below: a route can be perfectly
      -- reachable AND benched. 'notools' is permanent — the agent always sends
      -- tools and that endpoint cannot take them.
      reachability TEXT NOT NULL DEFAULT 'unprobed',
      -- Cooldown expiry in epoch ms, NULL when not benched. Stored as an
      -- ABSOLUTE time, never "minutes left": a delivery is read long after it
      -- was written and a relative figure would age silently.
      cooling_until_ms INTEGER,
      cooling_reason TEXT,
      -- When the reporting machine observed this. Staleness is a property the
      -- panel must show, so it is stored per row rather than inferred.
      observed_at_ms INTEGER NOT NULL,
      PRIMARY KEY (machine, spec)
    );
    CREATE INDEX IF NOT EXISTS idx_clifree_fleet_snapshot_provider
      ON clifree_fleet_snapshot(provider, class);
  `);
}

export function down(db: Db): void {
  db.exec(`
    DROP INDEX IF EXISTS idx_clifree_fleet_snapshot_provider;
    DROP TABLE IF EXISTS clifree_fleet_snapshot;
  `);
}
