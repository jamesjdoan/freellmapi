import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Share2, AlertTriangle, ChevronDown } from 'lucide-react'
import { useI18n } from '@/i18n'
import { apiFetch } from '@/lib/api'
import { formatTokens } from '@/lib/routing'
import { useExtensionEnabled } from '@/lib/use-extension'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import type { FleetUsageRow, FleetValue } from '@/components/clifree-fleet'

// Everything this install moved OFF the subscription, for one range, in one
// place: FreeLLM's own proxied traffic plus the free CLI-agent fleet (OpenCode
// Zen, Cline) that each machine reports.
//
// The two sources are priced the same way — what the same tokens cost on the
// equivalent paid model — so they add up to one figure. That figure is market
// value, NOT subscription money saved: the wallets are not comparable.
//
// Device tabs filter both sources to the same machine: the proxy by user agent,
// the fleet by hostname, mapped to one set of labels on the server.
//
// 🛑 The fleet routes are observed here, never callable here. Their free tiers
// refuse callers outside the vendor's own CLI. This card carries no control.

const STALE_MS = 24 * 60 * 60 * 1000

// Collapsed by default and remembered per browser, the same shape as the chain
// manager and penalty inspector: the headline total stays in the header, the
// per-machine and per-route breakdown waits behind a click.
const COLLAPSED_KEY = 'freellmapi.offloadedInference.collapsed'

function readCollapsed(): boolean {
  try {
    const stored = localStorage.getItem(COLLAPSED_KEY)
    return stored === null ? true : stored === '1'
  } catch {
    return true
  }
}

export interface ProxyTotals {
  requests: number
  inputTokens: number
  outputTokens: number
  valueUsd: number
}

export function OffloadedInference({ range, device, proxy, now }: {
  range: string
  /** A device label from the Analytics tabs, or '' for every machine. */
  device: string
  proxy: ProxyTotals | undefined
  /** Captured once by the page so staleness is a pure render. */
  now: number
}) {
  const { t } = useI18n()
  const fleetOn = useExtensionEnabled('clifree-fleet-telemetry')
  const [collapsed, setCollapsed] = useState<boolean>(readCollapsed)
  const { data } = useQuery({
    queryKey: ['clifree-fleet', range],
    queryFn: () => apiFetch<{ value: FleetValue[]; usage: FleetUsageRow[] }>(`/api/clifree-fleet?range=${range}`),
    enabled: fleetOn,
  })

  const machines = (data?.value ?? []).filter(v => !device || v.device === device)
  const routes = (data?.usage ?? []).filter(u => !device || u.device === device)
  const unpriced = machines.some(m => m.valueUsd === null || m.unpricedSpecs > 0)
  const fleetValueUsd = machines.reduce((n, m) => n + (m.valueUsd ?? 0), 0)
  const total = {
    requests: (proxy?.requests ?? 0) + machines.reduce((n, m) => n + m.requests, 0),
    inputTokens: (proxy?.inputTokens ?? 0) + machines.reduce((n, m) => n + m.inputTokens, 0),
    outputTokens: (proxy?.outputTokens ?? 0) + machines.reduce((n, m) => n + m.outputTokens, 0),
    valueUsd: (proxy?.valueUsd ?? 0) + fleetValueUsd,
  }
  const money = (v: number | null, places = 2) => (v === null ? t('analytics.offload.unpriced') : `$${v.toFixed(places)}`)

  function toggle() {
    setCollapsed(prev => {
      const next = !prev
      try { localStorage.setItem(COLLAPSED_KEY, next ? '1' : '0') } catch { /* ignore */ }
      return next
    })
  }

  return (
    <div className="rounded-3xl border bg-card">
      <button
        type="button"
        onClick={toggle}
        aria-expanded={!collapsed}
        aria-label={collapsed ? t('common.show') : t('common.hide')}
        className={`flex w-full flex-wrap items-center justify-between gap-2 px-4 py-3 text-left ${collapsed ? '' : 'border-b'}`}
      >
        <div>
          <h3 className="flex items-center gap-2 text-sm font-medium">
            <Share2 className="size-4 text-muted-foreground" aria-hidden="true" />
            {t('analytics.offload.title')}
          </h3>
          <p className="text-[11px] text-muted-foreground">{t('analytics.offload.valueHint')}</p>
        </div>
        <div className="flex flex-wrap items-center gap-2 text-[11px] tabular-nums">
          <span className="rounded-full bg-muted px-2 py-0.5 text-muted-foreground">
            {t('analytics.offload.proxy')} {money(proxy?.valueUsd ?? 0)}
          </span>
          {fleetOn && (
            <span className="rounded-full bg-muted px-2 py-0.5 text-muted-foreground">
              {t('analytics.offload.fleet')} {money(fleetValueUsd)}
            </span>
          )}
          <span
            className="rounded-full bg-muted px-2 py-0.5 font-medium text-foreground"
            title={unpriced ? t('analytics.offload.partial') : undefined}
          >
            {t('analytics.offload.total')} {money(total.valueUsd)}
          </span>
          <ChevronDown className={`size-4 text-muted-foreground transition-transform ${collapsed ? '-rotate-90' : ''}`} />
        </div>
      </button>
      {!collapsed && (
      <div className="p-4 space-y-4">
        <div className="-mx-4">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="pl-4">{t('analytics.offload.source')}</TableHead>
                <TableHead className="text-right">{t('analytics.requests')}</TableHead>
                <TableHead className="text-right">{t('analytics.inTokens')}</TableHead>
                <TableHead className="text-right">{t('analytics.outTokens')}</TableHead>
                <TableHead className="text-right pr-4">{t('analytics.offload.value')}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              <TableRow>
                <TableCell className="pl-4 text-xs font-medium">{t('analytics.offload.proxy')}</TableCell>
                <TableCell className="text-right tabular-nums">{proxy?.requests ?? 0}</TableCell>
                <TableCell className="text-right tabular-nums">{formatTokens(proxy?.inputTokens ?? 0)}</TableCell>
                <TableCell className="text-right tabular-nums">{formatTokens(proxy?.outputTokens ?? 0)}</TableCell>
                <TableCell className="text-right tabular-nums pr-4">{money(proxy?.valueUsd ?? 0)}</TableCell>
              </TableRow>
              {fleetOn && machines.map(m => {
                const stale = m.reportedAtMs === null || now - m.reportedAtMs > STALE_MS
                return (
                  <TableRow key={m.machine}>
                    <TableCell className="pl-4 text-xs">
                      <span className="font-medium">{t('analytics.offload.fleetOn', { device: m.device })}</span>
                      <span className="block text-[11px] text-muted-foreground">
                        {m.machine} · {m.reportedAtMs === null
                          ? t('analytics.offload.neverReported')
                          : t('analytics.offload.reportedAt', { when: new Date(m.reportedAtMs).toLocaleString() })}
                        {stale && (
                          <span className="ml-1 inline-flex items-center gap-0.5 text-amber-600 dark:text-amber-400">
                            <AlertTriangle className="size-3" aria-hidden="true" />{t('analytics.offload.stale')}
                          </span>
                        )}
                      </span>
                    </TableCell>
                    <TableCell className="text-right tabular-nums">{m.requests}</TableCell>
                    <TableCell className="text-right tabular-nums">{formatTokens(m.inputTokens)}</TableCell>
                    <TableCell className="text-right tabular-nums">{formatTokens(m.outputTokens)}</TableCell>
                    <TableCell className="text-right tabular-nums pr-4">{money(m.valueUsd)}</TableCell>
                  </TableRow>
                )
              })}
              <TableRow>
                <TableCell className="pl-4 text-xs font-semibold">
                  {t('analytics.offload.total')}
                  {unpriced && <span className="ml-1 font-normal text-muted-foreground">({t('analytics.offload.partial')})</span>}
                </TableCell>
                <TableCell className="text-right tabular-nums font-semibold">{total.requests}</TableCell>
                <TableCell className="text-right tabular-nums font-semibold">{formatTokens(total.inputTokens)}</TableCell>
                <TableCell className="text-right tabular-nums font-semibold">{formatTokens(total.outputTokens)}</TableCell>
                <TableCell className="text-right tabular-nums font-semibold pr-4">{money(total.valueUsd)}</TableCell>
              </TableRow>
            </TableBody>
          </Table>
        </div>

        {fleetOn && (
          routes.length === 0 ? (
            <p className="text-xs text-muted-foreground">{t('analytics.offload.noFleet')}</p>
          ) : (
            <div className="-mx-4 max-h-[320px] overflow-y-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="pl-4">{t('analytics.offload.route')}</TableHead>
                    <TableHead>{t('analytics.device')}</TableHead>
                    <TableHead>{t('analytics.offload.class')}</TableHead>
                    <TableHead className="text-right">{t('analytics.offload.aa')}</TableHead>
                    <TableHead className="text-right">{t('analytics.requests')}</TableHead>
                    <TableHead className="text-right">{t('analytics.inTokens')}</TableHead>
                    <TableHead className="text-right">{t('analytics.outTokens')}</TableHead>
                    <TableHead className="text-right pr-4">{t('analytics.offload.value')}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {routes.map(r => (
                    <TableRow key={`${r.machine}|${r.spec}`}>
                      <TableCell className="pl-4 text-xs font-medium max-w-[280px] truncate" title={r.spec}>{r.spec}</TableCell>
                      <TableCell className="text-xs">{r.device}</TableCell>
                      <TableCell className="text-xs">{r.class ?? '—'}</TableCell>
                      <TableCell className="text-right tabular-nums text-xs">{r.intelligence === null ? '—' : r.intelligence.toFixed(1)}</TableCell>
                      <TableCell className="text-right tabular-nums">{r.requests}</TableCell>
                      <TableCell className="text-right tabular-nums">{formatTokens(r.inputTokens)}</TableCell>
                      <TableCell className="text-right tabular-nums">{formatTokens(r.outputTokens)}</TableCell>
                      <TableCell className="text-right tabular-nums pr-4">{money(r.valueUsd, 4)}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )
        )}

        {fleetOn && <p className="text-[11px] text-muted-foreground">{t('analytics.offload.notCallable')}</p>}
      </div>
      )}
    </div>
  )
}
