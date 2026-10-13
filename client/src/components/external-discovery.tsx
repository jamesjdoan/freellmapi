import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Copy, EyeOff, Trash2 } from 'lucide-react'
import { useI18n } from '@/i18n'
import { apiFetch } from '@/lib/api'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { ConfirmButton } from '@/components/confirm-button'
import { formatStamp } from '@/lib/stamp'
import { useExtensionEnabled } from '@/lib/use-extension'

// Leads found OUTSIDE the signed catalog: a provider blog announcing a free
// stealth model, an agent's report, a console page listing something the feed
// does not carry yet. The catalog stays authoritative for what this router
// serves; this is the list kept beside it — what was found, where, and whether
// anyone has tested it. Nothing here routes traffic or enables a model.
//
// Leads are grouped by provider, one collapsible group each, so a busy agent
// does not bury the list; within a group, rejected leads sit below the live
// ones (the server's order). An agent writes through the same API with its own
// token (Agent access, below): it can change and remove only its own leads,
// never a status the operator set. Ignoring a model hides its leads and makes
// agents skip it from any source; rejecting keeps it visible as evidence.

export const LEAD_STATUSES = ['candidate', 'testing', 'verified', 'rejected', 'added'] as const
export type LeadStatus = typeof LEAD_STATUSES[number]

export interface ExternalLead {
  id: number
  at: string
  source: string
  provider: string | null
  modelId: string
  displayName: string | null
  kind: string | null
  status: LeadStatus
  statusSetBy: 'user' | 'agent'
  notes: string | null
  addedBy: 'user' | 'agent'
}

export interface IgnoredModel {
  provider: string
  modelId: string
  at: string
  reason: string | null
  hiddenLeads: number
}

interface LeadsPage {
  leads: ExternalLead[]
  total: number
  byStatus: Record<LeadStatus, number>
  ignored: IgnoredModel[]
}

interface AgentTokenStatus { active: boolean; createdAt: string | null }

const STATUS_TONE: Record<LeadStatus, string> = {
  candidate: 'text-muted-foreground',
  testing: 'text-amber-600 dark:text-amber-400',
  verified: 'text-emerald-600 dark:text-emerald-400',
  rejected: 'text-rose-600 dark:text-rose-400',
  added: 'text-sky-600 dark:text-sky-400',
}

const LEADS_KEY = ['discovery-leads']
const TOKEN_KEY = ['discovery-agent-token']
const LEADS_PATH = '/api/discovery/leads'
const IGNORES_PATH = '/api/discovery/ignores'

/** Provider groups, largest first; ties alphabetical, unnamed last. */
export function groupByProvider(leads: ExternalLead[]): Array<[string | null, ExternalLead[]]> {
  const groups = new Map<string | null, ExternalLead[]>()
  for (const lead of leads) {
    const list = groups.get(lead.provider) ?? []
    list.push(lead)
    groups.set(lead.provider, list)
  }
  return [...groups.entries()].sort(([pa, a], [pb, b]) => {
    if (pa === null || pb === null) return pa === null ? 1 : -1
    return b.length - a.length || pa.localeCompare(pb)
  })
}

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

function LeadRow({ lead, onStatus, onIgnore, onRemove }: {
  lead: ExternalLead
  onStatus: (status: LeadStatus) => void
  onIgnore: () => void
  onRemove: () => void
}) {
  const { t } = useI18n()
  return (
    <li className="flex flex-wrap items-baseline gap-x-3 gap-y-1 py-2 text-xs">
      <select
        aria-label={t('premium.discoveryStatusLabel', { model: lead.modelId })}
        value={lead.status}
        onChange={e => onStatus(e.target.value as LeadStatus)}
        className={`rounded border bg-background px-1 py-0.5 text-[11px] ${STATUS_TONE[lead.status]}`}
      >
        {LEAD_STATUSES.map(s => <option key={s} value={s}>{t(`premium.discoveryStatus.${s}`)}</option>)}
      </select>
      <span className="font-medium">{lead.displayName || lead.modelId}</span>
      <code className="text-[11px] text-muted-foreground">{lead.modelId}</code>
      {lead.addedBy === 'agent' && <Badge variant="outline" className="text-[10px]">{t('premium.discoveryByAgent')}</Badge>}
      <span className="ml-auto flex-shrink-0 text-[11px] text-muted-foreground tabular-nums">{formatStamp(lead.at, { time: true })}</span>
      <button
        type="button"
        onClick={onIgnore}
        aria-label={t('premium.discoveryIgnore', { model: lead.modelId })}
        title={t('premium.discoveryIgnore', { model: lead.modelId })}
        className="flex-shrink-0 text-muted-foreground hover:text-foreground"
      >
        <EyeOff className="size-3.5" />
      </button>
      <button
        type="button"
        onClick={onRemove}
        aria-label={t('premium.discoveryRemove', { model: lead.modelId })}
        className="flex-shrink-0 text-muted-foreground hover:text-destructive"
      >
        <Trash2 className="size-3.5" />
      </button>
      <div className="w-full pl-1 text-[11px] text-muted-foreground">
        <SourceLabel source={lead.source} />
        {lead.notes && <p className="mt-0.5 break-words">{lead.notes}</p>}
      </div>
    </li>
  )
}

function AgentAccess() {
  const { t } = useI18n()
  const queryClient = useQueryClient()
  const [fresh, setFresh] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const { data } = useQuery<AgentTokenStatus>({
    queryKey: TOKEN_KEY,
    queryFn: () => apiFetch('/api/discovery/agent-token'),
  })
  const refresh = () => queryClient.invalidateQueries({ queryKey: TOKEN_KEY })
  const mint = useMutation({
    mutationFn: () => apiFetch<{ token: string; createdAt: string }>('/api/discovery/agent-token', { method: 'POST' }),
    onSuccess: ({ token }) => { setFresh(token); setCopied(false); refresh() },
  })
  const revoke = useMutation({
    mutationFn: () => apiFetch('/api/discovery/agent-token', { method: 'DELETE' }),
    onSuccess: () => { setFresh(null); refresh() },
  })
  const copy = async () => {
    if (!fresh) return
    await navigator.clipboard.writeText(fresh)
    setCopied(true)
  }
  const endpoint = `${window.location.origin}${LEADS_PATH}`

  return (
    <div className="rounded border bg-muted/20 p-3 text-xs">
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="font-medium">{t('premium.discoveryAgentTitle')}</h3>
        <span className="text-[11px] text-muted-foreground">
          {data?.active
            ? t('premium.discoveryAgentActive', { when: formatStamp(data.createdAt ?? '', { time: true }) })
            : t('premium.discoveryAgentNone')}
        </span>
        <span className="ml-auto flex gap-1">
          {data?.active ? (
            <>
              <ConfirmButton onConfirm={() => mint.mutate()} disabled={mint.isPending} variant="outline">
                {t('premium.discoveryAgentReplace')}
              </ConfirmButton>
              <ConfirmButton onConfirm={() => revoke.mutate()} disabled={revoke.isPending}>
                {t('premium.discoveryAgentRevoke')}
              </ConfirmButton>
            </>
          ) : (
            <Button size="xs" variant="outline" onClick={() => mint.mutate()} disabled={mint.isPending}>
              {t('premium.discoveryAgentCreate')}
            </Button>
          )}
        </span>
      </div>
      {fresh && (
        <div className="mt-2 space-y-1">
          <div className="flex gap-2">
            <Input readOnly value={fresh} aria-label={t('premium.discoveryAgentTitle')} className="font-mono text-[11px]" onFocus={e => e.target.select()} />
            <Button size="sm" variant="outline" onClick={copy}>
              <Copy className="size-3.5" />
              {copied ? t('premium.discoveryAgentCopied') : t('premium.discoveryAgentCopy')}
            </Button>
          </div>
          <p className="text-[11px] text-amber-600 dark:text-amber-400">{t('premium.discoveryAgentShownOnce')}</p>
        </div>
      )}
      <p className="mt-2 text-[11px] text-muted-foreground">
        {t('premium.discoveryAgentUsage', { path: endpoint })}
      </p>
    </div>
  )
}

export function ExternalDiscovery() {
  const { t } = useI18n()
  const queryClient = useQueryClient()
  const [filter, setFilter] = useState<LeadStatus | null>(null)
  const [form, setForm] = useState({ source: '', provider: '', modelId: '', displayName: '', notes: '' })

  const { data } = useQuery<LeadsPage>({
    queryKey: LEADS_KEY,
    queryFn: () => apiFetch(`${LEADS_PATH}?limit=200`),
  })
  const refresh = () => queryClient.invalidateQueries({ queryKey: LEADS_KEY })

  const add = useMutation({
    mutationFn: () => apiFetch(LEADS_PATH, {
      method: 'POST',
      body: JSON.stringify({
        source: form.source,
        modelId: form.modelId,
        provider: form.provider || null,
        displayName: form.displayName || null,
        notes: form.notes || null,
      }),
    }),
    onSuccess: () => {
      setForm({ source: '', provider: '', modelId: '', displayName: '', notes: '' })
      refresh()
    },
  })
  const setStatus = useMutation({
    mutationFn: ({ id, status }: { id: number; status: LeadStatus }) =>
      apiFetch(`${LEADS_PATH}/${id}`, { method: 'PATCH', body: JSON.stringify({ status }) }),
    onSuccess: refresh,
  })
  const remove = useMutation({
    mutationFn: (id: number) => apiFetch(`${LEADS_PATH}/${id}`, { method: 'DELETE' }),
    onSuccess: refresh,
  })
  const ignore = useMutation({
    mutationFn: (lead: ExternalLead) => apiFetch(IGNORES_PATH, {
      method: 'POST',
      body: JSON.stringify({ provider: lead.provider, modelId: lead.modelId }),
    }),
    onSuccess: refresh,
  })
  const unignore = useMutation({
    mutationFn: (model: IgnoredModel) => apiFetch(
      `${IGNORES_PATH}?${new URLSearchParams({ provider: model.provider, modelId: model.modelId })}`,
      { method: 'DELETE' },
    ),
    onSuccess: refresh,
  })

  const leads = (data?.leads ?? []).filter(l => filter === null || l.status === filter)
  const groups = groupByProvider(leads)
  const canAdd = form.source.trim() !== '' && form.modelId.trim() !== '' && !add.isPending
  const field = (key: keyof typeof form, label: string) => (
    <Input
      aria-label={label}
      placeholder={label}
      value={form[key]}
      onChange={e => setForm(f => ({ ...f, [key]: e.target.value }))}
    />
  )

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

      {data && data.total === 0 && data.ignored.length === 0 && <p className="text-xs text-muted-foreground">{t('premium.discoveryEmpty')}</p>}

      <div className="space-y-1">
        {groups.map(([provider, list]) => (
          <details key={provider ?? ''} open={groups.length === 1} className="rounded border px-2 py-1">
            <summary className="flex cursor-pointer items-baseline gap-2 text-xs">
              <span className="font-medium">{provider ?? t('premium.discoveryUnspecified')}</span>
              <span className="tabular-nums text-muted-foreground">{list.length}</span>
              {LEAD_STATUSES.filter(s => list.some(l => l.status === s)).map(s => (
                <span key={s} className={`text-[11px] ${STATUS_TONE[s]}`}>
                  {t(`premium.discoveryStatus.${s}`)} {list.filter(l => l.status === s).length}
                </span>
              ))}
            </summary>
            <ul className="divide-y divide-border">
              {list.map(l => (
                <LeadRow
                  key={l.id}
                  lead={l}
                  onStatus={status => setStatus.mutate({ id: l.id, status })}
                  onIgnore={() => ignore.mutate(l)}
                  onRemove={() => remove.mutate(l.id)}
                />
              ))}
            </ul>
          </details>
        ))}
        {data && data.ignored.length > 0 && (
          <details className="rounded border border-dashed px-2 py-1">
            <summary className="flex cursor-pointer items-baseline gap-2 text-xs text-muted-foreground">
              <EyeOff className="size-3.5 self-center" />
              <span className="font-medium">{t('premium.discoveryIgnoredTitle')}</span>
              <span className="tabular-nums">{data.ignored.length}</span>
            </summary>
            <p className="py-1 text-[11px] text-muted-foreground">{t('premium.discoveryIgnoredHint')}</p>
            <ul className="divide-y divide-border">
              {data.ignored.map(m => (
                <li key={`${m.provider}:${m.modelId}`} className="flex flex-wrap items-baseline gap-x-3 py-1.5 text-xs">
                  <span className="text-muted-foreground">{m.provider || t('premium.discoveryUnspecified')}</span>
                  <code>{m.modelId}</code>
                  {m.hiddenLeads > 0 && (
                    <span className="text-[11px] text-muted-foreground">{t('premium.discoveryHiddenLeads', { count: m.hiddenLeads })}</span>
                  )}
                  {m.reason && <span className="text-[11px] text-muted-foreground">{m.reason}</span>}
                  <Button
                    size="xs"
                    variant="ghost"
                    className="ml-auto"
                    onClick={() => unignore.mutate(m)}
                    aria-label={t('premium.discoveryUnignoreLabel', { model: m.modelId })}
                  >
                    {t('premium.discoveryUnignore')}
                  </Button>
                </li>
              ))}
            </ul>
          </details>
        )}
      </div>

      <form
        className="grid gap-2 sm:grid-cols-2"
        onSubmit={e => { e.preventDefault(); if (canAdd) add.mutate() }}
      >
        {field('modelId', t('premium.discoveryModelId'))}
        {field('displayName', t('premium.discoveryDisplayName'))}
        {field('source', t('premium.discoverySource'))}
        {field('provider', t('premium.discoveryProvider'))}
        <div className="sm:col-span-2">{field('notes', t('premium.discoveryNotes'))}</div>
        <div className="flex items-center gap-3 sm:col-span-2">
          <Button type="submit" size="sm" disabled={!canAdd}>{t('premium.discoveryAdd')}</Button>
          {add.isError && <span className="text-destructive text-xs">{(add.error as Error).message}</span>}
        </div>
      </form>

      <AgentAccess />
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
