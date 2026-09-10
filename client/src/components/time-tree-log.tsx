import { useMemo, useState, type ReactNode } from 'react'
import { ChevronDown, ChevronRight } from 'lucide-react'
import { useI18n } from '@/i18n'
import {
  buildTimeTree,
  defaultOpenIds,
  mostRecent,
  withinCurrentUnit,
  type OpenDepth,
  type TimeTreeNode,
} from '@/lib/time-tree'

// A long append-only log, read in three steps rather than one.
//
// Shared by the catalogue log and the routing-decision (shadow) log: both grow
// without bound and are read the same way — "what just happened", then "the
// rest of today", then, rarely, "what happened back then". So:
//
//   1. the newest `recentCount` rows, always in full
//   2. one click for the REST of the period already on screen — the rest of
//      today for decisions, the rest of the month for the catalogue, since a
//      catalogue changes at the pace of a month and decisions by the dozen
//      per day
//   3. `Full history`, shut until asked for, holding the whole log folded into
//      Year > Month > Week > Day
//
// The section itself collapses too, because a log nobody is reading today
// should cost one line on the page and no more.
//
// Every shut fold carries a summary of what it contains, so collapsing hides
// the detail and never the fact that something happened. That is why `summary`
// is required rather than optional: a fold with no summary is a place for
// things to go missing.

export interface TimeTreeLogProps<T> {
  items: readonly T[]
  /** Reads the timestamp. Values from SQLite should go through
   *  `parseSqliteUtc` — see the note there about local-time drift. */
  at: (item: T) => Date
  /** One line describing a whole bucket, e.g. "+3 arrived · 1 retired". */
  summary: (items: readonly T[]) => ReactNode
  /** One row. */
  row: (item: T) => ReactNode
  /** Stable key per item. */
  itemKey: (item: T) => string
  /** The period step 2 reveals, and how deep the history opens. */
  unit?: OpenDepth
  /** Injected in tests so "today" is not wall-clock bound. */
  now?: Date
  /** Newest rows always shown in full. */
  recentCount?: number
  /** The history fold only exists past this many rows. */
  foldAbove?: number
  /** Heading for the flat head, e.g. "Latest changes". */
  recentLabel?: string
}

const LEVEL_INDENT: Record<string, string> = {
  year: 'pl-0',
  month: 'pl-3',
  week: 'pl-6',
  day: 'pl-9',
}

export function TimeTreeLog<T>({
  items, at, summary, row, itemKey, now,
  unit = 'day', recentCount = 10, foldAbove = 10, recentLabel,
}: TimeTreeLogProps<T>) {
  const { locale, t } = useI18n()
  const tree = useMemo(() => buildTimeTree(items, at, now), [items, at, now])
  const recent = useMemo(() => mostRecent(items, at, recentCount), [items, at, recentCount])
  const currentUnit = useMemo(() => withinCurrentUnit(items, at, unit, now), [items, at, unit, now])

  const [sectionOpen, setSectionOpen] = useState(true)
  const [restOpen, setRestOpen] = useState(false)
  // Shut until asked for. The head answers the common question; the tree is
  // for the rare one, and rendering it open buries the head under it.
  const [historyOpen, setHistoryOpen] = useState(false)
  // Seeded from the tree rather than kept in sync with it: re-deriving on every
  // refetch would slam shut whatever the reader had just opened.
  const [open, setOpen] = useState<Set<string> | null>(null)
  const effective = open ?? defaultOpenIds(tree, unit)

  const toggle = (id: string) => {
    setOpen(prev => {
      const next = new Set(prev ?? defaultOpenIds(tree, unit))
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const label = (node: TimeTreeNode<T>): string => {
    const d = node.start
    switch (node.level) {
      case 'year':
        return String(d.getFullYear())
      case 'month':
        return d.toLocaleDateString(locale, { month: 'long', year: 'numeric' })
      case 'week': {
        // A week label needs both ends: "week 37" means nothing to a reader,
        // and the month above does not bound it (weeks straddle months).
        const end = new Date(d.getTime() + 6 * 86_400_000)
        const opts: Intl.DateTimeFormatOptions = { day: 'numeric', month: 'short' }
        return `${d.toLocaleDateString(locale, opts)} – ${end.toLocaleDateString(locale, opts)}`
      }
      default:
        return d.toLocaleDateString(locale, { weekday: 'short', day: 'numeric', month: 'short' })
    }
  }

  if (items.length === 0) return null

  const folded = items.length > foldAbove
  // Only what step 2 would actually add: the rest of the period, minus the rows
  // already sitting in the head.
  const shownIds = new Set(recent.map(itemKey))
  const restOfUnit = currentUnit.filter(i => !shownIds.has(itemKey(i)))

  const renderNode = (node: TimeTreeNode<T>): ReactNode => {
    const isOpen = effective.has(node.id)
    const isDay = node.level === 'day'
    return (
      <li key={node.id} className={LEVEL_INDENT[node.level]}>
        <button
          type="button"
          onClick={() => toggle(node.id)}
          aria-expanded={isOpen}
          className="flex w-full items-center gap-1.5 rounded px-1 py-1 text-left text-xs hover:bg-muted/50"
        >
          <ChevronRight className={`size-3 flex-shrink-0 text-muted-foreground transition-transform ${isOpen ? 'rotate-90' : ''}`} />
          <span className={`flex-shrink-0 ${node.level === 'year' ? 'font-medium' : ''}`}>{label(node)}</span>
          {node.current && (
            <span className="flex-shrink-0 rounded-full border px-1 text-[10px] text-muted-foreground">
              {t('log.current')}
            </span>
          )}
          <span className="ml-auto min-w-0 truncate text-right text-[11px] text-muted-foreground">
            {summary(node.items)}
          </span>
        </button>
        {isOpen && (
          isDay
            ? (
              <ul className="mb-1 ml-4 space-y-1 border-l pl-3">
                {node.items.map(i => <li key={itemKey(i)}>{row(i)}</li>)}
              </ul>
            )
            : <ul>{node.children.map(renderNode)}</ul>
        )}
      </li>
    )
  }

  return (
    <div className="space-y-2">
      {/* The section's own fold. Shows the whole log's summary while shut, so
          collapsing it never hides that something happened. */}
      <button
        type="button"
        onClick={() => setSectionOpen(o => !o)}
        aria-expanded={sectionOpen}
        className="flex w-full items-center gap-1.5 rounded px-1 py-0.5 text-left text-[11px] font-medium text-muted-foreground hover:bg-muted/50"
      >
        <ChevronDown className={`size-3 flex-shrink-0 transition-transform ${sectionOpen ? '' : '-rotate-90'}`} />
        <span>{recentLabel ?? t('log.history')}</span>
        <span className="ml-auto truncate text-right font-normal">{summary(items)}</span>
      </button>

      {sectionOpen && (
        <>
          <ul className="space-y-1">
            {recent.map(i => <li key={itemKey(i)}>{row(i)}</li>)}
            {restOpen && restOfUnit.map(i => <li key={itemKey(i)}>{row(i)}</li>)}
          </ul>

          {restOfUnit.length > 0 && (
            <button
              type="button"
              onClick={() => setRestOpen(o => !o)}
              aria-expanded={restOpen}
              className="rounded px-1 py-0.5 text-[11px] text-muted-foreground underline decoration-dotted underline-offset-2 hover:text-foreground"
            >
              {restOpen
                ? t('log.restHide')
                : t(unit === 'day' ? 'log.restOfDay' : 'log.restOfMonth', { count: restOfUnit.length })}
            </button>
          )}

          {folded && (
            <div className="border-t pt-1.5">
              <button
                type="button"
                onClick={() => setHistoryOpen(o => !o)}
                aria-expanded={historyOpen}
                className="flex w-full items-center gap-1.5 rounded px-1 py-0.5 text-left text-[11px] font-medium text-muted-foreground hover:bg-muted/50"
              >
                <ChevronRight className={`size-3 flex-shrink-0 transition-transform ${historyOpen ? 'rotate-90' : ''}`} />
                <span>{t('log.history')}</span>
                <span className="ml-auto font-normal tabular-nums">{items.length}</span>
              </button>
              {historyOpen && <ul className="mt-1 space-y-0.5">{tree.map(renderNode)}</ul>}
            </div>
          )}
        </>
      )}
    </div>
  )
}
