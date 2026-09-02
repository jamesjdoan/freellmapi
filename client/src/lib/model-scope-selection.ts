// Pure logic behind the post-add model picker on the Keys page.
//
// A freshly pasted provider key serves EVERY model of its platform (#657:
// `model_scope_json` NULL = no scope). That is right for most people and wrong
// for anyone holding a relay-station key that only pays for a couple of model
// groups — and the only way to find out used to be a stream of 401s at routing
// time. So the moment a key lands for a platform with a big catalog, offer the
// list once.
//
// The two rules that make the offer safe to accept:
//   * "everything ticked" must stay a NULL scope, never the full id list.
//     A stored list freezes the key at today's catalog, so every model the
//     catalog gains next month would silently bypass that key.
//   * "nothing ticked" is not a scope. The server maps an empty array back to
//     NULL (= serves everything), which is the exact opposite of what an empty
//     tick list looks like it means, so the caller must refuse to submit it
//     rather than send a request that quietly does the wrong thing.
//
// Kept out of the component so both rules are unit-testable without rendering.

import type { FallbackEntry } from './routing'
import type { FreeCatalogExportProvider, FreeCatalogScope } from './provider-model-details-export'
import type { ApiKey } from '../../../shared/types'

/** One row of the picker: a catalog model this key could be scoped to. */
export interface ScopeCandidate {
  /** The provider-side model id — what `modelScope` actually stores. */
  modelId: string
  displayName: string
  /** Catalog capability tier ('Frontier' | 'Large' | 'Medium' | 'Small'), or null. */
  sizeLabel: string | null
  contextWindow: number | null
  /**
   * Per-provider capability rank; lower is more capable. Paired with
   * `sizeLabel` this is the catalogue's own advancement order.
   */
  intelligenceRank: number
}

/**
 * Below this many models the picker is pure friction: a provider serving three
 * models is trivially inspected on the Models page, and a dialog in the way of
 * "I just pasted a key" costs more than it saves. Six = "more than five".
 */
export const MODEL_PICKER_MIN_MODELS = 6

/**
 * The picker rows for one platform, taken from the `['fallback']` model list
 * the dashboard already holds — no extra endpoint, and no widening of the
 * POST /api/keys response.
 *
 * Order is left exactly as the server sent it (fallback priority, i.e. roughly
 * best-first), so the picker reads like the Models table rather than inventing
 * its own ranking. Duplicate model ids collapse to their first occurrence:
 * `modelScope` matches on model id alone, so two rows with one id could never
 * be ticked apart.
 */
export function scopeCandidates(
  entries: readonly FallbackEntry[],
  platform: string,
): ScopeCandidate[] {
  // 'custom' rows are per-endpoint, not per-platform — one custom key must
  // never be offered another endpoint's models.
  if (!platform || platform === 'custom') return []
  const seen = new Set<string>()
  const candidates: ScopeCandidate[] = []
  for (const entry of entries) {
    if (entry.platform !== platform) continue
    if (!entry.modelId || seen.has(entry.modelId)) continue
    seen.add(entry.modelId)
    candidates.push({
      modelId: entry.modelId,
      displayName: entry.displayName || entry.modelId,
      sizeLabel: entry.sizeLabel || null,
      contextWindow: entry.contextWindow ?? null,
      intelligenceRank: entry.intelligenceRank,
    })
  }
  return candidates
}

/**
 * Cross-provider capability tiers, in the order `POST /api/fallback/sort/
 * intelligence` already uses (issue #135): `intelligence_rank` is per-provider,
 * so the tier has to normalise before the rank breaks ties.
 */
const CAPABILITY_TIER: Record<string, number> = { Frontier: 1, Large: 2, Medium: 3, Small: 4 }

/**
 * Split a model id into the family it belongs to and its version number.
 *
 * Only the FIRST version-looking token counts, because families put the version
 * straight after the name (`gemini-3.5-flash`, `qwen3.6-27b`, `glm-4.7-flash`)
 * while later numbers are parameter counts. A token ending in b/m/k is a size,
 * never a version: `gpt-oss-120b` is one model, not version 120.
 *
 * The family is what remains once the version and size tokens are removed, so
 * `gemini-3.5-flash` and `gemini-2.5-flash` share `gemini-flash` and can be
 * compared. `glm-4.5` and `qwen3.6` cannot, and get different families —
 * comparing 4.5 against 3.6 across vendors would be a fabricated ranking.
 */
export function modelFamilyAndVersion(modelId: string): { family: string; version: number[] } {
  const withoutProvider = modelId.slice(modelId.lastIndexOf('/') + 1).toLowerCase()
  const tokens = withoutProvider.split(/[^a-z0-9.]+/).filter(Boolean)
  const version: number[] = []
  const family: string[] = []
  for (const token of tokens) {
    // A size token: 120b, 27b, 22m, 8x7b-style suffixes.
    if (/^\d+(?:\.\d+)*[bmk]$/.test(token)) continue
    const bare = /^\d+(?:\.\d+)*$/.test(token) ? token : null
    // `qwen3.6` and `gpt4` carry the version glued to the name.
    const glued = bare ? null : /^([a-z][a-z-]*?)(\d+(?:\.\d+)*)$/.exec(token)
    if (bare && version.length === 0) {
      version.push(...bare.split('.').map(Number))
      continue
    }
    if (glued && version.length === 0) {
      version.push(...glued[2].split('.').map(Number))
      family.push(glued[1])
      continue
    }
    if (bare || glued) continue
    family.push(token)
  }
  return { family: family.join('-'), version }
}

/** Higher version first; a model with no version sorts after one that has it. */
function compareVersionDesc(left: number[], right: number[]): number {
  if (left.length === 0 !== (right.length === 0)) return left.length === 0 ? 1 : -1
  for (let i = 0; i < Math.max(left.length, right.length); i += 1) {
    const diff = (right[i] ?? 0) - (left[i] ?? 0)
    if (diff !== 0) return diff
  }
  return 0
}

/**
 * Order the scope picker: models this key already serves first, then the most
 * advanced of the rest.
 *
 * "Most advanced" is the app's own definition first — capability tier, then
 * per-provider rank, exactly what `POST /api/fallback/sort/intelligence` does.
 * Nothing in the catalogue records a release date, so newest cannot be sorted
 * on directly.
 *
 * Where tier and rank tie, siblings of one family group together and the
 * highest version leads: `gemini-3.6-flash` above `gemini-3.5-flash` above
 * `gemini-2.5-flash`. Version is deliberately NOT compared across families,
 * because GLM 4.5 is not a later release than Qwen 3.6 — the numbers belong to
 * different vendors and comparing them would invent a ranking the catalogue
 * does not support.
 *
 * `enabled` is read from the tick state as it stood when the dialog opened, and
 * held for the life of it. Re-sorting as boxes are ticked would move the row out
 * from under the pointer mid-click, so the order is deliberately frozen while
 * editing.
 */
export function orderScopeCandidates(
  candidates: readonly ScopeCandidate[],
  enabled: (modelId: string) => boolean,
): ScopeCandidate[] {
  const keyed = candidates.map(candidate => ({
    candidate,
    ...modelFamilyAndVersion(candidate.modelId),
    numbers: [
      enabled(candidate.modelId) ? 0 : 1,
      CAPABILITY_TIER[candidate.sizeLabel ?? ''] ?? 5,
      Number.isFinite(candidate.intelligenceRank) ? candidate.intelligenceRank : Number.MAX_SAFE_INTEGER,
    ],
  }))
  return keyed.sort((left, right) => {
    for (let i = 0; i < left.numbers.length; i += 1) {
      if (left.numbers[i] !== right.numbers[i]) return left.numbers[i] - right.numbers[i]
    }
    if (left.family !== right.family) return left.family.localeCompare(right.family)
    const byVersion = compareVersionDesc(left.version, right.version)
    if (byVersion !== 0) return byVersion
    return left.candidate.displayName.localeCompare(right.candidate.displayName)
  }).map(entry => entry.candidate)
}

/**
 * What a provider's usable keys are scoped to serve. `serveAll` covers the
 * ordinary case of an unscoped key (#657: a NULL scope serves every model of
 * its platform), which no id list can stand in for.
 */
export interface ProviderKeyAccess {
  usableKeyCount: number
  serveAll: boolean
  selectedModelIds: ReadonlySet<string>
}

/**
 * Which free models each provider's usable keys are scoped to serve, keyed by
 * platform. A key counts as usable on the same terms the router and
 * `/api/fallback`'s `keyCount` use: enabled, and healthy or unchecked. An
 * invalid key grants no access, so it contributes no selection.
 */
export function providerKeyAccess(
  keys: readonly ApiKey[],
): Map<string, ProviderKeyAccess> {
  const access = new Map<string, ProviderKeyAccess>()
  for (const key of keys) {
    if (!key.enabled || (key.status !== 'healthy' && key.status !== 'unknown')) continue
    const existing = access.get(key.platform)
    const entry = existing ?? { usableKeyCount: 0, serveAll: false, selectedModelIds: new Set<string>() }
    entry.usableKeyCount += 1
    // A NULL/absent scope serves everything; several keys union their scopes.
    if (key.modelScope == null || key.modelScope.length === 0) entry.serveAll = true
    else for (const modelId of key.modelScope) (entry.selectedModelIds as Set<string>).add(modelId)
    if (!existing) access.set(key.platform, entry)
  }
  return access
}

/**
 * Group the free catalogue by provider for the catalogue-wide copy actions,
 * from the same `['fallback']` list the dialog already holds.
 *
 * `custom` rows and per-key relay rows are dropped: a relay endpoint serves
 * whatever its operator points it at, so the curated free catalogue cannot
 * vouch for it being free.
 *
 * `selected` keeps only the models a usable key is scoped to serve, and drops
 * providers left with none — that is the list of free models this install can
 * actually reach. `all` keeps every offered model and every provider.
 *
 * Row order is the server's (fallback priority); providers come out in first
 * appearance order for the same reason `scopeCandidates` keeps it: the export
 * should read like the Models table, not invent a ranking. Duplicate model ids
 * within one provider collapse to their first occurrence.
 *
 * Credential-blind by construction: only catalogue facts are copied out, never
 * `keyId`, `keyLabel`, `maskedKey` or `modelDbId`.
 */
export function freeCatalogProviders(
  entries: readonly FallbackEntry[],
  scope: FreeCatalogScope,
  providerName: (platform: string) => string,
  access: ReadonlyMap<string, ProviderKeyAccess>,
): FreeCatalogExportProvider[] {
  const providers = new Map<string, FreeCatalogExportProvider>()
  const seen = new Set<string>()
  for (const entry of entries) {
    if (!entry.platform || entry.platform === 'custom' || entry.source === 'custom') continue
    if (!entry.modelId) continue
    const identity = `${entry.platform}\u0000${entry.modelId}`
    if (seen.has(identity)) continue
    seen.add(identity)
    const keyAccess = access.get(entry.platform)
    const accessEnabled = Boolean(keyAccess) && (keyAccess!.serveAll || keyAccess!.selectedModelIds.has(entry.modelId))
    let provider = providers.get(entry.platform)
    if (!provider) {
      provider = {
        providerName: providerName(entry.platform),
        platform: entry.platform,
        usableKeyCount: keyAccess?.usableKeyCount ?? 0,
        offeredModelCount: 0,
        models: [],
      }
      providers.set(entry.platform, provider)
    }
    provider.offeredModelCount += 1
    if (scope === 'selected' && !accessEnabled) continue
    provider.models.push({
      displayName: entry.displayName || entry.modelId,
      modelId: entry.modelId,
      accessEnabled,
      routingEnabled: entry.enabled,
      retiredUpstream: entry.retiredUpstream ?? false,
      sizeLabel: entry.sizeLabel || null,
      contextWindow: entry.contextWindow ?? null,
      supportsVision: entry.supportsVision ?? null,
      supportsTools: entry.supportsTools ?? null,
      monthlyAllowance: entry.monthlyTokenBudget || null,
      limits: {
        rpmLimit: entry.rpmLimit ?? null,
        rpdLimit: entry.rpdLimit ?? null,
        tpmLimit: entry.tpmLimit ?? null,
        tpdLimit: entry.tpdLimit ?? null,
      },
    })
  }
  return [...providers.values()].filter(provider => scope === 'all' || provider.models.length > 0)
}

/** Whether a just-added key on this platform is worth interrupting for. */
export function shouldOfferModelPicker(candidates: readonly ScopeCandidate[]): boolean {
  return candidates.length >= MODEL_PICKER_MIN_MODELS
}

/**
 * What confirming the picker should do.
 *
 * `patch: false` means "send nothing at all" — either every model is ticked
 * (the key already serves everything, and leaving the scope NULL keeps future
 * catalog additions flowing through it) or nothing is ticked (not expressible;
 * the caller disables Confirm, and this is the belt-and-braces half).
 */
export type ScopeUpdate =
  | { patch: false; reason: 'all' | 'empty' }
  | { patch: true; modelScope: string[] }

export function resolveScopeUpdate(
  allIds: readonly string[],
  selected: ReadonlySet<string>,
): ScopeUpdate {
  // Driven by `allIds`, not by the set: a tick left over from an id that is no
  // longer on offer must not end up in the saved scope, and must not inflate
  // the count that decides "is this everything?".
  const chosen = allIds.filter(id => selected.has(id))
  if (chosen.length === 0) return { patch: false, reason: 'empty' }
  if (chosen.length === allIds.length) return { patch: false, reason: 'all' }
  return { patch: true, modelScope: chosen }
}
