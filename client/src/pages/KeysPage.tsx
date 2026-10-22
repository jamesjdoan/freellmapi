import { useCallback, useState, useEffect } from 'react'
import { useSearchParams } from 'react-router-dom'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { apiFetch } from '@/lib/api'
import { Button } from '@/components/ui/button'
import { SegmentedControl } from '@/components/ui/segmented-control'
import { PageHeader } from '@/components/page-header'
import { ChainMinimumsButton } from '@/components/chain-minimums-panel'
import type { ApiKey, Platform } from '../../../shared/types'
import { Plus, Download } from 'lucide-react'
import { useI18n } from '@/i18n'
import { LISTED_PLATFORMS, type HealthData } from '@/components/keys/shared'
import { QuotaSignalsSection } from '@/components/keys/quota-signals-section'
import { UnifiedKeySection } from '@/components/keys/unified-key-section'
import { ClientProfilesSection } from '@/components/keys/client-profiles-section'
import { ProxySettingsSection } from '@/components/keys/proxy-settings-section'
import { BackupsSection } from '@/components/keys/backups-section'
import { AnthropicSection } from '@/components/keys/anthropic-section'
import { ProviderList } from '@/components/keys/provider-list'
import { ProviderChecklistSection } from '@/components/keys/provider-checklist-section'
import { AddKeyDialog } from '@/components/keys/add-key-dialog'
import { ExportKeysDialog } from '@/components/keys/export-keys-dialog'
import { AgentCompatibilitySection } from '@/components/keys/agent-compatibility-section'
import { FreeCatalogCopyAction } from '@/components/keys/free-catalog-copy-action'
import { freeCatalogProviders, providerKeyAccess } from '@/lib/model-scope-selection'
import { useExtensionEnabled } from '@/lib/use-extension'
import {
  formatFreeCatalogModels,
  type FreeCatalogScope,
} from '@/lib/provider-model-details-export'
import type { FallbackEntry } from '@/lib/routing'
import type { QuotaGuidanceCatalog } from '../../../shared/types'

type KeysTab = 'providers' | 'quotaSignals' | 'apiKey' | 'anthropic' | 'agents'
const KEYS_TABS: { id: KeysTab; labelKey: string }[] = [
  { id: 'providers', labelKey: 'keys.tabProviders' },
  { id: 'quotaSignals', labelKey: 'keys.tabQuotaSignals' },
  { id: 'apiKey', labelKey: 'keys.tabApiKey' },
  { id: 'anthropic', labelKey: 'keys.tabAnthropic' },
  { id: 'agents', labelKey: 'keys.tabAgents' },
]

export default function KeysPage() {
  const { t } = useI18n()
  const queryClient = useQueryClient()
  const [tab, setTab] = useState<KeysTab>('providers')
  // `quota-capacity-dashboard` off: the overview and policy panels are hidden,
  // which here means the whole Quota signals tab. Collection continues server-side.
  const quotaDashboard = useExtensionEnabled('quota-capacity-dashboard')
  // `/keys?add=<platform>` opens Add key preselected to that provider, so other
  // pages can send the user straight to the one key they need (e.g. the
  // Decision routing setup guide, #1354). Unknown values are ignored.
  const [searchParams, setSearchParams] = useSearchParams()
  const linkedPlatform = LISTED_PLATFORMS.find(p => p.value === searchParams.get('add'))?.value
  const [addOpen, setAddOpen] = useState(linkedPlatform !== undefined)
  // Provider the Add key dialog opens preselected to, when the add flow was
  // entered from a checklist chip (or a link) rather than the generic Add key button.
  const [addPlatform, setAddPlatform] = useState<Platform | ''>(linkedPlatform ?? '')
  // Drop the param once read, so closing the dialog and reloading does not reopen it.
  useEffect(() => {
    if (searchParams.has('add')) setSearchParams(prev => { prev.delete('add'); return prev }, { replace: true })
  }, [searchParams, setSearchParams])
  // Null until the operator touches the disclosure: their click outranks the
  // default, and reading the default straight into state would latch `false`
  // from the query's empty first render.
  const [exportOpen, setExportOpen] = useState(false)

  const openAddKey = (platform: Platform | '' = '') => {
    setAddPlatform(platform)
    setAddOpen(true)
  }

  // ?platform=<p> focuses an EXISTING key. Compare sends a provider whose key
  // is switched off here rather than to the add dialog: they already have the
  // key, and turning it off was a decision. (`?add=` is upstream's, above.)
  const [focusPlatform, setFocusPlatform] = useState('')
  useEffect(() => {
    const focus = searchParams.get('platform')
    if (!focus) return
    setFocusPlatform(focus)
    // Consumed, so a refresh or a back-navigation does not repeat it.
    setSearchParams(prev => { prev.delete('platform'); return prev }, { replace: true })
  }, [searchParams, setSearchParams])

  // Kept at page level for the header's "Check all" gate; ProviderList runs the
  // same query (deduped by react-query) for the list itself.
  const { data: keys = [] } = useQuery<ApiKey[]>({
    queryKey: ['keys'],
    queryFn: () => apiFetch('/api/keys'),
  })

  const { data: healthData } = useQuery<HealthData>({
    queryKey: ['health'],
    queryFn: () => apiFetch('/api/health'),
    refetchInterval: 30000,
  })

  const checkAll = useMutation({
    mutationFn: () => apiFetch('/api/health/check-all', { method: 'POST' }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['health'] })
      queryClient.invalidateQueries({ queryKey: ['keys'] })
    },
  })

  // The free-catalogue copy is provider-wide, so it belongs to the page rather
  // than to any one key's dialog. Both queries are the same ones the list and
  // the model-scope dialog already run, deduped by react-query.
  const { data: fallback = [] } = useQuery<FallbackEntry[]>({
    queryKey: ['fallback'],
    queryFn: () => apiFetch('/api/fallback'),
  })

  const { data: quotaCatalog } = useQuery<QuotaGuidanceCatalog>({
    queryKey: ['keys', 'quota-guidance'],
    queryFn: () => apiFetch('/api/keys/quota-guidance'),
  })


  // Formatted on demand inside the copy click, so a 300-model export costs
  // nothing until it is asked for. `selected` is decided by what the usable
  // keys are scoped to serve, which is why the keys list feeds in here.
  const buildFreeCatalogText = useCallback((scope: FreeCatalogScope) => formatFreeCatalogModels({
    scope,
    capturedAt: new Date().toISOString().slice(0, 10),
    providers: freeCatalogProviders(
      fallback,
      scope,
      platform => quotaCatalog?.providers.find(provider => provider.platform === platform)?.displayName ?? platform,
      providerKeyAccess(keys),
    ),
  }), [fallback, keys, quotaCatalog])

  return (
    <div>
      <PageHeader
        title={t('keys.pageTitle')}
        description={t('keys.pageDescription')}
        actions={
          <>
            <ChainMinimumsButton />
            {(tab === 'providers' || tab === 'quotaSignals') && keys.length > 0 && (
              <Button variant="outline" size="sm" onClick={() => checkAll.mutate()} disabled={checkAll.isPending}>
                {checkAll.isPending ? t('keys.checking') : t('keys.checkAll')}
              </Button>
            )}
            {keys.length > 0 && (
              <Button variant="outline" size="sm" onClick={() => setExportOpen(true)}>
                <Download className="size-3.5" />
                {t('keys.export')}
              </Button>
            )}
            {tab === 'providers' && (
              <FreeCatalogCopyAction buildText={buildFreeCatalogText} disabled={fallback.length === 0} />
            )}
            {tab === 'providers' && (
              <Button size="sm" onClick={() => openAddKey()}>
                <Plus className="size-3.5" />
                {t('keys.addKey')}
              </Button>
            )}
            <SegmentedControl
              value={tab}
              onValueChange={setTab}
              options={KEYS_TABS.filter(tb => quotaDashboard || tb.id !== 'quotaSignals').map(tb => ({ value: tb.id, label: t(tb.labelKey) }))}
              ariaLabel={t('keys.pageTitle')}
              className="w-full sm:w-auto"
            />
          </>
        }
      />

      <div className="space-y-8">
        {tab === 'apiKey' && (
          <>
            <UnifiedKeySection />
            <ClientProfilesSection />
            <ProxySettingsSection />
            <BackupsSection />
          </>
        )}

        {tab === 'anthropic' && <AnthropicSection />}
        {tab === 'agents' && <AgentCompatibilitySection />}

        {tab === 'quotaSignals' && quotaDashboard && (
          <QuotaSignalsSection states={healthData?.quotaStates ?? []} />
        )}

        {tab === 'providers' && (
          <>
            <ProviderChecklistSection onAddKey={platform => openAddKey(platform as Platform)} />
            <ProviderList onAddKey={() => openAddKey()} initialSearch={focusPlatform || undefined} />
          </>
        )}
      </div>

      <AddKeyDialog open={addOpen} onOpenChange={setAddOpen} initialPlatform={addPlatform || undefined} />
      {/* Mounted only while open so the export flow always starts at step one
          and never retains a previously typed password. */}
      {exportOpen && <ExportKeysDialog open={exportOpen} onOpenChange={setExportOpen} />}
    </div>
  )
}
