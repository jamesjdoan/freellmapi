# Unified Provider Preference and Quota Pools

Status: IMPLEMENTED 2026-09-02 — Phase 1 complete on `codex/provider-routing-controls`

## Context

FreeLLMAPI resolves a public unified model name to several provider-backed endpoints and then applies health, cooldown, rate-limit, quota and reliability rules. Users currently cannot express a preferred provider order for a unified model without changing the external model name.

Free providers also expose different quota economics. Some allowances are shared across an account, some are independent per model, some are project/model scoped, some consume shared monetary credit, some are unpublished, and local inference is unmetered. Treating all of these as a provider-wide or model-wide allowance can incorrectly suppress usable models or multiply a shared allowance.

The existing implementation already has quota-pool observations, but pool identity and lookup are inconsistent: Groq is treated as account-wide, Google is overly coarse, and provider headroom can collapse unrelated pools. Observed exhaustion is not consistently used as a routing eligibility gate across all API surfaces.

## Decision

### Phase 1

1. Add an opt-in routing mode to each unified model:
   - `automatic`: preserve existing selection behaviour exactly.
   - `preferred`: apply a user-defined order to otherwise eligible provider members.
2. Keep the public OpenAI-compatible unified model name unchanged.
3. Preferred order is a soft order. Existing health, capability, enabled-state, cooldown and failover protections remain active. A known-exhausted applicable quota pool is ineligible until its known reset or recovery.
4. Represent quota policy as separate dimensions rather than overloading one scope field:

   ```ts
   interface QuotaPolicy {
     poolKey: string;
     scope: 'model' | 'account' | 'project' | 'shared_pool';
     accounting: 'metered' | 'unknown' | 'unmetered';
     metrics: Array<'requests' | 'tokens' | 'credits' | 'neurons'>;
     reset: {
       strategy: QuotaResetStrategy;
       period?: 'minute' | 'day' | 'month';
     };
   }
   ```

   Exact naming may follow established project conventions, but these concepts must remain distinct.
5. Resolve the applicable quota pool using provider, credential/account, model endpoint and metric. Do not compute eligibility from a provider-wide worst-case headroom value when its models have independent pools.
6. Correctly model at least:
   - shared request pools such as OpenRouter free account capacity;
   - independent per-model pools such as Groq model quotas;
   - Google project/model pools;
   - shared monetary pools such as Hugging Face credit;
   - unknown promotional/fair-use capacity without invented limits;
   - local inference as unmetered.
7. Provider/account limits apply to the credential-wide shared pool. Model-specific limits remain attached to model pools. Multiple configured credentials continue to represent distinct accounts unless the user explicitly maps them otherwise.
8. Ensure all request surfaces pass the real credential and quota context into routing and observation, including the Anthropic-compatible route.
9. Provider model enable/disable controls use the FreeLLMAPI catalogue as authority. Live discovery is only a fallback for providers absent from that catalogue. Disabling a provider endpoint preserves the unified model and its other members.
10. Keep migrations additive and defaults neutral. Existing installations remain in `automatic` mode and retain current behaviour until preference or quota metadata is explicitly configured or supplied by trusted catalogue defaults.

### Phase 2 — deferred

Do not add a general cost optimiser in Phase 1. Future work may add task capability classification, strongest-suitable selection within shared request pools, cheapest-sufficient selection for monetary pools, deliberate distribution across independent model quotas, forecasting, and cross-family quota-aware selection.

## Routing sequence

1. Resolve the requested unified model to provider endpoints.
2. Remove disabled or capability-incompatible endpoints.
3. Resolve each endpoint's applicable quota pool.
4. Remove endpoints known to be unavailable, exhausted, unhealthy or in cooldown under existing protections.
5. In `preferred` mode, order remaining endpoints by the saved preference; in `automatic` mode, retain the current scoring order.
6. Apply existing key selection and reliability logic within that ordering.
7. Execute the request and update usage/quota observations for the exact credential and pool.
8. On an existing failover-eligible error, continue to the next eligible endpoint.

## Data and API shape

- Persist unified-model routing mode and ordered provider-member identifiers alongside existing model-group configuration.
- Persist or derive quota policy per provider endpoint/key combination using stable pool identifiers.
- Reuse existing quota observations and reset parsing where possible; extend them only for missing metrics such as shared credits.
- Expose focused authenticated endpoints using existing settings and key-management API patterns.
- Never duplicate a unified model merely to encode provider preference.

## UI

- On unified-model details, show `Provider routing: Automatic | Preferred order`.
- In preferred mode, show enabled provider members in an ordered list with dependency-free up/down controls unless the project already has a suitable drag-and-drop primitive.
- Persist through the existing save convention and clearly show disabled/ineligible members without silently deleting their saved positions.
- On provider credentials, list catalogue models with per-model enable toggles and show limits at the scope they actually consume.

## Compatibility and migration

- Additive schema migration only.
- Null/absent routing mode means `automatic`.
- Null/absent preference order means no ordering override.
- Existing quota records remain readable; policy resolution supplies backward-compatible defaults.
- Unknown quota remains unknown and does not become a fabricated allowance.
- The uncommitted implementation that predates this decision is provisional. Its per-key provider-limit fields are not accepted as a complete quota model and must be reconciled with this decision before shipping.

## Validation

- Unit tests for preference ordering, automatic-mode parity, disabled providers and partial/stale preference lists.
- Integration tests proving failover on 429, cooldown, quota exhaustion, health failure and provider errors.
- Shared-pool tests proving one endpoint's consumption/exhaustion affects siblings using the same account pool.
- Independent-pool tests proving exhausting Groq model A does not suppress Groq model B.
- Project/model tests for Google and shared-credit tests for Hugging Face.
- Unknown and unmetered tests proving no invented capacity and no external-quota suppression.
- Cross-surface tests for OpenAI chat/responses and Anthropic messages using the correct key/pool context.
- Migration round-trip and backward-compatibility tests.
- Dashboard tests for ordering, persistence, catalogue toggles and accessibility.

## Consequences and risks

- Pool identity becomes a correctness boundary and must be stable across catalogue updates.
- Provider error payloads and reset headers are inconsistent, so inferred exhaustion must remain conservative.
- Shared credentials entered more than once can still double-count capacity unless explicitly linked in a future change.
- Saved preference entries may become stale as providers or catalogue members change; unknown entries are retained but ignored until they return.
- A preferred order intentionally reduces automatic score optimisation, but never bypasses safety, health, quota or failover rules.

## Forcing assessment

- Demand is demonstrated by current 401/429 routing failures and the inability to reserve scarce free-provider capacity without changing the public model name.
- The narrow wedge is provider ordering plus correct pool eligibility and catalogue endpoint controls.
- The policy dimensions leave a clean seam for later optimisation without requiring Phase 2 now.
