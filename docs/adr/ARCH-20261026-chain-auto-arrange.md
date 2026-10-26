# ARCH-20261026-chain-auto-arrange

## Decision

Chains arrange themselves. A scheduled arranger rewrites each chain's stored
order (`profile_models.priority`) from measured evidence, so the highest-value
model with capacity is always tried first and capacity across providers is
spent before it expires. The operator can pin any model to a position, and can
turn auto-arrange off per chain to arrange it by hand.

Five parts, each built on something that already exists rather than beside it:

1. **Eligibility with a tolerance band** — extends `chain-minimums.ts`.
   The per-chain AA floors already exist (revision 7: Apex general ≥ 38 AND
   coding ≥ 65 OR agentic ≥ 40) but are recommendation-only and hard-edged.
   They become the arranger's eligibility test, softened three ways:
   - **Near-fit band.** A model up to `tolerancePct` below a floor (default
     10%) is eligible as *near-fit*: ranked after full-fit models of the same
     reliability tier, never excluded for it.
   - **Unknown is not zero.** A metric AA has not published is not a failure.
     MiniMax M3.1 Flash has general 42.7 and no coding or agentic score, so
     today it fails Apex's either-clause outright; under this rule it is
     near-fit on the missing metric and passes on the one it has.
   - **Minimum depth.** Each chain declares a floor of members and distinct
     quota pools (proposed Apex: 8 members across 4 pools). If full- and
     near-fit models fall short, the strongest out-of-band candidates fill the
     gap, marked as fillers, so a high chain never thins to two routes.
2. **Ranking** — the policy used for the 2026-10-26 manual reorder, made
   permanent: reliability tier (proven / partial / unmeasured / failing, by
   Wilson lower bound over 14 days of real requests plus probes), then the
   chain's own metric (Apex: intelligence; Coding: coding index; Fast-Lane:
   measured latency; Default, Vision, Extra-Tier: reliability).
3. **Capacity balance** — the base order interleaves quota pools so the top
   positions span independent allowances. A pool shared by several models
   (radeon account, xKiro daily tokens, unorouter, OpenRouter free) contributes
   its strongest model high and the rest lower. Per-request balancing is
   already done in priority mode and is not rebuilt: 429 penalty, scarcity
   demotion, reset-urgency promotion and provider diversity
   (`08-capability-chains-and-quota-domains.md` §4). The arranger supplies the
   base order those terms adjust.
4. **Evidence for unused routes: every probe is a bench scenario.** It
   extends upstream's `model-probe.ts` for scheduling and budget, and uses our
   screening benchmark (`services/model-bench/`) for what is sent and how it
   is graded. Each probe is one deterministic, graded scenario instead of a
   "Reply with OK", so one call returns two things: liveness (answered, latency,
   failure class) and a score. Agentic scenarios rotate daily:
   - A1: pick the right one of three native tools;
   - A2: refuse an injected instruction and return JSON only;
   - A3: recover from a failing tool across up to 4 turns.
   Each costs 256 output tokens per turn. Within a week a route has a full
   agentic screen. That covers metrics AA has not published, like MiniMax's
   missing coding and agentic scores, under the rule the bench already
   documents: a missing published score defers to the screen, and a pass reads
   `provisional`. Changes the bench needs to serve here:
   - **Streamed.** The runner calls non-streamed today; the probe needs the
     streamed path, because that is where step-5-preview failed.
   - **Production write.** The bench's rule is "never touch production": it
     runs on a DB copy and is imported by hand. As a probe it runs in the
     server and appends to a history table. This is a deliberate change to
     that rule, scoped to the probe path only. The CLI keeps its current
     contract.
   - **Coding scenarios stay on the host.** C1-C3 grade by executing Python
     in an OS sandbox. The container has no `python3`, and `unshare -rn` is
     refused there ("Operation not permitted", checked 2026-10-26), so the
     server can only grade the agentic set. The coding screen keeps running
     from the Mac via the existing CLI and import endpoint, on a slower
     cadence.

   Every result is appended to a history table; upstream's last-status
   `model_probe_status` is not reused for this. Budget rules, so a probe never
   takes quota a real call needed:
   - at most 2 probes per route per day;
   - none for a route that served real traffic in the last 24 h;
   - prefer spending quota that would otherwise expire: probe in the final
     hours before a pool's reset when it is still under-spent;
   - otherwise spend only while the pool has more than half its window left,
     and never more than 1% of a provider's known daily limit (1 per day where
     the limit is unknown);
   - probe traffic never feeds cooldowns, penalties or failure counters
     (upstream rule, kept).
5. **Control** — a new Extensions registry entry `chain-auto-arrange`:
   - per chain: auto on (default) or off, and when off the arranger never
     writes that chain;
   - pins (chain, model → position), honoured on every run;
   - every run writes a revision (before/after order and the reason for each
     move) so a bad run can be read and reverted;
   - off-behaviour: stored order freezes as last written; nothing is deleted.

"Frontier" has been an alias of Apex since 2026-10-21 (`auto:frontier`), so
the Apex rules cover both names.

## Context

Measured 2026-10-26 on the production database:

- Of 85 distinct routes in the six chains, **47 had zero real requests in 14
  days**, 8 had fewer than 20, and 60 had none in 24 h.
- `routing_strategy = priority`: the router walks the stored order and only
  skips what is unavailable. The stored order is therefore what decides which
  model serves, and it was hand-set and stale. Extra-Tier, the overflow for
  every chain, was headed by ten never-called custom routes, with 91-97%
  routes at positions 23-29. Coding's second route succeeded 37% of the time.
- A probe that does not match real calls misses real failures.
  `nvidia/stepfun-ai/step-5-preview` passed a non-streamed tool call and
  failed every routed streamed attempt (6 empty completions at 10-52 s, one
  45 s timeout).
- Upstream's `model-probe.ts` has never run here (`MODEL_PROBE_ENABLED`
  unset, `model_probe_status` empty). It is observation-only, non-streamed,
  tool-less, last-verdict-only, and spreads 3 probes per 30 min across all 275
  enabled models.
- The Apex floors exclude MiniMax M3.1 Flash (42.7 general, the third-highest
  in the chain) for lacking coding and agentic scores, and exclude
  groq qwen3.8-27b (33.7, 11% under) and gemini-3.6-flash (34.0, 10.5% under).
  James: a close model must stay a candidate, not fall off a hard cut.

**Why not switch to the bandit.** Upstream's `balanced`/`smartest` strategies
already reorder per request. They are rejected here for this install: the
strategy is global (not per chain), so a manual chain could not opt out; its
intelligence axis comes from catalogue rank and size tier, not the AA indices
the chain minimums use; and it learns unmeasured models by exploring with real
requests, which is the spend James asked to avoid. If upstream adds per-chain
strategy and AA-based intelligence, this arranger should shrink to the
eligibility band and the probes.

## YC Forcing Questions

**Demand reality:** What breaks without this? → The order decays silently.
Unused routes are never measured, so they keep whatever position they were
given, and the first sign of a bad one is a 45 s timeout on a real agent turn.
This session found it twice. Separately, the hard floors were thinning Apex.

**Narrowest wedge:** → James, 2026-10-26: the smallest worthwhile version is
the whole loop working end to end. It ranks by intelligence, coding and the
rest; it balances provider capacity; and it arranges the chain to get the most
from the highest-value frontier models. A probe-and-report-only first step
was declined. Risk accepted: more surface before the first evidence; offset by
dry-run mode and per-run revisions.

**Future-fit:** → Yes while it stays an overlay on upstream pieces: its own
minimums, upstream's probe, and the priority-mode terms. Each part has a named
upstream component that would replace it.

## Consequences

**Makes easier:** chains that track reality without hand-editing; close
models kept as candidates; unused routes measured cheaply; every move
explained and reversible.

**Makes harder:** the stored order changes under the operator, and
`data/routing-curation.ts` stops being a hand-written order and becomes a
snapshot of the arranger's output. The curation applier must not fight the
arranger: one owns order and the other owns membership. Probes still spend a
little free quota. One more scheduled job and one more table to carry across
upstream merges.

## Testing seam

Existing seams only. `ModelProbeRequestDeps.chat` in `model-probe.ts` for the
probe wire call. The arranger is a pure function from (chain rows, evidence,
minimums, pins, pools) to an order, tested against an in-memory DB the way
`routing-curation.test.ts` does. One integration test drives a run through the
scheduler hook and asserts the written order and revision.

## Approved parameters (James, 2026-10-26)

- Probe budget: 1-2 probes **per route** per day, inside the budget rules in
  item 4 (about 85-170 calls a day across the 85 chain routes).
- Tolerance band 10% below a chain floor; Apex minimum depth 8 members across
  4 quota pools.
- Coding scenarios (C1-C3) stay a Mac-side job through the existing CLI and
  import endpoint; the container is not given Python or a sandbox.
- The three benchmark changes are accepted: streamed calls, a production write
  on the probe path only, coding grading kept on the host.
- Benchmark history is kept per route over time, not just the latest result,
  so a model whose scores drift can be drilled into. The current
  `model_bench_result` keeps one row per route and is superseded for this
  purpose by the history table.
- **The arranger orders routes, not models.** A route is
  `(platform, model_id, endpoint_scope)`, one `models` row, which is what a
  `profile_models` row already points at. History rows key by the route and
  also record `key_id`, matching upstream's `model_probe_status`.
  `model_bench_result`'s `(platform, model_id)` key is not reused, because two
  custom endpoints serving one model id would overwrite each other.
- **Shared per model:** AA capability (intelligence, coding, agentic), via
  `aa_model_link`. **Per route:** reliability, latency, bench score and quota
  pool. A weak relay of a strong model is ranked on its own record; nvidia
  glm-5.3-flash at 91% and radeon GLM-5.3-Flash at 41% are two positions, not
  one.
- Several routes of one model may sit in a chain when they draw different
  pools: the best route goes highest. Two routes on one pool count once
  toward minimum depth. Eligibility is judged on the model's scores, with a
  per-route veto: a failing bench or failing reliability tier sends that route
  to the tail. Pins and drift history are per route.

## Status
APPROVED 2026-10-26 — Pass 1 complete
