import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { Flame } from 'lucide-react'
import { apiFetch } from '@/lib/api'
import { useI18n } from '@/i18n'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Badge } from '@/components/ui/badge'
import { ConfirmButton } from '@/components/confirm-button'
import { QuotaProbeLogPanel } from '@/components/quota-probe-log'

// Quota DISCOVERY, on Logs rather than beside the keys.
//
// A burn run deliberately spends a provider's allowance until it refuses, to
// find a ceiling the provider never publishes. That is an experiment with a
// record, which is what this page is for — and emphatically not something to
// put one click from a credential, where the Keys page now shows headroom.
//
// The probe log below is the passive half of the same question: a burn drives
// a platform to refusal, a probe reads the limit a single model names in its
// own refusal during ordinary traffic.

interface BurnRun {
  id: string
  platform: string
  modelId: string
  phase: 'burning' | 'recovering' | 'complete' | 'cancelled' | 'failed'
  requestsSent: number
  requestsSucceeded: number
  refusedAt: string | null
  observedPeriod: string | null
}

export function QuotaBurnSection() {
  const { t } = useI18n()
  const queryClient = useQueryClient()

  // Polled only while a run is live, so the count climbs in view and the page
  // is otherwise idle.
  const { data: burnData = { runs: [] as BurnRun[] } } = useQuery({
    queryKey: ['quota', 'burn'],
    queryFn: () => apiFetch<{ runs: BurnRun[] }>('/api/quota/burn'),
    refetchInterval: query => (query.state.data?.runs.some(r => r.phase === 'burning') ? 2000 : false),
  })

  // A burn is per PLATFORM and only one may be live at a time, so the button
  // list is platforms, not pools: Groq's three pools would have offered two
  // clicks that could only ever 409. Deduped by react-query with the Keys page.
  const { data: providerData = { providers: [] as { platform: string }[] } } = useQuery({
    queryKey: ['quota', 'providers'],
    queryFn: () => apiFetch<{ providers: { platform: string }[] }>('/api/quota/providers'),
  })
  const burnPlatforms = [...new Set(providerData.providers.map(p => p.platform))]

  const runsByPlatform = new Map<string, BurnRun>()
  for (const run of burnData.runs) if (!runsByPlatform.has(run.platform)) runsByPlatform.set(run.platform, run)

  const invalidateBurn = () => { void queryClient.invalidateQueries({ queryKey: ['quota', 'burn'] }) }
  const startBurn = useMutation({
    // The caps travel with the request: the server clamps them, and stating
    // them here is what the confirmation is consenting to.
    mutationFn: (platform: string) => apiFetch('/api/quota/burn', {
      method: 'POST',
      body: JSON.stringify({ platform, maxRequests: 120, maxSeconds: 180, maxPeriod: 'day', confirm: true }),
    }),
    onSuccess: invalidateBurn,
  })
  const cancelBurn = useMutation({
    mutationFn: (id: string) => apiFetch(`/api/quota/burn/${id}/cancel`, { method: 'POST' }),
    onSuccess: invalidateBurn,
  })

  return (
    <div className="space-y-6">
      {/* Measured limits: what a provider was actually observed to allow, as
          opposed to the policies declared on the Keys page. */}
      <QuotaProbeLogPanel />

      <div className="border bg-card rounded-3xl px-4 py-3">
        <div className="flex items-center gap-2">
          <Flame className="size-4" aria-hidden="true" />
          <h3 className="text-sm font-semibold">{t('quota.burnTitle')}</h3>
        </div>
        <div className="mt-4">
          <p className="text-xs text-muted-foreground">{t('quota.burnCaveat')}</p>
          {startBurn.error ? (
            // A rejected start (no usable key, one already running) has to be
            // visible: a button that silently does nothing reads as broken.
            <p className="text-sm text-destructive">{(startBurn.error as Error).message}</p>
          ) : null}
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t('quota.colProvider')}</TableHead>
                <TableHead className="text-right">{t('quota.colBurnSent')}</TableHead>
                <TableHead className="text-right">{t('quota.colBurnCeiling')}</TableHead>
                <TableHead>{t('quota.colWindow')}</TableHead>
                <TableHead>{t('quota.colStatus')}</TableHead>
                <TableHead className="text-right">{t('quota.colAction')}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {burnPlatforms.map(platform => {
                const run = runsByPlatform.get(platform) ?? null
                const active = run?.phase === 'burning' || run?.phase === 'recovering'
                return (
                  <TableRow key={`burn:${platform}`}>
                    <TableCell className="font-medium">{platform}</TableCell>
                    <TableCell className="text-right">{run ? run.requestsSent : '—'}</TableCell>
                    {/* The ceiling is only known when the provider actually
                        refused; a run that stopped at its own cap has not
                        discovered anything and says so. */}
                    <TableCell className="text-right">
                      {run?.refusedAt ? run.requestsSucceeded : '—'}
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {run?.observedPeriod ? t(`quota.period_${run.observedPeriod}`) : '—'}
                    </TableCell>
                    <TableCell>
                      {run
                        ? <Badge variant={run.phase === 'failed' ? 'destructive' : active ? 'secondary' : 'outline'}>
                            {t(`quota.burnPhase_${run.phase}`)}
                          </Badge>
                        : <span className="text-sm text-muted-foreground">—</span>}
                    </TableCell>
                    <TableCell className="text-right">
                      {active
                        ? <ConfirmButton onConfirm={() => cancelBurn.mutate(run!.id)} confirmLabel={t('quota.burnCancelConfirm')}>
                            {t('quota.burnCancel')}
                          </ConfirmButton>
                        : <ConfirmButton
                            onConfirm={() => startBurn.mutate(platform)}
                            confirmLabel={t('quota.burnStartConfirm')}
                            armedClassName="text-destructive"
                            disabled={startBurn.isPending}
                          >
                            {t('quota.burnStart')}
                          </ConfirmButton>}
                    </TableCell>
                  </TableRow>
                )
              })}
            </TableBody>
          </Table>
        </div>
      </div>
    </div>
  )
}
