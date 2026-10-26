# Changelog

## 2026-10-27 — Chain auto-arrange and route bench probes (built, not deployed)

- **Why.** On 2026-10-26, 47 of the 85 routes in the six chains had no real requests in 14 days, so their positions were never measured. Under `routing_strategy = priority` the stored order decides which model serves, and that order was hand-set and stale. Extra-Tier, the overflow for every chain, was headed by ten never-called custom routes. ADR `ARCH-20261026-chain-auto-arrange`, approved 2026-10-26.
- **Chain auto-arrange** (`services/chain-arrange.ts`, extension `chain-auto-arrange`, on by default, hourly).
  - Orders routes, not models. Per route: reliability tier (Wilson lower bound over real traffic plus probes), eligibility against the chain minimums with a 10% tolerance band (an unpublished score is never a failure), then the chain's own metric.
  - The head spreads across independent quota pools. Per-chain minimum depth defaults: Apex, Coding and Default 8 models across 4 pools; Fast-Lane 6 across 3; Vision 4 across 2.
  - Operator pins always win, and a hand move in a managed chain becomes a pin. Any chain can be switched to manual.
  - Every applied order is a `chain_arrange_run` row with the reasons for every position.
  - The curation applier keeps arranged priorities in managed chains. `judgeMetric` (`model-bench/passport.ts`) is now the one minimum rule for both passport recommendations and the arranger.
- **Route bench probes** (`services/route-probe.ts`, extension `route-bench-probe`, on by default, every 15 minutes).
  - Each probe is one graded agentic scenario (A1–A3 rotating), sent streamed with native tools through the route's own key.
  - Budget: 1–2 per route per day, only for chain routes without real traffic in 24h, never into a cooldown, closed quota or paid route. Quota about to expire unused is spent first.
  - Results append to `route_probe_result`, keyed by route. Bench CLI imports append there too, so the host-only coding scenarios have a history.
  - Dashboard: **Routing → Auto-arrange** (preview, pins, depth, run history) and **Keys → provider → History** (daily drift, every probe, Probe now).
- **Migration** `20261026_000001_route_probes_and_chain_arrange`: creates two tables and changes nothing existing. `down()` drops only those two tables.
- **Verified:**
  - Server: 435 files, 5425 passed, 5 skipped. Client: 96 files, 731 passed. Both type-checks clean; i18n 60 locales.
  - On a copy of the production DB: the migration applied, and every chain previewed in under 100 ms.
  - One real streamed probe: `groq/openai/gpt-oss-120b` A1 PASS at 100, 328 ms, 243+69 tokens from the stream's own usage frame.
  - `nvidia/stepfun-ai/step-5-preview` A1 FAIL at 0 after 37 s, recorded as evidence.
  - A second apply on the copy wrote nothing.
- **Not yet done:** image rebuild and redeploy (needs approval); re-pinning MiniMax M3.1 Flash at Apex 3, chosen by hand on 2026-10-26 but not yet a pin, so the first pass would move it to 6.

## 2026-10-26 — Upstream v0.16.9 merged (deployed `main-20261026-064426`)

- `--no-ff` merge of tag `v0.16.9` onto `f5419594`, committed as `c44a4c2b` and fast-forwarded onto `docs/freellm-assert-start-on-redeploy`. It covers v0.16.4–v0.16.9, 63 commits. Recovery tag: `imperium/pre-v0.16.9-recovery`. Rollback image: `jamesjdoan/freellmapi:provider-routing-before-20261026-064426`. Volume backup: `backups/freellmapi-data-20261026-064426.tar.gz`.
- **Live after deploy:**
  - `Up (healthy)` on `127.0.0.1:3001`, running the same image ID as the validated candidate (`eff4aca0`).
  - 99 migrations, with the three new ones applied.
  - 19/19 keys decrypt.
  - `auto:fast-lane` answered "OK" through `groq/qwen/qwen3.8-27b`.
  - `/v1/models` lists 556 ids.
- **72 conflicts.** The 60 locale files were merged key by key; no value had changed on both sides. The 12 code and doc conflicts:
  - `resolveQuotaPolicy` kept (the documented exception). Upstream's onomeo and IteraCompute pools were ported into it, and Auray's pool was dropped.
  - No account-wide NVIDIA minute cap (measured per model); upstream's APINex 5/min cap taken.
  - Analytics keeps our window scope and takes upstream's first-value rule for repeated params (#1597) across every page filter.
  - `last_healthy_at` (#1493) taken. Our rule that the health payload's error wins over the key row's stale one is kept.
  - Moderation keeps the paid-balance guard and takes upstream's monthly-cap gate.
  - The migration manifest is filename-ordered with upstream's three new migrations.
  - Upstream's deleted Auray test and its Auray checklist case were dropped.
- **Deference review: nothing to delete.** No upstream change in the window does what an extension does. Upstream's model probe (#1492) is opt-in and observation-only, monthly-cap alerts (#1665) cover only monthly caps, `/v1/usage` reads our own ledger, and the Groq OTPM fix (#1546) complements the pool resolver.
- **Validation:**
  - Typecheck clean on both packages; `check:i18n` passes.
  - Client tests: 717/717.
  - Server tests: 5395 passed and 2 failed in the full run. Both failures are timing budgets (`compression` performance, `router-key-bandit` 5 s) that pass alone and pass on the pre-merge tree.
  - Two upstream tests ported to the fork's API: `inferQuotaPoolKey`, and the auth-aware fetch mock.
  - Image `jamesjdoan/freellmapi:candidate-v0.16.9` built on Node 24.
  - **Migration rehearsal** on a copy of the live DB: the first run applied the three new migrations, and the second applied nothing. `api_keys` was identical apart from the new empty column; the Auray removal touched no rows.
  - **Candidate container on a data copy:** came up healthy; 19/19 keys decrypt; all 41 extensions on the same states as live. `auto:fast-lane` and `auto` both answered through `groq/qwen/qwen3.8-27b`; `/v1/usage` and `/v1/models/auto` answered 200; the Keys page and Extensions panel rendered.
- **Found on the way:** `groq/qwen/qwen3.8-27b` (model 687) had `tpm_limit 1000`, learned from 32 OTPM rejections — the bug #1546 fixes. No write was needed: the boot catalogue re-apply restored the catalogue's 70,000, and no override pins it. Under #1546 an OTPM rejection now writes nothing, so this kind of rejection can no longer pull it back down.

## 2026-10-25 — UnoRouter's free chat models added; Step 5 Preview joins five chains (live data)

- **82 UnoRouter `:free` chat models added** through `POST /api/models`, each with `rpm_limit 1`, matching the two rows already there. The live `/v1/models` listing had 147 `:free` ids. The rest were left out:
  - 48 are embedding, image or AI Horde endpoints.
  - 16 are typed `openai` but are not chat models: speech (Whisper, Nova 3, Aura), embedding, music (Lyria), translation, robotics, a safety classifier and a calibration model.
  - `glm-5.3-flash:free` was already present.
  - `glm-5.3:free` is no longer listed upstream. Its row is kept.
- An AA relink afterwards matched 38 of the 84 UnoRouter rows. No chain auto-includes new models, so adding them changed no routing.
- **Screened tool use (A1) on every route. Only 8 reached a verdict** before the account started refusing everything:
  - PASS with native tool calls: Step 5 Preview, DeepSeek V4.1 Flash 1017, Agents A1, Beam, DiffusionGemma 26B.
  - FAIL: Cohere Command A, DeepSeek R1 Distill 32B, ALLaM 2 7B (simulated tools).
  - A 1-per-model sequential pass got 8 answers, then `429 … 1 request(s) every 1 min per account` on every model. That includes models never called before, and calls spaced 20 s to 2 min apart for 30 minutes. A single call after 3 quiet minutes was refused the same way: `x-ratelimit-remaining: 0`, `Retry-After: 60`. UnoRouter documents the cap as per model, per user. This behaves account-wide, and nothing in FreeLLM was calling UnoRouter at the time. The other 74 routes and the C1/C3 coding scenarios are untested.
- **The bench's own chain grading decided membership.** Both routes were appended at the tail of each chain through `POST /api/fallback/membership`:
  - `unorouter/step-5-preview:free` has I 43.7 measured, and coding 75.2 / agentic 43.4 typed (`tested`) from its NVIDIA and Speka routes. It joins Apex, Coding and Default as `provisional`, and Fast-Lane and Extra-Tier as `qualified`.
  - `unorouter/deepseek-v4.1-flash-1017:free` has I 45.1 and no coding or agentic score. It joins Fast-Lane and Extra-Tier. Apex, Coding and Default stay `insufficient evidence`.
  - Agents A1 and Beam have no score at all. DiffusionGemma is below every general minimum (I 9.5).
- The seven A1 verdicts with real usage were imported as screen results, at 1 scenario each.
- **Routed traffic since the chain adds: 0 of 75.** Between 10:04 and 13:24 UTC, Step 5 Preview got 39 × `429 … per account`. DeepSeek V4.1 Flash 1017 got 20 × `503 get_channel_failed`, 15 × 429 and one 520.
- **Apex candidates tested 2026-10-26 00:38–01:03 (AEDT): 0 of 18 answered.** MiniMax M3.1 Flash (I 42.7, typed coding 74.2 / agentic 46, the only UnoRouter route that would meet Apex) and MiMo V2.6 Flash (I 37.9, 0.1 under Apex's general floor) got only 429s and 503s across A1, C1 and C3. Calls were 75 s apart per model, and neither model is in a chain.

## 2026-10-25 — Remaining screen results imported; Agnes free tier caps at a handful of calls (live data)

- **Every local passport with a verdict is now imported** through `POST /api/analysis/bench-results`. Four had never been: Qwen3 32B (Inferbase) 601.5 tokens per task over 6 verdicts, Qwen3 30B-A3B (Inferbase) 866.75 over 4, the retired OpenRouter `minimax/minimax-m3.1-flash:free` 1,150.5 over 6, and Mistral Large 4 (xKiro). Compare returns each one with `source: "screen"`.
  - **Mistral Large 4 was removed again.** Its passport was a cached re-render, which reports 0 tokens, so it imported as 0 tokens per task. The row is deleted until a fresh run gives a real figure.
  - The seven 2026-10-20 passports with no verdict (six `custom` Llama/GLM routes and both Zhipu routes) were not imported. The import refuses a run with no verdict.
- **Agnes re-screened with all six scenarios.** Agnes 3.0 Flash passed A1, C1 and C3 again (443 tokens per task, replacing 448). Its A1 pass was a NATIVE tool call, 1 of 1 structurally valid, although the catalogue lists the route with `supports_tools = 0`.
- **The Agnes free account is not routing capacity.** Both models hit `429: You've reached the API rate limit for free users` after a few calls: Agnes 3.0 Flash after 3, Agnes 2.5 Flash after 7. A second run on Agnes 2.5 Flash failed all 3 calls. It is one account limit shared across the Agnes models, so neither joins a chain. Agnes 2.5 Flash keeps its 2026-10-23 import, and the passport on disk now holds the rate-limited run.
- Internal screen scores stay off the chain-minimum cells, as `docs/en/operations/model-bench.md` requires. They are on the screen's own 0–100 scale.

## 2026-10-23 — Agnes and Aion screened; Vercel free-tier rules confirmed (live data)

- **All 9 Agnes and Aion models screened** (3 scenarios: tool use, bug fixing, code review) on a live-data copy. 5 produced verdicts and were imported; 3 failed every call and 1 failed on tool selection:
  - Agnes 2.5 Flash 3/3 PASS, 764 tokens per task. Agnes 3.0 Flash 3/3 PASS, 448.
  - Aion 3.0 3/3 (85.7 on implementation, 83.3 on review), 593. Aion 3.0 Mini 2/3, 1,034. Aion 2.0 0/3.
  - No verdicts: Agnes 2.0 Flash (3 failed calls), Agnes 2.5 Pro and Pro Alpha (3 failed calls each; the 2.5 Pro route carried a measured AA score already).
- Agnes 2.5 Pro keeps its measured AA scores (I 35.2, C 62.3); Agnes 3.0 Flash borrows them as a family figure.
- **Vercel free-tier rules, from its own pricing page:** the free tier covers a SUBSET of models, not the full catalogue; its requests are rate limited per model; the free credit starts on the first request; and buying any credits moves the team to the paid tier, after which the monthly free credit no longer applies. So the choice is a bounded $5/month on a narrow model list, or spending money for everything.

## 2026-10-23 — The free MiniMax is over; all four routes retired (live data)

- **Vercel's $0 promotion ended 22 Oct.** The model is $0.15/M in and $0.60/M out, billed to the credit balance. $1.31 of the $5 was spent before it was caught — the unlimited flag had been cleared, but the route kept carrying the heaviest traffic in the install.
- **All four MiniMax routes are switched off**, each with a note naming its own reason:
  - Vercel (custom): switched off, removed from every chain, expiry row cleared.
  - Ollama: 402 "this model is not included in your free usage" — it bills pay-as-you-go.
  - OpenRouter `:free`: 404, retired on 22 Oct (see the previous entry).
  - Kilo: left on, but it has no working key, so it cannot serve.
- Every chain was checked for MiniMax rows still enabled: none. Routing after: `auto` served DeepSeek V4.1 Flash, `auto:apex` and `auto:coding` served GLM-5.3 Flash, `auto:fast-lane` served Qwen3.8 27B.
- The MiniMax model Passport and its 797-tokens-per-task screen result stay in the benchmark record, so if a free route appears again the comparison is there.

## 2026-10-23 — Retired OpenRouter ids cleaned up; Poolside given a proxy score (live data)

- **The OpenRouter key scope was 17 model ids, 12 of them dead.** Probed every one on 2026-10-23: 12 answered 404 (retired upstream, or "no longer available for free" — the Space Bunny Alpha, the Ling 3.0 free variants, the DeepSeek V4 Flash free, Apodex, NEX, GLM-5.2 free, MiniMax M2.7/M3 free, Qwen3.8-27B free), 3 answered 200, one 429 and one 403. The scope now holds the 5 that still exist: the three Nemotron free models, Xing 4.0 and Ling 3.1 Flash. The 429 and the 403 are transient limits, not retirements, so those two were kept.
- The 12 retired catalogue rows were already switched off, and the retired MiniMax row carries a note naming the paid replacement.
- **Poolside Laguna has no AA entry.** Checked against AA's live catalogue on 2026-10-23: no Laguna at all. Its 5 enabled routes are now PROXY-linked to Nemotron 3.5 Super VL (I 26.5, C 57.4, A 25.7), the closest published relative: an open-weights agentic coding model. A proxy is a "read this as roughly that" claim, not a measurement, and it never merges two routes.
- Poolside still could not be screened: the NVIDIA route answers 503 "Worker local total request limit reached" and the Vercel route 503 as well. Both rows carry a note saying so, and that the scores shown are the proxy's.
- **17 screen results are imported.** 15 of them sit behind an AA estimate, so the dashboard shows the AA range and keeps the screen figure in the passport. The 2 visible screen figures are Google Gemini 3 Flash Preview (201 tokens per task, 3 scenarios) and Gemini 3.7 Flash (263, 1 scenario).

## 2026-10-23 — Model screen across the routed set; OpenRouter retired its :free MiniMax (live data)

- **Screened 20 routes** with our own benchmark (3 scenarios: tool use, bug fixing, code review) on a copy of the live database, then imported the 14 that produced a verdict. The rest could not be measured, each for a provider reason, not a model one: UnoRouter 503 (all upstreams busy), ElectronHub 429 (its monthly 100,000 free tokens are spent, resets in 10 days), Google 503 (high demand), xKiro on cooldown, Inferera MiMo V2.6 Pro 404 (retired upstream), NVIDIA GLM-5.3 Flash 429, Poolside Laguna XS 2.1 503 then a 90s timeout.
- **OpenRouter retired `minimax/minimax-m3.1-flash:free`.** Its API answers 404: "The free launch period for MiniMax M3.1 Flash ended on Oct 22, 2026." That route carried 985 requests a day, the busiest in the install. Model 1701 is switched off with a note; the paid replacement is `minimax/minimax-m3.1-flash` at $0.15/M in and $0.60/M out. It stays on the key's model list, so a return would serve again.
- **Tokens per task, measured** (screen, tokens ÷ scenarios passed): Groq Qwen3.8 27B 403, Radeon DeepSeek-V4-Flash 394, Inferera MiMo V2.6 Flash 394, NVIDIA DeepSeek V4.1 Flash 661, NVIDIA GLM-5.3 662, Vercel MiniMax 797, ElectronHub DeepSeek V4 Flash 938, Radeon Qwen3.8 Flash Next 1,050.
- The pattern: the models that pass all three scenarios are the cheap ones, at about 400 tokens per task. The higher-scoring ones spend 660-800 and lose points on code review.
- Poolside Laguna XS 2.1 has neither an AA score nor a screen result: it is the one Poolside model with no numbers, because its only reachable route is overloaded.

## 2026-10-21 — Expiry countdown on a model row; Quota bars count down (deployed `main-20261023-064053`)

- Live after deploy: the `model_expiry` table exists, all 19 keys decrypt, and the Vercel MiniMax row (1707) carries the expiry 2026-10-22T23:59:00Z with its unlimited flag still on. The compare payload returns it.

- **A model's free access can now carry an end date.** New table `model_expiry` (migration `20261022_000002`, reversible) and `PATCH /api/models/:id` with `expiresAt` + `expiryLabel`. The Keys provider model table shows a chip beside the name: "13h 45m left", ticking once a minute, with the date and the reason in its tooltip.
- **It is a reminder only.** Nothing switches off and no route changes when the countdown reaches zero, at James's instruction: a promotion ending is not a model breaking. The Vercel MiniMax row keeps its unlimited flag.
- **Fixed a broken cell on the way.** The provider model table printed "0 of {limit}" for any model with no declared daily limit, because the server sends `limit: null`. The limit is nullable in the client type now, and the cell says what it knows.
- **Every allowance bar counts down** (shows what is left, shrinks as it is used): provider cards, forecast, AMD capacity, bonus grants, paid credit. Bonus and paid credit used to fill up with usage.
- **Numbers are labelled**: "500,000 used of 1,200,000", "$4.00 spent of $5.00", "81% left", "12 left of 20".
- **Quota page cleaned up**: about 7,000px of open panels became about 2,000px. Cards size to their content and show 3 pools before "+N more"; window names read as words ("Weekly credit"); two pools with one name say what each counts ("Daily free · requests", "Daily free · credit"); providers with nothing reported share one line of chips; one Details holds AMD capacity, the forecast, headroom and raw readings.
- **Redundant UI strings removed:** 24 strings referenced nowhere, 1,440 entries across 60 locales. The stray `client/src/i18n/en.json` stub deleted.
- Checks: the client typechecks and builds, the full suite passes (93 files / 704 tests); the server typechecks and the full suite passes (411 files / 5,194 tests). The expiry flow was verified on a live-data copy: the API stored the date, the compare payload carried it, and the row showed the countdown.

## 2026-10-22 — Quota numbers say what is left; redundant UI strings removed (local, not deployed)

- **Every allowance bar counts down.** The provider cards, the forecast, AMD capacity, bonus grants and paid credit all show what is LEFT and shrink as it is used, red at 20% or less and amber at half or less. Bonus and paid-credit bars used to fill UP with usage.
- **Numbers are labelled.** Provider cards read "{amount} left" and "{pct}% left". Bonus grants and paid credit say "500,000 used of 1,200,000", and AMD says "x left of y". Nothing is a bare fraction any more.
- **Redundant UI strings removed:** 24 strings were in `en.json` and all 59 other locales but referenced nowhere (old scopes, verdicts the diagnosis renders dynamically but through prefixes, Compare filters from an older UI). 1,440 locale entries deleted; `check-i18n` passes at 60 locales / 2,169 keys.
- The stray `client/src/i18n/en.json` stub (2 keys, Oct 14) duplicated keys the real locale already holds; deleted.
- Checks: the client typechecks and builds, the full suite passes (92 files / 700 tests), and lint shows no new errors versus `HEAD`.

## 2026-10-22 — Keys → Quota cleaned up (local, not deployed)

- The page was about 7,000px of mostly open panels. It is now about 2,000px, measured on live data at desktop width: allowance cards, then bonus grants and paid credit, then one closed **Details**.
- **Cards size to their own content.** They were stretched to the tallest card in their row. Each card shows 3 pools before "+N more" (was 5), so Mistral and Groq no longer leave empty bands.
- **Readable pool names.** Window names read as words ("weekly-credit" → "Weekly credit", "daily-free" → "Daily free"). Model ids are kept as they are. When two pools share a name, each says what it counts, for example AMD's "Daily free · requests" and "Daily free · credit", which looked like a duplicate.
- **Providers with nothing reported** (Agnes, UnoRouter, Zhipu) are one line of chips under the cards instead of three empty cards. UnoRouter's chip keeps its Connect account usage link.
- **One Details disclosure** now holds the AMD fleet capacity, the forecast, provider headroom with declared limits, and raw readings. Headroom and declared limits used to open by themselves whenever a policy existed.
- Checks: the client typechecks and builds, and the full suite passes (92 files / 700 tests, including a new test for repeated pool names). Lint shows the same 1 error as `HEAD`. The page stays 390px wide on a phone.

## 2026-10-22 — "New" models marked seen on one device stay seen on all (deployed `main-20261022-095940`)

- The Keys "N new" tag and the panel's "Mark N seen" kept their list in each browser's localStorage. Marks made on the Mac did not reach the iPad or the tailnet address, and were lost when site data was cleared. So tags kept coming back.
- They now use the server's acknowledgement (`catalogue_ack`, via `POST /api/models/changes/acknowledge-bulk`), the same record Premium → Catalog updates uses. Marking seen anywhere clears the tag everywhere, and every catalogue-changes view refreshes.
- On first load, a browser that still holds the old list sends those marks to the server once, then deletes the list, so nothing marked before comes back.
- On a live-data copy, with two separate sessions standing in for two devices: one marked 17 Custom arrivals seen, and the other session's unseen count for Custom went from 17 to gone. The other providers were unchanged.
- Checks: the client typechecks and builds, the full suite passes (92 files / 699 tests), and lint shows only 2 pre-existing errors in `provider-churn.tsx` (lines 34 and 143, not this change).

## 2026-10-22 — Extra-Tier is every chain's overflow (deployed `main-20261022-094030`)

- Live after deploy: both `overflow` columns exist, all 19 keys decrypt, and `auto`, `auto:apex`, `auto:coding` and `auto:fast-lane` each returned 200 from their own members (`overflow` 0).

- When a chain runs out, Extra-Tier's enabled routes that are not already in that chain are tried last, before `routing_exhausted`. Only routes that meet the chain's tools or vision requirement are added, in Extra-Tier's order. The chain's own members always come first, and the sticky preference, exploration and bandit can never move an overflow route ahead of them. Plain `auto`, `auto:<name>` and the aliases get it. Global sorts, Extra-Tier itself and explicit model ids do not.
- Switch: extension `extra-tier-overflow`, on by default. Answers are marked in new columns `requests.overflow` and `request_attempts.overflow` (migration `20261022_000001`, reversible), and shown in the analytics request detail.
- Measured on a live-data copy:
  - With Fast-Lane forced out of routes, the request went to Extra-Tier, and the row and attempt were marked `overflow: 1`.
  - The tail is small, because 2026-10-22 filled every chain with its qualifying routes: Apex 21, Default 18, Coding 18, Fast-Lane 1 and Vision 1 extra routes.
  - Most of those are Inferera custom routes whose quota is spent. With Apex forced out, all 21 were checked and refused ("17 quota allowance spent, 3 cooldown"). So today the overflow adds capacity only when Extra-Tier gains routes that the chains don't already hold.
- Fixed in review: the subagent's build had dropped `route.routingTrace = trace` from `routeRequest`, which removed the routing trace from every served request (8 failing tests). Restored. Two tests were updated for the intended behaviour: an `overflow` field on attempts, and a fixture chain no longer named Extra-Tier.
- Checks: the server typechecks. The full suite: 410 of 411 files pass (5,193 tests). The one failure, `router-bandit` "exploration toggle", is a random-draw test. It passed 3 of 3 runs on its own, and it involves no Extra-Tier rows.

## 2026-10-22 — Every qualifying route added to its chain (live data, no code change)

- Each chain now holds every enabled route that a key can reach and that meets its revision-7 minimums. Enabled members per chain: Apex 13 → 18, Default 13 → 27, Coding 19 → 30, Vision 12 → 15, Extra-Tier 29 → 78, Fast-Lane 11 → 58.
- Order: the existing qualifying members keep their place. New routes follow: proven first (at least 20 calls at 80% or better over 14 days), then those with some working evidence, then untested. Fast-Lane orders them by measured latency, the others by the chain's lead score.
- Members that no longer meet the minimums stay at the tail, still enabled. Examples: Mistral Large 4 and Groq Qwen3.8 27B in Apex, Codestral in Coding, and GPT-OSS 20B/120B and the Ministrals in Fast-Lane.
- Left out as measurably failing (at least 10 calls, under 30% success): every Inferera "coding-*" route (Kimi K3 0%/152, GLM-4.7 0%/53, MiniMax M3 0%/69, K2.6 0%/60, Kimi for coding 0%/70), MiMo V2.6 Pro on Inferera (15%/33), and Nemotron 3 Ultra (custom 0%/59, NVIDIA 6%/18).
- Applied through `PUT /api/profiles/:id/reorder`. The backup of every chain's rows beforehand is `backups/chain-fill-backup-2026-10-21T14-12-01-793Z.json`. After the change, `auto`, `auto:apex`, `auto:coding`, `auto:fast-lane` and `auto:extra-tier` each returned 200.
- The overflow design (Extra-Tier as the tail of every chain) is proposed in `docs/adr/ARCH-20261022-extra-tier-overflow.md`, not built.

## 2026-10-21 — Editing a chain no longer changes plain-auto routing (deployed `main-20261022-010730`)

- Live after deploy: `default-chain` and `active` both read Default (1), plain `auto` returned 200, and all 19 keys decrypt.

- **The bug.** One setting, `settings.active_profile_id`, meant two things: the chain the dashboard's table showed and edited, and the chain a request that names no chain (`model: "auto"`) routed through. Opening Extra-Tier to edit it silently moved every plain-auto request onto the overflow chain.
- Two settings now. `active_profile_id` is the chain being edited and viewed. The new `default_chain_profile_id` is the chain plain `auto` routes through, and it is the only one the router reads.
- Migration `20261021_000001_default_chain_profile` copies the current active value into the new setting when it is absent, so the deploy changes no routing. Live active is Default (id 1), so plain auto keeps routing over Default. Reversible; covered by the migration round-trip test.
- A `default_chain_profile_id` that names a deleted profile resolves to the Default chain, and the profile `DELETE` route moves the setting there too. A missing setting keeps the legacy meaning: no chain at all, so `fallback_config` is the chain — which is what every existing install with no profiles relies on.
- API: `GET /api/profiles/default-chain` and `POST /api/profiles/default-chain { profileId }` (404 on an unknown profile). `active_profile_id`, the fallback-chain listing, the models list, the token-usage estimate and the free-tier inventory keep following the chain being edited; the routing paths (`auto`, global sorts, exclude-from-auto enable flags, unify member priorities) and the quota forecast follow the routing default.
- Dashboard: chain rows gained a `plain auto` badge on the chain plain auto uses and a **Use for plain auto** action that confirms before it fires. **Edit** (formerly **Activate**) only points the table below at a chain. When the chain being edited is not the plain-auto chain, the table says which is which.
- Tests: `server` — 410 files / 5,182 tests pass (5 skipped), typecheck clean. `client` — 92 files / 699 tests pass, `tsc -b`, build clean, and lint on the two changed files shows the same single pre-existing `FallbackPage.tsx` error as `HEAD`.

## 2026-10-21 — Chains 8 → 6; typed scores apply to every route of a model (deployed `main-20261021-202037`, applied live)

- **Why fewer chains.** Over 14 days, `auto:frontier`, `auto:apex`, `auto:coding` and `auto:vision` ran out of routes 3,789 times. The chains shared most members: Apex × Frontier 91%, Workhorse × Default 93%, Frontier × Coding 86%. So they cooled down together.
- **Merged in code.** Frontier goes into Apex, and Workhorse into Default. `auto:frontier` and `auto:workhorse` still work as aliases (`CHAIN_ALIASES` in `router.ts`), so OMP's config keeps working. The remaining chains are Apex, Default, Coding, Vision, Fast-Lane and Extra-Tier.
  - Chain minimums ignore stored keys for the removed chains.
  - The curated spec folds Frontier positions into Apex and Workhorse into Default. One route is dropped, `openrouter/ling-3.0-flash-fin:free`, a second route on OpenRouter's single free counter.
- **Live rewrite, applied 2026-10-21 after the deploy.** The live dry run matched the rehearsal. The chain backup is `backups/chain-merge-backup-2026-10-21T09-22-01-418Z.json` (all four profiles' rows, plus minimums revision 6).
  - Apex is rebuilt to 13 members across 9 quota pools, led by GLM-5.3 Flash (NVIDIA, 93% success over 14 days), Qwen3.8 Max (xKiro, 97%), MiniMax M3.1 Flash on OpenRouter (100%) and Vercel. Dropped: Step 5 Preview, which has no tools and 0% success.
  - Default is rebuilt to 13. Dropped: Gemini 3.5 Flash, GLM-5.2 on Inferera, Qwen3.8 Omni Flash, Radeon Qwen3.8-27B and ElectronHub GPT-5.6 Luna. Each was weak, duplicate or failing.
  - Removed members stay as switched-off rows, so nothing is lost. The Frontier and Workhorse profiles are deleted.
  - Minimums saved as revision 7:
    - Apex: General 38 + (Coding 65 OR Agentic 40)
    - Default: General 30 + Agentic 25
    - Coding: General 25 + (Coding 60 OR Agentic 35)
    - Fast-Lane: General 15
  - On the copy, `/v1/models` listed the 6 chains, and `auto:frontier`, `auto:workhorse` and `auto:apex` each returned 200.
  - Live after apply: `/v1/models` lists the 6 chains. `auto:frontier`, `auto:workhorse` and `auto:apex` returned 200 via MiniMax M3.1 Flash, and `auto:coding` via GLM-5.3 Flash. All 19 keys decrypt.
- **Typed scores follow the model.** A tested, approximated or family score typed on one route now applies to every route linked to the same AA model, including routes added later. A route's own entry still wins. 8 missing rows were also filled on the live data: MiniMax M3.1 Flash on Kilo, Ollama and Vercel, and Step 5 on Speka. On the copy, all four MiniMax routes read Coding 74.2 (tested) and Agentic 46.
- Checks: the server suite passes (408 files / 5,171 tests), including the alias, legacy-document and shared-score tests. The client suite passes (92 files / 699 tests), and the build is clean.

## 2026-10-21 — Fast-Lane takes minimums; collapsed Keys rows cleaned up (deployed `main-20261021-095253`)

- **Fast-Lane in Chain minimums.** It was hard-coded as reserved because it is ordered on measured latency, not capability. It now takes General, Coding and Agentic floors like every chain, with AND/OR, so its members can be compared on capability. The default is General 15.
  - A saved document that predates this reads Fast-Lane at its default and keeps every saved minimum. A regression test covers the 7-chain document as it is live today (revision 6).
  - On a live-data copy at General 15, Fast-Lane showed 71 qualifiers and 4 of 11 members passing. GPT-OSS 20B (9.0), Nemotron 3.5 Lightning (12.9) and Ministral 3B (4.8) are below.
  - The "reserved" flag is gone from `/api/chain-minimums` requirements, the bench passport, Apply recommendations and the Members view.
- **Collapsed Keys rows.** A collapsed provider now shows its name, one health dot and only what needs attention: the diagnosis (`Access denied E403`, `rate limited E429`, `key off`), new models, and the balance (`84% tokens`).
  - Moved to the expanded view: the masked key, label, base URL, last-check time, "N/M in key scope" and the churn history chip.
  - The "1" key count on single-key providers and the "1 healthy" text are gone. Issues still say so in words.
  - On a live-data copy, all 18 collapsed rows are one 32px line at desktop width, and the page stays 390px wide on a phone.
- Checks: the server suite and the client suite (92 files / 699 tests) pass, typecheck and build are clean, and lint shows the same single pre-existing error in `provider-list.tsx` as `HEAD`. Two Keys tests now expand the provider before checking key actions.

## 2026-10-21 — Chain minimums: AND / OR per metric (deployed `main-20261021-080939`)

- Each metric on a chain in the Chain minimums panel has an AND/OR button. AND (the default) means the model must meet that minimum. OR metrics are alternatives: the model must meet every AND minimum, plus at least one OR minimum. Example: intelligence AND (coding OR agentic).
- A line under the chain spells the rule out, for example "Needs at least one of Coding or Agentic."
- Grading is the same everywhere: Compare and Keys highlights, chain fit chips, Apply recommendations and the benchmark passport.
  - An OR group fails only when every alternative is measured below its minimum.
  - When none passes but one is unscored, the result is "unknown", not a miss.
  - A measured passing alternative beats an estimated one when deciding whether the result is provisional.
- Stored as `either` on each chain in `imperium_chain_minimums`. A document saved before this reads `either: []`, so every existing minimum stays required. Checked on a live-data copy: revision 6 read with `either: []`.
- On the copy, setting Coding to coding OR agentic raised Coding qualifiers from 36 to 57, and saving round-tripped `either: ["coding","agentic"]` (revision 8). The live minimums are untouched.
- Checks: the full server suite passes (408 files / 5,169 tests) and the client suite passes (92 files / 699 tests), including new AND/OR cases on both sides. Typecheck, build and lint are clean. 7 new strings, filled into 59 locales.

## 2026-10-20 — "no tools" mark beside agentic (deployed `main-20261021-071815`)

- Tool support is a route fact, usually the provider's catalogue. 14 providers advertise no tools on any route, and 25 linked models have tools on some routes but not others. Vision is unrelated.
- So the agentic score stays as the model's own figure, and a small "no tools" mark now sits beside it, with a tooltip explaining why:
  - **Keys → provider model table:** on each route without tool support.
  - **Compare:** only when none of the model's routes offer tools.
- Checked against the live API through a local client:
  - Compare marked 4 rows: Step 5 Preview, Ling 3.1 Flash, Agnes 2.5 Pro and Agnes 3.0 Flash. MiniMax M3.1 Flash is unmarked because its OpenRouter route has tools.
  - The Inferbase model table marked 31 of 64 rows.
- Checks: the client typechecks and builds, and the full suite passes (92 files / 693 tests). 3 new strings, filled into 59 locales.

## 2026-10-20 — Coding and agentic filled from AA sub-scores (live data, no code change)

- AA publishes Intelligence plus SciCode, Terminal-Bench v4, LCR and HLE for its newest models, but not their Coding or Agentic index. 25 enabled models were missing one or both.
- The gap was fitted from AA's own data with least squares on the models that have every input. Coding fit: R² 0.95, typical error ±3.2. Agentic fit: R² 0.97, typical error ±2.2. Where the sub-scores are missing, agentic falls back to an Intelligence-only fit: R² 0.92, typical error ±3.3.
- Written through `PUT /api/analysis/score`: 34 values, 96 route rows, 0 failures. They were first marked `approximated`, then switched to `tested` the same day on James's call, because they are calculated from AA's measured sub-tests, not guessed. `tested` counts toward chain minimums and role thresholds, which `approximated` does not. The table had no typed scores before this. The empty-table snapshot is `backups/model_benchmark_entry-20261020-before-aa-derived.json`.
  - Coding and agentic for the 9 newest models, including MiniMax M3.1 Flash at C 74.2 / A 46, Step 5 at 75.2 / 43.4 and Mistral Large 4 at 67.5 / 40.5.
  - Agentic only, from the Intelligence-only fit, for 16 older models. Their coding stays empty because AA's API carries no sub-scores for them.
- Read back through the live API: MiniMax M3.1 Flash shows I 42.7 (measured), C 74.2 and A 46 (approximated).
- These are typed scores, so an AA sync won't replace them. Re-check after a sync that publishes the real indices. The method is in `docs/en/operations/model-bench.md`, intake step 4.

## 2026-10-20 — Token efficiency stat (deployed `main-20261020-205740`)

- New base stat "Tokens/task" next to Speed on Compare, Keys → provider model table and the CLI-free fleet (ADR `ARCH-20261020-task-efficiency-column`, approved by James).
- **AA estimate:** AA's cost per Intelligence Index task ÷ the model's prices, shown as a token range from all-output to all-input price. AA publishes no input/output split, so the range is what the data supports. The column sorts on the 3:1 blend, shown in the tooltip. A proxied model is marked `≈`. Changed from a rank on James's call, the same day.
- **Screen:** benchmark tokens ÷ scenarios that reached a verdict, shown as a number marked "screen". It is used only where AA has no estimate, and only after `POST /api/analysis/bench-results` imports a passport. `DELETE` removes it. New table `model_bench_result` (migration `20261020_000001`, reversible).
- Verified on a live-data copy through a local server:
  - MiniMax M3.1 Flash reads `366.8K–1.5M` (838.5K at 3:1). Its imported screen result (1,150.5) is not shown, because AA wins.
  - Mistral Large 4 reads `271.3K–833.9K ≈` (proxy).
  - Across the 107 groups with an AA estimate, the range runs from Mistral Large 3 at `20.7K–62.2K` to Nemotron 3 Super at `1.8M–5.5M`.
  - Qwen3-32B read "screen" 601.5 after import and "—" after delete.
  - A Zhipu run with no verdicts was refused (400).
  - Compare sorts ascending by the 3:1 estimate, with AA rows before screen rows.
- Checks: the server typechecks, and the new and analysis/migration suites pass (17 files / 137 tests). The client typechecks and builds, the full suite passes (92 files / 693 tests), and lint shows no new errors. i18n: 5 keys, filled into 59 locales.

## 2026-10-20 — Keys page fits a phone (deployed `main-20261020-164618`)

- At 390px the Providers tab was 874px wide: each provider row put the switch, name, chips, key, status, time and actions on one line.
- Provider rows now wrap on phones. Line 1 has the switch, name, menu and chevron. Chips and the inline key drop to line 2, and the key actions to line 3. From `sm` up, the wrapper uses `display: contents`, so desktop is unchanged (checked at 1280px).
- Multi-key rows wrap the same way. Model tables scroll sideways inside their panel instead of widening the page.
- Checked against live data through a local dev server: the page is 390px wide on all five tabs with every provider expanded. Client typecheck passes, the Keys and pages tests pass (28 files / 139 tests), and lint shows the same 41 errors as `HEAD`.

## 2026-10-18 — Model screening benchmark (CLI only; nothing to deploy)

- Added `server/src/services/model-bench/` (fixtures, sandbox, grade, runner, passport), the CLI `server/src/scripts/model-bench.ts` (`npm run model:bench -w server`) and `docs/en/operations/model-bench.md`.
- **What it does:**
  - Six fixed scenarios (A1–A3 tool use, C1–C3 Python) run straight at one provider route, with no router or chain fallback.
  - Stage 1 (A1, C1, C3) screens. Stage 2 runs per capability, so a coding-only model is kept.
  - Grading is deterministic: assertions, hidden unit tests in an OS sandbox, and fixed rubrics. No model grades another.
  - A token budget is checked before every call. Results are cached per bench version, route and configuration.
  - Model Passports in JSON and Markdown, plus a ranking that keeps published AA scores, typed estimates and internal 0–100 scores apart.
- **Safety:**
  - Runs on a temp copy of `--db`, refuses paid routes and routes on cooldown, and binds custom routes to their own key.
  - No table, no migration and no runtime change.
- **Found while testing:**
  - A1 passed a reversed currency conversion; direction is now one decisive check.
  - Dead endpoints counted as promising.
  - A failed internal screen read as provisional role support.
  - The first stub run picked another relay's custom key. Before this was fixed, 24 calls went to aihubmix with a stub model id; all were refused 400, with 0 tokens spent.
- **Verified:**
  - 19 bench tests, including a correct and a defective reply per scenario and a sandbox escape attempt. The full server suite passes (391 files / 4,913 tests).
  - CLI against a local stub endpoint on a live-data copy: a good model passed 6/6 on 3,050 tokens, and a weak one stopped after stage 1 on 670.
  - **First live run (2026-10-19):** `xkiro/mistralai/mistral-large-4-0`, 6/6 PASS. Agentic 100, coding 87.3 (C2 parser rejected `"45s"`, a real defect), 9/9 calls, 7,897 tokens. It found one more classification bug: an estimate below a role threshold read as provisional support. It now reads "insufficient evidence", with a regression test (19 bench tests pass).

## 2026-10-19 — xKiro Mistral Large 4 added; OpenCode Big Pickle ignored (live data, no code change)

- **xKiro:** already a registered provider (key 41), so it was not re-added.
  - Verified against the docs and the live key: free plan, no card. 500K tokens a day, or 1M after Telegram verification (this account), plus a one-time 30M bonus for 30 days. One account-wide counter that resets 00:00 UTC; exhaustion is a 429.
  - Plan `null`, wallet `$0.000000`, so nothing can be billed. Details are in `docs/en/providers/02-quotas-and-cooldowns.md`.
- **Mistral Large 4:** `mistralai/mistral-large-4-0` is listed `access_tier: free`.
  - Verified live: plain, tool call, JSON mode and high reasoning all returned 200 with the wallet unchanged.
  - Added through `POST /api/models` as row 1700 ("Mistral Large 4 (xKiro)"), 524K context, tools and vision. Enabled, but in no chain (no profile auto-includes new models).
  - Benchmark link: proxy to AA `mistral-large-4` (Mistral Large 4 Preview, 38.4), read as related family.
- **Bonus grant (live, grant id 1).** At first the router held xKiro back (`observed-quota-exhausted`), because the daily figure read exhausted while the account drew on the 30M bonus, which `/v1/usage` does not expose. Now configured:
  - Pool: 2,020,250 tokens. That is 30M minus the 27,979,750 xKiro served above 1M a day on 16–19 Oct (15,318,072 / 7,587,190 / 3,574,129 / 1,500,359). Normal limit 1,000,000 a day, UTC.
  - Start date: Telegram verification on 2026-10-16, confirmed by James and matching the ADR's `limit_per_day: 1000000` reading that day. Our local override had never been enabled, but xKiro spends the bonus whenever it serves past the daily limit. That traffic got through before the router saw a 429, because the quota poll runs every 5 minutes.
  - First created from an 18 Oct start (24.9M), then corrected the same morning.
  - Grant expires 2026-11-14 23:23 UTC, inside the 15 Nov end of the 30 days. The spending window covers the remaining 2,019,700 until 21:35 the same day.
  - A routed request to `mistralai/mistral-large-4-0` that had been refused then returned 200 through xKiro.
- **OpenCode Big Pickle (`big-pickle`):** catalogue-ignored on the operator's report that it is no longer free.
  - It was already off, unused and in no chain, so the ignore switched off 0 keys and 0 models. It only keeps the row off across syncs.
  - OpenCode's docs, its live `/v1/models` and models.dev still listed it at $0 on 2026-10-19.

## 2026-10-19 — Merge upstream v0.16.3

- `--no-ff` merge of tag `v0.16.3` onto `21160d04`. Covers upstream v0.16.0–v0.16.3, 28 commits:
  - Decision models and the Decision routing strategy.
  - Opt-in provider-moment failure attribution, and a min-context-window pool floor.
  - Learned output caps keyed per endpoint.
  - APINex, BeatAPI and SerpSearch.
  - GitHub Models removed, LLMTR keys re-enabled, Auray no longer offered to new users.
  - Bulk delete of custom models, plus retention sweeps.
- Recovery tag: `imperium/pre-v0.16.3-recovery`. `main` fast-forwarded to `v0.16.3`.
- **Conflict resolutions (13 code files):**
  - **Additive, both kept:** migration manifest (re-sorted by filename), fallback route imports, `add-key-form`, provider-list bulk delete, KeysPage state.
  - **Combined:** `request-log` writes both `unlimited` and `failure_attribution`. Router stats exclude burn tests and opted-out moments.
  - **`openai-compat` key validation:** upstream's "/models must answer JSON" check, then our unauthenticated-request check.
  - **`provider-quota`:** our typed resolver kept (measured per-model metering, see `routing-curation.ts`). Upstream's APINex pool ported; the retired GitHub pool dropped.
  - **`catalog-sync`:** upstream's decision models and shape-problem reporter, with `Catalog`/`isCatalog` still exported for our callers.
  - **KeysPage `?add=`:** convergent. Upstream's validated version kept; ours reduced to `?platform=` focus only.
  - **Provider list:** our one-group-open behaviour kept.
  - **Tests:** roundtrip stays manifest-driven, and both checklist tests are kept.
  - **Locales:** three-way JSON merge (upstream text wins; our added keys carried), then English fill.
- **Data:**
  - The new migrations writing existing rows were checked against this install before merging. `llmtr_reenable_keys` (no LLMTR keys) and `remove_github_provider` (no GitHub rows) are no-ops here.
  - Rehearsed on a copy of the live volume: only the four upstream migrations applied, and a second run applied nothing. All 18 keys decrypt.
  - `requests` gained an empty `failure_attribution` column with every original column byte-identical. Two settings record empty change lists.
- **Verified:** server 406 files / 5,130 tests, client 90 files / 680 tests, both typechecks, i18n (60 locales / 2,166 keys). Lint is unchanged from the pre-merge counts on every touched file.

## 2026-10-18 — Typed benchmark scores with provenance (deployed `main-20261018-153526`)

- ADR `ARCH-20261018-manual-benchmark-scores` (D1–D5 approved). On live data, 28 of 142 keyed models had no scores, 24 linked ones had no coding score and 32 no agentic score. Nothing could fill them.
- A typed intelligence, coding or agentic score (0–100) is now stored per route and metric with a required provenance: related family, approximated or tested. New table `model_benchmark_entry` (migration `20261018_000001`), and `PUT`/`DELETE /api/analysis/score`. A route that already has a measurement for that metric gets 409.
- One resolution rule, `resolveScore`, feeds Compare rows, groups (`groupScore`: measured > tested > family > approximated) and `getAdjustedScores`. A measurement wins and keeps the typed score as superseded. Otherwise the typed score applies, then a proxy's borrowed figure, read as related family. Routes scored only by typed entries now reach the router's score view.
- **Client:**
  - The Compare index cells, sorting and chart read the resolved scores.
  - An empty cell offers **+**, which opens an entry form: a value from 0 to 100 and a required choice of Related family, Approximated or Tested. A typed score can be edited or cleared.
  - Non-measured scores print in cyan (tested), indigo (related family) or fuchsia (approximated), with an italic note under the number. The note runs inline in the cramped model table.
  - The Keys provider panel, the chain-minimums panel and the model table show the same.
  - Chain grading is now per metric: approximated and related-family scores count as estimates, while tested scores grade like measurements.
  - New `lib/score-provenance.ts`, `components/score-value.tsx`, and `scoreProvenance.*` strings filled across 60 locales.
- **Verified:**
  - Server: 390 files / 4,894 tests. Client: 84 files / 658 tests. Both typechecks and the build pass. Lint on the new and changed files is clean; the three large files carry the same pre-existing errors as `HEAD` (40, 2 and 1).
  - On a live-data copy, the API refused a score without a provenance (400) and a score typed over a measurement (409).
  - It took `custom/coding-glm-5-free` coding 19.4 as tested, and `custom/cat-jam-free` intelligence 15 as approximated. The approximated score reached `/api/fallback` with `source: null` and provenance `approximated`.
  - Chrome showed the cyan "tested" and fuchsia "approximated" cells, seven existing proxies in indigo, and the entry form with Save disabled. The copy was deleted afterwards.

## 2026-10-17 — Usage credentials for UnoRouter, AMD and Google (deployed `main-20261017-232211`)

- These three report account usage only to a credential other than the inference key. A key can now carry one encrypted usage credential: new table `provider_usage_credentials` (migration `20261017_000002`, cascades with the key) and `services/usage-credentials.ts`.
- The credential is set from the provider card (Keys → Quota → Connect account usage) and handled by `GET/PUT/DELETE /api/quota/usage-credentials[/:keyId]`. Secrets are write-only. A save reads the provider at once, and every read stores its outcome, so an expired session or a missing role shows on the card.
- New readers:
  - **UnoRouter:** `/api/user/self` with access token and `New-Api-User`, balance in cents at the published `quota_per_unit`.
  - **AMD:** console-cookie `profile/model-usage`, daily cost cap, Shanghai reset.
  - **Google:** service-account JWT, then Cloud Quotas per-model daily limits and Monitoring usage since midnight Pacific. A model is recorded only when its usage is attributable.
- Cards: a reading whose reset has passed shows as refilled instead of "used up" forever. Google sends nothing on success, so a learned spent limit would otherwise never clear.
- **Overview fix:** `getProviderQuotaOverview` deduplicated measured pools by pool alone, so a pool measured in two units lost its second reading. Found in the smoke run:
  - ElectronHub's $0.25 weekly credit sat behind its 5-a-minute request header.
  - AMD's header-reported $1.00 daily cost cap was never shown.
  - Deduplication is now by pool and metric, with a regression test.
- Unverified against real credentials: all three shapes come from source, docs and unauthenticated probes. The AMD `rc-` key was re-probed and is still refused ("Login required").
- **Smoke run on a live-data copy:**
  - Fake UnoRouter and AMD credentials were refused by the real providers: HTTP 401 and "session expired". The cards showed both refusals, and the startup poll re-read them.
  - Google rejected invalid JSON with a 400, and Groq answered with a 404.
  - The Google dialog rendered.
  - The copy was deleted afterwards.

## 2026-10-17 — Quota sources audited and filled in (deployed `main-20261017-232211`)

- **Why some cards were stale:**
  - Ollama's undocumented `/api/usage` `limits.*` shape was withdrawn around 2026-10-07, so its reader silently returned nothing for 10 days.
  - Agnes, Zhipu and Inferbase only looked fresh because of probe rows with no numbers.
- **New readers in `provider-usage-api.ts`** (primary-source research, then GET-only probes with the live keys):
  - Ollama `/api/balance`: $2.50/$2.50 until 10 Nov.
  - OpenRouter `/api/v1/key` `free_model_daily_requests`: 996/1000, resetting 00:00 UTC.
  - ElectronHub `/v1/user/me`: $0.25/$0.25, resetting Sunday 21:00 UTC.
  - Inferbase `/api/v1/inference/credits`: 0 of the documented 5,000 a month.
  - Readers can now record a metric, a reset and a confidence.
- **Google:** a daily-quota 429 now records the model's `QuotaFailure.quotaValue` limit as spent until midnight Pacific. Before, it was a bare "rate limited" row with no limit.
- **Cards:**
  - Learned and declared limits show as "learned limit" instead of being hidden.
  - A card's age now counts only readings that carried numbers.
- **No usage API for a free key:** Google, Mistral, NVIDIA, Groq, Agnes, Zhipu, UnoRouter and AMD.
- **Verified:**
  - The new readers wrote 5 current readings against a copy of live data with the real keys.
  - Server 388 files / 4,872 tests and client 82 files / 646 tests pass, as do both typechecks and the build.

## 2026-10-17 — Keys → Quota: provider allowance cards (deployed `main-20261017-232211`)

- Audit of the old Quota signals tab on live data: 165 raw readings, 89 for deleted keys, 143 older than a day, 19 past their reset. No hyperlinks; the "dead" entries were orphaned readings. The per-provider overview (`/api/quota/providers`) had no widget.
- `client/src/lib/quota-dashboard.ts` and `components/keys/quota-dashboard.tsx`: Atrium-style cards, one per enabled keyed provider, from the existing overview endpoint. Each card shows a bar per allowance, using Atrium's headroom thresholds (≤20 red, ≤50 amber). A spent row fades and gets a waiting-reset badge. The footer shows the next reset and countdown, plus the reading's age with a stale warning after 24h. Zero-allowance pools are counted as paid-only, and local counts are labelled.
- The tab is renamed **Quota**. Its order is now: cards, AMD capacity, bonus grants, paid credit windows, then **Details** (forecast and raw readings). Raw readings for deleted or disabled keys are hidden with a count, and the rest are marked stale. No data is deleted.
- Verified:
  - Client 82 files / 646 tests, typecheck, build.
  - Against a copy of live data: 14 cards (9 measured, 5 with no reported allowance), Mistral 4 paid-only hidden, Ollama 10 days stale, and raw readings 73 shown with 92 hidden. The copy was deleted afterwards.

## 2026-10-17 — Catalog updates: changes only, one entry per day, keyed providers by default (deployed; included in `main-20261017-232211`)

- `catalogue-sync-log.ts`: a document that changed nothing is no longer recorded, and rows already logged that changed nothing are left out of the list.
- Each local day (browser time zone) is now one entry. Its documents merge into a net change: added then removed cancels, a field keeps its first old and last new value, and an edit that ends where it began drops out. A day whose documents were capped is summed instead and flagged `netted: false`.
- New default filter: only providers with a key (`api_keys`, any state). It is counted as `hiddenUnkeyed`. Ignored and removed providers stay hidden by default as before.
- Detail is fetched by the day's `ids`. Days left with no visible change are dropped under every filter.
- `catalogue-syncs.tsx`: one row per day with "N updates merged", **Only providers with a key** (default on, with its hidden count), **Hide ignored** and **Model status**. The **Only updates that changed models** checkbox is removed. Strings are filled into 60 locales.
- Supplier identity: every document's `version` (date plus content hash, e.g. `2026.10.16.7388413c`) is unique per document, alongside `generatedAt`.
- Verified:
  - Server 388 files / 4,868 tests, client 81 files / 637 tests, both typechecks, build.
  - A read-only copy of live data showed 3 days with keyed providers by default (32 unkeyed and 14 removed-provider changes hidden). 2026-10-13 and 2026-10-15 each merged 2 documents.
  - Chrome against that copy showed the merged day expanding into per-provider groups. The copy was deleted afterwards.

## 2026-10-17 — Upstream v0.15.0 merged into the extension

- `--no-ff` merge of tag `v0.15.0` onto `f37e837a`. Covers upstream v0.14.0–v0.15.0: search engines and agent web search, Playground attachments, Auray provider, MCP `provider_list`/`quota_outlook`/`clear_cache`, opt-in transport-error key parking, retention sweeps, ContextWindowExceeded classification, bulk proxy controls and the key-row sweep on delete. Recovery tag: `imperium/pre-v0.15.0-recovery`.
- None of the new upstream features duplicates an extension, so nothing of ours was retired. Conflicts resolved per the overlay rules:
  - Kept our typed pool resolver (`provider-quota.ts`, invasive by design) and ported upstream's `auray::monthly-credit` pool into it.
  - Kept our per-endpoint provider rows and added upstream's Search section ahead of them. Search keys now also lose our "Models & account limits" action.
  - Took upstream's combobox group headings with our wrapping labels, and its reset-password sign-in plus our failure reset.
  - Kept upstream's Premium refresh list plus `catalogue-syncs`, and both sides' imports and tests. The roundtrip test still asserts the manifest-driven list.
  - `20261013_000001_search_engines` is registered after `catalogue_sync_log`, keeping the manifest in filename order.
  - Locales were three-way merged per key (no key changed on both sides), then filled and checked.
- Two upstream tests adapted to fork behaviour. The Auray validation mock now refuses a request without a key, which our auth-enforcement probe relies on. The search-key test checks this fork's row actions.
- Migration rehearsal on a copy of the 2026-10-17 00:33 backup: the first run applied exactly 3 migrations, each creating new empty tables, and every existing table kept identical row hashes. The second run changed nothing.

## 2026-10-17 — Approved deployment of bonus grants and paid credit windows

- Encryption key hash matched between the running container and compose config before deploying. `bash scripts/deploy.sh` built `jamesjdoan/freellmapi:main-20261017-003343`, took a quiescent backup `backups/freellmapi-data-20261017-003343.tar.gz` and recreated the container on `freellmapi_freellmapi-data`. Rollback tag: `jamesjdoan/freellmapi:provider-routing-before-20261017-003343`.
- `docker compose ps`: `Up (healthy)` on `127.0.0.1:3001->3001/tcp`. All 16 keys decrypt with the initialised key context. Tables `bonus_grants`, `bonus_usage`, `paid_credit_models` and `paid_credit_windows` exist.
- A temporary session returned 200 from `/api/quota/bonuses` (no grants), `/api/quota/paid-credit` (OpenRouter key 19, 1200¢ balance, no window, guard active) and `/api/quota/capacity`, then was revoked. No grant, window or paid model created. No commit or push.

## 2026-10-17 — Bonus normal-limit fix and paid credit windows verified locally

- `server/src/services/bonus.ts`: a provider-reported daily limit can now only lower a grant's normal allowance. A provider that folds the bonus into `limit_per_day` can no longer turn the pool into normal capacity and bypass the spending window.
- New `paid-credit-windows` extension: `server/src/services/paid-credit.ts`, migration `20261017_000001_paid_credit_windows.ts`, `/api/quota/paid-credit*` routes and `client/src/components/keys/paid-credit-panel.tsx`.
  - The operator selects paid OpenRouter models from its priced listing. They join auto chains as a last-resort tier behind every free route.
  - Spend needs a credit window opened per key with `ALLOW PAID SPEND`. Spend is the measured rise in OpenRouter's reported usage, and one paid attempt runs at a time with a re-read balance in between.
  - The paid-balance guard stays on throughout. `provider-usage-api.ts` gained `pollProviderUsageForKey`, and AGENTS.md records the one bounded exception.

## 2026-10-16 — xKiro allowance and temporary bonus grants verified locally

- `server/src/providers/index.ts`, `openai-compat.ts`: xKiro polls `/v1/usage` (1,000,000 tokens a day, 00:00 UTC reset). A probe with no stated reset no longer invents a 24-hour one.
- `server/src/services/bonus.ts`, migration `20261016_000001_bonus_grants.ts`, `server/src/routes/quota.ts`: provider-neutral bonus pools with operator spending windows. Normal daily allowance first; excess admitted only while a window is open and debited once to window and pool via the `bonus_usage` ledger. Concurrent requests hold headroom. Settlement charges the admitting window after replacement or expiry. Resets never refill the pool, and edits never reset usage. Credit and money grants are refused because there is no per-request cost metering.
- `server/src/services/router.ts`, `provider-quota.ts`, `quota-pressure.ts`, `lib/fallback-loop.ts`: a funded window bypasses only the exhausted daily allowance it extends. Other gates, cooldowns and the paid guard still apply. Restored the monthly-budget pre-check that a delegated patch had deleted.
- Restored two pieces of deployed WIP lost from the working tree: the `/api/quota/capacity` route and the Radeon pressure observer wiring in `server/src/index.ts`. Confirmed by diffing a fresh compile against the deployed image's `dist`.
- New `bonus-grants` extension, default on. Dashboard panel at Keys → Quota signals → Bonus grants. Strings were filled into all 60 locales.
- Verification: full server suite 376 files / 4,653 tests passed, client 74 files / 612 tests passed, i18n and production build passed. An isolated server on a disposable DB created a grant over HTTP, refused credits, and ran the real migration. Chrome showed the panel, opened a window via Edit, displayed the pool-overflow error and cancelled the window. No deploy, commit or push.

## 2026-10-15 — Approved capacity and recommendation deployment

- Deployed both features with `./scripts/deploy.sh && docker compose up -d && docker compose ps`. Image `jamesjdoan/freellmapi:main-20261015-070832` matched the running container. Quiescent full-volume backup: `backups/freellmapi-data-20261015-070832.tar.gz`; existing `freellmapi_freellmapi-data` volume retained. Compose reported `Up (healthy)` with `127.0.0.1:3001->3001/tcp`.
- All 15 credentials decrypted after initializing the verification process's encryption context. Immediate pre/post key/scopes digest `b71c49b00832d68fd0abb1fa454cfdc454356cc4c26d38ef826fbe742ceb33f8` and chain digest `36b288867ca5f2d890fcc6553c8f2a4d913e6545edb5b99a5041d14d7b8a1de7` matched after deployed UI inspection. Active profile stayed 3.
- Authenticated capacity endpoint returned 200 with one account pool, 11 inventory models and real fresh anonymous fleet readings. Actual Keys model bars and Quota signals meters displayed them; unreported models remained Unknown. Capacity-aware routing stayed OFF.
- Actual deployed Keys and Compare Models recommendation previews listed exact eligible routes and target chains. Preview/Cancel only; no production adoption performed. Browser errors were empty. Temporary verification session revoked and owned browser/profile removed. No commit or push.

## 2026-10-15 — Confirmed chain recommendation adoption verified locally

- `client/src/components/apply-chain-recommendations.tsx`, `chain-fit.tsx`, Keys provider models and Compare Models: shared Apply recommendations preview with selectable chains and exact physical routes. Current evidence is schema-validated, individual fit is re-evaluated, threshold drafts block adoption, and changed saved recommendations require review. Two-stage confirmation precedes writes. Each chain reports success/refusal without hiding partial failure.
- `server/src/routes/fallback.ts`: explicit `append: true` membership intent appends new/reactivated members behind the current enabled tail, leaves active members unmoved, rejects disappeared/disabled catalogue rows, and retains key-scope/reachability/capability guards. Normal manual restoration keeps its old rank. No whole-chain replacement or active-profile change.
- `server/src/__tests__/routes/fallback-membership.test.ts`: six consumer acceptance cases added. Five failed before implementation; all 14 membership tests passed after. Integrated server checks passed 99 tests plus typecheck. Final transaction gate reran all 14 successfully.
- Client production build/typecheck and 29 focused tests passed. Added 11 English keys and filled 649 values across the other 59 locales. Validation passed for 60 locales/1958 keys. Declared existing Zod validation dependency directly in client package/lock without installing another version.
- Actual isolated in-memory runtime and Chromium proved no-write preview/Cancel/first click, confirmed Keys reactivation at priority 5 instead of historic priority 1, exact-member Compare adoption, excluded incompatible/out-of-scope routes, refreshed membership chips and unchanged active profile/model/key flags. Changed saved minimums caused review without writes; unsaved drafts disabled adoption. A controlled refusal showed partial results while the successful chain append was independently read. Browser errors were empty.
- Final runtime HTTP exercise returned 200/changed 1 then 200/changed 0, with existing head/order/active profile preserved. Fixtures used synthetic keys, no inference and no operator data. Updated registry/operator guide/ADR and session notes. Owned runtime/browser/profile and throwaway script/consumed plan removed. No deployment, commit or push.

## 2026-10-15 — AMD background capacity bars and opt-in routing verified locally

- `server/src/providers/radeon.ts`: collector requests now have a 40-second whole-request deadline and a completion-spaced 20-second refresh bound. Added cached-only `getModelPressure()` so pages and routing never wait on AMD. Preserved immutable model samples, failure/staleness semantics and inference configuration.
- `server/src/services/radeon-pressure.ts`, `server/src/index.ts`: one startup-owned background observer, configured-key and presentation/routing gates, completion-spaced scheduling and stop protection during pending requests. Shutdown cancels future polling. `provider-capacity.ts` and its regression mocks use synchronous cached facts.
- `client/src/components/provider-capacity.tsx`: per-model accessible fleet-utilisation meters on existing AMD provider/model/quota surfaces. Published states remain authoritative, genuine zero remains 0%, stale bars are muted Last reported and unknown has no fabricated meter. Reused existing translated strings; no new locale keys.
- `server/src/services/router.ts`, `server/src/data/extension-registry.ts`: new `amd-capacity-routing` extension defaults OFF. When enabled, fresh full AMD routes are last-resort candidates within exact-match tiers, before soft preference/scoring. Final serving order and exploration retain the pressure bands. Explicit pins, eligibility gates and saved chain configuration are unchanged.
- Verification: 131 focused server tests and server typecheck passed. 36 client tests, production client build and 60-locale/1947-key validation passed. An isolated in-memory server read the real anonymous AMD feed in 24.126 seconds. Authenticated capacity HTTP returned in 39 ms with collection pending and 7 ms after success, with 11 fresh models.
- Real-source routing smoke chose full MiMo-V2.6-Flash with the feature OFF and non-full Gemma-4-31B-IT when ON. Explicit MiMo pinning and full-model last resort worked; saved chain rows were unchanged. Synthetic keys only, no inference calls and no operator data changes.
- Actual Chromium showed live meters on expanded AMD provider rows, model detail and Quota signals with one account pool. The opt-in switch persisted through reload and was restored OFF. Controlled UI responses proved zero, age-based stale and unknown states. Browser errors were empty. Owned browser/server/profile, throwaway smoke program and consumed build batons removed.
- Updated routing/provider/extension docs and the approved ADR. Corrected the earlier source-unavailable interpretation: the deployed five-second deadline was too short for the available 24–26-second feed. Integration repaired invalid delegated patches before runtime. No deployment, commit or push.

## 2026-10-14 — Approved capacity-indicator deployment

- Deployed `jamesjdoan/freellmapi:main-20261014-215829` with `./scripts/deploy.sh && docker compose up -d && docker compose ps`. Preserved `freellmapi_freellmapi-data` and backed it up to `backups/freellmapi-data-20261014-215829.tar.gz`. Recreated container reported `Up (healthy)` with published `127.0.0.1:3001->3001/tcp`; running-image match was verified by the deployment script.
- All 15 provider keys decrypt with zero failures. Key enablement/scope and chain digests match the immediate pre-deploy baseline; active profile remains 3. No routing configuration changed.
- Authenticated model listing returned 200 with 481 models. Real auto and AMD MiniCPM5-2B completions both returned 200. The AMD request updated real key #39 allocation to 99.989486 internal cents remaining of 100, preserving fractional consumption.
- Deployed authenticated capacity API returned one account pool and 11 models. Actual key, expanded provider-model, model-detail and quota UI showed 0.99989486 / 1 points remaining and 0.00010514 used. The key badge showed 99.9895%. Source/reset timestamps and Last reported RPM were visible. Browser errors were empty.
- Live fleet pressure still rendered Unknown because the provider feed did not supply a usable runtime observation. No current pressure value was substituted or invented. Published exact visual inspection steps in a session guide and recorded the deployed state in the handoff/ADR.
- No commit or push. Temporary dashboard verification session revoked and owned browser resources removed.

## 2026-10-14 — Approved AMD capacity indicator completed locally

- `server/src/providers/radeon.ts`: specialized AMD adapter preserves existing inference configuration and reads the credential-free fleet feed with one in-flight fetch, a 20-second refresh window, bounded timeout, validation and stale/unknown failure semantics.
- `server/src/services/provider-quota.ts`: preserve fractional normalized credits rather than rounding measured small usage back to an apparently untouched allocation. `server/src/services/provider-capacity.ts`, `server/src/routes/quota.ts` and `shared/types.ts`: authenticated read-only `/api/quota/capacity` snapshot, actual credential/pool references, scope/eligibility, independent allocation/RPM freshness, fleet pressure and existing cooldown expiry. Anonymous/deleted credentials do not create allowances.
- `client/src/components/provider-capacity.tsx`, `client/src/lib/provider-capacity.ts`, `App.tsx`, model/provider/key and quota components: one shared page observer/clock, all approved surfaces, exact usage-point detail, no paid-dollar label, no false 100%, no inferred refill, explicit Unknown/Last reported and cooldown expiry. Legacy AMD key/RPM-headroom summaries are replaced, while other providers and policy editing remain intact. English strings filled across all locales. Registry metadata and user/provider docs updated.
- Recovered the invalid delegated/nested edits locally, including the damaged model table. Preserved the existing Ignore modal action and independently exercised preview/Cancel without model changes. No broken capacity UI was deployed.
- Verification: 84 focused server tests and server typecheck passed. 36 client tests, production build and 60-locale/1947-key validation passed. A temporary in-memory server used current live AMD model/key metadata and bounded actual inference through the new adapter; headers reported 0.99990221 of 1 usage points remaining and 0.00009779 used. Actual key, model-detail, expanded provider-model and quota surfaces showed those precise values, one shared pool, stale RPM as Last reported, no duplicated legacy AMD row and no browser errors.
- Controlled UI snapshots separately proved full model pressure alongside nearly full allocation, cooldown display/expiry, stale values labelled Last reported, unknown values not zero and extension-off presentation gating. These controlled pressure states are not claimed as current live vendor measurements.
- The public vendor pressure endpoint did not return a first byte to host/container Node or curl during smoke despite successful connection/TLS. Runtime therefore correctly displayed Unknown pressure. Reader-cached public data was not substituted as live capacity, and there is no claim of a successful live pressure fetch.
- Capacity implementation is not deployed. The earlier Keys-only deployment remains live and healthy. No model enablement, saved scopes, routing order, provider preference, commit or push changed. Temporary plan/resume/smoke files and verification access/resources are removed after proof.

## 2026-10-14 — Approved Keys deployment and capacity design

- James approved the provider-model capacity design and, separately, deployment of the verified Keys controls. Marked `docs/adr/ARCH-20261014-provider-model-capacity-indicator.md` APPROVED and recorded `config/plan-current.md`.
- Deployed Keys controls as `jamesjdoan/freellmapi:main-20261014-192916` via `./scripts/deploy.sh && docker compose up -d && docker compose ps`, preserving `freellmapi_freellmapi-data` and taking `backups/freellmapi-data-20261014-192916.tar.gz`. Container reported `Up (healthy)` with `127.0.0.1:3001->3001/tcp`.
- Deployed Chromium check verified alphabetical provider cards, 15 → 12 on Hide Disabled Providers, and explicit Disabled view exposing the three off groups. No browser errors. All 15 stored keys decrypt; key enablement/scopes and chain digests match the immediate pre-deploy snapshot. Authenticated model listing returned 200 with 481 models; real `auto` completion returned 200, `qwen/qwen3.8-27b`, `OK`, 18 tokens, 1031 ms. Temporary session revoked.
- Capacity-indicator source changes began only after the Keys image had been built and recreated. Its implementation is separate from this deployed image and has no deployment approval yet. No commit or push.

## 2026-10-14 — Provider list controls, AMD tests and free-allocation research

- `client/src/components/keys/provider-list.tsx`: provider cards default to case-insensitive alphabetical display order, including custom endpoints. Added a browser-persistent Hide/Show Disabled Providers button. Eligibility uses the complete provider key group before search narrows keys. Explicit Disabled view clears hiding, and hiding from that view returns to All. No routing or key-enable writes.
- `client/src/components/keys/provider-list-controls.test.tsx`: five consumer regressions cover ordering, all-off versus unhealthy/mixed groups, reversal without writes, Disabled-tab precedence, search matching an off sibling and remount persistence. Together with existing balance tests, 11 tests passed.
- Updated English and all other locale keys. Integration repaired the delegated malformed JSX and restored the English access-denied verdict key it had removed. Final i18n validation passed for 60 locales and 1917 keys. Client production build passed.
- Actual local Chromium smoke against the existing backend verified 15 alphabetically ordered provider cards, hiding the three wholly disabled groups, 12 remaining groups, persistence through reload, explicit Disabled view, restoration of all providers and unchanged key-enabled state. Browser errors were empty. Updated the provider controls documentation. This UI is not yet deployed.
- Tested all 11 public AMD chat models once in series: nine usable completions, DeepSeek-V4.1-Flash 429, GLM-5.3-Flash canceled after the 60-second client budget. MiMo-V2.6-Flash returned `pong`, a valid completion rather than an exact `OK` reply. Model enabled flags, Radeon fallback entries and all selected chain memberships/orders matched the pre-test digest. Temporary probe session removed.
- `docs/adr/ARCH-20261014-provider-model-capacity-indicator.md`: recorded the proposed shared free-allocation, per-model fleet-pressure and existing cooldown indicator. Found integer-cent normalization hiding small measured allocation usage. Proposal is PENDING, not implemented or approved. Do not arm a build plan until approval.
- ElectronHub read-only research established 10 no-ad Neutrinos/day, separate Free $0.25/week credit, 5 RPM and charges for failed/canceled free-model requests. The live public catalogue and provider UI price-label logic show 1-, 2- and 3-Neutrino chat routes. The existing key's account metadata confirms Free subscription, no ads, inactive Pass and disabled permanent credits. No ElectronHub inference, ad, purchase, settings change, model import or chain activation was performed.
- No deployment, commit or push. Full test and research tables are session reports; durable decisions and verified state are recorded here and in the handoff.

## 2026-10-14 — AMD Token Factory inventory under the existing key

- The existing Radeon registration already points at AMD China's shared API. Key #39 returned 200 from `/models` with 12 public models, while the local catalogue held two disabled entries. No duplicate Radeon credential exists.
- Registered the nine missing chat models through the running `POST /api/models` API as operator-owned native `radeon` entries: `DeepSeek-V4.1-Flash`, `DeepSeek-V4-Flash-Vision-Exp`, `Gemma-4-31B-IT`, `GLM-5.3-Flash`, `MiMo-V2.6-Flash`, `MiniCPM5-2B`, `MiniCPM-V-4.7-1B`, `MiniCPM-V-4.7-35B-A3B`, and `Qwen3.8-27B`. Context, vision and tool flags came from AMD's response. Automatic fallback is off for new entries, and existing parked models remain off.
- Excluded `MinerU2.5-Pro` because its output is OCR, not chat, and the three dedicated deployments because they require separate instance credits. AMD's public detail explicitly calls shared-model prices relative usage points, not charges.
- Created the consistent pre-import backup `/app/server/data/freeapi-before-amd-model-import-20261014060153987.db` in the persistent volume.
- Verification: the original roster comparison changed from nine missing chat models to zero. Authenticated `/api/models` returned all 11 Radeon chat models, and the actual Keys provider table showed 11 models, nine enabled and two parked. Chain digest and active profile 3 are unchanged. A real FreeLLM `radeon:MiniCPM5-2B` call returned 200 with a response containing `OK`, 46 tokens, in 2577 ms. Temporary sessions revoked and verification browsers closed.
- Updated quota documentation and appended the live configuration result to `config/handoff.md`. No application-code change, image rebuild, deployment, commit or push.

## 2026-10-14 — Approved Chat capacity deployment

- Deployed `jamesjdoan/freellmapi:main-20261014-164650` via `./scripts/deploy.sh`, preserving `freellmapi_freellmapi-data` and taking `backups/freellmapi-data-20261014-164650.tar.gz`.
- Finished with `docker compose up -d && docker compose ps`: recreated container `Up (healthy)`, published `127.0.0.1:3001->3001/tcp`. Deployment script verified the running image matches the build.
- Post-deploy checks: all 15 keys decrypt, zero failures, active profile 3 and unchanged chain digest. Authenticated capacity API returned 112,000,000 estimated tokens and 3,656,546,308 recorded chat tokens. The actual dashboard showed 112.0M capacity, 3.7B usage and 14 unpublished models, with no overflow or browser errors.
- Authenticated `/v1/models`: 200, 478 models. Real `auto` chat: 200, `qwen/qwen3.8-27b`, `OK`, 18 tokens, 54 ms. Temporary dashboard verification session revoked.
- Appended deployed state to `config/handoff.md`. No commit or push.

## 2026-10-14 — Honest Chat monthly capacity

- `server/src/routes/fallback.ts`: estimate capacity from enabled chain members with usable, in-scope, endpoint-matching keys. Count shared pools once per credential. Report all month-to-date chat usage separately, including disabled/removed routes and unpublished endpoints.
- `client/src/components/token-usage-bar.tsx`, `client/src/lib/budget-legend.ts`, `routing.ts`, `pages/FallbackPage.tsx` and `client/dev/mockApi.ts`: replace the fabricated remaining balance with estimated capacity and separate recorded usage. Shared allowances render once and unpublished capacity stays visible even when the estimate is zero.
- Updated all 60 locale contracts and quota documentation. Removed the obsolete free-tier-to-Chat legend wiring assertion and clarified that free-tier inventory includes chain-disabled routes.
- Verification: 34 targeted server tests and 7 legend tests passed. Server typecheck, client production build and i18n validation passed. An isolated in-memory server exercised the actual endpoint with read-only live model/key settings: previous estimate 231M, corrected capacity 112M, recorded chat usage 3,655,963,028 tokens. Isolated Chromium showed 112.0M capacity, 3.7B recorded chat tokens and 14 unpublished models, with four capacity segments totalling 100%, no horizontal overflow and no browser errors.
- No commit, push, deployment or live data changes.

## 2026-10-14 — Approved deployment of final confirmation and inventory

- Deployed `jamesjdoan/freellmapi:main-20261014-141957` via `./scripts/deploy.sh`, preserving the existing data volume and taking `backups/freellmapi-data-20261014-141957.tar.gz`.
- `docker compose up -d && docker compose ps` confirmed `Up (healthy)` with published `127.0.0.1:3001->3001/tcp`.
- Verified the deployed Models → Chat confirmation modal, unchanged routing through preview/Cancel, Escape dismissal, and both actual Extensions entries/links in isolated Chromium. Session revoked and profile removed.
- Appended the deployed state to `config/handoff.md`. No source edits, commits or pushes in this deployment follow-up.

## 2026-10-14 — Catalogue ignore on chat rows, confirmation and extension inventory

- `server/src/services/catalogue-ignores.ts` and `server/src/routes/models.ts`: preview and apply accept target lists so all provider routes of a logical chat model are ignored in one transaction. Single-target DELETE restores remain unchanged.
- `client/src/components/catalogue-ignore.tsx`, `catalogue-syncs.tsx` and `model-table.tsx`: reuse Ignore on Models → Chat rows. The final modal preview requires explicit Ignore and switch off, supports Cancel/Escape, and invalidates fallback-chain queries after changes.
- `server/src/__tests__/services/catalogue-ignores.test.ts`, `server/src/__tests__/routes/catalogue-ignores.test.ts`, `client/src/components/catalogue-ignore.test.tsx` and `client/src/components/model-table.rank.test.tsx`: migrated contracts and covered multi-route ignore and confirmation behavior.
- `server/src/data/extension-registry.ts` and `docs/IMPERIUM_EXTENSION.md`: catalogue updates, sync outcomes, history, ignores, chat confirmation, external leads, agent access, status ownership and remembered Hide ignored are explicitly tracked under the existing extension ids.
- `config/handoff.md`, `config/changelog.md` and `docs/GOTCHAS.md`: saved verified state, deploy/commit/push boundary, and the fallback-query and inline-table-confirmation traps.
- Latest checks: 586 client tests, 12 ignore server tests, 5 registry tests and 3 inventory UI tests passed. Client/server builds and i18n passed. Isolated-browser smoke verified modal cancellation and actual Extensions rendering. Final modal and inventory changes are local only. Earlier catalogue/discovery/A12 changes are committed and pushed through `18fe337f`.

## 2026-10-08 — Space Bunny via OpenCode Zen; AIHubMix free-only; Mistral re-enabled

- Live-data changes only. The detail and the IDs are in `config/handoff.md` (Session 2026-10-08).
- `space-bunny-free` is a custom endpoint (`https://opencode.ai/zen/v1`), unlimited, and back in
  its 7 former chain slots. The other Zen ids are tombstoned.
- AIHubMix's paid models are deleted, and the free-only sync filter is enabled in `.env`.
- 12 working Mistral models are enabled. Coding, Workhorse and Extra-Tier gained Mistral tails.

## 2026-10-07 — Keys: remove unwanted providers from the add checklist

- The "N of M providers configured" chips (the add-buttons for providers with no key) now each
  carry an **×**. It opens the existing Remove provider dialog, which requires a reason; the
  "also delete keys" box is hidden because there are none. The removal lands in the same
  `provider_removal` log, and **Restore** there brings the chip back.
- `GET /api/keys/providers` drops actively removed platforms from both the list and the summary
  totals, and the Add key provider picker hides them too. Before this, removal only reached
  configured providers, so a provider never used could not be vetted out of the add surfaces.

## 2026-10-04 — Analytics: real windows, longer durations, page-wide filters

- **The 30d and 90d views were identical, and it was not a render bug.** Measured on a copy of
  the live DB: `request_hourly` held 415 rows in a 30d window and 420 in a 90d one, spread over
  the same 31 daily buckets. Two causes. `/timeline` chose its interval with
  `range === '24h' ? 'hour' : 'day'`, so every window past a day drew one point per day — the
  chart was redrawing identical data and reading as frozen. And `HOURLY_RETENTION_DAYS` was 30
  while the toggle already offered 90d, so the 90d view was reading a 30-day window and
  labelling it 90 days.
- `server/src/routes/analytics.ts`: one `resolveWindow()` produces the half-open `[since, until)`
  every endpoint reads, from a `range` preset **or** a `from`/`to` date pair. Presets are now
  `24h 7d 30d 90d 180d 365d`. The timeline picks its bucket from the window's own span
  (`hour` ≤3d, `day` ≤150d, else `month`), so 180d and 365d read as a legible monthly line
  instead of 180 unreadable ticks. A custom window wider than five years is clamped to its
  RECENT end, so a fat-fingered `1900→2100` renders recent history rather than nothing.
- `pageFilters()` is now the one place a status, provider or model filter becomes SQL, and every
  endpoint composes it. The status and provider selectors used to live only on `/requests`, in
  the recent-calls **table header** — choosing "errors" moved that one table and left the stat
  cards, the timeline and both breakdowns describing all traffic. They now sit in a bar above
  every panel; the table's own controls are gone, not duplicated.
- `services/request-retention.ts`: `HOURLY_RETENTION_DAYS` 30 → 365, so the aggregate is
  retained as deep as the widest preset. ~8.8k rows and well under a megabyte.
- `/summary` now reports `windowSince`, `windowUntil`, `rawWindowTruncated` and
  `rawWindowOldest`. When a window reaches past the oldest request on record the page says so:
  the aggregate-backed totals cover everything held, while latency, TTFT, savings and the two
  breakdowns are raw-row readers and cover only that span.
- **F5, a real bug found by the probe:** a bucket in `request_hourly` is keyed by its FIRST
  second, so the aggregate's upper bound must NOT be ceiled to the next hour — doing so pulled
  in a whole bucket the window excludes, and a custom window ending at midnight counted the
  following hour. `since` IS floored, because a rolling 24h window opens mid-hour. Measured on
  the live copy: a one-day custom window read 6,117 requests, 248 of them from the next day.
- Verification: `analytics.test.ts` 38 → 49 tests, all passing. The ones that matter are
  `gives a longer preset a strictly wider window` (counts AND monotonic bounds — F2 violated
  both silently) and `buckets the timeline by the window span` (asserts the 30d and 90d label
  sets differ — F1 verbatim). A throwaway probe against a COPY of the live DB exercised six
  presets, four custom windows, all three filters across seven panels (all agreeing on 35,277)
  and five malformed inputs (four 400s). Not committed.
- **Two defects the server suite could not have caught, found in the browser.**
  (1) recharts INFERS the X-axis type, and from two points it infers a numeric
  one — so a 180d/365d window over a young install rendered an X axis with no
  dates on it (`2 empty tick groups`; "Sept 26"/"Oct 26" were being drawn as
  Y-axis ticks). Every timeline axis now states `type="category"`, which invents
  no data and gives the two honest points their labels back. (2)
  `apply-translations.mjs --fill-english` never updates a CHANGED key, so the
  reworded horizon notice had to be overwritten across 59 locales by hand —
  already documented in `docs/GOTCHAS.md`, and it bit again exactly as written.
- Verified against the deployed container: each preset moves the Requests card
  (3,933 / 40,543 / 70,804 / 71,578 …), a custom `2026-09-20 → 2026-09-26` window
  reads 12,789, and with `provider=nvidia&status=error` every one of the nine
  analytics endpoints requests `range=30d&status=error&provider=nvidia`.
- ADR `docs/adr/ARCH-20261004-analytics-windows-and-page-filters.md`.

## 2026-10-04 — Session wrap

- `docs/GOTCHAS.md`: new 2026-10-04 section — the MBP's 212 failed hourly reports and their
  one wrong Tailscale hostname, `code-sync.sh` pushing at the upstream project, a Groq
  OTPM 429 that is the size fix working, and the `reset --hard` that would have destroyed
  an unpushed handoff.
- `config/handoff.md`: session block for 2026-10-01 → 2026-10-04, and the stale "everything
  after it is local only" line in the 2026-10-01 block struck and marked superseded. No
  source file changed this wrap; the one code commit (`48479069`, the analytics boundary)
  is recorded in the handoff block above.

## 2026-10-01 — Session wrap

- `docs/GOTCHAS.md`: new 2026-10-01 section (merge-tree pre-flight trap, clean merge that does
  not compile, upstream tests encoding extension-changed behaviour, the Vite `PORT` proxy loop,
  two-stage `ConfirmButton`), and a dated addition to the stale-bundle entry.
- `config/handoff.md`: session block for 2026-09-29 → 2026-10-01. Every code change of the
  session is logged in the entries below; this list is from the commits, so it is complete.

## 2026-10-01 — Catalogue changes is a worklist you can empty

- Models → Catalogue changes is now an unread worklist. One **Mark N read** button clears
  every change on the panel and collapses it. Nothing is deleted: the arrival, the tombstone
  and the event log all survive, so **Show all** still renders what is really there.
- **All read** means collapsed. Expanding then shows the 10 most recent changes of either
  kind as one list, with **Show all** beside it.
- The mark is permanent and lives in the database, so it agrees across browsers and machines.
  Migration `20261001_000001_catalogue_ack`, one table of `(platform, model_id)`, no
  timestamps. Arrivals only: a departure is marked on its tombstone, and relisting deletes
  that, so a second retirement of the same model reads as new again.
- `POST /api/models/changes/acknowledge-bulk`. `getCatalogueChanges` returns every row in
  its window with an `acknowledged` flag rather than filtering, because the Keys page's
  provider chips read the same payload and must keep counting acknowledged rows. The
  filtering is `unreadSelection()` in the client, tested against that invariant.
- ADR `docs/adr/ARCH-20260930-catalogue-panel-unread-worklist.md`.

## 2026-10-01 — Upstream v0.13.0–v0.13.3 merged into the extension

- Four upstream releases taken in one `--no-ff` merge of the `v0.13.3` tag (24 commits, 149
  files). No migrations in any of the four. Upstream's own changes: output-limit learning from
  every provider's wording (#1367), Keys search matching a custom endpoint's URL (#1368),
  key-optional providers (Kilo, OVH, AI Horde) accepting a real key (#1331), built-in provider
  model discovery (#1348), per-key monthly request/token caps (#1158), Gemini daily quotas
  benched to Pacific midnight (#1343), a Requesty daily cap.
- 65 conflicted files: 60 locales resolved by a per-key three-way merge (neither side changed the
  same key; `keys.noKeyNeededPlaceholder` and `keys.keylessHint` dropped because upstream deleted
  them and nothing references them), and 5 source files. `keys.ts` takes upstream's removal of the
  keyless-credential rejection, which #1331 replaced. `provider-list.tsx` adopts upstream's
  `discoverTarget` rename, including the extension's own account-row caller.
- Two semantic collisions a clean text merge did not show: `anthropic.ts` had an extension caller
  of `estimateTokens`, which upstream deleted — it now reads `ctx.estimatedInputTokens`, the same
  estimate every other surface uses. Two upstream tests assumed upstream behaviour the extension
  changes on purpose and were updated to their intent: `keyless-bearer-1331.test.ts` captures the
  credentialed health request rather than the extension's unauthenticated control probe after it,
  and `fallback-loop.test.ts` expects a Gemini per-minute 429 to honour its stated 17s (e18d2c92)
  rather than the 90s default.
- Known dead code, left for a follow-up: the extension's `isUnsatisfiableRequestSizeError` branch
  in `cooldownDecisionForError` is now unreachable in production, because upstream's earlier
  `isContextTooLargeError` return in `recordRetryableFailure` matches every message it does. The
  outcome is identical (no bench).
- `AGENTS.md` and `docs/en/deployment/03-imperium-extension-branch.md` now say releases are taken
  by merge, not rebase, and record the pre-flight trap: `git merge-tree <old base> HEAD` is
  trivially clean; measure against the new tag.

## 2026-09-28 — Keys: remove a provider, with a reason and a log

- Keys → a provider's ⋯ menu → **Remove provider**. Requires a reason, takes an optional note and
  whether to delete the key too. The provider's models are removed and each tombstoned with the
  reason, so a catalogue refresh cannot bring them back; chain memberships and the auto chain are
  cleared. The credential is kept unless the box is ticked, so restoring needs no re-entry.
- Keys shows a **Removed providers** section with each provider's reason, when, and **Restore**.
  Restoring clears it from the list and the log; the models come back on the next catalogue sync.
  Deleting a provider's last key by hand records the same entry.
- `GET /api/keys/provider-removals`, `POST /api/keys/provider-removals/:platform`,
  `POST /api/keys/provider-removals/:platform/restore`. Migration `20260928_000001`; test
  `provider-removals.test.ts` (tombstones, chain rows gone, key kept, blank reason refused, restore).

## 2026-09-28 — Catalogue changes fold like the catalogue log

- Models → Catalogue changes: Arrived and Retired each show the 10 newest, then "Show N more
  from this month", then Full history folded Year › Month › Week › Day, with a count on every
  fold (and how many already route / left a chain). Same `TimeTreeLog` the Catalogue log uses,
  so both panels read the same way. Acknowledge still works on each retired row.

## 2026-09-26 — Keys: a Parked section and model notes

- Each provider's model table lists the working models first, then a **Parked · N** divider and the
  models that cannot route (switched off, key off, outside the key's scope). "Hide can't route"
  collapses the section to its divider, with a Show link.
- Any model can carry an operator note and a recheck-by date: `+ note` on the row, Enter or Save to
  keep it, Esc to cancel, clear the text to remove it. A date on or before today reads "recheck
  due". Stored in `model_note` keyed by platform and model id (migration `20260926_000001`), so it
  survives the catalogue re-inserting the row; written through `PATCH /api/models/:id` `note` /
  `recheckAt`, returned on `/api/analysis/compare` rows. Nothing routes on it.

## 2026-09-26 — Chain minimums panel: a Members view

- The docked Chain minimums panel (Compare, Keys) now swaps between **Minimums** and **Members**.
  Members lists every chain's enabled members, Fast-Lane included, in the order the router tries
  them: an effective unlimited model first, then chain priority. Each row shows provider, AA General
  score, fit against the chain's minimums (✓ / below min / estimate / unscored / no tools / no
  vision) and, greyed, why it cannot route. The chosen view is remembered; the minimums draft
  survives the swap. Read-only, from `GET /api/analysis/compare`.

## 2026-09-26 — The key pencil opens the edit dialog again

- Keys: the pencil (and the label) on a provider's key row flashed the Edit key dialog and closed
  it. The merged provider row kept its own inline label input on the same `editingKeyId` state as
  upstream's `EditKeyDialog` (#1163); the input grabbed focus, lost it to the dialog and saved-and-
  closed both on blur. The inline input is gone: every key's pencil and label open the dialog,
  which edits the label, base URL and key.

## 2026-09-26 — Rename a model from its Keys row; Add stays in view

- Keys → expand a provider → click a model's name to rename it (Enter saves, Esc cancels; blank or
  unchanged is a cancel). Uses `PATCH /api/models/:id` `displayName`, so a catalogue model keeps the
  name as an override across syncs. The model ID is unchanged. Meant for relays whose `/v1/models`
  only gives raw ids.
- Fetch models dialog: the Cancel / Add N models bar is sticky, so it no longer sits below a long list.

## 2026-09-25 — Unlimited models (Space Bunny)

- Keys → expand a provider → **∞ set unlimited** on a model row. An unlimited model skips every
  local usage gate (per-model RPM/RPD/TPM/TPD, provider account caps, quota domains, monthly key
  caps), is counted toward none (`recordRequest`/`recordTokens` skip it; each `requests` row records
  `unlimited` at log time, and the monthly-usage trigger and pool inference read that), is tried
  first in the chains it is in, and passes the paid-balance guard. Cooldowns, health, capability
  and per-key concurrency still apply.
- On OpenRouter/AnyAPI/UnoRouter it is only in force while the provider's public listing prices it
  at $0 (`model_price_check`, checked on flag, at boot and every 6h). Charging, delisted or never
  checked = off, and every limit and the guard apply again; a failed check keeps the last price.
  The chip reads `∞ unlimited` (in force) or `∞ unlimited · waiting for a $0 price`.
- Extension `unlimited-models` (off = flags kept, treated as normal). Migration `20260925_000003`
  (`models.unlimited` nullable, `model_price_check`, `requests.unlimited`, trigger).
  Test `unlimited-models.test.ts`.

## 2026-09-25 — Rename an OpenAI-compatible account from its row

- An account row's ⋯ menu gains **Rename**, opening Edit key on its label (the row's title).
  Clicking the label beside the key still edits it inline.

## 2026-09-25 — One row per OpenAI-compatible account; fix a base URL in place; pull all free models

- Keys: every custom (OpenAI-compatible) endpoint is its own provider row, named by its label (or
  host), with its own switch (that one key) and a model table narrowed to that endpoint
  (`endpointScope` on `/api/analysis/compare` rows). Platform-wide chips (diagnosis, churn, new
  arrivals) stay off account rows, where they would describe every custom endpoint at once.
- Click an account's base URL to correct it (`POST /api/keys/:id/base-url`): normalised, re-checked
  by the URL guard, refused if another endpoint already uses it, and its model rows, quota policies,
  capability probes and tombstones move with it in one transaction. AIHubMix had been saved as
  `https://api.inferera.com`, whose `/models` is the website's HTML; `/v1` lists 416 models.
- Discovery dialog: **Select all free (N)** ticks every id the endpoint marks free (`-free`/`:free`);
  AIHubMix publishes no pricing, so the id is the only marker (44 of 416).

## 2026-09-25 — Monthly credit allowance: a 402 waits for the reset

- Keys → key row → Models & account limits → **Monthly credit allowance**: amount (USD), reset day
  (1 = calendar month, else a billing-cycle anchor) and timezone. Stored in the quota ledger as a
  `provider_account` `credits` policy with the new `quota_policy.unit = 'usd_cents'` (migration
  `20260925_000002`), so $10 is `1000` and can no longer be read as ten credits.
- With one declared, a 402 benches the account's key until the next reset (`creditAllowanceResetAt`,
  uncapped - it is the operator's stated reset, not a heuristic) instead of 24h and a re-trip each
  day. Credit benches are never probed early. Regression test
  `fallback-loop-credit-allowance.test.ts`. Mistral: $10/month, reset 1 Oct.
- FreeLLM still cannot see Mistral's remaining balance (no headers, no usage API), so the allowance
  records the reset, not a live counter.

## 2026-09-25 — Chain minimums: set AA floors per chain, see where every model fits

- **Chain minimums** side panel (Compare or Keys → Chain minimums): minimum AA General, Coding and
  Agentic per chain with ±1 steppers (Shift ±5), off per metric, "accept estimated" per chain, and
  live counts - models that qualify, current members that pass, the nearest model either side of
  the line. Docked, not modal, so the page underneath re-grades as a stepper moves. Starting values
  are the audit's draft (Apex 45, Frontier 35, Workhorse/Default 25, Coding 45 + Agentic 30,
  Vision 25, Extra-Tier 20), unsaved until the first Save. Fast-Lane is listed as reserved.
- Compare and Keys rows show `fits: …` and, for current members that fall short,
  `in <chain> · General 22.0 < 25` / `no Agentic score` / `no tool calling`. Score cells turn green
  or amber against the chain picked in the panel. **Recommendation only**: no chain or routing
  change. Unmeasured is unknown, never a fail.
- Every save is a numbered revision (`chain_minimum_revision`, compare-and-set on save), and every
  AA sync is now also appended to `aa_measurement` (backfilled from the current v4.3 snapshot), so a
  past recommendation can be reconstructed. Migration `20260925_000001`.
- Keys: **Expand all / Collapse all** opens every provider's model table at once (remembered per
  browser).
- Extension `chain-minimums`. `server/src/services/chain-minimums.ts`, `routes/chain-minimums.ts`,
  `client/src/lib/chain-minimums.ts`, `components/chain-minimums-panel.tsx`, `components/chain-fit.tsx`.

## 2026-09-25 — Chain table sorts the view; key dialog edits limits only

- Keys panel: a switched-off row now says why - `held by a saved override since <date>`, `marked
  unavailable upstream` (applied catalogue ships it disabled) or `switched off here` - and an
  enabled row the provider has benched says `paused · out of credit|not on this plan|rate-limited|
  cooling down · back in <time>`. `offReason`/`pause` on `/api/analysis/compare` rows.
- Fix: `PATCH /api/models/:id` with `enabled` now drops a stored `enabled` override. Overrides
  re-apply after every sync to user rows too, so a script-written `{"enabled":0}` switched b.ai's
  hy3/mimo-v2.5 back off after every re-enable since 2026-09-16. Regression test in
  `models-management.test.ts`. b.ai itself is out of credit (`balance=0`).
- Keys: catalogue arrivals from the last 14 days that have not been seen get an amber `N new ×` tag
  on the key row and an amber row with a `new` badge in the expanded provider. `Hide can't route`
  turns amber with `· N new hidden` when it is what hides one. `×` or `Mark N new seen` records
  them per browser (`imperium.keys.seenArrivals`); an arrival re-flags only if it leaves and
  returns. Gated by `provider-churn`. `client/src/lib/seen-arrivals.ts`,
  `client/src/components/keys/provider-churn.tsx`, `provider-models-panel.tsx`, `provider-list.tsx`.
- Fallback chain table: `#`, Model, Reliability, Speed, Intelligence and Score headers sort the
  view (asc, desc, back to chain order), remembered per browser under `fallback.chainSort`. View
  only: routing order and the `#` numbers are unchanged, and drag-to-reorder pauses while a sort is
  on. New key `models.sortViewOnly`. `client/src/components/model-table.tsx`, `client/src/pages/FallbackPage.tsx`.
- Keys → Models & account limits no longer edits scope for catalogue providers. Checkboxes,
  Enable/Disable shown, Hide disabled and Clear scope are gone; the scope shows read-only ("not
  served by this key") and Save sends no `modelScope`, so it cannot change it. Scope is set on the
  expanded provider's per-model switch. Custom endpoints keep their id chip list. Removed because
  Disable shown + hide made 9 unsaved models look deleted. `client/src/components/keys/model-scope-dialog.tsx`,
  registry `provider-model-access`, `docs/IMPERIUM_EXTENSION.md`, keys `keys.modelLimitsTitle`,
  `keys.scopeEditedOnPanel`, `keys.scopeNotServed`.

## 2026-09-25 — Compare chain apply no longer 409s on merged rows; picker keeps the selection visible

- Adding a merged Compare row to a chain sent every provider's copy, and `POST /api/fallback/membership`
  refuses the whole batch if one copy has no usable key. It now sends only reachable copies
  (enabled, key scope `in`/`unscoped`); with none, it says so (`compare.chainNoRoutable`). Removal
  still sends all. `client/src/pages/CompareModelsPage.tsx`.
- `ModelCombobox`: when the search filters out the selected option, a pinned row shows it
  (`models.comboboxSelected`). `client/src/components/model-combobox.tsx`.
- Incident: an agent reset the dashboard password and replaced the live DB file while the server
  held it open. Recovered from the open file descriptors; copies in `backups/incident-20260925/`.

## 2026-09-24 — Offloaded inference card collapsed by default

- The card collapses by default and remembers the choice per browser. Its collapsed header shows
  the FreeLLM proxy, free CLI fleet and total values. `client/src/components/offloaded-inference.tsx`,
  new key `analytics.offload.fleet` in `client/src/i18n/locales/*.json`.

## 2026-09-23 — Offloaded-inference card on Analytics; CLI-fleet usage per UTC day, per device

- Migration `20260923_000001_clifree_fleet_usage_per_day` (manifest `defaults.ts:209`): usage keyed
  `(machine, spec, day)`. The lifetime table is renamed `clifree_fleet_usage_lifetime_archive`, not
  dropped (0 rows in prod when checked). Deliveries with undated usage keep their roster and set the
  usage aside (`usageIgnored`) instead of filing a lifetime total under one day.
- `GET /api/clifree-fleet?range=` windows by the Analytics ranges. Per-machine `value` gains `device`
  and `reportedAtMs`; new per-route `usage` carries class, AA score, benchmark and 4-place value.
  `fleetDevice()` maps hostnames onto the same labels `deviceSql` gives the proxy.
- `client/src/components/offloaded-inference.tsx` on the Analytics page: proxy + each machine + total,
  per-route table, stale flag at 24h, observation-only line. Follows the range and device tabs.
- Verified: `clifree-fleet.test.ts` 20/20 (15 kept, 5 new), `src/__tests__/db` + analytics routes
  142 pass / 4 skipped, server and client `tsc` clean, `check:i18n` pass. Rendered on :3002 against a
  backup of the live DB with the Studio's real snapshot and a SYNTHETIC MBP delivery: All
  $248.95 = proxy $247.22 + MBP $0.08 + Studio $1.65; device tabs split correctly. **Not deployed.**
- Two `react-refresh`/`purity` lint errors in `clifree-fleet.tsx` predate this change (same at HEAD).

## 2026-09-23 — quota tab gating, readable model names, probed free routes, per-task price

- Clifree fleet usage value and the Quota page folded into Keys and Logs; the Quota signals tab
  is gated on `quota-capacity-dashboard`. `client/src/pages/KeysPage.tsx`,
  `server/src/data/extension-registry.ts`, plus the previously uncommitted clifree/quota files
  (`30ff896e`).
- Model pickers size to the longest name and wrap. `client/src/components/model-combobox.tsx`
  (`be79636d`).
- Benchmark names split into base and a subdued variant. `client/src/lib/model-name.ts` and
  `client/src/lib/model-name.test.ts` (new), `client/src/components/model-name.tsx` (new),
  `client/src/pages/CompareModelsPage.tsx`, `client/src/components/clifree-fleet.tsx`,
  `client/src/components/keys/provider-models-panel.tsx`,
  `client/src/components/model-combobox.tsx` (`renderLabel`)
  (`c4689a21`, `81c27073`, `c2e1ffe4`, `5b8b9e7f`, `259067de`, `e898e6b1`).
- Curated chains: NVIDIA `gpt-oss-20b` removed, `diffusiongemma-26b-a4b-it` added at Vision 17,
  and ten unchained routes documented. `server/src/data/routing-curation.ts` (`6c0e6829`).
  Runtime state also changed: NVIDIA key 18 scope 15 → 13, and live chain rows via
  `/api/fallback/membership` and `/position`.
- Price chart ranks by AA cost per task with a per-1M-token switch; 4 new strings filled into
  every locale. `client/src/pages/CompareModelsPage.tsx`, `client/src/i18n/locales/*.json`
  (`8f9e4e26`).
- Session-wrap docs: `docs/GOTCHAS.md` (2026-09-23 section), `config/handoff.md`,
  `config/changelog.md`. Recall of a long session may be incomplete.

## 2026-09-22 — free CLI fleet telemetry, shared combobox fixes, honest scopes

- Added Cline to the free-CLI delegation path and built fleet telemetry for both agents.
  `server/src/db/migrations/20260922_000001_clifree_fleet_snapshot.ts` and
  `20260922_000002_clifree_fleet_benchmark_slug.ts` (new, both registered in
  `server/src/db/migrate/defaults.ts`), `server/src/services/clifree-fleet.ts` (new),
  `server/src/routes/clifree-fleet.ts` (new, mounted in `server/src/app.ts`),
  `server/src/data/extension-registry.ts` (new `clifree-fleet-telemetry` entry, `tooling`),
  `server/src/services/analysis.ts` (`lookupAa` exported).
- Free CLI fleet panel with nine columns mirroring the comparison table, benchmark-merged
  capabilities, editable mapping and OC/CL provider marks.
  `client/src/components/clifree-fleet.tsx` (new),
  `client/src/pages/CompareModelsPage.tsx`, `client/src/lib/vendor-tint.ts` (new).
- Fixed two defects in shared components affecting every page: `PopoverContent` never
  forwarded `side`, and `ModelCombobox`'s `autoFocus` scrolled the document to the top when
  the popup was portalled. `client/src/components/ui/popover.tsx`,
  `client/src/components/model-combobox.tsx`.
- Compare scope pills now nest honestly — `Enabled` means enabled AND keyed, tested on the
  same member, and the pills are ordered narrowest to widest.
  `client/src/pages/CompareModelsPage.tsx`.
- Restored `compare.chainApply`, dropped from `en.json` by a code-sync while present in all
  59 locales, and resynced two changed scope hints across the locales.
  `client/src/i18n/locales/*.json`.
- Migrations can declare `dataOnly`; the roundtrip suite no longer fails a data migration
  whose `down()` is correctly a no-op on an empty database.
  `server/src/db/migrate/defaults.ts`,
  `server/src/db/migrations/20260920_000001_rename_access_denied.ts`,
  `server/src/__tests__/db/migrate/roundtrip.test.ts`.
- ADR: `docs/adr/ARCH-20260922-clifree-fleet-telemetry.md` (APPROVED).

## 2026-09-21 — reference-only platforms, analytics compare, build fix

- Marked OpenCode as a reference-only platform: catalogued and ranked for comparison, never
  routable. `server/src/data/reference-only-platforms.ts` (new), mirrored in
  `client/src/lib/routing.ts`.
- Replaced the enable switch with a `reference` badge for those platforms in
  `client/src/components/model-table.tsx` (row and group header, the latter only when every
  member is unroutable) and `client/src/components/keys/provider-models-panel.tsx`.
- Filtered reference-only routes out of the Compare key-scope pickers instead of hiding them,
  so mixed groups keep the control for their routable members — `client/src/pages/CompareModelsPage.tsx`.
- Added an `OpenCode only` scope to Compare Models alongside Routed / Keyed / Enabled / All.
- Forced reference-only rows to `enabled=0` on both the insert and update branches of
  `server/src/services/catalog-sync.ts`.
- Made `applyModelOverrides` drop the `enabled` override for reference-only platforms in
  `server/src/services/model-state.ts`; a stale `{"enabled":1}` had been re-enabling two models
  on every catalogue sync.
- Rebuilt Analytics compare mode as four shared metric cards with machines as rows and the
  unfiltered total as context, replacing one repeated panel per machine; `Panel`'s `icon` prop
  is now optional — `client/src/pages/AnalyticsPage.tsx`.
- Fixed `server/src/lib/request-log.ts:93` passing the undefined `latencyMs` instead of the
  `elapsedMs` parameter. Introduced 2026-09-11 in `c67f0857`; it failed `tsc` and blocked every
  image build for ten days.
- Added `filterOpencode`, `referenceOnly` and `referenceOnlyHint` to `en.json`, filled across
  59 locales with the English text per the project convention.
- Documented four gotchas (shared package ships no JS, the three enable layers, query-time
  device labels, bundle baked into the image) in `docs/GOTCHAS.md`.

---

## 2026-09-02

- Added opt-in preferred provider ordering for unified models while preserving automatic routing, health gates, cooldowns and failover.
- Added explicit quota scope/accounting metadata and exact-pool routing eligibility for shared, per-model, project/model, monetary, unknown and local-unmetered capacity.
- Preserved legacy Groq and Google quota observations through conservative read fallbacks; exact new-pool observations take precedence.
- Added catalogue-backed per-key model selection and per-credential RPM, RPD and TPD controls.
- Propagated quota context through OpenAI chat, Responses and Anthropic-compatible request paths.
- Added a source-linked, dated free-tier guidance catalogue for the seven configured providers, with advisory freshness/conflict states and a reviewed Codex refresh contract.
- Added atomic provider/model RPM, RPD, TPM and TPD editing beside key model access, plus confirmed application of verified guidance.
- Added a Model Scope copy action that exports concise provider/free-model configuration and sourced quota guidance for LLM review without credential or internal identity data.

---

## 2026-09-07 — quota ledger, provider usage APIs, deploy verification

66 commits. This was a long session; the list below is by area and may be incomplete in
detail, though the areas themselves are taken from `git diff --name-status`.

### Added
- `server/src/services/` — `quota-clock.ts` (timezone-safe reset windows), `quota-policy.ts`
  (effective-quota resolver, shared pools, env caps), `quota-routing.ts` (shadow scoring),
  `quota-forecast.ts` (provider overview), `quota-inference.ts` (window/allowance/reset
  inference), `quota-burn.ts` (deliberate limit discovery), `provider-usage-api.ts`
  (undocumented Ollama + OpenRouter usage readers, 300s poller).
- `server/src/data/ollama-model-rates.ts` — published per-M rates, so an allowance can be
  derived in credit rather than in tokens.
- `server/src/routes/quota.ts` — quota state, history, decisions, shadow stats, policy
  GET/PUT/DELETE, burn.
- `client/src/pages/QuotaPage.tsx` — provider overview, reset timeline, shadow + divergence,
  policy editor, burn panel. Registered in `App.tsx` and the extension registry.
- `scripts/deploy.sh` + `scripts/deploy.test.mjs` (9 tests) — a deploy that verifies it landed
  instead of trusting a piped exit status; wired as `npm run test:deploy`.
- Migrations: `quota_policy`, `routing_decision`, `quota_observation_lookup`,
  `quota_unit`, `quota_burn_run`.
- 25 test files under `server/src/__tests__/` covering the clock, policy resolution,
  concurrency, inference, burn, the shadow pipeline end-to-end, and model-scoped auth.
- `docs/architecture/07-quota-ledger-and-shadow-routing.md`, `docs/api/02-quota-api.md`,
  `docs/providers/04-quota-guidance.md`, and this session's `docs/GOTCHAS.md` entry.

### Changed
- `server/src/lib/error-classify.ts` — `isModelScopedAuthError`: a 401/403 naming the model is
  model-fatal, not key-fatal.
- `server/src/lib/fallback-loop.ts` — the `finish_reason === 'length'` bench exemption is priced
  by wasted prefill; failed attempts meter their tokens.
- `server/src/services/health.ts` — stopped certifying keys against endpoints that ignore auth;
  HuggingFace validates against `whoami-v2`.
- `server/src/services/provider-quota.ts` — `unit` on observations, append-only dedupe with a
  15-minute heartbeat.
- `shared/types.ts`, `server/src/db/index.ts` — quota metric/scope/period/source enums and
  settings accessors.
- `AGENTS.md`, `docs/deployment/03-imperium-extension-branch.md` — assert `Up (healthy)` and a
  published port as the final step of a redeploy.
