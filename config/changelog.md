# Changelog

## 2026-09-04

Recall is believed complete for the code changes (three commits); the container operations were interactive and are summarised rather than enumerated.

- Merged upstream v0.9.5 into `imperium/eol-reinstatement-base` (`7169b82`): `server/src/db/migrate/defaults.ts`, `server/src/__tests__/db/migrate/roundtrip.test.ts` and `server/src/services/router.ts` keep both sides — the extension's `provider_preference_rank` accessor plus upstream's reassignable `let weights`, and the migration lists ordered by filename.
- Made a provider's own refusal outrank the catalogue that still lists the model: `server/src/services/catalog-sync.ts` records the disagreement instead of lifting the retirement, and `reinstateUpstreamRetiredCatalogModel` is now reachable only from an operator re-enable in `server/src/routes/models.ts`.
- Added `relisted_at`, `relist_count` and `acknowledged_at` to `catalog_model_tombstones` via `server/src/db/migrations/20260904_000001_retirement_reconciliation.ts`, with the read/settle/list helpers in `server/src/services/model-state.ts`.
- Added `GET /api/models/retirements` (pending + acknowledged) and `POST /api/models/retirements/{ignore,unignore}` in `server/src/routes/models.ts`.
- Added `client/src/components/retirement-reconciliation.tsx` and mounted it on `client/src/pages/FallbackPage.tsx`: pending disagreements in a notice, settled ones collapsed into a muted count that expands with Undo.
- Closed disagreements the catalogue stops making — `clearReconciledRetirements` runs in `applyCatalog` against the same `inCatalog` set the prune pass uses, so an entry leaves the list without an operator ruling.
- Registered `retirement-reconciliation` as the tenth entry in `client/src/lib/extension-registry.ts` (+ test and `client/src/i18n/locales/en.json` strings).
- Replayed the uncommitted `auto:<profile>` chain fix in `server/src/routes/anthropic.ts` on top of v0.9.5's task-type routing (still uncommitted, staged).
- Rebuilt `jamesjdoan/freellmapi:provider-routing` from the merged branch and recreated the live container three times; recovered the correct `ENCRYPTION_KEY`, and converted the hand-pinned `nvidia/openai/gpt-oss-120b` and `google/gemini-2.5-flash` into tombstoned retirements.
- Recorded five session gotchas in `docs/GOTCHAS.md` (dual IPv4/IPv6 bind on 3001, Vite `loadEnv` port precedence, silent `ENCRYPTION_KEY` mismatch, compose project-name volume reattachment, single-interface `HOST_BIND` refusing loopback).

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
