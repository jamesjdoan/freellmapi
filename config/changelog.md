# Changelog

## 2026-09-25 — Chain table sorts the view; key dialog edits limits only

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
