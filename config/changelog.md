# Changelog

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

---

## 2026-09-20 — chain capability verification, probe fix, docs cleanup, DNS fix

### Added
- `server/src/services/chain-capability.ts` — per-capability audit (`vision`, `tools`) against chain contracts; three states `ok` / `failed` / `unverified`; `unverified` is a real state (absence of evidence), only `failed` blocks membership writes. Generic over `requiresVision` / `requiresTools` from `CHAIN_CONTRACTS`.
- `server/src/services/model-health.ts` — `probeModelVision()` with inline 32×32 PNG (96 bytes); `runProbe()` shared body.
- `server/src/__tests__/services/chain-capability.test.ts` (11 tests), `__tests__/routes/fallback-capability-gate.test.ts` (3 tests), model-health regression test for 32px floor.
- `server/src/db/migrations/20260919_000003_model_capability_probe.ts` — table keyed `(platform, model_id, endpoint_scope, capability)` mirroring `models` uniqueness.
- `server/src/data/extension-registry.ts` — `chain-capability-verification` entry (enforcement-only toggle; audit, evidence, verification stay on).
- Two routes: `GET /api/fallback/capability[?chain=]`, `POST /api/fallback/capability/verify {chain}`.

### Changed
- `server/src/services/model-health.ts` — `PROBE_IMAGE_DATA_URL` 8×8 → 32×32 (74→96 bytes); comment records Groq 400 measurement.
- `server/src/services/quota-routing.ts` — dropped disputed ledger count; now only in down-migration.
- `server/src/routes/quota.ts` — corrected comment: routing_decision table dropped, not kept as history.
- `server/src/services/router.ts:1159` — corrected false offBehaviour comment (admission unaffected, gate is `quota-ledger-precedence`).
- `server/src/routes/fallback.ts` — `capabilityBlock` gated by `chain-capability-verification`; `endpoint_scope` in SELECT; `auditChainCapabilities` / `verifyChain` routes.
- `server/src/data/extension-registry.ts` — `quota-aware-scoring` entry corrected: five dead references removed, boolean gate at `router.ts:1163/1282` named.
- `server/src/__tests__/data/extension-registry.test.ts` — `existsSync` + symbol-in-cited-file assertions (negative-tested).
- `server/src/__tests__/routes/quota.test.ts` — dead shadow endpoints and `quota_routing_mode` cleanup removed; replaced with live `/reservation`, `/forecast`.
- `server/src/__tests__/services/model-health.test.ts` — 32px floor decode test (negative-tested against 8×8).

### Infrastructure
- Local DNS fix: `/etc/resolver/ts.net` manually created (`nameserver 100.100.100.100`) — unmanaged by tailscaled, noted for handoff.

### Verified
- Full suite: 3,833 passed / 5 failed / 5 skipped (313 files). 5 failures are pre-existing bandit timeouts (reproduced on stashed clean tree at 81328947).
- Typecheck clean.
- Live: `HTTP 401` on `/api/health` without `--resolve`; `/v1/models` → `HTTP 200` with 8 `auto:*` aliases.

### Open
- Vision probe never reached a real provider (no key on this machine). Re-verify on Studio after deploy — if any member records `failed`, that's the real control; if none does, accept that enforcement has no live evidence.
- `/etc/resolver/ts.net` is manually created and unmanaged by tailscaled; may be overwritten. Root cause: tailscaled declines to install its own `ts.net` resolver even after `accept-dns` toggle.
- `chain-capability-verification` enforcement 409 never fired against a real recorded failure. Awaiting Studio re-verify after image fix.


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
