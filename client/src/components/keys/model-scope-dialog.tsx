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
interface MeasuredProbe {
  modelId: string
  measuredRpm: number | null
  measuredRpd: number | null
  catalogueRpm: number | null
  catalogueRpd: number | null
  finding: string
}

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
  const [modelQuery, setModelQuery] = useState('')
  const [draft, setDraft] = useState('')
  const [providerRpmLimit, setProviderRpmLimit] = useState(apiKey.providerRpmLimit?.toString() ?? '')
  const [providerRpdLimit, setProviderRpdLimit] = useState(apiKey.providerRpdLimit?.toString() ?? '')
  const [providerTpdLimit, setProviderTpdLimit] = useState(apiKey.providerTpdLimit?.toString() ?? '')
  // A monthly credit allowance ("$10 of usage, resets on the 1st"), declared
  // in the quota ledger like every other operator limit. Null until edited, so
  // the saved policy shows through until the operator changes something.
  const [allowanceDraft, setAllowanceDraft] = useState<{ amount: string; day: string; timezone: string } | null>(null)
  const [modelLimitDrafts, setModelLimitDrafts] = useState<Record<number, ModelLimitDraft>>({})
  const [selectedModelId, setSelectedModelId] = useState<string | null>(null)
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
  // Why this second query exists: /api/fallback is the candidate source and it
  // returns only catalogue-ENABLED models, so a provider whose models are all
  // switched off sends zero rows and the dialog cannot tell "no models" from
  // "all switched off". Found on b.ai after its promo ended. Count only — the
  // rows are not rendered from here.
  const { data: allCatalogue = [] } = useQuery<{ platform: string }[]>({
    queryKey: ['models', 'catalogue-count'],
    queryFn: () => apiFetch('/api/models'),
    enabled: apiKey.platform !== 'custom',
    staleTime: 60_000,
  })
  const catalogueRowsForProvider = allCatalogue.filter(m => m.platform === apiKey.platform).length
  const { data: quotaCatalog } = useQuery<QuotaGuidanceCatalog>({
    queryKey: ['keys', 'quota-guidance'],
    queryFn: () => apiFetch('/api/keys/quota-guidance'),
    enabled: apiKey.platform !== 'custom',
  })

  const { data: probeData } = useQuery<{ probes: MeasuredProbe[] }>({
    queryKey: ['quota', 'probes', apiKey.platform],
    queryFn: () => apiFetch(`/api/quota/probes?platform=${encodeURIComponent(apiKey.platform)}`),
  })
  // Each half of a limit is usually found by a different run: a burst finds the
  // per-minute ceiling, a paced walk the daily one.
  const measured = useMemo(() => {
    const byModel = new Map<string, { rpm: number | null; rpd: number | null; wasRpm: number | null; wasRpd: number | null; finding: string }>()
    for (const p of probeData?.probes ?? []) {
      const seen = byModel.get(p.modelId)
      if (!seen) {
        byModel.set(p.modelId, {
          rpm: p.measuredRpm, rpd: p.measuredRpd,
          wasRpm: p.catalogueRpm, wasRpd: p.catalogueRpd, finding: p.finding,
        })
        continue
      }
      if (seen.rpm == null && p.measuredRpm != null) { seen.rpm = p.measuredRpm; seen.wasRpm = p.catalogueRpm }
      if (seen.rpd == null && p.measuredRpd != null) { seen.rpd = p.measuredRpd; seen.wasRpd = p.catalogueRpd }
    }
    return byModel
  }, [probeData?.probes])

  const selectedMeasured = useMemo(() => {
    if (!selectedModelId) return null
    const m = measured.get(selectedModelId)
    return m ? { rpm: m.rpm, rpd: m.rpd, finding: m.finding, ranAt: '' } : null
  }, [measured, selectedModelId])
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
  // Read-only here for catalogue providers: which models a key serves is edited
  // on the Keys provider panel's per-model switch, the one scope editor with no
  // bulk wipe. This dialog only shows it, to order rows and mark what is served.
  const selectedCatalogIds = apiKey.modelScope == null ? catalogIds : catalogIds.filter(id => ids.includes(id))

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
  // Search narrows the list. Matching the id as well as the name because a provider's display names
  // are often near-identical while the ids are what `modelScope` stores.
  const modelQueryText = modelQuery.trim().toLowerCase()
  const shownCandidates = modelQueryText
    ? orderedCandidates.filter(candidate =>
      candidate.modelId.toLowerCase().includes(modelQueryText)
      || candidate.displayName.toLowerCase().includes(modelQueryText))
    : orderedCandidates

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

  const { data: policyData } = useQuery<{ policies: CreditPolicy[] }>({
    queryKey: ['quota', 'policies', apiKey.platform],
    queryFn: () => apiFetch(`/api/quota/policies?platform=${encodeURIComponent(apiKey.platform)}`),
    enabled: apiKey.platform !== 'custom',
  })
  const allowancePolicy = policyData?.policies.find(p =>
    p.scope === 'provider_account' && p.metric === 'credits' && (p.periodKind === 'calendar_month' || p.periodKind === 'billing_cycle'))
  const allowance = allowanceDraft ?? {
    amount: allowancePolicy ? String(allowancePolicy.unit === 'usd_cents' ? allowancePolicy.limit / 100 : allowancePolicy.limit) : '',
    day: String(allowancePolicy?.periodKind === 'billing_cycle' ? allowancePolicy.anchorDay ?? 1 : 1),
    timezone: allowancePolicy?.timezone ?? 'UTC',
  }
  const allowanceDay = Math.min(31, Math.max(1, Math.trunc(Number(allowance.day) || 1)))
  const allowanceAmount = Number(allowance.amount)
  const allowanceInvalid = allowance.amount.trim() !== '' && !(allowanceAmount > 0)

  const saveAllowance = async () => {
    if (!allowanceDraft) return
    const clearing = allowance.amount.trim() === ''
    const periodKind = allowanceDay === 1 ? 'calendar_month' : 'billing_cycle'
    // The ledger keys a policy by its period kind too, so moving between "the
    // 1st" and another day must replace the old row rather than sit beside it.
    if (allowancePolicy && (clearing || allowancePolicy.periodKind !== periodKind)) {
      await apiFetch(`/api/quota/policies/${allowancePolicy.id}`, { method: 'DELETE' })
    }
    if (clearing) return
    await apiFetch('/api/quota/policies', {
      method: 'PUT',
      body: JSON.stringify({
        platform: apiKey.platform, modelId: null, endpointScope: null, scope: 'provider_account', metric: 'credits',
        limit: Math.round(allowanceAmount * 100), unit: 'usd_cents', periodKind,
        anchorDay: periodKind === 'billing_cycle' ? allowanceDay : null,
        timezone: allowance.timezone.trim() || 'UTC', notes: 'Monthly credit allowance (USD)',
      }),
    })
  }

  const save = useMutation({
    mutationFn: async (payload: Record<string, unknown>) => {
      await apiFetch(`/api/keys/${apiKey.id}`, { method: 'PATCH', body: JSON.stringify(payload) })
      await saveAllowance()
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['quota'] })
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
    // Custom endpoints have no catalogue rows for the Keys panel to switch, so
    // their chip list stays the scope editor. Catalogue providers send no
    // scope at all: an absent field leaves the saved scope untouched.
    const scopePatch = apiKey.platform === 'custom' ? { modelScope: next.length > 0 ? next : null } : {}
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
      ...scopePatch,
      providerRpmLimit: providerRpmLimit === '' ? null : Number(providerRpmLimit),
      providerRpdLimit: providerRpdLimit === '' ? null : Number(providerRpdLimit),
      providerTpdLimit: providerTpdLimit === '' ? null : Number(providerTpdLimit),
      ...(changedModelLimits.length > 0 ? { modelLimits: changedModelLimits } : {}),
    })
  }

  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogPopup maxWidth="max-w-6xl">
        <div className="flex items-center justify-between gap-3">
          <DialogTitle>{t('keys.modelLimitsTitle')}</DialogTitle>
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
              <p className="text-[11px] text-muted-foreground">{t('keys.scopeEditedOnPanel')}</p>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <Input
                type="search"
                value={modelQuery}
                onChange={event => setModelQuery(event.target.value)}
                placeholder="Search models by name or id…"
                aria-label="Search models"
                className="h-7 min-w-[200px] flex-1 text-xs"
                spellCheck={false}
              />
            </div>
            <div className="max-h-[50vh] overflow-y-auto rounded-2xl border divide-y">
              {shownCandidates.length === 0 && (
                /* Three different reasons produce an empty list, and saying
                   "no match" for all of them is what made a correctly-filtered
                   provider read as a broken panel: b.ai holds two models, both
                   switched off when its promo ended, so the default
                   hide-disabled filter removed every row and the dialog said
                   nothing at all. */
                <div className="px-3 py-4 text-xs text-muted-foreground">
                  {orderedCandidates.length === 0
                    ? (catalogueRowsForProvider > 0
                      ? t('keys.scopeEmptyCatalogueOff', { count: catalogueRowsForProvider })
                      : t('keys.scopeEmptyNoModels'))
                    : t('keys.scopeEmptyNoMatch')}
                </div>
              )}
              {shownCandidates.map(model => (
                <div key={model.modelId} className={`px-3 py-2 text-xs ${selectedModelId === model.modelId ? 'bg-muted/40' : 'hover:bg-muted/20'}`}>
                  <div className="flex items-center gap-2">
                    <button type="button" onClick={() => setSelectedModelId(model.modelId)} className="min-w-0 flex-1 text-left">
                      <span className="block truncate font-medium" title={model.modelId}>{model.displayName}</span>
                      <code className="block truncate text-[10px] text-muted-foreground">{model.modelId}</code>
                    </button>
                    {!selectedCatalogIds.includes(model.modelId) && (
                      <span className="shrink-0 text-[10px] text-muted-foreground">{t('keys.scopeNotServed')}</span>
                    )}
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
                    const m = measured.get(model.modelId)
                    const differs = m && ((m.rpm != null && String(m.rpm) !== draft.rpmLimit)
                      || (m.rpd != null && String(m.rpd) !== draft.rpdLimit))
                    return (
                      <>
                      {m && (m.rpm != null || m.rpd != null) && (
                        <div className="mt-1.5 flex flex-wrap items-center gap-1.5 text-[10px] text-muted-foreground">
                          <span title={m.finding}>
                            {t('keys.limitsMeasured', {
                              measured: [
                                m.rpm == null ? null : m.wasRpm != null && m.wasRpm !== m.rpm ? `${m.wasRpm}→${m.rpm}/min` : `${m.rpm}/min`,
                                m.rpd == null ? null : m.wasRpd != null && m.wasRpd !== m.rpd ? `${m.wasRpd}→${m.rpd}/day` : `${m.rpd}/day`,
                              ].filter(Boolean).join(' · '),
                            })}
                          </span>
                          {differs && (
                            <button
                              type="button"
                              onClick={() => setModelLimitDrafts(previous => ({
                                ...previous,
                                [row.modelDbId]: {
                                  ...draft,
                                  rpmLimit: m.rpm == null ? draft.rpmLimit : String(m.rpm),
                                  rpdLimit: m.rpd == null ? draft.rpdLimit : String(m.rpd),
                                },
                              }))}
                              className="rounded-full border px-1.5 py-0.5 text-[9px] hover:bg-muted"
                            >
                              {t('keys.limitsUseMeasured')}
                            </button>
                          )}
                        </div>
                      )}
                      <div className="mt-2 grid grid-cols-4 gap-1.5">
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
                      </>
                    )
                  })()}
                </div>
              ))}
            </div>
            </>
          ) : ids.length === 0 ? (
            <div className="space-y-1">
              <p className="text-xs text-muted-foreground">{t('keys.modelScopeEmpty')}</p>
              {/* This is the branch a RETIRED provider lands in, and it used to
                  stop at "no scope set" — true, but silent about why there is
                  nothing to choose from. /api/fallback selects
                  `WHERE m.enabled = 1`, so a provider whose catalogue rows are
                  all switched off sends zero candidates and the picker never
                  renders at all. b.ai: two models, both off since its promo
                  ended, and a dialog that looked broken. */}
              {apiKey.platform !== 'custom' && providerCandidates.length === 0 && catalogueRowsForProvider > 0 && (
                <p className="text-[11px] text-muted-foreground">
                  {t('keys.scopeEmptyCatalogueOff', { count: catalogueRowsForProvider })}
                </p>
              )}
            </div>
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

          {apiKey.platform !== 'custom' && (
            <div className="rounded-xl border p-3">
              <p className="text-xs font-medium">{t('keys.creditAllowance')}</p>
              <p className="mt-0.5 text-[11px] text-muted-foreground">{t('keys.creditAllowanceHint')}</p>
              <div className="mt-3 grid grid-cols-3 gap-2">
                <label className="text-[11px] text-muted-foreground">
                  {t('keys.creditAllowanceAmount')}
                  <Input type="number" min="0" step="0.01" placeholder="10.00" value={allowance.amount}
                    onChange={e => setAllowanceDraft({ ...allowance, amount: e.target.value })} className="mt-1 h-8 text-xs" />
                </label>
                <label className="text-[11px] text-muted-foreground">
                  {t('keys.creditAllowanceDay')}
                  <Input type="number" min="1" max="31" step="1" value={allowance.day}
                    onChange={e => setAllowanceDraft({ ...allowance, day: e.target.value })} className="mt-1 h-8 text-xs" />
                </label>
                <label className="text-[11px] text-muted-foreground">
                  {t('keys.creditAllowanceTimezone')}
                  <Input value={allowance.timezone} spellCheck={false}
                    onChange={e => setAllowanceDraft({ ...allowance, timezone: e.target.value })} className="mt-1 h-8 text-xs" />
                </label>
              </div>
              {allowanceInvalid
                ? <p className="mt-2 text-[11px] text-destructive">{t('keys.creditAllowanceInvalid')}</p>
                : allowance.amount.trim() !== '' && (
                  <p className="mt-2 text-[11px] text-muted-foreground">
                    {t('keys.creditAllowanceEffect', { amount: `$${allowanceAmount.toFixed(2)}`, date: nextMonthlyReset(allowanceDay).toISOString().slice(0, 10), timezone: allowance.timezone || 'UTC' })}
                  </p>
                )}
            </div>
          )}

          {save.isError && (
            <p className="text-xs text-destructive">{(save.error as Error).message}</p>
          )}

          <div className="flex items-center justify-end gap-2 pt-1">
            {apiKey.platform === 'custom' && (apiKey.modelScope?.length ?? 0) > 0 && (
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
            <Button type="button" size="sm" onClick={submit} disabled={save.isPending || !catalogReady || allowanceInvalid}>
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
                measured={selectedMeasured}
                onUseMeasured={limits => {
                  const row = providerModelRows.find(model => model.modelId === selectedModelId)
                  if (!row) return
                  // Only the fields a probe established: a measured per-minute
                  // ceiling says nothing about tokens, and blanking those would
                  // read as "no limit".
                  const draft = modelLimitDrafts[row.modelDbId] ?? toDraft({
                    rpmLimit: row.rpmLimit, rpdLimit: row.rpdLimit,
                    tpmLimit: row.tpmLimit ?? null, tpdLimit: row.tpdLimit ?? null,
                  })
                  setModelLimitDrafts(previous => ({
                    ...previous,
                    [row.modelDbId]: {
                      ...draft,
                      rpmLimit: limits.rpmLimit == null ? draft.rpmLimit : String(limits.rpmLimit),
                      rpdLimit: limits.rpdLimit == null ? draft.rpdLimit : String(limits.rpdLimit),
                    },
                  }))
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

interface CreditPolicy {
  id: number
  scope: string
  metric: string
  limit: number
  periodKind: string
  anchorDay: number | null
  timezone: string | null
  unit: string | null
}

/** The next occurrence of day `day` of the month at 00:00 UTC, clamped to the
 *  month's length like the server's billing anchor. Display only: the server's
 *  quota clock decides the real reset, in the declared timezone. */
function nextMonthlyReset(day: number, now = new Date()): Date {
  const at = (y: number, m: number) => new Date(Date.UTC(y, m, Math.min(day, new Date(Date.UTC(y, m + 1, 0)).getUTCDate())))
  const thisMonth = at(now.getUTCFullYear(), now.getUTCMonth())
  return thisMonth > now ? thisMonth : at(now.getUTCFullYear(), now.getUTCMonth() + 1)
}
