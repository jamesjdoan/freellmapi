import { useI18n } from '@/i18n'
import type { TokenEfficiency } from '@freellmapi/shared/types'

// Token efficiency, printed the same way on every surface
// (ADR ARCH-20261020).
//
// Three states, and they must never be confused:
//   - an AA ESTIMATE: a token range (all-output to all-input price), because
//     AA gives no input/output split of its cost; the 3:1 blend is in the
//     tooltip and is what the column sorts on;
//   - a SCREEN measurement: a token count, marked as a screen;
//   - unknown: a dash.

/** 1.4K rather than 1400 — a column of token counts is read at a glance. */
function compactTokens(tokens: number): string {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M`
  if (tokens >= 1000) return `${(tokens / 1000).toFixed(1)}K`
  return String(Math.round(tokens))
}

export function TokenEfficiencyCell({ value }: { value: TokenEfficiency | null | undefined }) {
  const { t } = useI18n()
  if (!value) return <span className="text-muted-foreground">—</span>

  if (value.source === 'aa' && value.tokensLow != null && value.tokensHigh != null) {
    const tooltip = t('compare.tokensPerTaskAaTooltip', { tokens: compactTokens(value.tokensPerTask) })
    return (
      <span className="inline-flex items-center gap-1 whitespace-nowrap" title={tooltip}>
        <span className="tabular-nums">{compactTokens(value.tokensLow)}–{compactTokens(value.tokensHigh)}</span>
        {value.proxied && (
          <span className="text-[10px] italic text-muted-foreground">≈</span>
        )}
      </span>
    )
  }

  const tooltip = t('compare.tokensPerTaskScreenTooltip', {
    tokens: compactTokens(value.tokensPerTask),
    scenarios: value.scenariosCompleted ?? 0,
    version: value.benchVersion ?? '—',
  })
  return (
    <span className="inline-flex items-center gap-1" title={tooltip}>
      <span className="tabular-nums">{compactTokens(value.tokensPerTask)}</span>
      <span className="text-[10px] italic text-muted-foreground">{t('compare.tokensPerTaskScreen')}</span>
    </span>
  )
}
