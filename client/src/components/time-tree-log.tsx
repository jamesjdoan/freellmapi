import { useMemo, useState, type ReactNode } from 'react'
import { ChevronRight } from 'lucide-react'
import { useI18n } from '@/i18n'
import { buildTimeTree, defaultOpenIds, mostRecent, type TimeTreeNode } from '@/lib/time-tree'

// A long append-only log: the most recent changes in full, then the rest folded
// into Year > Month > Week > Day.
//
// Shared by the catalogue log and the routing-decision (shadow) log: both are
// streams that grow without bound and are read the same way — "what happened
// lately", then occasionally "what happened back then". The flat head answers
// the first and the fold answers the second.
//
// Three rules decide what a reader sees at rest:
//   - the newest `recentCount` rows are ALWAYS shown in full, above the fold
//   - the fold appears only once there are more than `foldAbove` rows; below
//     that the flat list is already the whole log and a tree over ten rows is
//     ceremony
//   - inside the fold, today is open, and so is any fold holding a single day
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
  /** One row, rendered only when its day is expanded. */
  row: (item: T) => ReactNode
  /** Stable key per item. */
  itemKey: (item: T) => string
  /** Injected in tests so the open-by-default day is not wall-clock bound. */
  now?: Date
  /** Newest rows always shown in full. */
  recentCount?: number
  /** The fold only appears past this many rows. */
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
  recentCount = 10, foldAbove = 10, recentLabel,
}: TimeTreeLogProps<T>) {
  const { locale, t } = useI18n()
  const tree = useMemo(() => buildTimeTree(items, at, now), [items, at, now])
  const recent = useMemo(() => mostRecent(items, at, recentCount), [items, at, recentCount])
  // The fold keeps the WHOLE log, head included. Excluding the recent rows
  // would make every summary above disagree with the count beside it - "2
  // arrived" on a week that saw twelve.
  const folded = items.length > foldAbove
  // Seeded once from the tree rather than kept in sync with it: re-deriving on
  // every refetch would slam shut whatever the reader had just opened.
  const [open, setOpen] = useState<Set<string> | null>(null)
  const effective = open ?? defaultOpenIds(tree)

  const toggle = (id: string) => {
    setOpen(prev => {
      const next = new Set(prev ?? defaultOpenIds(tree))
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
        // A week label needs both ends: "week 37" alone means nothing to a
        // reader, and the month above it does not bound it (weeks straddle).
        const end = new Date(d.getTime() + 6 * 86_400_000)
        const opts: Intl.DateTimeFormatOptions = { day: 'numeric', month: 'short' }
        return `${d.toLocaleDateString(locale, opts)} – ${end.toLocaleDateString(locale, opts)}`
      }
      default:
        return d.toLocaleDateString(locale, { weekday: 'short', day: 'numeric', month: 'short' })
    }
  }

  if (items.length === 0) return null

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
          {/* Always visible, open or shut: a fold must never be the reason
              something went unnoticed. */}
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
    <div className="space-y-3">
      <div>
        {recentLabel && folded && (
          <p className="mb-1 text-[11px] font-medium text-muted-foreground">{recentLabel}</p>
        )}
        <ul className="space-y-1">
          {recent.map(i => <li key={itemKey(i)}>{row(i)}</li>)}
        </ul>
      </div>
      {folded && (
        <div className="border-t pt-2">
          <p className="mb-1 text-[11px] font-medium text-muted-foreground">{t('log.history')}</p>
          <ul className="space-y-0.5">{tree.map(renderNode)}</ul>
        </div>
      )}
    </div>
  )
}
