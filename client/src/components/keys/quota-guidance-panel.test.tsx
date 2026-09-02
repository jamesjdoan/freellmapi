import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { ProviderQuotaGuidance } from '../../../../shared/types'
import { QuotaGuidancePanel } from './quota-guidance-panel'

const openRouter: ProviderQuotaGuidance = {
  platform: 'openrouter',
  displayName: 'OpenRouter',
  scope: 'shared_pool',
  status: 'verified',
  currentAccess: 'available',
  summary: 'Free requests share one account pool.',
  verifiedAt: '2026-09-02',
  reviewAfter: '2099-10-02',
  recommendedLimits: { rpmLimit: 20, rpdLimit: 50, tpmLimit: null, tpdLimit: null },
  facts: [{ metric: 'requests', amount: 50, period: 'day', label: '50 requests/day', applicability: 'enforceable' }],
  sources: [{ kind: 'official_documentation', title: 'OpenRouter FAQ', url: 'https://openrouter.ai/docs/faq', checkedAt: '2026-09-02' }],
  models: [],
  advisory: null,
}

describe('QuotaGuidancePanel', () => {
  it('renders allowance scope, provenance, freshness, and the reviewed apply action', () => {
    const html = renderToStaticMarkup(<QuotaGuidancePanel guidance={openRouter} onUseLimits={() => undefined} />)
    expect(html).toContain('50 requests/day')
    expect(html).toContain('Shared pool')
    expect(html).toContain('Verified 2 Sep 2026')
    expect(html).toContain('href="https://openrouter.ai/docs/faq"')
    expect(html).toContain('Use these limits')
    expect(html).not.toContain('disabled=""')
  })

  it('flags stale contradictory guidance and prevents applying it', () => {
    const html = renderToStaticMarkup(
      <QuotaGuidancePanel
        guidance={{
          ...openRouter,
          status: 'contradictory',
          currentAccess: 'payment_required',
          reviewAfter: '2020-01-01',
          advisory: { kind: 'research_needed', message: 'Published free access conflicts with this account.' },
        }}
        onUseLimits={() => undefined}
      />,
    )
    expect(html).toContain('Contradictory')
    expect(html).toContain('Needs review')
    expect(html).toContain('Published free access conflicts with this account.')
    expect(html).toContain('disabled=""')
  })

  it('renders unsupported economics as reference-only', () => {
    const html = renderToStaticMarkup(
      <QuotaGuidancePanel
        guidance={{
          ...openRouter,
          status: 'verified',
          recommendedLimits: null,
          facts: [{ metric: 'credits', amount: 0.1, period: 'month', label: '$0.10/month shared credit', applicability: 'reference_only' }],
        }}
        onUseLimits={() => undefined}
      />,
    )
    expect(html).toContain('$0.10/month shared credit')
    expect(html).toContain('Reference only')
    expect(html).not.toContain('Use these limits')
  })
})
