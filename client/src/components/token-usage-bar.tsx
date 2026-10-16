import { useEffect, useRef, useState } from 'react'
import { ChevronDown } from 'lucide-react'
import { useI18n } from '@/i18n'
import { buildBudgetLegend } from '@/lib/budget-legend'
import { formatTokens, platformColors, type TokenUsageData } from '@/lib/routing'

const LEGEND_COLLAPSED_PX = 126

// Estimated capacity and recorded usage are separate quantities. The bar
// counts shared allowances once, never claims a live remaining balance.
export function TokenUsageBar({ data }: { data: TokenUsageData }) {
  const { t } = useI18n()
  const { totalBudget, totalUsed, models } = data

  const { rows, unpublishedCount } = buildBudgetLegend(models, totalBudget)

  const [expanded, setExpanded] = useState(false)
  const [collapsible, setCollapsible] = useState(false)
  // The legend's full height, measured in the effect (refs are not read during
  // render) so the expanded max-height animates to the real size.
  const [fullHeight, setFullHeight] = useState<number>()
  const legendRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const el = legendRef.current
    if (!el) return
    const check = () => {
      setFullHeight(el.scrollHeight)
      setCollapsible(el.scrollHeight > LEGEND_COLLAPSED_PX + 1)
    }
    check()
    const ro = new ResizeObserver(check)
    ro.observe(el)
    return () => ro.disconnect()
  }, [rows.length, unpublishedCount])

  return (
    <section id="quota-pools" className="scroll-mt-20 rounded-3xl border bg-card p-5">
      <div className="flex flex-wrap items-baseline justify-between gap-2 mb-3">
        <h2 className="text-sm font-medium">{t('models.monthlyTokenBudget')}</h2>
        <span className="text-xs text-muted-foreground tabular-nums">
          <span className="text-foreground font-medium">{formatTokens(totalBudget)}</span>
          <span className="mx-1.5">·</span>
          <span className="cursor-help underline decoration-dotted underline-offset-2" title={t('models.usedScopeHint')}>
            {t('models.recordedChatUsage', { count: formatTokens(totalUsed) })}
          </span>
        </span>
      </div>

      <p className="mb-3 text-xs text-muted-foreground">{t('models.capacityEstimateHint')}</p>
      <div className="flex h-2.5 rounded-full overflow-hidden bg-muted">
        {rows.map(m => (
          <div
            key={m.poolKey}
            title={`${m.memberNames.join(', ')} (${m.platform}): ${formatTokens(m.budget)}`}
            style={{
              width: `${m.widthPct}%`,
              backgroundColor: platformColors[m.platform] ?? '#94a3b8',
            }}
          />
        ))}
      </div>

      <div
        ref={legendRef}
        className="mt-4 overflow-hidden transition-[max-height] duration-300 ease-in-out"
        style={collapsible ? { maxHeight: expanded ? fullHeight : LEGEND_COLLAPSED_PX } : undefined}
      >
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-x-5 gap-y-1.5 text-xs tabular-nums">
          {rows.map(m => (
            <div key={m.poolKey} className="flex items-center gap-2 min-w-0">
              <span
                className="size-2 rounded-sm flex-shrink-0"
                style={{ backgroundColor: platformColors[m.platform] ?? '#94a3b8' }}
              />
              <span className="truncate" title={m.memberNames.join(', ')}>
                {m.displayName}{m.memberNames.length > 1 ? ` +${m.memberNames.length - 1}` : ''}
              </span>
              <span className="flex-1" />
              <span
                className="font-mono text-muted-foreground"
                title={t('models.legendRemainingTitle', { name: m.memberNames.join(', '), platform: m.platform })}
              >
                {formatTokens(m.budget)}
              </span>
            </div>
          ))}
        </div>
      </div>

      {/* Outside the collapsible box on purpose: it is a summary of what the
          legend is NOT showing, so it has to stay visible while collapsed. */}
      {unpublishedCount > 0 && (
        <p className="mt-1.5 text-xs text-muted-foreground" title={t('models.noPublishedQuotaTitle')}>
          {t('models.noPublishedQuota', { count: unpublishedCount })}
        </p>
      )}

      {collapsible && (
        <button
          onClick={() => setExpanded(e => !e)}
          className="mt-2 flex w-full items-center justify-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors"
        >
          {expanded ? t('models.showLess') : t('models.showAllAllowances', { count: rows.length })}
          <ChevronDown className={`size-3.5 transition-transform duration-300 ${expanded ? 'rotate-180' : ''}`} />
        </button>
      )}
    </section>
  )
}
