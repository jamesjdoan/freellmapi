# Session Handoff

## Session 2026-09-24 — JD-STUDIO (Mac Studio M2 Max)

**Branch:** `docs/freellm-assert-start-on-redeploy` — nothing committed. Changes are in the
working tree and deployed (container rebuilt with `docker compose up -d --build`, `Up (healthy)`
on `127.0.0.1:3001`).

### Done

- Offloaded inference card (Analytics) collapses by default, remembered per browser under
  `freellmapi.offloadedInference.collapsed`. The collapsed header shows `FreeLLM proxy $x`,
  `Free CLI fleet $y` (only when `clifree-fleet-telemetry` is on) and `Total $z`.
  Verified live: collapsed on a cleared key, header read $77.56 / $0.93 / $78.49 for 24h.
- Router pressure and Fallback chains on Models → Chat were already collapsed by default
  (`freellmapi.penaltyInspector.collapsed`, `freellmapi.chainManager.collapsed`). No change. A
  browser that once expanded them keeps them expanded until its localStorage key is cleared.
- New key `analytics.offload.fleet`, filled into 59 locales with the English text.
- Client: `tsc` clean, 57 files / 483 tests pass, `check:i18n` passes.
### Open

- Uncommitted: `client/src/components/offloaded-inference.tsx`, 60 locale files, plus the
  pre-existing `config/*`, `docs/GOTCHAS.md` and `.compressa/ledger.jsonl` edits from earlier.
- The stray `jamesjdoan/freellmapi:client-update` image from this session can be deleted.

### Open

- Uncommitted: `client/src/components/offloaded-inference.tsx`, 60 locale files, plus the
  pre-existing `config/*`, `docs/GOTCHAS.md` and `.compressa/ledger.jsonl` edits from earlier.
- The stray `jamesjdoan/freellmapi:client-update` image from this session can be deleted.

## Session 2026-09-23 — JD-STUDIO (Mac Studio M2 Max)

**Branch:** `docs/freellm-assert-start-on-redeploy` — 10 commits, all deployed and pushed to
`fork` (`30ff896e` → `8f9e4e26`). Local and `fork` are level.

**What was done:**

- **The "F1–F7 review" this session was meant to apply did not exist.** No 2026-09-23 block, no
  review file, no transcript. The only F1–F7 in the repo belong to the quota-ledger ADR. A fresh
  `reviewer` pass found one real defect: the Quota signals tab ignored `quota-capacity-dashboard`.
  Fixed in `KeysPage.tsx`, and the registry `codeLocations` now follow the move. Then committed and
  deployed the clifree usage-value and quota-tab work (`30ff896e`): migration 000003 ran, and keys
  decrypt `ok=11 fail=0`. The old `/quota` URL now 404s in-app.
- **Model names everywhere read as base plus a faint variant.** `client/src/lib/model-name.ts`
  (`splitModelName`) and `client/src/components/model-name.tsx`. "Claude Fable 5.1 (Adaptive
  Reasoning, Xhigh Effort, Default Fallback)" and "GPT-5.2 (xhigh)" both become base plus *Xhigh*.
  Non-default parts are kept ("Non-reasoning" is what stops Sonnet 5 High colliding), with
  0 collisions over AA's 673 names. Applied to the Compare graph and table, the Mapped to column,
  the fleet table and all four benchmark pickers (the new opt-in `renderLabel` on
  `ModelCombobox`). Pickers size to the longest name and wrap.
- **Probed all 50 keyed free routes:** 46 ok, 4 limited, 0 dead. NVIDIA `gemma-4-31b-it` and
  `gpt-oss-20b` timed out twice and were removed from NVIDIA key 18's scope. `gpt-oss-20b` also
  left the curated chains. `nvidia/google/diffusiongemma-26b-a4b-it` passed a real image probe
  and joined Vision 17. The ten working-but-unchained routes are recorded in
  `routing-curation.ts` with the reason each stays out (you chose "only real depth"). The live
  chains and the container's spec agree: 79 rows, 0 switched off.
- **The Compare Price chart now ranks by AA cost per task by default** (`indexCostPerTask`,
  157 of 673 models), with a Per 1M tokens switch. The view had been keyed `costPerTask` while
  ranking on token price.

**What's next:**

1. **APEX domain comparison, Pass 1 pending the source.** AA's free tier has no APEX fields (all
   673 models checked). Mercor's leaderboard pages carry the full data in `__NEXT_DATA__`, with no
   key, and `readyBenchmarks` lists the domains dynamically. You want a summary block ("best model
   for which domain") plus per-domain scores. It stays display-only and must not touch
   `auto:apex` routing. Choose Mercor pages or an AA commercial key, then write
   `docs/adr/ARCH-20260923-apex-domain-comparison.md` as PENDING.
2. `openrouter/deepseek/deepseek-v4-flash-0731:free` holds Extra-Tier 8 but is outside the
   OpenRouter key's scope, so that position adds nothing. Scope it or drop it —
   `GET /api/fallback/reachability`.
3. Optional: redirect `/quota` to `/keys` for old bookmarks.

**In progress:** —

## Session 2026-09-22 — JD-STUDIO (Mac Studio M2 Max)

**Branch:** `docs/freellm-assert-start-on-redeploy` — 4 commits, pushed to `fork`
(`8688c534`, `4002ee7a`, `4a3e6a21`, `65dfa8de`). Note `origin` is upstream
`tashfeenahmed/freellmapi`; a `git push origin` on this branch 403s, which is correct.

**What was done:** Added Cline to the free-CLI delegation path, then built fleet telemetry
for it in FreeLLM — machines report what they can reach, the dashboard shows it.

- **Cline's free tier has the same shape as OpenCode Zen's**, so it got the same answer: its
  docs say free models are "not supported through the Cline API", matching Zen's 403, so both
  are driven through the vendor CLI rather than routed. `atelier` now carries `jd-clifree`
  (replacing `jd-opencode`, retired to `tier: manual`, not deleted) over 28 free routes on one
  capability ladder — 7 Zen, 21 Cline. Benchmarked 11/11 vs 1/11 baseline on a recorded rung.
- **Fleet telemetry (ADR `ARCH-20260922-clifree-fleet-telemetry`, APPROVED).** The container
  has one mount and cannot read host state, so each machine POSTs its own snapshot;
  `clifree_fleet_snapshot` holds one row per (machine, spec) and a delivery replaces that
  machine's rows wholesale. Transport is SSH to the Studio, which posts to its own loopback —
  listening on the tailnet was rejected, since it turns the dashboard into a network service
  every later change inherits.
- **The ingest endpoint accepts the unified API key as well as a session**, deliberately:
  sessions expire after 30 days, so a reporter on a timer would authenticate today and fail
  silently next month with the panel showing that machine as stale rather than broken.
- **Free CLI fleet panel** on `/analytics/compare`: nine columns mirroring the comparison
  table, capabilities merged on benchmark (28 routes → 24 rows), remappable, with OC/CL marks
  naming which agent reaches each row. Baselines can be toggled in and interleave by score.
- **Three pre-existing defects fixed in shared code**, all affecting pages beyond this feature:
  `PopoverContent` accepted `side` and never forwarded it; `ModelCombobox`'s `autoFocus`
  scrolled the page to the top on open; and the Compare scope pills claimed containment while
  `Enabled` (355) was larger than `Have a key` (58) and contained models it did not. `Enabled`
  now means enabled AND keyed, tested on the same member.
- **`compare.chainApply` was missing from `en.json`** while present in all 59 locales — a
  code-sync dropped it, so the chain-picker button rendered a raw key and `check:i18n` was red.
  The migration roundtrip suite was red too, on a data-only migration whose `down()` is
  correctly a no-op; migrations can now declare `dataOnly`.

**What's next:**

1. Only one machine reports, so the cross-machine comparison the feature exists for is
   untested. Run on the MBP: `clifree-report.sh | ssh <studio> 'FREELLM_API_KEY=… ~/Code/Instrumenta/atelier/scripts/clifree-report.sh --post-stdin'`.
2. Reachability reads `unprobed` for every route — probing costs quota. `clifree-rank.sh -p`
   then re-report, and the tool-incompatible routes (`z-ai/glm-5.2:free`, `qwen3.8-27b:free`)
   will read `notools` instead of unknown.
3. Find out why `client/` `tsc --noEmit` passes what the Docker build rejects; until then the
   local check is not a gate. See the 2026-09-22 block in `docs/GOTCHAS.md`.

**In progress:** nothing mid-flight; tree clean, all four commits pushed.

## Session 2026-09-21 — JD-STUDIO (Mac Studio M2 Max)

**Branch:** `docs/freellm-assert-start-on-redeploy` (unchanged — nothing committed this session)

**What was done:** Made OpenCode models reference-only, condensed the Analytics device
comparison, and fixed a compile error that had blocked every image build since 11 Sep.

- **OpenCode models are now catalogued but unroutable by construction.** Zen 403s any call
  from outside its own CLI (already recorded in `docs/GOTCHAS.md`), so every control offering
  to enable one stated something false. The enable switch is replaced by a `reference` pill on
  all three surfaces that had one — Models table row, its group header, and the Keys provider
  panel — and the key-scope pickers on Compare filter reference-only routes out of their route
  list rather than hiding the control, so a mixed group's routable siblings stay editable.
  One definition, `server/src/data/reference-only-platforms.ts`, with a client copy in
  `client/src/lib/routing.ts`; it cannot live in `@freellmapi/shared` (see gotchas).
- **They now stay disabled.** `catalog-sync` forces `enabled=0` for these platforms on both the
  insert and the update branch, and `applyModelOverrides` drops the `enabled` key for them.
  That last one was the actual bug: a stale `{"enabled":1}` in `model_overrides` had been
  re-enabling two models on every sync, reverting manual `UPDATE`s twice before it was found.
  Verified by setting rows to `enabled=1` directly in SQLite and watching a restart clear them.
- **Compare Models gained an `OpenCode only` scope pill** beside Routed / Keyed / Enabled / All.
- **Analytics compare mode is metric-first.** Was one panel per machine each repeating the same
  four figures; now four shared cards with the machines as rows inside them and the unfiltered
  total as a muted context row, colour-matched to the existing combined chart. `Panel`'s `icon`
  is now optional.
- **`lib/request-log.ts:93` passed `latencyMs`, a name that does not exist** (the parameter is
  `elapsedMs`). Introduced 2026-09-11 in `c67f0857`; it failed `tsc` and so blocked every
  `docker compose build` for ten days. Unrelated to the rest of this session's work.
- **Diagnosed UnoRouter's free GLM failures as provider-side capacity, not our request pacing** —
  17% success all-time, 3 `rate_limited` rows ever, 170s minimum gap. Written up in memory as
  `upstream-capacity-is-not-our-pacing`.

**What's next:**

1. Nothing is committed — ten files across five deploys, including the unrelated
   `request-log.ts` fix, which reads better as its own commit. `git status --porcelain`.
2. No visual confirmation of any UI change this session. The omp browser relay serves on
   `:9224` but its extension never connects (`omp browser-relay install`), and headless Chrome
   stops at the login screen because `requireAuth` has no bypass. Everything was verified from
   the shipped bundle and the database instead. The Compare metric cards at `md` width are the
   one thing genuinely unverified.
3. UnoRouter sits at priority 3 in Apex at a 17% success rate — demote or drop it. Recommended,
   not actioned.
4. `PATCH /api/models/:id` still accepts an enable for a reference-only platform; sync reverts
   it at the next pass rather than refusing it. Three lines in the route would close the window.

**In progress:** —

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
