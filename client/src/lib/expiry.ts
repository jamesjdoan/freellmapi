// A countdown to a model's free-access end.
//
// The date is the provider's, not ours: Vercel's $0 MiniMax promotion ends at
// a moment, and the operator wants to see that coming. It is a REMINDER only.
// Nothing switches off when the countdown reaches zero — a promotion ending
// is not a model breaking, and the operator said so (2026-10-22).
//
// The countdown ticks once a minute: seconds would be noise on a deadline
// measured in days.
//
// The helpers live here rather than beside the component, so the component's
// file exports only a component (react-refresh).

/** "2d 4h 19m" — days, hours and minutes, the units that matter here. */
export function formatExpiryCountdown(msLeft: number, t: (key: string, vars?: Record<string, string | number>) => string): string {
  if (msLeft <= 0) return t('keys.expiryPassed')
  const totalMinutes = Math.floor(msLeft / 60_000)
  const days = Math.floor(totalMinutes / 1440)
  const hours = Math.floor((totalMinutes % 1440) / 60)
  const minutes = totalMinutes % 60
  if (days > 0) return t('keys.expiryCountdownDays', { days, hours, minutes })
  if (hours > 0) return t('keys.expiryCountdownHours', { hours, minutes })
  return t('keys.expiryCountdownMinutes', { minutes })
}

/** The date, in the reader's own timezone. */
export function formatExpiryDate(iso: string, locale: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return iso
  // dateStyle/timeStyle together are not allowed with timeZoneName, and the
  // combination is refused outright in some runtimes, so the parts are spelled
  // out.
  return new Intl.DateTimeFormat(locale, {
    year: 'numeric', month: 'short', day: 'numeric',
    hour: '2-digit', minute: '2-digit', timeZoneName: 'short',
  }).format(date)
}
