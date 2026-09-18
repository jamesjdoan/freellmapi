/**
 * One way to print a moment, shared by the catalogue panels.
 *
 * They had three conventions between them: the changes panel printed a raw ISO
 * slice ("2026-09-16"), the log printed "16 Sept 02:54 pm", and the tree
 * headers print a locale long form. Two panels sitting one above the other,
 * describing the same events, in two vocabularies.
 *
 * Same reasoning as `formatCountdown` in lib/countdown.ts: when two surfaces
 * answer the same question they share the formatter, or they drift.
 *
 * The year appears only when it is not the current one. A log of this year's
 * churn repeating "2026" on every row is noise; a row from last year that does
 * not say so is a bug.
 */

/** A SQLite UTC timestamp ("YYYY-MM-DD HH:MM:SS") or an ISO string. */
export function parseStamp(value: string): Date {
  const trimmed = (value ?? '').trim()
  if (!trimmed) return new Date(NaN)
  // SQLite's `datetime('now')` has no zone marker and IS UTC; parsing it as
  // local time shifts every row by the offset.
  const sqlite = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(trimmed)
  return new Date(sqlite ? `${trimmed.replace(' ', 'T')}Z` : trimmed)
}

export function formatStamp(value: string | Date, opts: { time?: boolean } = {}): string {
  const date = value instanceof Date ? value : parseStamp(value)
  if (Number.isNaN(date.getTime())) return '—'
  const sameYear = date.getFullYear() === new Date().getFullYear()
  const day = date.toLocaleDateString(undefined, {
    day: '2-digit',
    month: 'short',
    ...(sameYear ? {} : { year: 'numeric' }),
  })
  if (!opts.time) return day
  const time = date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
  return `${day} ${time}`
}
