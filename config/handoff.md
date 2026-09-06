# Session Handoff

## Session 2026-09-07 — JD-MBP (MacBook Pro M2 Max)

**Branch:** `docs/freellm-assert-start-on-redeploy` (NOT main — see below)

**What was done:** Delivered phases A–G of the quota-ledger ADR against live traffic.
Quota-aware routing is built and recording but has never routed: `quota_routing_mode` is
unset and defaults to `shadow` (`services/quota-routing.ts:34`). 822 shadow decisions,
470 agreed.

Beyond the ADR, four things the plan did not anticipate:

- **Provider usage APIs exist and are undocumented.** Probing all seven providers found
  Ollama `/api/usage` (session + weekly fractions) and OpenRouter `/api/v1/credits` +
  `/api/v1/auth/key` (`is_free_tier: false` → the 1000/day allowance, confirmed rather than
  assumed), plus HuggingFace `whoami-v2` — a real validation endpoint, which fixes keys
  reading `unverifiable` forever because `/v1/models` serves anyone. `services/provider-usage-api.ts`
  polls every 300s. Three provider-measured pools are now live in the ledger.
- **Ollama's allowance is derived in credit, not tokens.** It meters GPU time and reports only
  a fraction, so the token figure swung 4.9× between model mixes (71.9M vs 14.8M). Priced
  against `data/ollama-model-rates.ts` the same spend collapses to $2.00 vs $1.53. Free tier
  binds on a **5h session + 7d weekly** window, not the monthly cycle.
- **Two router defects found by driving real traffic.** `isKeyAuthError` treated OpenCode Zen's
  `401: Model X is not supported` as a credential failure and condemned the key, dropping the
  provider while 6 of 11 models worked. And `skipBench` on `finish_reason === 'length'`
  forgave a reasoning model burning a 215K-token prefill on hidden reasoning three times over,
  metered as 1 request / 0 tokens. Both fixed; failed attempts now meter their tokens.
- **`scripts/deploy.sh` + 9 tests**, written because the ad-hoc `compose up -d | tail -1`
  reported success on a failed deploy all session. It caught its own bug on first use, then
  caught a real port race twice more.

**Two claims retracted after checking them.** "18,026s confirms the documented 5 hours to
0.14%" was coincidence — two of the three apparent boundaries were polling artefacts from a
4.9h outage my own deploys caused. With the boundary-gap guard in place **no period is
currently measurable** and the estimator says so. Also: the run-aggregation guard exists
because a reset hidden in a polling gap inflates a derived allowance several-fold.

264 test files green. Deployed and independently verified by the script:
`main-20260907-074108`, container healthy, `/api/health` answering 401.

**Branch correction:** you checked out `docs/freellm-assert-start-on-redeploy` at 06:52 and
committed `5cfd71c` thirteen seconds later. My last five commits landed there, not on `main`
(tip `7463c45`), and four of my status reports said "main" wrongly. The deployed image is
correct — it builds from the working tree.

**What's next:**

1. **Leave the container alone ~10h.** Two resets each bracketed within 20 min make the session
   period measurable for the first time. Every deploy restarts the series. Usage *helps* — a
   reset is only visible as a step from <70% to ≥90%, so an idle pool at 100% shows nothing.
   Check: `sqlite3 … "SELECT observed_at, remaining_value FROM provider_quota_observations
   WHERE quota_pool_key='ollama::session' ORDER BY observed_at DESC LIMIT 8"`.
2. **Decide where the five commits land, then push.** `fork/main` is a clean 91-ahead
   fast-forward, 0 behind. `origin` is `tashfeenahmed/freellmapi` — upstream, not yours.
3. **Active mode is a decision, not a task.** Shadow's disagreement is concentrated where NVIDIA
   hits its 40 RPM cap and on the exhausted Ollama session (right 4-for-4 there). Worth
   understanding before flipping.
4. **Unverified at the surface:** the policy editor has never been rendered in a browser (no
   dashboard login) and the burn test has only run against stub providers.
5. **Unidentified:** the client looping 215K-token prompts sends no agent header — it arrives
   as `unknown` from the Docker host gateway `192.168.65.1`.

**In progress:** —

## Latest session — 2026-09-05 (MacBook Pro M2 Max)

**Branch:** main
**Repo:** freellmapi
**Work:** Quota ledger + quota-aware router, Pass 1 through W3

### Decision record

`docs/adr/ARCH-20260905-quota-ledger-and-quota-aware-router.md` — APPROVED.
`config/plan-current.md` points at it.

**Revision 2 supersedes revision 1.** An outside review (Codex `gpt-5.6-sol`, spec at
`codex/tasks/quota-ledger-adr-review.md`) returned NO and corrected five of seven findings.
Every correction was re-verified against source before being accepted. One of them — F4,
"zero 429s in the request log" — was my own measurement error: the query's `%` wildcards were
percent-decoded by the tooling before SQLite saw them. The real count is 38.

**The motivation changed as a result.** Not "recurring free quota is being wasted" — at 375
requests/day peak, idle Groq capacity was unavoidable, not waste. The measured harm is
scarce-provider exhaustion: 35 rate-limited Google attempts, **10 of which ended in a request
that failed for the user**, while Groq and NVIDIA sat idle. That argues for a scarcity term,
not a pacing engine.

### Landed (11 commits, suite green: 253 files / 2975 tests)

| Wedge | State | What |
|---|---|---|
| W0 | 3 of 5 | Pool-key/scope decoupling; raw header capture + `status_code`; failed-attempt metering |
| W1 | ✅ | Provider-wide autoroute exclusion (Hugging Face, SambaNova off by default) |
| W2 | ✅ | Timezone-safe reset clock; `quota_policy` table, resolver, `/api/quota` |
| W3 | ✅ | Shadow decision ledger + `quota_routing_mode` (defaults to `shadow`) |

New files: `services/quota-clock.ts`, `services/quota-policy.ts`, `services/quota-routing.ts`,
`routes/quota.ts`, migrations `20260905_000001_quota_policy`, `20260905_000002_routing_decision`.

### Open, and why

- **F3 duration parsing** and **F8 subject identity** are both blocked on the same trigger:
  one live Groq call. `parseResetAtFromHeader` accepts numerics only, so Groq's documented
  `2m59.56s` form was dropped with no record it ever arrived — raw capture now retains it, but
  only from the next request forward. The 4,469 historical observations stay NULL.
  Check: `sqlite3 server/data/freeapi.db "SELECT quota_pool_key, limit_value, raw_json FROM
  provider_quota_observations WHERE source='header' ORDER BY created_at DESC LIMIT 5"`.
  Differing `limit_value` per Groq model settles F8; the `raw_json` reset string settles F3.
- **F8 is probably not a migration.** The primary key already contains `quota_pool_key`, so a
  per-model Groq pool key separates the rows with no schema change. Hazard either way:
  `services/health.ts:100,183` pass `modelId: null`, which would split-brain against request
  traffic. See the 2026-09-05 amendment in the ADR.
- **Hard-gate consolidation moved out of W2** to the W3→W4 boundary. Switching
  `canMakeRequest` from rolling-24h to policy windows changes what gets rejected, live, on
  every model; running the one irreversible enforcement change before the observation layer
  inverts the point of shadow.
- **F9 attempt metering** counts requests only, never tokens — on a failure we do not know
  what the provider billed.

### Notes for next session

- `server/data/freeapi.db` is **empty** (0 keys, 0 requests). All evidence in the ADR came from
  `backups/freellmapi-data-20260902-131315.tar.gz`. The live-capture trigger is the real
  deployment, not this checkout.
- The DB path env var is **`FREEAPI_DB_PATH`**, not `DATA_DIR` — `DATA_DIR` does not exist and
  is silently ignored, so a smoke test pointed at it writes to the live
  `server/data/freeapi.db`. An earlier one did exactly that; the test data was cleaned out and
  the new tables legitimately remain.
- `package-lock.json` was already modified before this session; left alone.
- Untracked and deliberately not committed: `.compressa/`, `backups/`, `config/`, `freellmapi/`.

### What's next

1. **W4** — bounded canary, then active mode and the dashboard. Shadow must produce data first,
   which needs live traffic.
2. Remaining W0 items once a live capture lands.
