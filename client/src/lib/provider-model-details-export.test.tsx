import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { ApiKey, ProviderQuotaGuidance } from '../../../shared/types'
import {
  formatFreeCatalogModels,
  formatProviderModelDetails,
  type FreeCatalogScope,
  type ProviderModelDetailsExport,
} from './provider-model-details-export'
import { freeCatalogProviders, providerKeyAccess } from './model-scope-selection'
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
  scope: 'all',
  offeredModelCount: 2,
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

    expect(text).toContain('# FreeLLMAPI free models — all: Groq')
    expect(text).toContain('- Total: 1 free model')
    expect(text).toContain('- Scope: every free model this provider offers, whatever its access state')
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

  it('names the enabled scope against what the provider offers', () => {
    const text = formatProviderModelDetails({ ...input, scope: 'selected' })

    expect(text).toContain('# FreeLLMAPI free models — enabled: Groq')
    expect(text).toContain('- Total: 1 free model of 2 offered')
    expect(text).toContain('- Scope: free models this key is enabled to serve')
  })

  it('labels live-discovered models and renders a visible copy action', () => {
    const text = formatProviderModelDetails({ ...input, modelSource: 'live_discovery', guidance: null })
    expect(text).toContain('Live provider discovery; free-tier status requires verification')

    const html = renderToStaticMarkup(<ProviderModelDetailsCopyAction buildText={() => text} />)
    expect(html).toContain('Copy List')
    expect(html).toContain(`aria-label="Copy list of this provider&#x27;s free models"`)
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

// Groq: one unscoped usable key (serves everything) plus an invalid key that
// must grant nothing. Cerebras: a usable key scoped to one model. Nvidia: an
// invalid key only, so nothing there is reachable.
const keys = [
  { id: 1, platform: 'groq', enabled: true, status: 'healthy', modelScope: null, maskedKey: 'gsk_...0001', label: 'Groq main' },
  { id: 2, platform: 'groq', enabled: true, status: 'invalid', modelScope: ['openai/gpt-oss-20b'], maskedKey: 'gsk_...0002', label: 'Groq dead' },
  { id: 3, platform: 'cerebras', enabled: true, status: 'unknown', modelScope: ['qwen-3-coder'], maskedKey: 'csk-...0003', label: 'Cerebras' },
  { id: 4, platform: 'nvidia', enabled: true, status: 'invalid', modelScope: null, maskedKey: 'nvapi-...0004', label: 'Nvidia' },
] as unknown as ApiKey[]

const access = providerKeyAccess(keys)
const providersFor = (scope: FreeCatalogScope) =>
  freeCatalogProviders(catalogue, scope, platform => names[platform] ?? platform, access)

describe('free catalogue export', () => {
  it('counts only usable keys and reads an unscoped key as serving everything', () => {
    expect(access.get('groq')).toMatchObject({ usableKeyCount: 1, serveAll: true })
    expect(access.get('cerebras')).toMatchObject({ usableKeyCount: 1, serveAll: false })
    expect([...access.get('cerebras')!.selectedModelIds]).toEqual(['qwen-3-coder'])
    expect(access.has('nvidia')).toBe(false)
  })

  it('covers every provider once per model id and excludes unverifiable custom relays', () => {
    const providers = providersFor('all')

    expect(providers.map(provider => provider.platform)).toEqual(['groq', 'cerebras', 'nvidia'])
    expect(providers[0].models.map(model => model.modelId)).toEqual(['openai/gpt-oss-120b', 'moonshotai/kimi-k2'])
    expect(providers[0].offeredModelCount).toBe(2)
    expect(providers[2].providerName).toBe('nvidia')
  })

  it('keeps only key-scoped models for the selected scope and drops emptied providers', () => {
    const providers = providersFor('selected')

    expect(providers.map(provider => provider.platform)).toEqual(['groq', 'cerebras'])
    expect(providers[0].models.map(model => model.modelId)).toEqual(['openai/gpt-oss-120b', 'moonshotai/kimi-k2'])
    expect(providers[1].models.map(model => model.modelId)).toEqual(['qwen-3-coder'])
  })

  it('leads with the total, then each provider, then model blocks', () => {
    const text = formatFreeCatalogModels({ scope: 'all', capturedAt: '2026-09-02', providers: providersFor('all') })

    expect(text).toContain('# FreeLLMAPI free models — all')
    expect(text).toContain('- Total: 3 providers · 4 free models')
    expect(text).toContain('- Scope: every free model these providers offer, whatever its access or routing state')
    expect(text).toContain('Custom relay endpoints are excluded: their free status is unverified')
    expect(text).toContain('- Captured: 2026-09-02')
    expect(text).toContain('## Groq — `groq`\n- Free models: 2\n- Usable keys: 1')
    expect(text).toContain('## Cerebras — `cerebras`\n- Free models: 1\n- Usable keys: 1')
    // Same block shape as the single-provider export.
    expect(text).toContain('### **GPT-OSS 120B** — `openai/gpt-oss-120b`')
    expect(text).toContain('- Access enabled · Routing enabled')
    expect(text).toContain('- Frontier · 131K context · Tools · No vision')
    expect(text).toContain('- Catalogue allowance: 6.0M/mo')
    expect(text).toContain('- Model limits: RPM 30 · RPD 1,000')
    expect(text).toContain('- Access disabled · Routing disabled (retired upstream)')
    expect(text).not.toContain('Local Llama')
  })

  it('indexes every provider against the model ids it offers', () => {
    const text = formatFreeCatalogModels({ scope: 'all', capturedAt: '2026-09-02', providers: providersFor('all') })
    const index = text.slice(text.indexOf('## Providers and their free models'), text.indexOf('## Groq'))

    expect(index).toContain('- **Groq** (`groq`) — 2 free models: `openai/gpt-oss-120b`, `moonshotai/kimi-k2`')
    expect(index).toContain('- **Cerebras** (`cerebras`) — 1 free model: `qwen-3-coder`')
    expect(index).toContain('- **nvidia** (`nvidia`) — 1 free model: `nvidia/nemotron`')
    // Every provider in the export is indexed, so the pairing is answerable
    // without reading the detail sections.
    expect(index.match(/^- \*\*/gm)).toHaveLength(providersFor('all').length)
  })

  it('reports the selected scope against what is offered, and an empty result honestly', () => {
    const selected = formatFreeCatalogModels({ scope: 'selected', capturedAt: '2026-09-02', providers: providersFor('selected') })
    expect(selected).toContain('# FreeLLMAPI free models — enabled')
    expect(selected).toContain("- Total: 2 providers · 3 free models")
    expect(selected).toContain("- Scope: free models this install's usable keys are enabled to serve, out of 3 offered")
    expect(selected).toContain('- Free models: 1 of 1 offered')

    const empty = formatFreeCatalogModels({ scope: 'selected', capturedAt: '2026-09-02', providers: [] })
    expect(empty).toContain('- Total: 0 providers · 0 free models')
    expect(empty).toContain('No free model is currently enabled on a usable key.')
  })

  it('never emits credential or internal identity fields', () => {
    const text = formatFreeCatalogModels({ scope: 'all', capturedAt: '2026-09-02', providers: providersFor('all') })

    for (const forbidden of ['Ollama box', 'Groq main', 'gsk_...0001', 'keyId', 'modelDbId', 'keyLabel']) {
      expect(text).not.toContain(forbidden)
    }
  })

  it('renders one trigger offering both copy scopes', () => {
    const html = renderToStaticMarkup(<FreeCatalogCopyAction buildText={() => 'unused'} />)

    expect(html).toContain('Copy List')
    expect(html).toContain('aria-label="Copy list of free catalogue models"')
    expect(html).not.toContain('unused')
  })
})
