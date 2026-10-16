# ARCH-20261014-amd-capacity-bars-and-routing

## Decision

Make the existing AMD capacity collector a background observer with a 40-second request budget, add per-model fleet-utilisation bars, and provide an opt-in soft routing preference against models AMD currently reports as full.

This extends the earlier presentation-only capacity decision. Routing effects have explicit architecture approval and an independently switchable extension. Implementation is authorized, but deployment, commits and model activation are not.

## Context

The deployed collector aborts public pressure requests after five seconds. A fresh anonymous browser received HTTP 200 responses after 23.7 seconds. An anonymous extraction script executed inside the actual FreeLLMAPI container returned fresh model IDs, states and percentages after 26.2 seconds with a longer bound. Those observations identify a timeout mismatch, not a need for login or HTML scraping.

Earlier real model tests returned a DeepSeek-V4.1-Flash 429 and a GLM-5.3-Flash timeout. A later successful pressure sample reported those backends full. Those observations do not prove pressure caused the earlier failures. The shared free allocation was nearly unused in the deployed account inspection. Account allowance and model fleet utilisation are independent facts.

The operator now requests visible bars and capacity affecting routing priority. The earlier approved ADR explicitly excluded routing decisions, so this record is a new boundary.

## Proposed behavior

### D1 — Shared background observation

Use the existing public JSON pressure feed and parser. Allow up to 40 seconds for a read. There is one server-side collector and one in-flight request, not a scrape/poll for each model or browser. Refresh in the background with a 20-second interval between completed attempts. Dashboard and routing reads consume the cached snapshot without waiting for upstream HTTP.

Start collection when AMD is configured and either its capacity presentation or capacity-routing feature is enabled. Stop presentation-only collection when both are off. Initial, failed and overdue observations remain visibly Unknown or Last reported. A response only updates its observation timestamp after it succeeds and validates. No inference request is spent to refresh pressure.

### D2 — Per-model utilisation bars

Show the provider-reported 0–100% fleet utilisation on AMD model/provider rows and the quota capacity view. A full bar means busy/full backend utilisation, not remaining free allocation. Preserve the separate shared usage-point allowance and cooldown information.

Use AMD's reported idle/busy/full classification rather than inventing thresholds from rounded percentages. Missing data has an Unknown label and no pretend zero bar. Stale bars are explicitly last reported and visually muted. All surfaces use the existing shared capacity snapshot and clock.

### D3 — Opt-in soft routing effect

Recommend a new `amd-capacity-routing` routing extension, default OFF to preserve existing automatic-routing defaults. Enablement belongs in the existing Extensions state, not a second settings store. Disabling it leaves collection evidence, model enablement and saved chains intact and makes the priority signal neutral.

When enabled, a fresh AMD `state: full` reading places that eligible route behind otherwise eligible non-full alternatives in automatic selection. Within each pressure band, retain existing strategy, score, chain and soft provider-preference ordering. Apply the same rule to automatic unified-model provider choice and fallback candidate ordering across the supported inference surfaces.

Pressure is a preference, not hard quota exhaustion: a full route remains a last-resort candidate if alternatives cannot serve. If all candidates are full, retain their existing relative order. Busy/idle percentages are shown but do not introduce an arbitrary continuous score multiplier in this change.

Unknown, stale or failed pressure is neutral. The existing 60-second freshness boundary applies to received, validated pressure samples. No network request occurs on the inference request path. Health, capability, key scope, enabled state, cooldown, actual quota exhaustion and the paid-balance guard continue to constrain eligibility. Explicit provider/model-pinned calls retain their intent and are not silently substituted.

No model is enabled or added to a chain automatically. Existing inactive AMD routes stay inactive until the operator deliberately enables them. Public unified model IDs and saved routing configuration are unchanged.

## YC forcing questions

**Demand reality:** What breaks without this? → The current five-second bound cannot read a measured 24–26-second feed, and the operator cannot see a utilisation bar or prefer a non-full route. Real 429/timeout observations and successful longer-bound anonymous extraction establish the problem.

**Narrowest wedge:** What proves usefulness? → Fix the existing AMD observer, display its own percentages and add a binary fresh-full, opt-in soft priority band. No scraper, new quota ledger, continuous cost optimiser, automatic chain curation or hard exclusion.

**Future-fit:** Is this durable? → [INFERENCE] Yes: background observations, explicit freshness and soft eligibility-preserving priority use the existing provider/routing boundaries. The provider-specific feed stays isolated and replaceable. Missing information remains neutral rather than creating a dependency on an unreliable external feed.

## Consequences

**Makes easier:** Observe actual fleet occupancy without blocking the dashboard, avoid a full AMD backend when a suitable eligible alternative exists, and keep explicit requests and configured chains predictable.

**Makes harder:** Maintain a clear distinction between observation age, routing preference and hard quota eligibility. A shared fleet can change quickly, so even a fresh sample must not become a hard skip. The opt-in control must state its effect on soft provider/chain priority.

## Testing seam

Use the existing AMD pressure adapter/cache seam for delayed successful responses, background single-flight, errors and freshness. Use existing router candidate-ordering seams for fresh-full demotion, unknown/stale neutrality, all-full fallback, preserved eligibility and explicit pinning. Exercise the actual bar surfaces and real anonymous extraction. Tests must catch incorrect 100x scaling and confusing Unknown with genuine zero utilisation.

## Status

APPROVED 2026-10-14 — James approved D1–D3 and the existing pressure-adapter/router-ordering testing seams. Pass 1 complete. Implementation may proceed. Deployment, commits and changes to model enablement or saved chain membership require separate authorization.

Implementation verified locally on 2026-10-14: 131 focused server tests and server typecheck passed. 36 client tests, production client build and 60-locale/1947-key validation passed. An isolated in-memory server exercised the real anonymous feed through the actual observer in 24.126 seconds. The authenticated capacity endpoint returned in 39 ms while collection was pending and 7 ms once fresh, with 11 reported models.

Real-source routing smoke selected full MiMo-V2.6-Flash with the extension OFF, preferred non-full Gemma-4-31B-IT when ON, retained explicit MiMo pinning and used MiMo as last resort when key scope excluded alternatives. Saved chain rows were unchanged. The sandbox switch was restored OFF. This used synthetic keys and made no inference requests or changes to operator data.

Actual Chromium surfaces showed live bars on expanded AMD provider rows, the model detail and Quota signals (11 model bars and one account pool). The new Extensions switch persisted ON across reload and was restored OFF. Controlled UI responses separately proved genuine 0%, muted aged Last reported and Unknown with no fake meter. Browser errors were empty. No deployment, commit or push performed.

DEPLOYED 2026-10-15 — James separately approved deployment. Image `jamesjdoan/freellmapi:main-20261015-070832` is healthy on the existing volume and port 3001. Authenticated capacity HTTP returned 200 with one pool and 11 inventory models; the actual background collector supplied fresh anonymous AMD pressure. Actual Keys and Quota signals displayed live utilisation meters with unknown entries kept distinct. `amd-capacity-routing` remains OFF as designed; no models, scopes or saved chains were activated or reordered.
