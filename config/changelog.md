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
