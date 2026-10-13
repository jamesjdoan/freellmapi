import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useI18n } from '@/i18n'
import { apiFetch } from '@/lib/api'
import { Badge } from '@/components/ui/badge'
import { PlatformDot } from '@/components/platform-dot'
import { formatStamp } from '@/lib/stamp'

// One row per applied catalog document, on the Premium page.
//
// The catalogue log on the chat-models page records what happened to each
// MODEL; this records what each catalog UPDATE brought: when the document
// landed, from which tier, and — diffed against the previously applied
// document — how many models it added, removed, and quietly changed. A
// provider tightening a quota on an existing model never appears in the event
// log; it appears here.
//
// Field-level detail is fetched per row on open, not up front: a sync can move
// hundreds of fields and the list view stays cheap.

interface SyncByPlatform { a: number; r: number; c: number }

interface CatalogueSync {
  id: number
  at: string
  version: string
  previousVersion: string | null
  tier: string
  generatedAt: string | null
  updated: number
  inserted: number
  removed: number
  skippedUnknownPlatform: number
  quirks: number
  docAdded: number
  docRemoved: number
  docChanged: number
  byPlatform: Record<string, SyncByPlatform>
}

interface CatalogueSyncTotals {
  syncs: number
  added: number
  removed: number
  changed: number
  lastAt: string | null
  lastVersion: string | null
}

type FieldValue = string | number | boolean | null

interface CatalogueSyncDetail extends CatalogueSync {
  details: { r: string; p: string; m: string; f: string; o: FieldValue; n: FieldValue }[]
}

const valueOf = (v: FieldValue) => (v === null ? '—' : String(v))

function SyncDetail({ id }: { id: number }) {
  const { t } = useI18n()
  const { data, isPending } = useQuery<CatalogueSyncDetail>({
    queryKey: ['catalogue-sync-detail', id],
    queryFn: () => apiFetch(`/api/models/changes/syncs/detail?id=${id}`),
  })
  if (isPending) return <p className="pl-5 text-[11px] text-muted-foreground">{t('catalogue.syncsDetailLoading')}</p>
  if (!data || data.details.length === 0) return null
  return (
    <div className="ml-5 mt-1 max-h-48 overflow-y-auto rounded border bg-muted/30 p-2">
      <table className="w-full text-[11px]">
        <tbody>
          {data.details.map((d, i) => (
            <tr key={i} className="align-baseline">
              <td className="w-4 py-0.5"><PlatformDot platform={d.p} /></td>
              <td className="py-0.5 pr-2"><code className="text-muted-foreground">{d.m}</code></td>
              <td className="py-0.5 pr-2 font-medium">{d.f}</td>
              <td className="py-0.5 pr-1 text-rose-600 dark:text-rose-400"><code className="break-all">{valueOf(d.o)}</code></td>
              <td className="py-0.5 pr-1 text-muted-foreground">→</td>
              <td className="py-0.5 text-emerald-600 dark:text-emerald-400"><code className="break-all">{valueOf(d.n)}</code></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function Stat({ label, value, tone }: { label: string; value: string; tone?: string }) {
  return (
    <div className="min-w-24">
      <div className={`text-lg font-semibold tabular-nums ${tone ?? ''}`}>{value}</div>
      <div className="text-[11px] text-muted-foreground">{label}</div>
    </div>
  )
}

export function CatalogueSyncs() {
  const { t } = useI18n()
  const [openId, setOpenId] = useState<number | null>(null)
  const { data } = useQuery<{ syncs: CatalogueSync[]; total: number; totals: CatalogueSyncTotals }>({
    queryKey: ['catalogue-syncs'],
    queryFn: () => apiFetch('/api/models/changes/syncs?limit=30'),
  })
  if (!data) return null
  if (data.syncs.length === 0) {
    return <p className="text-xs text-muted-foreground">{t('catalogue.syncsEmpty')}</p>
  }
  const { totals } = data
  return (
    <div>
      <div className="flex flex-wrap items-end gap-x-8 gap-y-3">
        <Stat label={t('catalogue.syncsTotalUpdates')} value={String(totals.syncs)} />
        <Stat label={t('catalogue.syncsTotalAdded')} value={`+${totals.added}`} tone="text-emerald-600 dark:text-emerald-400" />
        <Stat label={t('catalogue.syncsTotalRemoved')} value={`−${totals.removed}`} tone="text-rose-600 dark:text-rose-400" />
        <Stat label={t('catalogue.syncsTotalChanged')} value={`~${totals.changed}`} tone="text-amber-600 dark:text-amber-400" />
        {totals.lastAt && (
          <span className="ml-auto text-[11px] text-muted-foreground tabular-nums">
            {t('catalogue.syncsLast', { when: formatStamp(totals.lastAt, { time: true }) })}
          </span>
        )}
      </div>
      <p className="mt-3 text-[11px] text-muted-foreground">{t('catalogue.syncsHint')}</p>
      <ul className="mt-2 divide-y divide-border">
        {data.syncs.map(s => (
          <li key={s.id}>
            <button
              type="button"
              onClick={() => setOpenId(v => (v === s.id ? null : s.id))}
              aria-expanded={openId === s.id}
              className="flex w-full flex-wrap items-baseline gap-x-2 gap-y-0.5 py-1.5 text-left text-xs"
            >
              <Badge variant="outline" className="text-[10px]">{s.tier}</Badge>
              <span className="font-mono">
                {s.previousVersion ? `${s.previousVersion} → ${s.version}` : s.version}
              </span>
              {!s.previousVersion && <span className="text-muted-foreground">({t('catalogue.syncsBaseline')})</span>}
              <span className="tabular-nums">
                {s.docAdded > 0 && <span className="text-emerald-600 dark:text-emerald-400">{`+${s.docAdded}`}</span>}
                {s.docRemoved > 0 && <span className="ml-1.5 text-rose-600 dark:text-rose-400">{`−${s.docRemoved}`}</span>}
                {s.docChanged > 0 && <span className="ml-1.5 text-amber-600 dark:text-amber-400">{`~${s.docChanged}`}</span>}
                {s.docAdded + s.docRemoved + s.docChanged === 0 && <span className="text-muted-foreground">—</span>}
              </span>
              <span className="ml-auto flex-shrink-0 text-[11px] text-muted-foreground tabular-nums">
                {formatStamp(s.at, { time: true })}
              </span>
            </button>
            {openId === s.id && <SyncDetail id={s.id} />}
          </li>
        ))}
      </ul>
    </div>
  )
}
