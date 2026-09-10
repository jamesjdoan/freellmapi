import { useI18n } from '@/i18n'
import { Tooltip } from '@/components/tooltip'
import { Switch } from '@/components/ui/switch'
import { PROVIDER_CHURN_DAYS, shortDate } from '@/lib/catalogue-changes'
import type { ProviderChurn } from '@/lib/catalogue-changes'

// What this provider's catalogue has done lately, on the provider row itself.
//
// The chain page's panel answers "what arrived and what needs acknowledging"
// across the whole catalogue. This answers a different question, asked while
// looking at a key: is this provider still shipping, or has it been shedding
// models? Two providers with identical key health and model counts are not
// equivalent when one gained three models this fortnight and the other lost
// two.
//
// Deliberately one chip at rest. The Keys page's job is to compare every
// provider at a glance, and anything taller by default trades that away. The
// names and dates are one hover behind, and one click behind is the strip
// below, where each model can be switched into or out of this key's scope
// without opening the model-scope dialog.

export function ProviderChurnChip({ churn, expanded, onToggle }: {
  churn: ProviderChurn | undefined
  /** Omitted on a multi-key group header, where "this key's scope" has no
   *  single answer: the chip stays informational there. */
  expanded?: boolean
  onToggle?: () => void
}) {
  const { t } = useI18n()
  const added = churn?.arrived.length ?? 0
  const lost = churn?.departed.length ?? 0
  // A provider whose catalogue held still says nothing, rather than "+0 -0" on
  // every row - which is most rows, most of the time.
  if (added === 0 && lost === 0) return null

  const lines = [
    ...churn!.arrived.map(m => `+ ${m.displayName || m.modelId} · ${shortDate(m.firstSeenAt)}${m.routed ? ` · ${m.chains.join(', ')}` : ''}`),
    ...churn!.departed.map(m => `− ${m.modelId} · ${shortDate(m.retiredAt)}${m.lostFrom.length > 0 ? ` · ${t('catalogue.lostFrom', { chains: m.lostFrom.map(c => c.chain).join(', ') })}` : ''}`),
  ]
  const label = t('keys.churnAria', { days: PROVIDER_CHURN_DAYS, added, lost })
  const counts = (
    <>
      {added > 0 && <span className="text-emerald-600 dark:text-emerald-400">{`+${added}`}</span>}
      {lost > 0 && <span className="text-rose-600 dark:text-rose-400">{`−${lost}`}</span>}
      <span className="text-muted-foreground">{t('keys.churnWindow', { days: PROVIDER_CHURN_DAYS })}</span>
    </>
  )
  const shape = 'inline-flex items-center gap-1 rounded-full border px-1.5 py-0.5 text-[10px] tabular-nums decoration-dotted underline-offset-2 [text-decoration-line:underline]'

  // A real <button> when it opens something. The tooltip keeps its own tab
  // stop only in the informational case: giving a focusable button a
  // focusable wrapper would put two stops on one control.
  if (onToggle) {
    return (
      <Tooltip text={lines.join('\n')} className="inline-flex flex-shrink-0">
        <button
          type="button"
          onClick={onToggle}
          aria-expanded={expanded}
          aria-label={label}
          title={t('keys.churnExpandHint')}
          className={`${shape} ${expanded ? 'bg-muted' : ''} hover:bg-muted focus-visible:outline focus-visible:outline-1`}
        >
          {counts}
        </button>
      </Tooltip>
    )
  }

  return (
    <Tooltip text={lines.join('\n')} focusable className="inline-flex flex-shrink-0 rounded-full focus-visible:outline focus-visible:outline-1">
      <span className={shape} aria-label={label}>{counts}</span>
    </Tooltip>
  )
}

/**
 * The expanded strip: every model this provider gained or lost lately, each
 * with the switch that decides whether THIS key may serve it.
 *
 * The switch writes the key's model scope, which is what the `n/m models
 * enabled` badge on the same row counts - so the number moves as you flip
 * them. It is not chain membership: a newly arrived model also has to be in a
 * routing chain before it serves traffic, and that stays on the chain page,
 * where the ordering it affects is visible.
 *
 * A retired model gets a switch ONLY while its id is still sitting in the
 * scope. Retirement deletes the catalogue row outright - a tombstone is all
 * that is left - so the id resolves to nothing, is not in the picker's list and
 * is not counted by the `n/m` badge. Where the scope still holds it, taking it
 * out is real cleanup of a stale entry. Where it does not, there is nothing to
 * toggle, and a switch would be a control over nothing.
 */
export function ProviderChurnPanel({ churn, isServed, onSetServed, pending, disabledReason }: {
  churn: ProviderChurn | undefined
  isServed: (modelId: string) => boolean
  onSetServed: (modelId: string, served: boolean) => void
  pending: boolean
  /** Set when a switch cannot be honoured - the last served model, which the
   *  scope column cannot express. Shown instead of failing silently. */
  disabledReason: (modelId: string) => string | null
}) {
  const { t } = useI18n()
  if (!churn || (churn.arrived.length === 0 && churn.departed.length === 0)) return null

  const rows = [
    ...churn.arrived.map(m => ({
      // An arrival is in the catalogue, so its switch always means something -
      // off is a real exclusion, not a no-op.
      actionable: true,
      key: `+${m.modelId}`,
      modelId: m.modelId,
      name: m.displayName || m.modelId,
      date: shortDate(m.firstSeenAt),
      arrived: true,
      note: m.routed ? t('catalogue.autoRouted', { chains: m.chains.join(', ') }) : t('catalogue.notRouted'),
      noteIsWarning: m.routed,
    })),
    ...churn.departed.map(m => ({
      // Only when the stale id is actually there to remove.
      actionable: isServed(m.modelId),
      key: `-${m.modelId}`,
      modelId: m.modelId,
      name: m.modelId,
      date: shortDate(m.retiredAt),
      arrived: false,
      note: m.lostFrom.length > 0
        ? t('catalogue.lostFrom', { chains: m.lostFrom.map(c => c.chain).join(', ') })
        : null,
      noteIsWarning: true,
    })),
  ]

  return (
    <div className="border-t bg-muted/20 px-4 py-3 pl-12">
      <p className="mb-2 text-[11px] text-muted-foreground">{t('keys.churnPanelHint')}</p>
      <ul className="space-y-1.5">
        {rows.map(row => {
          const blocked = disabledReason(row.modelId)
          const served = isServed(row.modelId)
          return (
            <li key={row.key} className="flex items-center gap-2 text-xs">
              <span
                className={`w-3 flex-shrink-0 text-center font-medium ${row.arrived ? 'text-emerald-600 dark:text-emerald-400' : 'text-rose-600 dark:text-rose-400'}`}
                aria-label={t(row.arrived ? 'catalogue.arrived' : 'catalogue.departed', { count: 1 })}
              >
                {row.arrived ? '+' : '−'}
              </span>
              <span className="min-w-0 flex-1 truncate font-medium" title={row.modelId}>{row.name}</span>
              {row.note && (
                <span className={`hidden flex-shrink-0 text-[11px] sm:inline ${row.noteIsWarning ? 'text-destructive' : 'text-muted-foreground'}`}>
                  {row.note}
                </span>
              )}
              <span className="flex-shrink-0 text-[11px] text-muted-foreground tabular-nums">{row.date}</span>
              {!row.actionable ? (
                <span className="flex-shrink-0 text-[11px] text-muted-foreground" title={t('keys.churnNotScopedHint')}>
                  {t('keys.churnNotScoped')}
                </span>
              ) : blocked ? (
                <Tooltip text={blocked} focusable className="inline-flex flex-shrink-0 rounded focus-visible:outline focus-visible:outline-1">
                  <Switch size="sm" checked={served} disabled aria-label={row.modelId} />
                </Tooltip>
              ) : (
                <Switch
                  size="sm"
                  checked={served}
                  disabled={pending}
                  onCheckedChange={next => onSetServed(row.modelId, next)}
                  aria-label={row.modelId}
                  className="flex-shrink-0"
                />
              )}
            </li>
          )
        })}
      </ul>
    </div>
  )
}
