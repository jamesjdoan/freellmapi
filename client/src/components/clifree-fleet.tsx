import { useQuery } from '@tanstack/react-query'
import { Server, AlertTriangle } from 'lucide-react'
import { useI18n } from '@/i18n'
import { apiFetch } from '@/lib/api'
import { Badge } from '@/components/ui/badge'
import { useExtensionEnabled } from '@/lib/use-extension'

// What each MACHINE can reach on the free CLI rosters, and what it has spent.
//
// The Mac Studio and the MBP spend the SAME free accounts from different
// machines, so "are we out of Cline quota, and who spent it" is unanswerable on
// either one — each holds half the evidence. Machines report their own state
// because the container cannot read a host filesystem or run a host binary.
//
// 🛑 These routes are NOT callable from FreeLLM. Their free tiers refuse callers
// outside the vendor's own CLI: OpenCode Zen answers 403 FreeTierError, and
// Cline's free models are not served through its API at all. That is why this
// panel says so in its own copy — an operator seeing model names on a FreeLLM
// page will otherwise reasonably assume the router can use them, and an agent
// under test made exactly that mistake, concluding a delegation had gone
// "through FreeLLM :free routing". Nothing here feeds routing or model pickers.
//
// See docs/adr/ARCH-20260922-clifree-fleet-telemetry.md.

interface FleetRow {
  machine: string
  spec: string
  provider: string
  class: string | null
  intelligence: number | null
  matchQuality: string | null
  reachability: string
  coolingUntilMs: number | null
  coolingReason: string | null
  observedAtMs: number
}


// Explicit, not built from the value at call time: a constructed key defeats
// static extraction, so check:i18n cannot see it and a missing translation
// surfaces as a raw key in the UI instead of a failed check.
const REACH_LABEL: Record<string, string> = {
  ok: 'compare.fleet.reachOk',
  fail: 'compare.fleet.reachFail',
  notools: 'compare.fleet.reachNotools',
  unprobed: 'compare.fleet.reachUnprobed',
}
const STALE_AFTER_MS = 6 * 60 * 60 * 1000

function minutesLeft(untilMs: number | null, now: number): number | null {
  if (untilMs === null) return null
  const left = Math.ceil((untilMs - now) / 60_000)
  return left > 0 ? left : null
}

/** Coarse, translated-adjacent duration. Exact seconds would imply a precision
 *  a delivery-based snapshot does not have. */
function ago(ms: number): string {
  const mins = Math.max(0, Math.round(ms / 60_000))
  if (mins < 60) return `${mins}m`
  const hours = Math.round(mins / 60)
  return hours < 48 ? `${hours}h` : `${Math.round(hours / 24)}d`
}

export function ClifreeFleet() {
  const { t } = useI18n()
  const enabled = useExtensionEnabled('clifree-fleet-telemetry')

  const { data } = useQuery({
    queryKey: ['clifree-fleet'],
    queryFn: () => apiFetch<{ routes: FleetRow[] }>('/api/clifree-fleet'),
    enabled,
  })

  if (!enabled) return null

  const rows = data?.routes ?? []
  const now = Date.now()

  // Grouped by machine, because the machine IS the question this panel answers.
  // A flat list sorted by capability would bury it.
  const machines = new Map<string, FleetRow[]>()
  for (const r of rows) {
    const list = machines.get(r.machine)
    if (list) list.push(r)
    else machines.set(r.machine, [r])
  }

  return (
    <section className="space-y-4">
      <div>
        <h2 className="flex items-center gap-2 text-lg font-semibold">
          <Server className="h-4 w-4" aria-hidden />
          {t('compare.fleet.title')}
        </h2>
        <p className="text-sm text-muted-foreground">{t('compare.fleet.description')}</p>
      </div>

      {/* Stated on the surface itself, not only in the extension registry. */}
      <p className="flex items-start gap-2 rounded-md border border-amber-500/30 bg-amber-500/5 p-3 text-sm text-muted-foreground">
        <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-500" aria-hidden />
        {t('compare.fleet.notRoutable')}
      </p>

      {machines.size === 0 ? (
        <div className="rounded-md border p-4 text-sm text-muted-foreground">
          <p>{t('compare.fleet.empty')}</p>
          <p className="mt-1 font-mono text-xs">{t('compare.fleet.emptyHint')}</p>
        </div>
      ) : (
        [...machines.entries()].map(([machine, machineRows]) => {
          const observedAtMs = machineRows[0].observedAtMs
          const age = now - observedAtMs
          const stale = age > STALE_AFTER_MS

          return (
            <div key={machine} className="space-y-2">
              <div className="flex items-center gap-2">
                <span className="font-medium">{machine}</span>
                <span className="text-xs text-muted-foreground">
                  {t('compare.fleet.lastReported', { ago: ago(age) })}
                </span>
                {/* A machine that stopped reporting is itself the finding, so
                    its rows are shown AND flagged rather than hidden. */}
                {stale && (
                  <Badge variant="outline" className="border-amber-500/40 text-amber-600">
                    {t('compare.fleet.staleWarning', { ago: ago(age) })}
                  </Badge>
                )}
              </div>

              <table className="w-full text-sm">
                <thead className="text-left text-xs text-muted-foreground">
                  <tr>
                    <th className="py-1 font-normal">{t('compare.fleet.route')}</th>
                    <th className="py-1 font-normal">{t('compare.fleet.class')}</th>
                    <th className="py-1 text-right font-normal">{t('compare.fleet.intelligence')}</th>
                    <th className="py-1 font-normal">{t('compare.fleet.reachability')}</th>
                    <th className="py-1 font-normal">{t('compare.fleet.availability')}</th>
                  </tr>
                </thead>
                <tbody>
                  {machineRows.map(r => {
                    const left = minutesLeft(r.coolingUntilMs, now)
                    return (
                      <tr key={r.spec} className="border-t">
                        <td className="py-1 font-mono text-xs">{r.spec}</td>
                        <td className="py-1">{r.class ?? '—'}</td>
                        <td className="py-1 text-right tabular-nums">
                          {r.intelligence === null ? '—' : r.intelligence.toFixed(1)}
                          {/* A proxy score is an estimate for a related variant.
                              Rendering it identically to a measurement would
                              overstate what is known. */}
                          {r.matchQuality === 'proxy' && (
                            <span className="ml-1 text-xs text-muted-foreground" title={t('compare.fleet.proxyScoreHint')}>
                              {t('compare.fleet.proxyScore')}
                            </span>
                          )}
                        </td>
                        <td className="py-1">
                          {t(REACH_LABEL[r.reachability] ?? 'compare.fleet.reachUnprobed')}
                        </td>
                        <td className="py-1">
                          {left === null
                            ? t('compare.fleet.availableNow')
                            : t('compare.fleet.coolingFor', { minutes: left, reason: r.coolingReason ?? '' })}
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          )
        })
      )}
    </section>
  )
}
