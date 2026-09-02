import { useCallback, useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { apiFetch } from '@/lib/api'
import { Button } from '@/components/ui/button'
import { Dialog, DialogPopup, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { useI18n } from '@/i18n'
import { X } from 'lucide-react'
import type { ApiKey, QuotaGuidanceCatalog, QuotaGuidanceLimits } from '../../../../shared/types'
import type { FallbackEntry } from '@/lib/routing'
import {
  orderScopeCandidates,
  scopeCandidates,
  type ScopeCandidate,
} from '@/lib/model-scope-selection'
import {
  formatProviderModelDetails,
  type FreeCatalogScope,
} from '@/lib/provider-model-details-export'
import { QuotaGuidancePanel } from './quota-guidance-panel'
import { ProviderModelDetailsCopyAction } from './provider-model-details-copy-action'

type ModelLimitDraft = Record<keyof QuotaGuidanceLimits, string>

const SCOPE_HIDE_DISABLED_KEY = 'imperium.modelScope.hideDisabled'

function toDraft(limits: QuotaGuidanceLimits): ModelLimitDraft {
  return {
    rpmLimit: limits.rpmLimit?.toString() ?? '',
    rpdLimit: limits.rpdLimit?.toString() ?? '',
    tpmLimit: limits.tpmLimit?.toString() ?? '',
    tpdLimit: limits.tpdLimit?.toString() ?? '',
  }
}

function parsedLimit(value: string): number | null {
  return value === '' ? null : Number(value)
}

// #657: relay stations hand out keys that only serve one model group; a key
// scoped here is skipped by the router for every model outside its list. A
// deliberately light editor: a chip list plus a free-text id field. Suggestions
// come only from data the key row already carries (a custom endpoint's
// registered models) — no extra fetching for catalog platforms.
export function ModelScopeDialog({
  apiKey,
  onOpenChange,
}: {
  apiKey: ApiKey
  onOpenChange: (open: boolean) => void
}) {
  const { t } = useI18n()
  const queryClient = useQueryClient()
  // Mounted only while open, so state seeds from the row without reset effects.
  const [ids, setIds] = useState<string[]>(apiKey.modelScope ?? [])
  const [catalogTouched, setCatalogTouched] = useState(false)
  const [draft, setDraft] = useState('')
  const [providerRpmLimit, setProviderRpmLimit] = useState(apiKey.providerRpmLimit?.toString() ?? '')
  const [providerRpdLimit, setProviderRpdLimit] = useState(apiKey.providerRpdLimit?.toString() ?? '')
  const [providerTpdLimit, setProviderTpdLimit] = useState(apiKey.providerTpdLimit?.toString() ?? '')
  const [modelLimitDrafts, setModelLimitDrafts] = useState<Record<number, ModelLimitDraft>>({})
  const [selectedModelId, setSelectedModelId] = useState<string | null>(null)
  // Most of a big provider catalogue is models the operator will never tick, and
  // a retired or switched-off one cannot serve traffic at all, so they start out
  // of the way. Remembered per browser, like the FreeLLM tab's own toggle.
  const [hideDisabled, setHideDisabled] = useState(() => {
    try {
      return localStorage.getItem(SCOPE_HIDE_DISABLED_KEY) !== '0'
    } catch {
      return true
    }
  })

  const { data: fallback = [], isLoading: catalogLoading, isError: catalogError } = useQuery<FallbackEntry[]>({
    queryKey: ['fallback'],
    queryFn: () => apiFetch('/api/fallback'),
    enabled: apiKey.platform !== 'custom',
  })
  const catalogCandidates = useMemo(
    () => scopeCandidates(fallback, apiKey.platform),
    [fallback, apiKey.platform],
  )
  const providerModelRows = useMemo(() => {
    const seen = new Set<string>()
    return fallback.filter(row => row.platform === apiKey.platform && !seen.has(row.modelId) && seen.add(row.modelId))
  }, [fallback, apiKey.platform])
  const { data: quotaCatalog } = useQuery<QuotaGuidanceCatalog>({
    queryKey: ['keys', 'quota-guidance'],
    queryFn: () => apiFetch('/api/keys/quota-guidance'),
    enabled: apiKey.platform !== 'custom',
  })
  const quotaGuidance = quotaCatalog?.providers.find(provider => provider.platform === apiKey.platform)
  const selectedModelGuidance = quotaGuidance?.models.find(model => model.modelId === selectedModelId) ?? null
  const liveCandidates = useMemo<ScopeCandidate[]>(() => {
    if (apiKey.platform === 'custom' || catalogCandidates.length > 0) return []
    const seen = new Set<string>()
    return (apiKey.models ?? [])
      .filter(model => model.kind === 'chat' && model.modelId && !seen.has(model.modelId) && seen.add(model.modelId))
      .map(model => ({
        modelId: model.modelId,
        displayName: model.displayName || model.modelId,
        // Live discovery carries no catalogue tier or rank, so these rows sort
        // after every ranked one rather than claiming a capability they have
        // not been measured for.
        sizeLabel: null,
        contextWindow: null,
        intelligenceRank: Number.MAX_SAFE_INTEGER,
      }))
  }, [apiKey.models, apiKey.platform, catalogCandidates.length])
  // The curated FreeLLMAPI catalogue is authoritative. Live discovery is used
  // only when this provider has no catalogue rows at all (for example a newly
  // added SambaNova-compatible endpoint).
  const providerCandidates = catalogCandidates.length > 0 ? catalogCandidates : liveCandidates
  const exportCandidates = useMemo(() => {
    if (apiKey.platform !== 'custom') return providerCandidates
    const seen = new Set<string>()
    return [
      ...(apiKey.models ?? [])
        .filter(model => model.kind === 'chat')
        .map(model => ({ modelId: model.modelId, displayName: model.displayName || model.modelId })),
      ...ids.map(modelId => ({ modelId, displayName: modelId })),
    ].filter(model => model.modelId && !seen.has(model.modelId) && seen.add(model.modelId))
  }, [apiKey.models, apiKey.platform, ids, providerCandidates])
  const catalogIds = providerCandidates.map(candidate => candidate.modelId)
  const catalogReady = apiKey.platform === 'custom' || (!catalogLoading && !catalogError)
  const selectedCatalogIds = !catalogTouched && (apiKey.modelScope === null || apiKey.modelScope === undefined)
    ? catalogIds
    : catalogIds.filter(id => ids.includes(id))

  // The tick state as it stood when the dialog opened. Both the order and the
  // hide filter read this, not the live selection: re-sorting or vanishing a row
  // as its own box is clicked would move the target out from under the pointer.
  // An unscoped key serves everything, so every model counts as enabled there.
  const [enabledAtOpen] = useState(() => {
    const scope = apiKey.modelScope
    return scope == null ? null : new Set(scope)
  })
  const wasEnabled = useCallback(
    (modelId: string) => enabledAtOpen === null || enabledAtOpen.has(modelId),
    [enabledAtOpen],
  )
  const orderedCandidates = useMemo(
    () => orderScopeCandidates(providerCandidates, wasEnabled),
    [providerCandidates, wasEnabled],
  )
  // Display-only: the saved scope is computed from `catalogIds`, so a hidden row
  // keeps whatever it had. Only models that were already off when the dialog
  // opened are hidden, which is why unticking one never makes it disappear.
  const visibleCandidates = hideDisabled
    ? orderedCandidates.filter(candidate => wasEnabled(candidate.modelId))
    : orderedCandidates
  const hiddenDisabledCount = orderedCandidates.length - visibleCandidates.length

  // Built on demand per scope inside the copy click, so unsaved limit edits in
  // this dialog are included at copy time.
  const exportModels = exportCandidates.map(model => {
    const row = providerModelRows.find(candidate => candidate.modelId === model.modelId)
    const limitDraft = row
      ? modelLimitDrafts[row.modelDbId] ?? toDraft({
        rpmLimit: row.rpmLimit,
        rpdLimit: row.rpdLimit,
        tpmLimit: row.tpmLimit ?? null,
        tpdLimit: row.tpdLimit ?? null,
      })
      : null
    return {
      displayName: model.displayName,
      modelId: model.modelId,
      accessEnabled: apiKey.platform === 'custom'
        ? (ids.length === 0 || ids.includes(model.modelId))
        : selectedCatalogIds.includes(model.modelId),
      routingEnabled: row?.enabled ?? apiKey.enabled,
      sizeLabel: row?.sizeLabel || null,
      contextWindow: row?.contextWindow ?? null,
      supportsVision: row?.supportsVision ?? null,
      supportsTools: row?.supportsTools ?? null,
      monthlyAllowance: row?.monthlyTokenBudget || null,
      limits: limitDraft ? {
        rpmLimit: parsedLimit(limitDraft.rpmLimit),
        rpdLimit: parsedLimit(limitDraft.rpdLimit),
        tpmLimit: parsedLimit(limitDraft.tpmLimit),
        tpdLimit: parsedLimit(limitDraft.tpdLimit),
      } : { rpmLimit: null, rpdLimit: null, tpmLimit: null, tpdLimit: null },
    }
  })

  const buildProviderDetailsText = (scope: FreeCatalogScope) => formatProviderModelDetails({
    providerName: quotaGuidance?.displayName ?? (apiKey.platform === 'custom' ? 'Custom provider' : apiKey.platform),
    platform: apiKey.platform,
    modelSource: catalogCandidates.length > 0 ? 'catalog' : 'live_discovery',
    scope,
    offeredModelCount: exportModels.length,
    accountLimits: {
      rpmLimit: parsedLimit(providerRpmLimit),
      rpdLimit: parsedLimit(providerRpdLimit),
      tpmLimit: null,
      tpdLimit: parsedLimit(providerTpdLimit),
    },
    guidance: quotaGuidance ?? null,
    models: scope === 'selected' ? exportModels.filter(model => model.accessEnabled) : exportModels,
  })

  const suggestions = (apiKey.models ?? [])
    .filter(m => m.kind === 'chat' && !ids.includes(m.modelId))
    .map(m => m.modelId)

  const save = useMutation({
    mutationFn: (payload: Record<string, unknown>) =>
      apiFetch(`/api/keys/${apiKey.id}`, { method: 'PATCH', body: JSON.stringify(payload) }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['keys'] })
      queryClient.invalidateQueries({ queryKey: ['fallback'] })
      queryClient.invalidateQueries({ queryKey: ['models'] })
      onOpenChange(false)
    },
  })

  const add = (raw: string) => {
    const id = raw.trim()
    if (!id) return
    setIds(prev => (prev.includes(id) ? prev : [...prev, id]))
    setDraft('')
  }

  const submit = () => {
    if (!catalogReady) return
    // A typed-but-unconfirmed id still counts — losing it on Save is the
    // classic chip-input paper cut.
    const pending = draft.trim()
    const next = pending && !ids.includes(pending) ? [...ids, pending] : ids
    const modelScope = apiKey.platform === 'custom'
      ? (next.length > 0 ? next : null)
      : (selectedCatalogIds.length === catalogIds.length ? null : selectedCatalogIds)
    const changedModelLimits = providerModelRows.flatMap(model => {
      const draft = modelLimitDrafts[model.modelDbId] ?? toDraft({
        rpmLimit: model.rpmLimit,
        rpdLimit: model.rpdLimit,
        tpmLimit: model.tpmLimit ?? null,
        tpdLimit: model.tpdLimit ?? null,
      })
      const next = {
        rpmLimit: parsedLimit(draft.rpmLimit),
        rpdLimit: parsedLimit(draft.rpdLimit),
        tpmLimit: parsedLimit(draft.tpmLimit),
        tpdLimit: parsedLimit(draft.tpdLimit),
      }
      if (next.rpmLimit === model.rpmLimit && next.rpdLimit === model.rpdLimit
        && next.tpmLimit === (model.tpmLimit ?? null) && next.tpdLimit === (model.tpdLimit ?? null)) return []
      return [{ modelDbId: model.modelDbId, ...next }]
    })
    save.mutate({
      modelScope,
      providerRpmLimit: providerRpmLimit === '' ? null : Number(providerRpmLimit),
      providerRpdLimit: providerRpdLimit === '' ? null : Number(providerRpdLimit),
      providerTpdLimit: providerTpdLimit === '' ? null : Number(providerTpdLimit),
      ...(changedModelLimits.length > 0 ? { modelLimits: changedModelLimits } : {}),
    })
  }

  const toggleCatalogModel = (modelId: string) => {
    const selected = new Set(selectedCatalogIds)
    if (selected.has(modelId)) selected.delete(modelId)
    else selected.add(modelId)
    setCatalogTouched(true)
    setIds([...selected])
  }

  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogPopup maxWidth="max-w-6xl">
        <div className="flex items-center justify-between gap-3">
          <DialogTitle>{t('keys.modelScope')}</DialogTitle>
          <ProviderModelDetailsCopyAction
            buildText={buildProviderDetailsText}
            disabled={!catalogReady || exportCandidates.length === 0}
          />
        </div>
        <p className="mt-1 text-xs text-muted-foreground">{t('keys.modelScopeDesc')}</p>
        <code className="mt-2 block truncate font-mono text-[11px] text-muted-foreground">{apiKey.maskedKey}</code>

        <div className="mt-4 grid gap-4 lg:grid-cols-[minmax(0,3fr)_minmax(300px,2fr)]">
          <div className="space-y-3">
          {apiKey.platform !== 'custom' && catalogLoading ? (
            <p className="text-xs text-muted-foreground">{t('auth.loading')}</p>
          ) : apiKey.platform !== 'custom' && catalogError ? (
            <p className="text-xs text-destructive">{t('keys.catalogLoadFailed')}</p>
          ) : apiKey.platform !== 'custom' && providerCandidates.length > 0 ? (
            <>
            {catalogCandidates.length === 0 && (
              <p className="text-[11px] text-muted-foreground">{t('keys.liveModelsFallback')}</p>
            )}
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="text-[11px] text-muted-foreground">Model limits below apply to all keys for this provider. Account limits remain specific to this key.</p>
              <label className="flex items-center gap-1.5 whitespace-nowrap text-[11px] text-muted-foreground">
                <input
                  type="checkbox"
                  checked={hideDisabled}
                  onChange={event => {
                    setHideDisabled(event.target.checked)
                    try { localStorage.setItem(SCOPE_HIDE_DISABLED_KEY, event.target.checked ? '1' : '0') } catch { /* ignore */ }
                  }}
                  className="size-3.5 accent-primary"
                />
                Hide disabled models
                {hideDisabled && hiddenDisabledCount > 0 && <span>({hiddenDisabledCount})</span>}
              </label>
            </div>
            <div className="max-h-[50vh] overflow-y-auto rounded-2xl border divide-y">
              {visibleCandidates.map(model => (
                <div key={model.modelId} className={`px-3 py-2 text-xs ${selectedModelId === model.modelId ? 'bg-muted/40' : 'hover:bg-muted/20'}`}>
                  <div className="flex items-center gap-2">
                    <input
                      type="checkbox"
                      checked={selectedCatalogIds.includes(model.modelId)}
                      onChange={() => toggleCatalogModel(model.modelId)}
                      className="size-4 accent-primary"
                      aria-label={`Enable ${model.displayName}`}
                    />
                    <button type="button" onClick={() => setSelectedModelId(model.modelId)} className="min-w-0 flex-1 text-left">
                      <span className="block truncate font-medium" title={model.modelId}>{model.displayName}</span>
                      <code className="block truncate text-[10px] text-muted-foreground">{model.modelId}</code>
                    </button>
                  </div>
                  {(() => {
                    const row = providerModelRows.find(candidate => candidate.modelId === model.modelId)
                    if (!row) return null
                    const draft = modelLimitDrafts[row.modelDbId] ?? toDraft({
                      rpmLimit: row.rpmLimit,
                      rpdLimit: row.rpdLimit,
                      tpmLimit: row.tpmLimit ?? null,
                      tpdLimit: row.tpdLimit ?? null,
                    })
                    return (
                      <div className="mt-2 grid grid-cols-4 gap-1.5 pl-6">
                        {(['rpmLimit', 'rpdLimit', 'tpmLimit', 'tpdLimit'] as const).map(field => (
                          <label key={field} className="text-[9px] uppercase tracking-wide text-muted-foreground">
                            {field.replace('Limit', '').toUpperCase()}
                            <Input
                              type="number"
                              min="1"
                              step="1"
                              value={draft[field]}
                              onFocus={() => setSelectedModelId(model.modelId)}
                              onChange={event => setModelLimitDrafts(previous => ({
                                ...previous,
                                [row.modelDbId]: { ...draft, [field]: event.target.value },
                              }))}
                              className="mt-1 h-7 px-1.5 text-[10px]"
                            />
                          </label>
                        ))}
                      </div>
                    )
                  })()}
                </div>
              ))}
            </div>
            </>
          ) : ids.length === 0 ? (
            <p className="text-xs text-muted-foreground">{t('keys.modelScopeEmpty')}</p>
          ) : (
            <div className="flex flex-wrap gap-1.5">
              {ids.map(id => (
                <span key={id} className="inline-flex min-w-0 items-center gap-1 rounded-md border bg-muted/40 px-2 py-0.5 font-mono text-[11px]">
                  <span className="max-w-[240px] truncate" title={id}>{id}</span>
                  <button
                    type="button"
                    onClick={() => setIds(prev => prev.filter(x => x !== id))}
                    aria-label={t('common.remove')}
                    className="text-muted-foreground hover:text-destructive"
                  >
                    <X className="size-3" />
                  </button>
                </span>
              ))}
            </div>
          )}

          {apiKey.platform === 'custom' && <Input
            value={draft}
            onChange={e => setDraft(e.target.value)}
            onKeyDown={e => {
              if (e.key === 'Enter') {
                e.preventDefault()
                add(draft)
              }
            }}
            placeholder={t('keys.modelScopeAdd')}
            className="h-8 font-mono text-xs"
          />}

          {apiKey.platform === 'custom' && suggestions.length > 0 && (
            <div className="flex flex-wrap gap-1.5">
              {suggestions.map(id => (
                <button
                  key={id}
                  type="button"
                  onClick={() => add(id)}
                  className="max-w-[240px] truncate rounded-md border border-dashed px-2 py-0.5 font-mono text-[11px] text-muted-foreground hover:text-foreground"
                  title={id}
                >
                  + {id}
                </button>
              ))}
            </div>
          )}

          <div className="rounded-xl border p-3">
            <p className="text-xs font-medium">{t('keys.providerAccountLimits')}</p>
            <p className="mt-0.5 text-[11px] text-muted-foreground">{t('keys.providerAccountLimitsHint')}</p>
            <div className="mt-3 grid grid-cols-3 gap-2">
              {[
                ['RPM', providerRpmLimit, setProviderRpmLimit],
                ['RPD', providerRpdLimit, setProviderRpdLimit],
                ['TPD', providerTpdLimit, setProviderTpdLimit],
              ].map(([label, value, setter]) => (
                <label key={label as string} className="text-[11px] text-muted-foreground">
                  {label as string}
                  <Input type="number" min="0" step="1" value={value as string} onChange={event => (setter as (value: string) => void)(event.target.value)} className="mt-1 h-8 text-xs" />
                </label>
              ))}
            </div>
          </div>

          {save.isError && (
            <p className="text-xs text-destructive">{(save.error as Error).message}</p>
          )}

          <div className="flex items-center justify-end gap-2 pt-1">
            {(apiKey.modelScope?.length ?? 0) > 0 && (
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="mr-auto"
                onClick={() => save.mutate({ modelScope: null })}
                disabled={save.isPending}
              >
                {t('keys.modelScopeClear')}
              </Button>
            )}
            <Button type="button" variant="outline" size="sm" onClick={() => onOpenChange(false)}>
              {t('common.cancel')}
            </Button>
            <Button type="button" size="sm" onClick={submit} disabled={save.isPending || !catalogReady || (apiKey.platform !== 'custom' && catalogIds.length > 0 && selectedCatalogIds.length === 0)}>
              {save.isPending ? t('common.saving') : t('common.save')}
            </Button>
          </div>
          </div>

          <div>
            {quotaGuidance ? (
              <QuotaGuidancePanel
                guidance={quotaGuidance}
                modelGuidance={selectedModelGuidance}
                selectedModelId={selectedModelId}
                onUseLimits={limits => {
                  setProviderRpmLimit(limits.rpmLimit?.toString() ?? '')
                  setProviderRpdLimit(limits.rpdLimit?.toString() ?? '')
                  setProviderTpdLimit(limits.tpdLimit?.toString() ?? '')
                }}
                onUseModelLimits={limits => {
                  const row = providerModelRows.find(model => model.modelId === selectedModelId)
                  if (!row) return
                  setModelLimitDrafts(previous => ({ ...previous, [row.modelDbId]: toDraft(limits) }))
                }}
              />
            ) : apiKey.platform !== 'custom' ? (
              <div className="rounded-2xl border border-dashed p-4 text-xs text-muted-foreground">
                Quota guidance not researched for this provider.
              </div>
            ) : null}
          </div>
        </div>
      </DialogPopup>
    </Dialog>
  )
}
