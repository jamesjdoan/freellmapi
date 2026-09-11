# Imperium FreeLLMAPI Extension

This checkout is the Imperium-maintained FreeLLMAPI extension, not upstream `main`. The public API stays FreeLLMAPI-compatible while this branch adds provider ordering, quota-pool correctness, provider-key model access, measured benchmark comparison with proxy scores for unpublished models, a catalogue arrival/departure log, and an Extensions dashboard index.

## Read first

| Task | Read first | Then read |
| --- | --- | --- |
| Find or operate extension settings | `docs/IMPERIUM_EXTENSION.md` | Relevant linked UI/source section |
| Change unified-model routing | `docs/architecture/01-routing-and-bandit-scoring.md` | `docs/adr/ARCH-20260901-unified-provider-preference-and-quota-pools.md` |
| Change quota semantics | `docs/providers/02-quotas-and-cooldowns.md` | `server/src/services/provider-quota.ts` |
| Update from upstream | `docs/deployment/03-imperium-extension-branch.md` | `docs/GOTCHAS.md` |
| Change benchmark scores, mapping or key reachability | `docs/adr/ARCH-20260911-measured-benchmarks-and-proxy-scores.md` | `server/src/services/analysis.ts` |
| Add another fork feature | `docs/adr/ARCH-20260902-extension-registry-dashboard.md` | `client/src/lib/extension-registry.ts` |

## Hard constraints

- Keep changes on `docs/freellm-assert-start-on-redeploy`, the branch that carries the whole extension; do not merge into upstream `main` unless explicitly requested. `codex/provider-routing-controls` is an ancestor of it, kept as the publishable subset on the older `v0.9.4` base — it does not contain the quota-ledger subsystem (`quota-policy`, `quota-clock`, `quota-routing` and their migrations), so work built on that resolver cannot land there.
- Rebase the extension branch onto upstream releases, validate it, rebuild the local image, then recreate the existing container with its existing data volume.
- Finish a redeploy with `docker compose up -d` and confirm `docker compose ps` reads `Up (healthy)` with a published port. A container left in `Created` stays down through reboots — `restart: unless-stopped` never starts one that has not run — and the harness roles pointed at FreeLLM fall back silently rather than erroring.
- Preserve public unified model IDs and automatic-routing defaults.
- Preferred provider order remains soft: health, capability, key scope, cooldown and known quota exhaustion still win.
- The Extensions registry is navigation/documentation metadata, never a second settings store.
- New UI strings go into `client/src/i18n/locales/en.json`, then straight into every other locale as the English text via `node scripts/apply-translations.mjs --fill-english` from `client/`. Do not hand-translate them. The 60 locales are upstream's (`#607`), this is a single-user tool, and `check:i18n` gates only on the key being PRESENT — over 3,300 keys already hold the English text, so filling is the existing convention rather than an exception. Translate only what the operator asks for by name.
- Never commit secrets, `.env` files, database contents or local backups.
- Do not commit, push or deploy without explicit approval for that individual action.

## Current branch and deployment

- Fork: `jamesjdoan/freellmapi`
- Branch: `docs/freellm-assert-start-on-redeploy` (publishable subset: `codex/provider-routing-controls`)
- Local image: `jamesjdoan/freellmapi:provider-routing`
- Dashboard: `http://127.0.0.1:3001`
- Persistent Docker volume: `freellmapi_freellmapi-data`

Machine-specific paths and safe update commands are documented in `docs/deployment/03-imperium-extension-branch.md`.
