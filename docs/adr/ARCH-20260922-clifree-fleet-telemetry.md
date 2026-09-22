# ARCH-20260922-clifree-fleet-telemetry

## Decision

Make the free CLI-agent rosters (OpenCode Zen, Cline) **visible** in FreeLLM without making
them **routable** through it. Two surfaces, deliberately split:

- **O1 — FreeLLM panel.** Each machine pushes its clifree state to FreeLLM over the existing
  Tailscale network. FreeLLM stores it per machine and renders roster, reachability, cooldowns,
  and usage on an extension of `CompareModelsPage`.
- **O3 — CLI surface.** A combined `clifree-rank.sh` view an agent can read mid-task, so a
  delegation decision does not require the dashboard.

## Context

James, asked what breaks today:

> "cant see no idea which models availble in the clifree endpoints, hard to see capabilities of
> delagating, also no way to minotr use and how much on each manchone the mac studio and mbp etc"

Three distinct gaps, and the third is the one that shapes the design:

1. **Roster opacity.** 28 free routes exist across two providers and rotate without notice.
   Today the only way to see them is running `clifree-rank.sh` in a terminal.
2. **Capability opacity at the point of decision.** Choosing a class to delegate at means
   knowing what each free route scores. The ranker prints it; an agent mid-task rarely looks.
3. **No fleet view.** The Mac Studio and the MBP each spend the *same* free accounts from
   different machines. Nothing attributes usage, quota exhaustion or reachability to a machine,
   so "are we out of Cline quota" has no answer, and neither does "which machine spent it".

Measured 2026-09-22:

- **The container is isolated.** `freellmapi-freellmapi-1` has exactly one mount, the data
  volume at `/app/server/data`. It cannot read `~/.clifree-cooldowns`, cannot execute
  `clifree-rank.sh`, and cannot reach the `opencode` or `cline` binaries. Today data flows the
  other way — `clifree-rank.sh` reaches *into* the container via `docker exec` for the
  Artificial Analysis cache. A UI panel needs the reverse, which Docker blocks by design.
- **A host mount was rejected as the mechanism.** It would couple the container to one host's
  filesystem layout, break the documented "recreate the container with its existing data
  volume" workflow, and be machine-specific — and machine-specific is precisely what a fleet
  view must not be.
- **The network already exists.** The MBP reaches this machine over Tailscale (`100.93.164.27`
  in the current session). A push from a second machine needs no new transport, only an
  endpoint and a credential.
- **A host surface already exists.** `CompareModelsPage.tsx`, plus the measured-benchmark work
  that already renders proxy scores for unpublished models — the same scores
  `clifree-rank.sh` reads.

## YC Forcing Questions

**Demand reality:** → Answered above, with the fleet gap as the sharpest. The first two gaps
are inconvenience; the third is unanswerable without new plumbing, because no single machine
holds the information. This is the part that cannot be solved by printing more in a terminal.

**Narrowest wedge:** → Both surfaces, because they answer different questions at different
moments. O3 is near-free: `clifree-rank.sh` already computes roster, class and reachability,
and `-s` already prints cooldowns; combining them is a view, not a subsystem. O1 is the real
build, and its wedge is **push + store + one read-only panel** — no charts, no retention
policy, no alerting until the panel has proven it gets looked at.

**Future-fit:** → James: *"yes to monitor each provider relaibility models etc"*. This reframes
it. Cline's promotion is explicitly limited-time, so a UI built around *Cline* would rot with
it — but a panel built around **provider reliability over time** outlives any single provider.
When Cline's promotion ends, the row disappears and the surface still answers the question for
whatever replaces it. The schema must therefore be keyed on provider+route+machine, never on
Cline specifically.

## Consequences

**Makes easier:** One place that answers "what is free right now, is it reachable, who spent
it". Delegation decisions stop depending on someone running a terminal command. Provider
reliability becomes a measured trend rather than an impression.

**Makes harder:**

- A second write path into FreeLLM from outside the container, which needs authentication. The
  dashboard currently binds `127.0.0.1:3001`; accepting a push from the MBP means listening on
  the Tailscale interface, and that is a security boundary change, not a feature.
- A new table plus a migration, and `server/src/db/migrate/defaults.ts` and the migration
  manifest are the known conflict hotspot on this branch (19 conflicts on the manifest alone
  during the v0.11.0 take). One migration, appended, registered, re-read after writing.
- Staleness is now a visible property. The panel shows the last push time per machine, because
  a fleet view that silently renders week-old data is worse than no fleet view.

🛑 **The hazard this design must not create.** `jd-clifree` carries a standing mandate:
*"Neither can be a FreeLLM provider"* and *"Never edit FreeLLM routing to reach these"* — Zen
answers `403 FreeTierError`, Cline's docs say free models are not served through its API. That
guard took four benchmark iterations to make stick. Rendering these routes inside the FreeLLM
dashboard risks teaching the opposite. **The panel must state, on its own surface, that these
routes are observable here and not callable here**, and must never appear in a routing,
fallback or model-picker control.

## Extension registry

One new entry, per the registry contract in `shared/extension-registry.ts`:

- `id: 'clifree-fleet-telemetry'` — never renamed once shipped.
- `category: 'tooling'` — the union in `shared/extension-registry.ts` is `presentation | routing | safety | tooling`; there is no `observability`. `tooling` is the fit: *"Operator tooling outside the request path. Off = the command refuses."* Rejected `presentation`, which would imply off merely hides a UI while ingest keeps running — collecting telemetry nobody can see is waste.
- `defaultEnabled: true`.
- `offBehaviour`: the ingest endpoint refuses the delivery and the panel is hidden; **rows already
  stored are retained**, and the migration still runs. Off stops collection, never deletes.
- `takesEffect`: next request for the endpoint, next page load for the panel.
- `disableConfirmation: 'none'` — nothing here spends money.

## Testing seam

Existing seam, extended: the push endpoint is an ordinary route and gets route-level tests
alongside the others. The reporter is a shell script and uses the stub-binary technique already
used by `opencode-ask.test.sh` and the `classify_failure` tests — no live quota spent. One
entry point, no new seam.

## Open question for Pass 2, not decided here

Whether the reporter pushes on a timer or as a post-delegation hook in `clifree-ask.sh`. A hook
gives exact per-call usage attribution and couples telemetry to the delegation path; a timer is
decoupled but samples, and would miss a quota exhaustion that resolved between polls. Leaning
hook-for-usage plus timer-for-roster, but that is an implementation decision.

## Status

APPROVED 2026-09-22 — Pass 1 complete.

**O3 (CLI surface) is unblocked** and may be built now: it needs no network change, no
migration and no new endpoint.

**O1 transport decided 2026-09-22: SSH delivery, not a network endpoint.**

FreeLLM keeps binding `127.0.0.1:3001`. The MBP writes its snapshot and delivers it to the
Studio over SSH — already-authenticated, already-audited transport in daily use. A host-side
reporter on the Studio ingests both machines' snapshots into FreeLLM over localhost.

Rejected: listening on the Tailscale interface with a push credential. It turns the dashboard
from a local tool into a network service, and every later change inherits that surface. The
chosen route costs freshness — the MBP's data is as old as its last delivery — which is
acceptable for telemetry and reversible. Exposing the bind address is not reversible in the
same way.

O1's Pass 2 may now begin. Its wedge remains: deliver + ingest + one read-only panel. No
charts, no retention policy, no alerting until the panel proves it gets looked at.
