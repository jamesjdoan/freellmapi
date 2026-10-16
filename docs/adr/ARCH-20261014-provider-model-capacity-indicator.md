# ARCH-20261014-provider-model-capacity-indicator

## Decision

Extend the existing quota/capacity presentation with an AMD provider-model indicator that keeps three facts separate:

- The free usage allocation shared by the credential/account, with used, remaining, limit, reset and observation age.
- AMD's shared-fleet pressure for the individual model, with its source and observation age.
- FreeLLM's existing model/key cooldown and route availability.

Show the same facts on the provider's model row/detail, key view and quota/usage view. Reuse the existing quota observation store and existing cooldown machinery. Do not assign each model an independent copy of a shared account allowance, convert usage points into a fabricated monthly token budget, or create a blended capacity score.

This is a presentation and observation change. It does not enable models, reorder chains, change provider preference, or make new routing decisions.

## Context

The operator added AMD China Token Factory. Its shared API currently advertises 11 public chat models plus an OCR model. The local inventory was supplemented through existing model APIs without activating AMD in selected chains.

On 2026-10-14, every public chat model was tested once in series. Nine returned usable completions. `DeepSeek-V4.1-Flash` returned 429, and `GLM-5.3-Flash` did not complete within the 60-second client budget. AMD's public fleet endpoint simultaneously reported both models at capacity. The free allocation remained almost full. This demonstrates that account allowance and individual-model execution capacity are different facts.

Actual completion headers report `x-ratelimit-limit-user-rpm: 20` and `x-ratelimit-limit-user-daily-usd: 1`. One raw observation reports `x-ratelimit-remaining-user-daily-usd: 0.99995531` and `x-ratelimit-used-user-daily-usd: 0.00004469`. The current header parser rounds the normalized credit reading to integer cents, storing remaining=100 and limit=100. That erases small measured usage and makes a precise allowance look untouched.

The provider model detail describes shared-model prices as **“Free to use. Points show relative usage—not a charge.”** The indicator must label that free allowance clearly rather than presenting it as a paid balance. GPU instance credits and dedicated deployments are a different system and are out of scope.

The existing quota outlook flags an old observation as stale, but the key badge and provider-headroom table can still present the same minute-window sample as 95% remaining and Healthy. AMD's fleet-pressure endpoint is not currently integrated.

## YC Forcing Questions

**Demand reality:** What hurts without this? → The operator cannot distinguish a nearly unused shared free allowance from a full individual model. Existing key/limit summaries also hide freshness and small allocation consumption. These gaps were observed in the actual UI and live requests, not inferred from a mock.

**Narrowest wedge:** What is the smallest useful version? → One AMD provider-model capacity presentation, using its existing account quota observations, its published per-model pressure feed and existing cooldowns. Make those same facts visible on the existing model, key and quota surfaces. Preserve precise measured usage and mark stale/unknown readings honestly. No routing-policy change or speculative tokens-per-month conversion.

**Future-fit:** Does this remain useful in 2–3 years? → [INFERENCE] Yes: shared allowances, per-model pressure and cooldowns are stable distinctions already represented by the repository's quota architecture. Keep provider-specific collection behind the provider boundary and retain source/time information so another provider's better feed can replace it without a second quota store.

## Data contract

- Allocation is scoped to provider + credential/account + quota pool. All AMD model rows drawing from that pool reference the same allowance. Aggregate views count it once.
- Observations without a resolved credential/account, such as the existing native probe's key-id-0 rows, do not count as an additional usable account. The live test produced such rows for the two parked models, and that probe records token usage as zero. Neither fact is evidence of zero provider consumption or a second free allocation.
- Preserve fractional measured allocation instead of rounding small usage to an apparently untouched allowance. Keep the existing denomination contract coherent. Show enough precision in details to reveal real consumption without adding false precision to a compact badge.
- RPM is a short rolling gate, not the free-allocation percentage. Do not let an old minute-window reading masquerade as the current account balance.
- Fleet pressure is scoped to provider endpoint + model. It describes shared backend concurrency, not this key's quota usage or a failure probability.
- Both source timestamp and freshness state are required. A failed read does not become zero, and a cached or expired reading does not become fresh.
- Allowance readings come from legitimate completion headers today. The China usage-summary endpoint returned `401 Login required` with the saved API key, and `/models` returned no quota headers. Do not claim idle allocation polling works, or spend inference quota merely to refresh a badge. If authenticated usage polling is later verified, it can feed the same observation contract.
- AMD's published fleet feed can supply model pressure without disclosing a credential. Cache it once per server and expose it to the existing dashboard surfaces, rather than one upstream poll per model row.
- Existing cooldown expiry and reasons remain authoritative for local router state. A busy model must not be presented as an exhausted key.
- Missing model pressure or account data renders Unknown. Busy/full, exhausted allocation, rate-limited and cooling down remain distinguishable.

## Consequences

**Makes easier:** See why one AMD route cannot serve while another can, observe consumption of the actual free allowance, and distinguish stale data from current capacity on the pages the operator uses.

**Makes harder:** Maintain separate freshness semantics for short RPM windows, account allocation and volatile model pressure. The China usage-summary endpoint cannot currently be polled with the API key, so idle allocation values must remain explicitly last-reported.

## Testing seam

Use the existing public quota parser/observation seam to prove fractional allocation survives and one account pool is not duplicated across models. Cover pressure success/failure/staleness at the provider observation boundary. UI acceptance should exercise the actual model, key and quota surfaces with shared-allocation and busy-model evidence. Existing cooldown data must be reused, not mocked into a second state machine. Tests must cover consumer-visible precision, shared scope, freshness and unknown-versus-zero behavior.

## Sources

- https://developer.amd.com.cn/radeon/tokenfactory
- https://developer.amd.com.cn/radeon/api/tokenfactory/load
- https://developer.amd.com.cn/radeon/api/tokenfactory/model?id=model_gateway%3AQwen3.8-27B
- https://amd-aim.github.io/radeon-cloud-docs/zh-cn/api/rate-limits/
- https://amd-aim.github.io/radeon-cloud-docs/zh-cn/api/usage/
- Existing implementation: `server/src/services/provider-quota.ts`, `server/src/providers/openai-compat.ts`, `server/src/services/quota-outlook.ts`, `client/src/components/keys/quota-balance.ts`, `client/src/components/keys/quota-limits-section.tsx`, `client/src/components/penalty-inspector.tsx`.

## Status

APPROVED 2026-10-14 — Pass 1 complete. James approved the indicator design and, separately, deployment of the completed Keys controls. Capacity-indicator implementation does not carry a separate deployment approval.

Implementation completed and verified locally on 2026-10-14: authenticated shared snapshot, precise allocation storage, single-flight cached AMD pressure observer, shared client observer/clock and all approved presentation surfaces. Focused verification passed 84 server tests and 36 client tests, package type/build checks and 60-locale/1947-key validation. Actual account headers showed 0.99990221 of 1 usage points remaining; UI exposed the measured 0.00009779 used instead of 100%. Controlled UI states proved full pressure, cooldown expiry, stale/unknown distinctions and one shared account pool. The vendor pressure endpoint did not return a first byte from runtime HTTP clients during smoke, so actual live pressure correctly rendered Unknown; no successful live pressure sample is claimed. Capacity deployment remains unapproved.

DEPLOYED 2026-10-14 — James separately approved deployment. Image `jamesjdoan/freellmapi:main-20261014-215829` is healthy on the existing data volume with published port 3001. Authenticated API, real inference and deployed key/model/quota surfaces were verified. A new real request exposed 0.99989486 / 1 free usage points remaining and 0.00010514 used. Live fleet pressure remains Unknown until the vendor supplies a usable response. Earlier unapproved-deployment statements describe their prior snapshots and are superseded by this approval and deployment.

Diagnosis corrected later on 2026-10-14: the anonymous pressure source is available, but measured responses took 24–26 seconds and the deployed five-second deadline aborted too early. The resulting Unknown reading was honest, but the earlier attribution to provider-source unavailability was incomplete. See `ARCH-20261014-amd-capacity-bars-and-routing.md` for the separately approved background-observer fix, bars and opt-in routing extension. Those changes are verified locally, not deployed by the earlier approval.
