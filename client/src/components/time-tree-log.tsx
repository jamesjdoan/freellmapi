import { useMemo, useState, type ReactNode } from 'react'
import { ChevronRight } from 'lucide-react'
import { useI18n } from '@/i18n'
import { buildTimeTree, defaultOpenIds, type TimeTreeNode } from '@/lib/time-tree'

// A long append-only log, folded into Year > Month > Week > Day.
//
// Shared by the catalogue log and the routing-decision (shadow) log: both are
// streams that grow without bound and are read the same way — "what happened
// lately", then occasionally "what happened back then". A flat list answers
// the first badly and the second not at all.
//
// Everything is shut except the path to the current week, whose days stay shut
// too. So the resting view is a few rows, and every shut row carries a summary
// of what it contains — collapsing hides the detail, never the fact that
// something happened. That last part is why `summary` is required rather than
// optional: a fold with no summary is a place for things to go missing.

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
  /** Injected in tests so the open-by-default week is not wall-clock bound. */
  now?: Date
}

const LEVEL_INDENT: Record<string, string> = {
  year: 'pl-0',
  month: 'pl-3',
  week: 'pl-6',
  day: 'pl-9',
}

export function TimeTreeLog<T>({ items, at, summary, row, itemKey, now }: TimeTreeLogProps<T>) {
  const { locale, t } = useI18n()
  const tree = useMemo(() => buildTimeTree(items, at, now), [items, at, now])
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

  if (tree.length === 0) return null

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

  return <ul className="space-y-0.5">{tree.map(renderNode)}</ul>
}
