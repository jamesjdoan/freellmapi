# ARCH-20261022-extra-tier-overflow

## Decision

When a chain runs out of routes, try Extra-Tier's routes before returning an error. Extra-Tier becomes what its contract has always said it was, the overflow and experimental capacity. Today nothing sends a request to it unless a client names `auto:extra-tier`.

## Context

- Over the 14 days to 2026-10-21, `auto:frontier`, `auto:apex`, `auto:coding` and `auto:vision` returned `routing_exhausted` 3,789 times. A typical refusal reads `provider-blocked … cooldown … tpm_limit 1000 < estimated 49437`: every member was cooling down or blocked at the same moment.
- Merging the chains (8 → 6) and filling each with every route that meets its minimums (2026-10-21) made the chains deeper. Extra-Tier now holds 78 enabled routes across most providers, and it is still unreachable from any other chain.
- The refusal happens in one place. `runFallbackLoopAttempts` (`server/src/lib/fallback-loop.ts`) calls `hooks.route(attempt)`, and a throw from it, with no earlier upstream error, becomes `routingExhaustionBody`. The chain it walks comes from `resolveRoutingChain` (`server/src/services/router.ts`).

## Design

1. **Where.** In `resolveRoutingChain`, for every resolved chain except Extra-Tier itself, append Extra-Tier's enabled members that are not already in the chain, after the chain's own members. This covers plain `auto` (the default chain), `auto:<name>` and the aliases. Global sorts (`auto:smart`, `auto:fast` …) already span the catalogue and are left alone. So is an explicit model id, which is the client naming one model.
2. **Contract kept.** Only appended rows that meet the original chain's contract are kept: tools when it requires tools, vision when it requires vision. The per-request `requireTools`/`requireVision` filters in `routeRequest` still apply on top. A Coding request never overflows onto a model that cannot call tools.
3. **Ordering.** Appended rows keep Extra-Tier's own order, so its proven routes are tried first. The chain's own members always come first. Overflow is a tail, never a re-rank.
4. **Bounds that already exist still apply.** The fallback time budget, `maxRetries`, the circuit breaker, cooldowns, quota gates and the paid-balance guard. Overflow adds candidates, not attempts beyond those limits.
5. **Visibility.** Each attempt served from an overflow row is marked `overflow: true` in the attempt record and the request log, so the dashboard can show how often a chain leaned on Extra-Tier. A chain that overflows often is a chain that needs more of its own depth.
6. **Switch.** A new extension `extra-tier-overflow`, on by default, listed in `shared/extension-registry.ts` with `offBehaviour: "a chain that runs out returns routing_exhausted, as before"` and `takesEffect: "next request"`.

## Alternatives considered

- **Per-chain overflow lists.** More control, but it is a second chain-membership surface to maintain, the thing the 8 → 6 merge removed.
- **Overflow into the whole catalogue.** It would also reach routes the minimums deliberately keep out of every chain. Extra-Tier is the operator's curated "acceptable as a last resort" list, so it is the right boundary.
- **Leave Fast-Lane out.** Fast-Lane's point is latency, and an overflow route may be slow. It is included anyway, because a slow answer to `commit`/`tiny` is still better than an error, and the time budget caps the wait. This can be revisited from the overflow counts.

## Questions for James

- **Q1.** Answered (James, 2026-10-22, taking the recommendation): on by default.
- **Q2.** Answered (James, 2026-10-22, taking the recommendation): Fast-Lane included.

## Testing seam

- Router: a chain whose members are all cooling down routes to an Extra-Tier member. Appended rows that break the chain's tools or vision contract are never chosen. Extra-Tier itself gets no tail. With the extension off, behaviour is unchanged. An explicit model id never overflows.
- Fallback loop: an overflow attempt is recorded with `overflow: true`.
- Smoke on a live-data copy: force-cool a chain's members and confirm the request is served from Extra-Tier, not refused.

## Acceptance after deploy

The `routing_exhausted` count for `auto:*` requests over the following 7 days, against the 3,789-in-14-days baseline.

## Status

APPROVED 2026-10-22. The approval does not cover commit, push or deploy.
