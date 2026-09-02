import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { ProviderQuotaGuidance } from '../../../shared/types'
import {
  formatFreeCatalogModels,
  formatProviderModelDetails,
  type ProviderModelDetailsExport,
} from './provider-model-details-export'
import { freeCatalogProviders } from './model-scope-selection'
import type { FallbackEntry } from './routing'
import { ProviderModelDetailsCopyAction } from '../components/keys/provider-model-details-copy-action'
import { FreeCatalogCopyAction } from '../components/keys/free-catalog-copy-action'

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

function entry(over: Partial<FallbackEntry>): FallbackEntry {
  return {
    modelDbId: 1,
    priority: 1,
    effectivePriority: 1,
    penalty: 0,
    rateLimitHits: 0,
    enabled: true,
    platform: 'groq',
    modelId: 'openai/gpt-oss-120b',
    displayName: 'GPT-OSS 120B',
    intelligenceRank: 1,
    speedRank: 1,
    sizeLabel: 'Frontier',
    rpmLimit: 30,
    rpdLimit: 1000,
    tpmLimit: null,
    tpdLimit: null,
    monthlyTokenBudget: '6.0M/mo',
    contextWindow: 131072,
    supportsVision: false,
    supportsTools: true,
    source: 'catalog',
    keyCount: 2,
    ...over,
  }
}

const catalogue: FallbackEntry[] = [
  entry({}),
  entry({ modelDbId: 2, modelId: 'moonshotai/kimi-k2', displayName: 'Kimi K2', enabled: false }),
  entry({ modelDbId: 3, modelId: 'openai/gpt-oss-120b', displayName: 'Duplicate row' }),
  entry({ modelDbId: 4, platform: 'cerebras', modelId: 'qwen-3-coder', displayName: 'Qwen 3 Coder', keyCount: 0, sizeLabel: 'Large', contextWindow: null, monthlyTokenBudget: '' }),
  entry({ modelDbId: 5, platform: 'nvidia', modelId: 'nvidia/nemotron', displayName: 'Nemotron', retiredUpstream: true, retiredReason: 'end of life' }),
  entry({ modelDbId: 6, platform: 'custom', modelId: 'local-llama', displayName: 'Local Llama', source: 'custom', keyLabel: 'Ollama box' }),
]

const names: Record<string, string> = { groq: 'Groq', cerebras: 'Cerebras' }
const providersFor = (scope: 'all' | 'active') =>
  freeCatalogProviders(catalogue, scope, platform => names[platform] ?? platform)

describe('free catalogue export', () => {
  it('covers every provider once per model id and excludes unverifiable custom relays', () => {
    const providers = providersFor('all')

    expect(providers.map(provider => provider.platform)).toEqual(['groq', 'cerebras', 'nvidia'])
    expect(providers[0].models.map(model => model.modelId)).toEqual(['openai/gpt-oss-120b', 'moonshotai/kimi-k2'])
    expect(providers[0].providerName).toBe('Groq')
    expect(providers[2].providerName).toBe('nvidia')
  })

  it('keeps only routable models for the active scope', () => {
    const providers = providersFor('active')

    expect(providers.map(provider => provider.platform)).toEqual(['groq'])
    expect(providers[0].models.map(model => model.modelId)).toEqual(['openai/gpt-oss-120b'])
  })

  it('formats one line per model with counts, state and limits', () => {
    const text = formatFreeCatalogModels({
      scope: 'all',
      capturedAt: '2026-09-02',
      providers: providersFor('all'),
    })

    expect(text).toContain('# FreeLLMAPI free catalogue: all models')
    expect(text).toContain('- Scope: every catalogue model, whatever its routing switch or key state')
    expect(text).toContain('custom relay endpoints are excluded because their free status is unverified')
    expect(text).toContain('- Captured: 2026-09-02')
    expect(text).toContain('- Providers: 3 · Models: 4')
    expect(text).toContain('## Groq — `groq` (2 usable keys · 2 models)')
    expect(text).toContain('## Cerebras — `cerebras` (0 usable keys · 1 models)')
    expect(text).toContain('**GPT-OSS 120B** — `openai/gpt-oss-120b` · routing enabled · Frontier · 131K context · Tools · No vision · allowance 6.0M/mo · RPM 30 · RPD 1,000')
    expect(text).toContain('**Kimi K2** — `moonshotai/kimi-k2` · routing disabled')
    expect(text).toContain('**Nemotron** — `nvidia/nemotron` · retired upstream')
    expect(text).not.toContain('Local Llama')
  })

  it('states the active scope and reports an empty catalogue honestly', () => {
    const active = formatFreeCatalogModels({ scope: 'active', capturedAt: '2026-09-02', providers: providersFor('active') })
    expect(active).toContain('# FreeLLMAPI free catalogue: active models')
    expect(active).toContain('- Scope: routing-enabled catalogue models whose provider holds a usable key')

    const empty = formatFreeCatalogModels({ scope: 'active', capturedAt: '2026-09-02', providers: [] })
    expect(empty).toContain('- Providers: 0 · Models: 0')
    expect(empty).toContain('No catalogue model matches this scope.')
  })

  it('never emits credential or internal identity fields', () => {
    const text = formatFreeCatalogModels({
      scope: 'all',
      capturedAt: '2026-09-02',
      providers: providersFor('all'),
    })

    for (const forbidden of ['Ollama box', 'keyId', 'modelDbId', 'keyLabel']) {
      expect(text).not.toContain(forbidden)
    }
  })

  it('renders one trigger offering both copy scopes', () => {
    const html = renderToStaticMarkup(<FreeCatalogCopyAction buildText={() => 'unused'} />)

    expect(html).toContain('Copy free catalogue')
    expect(html).toContain('aria-label="Copy free catalogue models"')
    expect(html).not.toContain('unused')
  })
})
