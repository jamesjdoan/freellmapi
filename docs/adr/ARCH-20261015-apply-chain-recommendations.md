# ARCH-20261015-apply-chain-recommendations

## Decision

Make the existing chain-fit recommendations actionable with an additive, confirmed Apply recommendations control on Keys and the Models comparison surface where those recommendations currently appear.

This is a new feature, separate from the completed but undeployed AMD capacity work. James approved the architecture and implementation. Applying actual operator chain changes, deployment, commits and pushes still require separate authorization.

## Context

James requests a way to click and apply the recommended chain placement rather than manually copying recommendations into chains. Source inspection confirms that `client/src/components/chain-fit.tsx` only renders fit/misfit chips. Its current callers are Keys provider-model rows and Compare Models (`/analytics/compare`), not the ordinary Chat Models table.

Keys and Compare already have a manual confirmed `ChainPicker`. Both use `POST /api/fallback/membership` with physical catalogue model IDs and named chains. That endpoint performs additive membership writes, checks enabled healthy/in-scope keys, and enforces recorded capability failures under the existing capability-verification extension. It does not replace the complete chain or change the active profile.

The current recommendation evaluator uses operator-set Artificial Analysis minimums and structural tool/vision requirements. It permits estimated proxy scores only where the chain accepts them. Fast-Lane is reserved and not graded. The visible fit may come from an unsaved threshold draft, which must not silently become the basis of a routing write.

An important ordering distinction: existing membership upserts preserve a previously disabled row's old priority when it is re-enabled. Therefore ordinary membership restoration is not always equivalent to appending a new recommendation. Recommendation adoption must explicitly distinguish its safe append intent without changing the existing manual restore behavior.

## Proposed behavior

### D4 — Apply the existing recommendations

Place an Apply recommendations action beside the existing Fits hints in Keys provider-model rows and Models comparison rows. The existing manual chain picker stays available. The action previews recommended chain additions, lets the operator choose which to adopt, and requires the existing confirmation pattern before any write.

Use the current minimums and measured/proxy-score conventions. Do not create another scoring engine, include reserved Fast-Lane, or automatically adopt unknown/below-minimum recommendations. Save threshold edits before adopting recommendations derived from them.

This proposal targets the existing recommendation locations. Adding a new recommendation display to the ordinary Chat Models table is not silently substituted for the requested apply action.

### D5 — Add only, preserve the operator's chains

Adoption adds the selected physical model routes to the selected named chains. It never removes a member because it no longer fits, replaces a chain, changes the active profile, rewrites unrelated priorities, expands key scopes or enables a provider/model globally.

Newly enabled recommendation members go at the end of the stored enabled-member order, including a previously disabled member that otherwise retains an old rank. Already-active members remain unchanged. Normal manual restoration keeps its existing position-preserving behavior. Stored append order does not override the router's selected strategy or live priority signals.

Repeated adoption does not duplicate membership or move already-active members. Show actual success/failure per target chain. A partially successful multi-chain action must not report that every target was applied.

### D6 — Exact route identity and existing safety

Keys adopts the specific provider-model row selected by the operator. A grouped Models comparison row must preview the exact physical members it will add. Only currently enabled, key-reachable, in-scope members that individually satisfy the selected recommendation may be included. Do not apply a group's aggregate fit blindly to all providers.

Refresh and re-evaluate the recommendation before confirmation. Reuse the existing membership validation at write time, including key reachability and recorded capability failures. An unavailable model, removed chain or rejected write shows its concrete reason and does not silently modify keys, minimums or another chain.

Adoption remains an explicit operator action. Dynamic AMD fleet pressure can affect routing priority when that separate extension is enabled, but does not permanently curate membership. Existing paid-balance protection remains unchanged.

Extend the existing chain-minimums UI/registry contract rather than adding a second recommendation settings store. Turning the presentation off hides recommendation adoption controls and retains all saved membership and minimums. Existing manual chain editing remains available.

## YC forcing questions

**Demand reality:** What hurts without this? → James cannot directly adopt the existing fit recommendations. The source confirms those chips are display-only despite a separate manual chain editor being available.

**Narrowest wedge:** What proves usefulness? → Select one model's existing recommended chains, review physical routes and additive changes, then explicitly confirm. No automatic global rebalance, removals, new recommendation engine or key activation.

**Future-fit:** Does this remain coherent? → [INFERENCE] Yes: advisory evaluation remains separate from explicit persisted membership, with existing chain IDs, manual editing and routing protections retained. Reusing current grading avoids a divergent recommendation convention.

## Consequences

**Makes easier:** Adopt recommendations at the point where the model is being evaluated, without navigating away or manually recreating the selected chain choices.

**Makes harder:** Prevent a grouped recommendation, unsaved draft or stale catalogue from enabling unintended routes. Append intent must account for existing disabled rows without changing manual restore semantics. Multi-chain results must report partial failure honestly.

## Testing seam

Reuse `server/src/__tests__/routes/fallback-membership.test.ts` for additive writes, append/reactivation, duplicate adoption, preserved existing members/active profile and safety refusals. Use the existing chain-minimums evaluation seam for unknown/structural/proxy acceptance boundaries. Exercise actual Keys and Models comparison UI for preview, Cancel, confirmation, per-route selection and refreshed membership. Any new permanent UI regression must test consumer-visible transitions, not source text or callback echoes.

## Research evidence

- `client/src/components/chain-fit.tsx:13-47`: current display-only recommendation.
- `client/src/lib/chain-minimums.ts:83-99,158-163`: evaluation and unsaved draft precedence.
- `client/src/components/keys/provider-models-panel.tsx:440-444,852-867`: existing physical-row adoption interface.
- `client/src/pages/CompareModelsPage.tsx:1202-1221`: grouped membership currently filters enabled/key-scoped routes.
- `server/src/routes/fallback.ts:511-605`: named-chain resolution, reachability/capability gates, transaction and preserved old priority.
- Read-only browser smoke of the actual evaluator returned measured=fits, unacceptedProxy=unknown, missingTools=structural, unmeasured=unknown. No routing data was changed.
- The requested subagent research was attempted. Both scouts were unavailable because FreeLLMAPI returned `429 All models exhausted`; the relevant source inspection and browser smoke were completed inline instead.

## Status

APPROVED 2026-10-15 — James approved D4–D6, existing membership/evaluation testing seams and actual Keys/Models comparison UI verification. Implementation may proceed. No production chain adoption, deployment, commit or push is authorized.

IMPLEMENTED AND VERIFIED LOCALLY 2026-10-15 — The shared confirmed adoption control is wired to existing Keys and Compare Models fit hints. It validates fresh evidence, grades exact physical routes, blocks unsaved threshold edits and rechecks current recommendations before writing. The existing membership endpoint accepts explicit `append: true` adoption intent with idempotent active-member behavior, safe reactivation at the tail and existing reachability/capability guards. Ordinary manual restoration remains unchanged.

Verification: five new acceptance cases failed against the original endpoint, then all 14 membership tests passed after implementation. The integrated server suite passed 99 tests, with server typecheck passing. Client build/typecheck, 29 client tests and 60-locale/1958-key validation passed.

Actual isolated in-memory runtime and Chromium verified preview/Cancel and first confirmation click made no writes. Keys adopted Groq at Coding priority 5 behind the existing priority-4 head, rather than restoring its disabled priority-1 slot. Compare allowed an exact Groq-only Apex addition while leaving Google/NVIDIA/Cerebras untouched; individually incompatible and out-of-scope routes were excluded. Membership chips refreshed. A changed saved minimum was refused without writes, and an unsaved threshold draft disabled adoption.

A controlled Coding refusal showed honest per-chain partial results while Default's actual successful append was independently read from the API. The final runtime exercised the completed transaction again: initial adoption returned HTTP 200/changed 1, repeat returned HTTP 200/changed 0, head/order/active profile remained correct. All browser errors were empty, and no model enablement/key-scope/operator data changed. All fixture state was isolated and no inference requests were made. No deployment, commit or push performed.

DEPLOYED 2026-10-15 — James separately approved deployment. Image `jamesjdoan/freellmapi:main-20261015-070832` is running healthy on the existing data volume with published port 3001. Deployed Keys and Compare recommendation previews were opened and cancelled without applying members. Key/scopes and chain digests matched the immediate pre-deploy baseline after inspection, active profile stayed 3, and all 15 stored credentials decrypted. Browser errors were empty; temporary verification session revoked. Earlier no-deployment statements describe prior snapshots and are superseded by this approval.
