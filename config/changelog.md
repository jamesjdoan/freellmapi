# Changelog

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
