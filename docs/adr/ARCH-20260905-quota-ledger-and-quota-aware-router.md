# ARCH-20260905-quota-ledger-and-quota-aware-router

> **Revision 2 (2026-09-05).** Revision 1 was reviewed by an outside agent (Codex `gpt-5.6-sol`,
> spec at `codex/tasks/quota-ledger-adr-review.md`) which returned a NO. Five of its seven
> findings were wrong or overstated, and it missed a structural defect that undercut the whole
> proposal. Every correction below was re-verified against source before being accepted; one of
> the reviewer's own corrections (F4) was itself checked and found correct only after the
> original query turned out to be malformed. Revision 1's findings are superseded, not amended.

## Decision

Make FreeLLMAPI's existing quota evidence trustworthy, then add **scarcity-aware provider
selection** between providers serving the same logical model — shipped `off` → `shadow` →
`canary` → `active`, with the existing bandit router as the permanent fallback.

Explicitly **not** a new parallel monitoring system, and explicitly **not** a pacing-first
design (see F2). `provider_quota_state`, `provider_quota_observations`, `rate_limit_usage`,
`requests`, `request_attempts` and the per-model limit columns on `models` already exist; this
decision corrects and consolidates them.

## Context

Traffic sample: 772 requests, 2026-08-27 → 2026-09-02, from
`backups/freellmapi-data-20260902-131315.tar.gz` (the working-tree `server/data/freeapi.db` is
empty — 0 requests, 0 keys).

**F1 — Hugging Face is auto-routed, but a durable auto-only exclusion already exists.**
39 of 43 Hugging Face requests were auto-routed (`requested_model IS NULL`); 30 succeeded.
However `fallback_config.enabled` / `profile_models.enabled` already exclude a model from auto
routing **while leaving explicit invocation working** — pinned by
`server/src/__tests__/routes/routing-semantics.test.ts:170-184` and `:213-228`, and surfaced by
the models API as `fallbackEnabled` (`server/src/routes/models.ts:157-170`). Revision 1 claimed
`models.enabled = 0` was the only durable lever. That was wrong. What is genuinely missing is a
**provider-wide** default so future catalog rows and new profiles inherit the exclusion instead
of each row needing to be flipped.

**F2 — The binding constraint is scarce-provider exhaustion, not wasted recurring quota.**
This reverses revision 1. Google absorbed 226 of 375 requests on the heaviest day and returned
429 on 32 of them; across the sample, `request_attempts` records 35 `rate_limited` Google
attempts, and **10 of those belong to a parent request that ultimately failed** — user-visible
failures, not absorbed retries. Meanwhile peak demand (375/day) sits far below Groq's per-model
1000 RPD (`server/src/db/migrations/20260101_000000_legacy_baseline.ts:632-635`), so unused Groq
capacity was **unavoidable at this demand** and is not evidence of harm. Revision 1's
"recurring free quota is expiring unused" claim does not survive: no outage, cost or rejected
request traces to it. The demonstrated problem is the opposite shape — the router keeps
selecting the scarce provider until it 429s while abundant pools idle. That motivates a
**scarcity** term, not a pacing term.

**F3 — We may be discarding the reset clock rather than lacking it.**
`HEADER_SPECS` covers 4 platforms — groq, cerebras, openrouter, modelscope, the last marked
unconfirmed (`server/src/services/provider-quota.ts:169-195`).
`parseResetAtFromHeader` accepts **only numerics** (`Number(raw.trim())`,
`server/src/services/provider-quota.ts:93-105`), and the raw header value is not retained on the
observation. Groq documents its reset headers as duration strings (`2m59.56s`), which this
parser drops on the floor. 114 of 115 Groq header rows have `reset_at = NULL`; the single
non-null came from an 8-second `Retry-After`. Revision 1 concluded "Groq omits the reset". That
is unproven and probably false — **raw capture must come before any conclusion about provider
coverage.**

**F4 — 429s do reach the request log; the observation record is what's incomplete.**
`SELECT COUNT(*) FROM requests WHERE instr(error,'429')>0` returns **38** (35 Google, 1 each
custom/groq/openrouter). Revision 1 reported 0 — that was a malformed query, not a fact
(`%` wildcards were percent-decoded by the query tool before SQLite saw them). The real defect:
the 429 observation constructor never sets `statusCode` even though the column exists
(`server/src/services/provider-quota.ts:273-285` vs schema at
`server/src/db/migrations/20260101_000000_legacy_baseline.ts:201-221`), so every observation in
the sample has `status_code = NULL`.

**F5 — Two clocks already coexist, and the architecture doc is wrong about which.**
Per-model RPD/TPD use a **rolling 24h lookback** (`canMakeRequest` / `canUseTokens` pass `DAY`
as a window width, `server/src/services/ratelimit.ts:328` and `:351`). Only the provider-wide
caps use UTC calendar midnight (`msSinceUtcMidnight` at `:38`, used at `:640` and `:755`).
`docs/architecture/02-quota-and-cooldown-engine.md:18-22` states per-model RPD/TPD reset at UTC
midnight — the doc contradicts the implementation and should be corrected regardless of this
decision. Revision 1 trusted the doc. Timezone-aware calendar reset (Google's Pacific day)
exists in neither representation.

**F6 — Per-model limits are already persisted and API-editable.**
`models` carries `rpm_limit`, `rpd_limit`, `tpm_limit`, `tpd_limit`, `monthly_token_budget`
(`.../legacy_baseline.ts:60-75`), editable via `PATCH /api/models/:id`
(`server/src/routes/models.ts:246-264`). Only the **provider-wide** caps are env-only
(`server/src/services/ratelimit.ts:551-612`). Revision 1 claimed configured caps live only in
env — half wrong. What is needed is a **precedence resolver** over four existing sources, not a
greenfield policy table that would become a fifth competing source of truth.

**F7 — No decision record exists, and shadow mode cannot prove what revision 1 claimed.**
`request_attempts` records dispatched attempts, never candidates or scores
(`server/src/db/migrations/20260726_000002_request_attempts.ts:24-38`). A decision ledger is
required. But shadow rows can only establish *divergence* and *arithmetic consistency* — the
provider the shadow router preferred never ran, so "would have been better" is unknowable from
passive shadowing. Proving benefit needs a **bounded canary**, not a longer shadow.

**F8 — The quota ledger has no reliable subject identity. This is the blocker.**
`provider_quota_state` is keyed `(platform, key_id, quota_pool_key, metric)` with no `model_id`
(`.../legacy_baseline.ts:182-197`), while `inferPoolForPlatform` collapses every Groq model into
one account pool (`server/src/services/provider-quota.ts:112-167`) — and the catalog gives Groq
models **different** limits, from 1000 RPD to 14400 RPD for `llama-3.1-8b-instant`
(`.../legacy_baseline.ts:632-635`). A 14× difference is being written into one row. Every
downstream layer — reset clock, pacing, scoring, shadow, dashboard — inherits this. Building on
it yields confidently-wrong numbers that look precisely attributed.

**AMENDED 2026-09-05 — the fix is probably not a primary-key change.** On inspection before
execution, the live catalog is worse than stated above: Groq spans **three** RPD tiers (14400 /
1000 / 250), two RPM tiers (30 / 60) and four TPM tiers (6000 / 8000 / 15000 / 70000), all
collapsing into one `groq::account` row whose `limit_value` is overwritten by whichever model
was called last. But the existing primary key **already contains `quota_pool_key`** — so if
Groq's pool key were per-model (`groq::<modelId>`), the rows would separate with **no migration
at all**. The defect is a wrong pool key asserting account scope, not a primary key missing a
column.

Two hazards make this a decision rather than an edit:
1. **Health-probe split brain.** `services/health.ts:100` and `:183` pass `modelId: null`, so
   probes would keep writing `groq::account` while request traffic writes `groq::<modelId>` —
   two disagreeing subjects for one account. This must be resolved whichever route is taken.
2. **Which pooling is real is still unverified.** Our catalog asserts per-model Groq limits, but
   that is our own seed data, not a provider statement. The raw capture landed in F10 settles it
   on the next live call: differing `x-ratelimit-limit-requests` per model proves per-model
   metering; identical values prove one account pool.

Re-scoping the pool key also flips `isAccountScopedPool('groq')` false, enabling
`least-remaining` key ordering for Groq — inert today at one key per platform (F10), live the
moment a second is added.

**Held pending the first live capture.** Executing either route now would be a guess about
provider semantics dressed as a schema decision — the exact failure this ADR was rewritten to
avoid.

**F9 — Local metering counts successes only.**
`recordRequest` / `recordTokens` are driven by `recordUpstreamSuccess`
(`server/src/lib/fallback-loop.ts:386-389`). A failed attempt that consumed provider quota — the
35 Google 429s among them — never lands in `rate_limit_usage`. Any locally-derived remaining
figure is therefore biased optimistic exactly when the provider is under pressure.

**F10 — The raw-header pipe is fully built and has no producer, and the account-scope
detector cannot fire on this install.** Added 2026-09-05 while sequencing W0.
`rawJson` is threaded through the observation type, the insert and the read
(`server/src/services/provider-quota.ts:40`, `:384`, `:448`, `:623`) but **no caller ever sets
it** — `parseQuotaObservationsFromResponse` does not populate it. All 4,469 observations in the
sample have `raw_json IS NULL`. F3 is therefore **not answerable retroactively**: there is no
stored record of what Groq actually sent, and every day without capture destroys more evidence.
The fix is small and the plumbing already exists.

**RESOLVED 2026-09-05 — the producer landed.** `parseQuotaObservationsFromResponse` now
populates `rawJson` on all four observation shapes via `captureRawHeaders`
(`server/src/services/provider-quota.ts`), and sets `statusCode`, closing F4's half of the same
defect. Capture is a whitelist of the header names each observation was derived from, unioned
with a discovery pattern (`/ratelimit|quota|retry|reset|remaining|credit/i`) so platforms with
no `HEADER_SPECS` entry record what they actually sent instead of asserting "no quota headers
exposed" unbacked. A deny-list (`authorization|cookie|token|secret|api-key|bearer|session|
password|signature`) overrides the pattern and a 2 KB ceiling bounds the row — telemetry must
not hold credential material. One deliberate behaviour change: a reset header that arrives but
does not parse now yields an observation noted `reset header present but unparsed`, because
otherwise the raw value has nothing to ride on; it cannot reach routing, since
`getKeyQuotaHeadroom` requires `limit_value IS NOT NULL`. Three tests at the
`parseQuotaObservationsFromResponse(new Response(...))` seam; the Groq `2m59.56s` retention and
NVIDIA discovery cases both fail without the producer.

**Still true:** the 4,469 historical observations remain `raw_json IS NULL`. F3 is answerable
from the next live request onward, never for the sample this ADR was written from.

Separately, the install has **exactly one key per platform** across all 8 platforms with keys.
Two consequences: (a) the empirical account-scope detector — "do two keys report the same
remaining number in lockstep?" — has no second key to compare and cannot run here; (b)
`least-remaining` key selection is gated on `keys.length > 1` (`server/src/services/router.ts:1448`),
so the entire pool-scope classification question, including the `openrouter::free`
misclassification, currently has **zero effect on live routing**. It is latent correctness for
the day a second key is added, not a present defect.

**Decision (operator, 2026-09-05) — pool scope is configured, not guessed.** Scope resolves by
the same precedence as every other quota fact: declared default (`POOL_SPECS`) → observed
(the lockstep detector, where a second key exists) → operator override, with the operator
winning. Collection is the upgrade path, not the primary mechanism, because F10(a) makes it
unavailable on single-key installs.

### What already exists and must be reused, not rebuilt

| Requested concept | Existing implementation |
|---|---|
| Observations, append-only | `provider_quota_observations` (`.../legacy_baseline.ts:201-224`) |
| Derived state | `provider_quota_state` (`:182-199`) — but see F8 |
| Source enum | `QuotaObservationSource` (`shared/types.ts:531`) |
| Confidence + precedence | `DEFAULT_CONFIDENCE`, `SOURCE_PRIORITY` (`provider-quota.ts:58-74`) |
| Reset-strategy enum | `QuotaResetStrategy` (`shared/types.ts:530`) |
| Per-model limits, API-editable | `models.*_limit` + `PATCH /api/models/:id` (F6) |
| Auto-only exclusion | `fallback_config.enabled` / `fallbackEnabled` (F1) |
| Hot-path headroom | `getKeyQuotaHeadroom`, 5s TTL, confidence ≥ 0.7 (`provider-quota.ts:459-526`) |
| Forecast | `quota-forecast.ts` |
| Logical model → N providers | `resolveModelGroupCandidates` (`router.ts:1726-1773`) |

## YC Forcing Questions

**Demand reality:** → 35 rate-limited Google attempts, **10 ending in a failed request**, while
Groq and NVIDIA sat idle with capacity. That is the harm, and it is user-visible. The
"wasted recurring quota" motivation from revision 1 is withdrawn — at 375 requests/day it is not
supported by the data (F2).

**Narrowest wedge:** → **W0 (evidence integrity) is now the wedge**, and it is not optional
groundwork: F8 alone makes every quota number for Groq wrong by up to 14×. The smallest thing
that proves the *routing* idea is then a shadow ledger answering one question: on those 35
rate-limited Google attempts, would a scarcity-aware router have chosen an abundant provider
that was healthy at that moment? That is answerable from recorded state, and it is a far
narrower claim than a pacing engine.

**Future-fit:** → Partly answered by F3. The pessimistic reading of revision 1 ("providers don't
publish quota data") may be an artifact of our own parser discarding it. Until raw capture lands
we do not know the real coverage, and **the design must not bet on either answer**: the
precedence resolver (F6) degrades to operator-configured limits when observations are absent and
upgrades automatically when they are not. That is the property that makes this survive provider
churn. **Answered 2026-09-05 (operator):** pacing on operator-typed limits is accepted for
pools where no observation will ever arrive, on the condition that operator-entered limits are
control-plane configuration with their own provenance — never written back as though they were
learned observations, and never allowed to outrank a live provider reading.

## Consequences

**Makes easier**
- Quota numbers become attributable to the right subject, so every later layer can be trusted.
- Scarce-provider exhaustion becomes avoidable rather than merely retried.
- One precedence resolver replaces four disagreeing sources of limit truth.
- Provider-wide autoroute policy stops depending on per-row hygiene.

**Makes harder**
- F8's fix changes a primary key, and it is **not routing-neutral**. Two couplings verified
  2026-09-05:
  - `getKeyQuotaHeadroom` filters `provider_quota_state` by `platform` alone and reduces to one
    ratio per key by taking the **minimum** across matching rows
    (`server/src/services/provider-quota.ts:490-516`). Adding `model_id` to the key multiplies
    rows per key, silently redefining that minimum from "worst pool" to "worst model on the
    platform".
  - `quotaWeightingApplies` decides whether `least-remaining` key ordering runs by testing
    whether the pool key **string ends in `::account`** (`server/src/services/router.ts:1355-1357`).
    Emitting per-model Groq keys flips that test false → true, switching on key reordering that
    #919 deliberately disabled for shared account pools. The suffix test must be decoupled from
    the pool-key string before the key changes, not after.
  - Other `inferQuotaPoolKey` consumers that move with it: `routes/free-tier.ts:143` (panel
    grouping and its one-budget-per-pool dedupe), `routes/proxy.ts:92`, `routes/responses.ts:507`,
    and `services/health.ts:100,183` — the last passes `modelId: null`, so under a per-model
    scheme health-probe observations and request observations would stop landing on the same row.
- A third clock is forbidden. W2 must consolidate the two in F5, not add to them.
- Scarcity scoring and the existing headroom guardrail push in related directions
  (`router.ts:1006-1036`, `scoring.ts:431-466`); applied independently the outcome depends on
  multiplier ordering. They need one coherent quota objective, not two multipliers.
- Attempt-level metering (F9) increases write volume on the failure path.

## Testing seam

- **Reset clock** — new pure module (policy + `now` → `{period_start, reset_at}`), IANA zone
  passed explicitly, never `process.env.TZ`. The only new seam.
- **Precedence resolver** — pure function over the four sources; table-driven.
- **Scoring** — `server/src/services/scoring.ts`, already pure and per-factor tested.
- **Selection / shadow / provider exclusion** — existing router integration seam against an
  isolated DB (`router-bandit.test.ts`, `routing-semantics.test.ts`). "Shadow never alters
  selection" is an equality assertion on the same seed with the mode flipped.
- **Header + 429 observation** — `parseQuotaObservationsFromResponse(new Response(...))`, the
  established pattern at `provider-quota.test.ts:206-218`. Groq's `2m59.56s` duration format is
  a regression case here.

## Proposed sequence

- **W0 — evidence integrity.** No routing change.
  - ✅ Pool-key/scope decoupling — prerequisite for subject identity, since the routing rule
    read the pool-key string (`isAccountScopedPool`, 2026-09-05).
  - ✅ Raw reset retention + `status_code` (F3, F4, F10) — 2026-09-05.
  - ⬜ Duration parsing (F3) — deliberately deferred until a live capture shows the real
    format. Parsing a guessed format is what produced F3 in the first place.
  - ⏸ Subject identity (F8) — **partly closed 2026-09-05.** The defect turned out to have three
    instances, not one, and two are now fixed: the routing ledger gained
    `actual_endpoint`/`shadow_endpoint` (migration `000003`) after a live run showed two relays
    recording identical rows with a vacuously-true `agreed`; and `quota_policy` gained
    `endpoint_scope` (migration `000004`), so a limit can name one relay — previously a second
    policy for a sibling endpoint collided on the unique index and silently replaced the first.
    **Still open:** the original case, Groq's per-model limits (14400/1000/250 RPD) collapsing
    into one `groq::account` row. That remains a pool-key correction rather than a migration,
    and remains blocked on a live capture proving which pooling is real.
  - ✅ Attempt-level metering (F9) — 2026-09-05.
- **W1 — provider-wide autoroute policy.** ✅ 2026-09-05. Built on the existing chain-enable
  mechanism (F1); Hugging Face and SambaNova off by default. Needed reach in three chain
  builders, not one — the `auto:<sort>` chain spans the whole catalog and defaults unlisted
  models IN, which is how a freshly synced model would have re-entered autoroute.
- **W2 — effective-policy resolver + API.**
  - ✅ Timezone-safe reset clock (`services/quota-clock.ts`) — 2026-09-05.
  - ✅ `quota_policy` table, resolver and `/api/quota` — 2026-09-05.
  - ⏸ **Hard-gate consolidation moved out of W2** (operator, 2026-09-05). Codex was right
    that gates and scoring must share one clock, but that is a prerequisite for **active
    mode**, not for W2: switching `canMakeRequest` from rolling-24h to policy windows changes
    what gets rejected, live, on every model. Running the one irreversible enforcement change
    before the observation layer inverts the point of shadow. It now sits at the W3→W4 boundary.
- **W3 — shadow decision ledger.** ✅ 2026-09-05. `routing_decision` + `quota_routing_mode`
  (defaults to `shadow`, never `active`). Validates arithmetic and divergence only — the
  preferred provider never ran, so the ledger cannot show it would have done better.
  Scoring is one defensible signal (headroom on the binding axis), not a weighted blend:
  with no shadow data yet, tuned constants would be false precision. Pacing is recorded
  per candidate so the weighting can be settled from data at W4.
  The evaluation is deferred past the routing turn (`setImmediate`) and policy reads are
  memoised for 5s, so selection pays nothing for measurement — pinned by a test asserting
  the ledger is still empty when `routeRequest` returns.
- **W4 — bounded canary**, then active mode and the full dashboard.

## Status

APPROVED 2026-09-05 — Pass 1 complete. Sequence W0 → W1 → W2 → W3 → W4 approved as written;
operator-typed limits accepted under the provenance condition recorded in Future-fit.
