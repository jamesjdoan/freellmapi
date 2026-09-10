import { useI18n } from '@/i18n'
import { Tooltip } from '@/components/tooltip'
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
// Deliberately one chip. The Keys page's job is to compare every provider at a
// glance, and anything taller here trades that away — the names and dates are
// one hover behind, where they cost no vertical space.

export function ProviderChurnChip({ churn }: { churn: ProviderChurn | undefined }) {
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

  // Focusable on purpose: the names and dates live only in the tooltip, so
  // without a tab stop the detail is unreachable by keyboard. The counts stay
  // in the accessible name either way.
  return (
    <Tooltip text={lines.join('\n')} focusable className="inline-flex flex-shrink-0 rounded-full focus-visible:outline focus-visible:outline-1">
      <span
        className="inline-flex items-center gap-1 rounded-full border px-1.5 py-0.5 text-[10px] tabular-nums decoration-dotted underline-offset-2 [text-decoration-line:underline]"
        aria-label={t('keys.churnAria', { days: PROVIDER_CHURN_DAYS, added, lost })}
      >
        {added > 0 && <span className="text-emerald-600 dark:text-emerald-400">{`+${added}`}</span>}
        {lost > 0 && <span className="text-rose-600 dark:text-rose-400">{`−${lost}`}</span>}
        <span className="text-muted-foreground">{t('keys.churnWindow', { days: PROVIDER_CHURN_DAYS })}</span>
      </span>
    </Tooltip>
  )
}
