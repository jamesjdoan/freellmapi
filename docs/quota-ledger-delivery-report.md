# Quota Ledger + Quota-Aware Router — Delivery Report

**Date:** 2026-09-05 · **Branch:** `main` · **Base:** `6b6402a` · **Head:** `33eb249`
**Decision record:** `docs/adr/ARCH-20260905-quota-ledger-and-quota-aware-router.md` (APPROVED)

Status: **W0 partial, W1/W2/W3 complete. Active routing NOT enabled. No dashboard.**

---

## 1. Repository architecture discovered

The repo already had most of a quota subsystem; the brief's design assumed greenfield.

| Concern | Existing implementation |
|---|---|
| Observations, append-only | `provider_quota_observations` (baseline migration `:201-224`) |
| Derived quota state | `provider_quota_state` (`:182-199`), PK `(platform, key_id, quota_pool_key, metric)` |
| Source enum | `QuotaObservationSource` — header / quota_api / error_body / local_usage / documentation / probe (`shared/types.ts:531`) |
| Confidence + precedence | `DEFAULT_CONFIDENCE`, `SOURCE_PRIORITY` (`services/provider-quota.ts:58-74`) |
| Reset-strategy enum | `QuotaResetStrategy` (`shared/types.ts:530`) |
| Response-header capture | `HEADER_SPECS` for groq, cerebras, openrouter, modelscope only |
| Rate windows | `services/ratelimit.ts` — RPM/RPD/TPM/TPD, leases, provider-wide caps |
| Cooldowns + provenance | `rate_limit_cooldowns`, escalation ladder, `cooldown-probe.ts` |
| Router | `services/router.ts` — contextual bandit, five axes, multiplicative guardrails |
| Logical model grouping | `services/model-groups.ts` — `normalizeGroupKey`, `stripProviderSuffix` |
| Per-model limits | `models.rpm_limit / rpd_limit / tpm_limit / tpd_limit`, editable via `PATCH /api/models/:id` |
| Usage events | `requests`, `request_attempts`, `rate_limit_usage`, `request_hourly` |

**The motivation changed on evidence.** The brief assumed recurring free quota was being wasted
before reset. Measured over 772 requests (2026-08-27 → 09-02, from
`backups/freellmapi-data-20260902-131315.tar.gz`): peak demand was 375 requests/day against a
Groq pool of 1000/model/day, so idle capacity was unavoidable, not waste. The real harm was
**scarce-provider exhaustion** — 35 rate-limited Google attempts, **10 of which ended in a
request that failed for the user**, while Groq and NVIDIA sat idle. That argues for a scarcity
term, not a pacing engine.

An outside review (Codex `gpt-5.6-sol`, spec at `codex/tasks/quota-ledger-adr-review.md`)
returned NO on the first ADR and corrected five of seven findings. All corrections were
re-verified against source. One — "zero 429s in the request log" — was a measurement error of
mine: `%` wildcards were percent-decoded before SQLite saw the query. Real count: 38.

## 2. Files changed

24 files, +3130 / −58 (excluding `package-lock.json`). Twelve commits:

```
33eb249 feat(quota): expose shadow statistics, decision history and the routing mode
5296dc1 perf(quota): keep shadow measurement off the selection path
0555fa8 feat(routing): shadow quota-aware provider selection
ac97bbf docs(adr): record W1/W2 progress and the hard-gate deferral
3b05f45 feat(quota): effective quota policy resolver and API
b5da116 feat(quota): timezone-safe quota reset clock
e3db42f feat(routing): provider-wide autoroute exclusion policy
6c4b0d0 docs(architecture): correct the per-model RPD/TPD reset claim
094305e feat(quota): meter failed attempts that consumed provider quota
f39c42d feat(quota): capture raw provider quota headers and status code
4e739f0 refactor(quota): declare pool scope instead of inferring it from the key string
8baee7f docs(adr): quota ledger + quota-aware router Pass 1 decision
```

New: `services/quota-clock.ts`, `services/quota-policy.ts`, `services/quota-routing.ts`,
`routes/quota.ts`, two migrations, five test files.

## 3. Database migrations

Two, both additive and reversible, registered in `db/migrate/defaults.ts`:

- `20260905_000001_quota_policy.ts`
- `20260905_000002_routing_decision.ts`

No existing table was altered. No data migration. `down()` on each drops only what it created.

## 4. New tables and fields

**`quota_policy`** — declared limits with period semantics. `platform`, `model_id` (NULL = whole
platform), `scope`, `metric`, `limit_value`, `period_kind`, `period_ms`, `timezone`, `anchor_day`,
`priority`, `enabled`, `source`, `confidence`, `notes`. CHECK constraints on all four enums plus
`limit_value > 0`, `anchor_day 1..31`, `confidence 0..1`. Unique on
`(platform, IFNULL(model_id,''), scope, metric)`.

**`routing_decision`** — the shadow ledger. `logical_model`, `mode`, `actual_platform`,
`actual_model_id`, `shadow_platform`, `shadow_model_id`, `agreed`, `reason`, `candidates_json`.
Indexed on `created_at_ms` and `(logical_model, created_at_ms)`.

**No new columns** on `requests` or `provider_quota_state`. `raw_json` and `status_code` already
existed on `provider_quota_observations` and were simply never populated — that was the defect.

## 5. API endpoints

All under `/api/quota`, all behind `requireAuth` (dashboard session, not the `/v1` key).

| Method | Path | Purpose |
|---|---|---|
| GET | `/policies?platform=` | List declared policies |
| PUT | `/policies` | Create or replace a policy for one subject+metric |
| DELETE | `/policies/:id` | Remove a policy |
| GET | `/state?platform=&model=` | Effective limits per axis, with window, source, confidence |
| GET | `/forecast` | Existing observed-balance forecast |
| GET | `/shadow?days=` | Shadow agreement rate, overall and per logical model |
| GET | `/decisions?disagreed=1&model=&days=&limit=` | Routing decision history |
| GET | `/mode` · PUT `/mode` | Read/switch `off` \| `shadow` \| `active` |

`PUT /policies` **refuses a client-supplied `source`**, so a typed limit cannot label itself
measured and outrank a real provider header. No endpoint returns key material.

## 6. UI added

**None.** The dashboard from the brief (provider overview, model→provider, provider→model,
reset timeline, history charts) was not built — see §13.

## 7. Provider policies implemented

Policy is data, not code. Nothing provider-specific is hardcoded in routing.

- **OpenRouter 50/day** — expressible as a `quota_policy` row and changeable over HTTP without a
  restart. Not seeded; the operator declares it.
- **Groq** — header capture already existed and now retains raw values.
- **Google** — calendar-day resets in a configured IANA zone are expressible for the first time.
- **NVIDIA** — 40 RPM ships as a provider-wide env default (`DEFAULT_PROVIDER_MINUTE_REQUEST_CAPS`);
  no daily cap was invented.
- **Ollama** — monthly and billing-cycle periods are supported by the clock.
- **OpenCode** — no promotional rule hardcoded; 429 learning feeds observations.
- **Hugging Face / SambaNova** — excluded from autoroute by default (§10). SambaNova was already
  unroutable: it is absent from `PLATFORMS` (`routes/keys.ts:30-35`) so no key can be added.

## 8. Quota and reset rules implemented

`services/quota-clock.ts`, pure, no ambient timezone:

- rolling window (returns `resetAt: null` without an oldest event — the reset depends on usage,
  not the clock)
- calendar day / week / month in an IANA zone, DST-correct (offset sampled twice; tests pin the
  23-hour and 25-hour Pacific days)
- signup-anchored billing cycle, clamped in short months
- provider-reported instant (returns `periodStart: null` — told when, not how long)

Pacing: `elapsedFraction`, `usedFraction`, `paceDelta`, `projectedUsageAtReset`,
`projectedUnused`, `projectedExhaustionMs`. All null when inputs are unknown; a missing limit is
not a pace of zero.

## 9. Routing scoring formula

**Deliberately not a weighted blend.** Shadow scores a candidate as the remaining fraction on its
**binding axis** — the worst of the axes that apply:

```
score = min over axes of ( 1 - used / limit ),  clamped to [0,1]
```

`null` (no opinion) is distinct from `0` (known and exhausted). With no shadow data yet, a
formula with tuned constants for scarcity, reset-proximity, latency and reliability would be
false precision. `paceDelta` is recorded per candidate so the weighting can be decided from
recorded data at W4 rather than guessed at now.

The existing bandit score is untouched. Layering: bandit picks the logical model; shadow picks
only which provider would serve it.

## 10. Configuration options

| Setting | Where | Default |
|---|---|---|
| `quota_routing_mode` | `settings`, via `GET/PUT /api/quota/mode` | `shadow` |
| `routing_autoroute_disabled_platforms` | `settings` | `huggingface,sambanova` |
| Quota policies | `quota_policy` table, via `/api/quota/policies` | none |
| `PROVIDER_DAILY_REQUEST_CAP_<PLATFORM>` | env | per-platform defaults |
| `PROVIDER_MINUTE_REQUEST_CAP_<PLATFORM>` | env | nvidia 40 |
| `PROVIDER_DAILY_TOKEN_CAP_<PLATFORM>` | env | per-platform defaults |

Precedence, highest first: **provider header → provider API → operator policy → documentation →
catalog → env cap.** An operator-typed limit never outranks a live provider reading.

## 11. Test results

```
Test Files  254 passed (254)
Tests       2983 passed | 5 skipped (2988)
```

Against the brief's 25 cases: **19 covered** (Pacific reset, UTC reset, rolling, monthly/billing,
provider timestamp, provider duration retention, RPM expiry, shared pool, per-model quota,
exhaustion vs unknown, reset, 429 with retry-after, 429 without headers, underused/behind-pace,
overconsumed, same logical model across providers, HF never autoselected, SambaNova, router
fallback when the quota service throws, shadow never alters selection, no secret leakage).
**Not covered:** active-mode selection (unbuilt), concurrency/atomic counters, restart
persistence as an automated test (verified manually instead).

## 12. Shadow mode results

**None — zero rows.** `routing_decision` is empty because the working checkout has no API keys
and no traffic. Shadow will record on the real deployment. Until then there is no agreement rate
and no basis for W4.

## 13. Known limitations

1. **No dashboard.** Phase F of the brief is entirely unbuilt.
2. **Shadow proves divergence, not benefit.** The preferred provider never ran. Only a bounded
   canary can show the other choice would have been better.
3. **Hard gates still use the old clocks.** Per-model RPD/TPD remain a rolling 24h lookback;
   provider-wide caps remain UTC-calendar. Consolidation moved to the W3→W4 boundary.
4. **Quota subject identity is still wrong for Groq** (ADR F8). All Groq models collapse into
   `groq::account` while the catalog gives them 14400 / 1000 / 250 RPD. Probably a pool-key fix,
   not a migration — the PK already contains `quota_pool_key`. Blocked on live capture.
5. **Duration reset parsing not implemented.** Raw values are now retained; parsing waits until a
   real header shows the format.
6. **Failed-attempt metering counts requests only, never tokens.** On a failure we do not know
   what the provider billed.
7. **`DATA_DIR` is not honoured by the server** — it writes to `server/data/freeapi.db`
   regardless. Discovered during smoke testing.
8. **Unclassified failures are not metered**, biasing local usage slightly low rather than
   arbitrarily high.

## 14. Estimated rather than authoritative

- Every catalog limit (`models.*_limit`) is shipped data, not a provider statement.
- Provider-wide env caps are defaults we chose.
- Operator policies are typed, not measured — kept at `source='operator'` so they never pose as
  measurements.
- Only groq / cerebras / openrouter / modelscope have header specs. NVIDIA, Google, Ollama and
  OpenCode currently produce `source='probe', confidence=0.1` rows with no limits. Whether they
  publish anything is **unknown** until the discovery capture sees live traffic.
- The Groq pooling model (per-model vs per-account) is unverified — our catalog asserts per-model.

## 15. Run migrations

```bash
npm run db:migration:up            # from the repo root
npm run db:migration:status        # what has applied
npm run db:migration:down          # roll back the last one
```

## 16. Run tests

```bash
npm run test -w server                       # 254 files, 2983 tests
npm run test -w server -- src/__tests__/services/quota-clock.test.ts   # one file
npm run test                                 # all workspaces
```

## 17. Start the app

```bash
npm run dev                        # server + client, from the repo root
npm run build && npm start -w server   # production
```

## 18. Switching off → shadow → active

```bash
# Read
curl -s localhost:3001/api/quota/mode -H "Authorization: Bearer $TOKEN"

# Switch
curl -s -X PUT localhost:3001/api/quota/mode \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"mode":"shadow"}'      # off | shadow | active
```

`shadow` is the default. **`active` is not implemented as a selection path yet** — W4. Setting it
today records decisions with `mode='active'` but does not change routing. Read the agreement rate
before considering it:

```bash
curl -s "localhost:3001/api/quota/shadow?days=7" -H "Authorization: Bearer $TOKEN"
curl -s "localhost:3001/api/quota/decisions?disagreed=1" -H "Authorization: Bearer $TOKEN"
```
