import { useQuery } from '@tanstack/react-query'
import { useI18n } from '@/i18n'
import { apiFetch } from '@/lib/api'
import { Tooltip } from '@/components/tooltip'
import { formatStamp } from '@/lib/stamp'

// What is happening with THIS key, on the key's own row.
//
// The model panel answers "can this route serve" one row at a time. Sitting on
// a provider, the question is about the credential: is it limited, blocked, or
// fine. OpenCode is why this exists — eleven models each answering 403 or 404
// read as eleven unrelated failures, when the truth is one sentence.
//
// Silent when healthy. A badge on every provider is a badge nobody reads, and
// the whole value here is that the row which needs a decision stands out from
// the nine that do not.

export type ProviderVerdict =
  | 'healthy' | 'no_key' | 'key_unusable' | 'key_rejected' | 'account_blocked'
  | 'models_gone' | 'rate_limited' | 'degraded' | 'untested'

export interface ProviderDiagnosis {
  platform: string
  verdict: ProviderVerdict
  dominantCode: string | null
  sample: string | null
  keyed: boolean
  okModels: number
  failingModels: number
  activeCooldowns: number
  cause: string
  action: string
  selfHealing: boolean
  sinceMs: number | null
}

/** One fetch for every provider: the endpoint returns them all, so a query per
 *  row would be eleven requests for one answer. */
export function useProviderDiagnosis() {
  return useQuery({
    queryKey: ['keys', 'diagnosis'],
    queryFn: () => apiFetch<{ providers: ProviderDiagnosis[] }>('/api/keys/diagnosis'),
    staleTime: 60_000,
  })
}

/**
 * Ink by what the operator must do, not by severity in the abstract.
 *
 * Rose is reserved for states that WAITING WILL NOT FIX: a rejected key, a
 * blocked account, retired models. Amber is for the self-healing ones, where
 * the right response is usually patience. Healthy and untested get nothing at
 * all, which is what keeps the two rose rows visible.
 */
const TONE: Record<ProviderVerdict, string | null> = {
  healthy: null,
  untested: null,
  no_key: null,
  key_unusable: 'bg-rose-500/10 text-rose-700 dark:text-rose-400',
  key_rejected: 'bg-rose-500/10 text-rose-700 dark:text-rose-400',
  account_blocked: 'bg-rose-500/10 text-rose-700 dark:text-rose-400',
  models_gone: 'bg-rose-500/10 text-rose-700 dark:text-rose-400',
  rate_limited: 'bg-amber-500/10 text-amber-700 dark:text-amber-400',
  degraded: 'bg-amber-500/10 text-amber-700 dark:text-amber-400',
}

export function ProviderDiagnosisChip({ diagnosis }: { diagnosis: ProviderDiagnosis | undefined }) {
  const { t } = useI18n()
  if (!diagnosis || !diagnosis.keyed) return null
  const tone = TONE[diagnosis.verdict]
  if (!tone) return null

  // The provider's own words are the thing that says what actually happened, so
  // they are in the tooltip rather than dropped. Truncated, because a provider
  // error body can be a paragraph.
  const lines = [
    diagnosis.cause,
    diagnosis.action,
    diagnosis.okModels + diagnosis.failingModels > 0
      ? t('keys.diagnosisCounts', { ok: diagnosis.okModels, failing: diagnosis.failingModels })
      : null,
    diagnosis.activeCooldowns > 0
      ? t('keys.diagnosisCooldowns', { count: diagnosis.activeCooldowns })
      : null,
    diagnosis.sinceMs ? t('keys.diagnosisSince', { since: formatStamp(new Date(diagnosis.sinceMs), { time: true }) }) : null,
    diagnosis.sample ? `"${diagnosis.sample.slice(0, 160)}"` : null,
  ].filter(Boolean).join('\n')

  return (
    <Tooltip text={lines}>
      <span className={`inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 text-[10px] ${tone}`}>
        {t(`keys.verdict_${diagnosis.verdict}`)}
        {diagnosis.dominantCode && (
          <span className="font-mono opacity-70">{diagnosis.dominantCode}</span>
        )}
      </span>
    </Tooltip>
  )
}
