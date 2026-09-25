import { useI18n } from '@/i18n'
import { useExtensionEnabled } from '@/lib/use-extension'
import {
  GRADED_CHAINS, evaluate, useEffectiveMinimums,
  type GradedChain, type ScoreRow,
} from '@/lib/chain-minimums'

// Where a model fits under the operator's chain minimums, shown on the row
// itself. Recommendation only - nothing here adds to or removes from a chain.
// It grades the AA scores and the chain's tools/vision contract, and nothing
// else: free, paid, quota and provider never enter it.

export function ChainFit({ score, chains }: { score: ScoreRow; chains: readonly string[] }) {
  const enabled = useExtensionEnabled('chain-minimums')
  const { doc, requirements } = useEffectiveMinimums()
  const { t } = useI18n()
  if (!enabled || !doc) return null
  const req = (c: GradedChain) => requirements.find(r => r.name === c)
  const results = GRADED_CHAINS.map(c => ({ chain: c, e: evaluate(score, doc.chains[c], req(c)) }))
  const fits = results.filter(r => r.e.status === 'fits').map(r => r.chain)
  // Current memberships that the minimums would not recommend. Fast-Lane is
  // not graded, so it never appears here.
  const misfits = results.filter(r => chains.includes(r.chain) && r.e.status !== 'fits')
  const why = (r: (typeof results)[number]) =>
    r.e.status === 'structural' ? t(`chainFit.missing_${r.e.missing[0]}`)
    : r.e.status === 'below' ? r.e.shortfalls.map(s => t('chainFit.shortfall', {
      metric: t(`chainMinimums.metric_${s.metric}`), value: s.value.toFixed(1), min: s.min,
    })).join(', ')
    : t('chainFit.unknown', { metrics: r.e.unknown.map(m => t(`chainMinimums.metric_${m}`)).join(', ') })
  if (fits.length === 0 && misfits.length === 0) return null
  return (
    <span className="inline-flex flex-wrap items-center gap-1">
      {fits.length > 0 && (
        <span className="rounded-full bg-emerald-500/12 px-1.5 py-0.5 text-[10px] text-emerald-800 dark:text-emerald-300">
          {t('chainFit.fits', { chains: fits.join(' · ') })}
        </span>
      )}
      {misfits.map(r => (
        <span
          key={r.chain}
          className={`rounded-full px-1.5 py-0.5 text-[10px] ${r.e.status === 'unknown' ? 'bg-muted text-muted-foreground' : 'bg-amber-500/15 text-amber-800 dark:text-amber-300'}`}
        >
          {t('chainFit.inChain', { chain: r.chain, why: why(r) })}
        </span>
      ))}
    </span>
  )
}
