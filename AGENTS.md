# Imperium FreeLLMAPI Extension

This checkout is the Imperium-maintained FreeLLMAPI extension, not upstream `main`. The public API stays FreeLLMAPI-compatible while this branch adds provider ordering, quota-pool correctness, provider-key model access and an Extensions dashboard index.

## Read first

| Task | Read first | Then read |
| --- | --- | --- |
| Find or operate extension settings | `docs/IMPERIUM_EXTENSION.md` | Relevant linked UI/source section |
| Change unified-model routing | `docs/architecture/01-routing-and-bandit-scoring.md` | `docs/adr/ARCH-20260901-unified-provider-preference-and-quota-pools.md` |
| Change quota semantics | `docs/providers/02-quotas-and-cooldowns.md` | `server/src/services/provider-quota.ts` |
| Update from upstream | `docs/deployment/03-imperium-extension-branch.md` | `docs/GOTCHAS.md` |
| Add another fork feature | `docs/adr/ARCH-20260902-extension-registry-dashboard.md` | `client/src/lib/extension-registry.ts` |

## Hard constraints

- Keep changes on `codex/provider-routing-controls`; do not merge into upstream `main` unless explicitly requested.
- Rebase the extension branch onto upstream releases, validate it, rebuild the local image, then recreate the existing container with its existing data volume.
- Preserve public unified model IDs and automatic-routing defaults.
- Preferred provider order remains soft: health, capability, key scope, cooldown and known quota exhaustion still win.
- The Extensions registry is navigation/documentation metadata, never a second settings store.
- Never commit secrets, `.env` files, database contents or local backups.
- Do not commit, push or deploy without explicit approval for that individual action.

## Current branch and deployment

- Fork: `jamesjdoan/freellmapi`
- Branch: `codex/provider-routing-controls`
- Local image: `jamesjdoan/freellmapi:provider-routing`
- Dashboard: `http://127.0.0.1:3001`
- Persistent Docker volume: `freellmapi_freellmapi-data`

Machine-specific paths and safe update commands are documented in `docs/deployment/03-imperium-extension-branch.md`.
