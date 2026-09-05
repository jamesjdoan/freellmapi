# Quota Ledger & Shadow Routing — Deep Dive

> **Source:** `server/src/services/quota-clock.ts`, `server/src/services/quota-policy.ts`, `server/src/services/quota-routing.ts`, `server/src/services/provider-quota.ts`

## 1. Overview

The quota ledger persists operator-configured limits (`quota_policy` table) and the shadow router's decision log (`routing_decision` table). Together they enable scarcity-aware provider selection: the router scores providers serving the same logical model by headroom on the binding axis, weighted by reservation weights, and records the comparison of respective weights and allocation. Shadow mode records the comparison without affecting selection, providing an auditable ledger of divergence and arithmetic consistency.

## 2. Quota Clock — Timezone‑Aware Reset Logic

The `quota-clock` module replaces ad‑hoc rolling and UTC‑midnight clocks with a single timezone‑aware resolver. It answers: given a period description and an instant, where does the current window start and when does it reset?

### Period Kinds

Five period kinds are supported:

| Kind | Description | Example |
|------|-------------|---------|
| `rolling` | Fixed‑width lookback: `[now - windowMs, now]` | Per‑model RPD/TPD (24 h) |
| `calendar_day` | Local calendar day, resets at local midnight | Provider‑wide daily caps |
| `calendar_week` | ISO week (Monday start), resets Monday midnight | — |
| `calendar_month` | Local calendar month, resets on the 1st | — |
| `billing_cycle` | Monthly cycle anchored to a signup/billing day | — |
| `provider_reported` | Provider‑stated reset instant; period start unknown | — |

### Two‑Pass DST Offset

The clock computes zone offsets in two passes to correctly handle civil‑day transitions that fall on a DST jump. First, it converts the instant to civil time in the zone; second, it recomputes the offset at the computed civil‑day boundary. This yields the correct offset even when the instant falls in a “gap” or “overlap” caused by DST shift.

### Nullable Fields

The `QuotaWindow` interface returns `null` for fields that are not knowable:

- `periodStartMs`: `null` for `provider_reported` (the provider stated only when, not how long) and for `rolling` when the oldest event is unknown (no reset instant without the oldest event).
- `resetAtMs`: `null` for `rolling` when the oldest event is unknown (same reason as above).

Deliberately returning `null` avoids fabricating a number that would be mistaken for a measured value downstream.

### Key Functions (quota-clock.ts)

| Function | Purpose |
|----------|---------|
| `resolveQuotaWindow(period, now)` | Returns `{ periodStartMs, resetAtMs }` for the given period and instant |
| `quotaPacing(window, now, used, limit)` | Returns pacing info: `elapsedFraction`, `paceDelta`, `projectedUsedAtReset` |
| `zoneOffsetMs(instantMs, timeZone)` | Offset of time zone from UTC at instant, in milliseconds |
| `zonedParts(instantMs, timeZone)` | Civil‑time parts (year, month, day, weekday) for instant in zone |
| `zonedMidnightMs(year, month, day, timeZone)` | UTC instant of local midnight on the given date in zone |

## 3. Quota Policy — Precedence‑Based Limit Resolution

The `quota-policy` module is the single place that ranks quota limits from six sources. It implements the operator’s Q2 condition: a measured provider reading always outranks a typed limit, and an operator's typed limit outranks the shipped catalog default.

### quota_policy Table

The table stores operator‑entered limits with full period and scope semantics.

| Column | Type | Description |
|--------|------|-------------|
| `id` | INTEGER PRIMARY KEY | Auto‑increment |
| `platform` | TEXT NOT NULL | Provider platform (e.g. `groq`) |
| `model_id` | TEXT | NULL = every model on the platform (account‑wide pool) |
| `endpoint_scope` | TEXT | NULL = every endpoint of this platform+model; otherwise discriminates endpoints (e.g. for relays) |
| `scope` | TEXT NOT NULL | Quota pool scope: `provider_account`, `provider_key`, `model`, `shared_pool` |
| `metric` | TEXT NOT NULL | Quota metric: `requests`, `input_tokens`, `output_tokens`, `total_tokens`, `credits` |
| `limit_value` | INTEGER NOT NULL | Limit value (>0) |
| `period_kind` | TEXT NOT NULL | Period kind: `rolling`, `calendar_day`, `calendar_week`, `calendar_month`, `billing_cycle` |
| `period_ms` | INTEGER | Width for `rolling` periods; NULL otherwise |
| `timezone` | TEXT | IANA time zone name for calendar kinds; NULL means UTC |
| `anchor_day` | INTEGER | Day‑of‑month anchor for `billing_cycle`; clamped by clock in short months |
| `priority` | INTEGER NOT NULL | Higher wins when two policies match with equal specificity |
| `enabled` | INTEGER NOT NULL | 0 = disabled, 1 = enabled |
| `source` | TEXT NOT NULL | Provenance: `operator`, `catalog`, `documentation`, `provider_api` |
| `confidence` | REAL NOT NULL | 0.0–1.0; operator‑entered limits default to 0.8 |
| `notes` | TEXT | Optional notes |
| `created_at` | TEXT NOT NULL | Timestamp of creation |
| `updated_at` | TEXT NOT NULL | Timestamp of last update |

The unique index enforces one policy per subject+metric:  
`UNIQUE (platform, IFNULL(model_id, ''), IFNULL(endpoint_scope, ''), scope, metric)`

### Six‑Level Source Precedence

Limits are ranked by source trustworthiness. Higher rank wins.

| Rank | Source | Description |
|------|--------|-------------|
| 100 | `provider_header` | Measured from live provider headers (e.g. `x-ratelimit-limit-requests`) |
| 80 | `provider_api` | Quota fetched via provider API (e.g. `/v1/models`) |
| 60 | `operator` | Entered via `PUT /api/quota/policies` |
| 40 | `documentation` | Stated in provider documentation |
| 20 | `catalog` | Shipped with the catalog (per‑model `_limit` columns) |
| 10 | `provider_cap_env` | Provider‑wide cap from environment (e.g. `PROVIDER_*_CAP_<PLATFORM>`) |

The `considerCandidate` function iterates over candidates and keeps the one with strictly greater source rank. Iteration order within a rank is not load‑bearing because the first source to claim an axis at a given rank keeps it.

### Per‑Axis Resolution

Limits are resolved per `(metric, period)` axis. The `resolveEffectiveQuotas` function:

1. Collects all enabled policies for the given `(platform, modelId, endpointScope)`.
2. For each policy, builds a `QuotaPeriod` from its period fields.
3. For each `(metric, period)` axis, keeps the policy with the highest source rank (using `considerCandidate`).
4. Returns an array of `EffectiveQuota` objects, one per binding axis.

Specificity is encoded by **sort order**, and this is load-bearing. All operator policies share
one source rank, and `considerCandidate` replaces the current holder only on a *strictly* better
rank — so on any axis claimed twice, the **first** policy seen wins. The list is therefore sorted
most-specific-first (`policySpecificity`: per-endpoint 2, per-model 1, platform-wide 0), which is
what makes a per-endpoint limit beat a per-model one and that beat a platform-wide one.

`priority` breaks ties at equal specificity, descending. That tie is reachable: `axisKey` is
`(metric, period)` and ignores `scope`, so two policies differing only by `scope` claim the same
axis. Without the tiebreak the winner would be whatever order SQLite happened to return.

### Key Functions (quota-policy.ts)

| Function | Purpose |
|----------|---------|
| `resolveEffectiveQuotas(platform, modelId, now, endpointScope)` | Returns every limit that currently binds `(platform, modelId, endpointScope)` |
| `upsertQuotaPolicy(input)` | Create or replace the policy for one subject+metric |
| `deleteQuotaPolicy(id)` | Delete a policy by ID |
| `periodForPolicy(policy)` | Converts a policy row to a `QuotaPeriod` for the clock |
| `policySpecificity(policy)` | Returns a number: 2 if `endpointScope` not null, plus 1 if `modelId` not null |
| `considerCandidate(best, candidate)` | Updates the best effective quota for an axis if candidate has strictly better source rank |
| `invalidateQuotaPolicyCache(platform?)` | Drops memoised policies for one platform or all |

## 4. Quota‑Aware Routing — Scarcity Scoring and Shadow Ledger

The `quota-routing` module implements scarcity‑aware provider selection in shadow mode. It scores providers serving the same logical model by headroom on the binding axis, multiplied by reservation weight, and records the comparison without affecting selection.

### Modes

Quota routing operates in three modes, controlled by the `quota_routing_mode` setting:

| Mode | Description |
|------|-------------|
| `off` | Quota awareness disabled; the bandit router selects providers as usual |
| `shadow` | Quota‑aware scores are computed and recorded, but the incumbent's choice is served (default) |
| `active` | Quota‑aware choice is served (requires deliberate operator action) |

Shadow is the default and never active by default — recording what a change *would* do is safe; making the change requires explicit operator consent.

### Scoring Formula

The `scoreQuotaCandidate` function computes attractiveness as:

```
headroom = min over axes of (1 - used/limit)
score    = headroom × reservationWeight[platform]
```

- `headroom` is clamped to `[0, 1]`; when all limits are unknown or unmetered, `headroom` defaults to `UNKNOWN_HEADROOM = 0.5`.
- `reservationWeight` is a per‑platform multiplier in `[0, 1]`; lower means “hold this pool back”. Weights are declared by the operator via `PUT /api/quota/reservation`.
- `paceDelta` is recorded per candidate from the quota clock's pacing output, enabling the operator to later tune the weighting between headroom and pace.

### Reservation Weights and the Ledger

Reservation weights are stored in the `settings` table under the key `quota_reservation_weights`. The ledger (`routing_decision` table) records one comparison per routed request when in shadow or active mode.

Entries are failure‑swallowing: if the policy table is missing, the clock throws, or the database is mid‑restore, routing continues exactly as it did before.

### Deferral Off the Selection Path

Quota‑aware scoring is deliberately kept separate from the bandit router:

- The bandit decides **which logical model** to serve (ranking models by reliability, speed, intelligence).
- This module decides, **among the providers serving that model**, which one should spend its quota.
- Mixing the two would let a quota signal silently substitute a weaker model, which is not what quota awareness is for.

In shadow mode, the answer is recorded and thrown away; the only side effect is one insert into `routing_decision`.

### Key Functions (quota-routing.ts)

| Function | Purpose |
|----------|---------|
| `getQuotaRoutingMode()` / `setQuotaRoutingMode(mode)` | Read/write the quota routing mode setting |
| `getReservationWeights()` / `setReservationWeights(weights)` | Read/write reservation weights per platform |
| `scoreQuotaCandidate(quotas, used, now, reservationWeight)` | Returns `{ score, headroom, paceDelta }` for one candidate |
| `evaluateShadowDecision(candidates, usedFor, now)` | Returns the shadow decision (or null) for one logical model |
| `recordRoutingDecision(input)` | Persists one comparison (swallows every failure) |
| `getShadowAgreementStats(sinceMs?)` | Returns shadow‑mode agreement statistics |
| `listRoutingDecisions(query)` | Returns recent routing decisions, newest first |

## 5. Provider Quota Observation — Raw Header Capture

The `provider-quota` module captures raw quota‑related headers from provider responses before parsing, preserving the original values for later analysis.

### Whitelist + Pattern, Never a Full Header Dump

Raw capture uses a whitelist of header names derived from the observation context (e.g. the names actually used to build the observation) plus a discovery pattern that matches any quota‑shaped header the provider sent.

- **Whitelist**: `explicit` header names passed in via `QuotaObservationInput` (e.g. `x-ratelimit-limit-requests`).
- **Discovery pattern**: `/ratelimit|rate-limit|quota|retry|reset|remaining|credit/i` matches anything quota‑shaped in the headers.
- **Deny‑list wins**: `/authorization|cookie|token|secret|api-?key|bearer|session|password|signature/i` overrides the pattern — any header that looks like a credential is refused.
- **2 KB ceiling**: Real header sets are a few hundred bytes; anything larger is discarded to avoid persisting credential material.

The captured headers are serialized to JSON and truncated to `RAW_CAPTURE_MAX_CHARS = 2048` characters.

### Why Discovery Is Not Gated on `isSharedPool`

The discovery capture runs on **every** platform, not just pooled ones, because `isSharedPool`
answers a different question. Whether a platform's models share one account budget (pooling) has
no bearing on whether it sends headers worth recording (discovery). While both were behind that
one condition, any platform outside the shared-pool list — `custom`, `ovh`, `reka`,
`siliconflow`, `qianfan`, `volcengine`, `longcat`, `xfyun` — could return textbook
`x-ratelimit-*` headers and nothing at all was recorded. The synthetic "we called it and nothing
was reported" probe row is still gated on `isSharedPool`, because that one genuinely is about
pooling.

### Key Functions (provider-quota.ts)

| Function | Purpose |
|----------|---------|
| `captureRawHeaders(headers, explicit)` | Returns JSON‑serialized whitelist+discovery headers, or null |
| `parseQuotaObservationsFromResponse(response, opts)` | Extracts observations from a provider response, now populates `rawJson` and `statusCode` |
| `recordQuotaObservation(input)` | Persists one observation |
| `getKeyQuotaHeadroom(platform)` | Returns a map of `keyId → headroom fraction` (5‑second TTL, confidence ≥ 0.7) |
| `getQuotaStateForKeys()` | Quota observation view for all keys (raw headers deliberately not projected) |

## 6. Quota Ledger Migrations

Four migrations introduced the quota ledger and shadow routing tables, added endpoint identity to disambiguate relays, and extended the policy table with per‑endpoint scope.

### 20260905_000001 — quota_policy Table

Created the `quota_policy` table with columns for platform‑scoped limits, including period and timezone fields.

Added columns:
- `id`, `platform`, `model_id`, `scope`, `metric`, `limit_value`, `period_kind`, `period_ms`, `timezone`, `anchor_day`, `priority`, `enabled`, `source`, `confidence`, `notes`, `created_at`, `updated_at`

### 20260905_000002 — routing_decision Table

Created the `routing_decision` table to record the router's considerations and choices.

Added columns:
- `id`, `created_at_ms`, `logical_model`, `mode`, `actual_platform`, `actual_model_id`, `shadow_platform`, `shadow_model_id`, `agreed`, `reason`, `candidates_json`, `created_at`

### 20260905_000003 — routing_decision Endpoint Identity

Added `actual_endpoint` and `shadow_endpoint` columns to the `routing_decision` table to disambiguate relay endpoints.

Added columns:
- `actual_endpoint` (TEXT)
- `shadow_endpoint` (TEXT)

### 20260905_000004 — quota_policy.endpoint_scope

Added the `endpoint_scope` column to the `quota_policy` table and rebuilt the unique index to include it.

Added column:
- `endpoint_scope` (TEXT)

The unique index became:  
`UNIQUE (platform, IFNULL(model_id, ''), IFNULL(endpoint_scope, ''), scope, metric)`

## 7. What Shadow CANNOT Tell You

The shadow decision ledger records only **divergence** and **arithmetic consistency**. It cannot show whether the shadow‑preferred provider would have performed better because that provider never ran.

- Shadow proves divergence only: the provider it preferred never ran, so nothing can claim the shadow choice would have been better.
- Any UI claiming “shadow would have been better” is incorrect; the ledger only validates that the quota‑aware scoring is arithmetically consistent and differs from the incumbent's choice.
- To prove benefit, a bounded canary must follow shadow — active mode is not enabled by default and requires deliberate operator consent.

---