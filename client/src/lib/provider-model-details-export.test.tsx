import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { ProviderQuotaGuidance } from '../../../shared/types'
import {
  formatProviderModelDetails,
  type ProviderModelDetailsExport,
} from './provider-model-details-export'
import { ProviderModelDetailsCopyAction } from '../components/keys/provider-model-details-copy-action'

const guidance: ProviderQuotaGuidance = {
  platform: 'groq',
  displayName: 'Groq',
  scope: 'model',
  status: 'verified',
  currentAccess: 'available',
  summary: 'Free limits are published per model.',
  verifiedAt: '2026-09-02',
  reviewAfter: '2026-10-02',
  recommendedLimits: null,
  facts: [{ metric: 'requests', amount: null, period: 'provider_defined', label: 'Independent limits per model', applicability: 'reference_only' }],
  sources: [{ kind: 'official_documentation', title: 'Groq rate limits', url: 'https://console.groq.com/docs/rate-limits', checkedAt: '2026-09-02' }],
  models: [{
    modelId: 'openai/gpt-oss-120b',
    scope: 'model',
    status: 'verified',
    summary: 'Published free-plan allowance.',
    recommendedLimits: { rpmLimit: 30, rpdLimit: 1000, tpmLimit: 8000, tpdLimit: 200000 },
    facts: [{ metric: 'tokens', amount: 200000, period: 'day', label: '200,000 tokens/day', applicability: 'enforceable' }],
    advisory: null,
  }],
  advisory: null,
}

const input: ProviderModelDetailsExport = {
  providerName: 'Groq',
  platform: 'groq',
  modelSource: 'catalog',
  accountLimits: { rpmLimit: 20, rpdLimit: 500, tpmLimit: null, tpdLimit: null },
  guidance,
  models: [{
    displayName: 'GPT-OSS 120B',
    modelId: 'openai/gpt-oss-120b',
    accessEnabled: true,
    routingEnabled: true,
    sizeLabel: 'Frontier',
    contextWindow: 131072,
    supportsVision: false,
    supportsTools: true,
    monthlyAllowance: '6.0M/mo',
    limits: { rpmLimit: 30, rpdLimit: 1000, tpmLimit: 8000, tpdLimit: 200000 },
  }],
}

describe('provider model details export', () => {
  it('produces concise Markdown with provider, model, capability, limit, and evidence details', () => {
    const text = formatProviderModelDetails(input)

    expect(text).toContain('# FreeLLMAPI provider review: Groq')
    expect(text).toContain('FreeLLMAPI free catalogue')
    expect(text).toContain('Provider account limits: RPM 20 · RPD 500')
    expect(text).toContain('**GPT-OSS 120B** — `openai/gpt-oss-120b`')
    expect(text).toContain('Access enabled · Routing enabled')
    expect(text).toContain('Frontier · 131K context · Tools · No vision')
    expect(text).toContain('Model limits: RPM 30 · RPD 1,000 · TPM 8,000 · TPD 200,000')
    expect(text).toContain('Published guide: 200,000 tokens/day')
    expect(text).toContain('Verified 2026-09-02 · review after 2026-10-02')
    expect(text).toContain('[Groq rate limits](https://console.groq.com/docs/rate-limits)')
  })

  it('omits absent limits and never emits credential or internal identity fields', () => {
    const unsafe = {
      ...input,
      accountLimits: { rpmLimit: null, rpdLimit: null, tpmLimit: null, tpdLimit: null },
      apiKey: 'gsk_secret-value',
      maskedKey: 'gsk_...abcd',
      credentialLabel: 'James personal key',
      keyId: 42,
      models: [{ ...input.models[0], limits: { rpmLimit: null, rpdLimit: null, tpmLimit: null, tpdLimit: null }, modelDbId: 987 }],
    } as unknown as ProviderModelDetailsExport

    const text = formatProviderModelDetails(unsafe)
    expect(text).toContain('Provider account limits: not configured')
    expect(text).not.toContain('Model limits:')
    for (const forbidden of ['gsk_secret-value', 'gsk_...abcd', 'James personal key', 'keyId', 'modelDbId', '987']) {
      expect(text).not.toContain(forbidden)
    }
  })

  it('labels live-discovered models and renders a visible copy action', () => {
    const text = formatProviderModelDetails({ ...input, modelSource: 'live_discovery', guidance: null })
    expect(text).toContain('Live provider discovery; free-tier status requires verification')

    const html = renderToStaticMarkup(<ProviderModelDetailsCopyAction text={text} />)
    expect(html).toContain('Copy provider details')
    expect(html).toContain('aria-label="Copy provider model details"')
    expect(html).not.toContain(text)
  })
})
