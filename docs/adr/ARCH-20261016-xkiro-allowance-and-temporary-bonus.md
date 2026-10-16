# ARCH-20261016-xkiro-allowance-and-temporary-bonus

## Decision

Integrate Xkiro into the existing allowance and usage dashboard and extend the existing quota controls with provider-neutral temporary bonus grants. Each grant identifies its provider/account, metric and unit, quantity, and duration in hours. Supported quantities include tokens, request counts, provider credits and explicitly denominated monetary value. Use the provider/account's normal applicable allowance first, then count excess against its one bonus pool across the entire duration. Normal allowance resets do not refill the bonus. At expiry or exhaustion, only the normal allowance remains. Xkiro's initial grant is 30 million tokens for 720 hours on top of its normal one-million-token UTC daily allowance. Do not change model enablement or paid-spend controls.

## Shared grant contract

- Reuse existing quota accounting, reservations, and dashboard controls. A separate provider-specific bonus settings system is not part of this decision.
- A grant belongs to an actual account/pool, not an independent duplicate per model or credential. Preserve endpoint/account scope and avoid sharing unrelated accounts.
- Distinguish the provider's grant pool from the operator's spending allowance. Xkiro's pool is 30M tokens valid for 30 days. Independently, the operator selects how much EXTRA usage may draw from that existing pool during a chosen duration in hours. For example, authorising 2M extra tokens over 6 hours does not create another grant or expose the entire 30M pool.
- Bonus admission is bounded by BOTH the remaining authorised extra allowance and the remaining unexpired grant pool. Actual excess consumption debits both once, after applying the normal allowance first. Authorising another spending window never replenishes the grant pool or resets its expiry.
- When the spending window expires or its extra allowance is spent, return to the normal allowance even if the grant pool still has tokens. Unspent authorised allowance is not consumption; unused pool capacity stays available for a later authorisation until the provider grant expires. The UI shows grant-pool balance/expiry separately from the active extra allowance/balance/window.
- Store metric and unit explicitly. Requests, tokens, provider credits, and money are not interchangeable. Follow the repository's currency convention rather than converting arbitrary credits to money or assuming exchange rates.
- Show normal allowance/reset alongside configured bonus, bonus consumed, remaining local budget, and expiry countdown. Clearly distinguish provider-reported balances from locally accounted or estimated consumption.
- Reconcile reservations with actual request usage, including streamed requests and concurrent calls. Editing a grant never resets recorded consumption. Expiry stops admitting bonus-funded work without claiming to revoke an already-started generation.
- Normal-first allocation follows each pool's real reset period. It must account for normal consumption already observed before grant activation without charging that consumption to the new bonus. Locally tracked bonus consumption cannot claim to include calls outside FreeLLMAPI.
- Provider-specific measurement remains provider-specific. A configured grant cannot invent missing token or currency costs, bypass an authoritative upstream refusal, permit paid spend, or create upstream entitlement. Unsupported or unknown consumption must remain explicit, not silently count as zero.

## Context

Two enabled Qwen free models returned successful completions on 2026-10-16. Authenticated `/v1/usage` returned `limit_per_day: 1000000`, `used_today: 308`, and `remaining: 999692`. The official usage documentation defines the daily boundary as 00:00 UTC. The account counters are shared across its keys and free models.

James reports an extra 30 million tokens for 30 days and explicitly selected **30M total for 30 days**, not an extra daily allowance. He clarified that the operator's configurable quantity-and-hours allowance draws from that pool: the grant's lifetime and the local spending window are distinct. The control restricts how much of the remaining provider bonus may be used as extra capacity before reverting to normal limits. A subsequent live usage read still reports only the normal daily pool, no subscription windows, and no bonus field. The bonus must be labelled operator-provided. Daily-first allocation is the requested local accounting rule, not a verified claim about Xkiro's own spending order. Local accounting cannot establish bonus use from other clients.

## YC Forcing Questions

**Demand reality:** The working Xkiro routes need visible allowance, usage, and reset information in the existing dashboard. The temporary grant is not represented by the provider's checked usage response.

**Narrowest wedge:** Extend existing quota observation and dashboard surfaces for the daily pool. Present the separately labelled temporary grant and its expiry without inventing a provider-reported bonus balance.

**Future-fit:** Daily observations remain useful after the grant expires. Expiry ends the temporary grant without changing the normal daily allowance or leaving a permanent inflated quota.

## Consequences

**Makes easier:** Distinguishes today's resettable allowance from a one-time promotion and makes provenance visible.

**Makes harder:** Exact bonus remaining cannot be confirmed from the checked provider endpoint. Local requests alone cannot establish usage from other clients or the provider's spending order. The dashboard must show this uncertainty rather than subtract all usage from both pools.

The duration starts when the operator activates the bonus. The dashboard shows configured total, locally accounted bonus usage and remaining budget, expiry, and time remaining, separately from the daily counter/reset. The cap and usage must survive restarts and apply across Xkiro's free models and keys without multiplying an account allowance. In-flight requests need reservations so concurrency cannot overspend the local budget; reconcile with actual reported tokens when complete. Expiry prevents new bonus-funded requests and does not pretend it can revoke tokens already being generated. Duration and budget edits must not erase consumption. Provider failures, actual upstream quota exhaustion, and the paid-spend guard remain authoritative: a local bonus setting does not manufacture upstream entitlement or override a 429. No commit, push, or deployment is authorised by this record.

## Testing seam

Reuse existing provider-quota parsing/observations, provider quota polling, quota reservation/accounting, and dashboard seams. Verify normal-first allocation for tokens, request counts, and denominated credits; requests crossing a normal allowance boundary; repeated resets without bonus refill; duration expiry; concurrency reservations and settlement; restart persistence; edits without usage reset; account scope; pre-activation usage; and the distinction between local accounting and provider-reported balances. Exercise actual dashboard surfaces with isolated data before deployment.

## Sources

- https://docs.xkiro.com/api/usage/
- Live authenticated https://api.xkiro.com/v1/usage (credentials omitted).
- James's selected bonus scope in this conversation.

## Status

APPROVED 2026-10-16 — James approved the dashboard integration and the expanded provider-neutral temporary bonus contract, including configurable token/request/credit quantities, duration in hours, normal-first accounting across resets, and automatic reversion after expiry or exhaustion. Pass 1 complete. Implementation may proceed at the existing quota and dashboard seams. This approval does not authorise commit, push, or deployment.
