import { useEffect, useState } from 'react'
import { useI18n } from '@/i18n'
import { cn } from '@/lib/utils'
import { useExtensionEnabled } from '@/lib/use-extension'
import { formatExpiryCountdown, formatExpiryDate } from '@/lib/expiry'

// The chip on a model row: how long this model's free access has left.
//
// A REMINDER, not a switch. Nothing is disabled when the countdown reaches
// zero — a promotion ending is not a model breaking (2026-10-22).

export function ExpiryChip({ expiresAt, label }: { expiresAt: string; label: string | null }) {
  const { t, locale } = useI18n()
  // A minute tick, started once. `useState(() => Date.now())` rather than
  // Date.now() in render, which would be an impure render.
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 60_000)
    return () => clearInterval(id)
  }, [])
  const end = new Date(expiresAt).getTime()
  // `model-expiry` off: the reminder chip is hidden; the expiry data behind it
  // is untouched. Kept after the hooks above so a flip mid-session cannot
  // change how many hooks this component runs.
  if (!useExtensionEnabled('model-expiry')) return null
  if (Number.isNaN(end)) return null
  const left = end - now
  const passed = left <= 0
  const title = [
    label,
    t('keys.expiryEndsAt', { date: formatExpiryDate(expiresAt, locale) }),
    passed ? t('keys.expiryPassedHint') : t('keys.expiryCountdownHint'),
  ].filter(Boolean).join(' · ')
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 rounded-full border px-1.5 py-0.5 text-[10px] tabular-nums',
        passed ? 'border-rose-500/50 text-rose-700 dark:text-rose-400' : 'border-amber-500/50 text-amber-800 dark:text-amber-300',
      )}
      title={title}
    >
      <span aria-hidden className="size-1.5 rounded-full bg-current" />
      {formatExpiryCountdown(left, t)}
    </span>
  )
}
