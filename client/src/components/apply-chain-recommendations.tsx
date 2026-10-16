import { useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { z } from 'zod'
import { apiFetch } from '@/lib/api'
import {
  GRADED_CHAINS, METRICS, evaluate, scoreRowOf, useChainMinimums, useChainMinimumsView, type GradedChain,
} from '@/lib/chain-minimums'
import { REFERENCE_ONLY_PLATFORMS } from '@/lib/routing'
import { useI18n } from '@/i18n'
import { Button } from '@/components/ui/button'
import { ConfirmButton } from '@/components/confirm-button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'

const score = z.number().finite().nullable()
const Route = z.object({
  modelDbId: z.number().int().positive(), platform: z.string(), modelId: z.string(),
  enabled: z.boolean(), keyScope: z.enum(['none', 'disabled', 'unscoped', 'in', 'out']),
  supportsTools: z.boolean(), supportsVision: z.boolean(), chains: z.array(z.string()),
  analysis: z.object({ intelligenceIndex: score, codingIndex: score, agenticIndex: score }).nullable(),
  link: z.object({ source: z.enum(['auto', 'manual', 'proxy']) }).nullable(),
})
const Minimums = z.object({ general: score, coding: score, agentic: score, acceptEstimated: z.boolean() })
const Evidence = z.object({
  doc: z.object({
    revision: z.number().int().nonnegative(),
    chains: z.record(Minimums).refine(chains => GRADED_CHAINS.every(chain => Object.hasOwn(chains, chain))),
  }),
  requirements: z.array(z.object({ name: z.string(), requiresTools: z.boolean(), requiresVision: z.boolean(), reserved: z.boolean() }))
    .refine(requirements => GRADED_CHAINS.every(chain => requirements.some(req => req.name === chain && !req.reserved))),
})
const Profiles = z.array(z.object({ name: z.string() }))
const Membership = z.object({ success: z.literal(true), changed: z.number().int().nonnegative() })
type Models = number | readonly { modelDbId: number }[]
type Preview = {
  revision: number
  groups: { chain: GradedChain; models: z.infer<typeof Route>[] }[]
}

/** Capture validated, current evidence for the exact physical rows on this UI. */
async function readRecommendations(models: Models): Promise<Preview> {
  const ids = new Set(typeof models === 'number' ? [models] : models.map(model => model.modelDbId))
  const [rawRows, rawMinimums, rawProfiles] = await Promise.all([
    apiFetch<unknown>('/api/analysis/compare'),
    apiFetch<unknown>('/api/chain-minimums'),
    apiFetch<unknown>('/api/profiles'),
  ])
  const rows = z.object({ rows: z.array(Route) }).parse(rawRows).rows.filter(row =>
    ids.has(row.modelDbId) && row.enabled && !REFERENCE_ONLY_PLATFORMS[row.platform]
    && (row.keyScope === 'in' || row.keyScope === 'unscoped'))
  const minimums = Evidence.parse(rawMinimums)
  const names = new Set(Profiles.parse(rawProfiles).map(profile => profile.name))
  const groups = GRADED_CHAINS.filter(chain => names.has(chain)).map(chain => ({
    chain,
    models: rows.filter(row => !row.chains.includes(chain)
      && evaluate(scoreRowOf(row), minimums.doc.chains[chain], minimums.requirements.find(req => req.name === chain)).status === 'fits'),
  })).filter(group => group.models.length > 0)
  return { revision: minimums.doc.revision, groups }
}

type Result = { chain: string; added: number | null; error: string | null }

/** Recommendation is advisory until the operator selects rows and confirms. */
export function ApplyChainRecommendations({ models }: { models: Models }) {
  const { t } = useI18n()
  const queryClient = useQueryClient()
  const saved = useChainMinimums().data?.doc
  const { draft } = useChainMinimumsView()
  const unsaved = draft != null && (!saved || GRADED_CHAINS.some(chain =>
    draft.chains[chain].acceptEstimated !== saved.chains[chain].acceptEstimated
    || METRICS.some(metric => draft.chains[chain][metric] !== saved.chains[chain][metric])))
  const [open, setOpen] = useState(false)
  const [working, setWorking] = useState(false)
  const [preview, setPreview] = useState<Preview | null>(null)
  const [selected, setSelected] = useState<Set<string>>(() => new Set())
  const [error, setError] = useState<string | null>(null)
  const [results, setResults] = useState<Result[]>([])
  const selectionKey = [...selected].sort().join('|')

  const prepare = async () => {
    setWorking(true)
    setError(null)
    setResults([])
    try {
      const current = await readRecommendations(models)
      setPreview(current)
      setSelected(new Set(current.groups.flatMap(group => group.models.map(model => `${group.chain}:${model.modelDbId}`))))
      setOpen(true)
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : t('chainFit.applyFailed'))
    } finally {
      setWorking(false)
    }
  }

  const apply = async () => {
    if (!preview || unsaved || selected.size === 0) return
    setWorking(true)
    setError(null)
    try {
      const current = await readRecommendations(models)
      const eligible = new Set(current.groups.flatMap(group => group.models.map(model => `${group.chain}:${model.modelDbId}`)))
      if (current.revision !== preview.revision || [...selected].some(key => !eligible.has(key))) {
        setPreview(current)
        setSelected(new Set([...selected].filter(key => eligible.has(key))))
        setResults([])
        setError(t('chainFit.changedReview'))
        return
      }
      const outcomes: Result[] = []
      const completed = new Set<string>()
      for (const group of current.groups) {
        const modelDbIds = group.models.filter(model => selected.has(`${group.chain}:${model.modelDbId}`)).map(model => model.modelDbId)
        if (modelDbIds.length === 0) continue
        try {
          const result = Membership.parse(await apiFetch<unknown>('/api/fallback/membership', {
            method: 'POST', body: JSON.stringify({ chain: group.chain, modelDbIds, member: true, append: true }),
          }))
          outcomes.push({ chain: group.chain, added: result.changed, error: null })
          for (const id of modelDbIds) completed.add(`${group.chain}:${id}`)
        } catch (failure) {
          outcomes.push({ chain: group.chain, added: null, error: failure instanceof Error ? failure.message : t('chainFit.applyFailed') })
        }
      }
      setResults(outcomes)
      setSelected(new Set([...selected].filter(key => !completed.has(key))))
      await Promise.all(['analysis', 'models', 'fallback', 'profiles'].map(key =>
        queryClient.invalidateQueries({ queryKey: [key] })))
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : t('chainFit.applyFailed'))
    } finally {
      setWorking(false)
    }
  }

  return (
    <Popover open={open} onOpenChange={next => { if (!next && !working) setOpen(false) }}>
      <PopoverTrigger
        disabled={working || unsaved}
        title={unsaved ? t('chainFit.saveFirst') : t('chainFit.appendHint')}
        onClick={event => { event.stopPropagation(); void prepare() }}
        className="px-1 text-[10px] text-muted-foreground underline decoration-dotted disabled:opacity-50"
      >
        {working ? t('chainFit.refreshing') : t('chainFit.applyRecommendations')}
      </PopoverTrigger>
      {!open && error && <span role="alert" className="text-[10px] text-destructive">{error}</span>}
      <PopoverContent align="start" className="max-h-[70vh] w-[min(26rem,calc(100vw-2rem))] space-y-3 overflow-y-auto p-3" onClick={event => event.stopPropagation()}>
        <p className="text-xs font-medium">{t('chainFit.previewTitle')}</p>
        <p className="text-[11px] text-muted-foreground">{t('chainFit.appendHint')}</p>
        {unsaved && <p role="alert" className="text-[11px] text-amber-700 dark:text-amber-400">{t('chainFit.saveFirst')}</p>}
        {preview?.groups.length === 0 && <p className="text-[11px] text-muted-foreground">{t('chainFit.noAdditions')}</p>}
        {preview?.groups.map(group => {
          const keys = group.models.map(model => `${group.chain}:${model.modelDbId}`)
          const checked = keys.every(key => selected.has(key))
          return (
            <fieldset key={group.chain} className="space-y-1 rounded-lg border p-2" disabled={working}>
              <legend className="px-1 text-xs font-medium">
                <label className="inline-flex items-center gap-2">
                  <input type="checkbox" checked={checked} onChange={() => setSelected(previous => {
                    const next = new Set(previous)
                    for (const key of keys) { if (checked) next.delete(key); else next.add(key) }
                    return next
                  })} />
                  {group.chain}
                </label>
              </legend>
              {group.models.map(model => {
                const key = `${group.chain}:${model.modelDbId}`
                return <label key={model.modelDbId} className="flex items-start gap-2 text-[11px]">
                  <input type="checkbox" className="mt-0.5" checked={selected.has(key)} onChange={() => setSelected(previous => {
                    const next = new Set(previous)
                    if (next.has(key)) next.delete(key); else next.add(key)
                    return next
                  })} />
                  <span className="break-all">{model.platform} · {model.modelId} <span className="text-muted-foreground">#{model.modelDbId}</span></span>
                </label>
              })}
            </fieldset>
          )
        })}
        {error && <p role="alert" className="text-[11px] text-destructive">{error}</p>}
        {results.map(result => <p key={result.chain} role={result.error ? 'alert' : 'status'} className={`text-[11px] ${result.error ? 'text-destructive' : 'text-emerald-700 dark:text-emerald-400'}`}>
          {result.error ? `${result.chain}: ${result.error}` : t('chainFit.applied', { chain: result.chain, count: result.added ?? 0 })}
        </p>)}
        <div className="flex items-center justify-between gap-2">
          <Button size="xs" variant="ghost" disabled={working} onClick={() => setOpen(false)}>{t('common.cancel')}</Button>
          <ConfirmButton key={`${preview?.revision}:${selectionKey}`} size="xs" variant="default"
            disabled={working || unsaved || selected.size === 0} confirmLabel={t('chainFit.confirmAdditions')} onConfirm={() => { void apply() }}>
            {t('chainFit.applyCount', { count: selected.size })}
          </ConfirmButton>
        </div>
      </PopoverContent>
    </Popover>
  )
}
