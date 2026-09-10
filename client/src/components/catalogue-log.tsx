import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { History } from 'lucide-react'
import { useI18n } from '@/i18n'
import { apiFetch } from '@/lib/api'
import { Badge } from '@/components/ui/badge'
import { PlatformDot } from '@/components/platform-dot'
import { TimeTreeLog } from '@/components/time-tree-log'
import { parseSqliteUtc } from '@/lib/time-tree'

// The catalogue's history: every model that arrived, was retired, removed or
// relisted, and when.
//
// Distinct from the changes panel above it, which is a worklist of the recent
// and unacknowledged. This is the whole record, and it answers the question the
// panel cannot: what has this provider been doing over time.
//
// It exists because one departure path used to record nothing at all — catalog
// sync deletes models the upstream catalogue has stopped listing, so a provider
// dropping a model made it vanish with no trace.

interface CatalogueEvent {
  id: number
  at: string
  kind: 'arrived' | 'retired' | 'removed' | 'relisted'
  platform: string
  modelId: string
  displayName: string | null
  source: string | null
  reason: string | null
  chains: { chain: string; priority: number }[]
}

interface CatalogueLogPage {
  events: CatalogueEvent[]
  total: number
  byPlatform: { platform: string; arrived: number; departed: number }[]
}

const GAINED = new Set(['arrived', 'relisted'])

export function CatalogueLogPanel() {
  const { t } = useI18n()
  const [platform, setPlatform] = useState<string | null>(null)

  const { data } = useQuery<CatalogueLogPage>({
    queryKey: ['catalogue-log', platform],
    queryFn: () => apiFetch(`/api/models/changes/log?limit=500${platform ? `&platform=${encodeURIComponent(platform)}` : ''}`),
  })

  // Nothing has happened since the log started. Rendering an empty shell would
  // read as a broken panel rather than as a quiet catalogue.
  if (!data || data.byPlatform.length === 0) return null

  return (
    <section className="rounded-xl border p-4">
      <div className="flex flex-wrap items-center gap-2">
        <History className="size-4 text-muted-foreground" />
        <h2 className="text-sm font-medium">{t('catalogue.logTitle')}</h2>
        <Badge variant="secondary" className="tabular-nums">{data.total}</Badge>
        <div className="ml-auto flex flex-wrap items-center gap-1">
          <button
            type="button"
            onClick={() => setPlatform(null)}
            className={`rounded-full border px-2 py-0.5 text-[11px] ${platform === null ? 'bg-muted' : 'hover:bg-muted/50'}`}
          >
            {t('catalogue.logAllProviders')}
          </button>
          {/* Built from `byPlatform`, which the API returns unfiltered — so
              narrowing to one provider never removes the others from here. */}
          {data.byPlatform.map(p => (
            <button
              key={p.platform}
              type="button"
              onClick={() => setPlatform(p.platform)}
              className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] ${platform === p.platform ? 'bg-muted' : 'hover:bg-muted/50'}`}
            >
              <PlatformDot platform={p.platform} />
              {p.platform}
              <span className="tabular-nums text-muted-foreground">{`+${p.arrived}/−${p.departed}`}</span>
            </button>
          ))}
        </div>
      </div>

      <div className="mt-3">
        <TimeTreeLog
          recentLabel={t('catalogue.logRecent')}
          unit="month"
          items={data.events}
          at={e => parseSqliteUtc(e.at)}
          itemKey={e => String(e.id)}
          summary={items => {
            const gained = items.filter(e => GAINED.has(e.kind)).length
            const lost = items.length - gained
            return (
              <span className="tabular-nums">
                {gained > 0 && <span className="text-emerald-600 dark:text-emerald-400">{t('log.arrived', { count: gained })}</span>}
                {gained > 0 && lost > 0 && ' · '}
                {lost > 0 && <span className="text-rose-600 dark:text-rose-400">{t('log.departed', { count: lost })}</span>}
              </span>
            )
          }}
          row={e => (
            <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 text-xs">
              <span className={`w-3 flex-shrink-0 text-center font-medium ${GAINED.has(e.kind) ? 'text-emerald-600 dark:text-emerald-400' : 'text-rose-600 dark:text-rose-400'}`}>
                {GAINED.has(e.kind) ? '+' : '−'}
              </span>
              <PlatformDot platform={e.platform} />
              <span className="font-medium">{e.displayName || e.modelId}</span>
              <code className="text-[11px] text-muted-foreground">{e.modelId}</code>
              <Badge variant="outline" className="text-[10px]">{t(`catalogue.kind.${e.kind}`)}</Badge>
              {e.chains.length > 0 && (
                <span className="text-[11px] text-destructive">
                  {t('catalogue.lostFrom', { chains: e.chains.map(c => `${c.chain} #${c.priority}`).join(', ') })}
                </span>
              )}
              <span className="ml-auto flex-shrink-0 text-[11px] text-muted-foreground tabular-nums">
                {parseSqliteUtc(e.at).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}
              </span>
              {e.reason && (
                <p className="w-full pl-5 text-[11px] text-muted-foreground break-words">{e.reason}</p>
              )}
            </div>
          )}
        />
      </div>
    </section>
  )
}
