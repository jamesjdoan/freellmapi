# Imperium FreeLLMAPI Extension

This document is the user and maintainer map for the features carried by the separate `docs/freellm-assert-start-on-redeploy` extension branch. These features are installed in the running local image but are not part of upstream FreeLLMAPI `main`. (`codex/provider-routing-controls` is the older publishable subset of the same work; see `docs/deployment/03-imperium-extension-branch.md`.)

The dashboard’s **Extensions** button is the quickest runtime index. It lists the same features, shows that they are installed and links to the pages that own their settings.

## Where the settings live

| Feature | Dashboard path | What to do |
| --- | --- | --- |
| Provider preference ordering | **Models → Chat models → select a unified model** | In **Provider routing**, choose **Automatic** or **Preferred order**. In Preferred mode, use the up/down buttons. Changes save immediately. |
| Hide disabled models | **Models → Chat models → Hide disabled** | On by default. Hides logical models whose every provider is switched off in the active chain, with the hidden count on the filter. Turn it off to see and re-enable them. Remembered per browser. |
| Provider model access | **Keys → provider → key row → Models & account limits** | Hover or focus the key row and select the list/filter button. Tick the catalogue models that key may serve, or search by name or id and use **Enable shown** / **Disable shown** — both arm first and name the count (`Disable 3?`) before they act, and both apply only to the rows currently shown. Enabled models sort to the top, then the most advanced of the rest: capability tier, then per-provider rank, then the highest version within a family (`gemini-3.6-flash` above `gemini-3.5-flash`). Versions are never compared across vendors. **Hide disabled models** is on by default and hides the ones that were off when the dialog opened; the count beside it says how many. |
| Provider row summary | **Keys → Providers** | Read each provider at a glance: `N/M models enabled` on its row, and one row instead of a disclosure when it holds a single key. Nothing to configure. |
| Provider account limits | **Keys → provider → key row → Models & account limits** | Set credential-wide RPM, RPD or TPD. Blank inherits provider behaviour; zero disables that particular account-wide gate. |
| Catalogue arrival and departure log | **Models → Chat models → Catalogue log** | Read what entered and left the catalogue, folded by year, month, week and day. The newest ten are listed in full; older history opens one period at a time. A departure records the chains it was serving, which the model row itself cannot say once deleted. Nothing to configure. |
| Per-provider catalogue churn | **Keys → provider key row → churn chip** | See what that provider gained and lost lately, and expand into per-model scope switches. A retirement names the chains it was serving. |
| Measured model comparison | **Analytics → Compare models** | Paste an Artificial Analysis key (stored encrypted) and press **Refresh data**. Sort any column; unmeasured models sink to the bottom in both directions. Search by model, provider, route id, chain or benchmark. The scope buttons say what "available" means: in a chain, reachable with a key, enabled, or merely discovered — each counted. |
| Benchmark mapping and baselines | **Analytics → Compare models → Mapped to** | Every row shows which benchmark it matched and how. Click to remap: search, select, press **OK**. On a merged model one pick writes every route, so its copies cannot disagree. **Add a baseline** pins any published model — a paid frontier one, typically — as a shaded row and bar to read free scores against. |
| Proxy scores for unpublished models | **Keys → provider → model row → Mapped to → closest match** | For a model Artificial Analysis does not publish, tick **closest match** before or after selecting, then **OK**. The row reads `≈ name / estimated`. Hover a score cell for − and + : three coarse steps per metric, shown `+++` green or `---` red. Speed steps by 15% because tokens/sec has no common scale with the indices. A measurement can never be adjusted. When a sync publishes the real model, both Compare and Keys offer **Use real data**. |
| Merge catalogue rows into one logical model | **Models → Chat models → Merge** | Press **Merge**, tick two or more rows, choose which name survives, and **Fold in**. Picks survive searching, so the two rows needing merging rarely share a name. Undo the whole merge from the row's `unmerge` chip, or take one route back out from the picker in merge mode. Both confirm first. This writes the router's unify overrides, so failover changes immediately. |
| Provider model comparison on Keys | **Keys → Providers → expand a provider** | Every model that provider serves, with measured scores, the chains routing to it, and one switch for whether this key routes it at all. One provider opens at a time. Rows that cannot route are faded; `idle` means enabled and reachable with nothing routing to it. |
| Key reachability signals | **Analytics → Compare models**, **Keys → Providers** | A filled swatch is a usable key, a hollow circle a key switched off, a hollow square no key at all — the last two link to the screen that fixes it. Hover any swatch for what that provider serves and how much of it the key permits. Where the key omits a route, `+ key scope` adds it and `− key scope` removes it; with several routes you choose which. |
| Catalogue-wide copy | **Keys → Providers tab header** | Select **Copy List** — a page-level action, because it spans every provider rather than the key row it used to sit under. **All free models offered** takes every free catalogue model; **Enabled free models only** takes those a usable key is enabled to serve. Custom relay endpoints are excluded because their free-tier status is unverified. |
| Provider free-model copy | **Keys → provider → key row → Models & account limits** | Select **Copy List** for one provider, with the same two scopes: **All free models offered** or **Enabled free models only** (the models this key is ticked for). Includes account limits, unsaved limit edits and published quota guidance. |
| Quota-pool routing | Automatic; usage context at **Models → Chat models → Monthly token budget** | There is no separate quota-pool editor. The linked view shows monthly token-use context; quota-pool eligibility and enforcement are automatic. |
| Extension inventory | Top navigation → **Extensions** | Review installed fork features and follow direct links to each settings area. |

A provider holding exactly one key is shown as a single row: its group header would repeat the same provider and its disclosure would have nothing to disclose, so the provider name, the `N/M models enabled` count and the provider menu move onto the key row itself. Two or more keys keep the group header, which carries the same count. The count is the models the provider's enabled keys are scoped to serve, out of the models it offers; several keys union their scopes, so one unscoped key reads as all of them.

Provider-row controls are intentionally compact. On desktop they appear when the key row is hovered or keyboard-focused. The button’s accessible name and tooltip are **Models & account limits**.

The page-level copy opens with a **Providers and their free models** index — one line per provider naming every model id it offers — so the provider/model pairing is answerable without reading the detail below. Both **Copy List** actions then share one format, built by one renderer: the total
first, then the provider and its counts, then one block per free model carrying
access and routing state, capabilities, catalogue allowance and limits. Neither
includes a credential, key label or internal identifier, and neither is sent
anywhere by FreeLLMAPI.

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
| Provider row summary and model counts | `client/src/components/keys/provider-list.tsx`, `client/src/lib/model-scope-selection.ts` |
| Models page disabled filter | `client/src/pages/FallbackPage.tsx` |
| Quota guidance UI/catalogue | `client/src/components/keys/quota-guidance-panel.tsx`, `server/src/data/quota-guidance.ts` |
| Provider free-model copy | `client/src/lib/provider-model-details-export.ts`, `client/src/components/keys/provider-model-details-copy-action.tsx` |
| Free catalogue copy | `client/src/pages/KeysPage.tsx`, `client/src/components/keys/free-catalog-copy-action.tsx`, `client/src/lib/provider-model-details-export.ts`, `client/src/lib/model-scope-selection.ts` |
| Catalogue event log | `server/src/services/catalogue-log.ts`, `server/src/db/migrations/20260910_000002_catalogue_event_log.ts`, `client/src/components/catalogue-log.tsx`, `client/src/lib/time-tree.ts` |
| Benchmark sync, matching and links | `server/src/services/analysis.ts`, `server/src/services/analysis-match.ts`, `server/src/routes/analysis.ts`, `server/src/db/migrations/20260911_000001_analysis_benchmarks.ts` |
| Proxy scores and adjustments | `server/src/services/analysis.ts` (`setManualLink`, `setProxyDelta`, `findProxyUpgrades`), migrations `20260911_000004/000005/000006` |
| Compare models page | `client/src/pages/CompareModelsPage.tsx`, `client/src/lib/compare-sort.ts`, `client/src/components/compare/scope-picker.tsx` |
| Provider model panel | `client/src/components/keys/provider-models-panel.tsx`, `client/src/components/keys/provider-list.tsx` |
| Logical-model merging | `client/src/lib/alias-merge.ts`, `client/src/pages/FallbackPage.tsx`, `server/src/services/model-groups.ts` |
| Key reachability signals | `client/src/components/platform-dot.tsx`, `server/src/services/analysis.ts` (`keyScope`, `setModelKeyScope`) |
| Key update API/migration | `server/src/routes/keys.ts`, `server/src/db/migrations/20260902_000002_provider_account_limits.ts` |
| Quota policy/observations | `server/src/services/provider-quota.ts`, `server/src/services/ratelimit.ts` |
| API-surface quota context | `server/src/routes/proxy.ts`, `server/src/routes/responses.ts`, `server/src/routes/anthropic.ts` |

## Validation map

- Registry and rendered panel: `client/src/lib/extension-registry.test.tsx`
- Catalogue event log: `server/src/__tests__/services/catalogue-log.test.ts`, `client/src/lib/time-tree.test.ts`, `client/src/components/time-tree-log.test.tsx`
- Benchmark matching and links: `server/src/__tests__/services/analysis-match.test.ts`, `analysis-link.test.ts`, `analysis-grouped.test.ts`, `server/src/__tests__/routes/analysis-link.test.ts`
- Proxy scores, adjustments and upgrade prompts: `server/src/__tests__/services/analysis-grouped.test.ts`
- Compare sorting and search: `client/src/lib/compare-sort.test.ts`
- Logical-model merging: `client/src/lib/alias-merge.test.ts`, `server/src/__tests__/services/model-groups.test.ts`
- Provider preference ordering helpers: `client/src/lib/provider-preferences.test.ts`
- Unified routing/failover: `server/src/__tests__/routes/proxy-model-groups.test.ts`
- Shared versus independent pools: `server/src/__tests__/services/provider-quota.test.ts`
- Provider account limits: `server/src/__tests__/services/provider-minute-cap.test.ts` and `server/src/__tests__/services/ratelimit.test.ts`
- Catalogue key scopes: `server/src/__tests__/routes/keys-model-scope.test.ts`
- Quota guidance: `server/src/__tests__/routes/quota-guidance.test.ts` and `client/src/components/keys/quota-guidance-panel.test.tsx`
- Provider free-model copy and credential exclusion: `client/src/lib/provider-model-details-export.test.tsx`
- Scope ordering, key access and model counts: `client/src/lib/model-scope-selection.test.ts`
- Free catalogue copy scopes, formatting and credential exclusion: `client/src/lib/provider-model-details-export.test.tsx`
- Free catalogue copy menu behaviour: `client/src/components/keys/free-catalog-copy-action.render.test.tsx`
- Cross-surface routing: OpenAI route tests plus `server/src/__tests__/routes/anthropic.test.ts`
- Migration safety: `server/src/__tests__/db/migrate/roundtrip.test.ts`

## Updating or deploying the extension

Do not merge this fork into upstream `main`. Rebase the extension branch onto the desired upstream revision, resolve conflicts in the extension branch, run the full suite, rebuild the local image and recreate the existing Docker service with its existing volume.

The current machine paths, image tag, backup boundary, exact update workflow and rollback notes are in [deployment/03-imperium-extension-branch.md](deployment/03-imperium-extension-branch.md).

## Adding another extension feature

Add one typed metadata entry to `client/src/lib/extension-registry.ts`, point it at the page that owns the real state, extend the registry/render test and update this guide. Do not put feature state, mutations or independent configuration inside the registry or Extensions dialog.

## Design records

| Subsystem | ADR |
| --- | --- |
| Provider preference and quota pools | `docs/adr/ARCH-20260901-unified-provider-preference-and-quota-pools.md` |
| Extensions registry | `docs/adr/ARCH-20260902-extension-registry-dashboard.md` |
| Provider model details copy | `docs/adr/ARCH-20260902-provider-model-details-copy.md` |
| Provider quota guidance | `docs/adr/ARCH-20260902-provider-quota-guidance.md` |
| Quota ledger and quota-aware router | `docs/adr/ARCH-20260905-quota-ledger-and-quota-aware-router.md` |
| Measured benchmarks, proxy scores and key reachability | `docs/adr/ARCH-20260911-measured-benchmarks-and-proxy-scores.md` |
