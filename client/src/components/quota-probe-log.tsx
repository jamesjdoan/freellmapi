import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { ChevronDown, Ruler } from 'lucide-react'
import { useI18n } from '@/i18n'
import { apiFetch } from '@/lib/api'
import { Badge } from '@/components/ui/badge'
import { PlatformDot } from '@/components/platform-dot'
import { TimeTreeLog } from '@/components/time-tree-log'
import { parseSqliteUtc } from '@/lib/time-tree'

// The record of what a provider's limits were actually MEASURED to be.
//
// Quota numbers arrive from four places (live header, provider API, operator
// config, shipped catalogue) and the policies panel above shows which one won.
// None of them answers the question this panel exists for: has anyone ever
// checked, and what did the provider itself say?
//
// It matters because measuring costs real quota. Google publishes no quota
// headers at all, so the only channel that states a limit is a 429 body, and
// getting one means deliberately spending requests on a route with a 20-a-day
// allowance. A measurement that expensive should not have to be repeated
// because nobody wrote it down.
//
// Shape follows the question an operator asks. The unit of interest is a MODEL,
// not a run: "what is this model's limit, and is the catalogue right about it?"
// So each model is one row carrying its latest answer, pressable for the
// evidence; earlier runs for that same model fold underneath by month, which is
// the pace at which a provider changes an allowance.

interface QuotaProbe {
  id: number
  platform: string
  modelId: string
  ranAt: string
  method: 'burst' | 'observed'
  concurrency: number | null
  served: number
  refused: number
  statusCodes: Record<string, number>
  measuredRpm: number | null
  measuredRpd: number | null
  catalogueRpm: number | null
  catalogueRpd: number | null
  currentRpm: number | null
  currentRpd: number | null
  routed: boolean
  retryHintMs: number | null
  quotaBucket: string | null
  verbatim: string | null
  notes: string | null
  finding: string
  recommendation: string | null
}

/** Every response was the provider saying the model is gone. */
function delisted(probe: QuotaProbe): boolean {
  const codes = Object.keys(probe.statusCodes)
  return codes.length > 0 && codes.every(c => c === '404' || c === '410')
}

function rate(rpm: number | null, rpd: number | null, perMin: string, perDay: string): string {
  return [rpm == null ? null : `${rpm}${perMin}`, rpd == null ? null : `${rpd}${perDay}`]
    .filter(Boolean)
    .join(' · ')
}

function ProbeDetail({ probe }: { probe: QuotaProbe }) {
  const { t } = useI18n()
  const codes = Object.entries(probe.statusCodes).sort(([a], [b]) => a.localeCompare(b))
  return (
    <div className="space-y-2 text-xs">
      <p>{probe.finding}</p>

      {/* The recommendation is the whole point of keeping the catalogue's claim
          beside the measurement, so it gets the only colour in the panel. */}
      {probe.recommendation && (
        <p className="rounded-md border border-amber-500/40 bg-amber-500/5 px-2 py-1 text-amber-700 dark:text-amber-400">
          {probe.recommendation}
        </p>
      )}

      <dl className="flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-muted-foreground">
        {codes.length > 0 && (
          <div>
            <dt className="inline font-medium">{t('quota.probeCodes')}: </dt>
            <dd className="inline tabular-nums">{codes.map(([c, n]) => `${c}×${n}`).join(', ')}</dd>
          </div>
        )}
        {probe.quotaBucket && (
          <div>
            <dt className="inline font-medium">{t('quota.probeBucket')}: </dt>
            <dd className="inline"><code>{probe.quotaBucket}</code></dd>
          </div>
        )}
        {probe.retryHintMs != null && (
          <div>
            <dt className="inline font-medium">{t('quota.probeRetryHint')}: </dt>
            <dd className="inline tabular-nums">{Math.round(probe.retryHintMs / 1000)}s</dd>
          </div>
        )}
      </dl>

      {/* Only worth saying when it has since changed: otherwise it repeats the
          chip on the row above. */}
      {(probe.catalogueRpm !== probe.currentRpm || probe.catalogueRpd !== probe.currentRpd) && (
        <p className="text-[11px] text-muted-foreground">
          {t('quota.probeClaimedThen', {
            claimed: rate(probe.catalogueRpm, probe.catalogueRpd, t('quota.probePerMin'), t('quota.probePerDay')) || '—',
          })}
        </p>
      )}

      {probe.notes && <p className="text-[11px] text-muted-foreground">{probe.notes}</p>}

      {/* Untruncated on purpose: `requests.error` caps at 240 characters and a
          provider names its limit past that, which is how the number got lost
          before this table existed. */}
      {probe.verbatim && (
        <pre className="max-h-40 overflow-auto whitespace-pre-wrap break-words rounded-md bg-muted/50 p-2 text-[10px] leading-snug text-muted-foreground">
          {probe.verbatim}
        </pre>
      )}
    </div>
  )
}

function ModelRow({ probes }: { probes: QuotaProbe[] }) {
  const { t } = useI18n()
  const [open, setOpen] = useState(false)
  const [latest, ...earlier] = probes
  if (!latest) return null

  const measured = rate(latest.measuredRpm, latest.measuredRpd, t('quota.probePerMin'), t('quota.probePerDay'))
  const claimed = rate(latest.currentRpm, latest.currentRpd, t('quota.probePerMin'), t('quota.probePerDay'))

  return (
    <li className="border-b last:border-b-0">
      <button
        type="button"
        onClick={() => setOpen(o => !o)}
        aria-expanded={open}
        className="flex w-full flex-wrap items-baseline gap-x-2 gap-y-0.5 px-1 py-1.5 text-left text-xs hover:bg-muted/50"
      >
        <ChevronDown className={`size-3 flex-shrink-0 self-center transition-transform ${open ? '' : '-rotate-90'}`} aria-hidden="true" />
        <PlatformDot platform={latest.platform} />
        <code className="font-medium">{latest.modelId}</code>
        {measured ? (
          <Badge variant="secondary" className="tabular-nums text-[10px]">{measured}</Badge>
        ) : delisted(latest) ? (
          <Badge variant="destructive" className="text-[10px]">{t('quota.probeDelisted')}</Badge>
        ) : (
          <Badge variant="outline" className="text-[10px]">{t('quota.probeNoLimitFound')}</Badge>
        )}
        {/* Disagreement is the reason to look, so it is visible before opening. */}
        {latest.recommendation && !delisted(latest) && (
          <span className="text-[11px] text-amber-700 dark:text-amber-400">
            {claimed ? t('quota.probeClaimed', { claimed }) : t('quota.probeDisagrees')}
          </span>
        )}
        <span className="ml-auto flex-shrink-0 text-[11px] text-muted-foreground tabular-nums">
          {parseSqliteUtc(latest.ranAt).toLocaleDateString(undefined, { day: 'numeric', month: 'short' })}
          {earlier.length > 0 && ` · ${t('quota.probeRunCount', { count: probes.length })}`}
        </span>
      </button>

      {open && (
        <div className="px-2 pb-3 pl-6">
          <ProbeDetail probe={latest} />

          {/* Only the runs BEFORE the latest one, folded by month. A provider
              revises an allowance on that timescale, and the current answer is
              already above — this is for "when did it change". */}
          {earlier.length > 0 && (
            <div className="mt-3 border-t pt-2">
              <TimeTreeLog
                recentLabel={t('quota.probeEarlier')}
                unit="month"
                recentCount={3}
                foldAbove={3}
                items={earlier}
                at={p => parseSqliteUtc(p.ranAt)}
                itemKey={p => String(p.id)}
                summary={items => (
                  <span className="tabular-nums">{t('quota.probeRunCount', { count: items.length })}</span>
                )}
                row={p => (
                  <div className="text-xs">
                    <div className="flex flex-wrap items-baseline gap-x-2">
                      <span className="tabular-nums">
                        {rate(p.measuredRpm, p.measuredRpd, t('quota.probePerMin'), t('quota.probePerDay')) || '—'}
                      </span>
                      <span className="text-[11px] text-muted-foreground">{p.finding}</span>
                      <span className="ml-auto flex-shrink-0 text-[11px] text-muted-foreground tabular-nums">
                        {parseSqliteUtc(p.ranAt).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}
                      </span>
                    </div>
                  </div>
                )}
              />
            </div>
          )}
        </div>
      )}
    </li>
  )
}

export function QuotaProbeLogPanel({ modelIds }: { modelIds?: string[] } = {}) {
  const { t } = useI18n()
  const [platform, setPlatform] = useState<string | null>(null)

  // Scoped to one logical model, that model is served by several provider ids,
  // so ask for each and merge. Unscoped, one request gets the lot.
  const scoped = modelIds && modelIds.length > 0
  const { data } = useQuery<{ probes: QuotaProbe[] }>({
    queryKey: ['quota', 'probes', modelIds ?? null],
    queryFn: async () => {
      if (!scoped) return apiFetch('/api/quota/probes')
      const pages = await Promise.all(
        [...new Set(modelIds)].map(id =>
          apiFetch(`/api/quota/probes?modelId=${encodeURIComponent(id)}`) as Promise<{ probes: QuotaProbe[] }>),
      )
      return { probes: pages.flatMap(p => p.probes) }
    },
  })

  const probes = data?.probes ?? []
  // Nothing has ever been measured. An empty panel would read as a broken
  // feature rather than as "no one has checked yet".
  if (probes.length === 0) return null

  const platforms = [...new Set(probes.map(p => p.platform))].sort()
  const shown = platform ? probes.filter(p => p.platform === platform) : probes

  // Newest first per model; the API already returns newest-first overall, so
  // insertion order into each group preserves that.
  const byModel = new Map<string, QuotaProbe[]>()
  for (const p of shown) {
    const key = `${p.platform}/${p.modelId}`
    const group = byModel.get(key)
    if (group) group.push(p)
    else byModel.set(key, [p])
  }
  const groups = [...byModel.values()].sort(
    (a, b) => parseSqliteUtc(b[0]!.ranAt).getTime() - parseSqliteUtc(a[0]!.ranAt).getTime(),
  )

  const disagreeing = groups.filter(g => g[0]!.recommendation != null).length

  return (
    <section className="rounded-xl border p-4">
      <div className="flex flex-wrap items-center gap-2">
        <Ruler className="size-4 text-muted-foreground" aria-hidden="true" />
        <h2 className="text-sm font-medium">{t('quota.probesTitle')}</h2>
        <Badge variant="secondary" className="tabular-nums">{groups.length}</Badge>
        {disagreeing > 0 && (
          <Badge variant="outline" className="border-amber-500/40 text-[10px] text-amber-700 dark:text-amber-400">
            {t('quota.probeDisagreeCount', { count: disagreeing })}
          </Badge>
        )}
        {platforms.length > 1 && !scoped && (
          <div className="ml-auto flex flex-wrap items-center gap-1">
            <button
              type="button"
              onClick={() => setPlatform(null)}
              className={`rounded-full border px-2 py-0.5 text-[11px] ${platform === null ? 'bg-muted' : 'hover:bg-muted/50'}`}
            >
              {t('quota.probeAllProviders')}
            </button>
            {platforms.map(p => (
              <button
                key={p}
                type="button"
                onClick={() => setPlatform(p)}
                className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] ${platform === p ? 'bg-muted' : 'hover:bg-muted/50'}`}
              >
                <PlatformDot platform={p} />
                {p}
              </button>
            ))}
          </div>
        )}
      </div>

      <p className="mt-1 text-[11px] text-muted-foreground">{t('quota.probesHint')}</p>

      <ul className="mt-2">
        {groups.map(g => (
          <ModelRow key={`${g[0]!.platform}/${g[0]!.modelId}`} probes={g} />
        ))}
      </ul>
    </section>
  )
}
