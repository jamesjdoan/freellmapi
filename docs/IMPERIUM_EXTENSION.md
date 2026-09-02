# Imperium FreeLLMAPI Extension

This document is the user and maintainer map for the features carried by the separate `codex/provider-routing-controls` branch. These features are installed in the running local image but are not part of upstream FreeLLMAPI `main`.

The dashboard’s **Extensions** button is the quickest runtime index. It lists the same features, shows that they are installed and links to the pages that own their settings.

## Where the settings live

| Feature | Dashboard path | What to do |
| --- | --- | --- |
| Provider preference ordering | **Models → Chat models → select a unified model** | In **Provider routing**, choose **Automatic** or **Preferred order**. In Preferred mode, use the up/down buttons. Changes save immediately. |
| Provider model access | **Keys → provider → key row → Models & account limits** | Hover or focus the key row and select the list/filter button. Tick the catalogue models that key may serve. |
| Provider account limits | **Keys → provider → key row → Models & account limits** | Set credential-wide RPM, RPD or TPD. Blank inherits provider behaviour; zero disables that particular account-wide gate. |
| Catalogue-wide copy | **Keys → Providers tab header** | Select **Copy List** — a page-level action, because it spans every provider rather than the key row it used to sit under. **All free models offered** takes every free catalogue model; **Selected free models only** takes those a usable key is scoped to serve. The export leads with the total, then each provider and its key count, then one model block per free model in the same shape **Copy provider details** uses. Custom relay endpoints are excluded because their free-tier status is unverified. Credentials, labels and internal IDs are never included. |
| Provider review copy | **Keys → provider → key row → Models & account limits** | Select **Copy provider details** to copy a concise Markdown snapshot of the current free-model catalogue, access/routing state, capabilities, visible limits, guidance and evidence. Credentials, labels and internal IDs are excluded. |
| Quota-pool routing | Automatic; usage context at **Models → Chat models → Monthly token budget** | There is no separate quota-pool editor. The linked view shows monthly token-use context; quota-pool eligibility and enforcement are automatic. |
| Extension inventory | Top navigation → **Extensions** | Review installed fork features and follow direct links to each settings area. |

Provider-row controls are intentionally compact. On desktop they appear when the key row is hovered or keyboard-focused. The button’s accessible name and tooltip are **Models & account limits**.

## Provider preference semantics

Pi and OMP continue to request the same unified public model name, for example:

```json
{ "model": "gpt-oss-120b" }
```

In **Automatic** mode, provider members retain FreeLLMAPI’s normal scoring order. This is the backward-compatible default for every existing installation and every group without a saved preference.

In **Preferred order** mode, the saved provider order becomes the first ordering dimension among members of that unified model. It is a soft preference, not an unconditional pin. The router still skips a member when it is disabled, lacks the requested capability, has no allowed healthy key, is cooling down or has a high-confidence observation that its applicable quota pool is exhausted. Existing failover-eligible errors continue to the next member.

Temporarily missing provider identities remain in the stored order and regain their former position if their catalogue row or key returns.

## Provider model access and account limits

Each provider key can carry a model scope:

- no saved scope means the key serves every current and future model for that provider;
- a non-empty scope means the router uses the key only for those model IDs;
- catalogue providers use FreeLLMAPI’s curated catalogue as the authority;
- live provider discovery is used only when the provider has no catalogue rows, such as a custom or uncatalogued endpoint.

Account limits belong to the credential, not to an individual model. The extension stores optional `providerRpmLimit`, `providerRpdLimit` and `providerTpdLimit` values per key and checks those gates before model-specific RPM/RPD/TPM/TPD gates.

Model limit fields shown in the same dialog belong to the provider/model endpoint and
apply across every key for that provider. The adjacent free-tier panel reads the
version-controlled extension catalogue; it never treats guidance as configured state
or observed usage. See [Provider quota guidance](providers/04-quota-guidance.md) for
the source hierarchy, freshness rules and the reviewed Codex refresh workflow.

**Copy provider details** exports the values currently visible in the dialog, including
unsaved limit edits, for manual review in an LLM. Catalogue providers include every
current free catalogue model and mark each model's access and routing state. A live-
discovered fallback is explicitly labelled as unverified. The export is read-only and
never includes an API key, masked key, credential label, database identity or usage
history, and it is not sent anywhere by FreeLLMAPI.

## Quota-pool model

Provider identity, model endpoint and consumed quota pool are separate concepts. Phase 1 represents the smallest distinctions needed to prevent false capacity multiplication or false provider-wide exhaustion:

| Economics | Examples | Pool treatment |
| --- | --- | --- |
| Shared request allowance | OpenRouter `:free` | One `openrouter::free` request pool shared by its free models. |
| Independent model allowance | Groq | One metered request/token pool per Groq model. Exhausting one model does not suppress its siblings. |
| Project/model allowance | Google Gemini | One metered pool per project credential and model identity. |
| Shared monetary credit | Hugging Face Router | One shared credits pool; Phase 1 observes it but does not choose the cheapest model automatically. |
| Unpublished promotional capacity | OpenCode and similar endpoints | Capacity stays unknown. Health, observed 429s, cooldown and reliability govern failover; no allowance is invented. |
| Local endpoint | Private/loopback custom endpoint | Unmetered API capacity; local compute and latency remain relevant through normal scoring. |

Only a high-confidence observation of zero remaining capacity with a future reset is a hard quota-pool routing gate. Unknown capacity stays eligible. Older Groq account-wide and Google project-wide observations remain readable until an exact new-pool observation supersedes them.

Phase 1 does not implement task classification, strongest-model selection across families, cheapest-sufficient monetary optimisation or quota forecasting.

## API and persistence ownership

The Extensions panel owns no state. Real settings remain in existing APIs and SQLite storage:

| Setting | API | Storage |
| --- | --- | --- |
| Provider order | `GET/PUT /api/settings/unify` → `providerPreferences` | `settings.model_provider_preferences` JSON, schema version 1 |
| Key model access | `PATCH /api/keys/:id` → `modelScope` | `api_keys.model_scope_json` |
| Account limits | `PATCH /api/keys/:id` → `providerRpmLimit`, `providerRpdLimit`, `providerTpdLimit` | `api_keys.provider_rpm_limit`, `provider_rpd_limit`, `provider_tpd_limit` |
| Provider/model limits | `PATCH /api/keys/:id` → `modelLimits[]` | Existing `models` limit columns plus `model_overrides` for catalogue persistence |
| Quota guidance | `GET /api/keys/quota-guidance` | Version-controlled `server/src/data/quota-guidance.ts`; no database state |
| Quota observations | Provider response parsing and routing services | `provider_quota_state` and observation history keyed by platform, credential, pool and metric |

The additive migration is `server/src/db/migrations/20260902_000002_provider_account_limits.ts`. Missing preference JSON safely means Automatic; corrupt preference JSON also fails closed to Automatic.

## Implementation map

| Concern | Primary files |
| --- | --- |
| Extension inventory and links | `client/src/lib/extension-registry.ts`, `client/src/components/extensions-dialog.tsx`, `client/src/App.tsx` |
| Model-detail provider order UI | `client/src/pages/ModelDetailPage.tsx`, `client/src/lib/provider-preferences.ts` |
| Preference persistence/group identity | `server/src/routes/settings.ts`, `server/src/services/model-groups.ts` |
| Preferred ordering and eligibility | `server/src/services/router.ts` |
| Key catalogue scope/account-limit UI | `client/src/components/keys/model-scope-dialog.tsx`, `client/src/components/keys/provider-list.tsx` |
| Quota guidance UI/catalogue | `client/src/components/keys/quota-guidance-panel.tsx`, `server/src/data/quota-guidance.ts` |
| Provider review copy | `client/src/lib/provider-model-details-export.ts`, `client/src/components/keys/provider-model-details-copy-action.tsx` |
| Free catalogue copy | `client/src/pages/KeysPage.tsx`, `client/src/components/keys/free-catalog-copy-action.tsx`, `client/src/lib/provider-model-details-export.ts`, `client/src/lib/model-scope-selection.ts` |
| Key update API/migration | `server/src/routes/keys.ts`, `server/src/db/migrations/20260902_000002_provider_account_limits.ts` |
| Quota policy/observations | `server/src/services/provider-quota.ts`, `server/src/services/ratelimit.ts` |
| API-surface quota context | `server/src/routes/proxy.ts`, `server/src/routes/responses.ts`, `server/src/routes/anthropic.ts` |

## Validation map

- Registry and rendered panel: `client/src/lib/extension-registry.test.tsx`
- Provider preference ordering helpers: `client/src/lib/provider-preferences.test.ts`
- Unified routing/failover: `server/src/__tests__/routes/proxy-model-groups.test.ts`
- Shared versus independent pools: `server/src/__tests__/services/provider-quota.test.ts`
- Provider account limits: `server/src/__tests__/services/provider-minute-cap.test.ts` and `server/src/__tests__/services/ratelimit.test.ts`
- Catalogue key scopes: `server/src/__tests__/routes/keys-model-scope.test.ts`
- Quota guidance: `server/src/__tests__/routes/quota-guidance.test.ts` and `client/src/components/keys/quota-guidance-panel.test.tsx`
- Provider review copy and credential exclusion: `client/src/lib/provider-model-details-export.test.tsx`
- Free catalogue copy scopes, formatting and credential exclusion: `client/src/lib/provider-model-details-export.test.tsx`
- Free catalogue copy menu behaviour: `client/src/components/keys/free-catalog-copy-action.render.test.tsx`
- Cross-surface routing: OpenAI route tests plus `server/src/__tests__/routes/anthropic.test.ts`
- Migration safety: `server/src/__tests__/db/migrate/roundtrip.test.ts`

## Updating or deploying the extension

Do not merge this fork into upstream `main`. Rebase the extension branch onto the desired upstream revision, resolve conflicts in the extension branch, run the full suite, rebuild the local image and recreate the existing Docker service with its existing volume.

The current machine paths, image tag, backup boundary, exact update workflow and rollback notes are in [deployment/03-imperium-extension-branch.md](deployment/03-imperium-extension-branch.md).

## Adding another extension feature

Add one typed metadata entry to `client/src/lib/extension-registry.ts`, point it at the page that owns the real state, extend the registry/render test and update this guide. Do not put feature state, mutations or independent configuration inside the registry or Extensions dialog.
