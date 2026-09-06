import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { Clock, FileText, Flame, Server, Shield } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { apiFetch } from '@/lib/api';
import { useI18n } from '@/i18n';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Badge } from '@/components/ui/badge';
import { ConfirmButton } from '@/components/confirm-button';
import { formatSqliteUtcToLocalTime } from '@/lib/utils';

// Define interfaces based on API contracts
interface BurnRun {
  id: string;
  platform: string;
  modelId: string;
  phase: 'burning' | 'recovering' | 'complete' | 'cancelled' | 'failed';
  requestsSent: number;
  requestsSucceeded: number;
  refusedAt: string | null;
  observedPeriod: string | null;
}

interface InferredWindow {
  period: string;
  method: string;
  samples: number;
  confidence: number;
  note: string;
}

interface ProviderOverviewRow extends QuotaForecastEntry {
  source: string | null;
  confidence: number | null;
  /** False when the provider has never reported a usable limit — shown as
   *  Unknown rather than omitted, so an unmeasured provider stays visible. */
  metered: boolean;
  usedSource: 'provider' | 'local' | null;
  inferred: InferredWindow[];
  metric: string | null;
  unit: string | null;
  derivedAllowance: { metric: string; limit: number; low: number; high: number; samples: number } | null;
}

interface QuotaForecastEntry {
  platform: string;
  pool: string;
  used: number | null;
  remaining: number | null;
  limit: number | null;
  remaining_pct: number | null;
  reset_at: string | null;
  low_balance: boolean;
  seconds_until_reset: number | null;
}

interface ShadowResponse {
  mode: string;
  stats: {
    total: number;
    agreed: number;
    agreementRate: number;
    byLogicalModel: Array<{ logicalModel: string; total: number; agreed: number }>;
  };
}

interface DecisionRow {
  id: number;
  createdAt: string;
  logicalModel: string;
  mode: string;
  actualPlatform: string;
  actualModelId: string;
  shadowPlatform: string | null;
  shadowModelId: string | null;
  actualEndpoint: string | null;
  shadowEndpoint: string | null;
  agreed: boolean;
  reason: string | null;
  candidates: unknown;
}

interface PolicyRow {
  id: string;
  platform: string;
  modelId: string | null;
  metric: string;
  scope: string;
  limit: number | null;
  period: string;
  source: string;
  confidence: string | number;
}

// Helper to format seconds to human readable
/**
 * A count needs no denomination; a credit figure does. Two providers report
 * 'credits' in units that are not comparable - cents of balance, and
 * ten-thousandths of an allowance the provider never sizes - so the unit
 * decides, and an unknown unit stays a bare integer rather than a guess.
 */
function formatAmount(value: number | null, unit: string | null): string {
  if (value == null) return '—';
  if (unit === 'cents') return `$${(value / 100).toFixed(2)}`;
  if (unit === 'per_10k') return `${(value / 100).toFixed(1)}%`;
  return String(value);
}

/** 25087353 -> "25.1M". An allowance carrying a ±20% error bar does not want
 *  eight significant figures. */
function formatCompact(value: number): string {
  if (value >= 1_000_000_000) return `${(value / 1_000_000_000).toFixed(1)}B`;
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}K`;
  return String(value);
}

/** A derived allowance in credit arrives in cents; anything else is a count. */
function formatAllowance(value: number, metric: string): string {
  return metric === 'credit_usd' ? `$${(value / 100).toFixed(2)}` : formatCompact(value);
}

function formatCountdown(seconds: number | null): string {
  if (seconds == null || seconds <= 0) return '—';
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  const parts: string[] = [];
  if (h > 0) parts.push(`${h}h`);
  if (m > 0) parts.push(`${m}m`);
  if (s > 0 || parts.length === 0) parts.push(`${s}s`);
  return parts.join(' ');
}

/**
 * Provider status. `remaining_pct` from /api/quota/forecast is a 0..100 share,
 * not a fraction — comparing it against 0.2 would call every provider exhausted.
 * Thresholds: under 5% left is red, under 20% amber, otherwise green. A pool we
 * have no number for is grey, NOT green: unknown is not healthy.
 */
function getStatus(remainingPct: number | null, lowBalance: boolean): { labelKey: string; variant: 'default' | 'destructive' | 'outline' | 'secondary' } {
  if (remainingPct == null) return { labelKey: 'quota.status.unknown', variant: 'secondary' };
  if (remainingPct < 5) return { labelKey: 'quota.status.exhausted', variant: 'destructive' };
  if (remainingPct < 20 || lowBalance) return { labelKey: 'quota.status.low', variant: 'outline' };
  return { labelKey: 'quota.status.healthy', variant: 'default' };
}

function Panel({ icon: Icon, title, children }: { icon: LucideIcon; title: string; children: ReactNode }) {
  return (
    <div className="border bg-card rounded-3xl px-4 py-3">
      <div className="flex items-center gap-2">
        <Icon className="size-4" aria-hidden="true" />
        <h3 className="text-sm font-semibold">{title}</h3>
      </div>
      <div className="mt-4">{children}</div>
    </div>
  );
}

/** Every panel has three states, and an empty one says so rather than drawing a
 *  zeroed table that implies data exists. */
function PanelState({ loading, error, empty, emptyKey, children }: {
  loading: boolean; error: boolean; empty: boolean; emptyKey: string; children: ReactNode;
}) {
  const { t } = useI18n();
  if (loading) return <p className="text-sm text-muted-foreground">{t('quota.loading')}</p>;
  if (error) return <p className="text-sm text-destructive">{t('quota.loadFailed')}</p>;
  if (empty) return <p className="text-sm text-muted-foreground">{t(emptyKey)}</p>;
  return <>{children}</>;
}

export default function QuotaPage() {
  const { t } = useI18n();

  // Fetch forecast
  const { data: forecastData = { forecast: [] }, isLoading: forecastLoading, isError: forecastError } = useQuery({
    queryKey: ['quota', 'forecast'],
    queryFn: () => apiFetch<{ forecast: QuotaForecastEntry[] }>('/api/quota/forecast'),
  });

  const { data: shadowData = { mode: 'off', stats: { total: 0, agreed: 0, agreementRate: 0, byLogicalModel: [] } }, isLoading: shadowLoading, isError: shadowError } = useQuery({
    queryKey: ['quota', 'shadow'],
    queryFn: () => apiFetch<ShadowResponse>('/api/quota/shadow'),
  });

  const { data: decisionsData = { decisions: [] }, isLoading: decisionsLoading, isError: decisionsError } = useQuery({
    queryKey: ['quota', 'decisions'],
    queryFn: () => apiFetch<{ decisions: DecisionRow[] }>('/api/quota/decisions?disagreed=1'),
  });

  const { data: policiesData = { policies: [] }, isLoading: policiesLoading, isError: policiesError } = useQuery({
    queryKey: ['quota', 'policies'],
    queryFn: () => apiFetch<{ policies: PolicyRow[] }>('/api/quota/policies'),
  });

  const { data: modeData = { mode: 'shadow' } } = useQuery({
    queryKey: ['quota', 'mode'],
    queryFn: () => apiFetch<{ mode: string }>('/api/quota/mode'),
  });

  const { data: providerData = { providers: [] }, isLoading: providerLoading, isError: providerError } = useQuery({
    queryKey: ['quota', 'providers'],
    queryFn: () => apiFetch<{ providers: ProviderOverviewRow[] }>('/api/quota/providers'),
  });

  const providers = providerData.providers;

  // Burn runs: the experiment record per provider. Polled while one is live so
  // the count climbs in view; the newest run per platform is the one shown.
  const queryClient = useQueryClient();
  const { data: burnData = { runs: [] as BurnRun[] } } = useQuery({
    queryKey: ['quota', 'burn'],
    queryFn: () => apiFetch<{ runs: BurnRun[] }>('/api/quota/burn'),
    refetchInterval: (query) =>
      query.state.data?.runs.some(r => r.phase === 'burning') ? 2000 : false,
  });
  const runsByPlatform = new Map<string, BurnRun>();
  for (const run of burnData.runs) if (!runsByPlatform.has(run.platform)) runsByPlatform.set(run.platform, run);

  // The overview is one row per POOL; a burn run is per PLATFORM, and only one
  // may be live at a time. Listing Groq's three pools as three buttons offered
  // two clicks that could only ever 409.
  const burnPlatforms = [...new Set(providers.map(p => p.platform))];

  const invalidateBurn = () => { void queryClient.invalidateQueries({ queryKey: ['quota', 'burn'] }); };
  const startBurn = useMutation({
    // The caps travel with the request: the server clamps them, and stating
    // them here is what the confirmation is consenting to.
    mutationFn: (platform: string) => apiFetch('/api/quota/burn', {
      method: 'POST',
      body: JSON.stringify({ platform, maxRequests: 120, maxSeconds: 180, maxPeriod: 'day', confirm: true }),
    }),
    onSuccess: invalidateBurn,
  });
  const cancelBurn = useMutation({
    mutationFn: (id: string) => apiFetch(`/api/quota/burn/${id}/cancel`, { method: 'POST' }),
    onSuccess: invalidateBurn,
  });
  // Soonest first: the panel exists to answer "which allowance renews next".
  const resets = forecastData.forecast
    .filter(e => e.reset_at != null && e.seconds_until_reset != null && e.seconds_until_reset > 0)
    .sort((a, b) => (a.seconds_until_reset ?? 0) - (b.seconds_until_reset ?? 0));

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold">{t('quota.title')}</h1>
        <p className="text-muted-foreground">{t('quota.description')}</p>
      </div>

      <Panel icon={Server} title={t('quota.overviewTitle')}>
        <PanelState loading={providerLoading} error={providerError} empty={providers.length === 0} emptyKey="quota.emptyOverview">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t('quota.colProvider')}</TableHead>
                <TableHead>{t('quota.colPool')}</TableHead>
                <TableHead>{t('quota.colCounts')}</TableHead>
                <TableHead className="text-right">{t('quota.colUsed')}</TableHead>
                <TableHead className="text-right">{t('quota.colRemaining')}</TableHead>
                <TableHead className="text-right">{t('quota.colLimit')}</TableHead>
                <TableHead className="text-right">{t('quota.colReset')}</TableHead>
                <TableHead>{t('quota.colWindow')}</TableHead>
                <TableHead>{t('quota.colSource')}</TableHead>
                <TableHead>{t('quota.colStatus')}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {providers.map(p => {
                // An unmetered provider has no percentage to judge; getStatus
                // already reports null as Unknown rather than as healthy.
                const status = getStatus(p.metered ? p.remaining_pct : null, p.low_balance);
                return (
                  <TableRow key={`${p.platform}:${p.pool ?? 'unknown'}`}>
                    <TableCell className="font-medium">{p.platform}</TableCell>
                    <TableCell className="text-muted-foreground">{p.pool ?? '—'}</TableCell>
                    <TableCell className="text-muted-foreground">
                      {p.metric ? t(`quota.metric_${p.metric}`) : '—'}
                    </TableCell>
                    <TableCell className="text-right">{formatAmount(p.used, p.unit)}</TableCell>
                    <TableCell className="text-right">{formatAmount(p.remaining, p.unit)}</TableCell>
                    {/* For a pool the provider reports only as a fraction, the
                        stored limit is a synthetic scale — showing "100.0%" as
                        a ceiling states nothing. The derived allowance is a
                        real figure when we have one, and a dash is honest when
                        we do not. */}
                    <TableCell className="text-right">
                      {p.unit === 'per_10k'
                        ? p.derivedAllowance
                          ? <span title={t('quota.derivedAllowanceHint', {
                              low: formatAllowance(p.derivedAllowance.low, p.derivedAllowance.metric),
                              high: formatAllowance(p.derivedAllowance.high, p.derivedAllowance.metric),
                              samples: p.derivedAllowance.samples,
                            })}>
                              ~{formatAllowance(p.derivedAllowance.limit, p.derivedAllowance.metric)}
                              {p.derivedAllowance.metric === 'credit_usd' ? '' : ` ${t(`quota.metric_${p.derivedAllowance.metric}`)}`}
                            </span>
                          : '—'
                        : formatAmount(p.limit, p.unit)}
                    </TableCell>
                    <TableCell className="text-right">{formatCountdown(p.seconds_until_reset)}</TableCell>
                    <TableCell className="text-muted-foreground">
                      {p.inferred.length === 0 ? '—' : p.inferred.map(w => (
                        // Always prefixed and always carrying its sample count:
                        // a reader must be able to tell an estimate from a
                        // number the provider stated.
                        <div key={`${w.method}:${w.period}`} title={w.note}>
                          {t('quota.inferredWindow', { period: t(`quota.period_${w.period}`), samples: w.samples })}
                        </div>
                      ))}
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {p.source ?? '—'}
                      {p.usedSource === 'local' ? ` ${t('quota.locallyCounted')}` : ''}
                    </TableCell>
                    <TableCell><Badge variant={status.variant}>{t(status.labelKey)}</Badge></TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </PanelState>
      </Panel>

      <Panel icon={Clock} title={t('quota.resetTimelineTitle')}>
        <PanelState loading={forecastLoading} error={forecastError} empty={resets.length === 0} emptyKey="quota.emptyResets">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t('quota.colProvider')}</TableHead>
                <TableHead>{t('quota.colResetsAt')}</TableHead>
                <TableHead className="text-right">{t('quota.colCountdown')}</TableHead>
                <TableHead className="text-right">{t('quota.colUnused')}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {resets.map(r => (
                <TableRow key={`${r.platform}:${r.pool}`}>
                  <TableCell className="font-medium">{r.platform}</TableCell>
                  <TableCell>{formatSqliteUtcToLocalTime(r.reset_at, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</TableCell>
                  <TableCell className="text-right">{formatCountdown(r.seconds_until_reset)}</TableCell>
                  <TableCell className="text-right">{r.remaining ?? '—'}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </PanelState>
      </Panel>

      <Panel icon={Shield} title={t('quota.shadowTitle')}>
        <div className="mb-3 flex items-center gap-2 text-sm">
          <span className="text-muted-foreground">{t('quota.routingMode')}</span>
          <Badge variant="secondary">{modeData.mode}</Badge>
        </div>
        {/* Shadow can only show DIVERGENCE. The provider it preferred never ran,
            so nothing here says the other choice would have been better. */}
        <p className="mb-3 text-xs text-muted-foreground">{t('quota.shadowCaveat')}</p>
        <PanelState loading={shadowLoading} error={shadowError} empty={shadowData.stats.total === 0} emptyKey="quota.emptyShadow">
          <div className="space-y-4">
            <p className="text-sm">
              {t('quota.agreementSummary', {
                agreed: String(shadowData.stats.agreed),
                total: String(shadowData.stats.total),
              })}
            </p>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t('quota.colLogicalModel')}</TableHead>
                  <TableHead className="text-right">{t('quota.colDecisions')}</TableHead>
                  <TableHead className="text-right">{t('quota.colAgreed')}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {shadowData.stats.byLogicalModel.map(lm => (
                  <TableRow key={lm.logicalModel}>
                    <TableCell className="font-medium">{lm.logicalModel}</TableCell>
                    <TableCell className="text-right">{lm.total}</TableCell>
                    <TableCell className="text-right">{lm.agreed}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </PanelState>
      </Panel>

      <Panel icon={Shield} title={t('quota.divergenceTitle')}>
        <PanelState loading={decisionsLoading} error={decisionsError} empty={decisionsData.decisions.length === 0} emptyKey="quota.emptyDivergence">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t('quota.colWhen')}</TableHead>
                <TableHead>{t('quota.colLogicalModel')}</TableHead>
                <TableHead>{t('quota.colServed')}</TableHead>
                <TableHead>{t('quota.colPreferred')}</TableHead>
                <TableHead>{t('quota.colReason')}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {decisionsData.decisions.map(d => (
                <TableRow key={d.id}>
                  <TableCell>{formatSqliteUtcToLocalTime(d.createdAt, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</TableCell>
                  <TableCell className="font-medium">{d.logicalModel}</TableCell>
                  {/* Endpoint disambiguates two relays that share a platform name. */}
                  <TableCell>{d.actualEndpoint ? `${d.actualPlatform} (${d.actualEndpoint})` : d.actualPlatform}</TableCell>
                  <TableCell>{d.shadowPlatform == null ? '—' : d.shadowEndpoint ? `${d.shadowPlatform} (${d.shadowEndpoint})` : d.shadowPlatform}</TableCell>
                  <TableCell className="text-muted-foreground">{d.reason ?? '—'}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </PanelState>
      </Panel>

      <Panel icon={FileText} title={t('quota.policiesTitle')}>
        <PanelState loading={policiesLoading} error={policiesError} empty={policiesData.policies.length === 0} emptyKey="quota.emptyPolicies">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t('quota.colProvider')}</TableHead>
                <TableHead>{t('quota.colModel')}</TableHead>
                <TableHead>{t('quota.colMetric')}</TableHead>
                <TableHead>{t('quota.colScope')}</TableHead>
                <TableHead className="text-right">{t('quota.colLimit')}</TableHead>
                <TableHead>{t('quota.colSource')}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {policiesData.policies.map(p => (
                <TableRow key={p.id}>
                  <TableCell className="font-medium">{p.platform}</TableCell>
                  <TableCell className="text-muted-foreground">{p.modelId ?? t('quota.allModels')}</TableCell>
                  <TableCell>{p.metric}</TableCell>
                  <TableCell>{p.scope}</TableCell>
                  <TableCell className="text-right">{p.limit ?? '—'}</TableCell>
                  <TableCell className="text-muted-foreground">{p.source}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </PanelState>
      </Panel>

      <Panel icon={Flame} title={t('quota.burnTitle')}>
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
              const run = runsByPlatform.get(platform) ?? null;
              const active = run?.phase === 'burning' || run?.phase === 'recovering';
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
              );
            })}
          </TableBody>
        </Table>
      </Panel>
    </div>
  );
}
