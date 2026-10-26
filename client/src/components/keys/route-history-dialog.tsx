import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { FlaskConical } from 'lucide-react'
import { useI18n } from '@/i18n'
import { apiFetch } from '@/lib/api'
import { formatStamp } from '@/lib/stamp'
import { Button } from '@/components/ui/button'
import { Dialog, DialogPopup, DialogTitle, DialogDescription } from '@/components/ui/dialog'
import {
  chainArrangePaths,
  endpointHandle,
  type ProbeRunOutcome,
  type RouteHistoryResponse,
} from '@/lib/chain-arrange'

// Route history (ARCH-20261026): the drill-in for one route — probes and
// imported bench results beside the real traffic, per day, so drift is
// visible before it becomes a 45 s timeout on a live turn. Opened from a
// route row on a provider's model panel; "Probe now" spends one of the
// route's 1-2 probes for today and shows what came back, refusals included.

export interface RouteHistoryTarget {
  platform: string
  modelId: string
  endpointScope: string
}

/** ok/n with the honest dash for "nothing measured". */
const ratio = (ok: number, n: number) => (n > 0 ? `${ok}/${n}` : '–')

const mean = (value: number | null) => (value == null ? '–' : String(Math.round(value * 10) / 10))

const OUTCOME_TONE: Record<string, string> = {
  ok: 'text-emerald-700 dark:text-emerald-400',
  empty: 'text-rose-700 dark:text-rose-400',
  timeout: 'text-rose-700 dark:text-rose-400',
  refused: 'text-amber-700 dark:text-amber-400',
  rate_limited: 'text-amber-700 dark:text-amber-400',
  error: 'text-rose-700 dark:text-rose-400',
}

export function RouteHistoryDialog({ route, displayName, open, onClose }: {
  route: RouteHistoryTarget
  displayName: string
  open: boolean
  onClose: () => void
}) {
  const { t } = useI18n()
  const queryClient = useQueryClient()

  const { data, isPending, error } = useQuery<RouteHistoryResponse>({
    queryKey: ['chain-arrange', 'route-history', route.platform, route.modelId, route.endpointScope],
    queryFn: () => apiFetch(chainArrangePaths.routeHistory(route)),
    enabled: open,
  })

  const probe = useMutation({
    mutationFn: () =>
      apiFetch<ProbeRunOutcome>(chainArrangePaths.probe, {
        method: 'POST',
        body: JSON.stringify({ platform: route.platform, modelId: route.modelId, endpointScope: route.endpointScope }),
      }),
    onSuccess: () => {
      // The probe just became new history: the open dialog re-reads it, and
      // the arrange panel's evidence follows.
      queryClient.invalidateQueries({ queryKey: ['chain-arrange'] })
      queryClient.invalidateQueries({ queryKey: ['fallback'] })
    },
  })

  const evidence = data?.evidence ?? null
  const handle = endpointHandle(route.endpointScope)
  const outcome = probe.data

  return (
    <Dialog open={open} onOpenChange={next => { if (!next && !probe.isPending) onClose() }}>
      <DialogPopup maxWidth="max-w-3xl">
        <DialogTitle>{t('routeHistory.title')}</DialogTitle>
        <DialogDescription className="mt-1">
          <span className="font-medium text-foreground">{displayName}</span>
          <span className="ml-2 font-mono text-[11px]">
            {route.platform}/{route.modelId}
            {handle && <span className="text-muted-foreground/80"> · {handle}</span>}
          </span>
        </DialogDescription>

        {isPending && <p className="mt-3 text-xs text-muted-foreground">{t('common.loading')}</p>}
        {error && <p className="mt-3 text-xs text-rose-600 dark:text-rose-400">{error.message}</p>}

        {data && (
          <>
            {/* The summary the chain panel ranks on: 14 days of real traffic
                and probes, 30 days of screen means. */}
            <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4">
              <Stat
                label={t('routeHistory.realTraffic')}
                value={evidence ? ratio(evidence.real.ok, evidence.real.n) : '–'}
                hint={evidence?.real.avgOkLatencyMs != null
                  ? t('routeHistory.avgLatency', { ms: evidence.real.avgOkLatencyMs })
                  : undefined}
              />
              <Stat
                label={t('routeHistory.probeTraffic')}
                value={evidence ? ratio(evidence.probe.ok, evidence.probe.n) : '–'}
                hint={evidence?.probe.avgOkLatencyMs != null
                  ? t('routeHistory.avgLatency', { ms: evidence.probe.avgOkLatencyMs })
                  : undefined}
              />
              <Stat label={t('routeHistory.agenticScreen')} value={evidence ? mean(evidence.screen.agentic.mean) : '–'}
                    hint={evidence && evidence.screen.agentic.graded > 0
                      ? t('routeHistory.gradedCount', { count: evidence.screen.agentic.graded })
                      : undefined} />
              <Stat label={t('routeHistory.codingScreen')} value={evidence ? mean(evidence.screen.coding.mean) : '–'}
                    hint={evidence && evidence.screen.coding.graded > 0
                      ? t('routeHistory.gradedCount', { count: evidence.screen.coding.graded })
                      : undefined} />
            </div>

            <h3 className="mt-4 text-xs font-medium">{t('routeHistory.dailyTitle')}</h3>
            <div className="mt-1 max-h-56 max-w-full overflow-y-auto overflow-x-auto rounded-xl border">
              <table className="w-full text-xs">
                <thead className="sticky top-0 bg-card text-[10px] text-muted-foreground">
                  <tr>
                    <th className="px-2 py-1 text-left font-normal">{t('routeHistory.colDay')}</th>
                    <th className="px-2 py-1 text-right font-normal">{t('routeHistory.colReal')}</th>
                    <th className="px-2 py-1 text-right font-normal">{t('routeHistory.colProbe')}</th>
                    <th className="px-2 py-1 text-right font-normal">{t('routeHistory.colAgentic')}</th>
                    <th className="px-2 py-1 text-right font-normal">{t('routeHistory.colCoding')}</th>
                  </tr>
                </thead>
                <tbody>
                  {data.daily.length === 0 ? (
                    <tr><td colSpan={5} className="px-2 py-2 text-muted-foreground">{t('routeHistory.dailyEmpty')}</td></tr>
                  ) : data.daily.map(day => (
                    <tr key={day.day} className="border-t">
                      <td className="px-2 py-1 tabular-nums text-muted-foreground">{day.day}</td>
                      <td className="px-2 py-1 text-right tabular-nums">{ratio(day.realOk, day.realN)}</td>
                      <td className="px-2 py-1 text-right tabular-nums">{ratio(day.probeOk, day.probeN)}</td>
                      <td className="px-2 py-1 text-right tabular-nums">{mean(day.agenticMean)}</td>
                      <td className="px-2 py-1 text-right tabular-nums">{mean(day.codingMean)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <div className="mt-4 flex items-center justify-between gap-2">
              <h3 className="text-xs font-medium">{t('routeHistory.probesTitle', { count: data.probes.length })}</h3>
              {/* One probe of the route's 1-2 for today. The server refuses
                  when the gate is off, the route is paid, cooling down or
                  keyless — that reason comes back and is shown as-is. */}
              <Button
                size="xs"
                variant="outline"
                disabled={probe.isPending}
                onClick={() => { probe.reset(); probe.mutate() }}
              >
                <FlaskConical className="size-3" />
                {probe.isPending ? t('routeHistory.probing') : t('routeHistory.probeNow')}
              </Button>
            </div>

            {probe.isError && (
              <p className="mt-2 text-xs text-rose-600 dark:text-rose-400">{(probe.error as Error).message}</p>
            )}
            {outcome && (
              <div
                className={`mt-2 rounded-xl border px-3 py-2 text-xs ${
                  outcome.refused ? 'border-amber-500/40 bg-amber-500/5 text-amber-800 dark:text-amber-300'
                    : outcome.ok ? 'border-emerald-500/40 bg-emerald-500/5 text-emerald-800 dark:text-emerald-300'
                    : 'border-rose-500/40 bg-rose-500/5 text-rose-700 dark:text-rose-400'}`}
              >
                <p className="font-medium">
                  {outcome.refused
                    ? t('routeHistory.probeRefused', { reason: outcome.refused })
                    : outcome.ok ? t('routeHistory.probePassed') : t('routeHistory.probeFailed')}
                </p>
                {!outcome.refused && (
                  <p className="mt-0.5 font-mono text-[10px] text-muted-foreground">
                    {[
                      outcome.scenarioId,
                      outcome.outcome,
                      outcome.status,
                      outcome.score != null ? `${t('routeHistory.scoreWord')} ${outcome.score}` : null,
                      outcome.latencyMs != null ? `${outcome.latencyMs} ms` : null,
                    ].filter(Boolean).join(' · ')}
                  </p>
                )}
              </div>
            )}

            <div className="mt-2 max-h-64 max-w-full overflow-y-auto overflow-x-auto rounded-xl border">
              <table className="w-full text-xs">
                <thead className="sticky top-0 bg-card text-[10px] text-muted-foreground">
                  <tr>
                    <th className="px-2 py-1 text-left font-normal">{t('routeHistory.colTime')}</th>
                    <th className="px-2 py-1 text-left font-normal">{t('routeHistory.colScenario')}</th>
                    <th className="px-2 py-1 text-left font-normal">{t('routeHistory.colSource')}</th>
                    <th className="px-2 py-1 text-center font-normal">{t('routeHistory.colStreamed')}</th>
                    <th className="px-2 py-1 text-left font-normal">{t('routeHistory.colOutcome')}</th>
                    <th className="px-2 py-1 text-left font-normal">{t('routeHistory.colStatus')}</th>
                    <th className="px-2 py-1 text-right font-normal">{t('routeHistory.colScore')}</th>
                    <th className="px-2 py-1 text-right font-normal">{t('routeHistory.colLatency')}</th>
                    <th className="px-2 py-1 text-left font-normal">{t('routeHistory.colError')}</th>
                  </tr>
                </thead>
                <tbody>
                  {data.probes.length === 0 ? (
                    <tr><td colSpan={9} className="px-2 py-2 text-muted-foreground">{t('routeHistory.probesEmpty')}</td></tr>
                  ) : data.probes.map(p => (
                    <tr key={p.id} className="border-t">
                      <td className="whitespace-nowrap px-2 py-1 tabular-nums text-muted-foreground">
                        {formatStamp(new Date(p.probedAtMs), { time: true })}
                      </td>
                      <td className="px-2 py-1 font-mono text-[10px]">{p.scenarioId}</td>
                      <td className="px-2 py-1 text-muted-foreground">
                        {t(p.source === 'import' ? 'routeHistory.sourceImport' : 'routeHistory.sourceProbe')}
                      </td>
                      <td className="px-2 py-1 text-center">{p.streamed ? '✓' : '–'}</td>
                      <td className={`px-2 py-1 ${OUTCOME_TONE[p.outcome] ?? ''}`}>{p.outcome}</td>
                      <td className="px-2 py-1 text-muted-foreground">{p.status}</td>
                      <td className="px-2 py-1 text-right tabular-nums">{p.score != null ? String(Math.round(p.score * 10) / 10) : '–'}</td>
                      <td className="px-2 py-1 text-right tabular-nums">{p.latencyMs != null ? p.latencyMs : '–'}</td>
                      <td className="max-w-[180px] truncate px-2 py-1 text-[10px] text-muted-foreground" title={p.error ?? undefined}>
                        {p.error ?? '–'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </DialogPopup>
    </Dialog>
  )
}

function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  // The hint is the sample behind the figure (graded scenarios, latency), so
  // it is printed, not tucked into a tooltip: a mean over one scenario and a
  // mean over six are not the same evidence.
  return (
    <div className="rounded-xl border bg-background px-3 py-2">
      <p className="text-[10px] text-muted-foreground">{label}</p>
      <p className="text-sm font-medium tabular-nums">{value}</p>
      {hint && <p className="text-[10px] text-muted-foreground tabular-nums">{hint}</p>}
    </div>
  )
}
