import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Trash2 } from 'lucide-react'
import { useI18n } from '@/i18n'
import { apiFetch } from '@/lib/api'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { formatStamp } from '@/lib/stamp'
import { useExtensionEnabled } from '@/lib/use-extension'

// Leads found OUTSIDE the signed catalog: a provider blog announcing a free
// stealth model, an agent's report, a console page listing something the feed
// does not carry yet. The catalog stays authoritative for what this router
// serves; this is the list kept beside it — what was found, where, and whether
// anyone has tested it. Nothing here routes traffic or enables a model.
//
// An agent records leads through the same API the form uses, with
// `addedBy: "agent"`, so a bad batch is easy to tell apart and clear.

export const LEAD_STATUSES = ['candidate', 'testing', 'verified', 'rejected', 'added'] as const
export type LeadStatus = typeof LEAD_STATUSES[number]

export interface ExternalLead {
  id: number
  at: string
  source: string
  modelId: string
  displayName: string | null
  kind: string | null
  status: LeadStatus
  notes: string | null
  addedBy: 'user' | 'agent'
}

interface LeadsPage {
  leads: ExternalLead[]
  total: number
  byStatus: Record<LeadStatus, number>
}

const STATUS_TONE: Record<LeadStatus, string> = {
  candidate: 'text-muted-foreground',
  testing: 'text-amber-600 dark:text-amber-400',
  verified: 'text-emerald-600 dark:text-emerald-400',
  rejected: 'text-rose-600 dark:text-rose-400',
  added: 'text-sky-600 dark:text-sky-400',
}

const QUERY_KEY = ['discovery-leads']

function SourceLabel({ source }: { source: string }) {
  if (/^https?:\/\//.test(source)) {
    return (
      <a href={source} target="_blank" rel="noopener noreferrer" className="break-all underline decoration-dotted hover:text-foreground">
        {source.replace(/^https?:\/\//, '')}
      </a>
    )
  }
  return <span className="break-all">{source}</span>
}

export function ExternalDiscovery() {
  const { t } = useI18n()
  const queryClient = useQueryClient()
  const [filter, setFilter] = useState<LeadStatus | null>(null)
  const [form, setForm] = useState({ source: '', modelId: '', displayName: '', notes: '' })

  const { data } = useQuery<LeadsPage>({
    queryKey: QUERY_KEY,
    queryFn: () => apiFetch('/api/models/discovery/leads?limit=200'),
  })
  const refresh = () => queryClient.invalidateQueries({ queryKey: QUERY_KEY })

  const add = useMutation({
    mutationFn: () => apiFetch('/api/models/discovery/leads', {
      method: 'POST',
      body: JSON.stringify({
        source: form.source,
        modelId: form.modelId,
        displayName: form.displayName || null,
        notes: form.notes || null,
      }),
    }),
    onSuccess: () => {
      setForm({ source: '', modelId: '', displayName: '', notes: '' })
      refresh()
    },
  })
  const setStatus = useMutation({
    mutationFn: ({ id, status }: { id: number; status: LeadStatus }) =>
      apiFetch(`/api/models/discovery/leads/${id}`, { method: 'PATCH', body: JSON.stringify({ status }) }),
    onSuccess: refresh,
  })
  const remove = useMutation({
    mutationFn: (id: number) => apiFetch(`/api/models/discovery/leads/${id}`, { method: 'DELETE' }),
    onSuccess: refresh,
  })

  const leads = (data?.leads ?? []).filter(l => filter === null || l.status === filter)
  const canAdd = form.source.trim() !== '' && form.modelId.trim() !== '' && !add.isPending

  return (
    <div className="space-y-4">
      <p className="text-xs text-muted-foreground">{t('premium.discoveryHint')}</p>

      {data && data.total > 0 && (
        <div className="flex flex-wrap gap-1">
          <button
            type="button"
            onClick={() => setFilter(null)}
            className={`rounded-full border px-2 py-0.5 text-[11px] ${filter === null ? 'bg-muted' : 'hover:bg-muted/50'}`}
          >
            {t('premium.discoveryAll')} <span className="tabular-nums text-muted-foreground">{data.total}</span>
          </button>
          {LEAD_STATUSES.filter(s => data.byStatus[s] > 0).map(s => (
            <button
              key={s}
              type="button"
              onClick={() => setFilter(s)}
              className={`rounded-full border px-2 py-0.5 text-[11px] ${filter === s ? 'bg-muted' : 'hover:bg-muted/50'}`}
            >
              {t(`premium.discoveryStatus.${s}`)} <span className="tabular-nums text-muted-foreground">{data.byStatus[s]}</span>
            </button>
          ))}
        </div>
      )}

      {data && data.total === 0 && <p className="text-xs text-muted-foreground">{t('premium.discoveryEmpty')}</p>}

      {leads.length > 0 && (
        <ul className="divide-y divide-border">
          {leads.map(l => (
            <li key={l.id} className="flex flex-wrap items-baseline gap-x-3 gap-y-1 py-2 text-xs">
              <select
                aria-label={t('premium.discoveryStatusLabel', { model: l.modelId })}
                value={l.status}
                onChange={e => setStatus.mutate({ id: l.id, status: e.target.value as LeadStatus })}
                className={`rounded border bg-background px-1 py-0.5 text-[11px] ${STATUS_TONE[l.status]}`}
              >
                {LEAD_STATUSES.map(s => <option key={s} value={s}>{t(`premium.discoveryStatus.${s}`)}</option>)}
              </select>
              <span className="font-medium">{l.displayName || l.modelId}</span>
              <code className="text-[11px] text-muted-foreground">{l.modelId}</code>
              {l.addedBy === 'agent' && <Badge variant="outline" className="text-[10px]">{t('premium.discoveryByAgent')}</Badge>}
              <span className="ml-auto flex-shrink-0 text-[11px] text-muted-foreground tabular-nums">{formatStamp(l.at, { time: true })}</span>
              <button
                type="button"
                onClick={() => remove.mutate(l.id)}
                aria-label={t('premium.discoveryRemove', { model: l.modelId })}
                className="flex-shrink-0 text-muted-foreground hover:text-destructive"
              >
                <Trash2 className="size-3.5" />
              </button>
              <div className="w-full pl-1 text-[11px] text-muted-foreground">
                <SourceLabel source={l.source} />
                {l.notes && <p className="mt-0.5 break-words">{l.notes}</p>}
              </div>
            </li>
          ))}
        </ul>
      )}

      <form
        className="grid gap-2 sm:grid-cols-2"
        onSubmit={e => { e.preventDefault(); if (canAdd) add.mutate() }}
      >
        <Input
          aria-label={t('premium.discoveryModelId')}
          placeholder={t('premium.discoveryModelId')}
          value={form.modelId}
          onChange={e => setForm(f => ({ ...f, modelId: e.target.value }))}
        />
        <Input
          aria-label={t('premium.discoveryDisplayName')}
          placeholder={t('premium.discoveryDisplayName')}
          value={form.displayName}
          onChange={e => setForm(f => ({ ...f, displayName: e.target.value }))}
        />
        <Input
          aria-label={t('premium.discoverySource')}
          placeholder={t('premium.discoverySource')}
          value={form.source}
          onChange={e => setForm(f => ({ ...f, source: e.target.value }))}
        />
        <Input
          aria-label={t('premium.discoveryNotes')}
          placeholder={t('premium.discoveryNotes')}
          value={form.notes}
          onChange={e => setForm(f => ({ ...f, notes: e.target.value }))}
        />
        <div className="flex items-center gap-3 sm:col-span-2">
          <Button type="submit" size="sm" disabled={!canAdd}>{t('premium.discoveryAdd')}</Button>
          {add.isError && <span className="text-destructive text-xs">{(add.error as Error).message}</span>}
          <span className="ml-auto text-[11px] text-muted-foreground">{t('premium.discoveryAgentHint')}</span>
        </div>
      </form>
    </div>
  )
}

/** `external-model-discovery` off: the section is hidden; recorded leads stay. */
export function ExternalDiscoverySection({ title }: { title: string }) {
  if (!useExtensionEnabled('external-model-discovery')) return null
  return (
    <section>
      <h2 className="text-sm font-medium mb-3">{title}</h2>
      <div className="rounded-3xl border bg-card p-5">
        <ExternalDiscovery />
      </div>
    </section>
  )
}
