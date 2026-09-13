import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { PackagePlus, PackageMinus } from 'lucide-react'
import { useI18n } from '@/i18n'
import { apiFetch } from '@/lib/api'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { shortDate, useCatalogueChanges } from '@/lib/catalogue-changes'
import { partitionByActivated, useActivatedPlatforms } from '@/lib/activated-platforms'

// What the catalogue gained and lost since the last time anyone looked.
//
// The panel exists because arrivals were invisible: two OpenRouter models
// appeared in a sync, the Default profile auto-included them, and they served
// traffic before anyone knew they existed. They were found by accident.
//
// It reports and does not act. Chain membership lives in a reviewed source file
// (server/src/data/routing-curation.ts); an "add to chain" button here would
// recreate `auto_include_new_models` behind a different control, which is the
// drift this panel exists to expose.

export function CatalogueChangesPanel() {
  const { t } = useI18n()
  const queryClient = useQueryClient()
  // Same default as the log: this is a worklist, and a row for a provider with
  // no key is not work. Opt back in with the footer control.
  const [onlyActivated, setOnlyActivated] = useState(true)
  const { activated, ready } = useActivatedPlatforms()

  const { data } = useCatalogueChanges()

  const acknowledge = useMutation({
    mutationFn: (model: { platform: string; modelId: string }) =>
      apiFetch('/api/models/changes/acknowledge', { method: 'POST', body: JSON.stringify(model) }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['catalogue-changes'] }),
  })

  // Acknowledged departures stay in the payload — the record is permanent — but
  // drop out of the panel, which is a worklist rather than a history.
  const filtering = onlyActivated && ready
  const allDeparted = (data?.departed ?? []).filter(d => !d.acknowledgedAt)
  const allArrived = data?.arrived ?? []
  const arrivedSplit = partitionByActivated(allArrived, activated)
  const departedSplit = partitionByActivated(allDeparted, activated)
  const arrived = filtering ? arrivedSplit.shown : allArrived
  const departed = filtering ? departedSplit.shown : allDeparted
  const hidden = arrivedSplit.hidden.length + departedSplit.hidden.length

  // Every row is on a deactivated provider: the panel still has something to
  // say, so it says how much and offers the way in rather than vanishing.
  if (allArrived.length === 0 && allDeparted.length === 0) return null

  return (
    <section className="rounded-xl border p-4">
      <h2 className="text-sm font-medium">{t('catalogue.changesTitle')}</h2>
      <p className="mt-0.5 text-xs text-muted-foreground">
        {t('catalogue.changesHint', { since: shortDate(data?.since ?? '') })}
        {data && data.untrackedArrivals > 0
          ? ` ${t('catalogue.untracked', { count: data.untrackedArrivals })}`
          : ''}
      </p>

      {arrived.length > 0 && (
        <div className="mt-3">
          <h3 className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
            <PackagePlus className="size-3.5" />
            {t('catalogue.arrived', { count: arrived.length })}
          </h3>
          <ul className="mt-1.5 space-y-1">
            {arrived.map(m => (
              <li key={`${m.platform}:${m.modelId}`} className="flex flex-wrap items-center gap-2 text-xs">
                <span className="text-muted-foreground">{m.platform}</span>
                <span className="font-mono">{m.modelId}</span>
                {/* A model that arrived AND is already serving is the urgent
                    row: it is answering requests nobody chose it for. One
                    sitting unrouted is information, not an incident. */}
                {m.routed
                  ? <Badge variant="destructive">{t('catalogue.autoRouted', { chains: m.chains.join(', ') })}</Badge>
                  : <Badge variant="outline">{t('catalogue.notRouted')}</Badge>}
                <span className="ml-auto text-muted-foreground tabular-nums">{shortDate(m.firstSeenAt)}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {departed.length > 0 && (
        <div className="mt-4">
          <h3 className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
            <PackageMinus className="size-3.5" />
            {t('catalogue.departed', { count: departed.length })}
          </h3>
          <ul className="mt-1.5 space-y-2">
            {departed.map(m => (
              <li key={`${m.platform}:${m.modelId}`} className="text-xs">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-muted-foreground">{m.platform}</span>
                  <span className="font-mono">{m.modelId}</span>
                  {/* The whole point of recording membership at retirement: a
                      departure matters because of what went with it. */}
                  {m.lostFrom.length > 0 && (
                    <Badge variant="destructive">
                      {t('catalogue.lostFrom', {
                        chains: m.lostFrom.map(c => `${c.chain} #${c.priority}`).join(', '),
                      })}
                    </Badge>
                  )}
                  <span className="ml-auto text-muted-foreground tabular-nums">{shortDate(m.retiredAt)}</span>
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={acknowledge.isPending}
                    onClick={() => acknowledge.mutate({ platform: m.platform, modelId: m.modelId })}
                  >
                    {t('catalogue.acknowledge')}
                  </Button>
                </div>
                {m.reason && (
                  <p className="mt-0.5 text-[11px] text-muted-foreground break-words">{m.reason}</p>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}

      {(hidden > 0 || !onlyActivated) && (
        <button
          type="button"
          onClick={() => setOnlyActivated(v => !v)}
          className="mt-3 text-[11px] text-muted-foreground underline decoration-dotted hover:text-foreground"
        >
          {onlyActivated ? t('catalogue.changesShowUnkeyed', { count: hidden }) : t('catalogue.changesOnlyActivated')}
        </button>
      )}
    </section>
  )
}
