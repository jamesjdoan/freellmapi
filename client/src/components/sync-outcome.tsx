import { useI18n } from '@/i18n'

// What a manual "Check for updates" actually did. The server always said; the
// page used to spin the icon and show nothing, so finding nothing new, applying
// an update and failing all looked the same.

export interface SyncChanges {
  added: number
  removed: number
  changed: number
  switchedOff: number
  switchedOn: number
}

export interface SyncResultView {
  ok: boolean
  action: 'applied' | 'up_to_date' | 'skipped_older' | 'error'
  version?: string
  detail?: string
  changes?: SyncChanges
}

export function SyncOutcome({ result, error, at }: { result: SyncResultView | null; error: string | null; at: Date | null }) {
  const { t } = useI18n()
  if (!result && !error) return null
  const when = at ? at.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' }) : null

  let tone = 'text-muted-foreground'
  let text: string
  if (error || !result || result.action === 'error') {
    tone = 'text-destructive'
    text = t('premium.syncFailed', { error: error ?? result?.detail ?? '' })
  } else if (result.action === 'up_to_date') {
    text = t('premium.syncUpToDate', { version: result.version ?? '' })
  } else if (result.action === 'skipped_older') {
    text = t('premium.syncSkippedOlder', { version: result.version ?? '' })
  } else {
    tone = 'text-emerald-600 dark:text-emerald-400'
    const c = result.changes
    const parts = c
      ? [
          c.added > 0 && t('premium.syncPartAdded', { count: c.added }),
          c.removed > 0 && t('premium.syncPartRemoved', { count: c.removed }),
          c.switchedOff > 0 && t('premium.syncPartOff', { count: c.switchedOff }),
          c.switchedOn > 0 && t('premium.syncPartOn', { count: c.switchedOn }),
          c.changed > 0 && t('premium.syncPartChanged', { count: c.changed }),
        ].filter(Boolean)
      : []
    text = `${t('premium.syncAppliedHead', { version: result.version ?? '' })}: ${parts.length ? parts.join(', ') : t('premium.syncNoModelChanges')}`
  }

  return (
    <p role="status" className={`mt-2 text-xs ${tone}`}>
      {text}
      {when && <span className="ml-2 text-muted-foreground tabular-nums">{when}</span>}
    </p>
  )
}
