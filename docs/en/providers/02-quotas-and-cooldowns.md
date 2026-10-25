**English** · [简体中文](../../zh-cn/providers/02-quotas-and-cooldowns.md)

# Quotas, cooldowns, and key health

Free tiers fail in specific, metered ways: per-minute and per-day request caps, token budgets, concurrency limits, and outright quota exhaustion. The gateway models all of them so the router stops spending fallback attempts on keys it already knows are spent. The machinery lives in [`server/src/services/ratelimit.ts`](../../../server/src/services/ratelimit.ts), [`server/src/services/provider-quota.ts`](../../../server/src/services/provider-quota.ts), [`server/src/services/cooldown-probe.ts`](../../../server/src/services/cooldown-probe.ts), [`server/src/services/health.ts`](../../../server/src/services/health.ts), and the shared back-off parsers in [`server/src/providers/base.ts`](../../../server/src/providers/base.ts).

## Rate-limit windows (RPM/RPD)

Every catalog model row carries `rpm_limit` / `rpd_limit` columns. Before dispatching an attempt, the router checks sliding windows keyed `platform:modelId:keyId:rpm` (minute) or `...:rpd` (day):

- A request is admitted only when `recorded + in-flight < limit` — counting in-flight leases (below) closes the race where N concurrent requests all read the same counter as unspent.
- Windows exist both in memory and persisted; on DB unavailability the router falls back to summing the in-memory window keys.

## Token budgets (TPM/TPD)

`tpm_limit` / `tpd_limit` work the same way with estimated tokens: a request counts against its minute/day token window only if `used + in-flight tokens + estimate` fits under the limit. Because some providers publish a generous RPD but a tiny TPM (the code cites groq `gpt-oss-120b`: rpd 1000 yet tpm 8000), the daily token check also feeds a derived cap so one large burst cannot exhaust a day's budget in seconds.

## Estimated monthly token capacity on Chat

The Chat card reports catalogue estimates, not a live provider balance. It includes only enabled models in the active chain that have an enabled healthy/unknown key within model scope. Custom routes count only credentials for their endpoint.

Each quota pool contributes once. Within a shared pool, each usable key contributes the largest published allowance among the enabled models that key can serve. Unknown allowances contribute no tokens and remain visible in the unpublished count.

Recorded usage is a separate total: all chat tokens logged since the start of the UTC calendar month, including custom endpoints and disabled or removed routes. It is not subtracted from estimated capacity. Daily quotas renew, unpublished pools can serve traffic, and requests sent outside FreeLLMAPI are not visible here.

`GET /api/fallback/token-usage` exposes `totalBudget` as estimated capacity and `totalUsed` as recorded chat usage. Its model rows include `poolKey` and `poolBudget` for the deduplicated legend. The configured pool inventory at `/api/free-tier` still includes chain-disabled members.

## AMD Radeon Cloud shared-model inventory

The built-in `radeon` provider already uses `https://developer.amd.com.cn/radeon/api/v1`. The key from the [AMD China Token Factory page](https://developer.amd.com.cn/radeon/tokenfactory) is used for that endpoint; no separate custom-provider key is needed.

On 2026-10-14, the authenticated `/models` response and public page listed 12 shared models: 11 chat models and `MinerU2.5-Pro` with OCR output. The page also listed three dedicated deployments, which require the operator's own instance credits. Those dedicated deployments and the OCR-only model are not ordinary chat routes.

The hosted FreeLLM catalogue had only two older Radeon entries. Nine missing chat models were registered locally through `POST /api/models` as operator-owned `radeon` models, using AMD's advertised context, vision and tool capabilities. Their automatic fallback entries are off, selected chains are unchanged, and the two previously disabled models remain parked. They are visible under **Keys → Providers → AMD Radeon Cloud**.

AMD's shared-model detail describes its prices as **"Free to use. Points show relative usage—not a charge."** Do not classify these routes as paid solely from the `/models` `free: false` field or numeric price metadata.

### Shared allocation, fleet pressure and cooldown

The capacity indicator uses **one free usage-point allowance per actual AMD credential/pool**, referenced by the models that credential may serve. It never assigns every model a separate copy or converts points into a monthly token budget. Completion headers preserve fractional usage, including consumption smaller than one cent of the API's USD-equivalent unit.

The model/provider row, key view and Quota signals panel consume the same authenticated `GET /api/quota/capacity` snapshot. Account allocation expires as current evidence after 15 minutes or its reported reset. The separate RPM sample expires after one minute. Expired readings stay explicitly **Last reported** rather than becoming an inferred refill. Anonymous key-id-0 probe observations do not create a usable account.

`RadeonProvider` reads the [public per-model fleet-pressure JSON feed](https://developer.amd.com.cn/radeon/api/tokenfactory/load) without login or a credential. One startup-owned background observer allows a 40-second whole-request deadline, shares one in-flight request and waits 20 seconds after completion before refreshing. Anonymous responses were measured at 24–26 seconds; the former five-second deadline caused Unknown readings. Dashboard and routing reads use the cached snapshot immediately, without waiting on AMD.

Each reported model has a fleet-utilisation bar. Its percentage means backend utilisation, not remaining account allowance. The provider's own idle/busy/full classification is authoritative: a model can be full below 100%, and busy does not mean quota exhaustion. Missing readings show **Unknown** without a pretend zero bar. Genuine zero remains a measured 0%. A failed refresh or a reading at least 60 seconds old becomes **Last reported**, with a muted bar and its original timestamp. Existing model/key cooldowns retain their own expiry.

Collection never spends an inference request merely to refresh a badge. The China usage-summary endpoint did not accept the saved API key when checked, so idle allocation values remain last reported until a real request supplies new headers. A source failure must not be rendered as zero use or idle capacity.

Presentation belongs to `quota-capacity-dashboard`. Routing belongs to the separate **Extensions → AMD capacity-aware priority** control (`amd-capacity-routing`, default OFF). When enabled, fresh full AMD routes follow eligible non-full alternatives within the requested model's match tier, but remain available as last resort. Unknown/stale pressure is neutral. Explicit model requests and existing health, capability, scope, cooldown, quota and paid-balance protections still apply. No model is enabled and no saved chain or provider preference is rewritten.

Switching presentation off hides the indicators. Background fleet collection stops only when both capacity extensions are off, or no AMD key is configured. Observations, scopes, model enablement and saved chains are retained. Collection also resumes after a key or consumer is enabled.

## Quota policy and pool identity

Per-model windows cannot describe every provider's economics. `resolveQuotaPolicy()` separates provider, model endpoint and consumed pool, returning a stable pool key plus scope (`model`, `account`, `project`, `shared_pool`), accounting kind (`metered`, `unknown`, `unmetered`), metrics and reset strategy.

- OpenRouter `:free` models consume one `openrouter::free` request pool.
- Groq publishes independent model limits, so each model has its own request/token pool. Exhausting model A does not suppress model B.
- Google keys identify a project, while each Gemini model retains its independently published project/model allowance.
- Hugging Face Router consumes one shared credits pool.
- NVIDIA, SambaNova and several aggregators use shared provider/account pools.
- Radeon Cloud reports both an RPM ceiling and one recurring daily allowance denominated in currency, so `radeon::daily-free` carries the `requests` and `credits` metrics together.
- Unknown promotional capacity stays unknown; the router does not invent a limit.
- A private or loopback custom endpoint is unmetered for external API quota.

The router hard-skips a pool only when a high-confidence observation reports zero remaining with a future reset. Unknown capacity remains eligible. Legacy Groq `groq::account` and Google `google::project` observations remain readable until an exact corrected-pool observation exists for the credential, preventing an upgrade from forgetting a real active exhaustion signal.

### Operator key scopes and account gates

Under **Keys**, each key row exposes **Models & account limits**. Catalogue-backed checkboxes persist `model_scope_json`; an absent scope means the key serves every model of its provider, while a non-empty scope makes the router skip that key for every other model. Live model discovery is only a fallback when the provider has no catalogue rows.

Optional per-key `provider_rpm_limit`, `provider_rpd_limit` and `provider_tpd_limit` values gate the credential before model-specific limits. Blank inherits existing provider behaviour; zero disables that individual account-wide gate. These controls do not convert model-scoped quotas into provider-wide quotas—the quota policy and the explicit operator gate remain separate dimensions.

## Concurrency leases

- **Leases** make in-flight requests visible: every dispatched attempt acquires a lease and releases it after the attempt settles (idempotent release; leaked leases are pruned by age). Without leases, counters are only written *after* the awaited provider call, so parallel streams would sail through the limit and collect real 429s.
- **Opt-in concurrency caps**: most free tiers meter requests-per-minute, not parallelism, so capping by default would serialize providers for no benefit. `MAX_CONCURRENT_REQUESTS_PER_KEY_<PLATFORM>` (per platform) or `MAX_CONCURRENT_REQUESTS_PER_KEY` (fallback) enables a per-key cap checked against live lease counts. There is deliberately no built-in per-platform table: the providers that behave this way are not documented precisely enough to assert numbers for.

## Cooldowns

A 429 blocks that model+key pair for a period:

| Mechanism | Duration | Notes |
| --- | --- | --- |
| Transient cooldown | 90s | Per-minute-window 429; recovers within ~one window. |
| Escalation ladder | 2min → 10min → 1h → 1 day | Hits tracked over a rolling 24h window; a genuinely exhausted daily quota quarantines the key for the rest of the day instead of looping through short cooldowns. A successful request clears the hit counter. |
| Unknown-limit ceiling | capped at 10min | When exhaustion is guessed rather than measured, the bench is capped since the verdict is a guess. |
| Payment required (402) | 1 day | Out-of-credits. |
| Model forbidden (403 tier gate) | 1 day | Key valid, model gated to a higher tier. |
| Local endpoint errors | 5s | Never enters the ladder. |

**Operator ceiling (#952).** Relay endpoints often return "busy" or "insufficient balance" for transient reasons, and a few of those per key can walk a whole pool onto day-long benches. Fallback page → routing options → *Longest automatic cooldown* (`routing_cooldown_ceiling_ms`, `PUT /api/fallback/routing {"cooldownCeilingMs"}`) caps the escalation ladder and the 402/403 benches at 10 min, 1 h or 6 h. Provider-stated retry times (Retry-After, daily-quota resets) are never shortened. The *Router pressure* panel's **Clear all** (`DELETE /api/fallback/penalty-inspector`) lifts every cooldown, score penalty, ladder counter and cross-key failure streak at once; the per-key reset (`DELETE /api/keys/:id/cooldowns`) remains for the surgical case.
| Auth failure (401) | benched until the next health cycle | ~5 minutes. |

### Provenance and probe-based early recovery

Cooldowns record why they exist (`heuristic`, `authoritative`, `credit`, `tier`). Only `heuristic` benches are guesses that often outlive the outage; provider-stated facts (explicit Retry-After expiry, daily-quota reset) and credit/tier benches are never probed because a passing key-validation probe proves nothing about them.

The cooldown-probe job scans every 60s and re-validates probe-ripe keys to clear heuristic cooldowns early:

- ripe only after half the bench has elapsed, and only if >60s remains (probing a nearly-expired bench wastes a validate call);
- a failed probe never extends the bench — it schedules the next probe further out (2min doubling, capped at 15min);
- probes are side-effect-free for health bookkeeping, staggered after restart, and budgeted per pass (`COOLDOWN_PROBE_MAX_PER_PASS`, default 3); `COOLDOWN_PROBE_DISABLED=1` kills the job;
- the probe unit is the KEY, not the model: one `validateKey` result is evidence for every heuristic cooldown that key holds.

## Back-off from headers and error bodies (#798)

Before #798, a provider that stated exactly when to come back got the same heuristic ladder as one that said nothing, because error bodies were flattened to a message string before reaching the router. Now every adapter builds errors via `providerHttpError`, which captures:

1. **The `Retry-After` header** — delta-seconds or HTTP-date, parsed once (shared parser in `providers/base.ts`) and still the winning channel when both sources are present.
2. **A delay stated inside the error body**:
   - structured fields: Gemini answers 429 with `error.details[]` carrying `google.rpc.RetryInfo` whose `retryDelay` reads `"17s"`; the body is walked depth-capped (max depth 6) looking for `retryDelay` / `retry_after` / `retryAfterSeconds` shapes, which is more durable across providers than exact paths;
   - prose: anchored phrases like "try again in 30 seconds" or "retry after 2m" — anchored so an unrelated number in an error message can never be mistaken for a back-off.
3. All parsed delays are clamped to 24h so a malformed/hostile hint cannot bench a key forever.

Only the number is kept — never the body — so nothing extra reaches logs or attempt traces. Tests: [`server/src/__tests__/providers/stated-retry.test.ts`](../../../server/src/__tests__/providers/stated-retry.test.ts).

## Provider-reported quota polling (#1403)

Headers and error bodies only show quota when a request happens to carry them. Providers with a **key-info endpoint** (OpenRouter's `GET /api/v1/key` returns the key's `limit` / `limit_remaining` credit balance; SiliconFlow's `GET /v1/user/info` returns the account's `totalBalance`/`balance` in CNY as numeric strings) can be asked directly, and now are: `BaseProvider.fetchQuota()` is an optional probe that records what the provider itself reports as a `source: 'quota_api'` observation (confidence 1.0). The health pass piggybacks the probe onto a **healthy** verdict only, per key at most once per 15 minutes (`QUOTA_POLL_INTERVAL_MS`), fire-and-forget and failure-silent: a quota probe that errors or times out says nothing about the key and never changes a health verdict. Providers register their endpoint as a `quotaProbe` spec (URL + the JSON fields carrying limit/remaining); a spec may omit `limitFields` when the provider reports only a balance. Providers without a spec pay zero network. This is what fills the dashboard's live balances for pools that send no token-level rate-limit headers, instead of the text-label guess `parseBudget` makes over catalog copy.

xKiro registers `GET https://api.xkiro.com/v1/usage` (`free_tokens.limit_per_day` / `free_tokens.remaining`, metric tokens). Its daily allowance resets at 00:00 UTC, so the observation carries that calendar reset. A spec without a stated reset now records none rather than inventing one 24 hours out.

## Account usage sources (verified 2026-10-17)

Polled every 5 minutes by `provider-usage-api.ts` (GET only, never inference), or learned from responses:

| Provider | Source | Reading | Reset |
|---|---|---|---|
| Ollama Cloud | `GET ollama.com/api/balance` | included credit in USD (legacy plans: session/weekly % left) | the period end it reports |
| OpenRouter | `GET /api/v1/key` `free_model_daily_requests`; `GET /api/v1/credits` | `:free` requests used of 50/1000; credit balance | 00:00 UTC |
| ElectronHub | `GET /v1/user/me` | `credits` of `weekly_credits` | Sunday 21:00 UTC |
| Inferbase | `GET /api/v1/inference/credits` | `requests_this_month` of 5,000 (limit from its pricing page, confidence 0.75) | 1st of the month, 00:00 UTC |
| xKiro | `GET /v1/usage` | free tokens of 1,000,000 a day | 00:00 UTC |
| Google | 429 `QuotaFailure.quotaValue` | the model's daily limit, spent until reset | midnight Pacific |
| Groq, Mistral, AMD | response headers | per model or per minute | as stated |

No account usage API exists for the inference key on Mistral (the admin API is Enterprise-only), NVIDIA, Groq, Agnes or Zhipu (its quota endpoint answers only for Coding Plan accounts). Their cards show what headers, learned limits and local counts can say.

### Usage credentials (UnoRouter, AMD, Google)

These three report account usage only to a second credential. Connect one per key at **Keys → Quota → the provider's card → Connect account usage**. It is stored encrypted in `provider_usage_credentials`, never returned by the API, deleted with its key, and read once on save and then every 5 minutes. The card shows the last read's outcome, including a refusal.

| Provider | Credential | Request | Reading |
|---|---|---|---|
| UnoRouter | user id + System Access Token (Personal Settings → Security Settings) | `GET /api/user/self` with `Authorization: Bearer` and `New-Api-User` | balance `quota` of `quota + used_quota`, converted at `/api/status` `quota_per_unit` (500,000 per $1) |
| AMD | console session `Cookie` header | `GET developer.amd.com.cn/radeon/api/profile/model-usage` | `daily_cost_*_usd`, reset 00:00 Asia/Shanghai. The `rc-` key is refused with "Login required" despite the docs, and the session lapses when the console signs out. |
| Google | service-account JSON key in the API key's project, with `roles/cloudquotas.viewer` and `roles/monitoring.viewer` | RS256 JWT-bearer token, then Cloud Quotas `quotaInfos` and Monitoring `quota/rate/net_usage` since midnight Pacific | per-model free-tier daily limits and today's count. A model is recorded only when Monitoring attributes usage to it; otherwise the card line reports the project-wide count. |

UnoRouter's shapes come from new-api source (`controller/user.go` `GetSelf`, `middleware/auth.go`), AMD's from its docs, and Google's from the Cloud Quotas and Monitoring references. None has been read with a real credential yet, so the first connect is the first live test.

Ollama's undocumented `/api/usage` `limits.*` fractions were withdrawn around 2026-10-07; that endpoint now returns usage history only, so the reader moved to the documented `/api/balance`.

### xKiro free tier (verified 2026-10-19)

Sources: [xkiro.com pricing](https://xkiro.com/#pricing), [Pricing & billing](https://docs.xkiro.com/guides/pricing/), [Access tiers](https://docs.xkiro.com/models/tiers/), [Rate limits](https://docs.xkiro.com/api/rate-limits/), [Usage](https://docs.xkiro.com/api/usage/), and the live key.

- **Allowance.** 500,000 free-model tokens a day, no card. Telegram verification raises it to 1,000,000 a day, plus a **one-time** 30,000,000-token bonus for 30 days. This account reads `limit_per_day: 1000000`, so it is verified. The daily allowance is recurring; the bonus is promotional and expires.
- **Scope.** One account-wide counter across every free-tier model and every key on the account, which is `xkiro::free` here.
- **Reset.** `/v1/usage` counts `used_today` from 00:00 UTC, and that is what gates requests. The pricing page's "sliding window" wording is not what this endpoint reports.
- **Exhaustion.** `429 rate_limit_error`, "You've reached today's free-model token quota", seen in production on 2026-10-16 to 10-18. Free-tier usage never draws on the wallet.
- **Tiers.** `free` works on any account. `paid` needs a plan or positive wallet, and `premium` needs a real deposit. Calling either from a free account returns `403 permission_denied`, never a charge. `GET /v1/models` carries `access_tier` per model.
- **Spend exposure today.** `plan: null`, wallet `0.000000`. Nothing can be billed. If a wallet is ever funded, set a monthly limit per key in the xKiro console first.
- **Bonus is not visible.** `/v1/usage` exposes neither the bonus balance nor its expiry. On 2026-10-19 the account had used 2.5M against a 1M day, and xKiro still served free models from the bonus. The router's ledger reads the daily figure as exhausted and holds xKiro back until 00:00 UTC unless a bonus grant (below) covers the excess.
- **Rate limits.** Per-plan requests per minute, unpublished for the free plan. Hammering after a 429 can earn an IP cooldown.
- **Prompt overhead.** Each chat call reported about 540 prompt tokens for a 6-token user message. Budget accordingly.

`mistralai/mistral-large-4-0` (Mistral Large 4) is `access_tier: free`, 524,288 context, 65,536 max output, with tools, vision and reasoning (`reasoning_effort` `none` or `high`, default `none`). It was verified live on the free tier with the wallet at $0: plain, tool call, JSON mode and high reasoning all returned 200 under the requested model id.

## Temporary bonus grants

A bonus grant is extra provider capacity layered on a normal per-day allowance, for example xKiro's 30M tokens over 30 days on top of 1M a day. It covers the keys that share one account, one metric (tokens or requests), a quantity, and an expiry measured from creation. Grants are configured at **Keys → Quota signals → Bonus grants** and switched by the `bonus-grants` extension.

Admission, in `selectKeyForModel` before the other quota gates:

1. **Normal first.** Today's normal usage is local `rate_limit_usage` for the covered keys since local midnight in the grant's zone. A provider observation taken today wins when it shows more usage (it also sees other clients); its limit applies only when lower than the operator's figure, so a daily limit that includes the bonus cannot widen normal capacity. Requests already in flight count too.
2. **Excess needs a window.** The part of a request beyond the normal limit is admitted only while a spending window is open and both the window and the pool have room for it, net of in-flight excess. Otherwise the key is skipped as `bonus-refused(no-spending-window | spending-window-spent | bonus-pool-spent)`.
3. **Funded excess passes only its own allowance.** When a window funds the excess, the observed-exhaustion gate and quota domains skip the exhausted daily allowance on that metric whose reset is within an hour of the grant's day boundary. Per-minute limits, operator caps, cooldowns, health, scope and the paid-balance guard still apply. A provider 429 benches the key as usual.

Settlement runs synchronously after an attempt's usage is written, including quota-consuming failures. The debit is the attempt's share of today's usage beyond the normal limit, written once to the `bonus_usage` ledger against the pool and the window that admitted it. That window is charged even if it was replaced, cancelled or expired mid-flight. Normal resets restore the normal allowance; they never refill the pool. Edits never reset consumption.

Limits of the local count: only requests this install routed are debited, and only countable metrics are supported. Normal periods are calendar days because `rate_limit_usage` keeps 24 hours.

## Paid credit windows

The paid-balance guard keeps automatic routing off billed models on OpenRouter, AnyAPI and unorouter. A paid credit window (`paid-credit-windows`) is the one bounded exception under it, available where the provider's usage API reports a credit balance (today OpenRouter, `openrouter::credits` in cents).

- **Selection.** The operator ticks paid models from OpenRouter's priced listing. Each gets a `models` row (`source = 'user'`). Only selected models join the auto chains, as a tier appended by `withoutAutorouteDisabled` and walked after every free route, never explored and never promoted by stickiness.
- **Window.** Opened per key with an amount, a duration and the typed confirmation `ALLOW PAID SPEND`. Opening re-reads the balance and refuses a reading older than two minutes. The reported cumulative usage at that moment is the baseline.
- **Measured spend.** Spend is reported usage now minus the baseline. Catalogue prices are never used. Spend by other clients of the account counts, so a window stops early, never late.
- **One attempt at a time.** A paid attempt holds the window. When it ends, the balance is re-read after a five-second settle delay, and the next paid attempt is refused (`paid-credit-refused(credit-awaiting-reading)`) until a reading newer than that exists. Overshoot is bounded by one request's cost plus any lag in the provider's own accounting.
- **Not a second switch.** With the guard off, paid routes already route unbounded by the acknowledged decision, so windows are not consulted. A client that names a paid model is unaffected either way.

## Health checks must not burn metered quota (#882)

Health runs a scheduled pass every 5 minutes (±20% jitter, keys validated more recently than 3.5 minutes skipped, default concurrency 8, ≥1s spacing between same-provider probes). That cadence is fine for free validation endpoints but poisonous where validation itself costs quota. `HEALTH_CHECK_INTERVAL_MS` (milliseconds, minimum 60000, read at startup) changes it for the whole install (#1593):

- ModelScope validates keys with a paid 1-token chat completion (`GET /v1/models` does not enforce auth), spending magic-grain quota — at the default cadence roughly 288 paid probes/key/day. Fix (#882): tokens not prefixed `ms-` are rejected locally with zero network calls, and a successful validation is cached per key for `MODELSCOPE_VALIDATE_CACHE_MS` (default 24h).
- Pollinations' public `/v1/models` answers 200 even for revoked keys, so validation targets the authenticated `/account/key`; AI Horde treats any reachable endpoint as healthy rather than spending queue slots.
- SerpSearch, Exa and keyed Parallel have no account endpoint, so their key check is a search with no query. SerpSearch revoked a user's free account over those empty searches arriving every 5 minutes (#1599). Such providers set `supportsKeyPolling = false`: the scheduled pass validates a key once (when it has never been checked), re-asks about a key parked at `error` at most hourly, and the cooldown probe skips it. Manual "Check now" / "Check all" still validate.

The rule for contributors: **if `validateKey` consumes metered quota, it needs a cache or a free probe path** — see [03-adding-a-new-provider.md](03-adding-a-new-provider.md).
