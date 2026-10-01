import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { PackagePlus, PackageMinus, ChevronRight, ChevronDown, History, Clock } from 'lucide-react'
import { useI18n } from '@/i18n'
import { apiFetch } from '@/lib/api'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { useCatalogueChanges, unreadSelection, RECENT_HEAD } from '@/lib/catalogue-changes'
import { formatStamp } from '@/lib/stamp'
import { parseSqliteUtc } from '@/lib/time-tree'
import { TimeTreeLog } from '@/components/time-tree-log'
import type { ArrivedModel, DepartedModel } from '@/lib/catalogue-changes'
import { ConfirmButton } from '@/components/confirm-button'
import { partitionByActivated, useActivatedPlatforms } from '@/lib/activated-platforms'

// What the catalogue gained and lost since the last time anyone looked.
//
// The panel exists because arrivals were invisible: two OpenRouter models
// appeared in a sync, the Default profile auto-included them, and they served
// traffic before anyone knew they existed. They were found by accident.
//
// It reports and it does not ROUTE. Chain membership lives in a reviewed
// source file (server/src/data/routing-curation.ts); an "add to chain" button
// here would recreate `auto_include_new_models` behind a different control,
// which is the drift this panel exists to expose.
//
// The one thing it does write is an ACKNOWLEDGEMENT, and that is not routing:
// it records that a change has been read so it stops repeating, and it moves
// nothing. Rows are never deleted — the arrival, the tombstone and the event
// log all survive — so "show all" is always able to render what is really
// there. See docs/adr/ARCH-20260930-catalogue-panel-unread-worklist.md.

/** One button for every change on screen, arrivals and departures alike. */
const BULK_ACK_PATH = '/api/models/changes/acknowledge-bulk'

export function CatalogueChangesPanel() {
  const { t } = useI18n()
  const queryClient = useQueryClient()
  // Same default as the log: this is a worklist, and a row for a provider with
  // no key is not work. Opt back in with the footer control.
  const [onlyActivated, setOnlyActivated] = useState(true)
  // Collapsed by default, and this panel and the log below it both opened
 // fully expanded, which put two long lists at the top of the page before
  // anything that needed reading.
  const [expanded, setExpanded] = useState(false)
  // Once everything is read the panel still answers "what changed lately", so
  // the expanded state has to be able to show more than the worklist. Only
  // meaningful when there is nothing unread, which is the only time `recent`
  // is non-null.
  const [showAll, setShowAll] = useState(false)
  const { activated, ready } = useActivatedPlatforms()

  const { data } = useCatalogueChanges()

  const acknowledge = useMutation({
    mutationFn: (model: { platform: string; modelId: string }) =>
      apiFetch('/api/models/changes/acknowledge', { method: 'POST', body: JSON.stringify(model) }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['catalogue-changes'] }),
  })

  // One gesture for both lists. The body carries what is ON SCREEN, not
  // everything unread: the activated-provider filter is a view choice, and
  // marking a hidden provider's arrivals read would silence news nobody was
  // shown. Collapsing is part of the same act — the panel is a worklist, and
  // an emptied one that stays open is just the same list with more space.
  const acknowledgeAll = useMutation({
    mutationFn: (body: { arrived: { platform: string; modelId: string }[]; departed: { platform: string; modelId: string }[] }) =>
      apiFetch(BULK_ACK_PATH, { method: 'POST', body: JSON.stringify(body) }),
    onSuccess: () => {
      setExpanded(false)
      setShowAll(false)
      queryClient.invalidateQueries({ queryKey: ['catalogue-changes'] })
    },
  })

  const filtering = onlyActivated && ready
  const arrivedAll = data?.arrived ?? []
  const departedAll = data?.departed ?? []
  // Order matters: the provider filter FIRST, then the read/unread decision.
  // The other way round, a hidden unread row would keep the panel claiming to
  // be a worklist while showing nothing — "0 arrived" beside an urgent-looking
  // summary, and no recent list either.
  const arrivedPool = filtering
    ? partitionByActivated(arrivedAll, activated).shown
    : arrivedAll
  const departedPool = filtering
    ? partitionByActivated(departedAll, activated).shown
    : departedAll
  const hidden = filtering
    ? partitionByActivated(arrivedAll, activated).hidden.length + partitionByActivated(departedAll, activated).hidden.length
    : 0
  const selection = unreadSelection({ arrived: arrivedPool, departed: departedPool })
  const arrived = selection.arrived
  const departed = selection.departed

  // Nothing at all in the window: the catalogue has not moved, and an empty
  // shell would read as a broken panel.
  if (arrivedAll.length === 0 && departedAll.length === 0) return null

  const routedArrivals = arrived.filter(m => m.routed).length
  const quiet = !selection.hasUnread
  // The header states the real number, never the cap: three changes in view
  // must not read as ten.
  const totalInView = arrivedPool.length + departedPool.length
  const head = quiet ? (showAll ? totalInView : Math.min(RECENT_HEAD, totalInView)) : arrived.length + departed.length
  const canShowAll = quiet && !showAll && totalInView > RECENT_HEAD

  // "Show all" honours the same provider filter as everything else here, so
  // widening the list cannot leak rows the panel is otherwise hiding and make
  // the count disagree with what is on screen.
  const rowsShown = showAll
    ? [
      ...arrivedPool.map(m => ({ kind: 'arrived' as const, at: m.firstSeenAt, model: m })),
      ...departedPool.map(m => ({ kind: 'departed' as const, at: m.retiredAt, model: m })),
    ].sort((a, b) => (stampOf(b.at) < stampOf(a.at) ? -1 : stampOf(b.at) > stampOf(a.at) ? 1 : 0))
    : selection.recent ?? []

  const markAllRead = () => acknowledgeAll.mutate({
    arrived: arrived.map(m => ({ platform: m.platform, modelId: m.modelId })),
    departed: departed.map(m => ({ platform: m.platform, modelId: m.modelId })),
  })

  return (
    <section className="rounded-xl border p-4">
      <button
        type="button"
        onClick={() => setExpanded(v => !v)}
        aria-expanded={expanded}
        className="flex w-full items-start gap-2 text-left"
      >
        {expanded ? <ChevronDown className="mt-0.5 size-4 flex-shrink-0 text-muted-foreground" />
                  : <ChevronRight className="mt-0.5 size-4 flex-shrink-0 text-muted-foreground" />}
        <span className="min-w-0 flex-1">
          <span className="flex flex-wrap items-center gap-2">
            <h2 className="text-sm font-medium">{t('catalogue.changesTitle')}</h2>
            {quiet ? (
              <Badge variant="outline" className="tabular-nums">{t('catalogue.changesAllRead')}</Badge>
            ) : (
              <Badge variant="secondary" className="tabular-nums">
                {t('catalogue.changesSummary', { arrived: arrived.length, departed: departed.length })}
              </Badge>
            )}
            {/* An arrival already serving traffic is the row that cannot wait
                for someone to expand a panel, so its count sits in the
                summary. */}
            {routedArrivals > 0 && (
              <Badge variant="destructive" className="tabular-nums">
                {t('catalogue.changesSummaryUrgent', { count: routedArrivals })}
              </Badge>
            )}
          </span>
          <span className="mt-0.5 block text-xs text-muted-foreground">
            {quiet
              ? t('catalogue.changesAllReadHint', { count: head })
              : t('catalogue.changesHint', { since: formatStamp(data?.since ?? '', { time: true }) })}
            {data && data.untrackedArrivals > 0
              ? ` ${t('catalogue.untracked', { count: data.untrackedArrivals })}`
              : ''}
          </span>
        </span>
        <span className="sr-only">{expanded ? t('catalogue.hideDetail') : t('catalogue.showDetail')}</span>
      </button>

      {/* The worklist and the quiet head are different questions, so they render
          through different branches rather than one list that happens to be
          empty. A quiet panel gets the newest few as a plain list — handing ten
          rows to TimeTreeLog would show all ten expanded and hide the history
          folds it only offers past `foldAbove`. */}
      {expanded && quiet && (
        <div className="mt-3">
          <h3 className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
            {showAll ? <History className="size-3.5" /> : <Clock className="size-3.5" />}
            {showAll ? t('catalogue.changesAll', { count: head }) : t('catalogue.changesRecent', { count: head })}
          </h3>
          <ul className="mt-1.5 divide-y divide-border">
            {rowsShown.map(change => (
              <li key={`${change.kind}:${change.model.platform}:${change.model.modelId}`} className="flex flex-wrap items-center gap-2 py-1 text-xs">
                {change.kind === 'arrived'
                  ? <PackagePlus className="size-3.5 flex-shrink-0 text-muted-foreground" />
                  : <PackageMinus className="size-3.5 flex-shrink-0 text-muted-foreground" />}
                <span className="text-muted-foreground">{change.model.platform}</span>
                <span className="font-mono">{change.model.modelId}</span>
                <span className="ml-auto text-muted-foreground tabular-nums">{formatStamp(change.at, { time: true })}</span>
              </li>
            ))}
          </ul>
          {(canShowAll || showAll) && (
            <button
              type="button"
              onClick={() => setShowAll(v => !v)}
              className="mt-2 text-[11px] text-muted-foreground underline decoration-dotted hover:text-foreground"
            >
              {showAll ? t('catalogue.changesShowRecent') : t('catalogue.changesShowAll')}
            </button>
          )}
        </div>
      )}

      {!quiet && !expanded && (arrived.length > 0 || departed.length > 0) && (
        <div className="mt-3 flex justify-end">
          <ConfirmButton
            size="xs"
            variant="outline"
            onConfirm={markAllRead}
            confirmLabel={t('catalogue.changesMarkReadConfirm')}
            disabled={acknowledgeAll.isPending}
            title={t('catalogue.changesMarkReadHint')}
          >
            {t('catalogue.changesMarkRead', { count: arrived.length + departed.length })}
          </ConfirmButton>
        </div>
      )}

      {expanded && !quiet && arrived.length > 0 && (
        <div className="mt-3">
          <h3 className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
            <PackagePlus className="size-3.5" />
            {t('catalogue.arrived', { count: arrived.length })}
          </h3>
          {/* Same three steps as the log below: the 10 newest, the rest of the
              month, then Year > Month > Week > Day. A sync can land dozens at
              once, and a flat list of them pushed everything else off screen. */}
          <div className="mt-1.5">
          <TimeTreeLog<ArrivedModel>
            unit="month"
            recentLabel={t('catalogue.latest')}
            items={arrived}
            at={arrivedAt}
            itemKey={arrivedKey}
            summary={items => {
              const routed = items.filter(m => m.routed).length
              return (
                <span className="tabular-nums">
                  {t('catalogue.arrived', { count: items.length })}
                  {routed > 0 && <span className="text-rose-600 dark:text-rose-400">{' · '}{t('catalogue.changesSummaryUrgent', { count: routed })}</span>}
                </span>
              )
            }}
            row={m => (
              <div className="flex flex-wrap items-center gap-2 text-xs">
                <span className="text-muted-foreground">{m.platform}</span>
                <span className="font-mono">{m.modelId}</span>
                {/* A model that arrived AND is already serving is the urgent
                    row: it is answering requests nobody chose it for. One
                    sitting unrouted is information, not an incident. */}
                {m.routed
                  ? <Badge variant="destructive">{t('catalogue.autoRouted', { chains: m.chains.join(', ') })}</Badge>
                  : <Badge variant="outline">{t('catalogue.notRouted')}</Badge>}
                <span className="ml-auto text-muted-foreground tabular-nums">{formatStamp(m.firstSeenAt, { time: true })}</span>
              </div>
            )}
          />
          </div>
        </div>
      )}

      {expanded && !quiet && departed.length > 0 && (
        <div className="mt-4">
          <h3 className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
            <PackageMinus className="size-3.5" />
            {t('catalogue.departed', { count: departed.length })}
          </h3>
          <div className="mt-1.5">
          <TimeTreeLog<DepartedModel>
            unit="month"
            recentLabel={t('catalogue.latest')}
            items={departed}
            at={departedAt}
            itemKey={departedKey}
            summary={items => {
              const lost = items.filter(m => m.lostFrom.length > 0).length
              return (
                <span className="tabular-nums">
                  {t('catalogue.departed', { count: items.length })}
                  {lost > 0 && <span className="text-rose-600 dark:text-rose-400">{' · '}{t('catalogue.lostChains', { count: lost })}</span>}
                </span>
              )
            }}
            row={m => (
              <div className="text-xs">
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
                  <span className="ml-auto text-muted-foreground tabular-nums">{formatStamp(m.retiredAt, { time: true })}</span>
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
              </div>
            )}
          />
          </div>
        </div>
      )}

      {expanded && (hidden > 0 || !onlyActivated) && (
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

// SQLite UTC to a comparable string, for ordering a mixed arrival/departure
// list. Both lists are already `YYYY-MM-DD HH:MM:SS`, so a space replaced with
// a `T` sorts correctly without inventing a Date.
const stampOf = (iso: string) => iso.replace(' ', 'T')

// Module-level so the tree's memo keys stay stable across renders.
const arrivedAt = (m: ArrivedModel) => parseSqliteUtc(m.firstSeenAt)
const arrivedKey = (m: ArrivedModel) => `${m.platform}:${m.modelId}`
const departedAt = (m: DepartedModel) => parseSqliteUtc(m.retiredAt)
const departedKey = (m: DepartedModel) => `${m.platform}:${m.modelId}`
