import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { Clock, FileText, Flame, Server, Shield, Trash2 } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { apiFetch } from '@/lib/api';
import { useI18n } from '@/i18n';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Badge } from '@/components/ui/badge';
import { Tooltip as HoverTooltip } from '@/components/tooltip';
import { TimeTreeLog } from '@/components/time-tree-log';
import { parseSqliteUtc } from '@/lib/time-tree';
import { ConfirmButton } from '@/components/confirm-button';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { useState } from 'react';
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
  /** Routed models drawing on this pool. Empty when nothing routes to it. */
  members: string[];
  resetSource: 'provider' | 'inferred' | null;
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
 * The pool key without its platform prefix.
 *
 * The Provider column already carries `nvidia`, so `nvidia::rolling-60s` spends
 * width repeating it on every row — width the used/remaining/limit columns need
 * to stay readable. Only the leading `<platform>::` is dropped; the rest of the
 * key is left exactly as the router knows it, because it is the identifier an
 * operator matches against `quota_policy` and the routing diagnostics.
 */
export function poolLabel(row: { platform: string; pool: string | null }): string {
  if (!row.pool) return '—';
  const prefix = `${row.platform}::`;
  return row.pool.startsWith(prefix) ? row.pool.slice(prefix.length) : row.pool;
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

/** Period kinds the API accepts, and what each additionally requires. */
const PERIOD_KINDS = ['rolling', 'calendar_day', 'calendar_week', 'calendar_month', 'billing_cycle'] as const;
const METRICS = ['requests', 'input_tokens', 'output_tokens', 'total_tokens', 'credits'] as const;
const SCOPES = ['provider_account', 'provider_key', 'model', 'shared_pool'] as const;

/**
 * Operator quota policies — the only place a reset time can be declared for a
 * provider that does not report one.
 *
 * The conditional requirements are enforced here as well as server-side, so a
 * rolling window without a length is unsubmittable rather than a 400: the API
 * rejects `rolling` with no periodMs and `billing_cycle` with no anchorDay.
 */
function PolicyEditor({ platforms, onSaved }: { platforms: string[]; onSaved: () => void }) {
  const { t } = useI18n();
  const [platform, setPlatform] = useState(platforms[0] ?? '');
  const [modelId, setModelId] = useState('');
  const [metric, setMetric] = useState<string>('requests');
  const [scope, setScope] = useState<string>('provider_account');
  const [limit, setLimit] = useState('');
  const [periodKind, setPeriodKind] = useState<string>('calendar_day');
  const [periodHours, setPeriodHours] = useState('');
  const [timezone, setTimezone] = useState('');
  const [anchorDay, setAnchorDay] = useState('');

  const save = useMutation({
    mutationFn: () => apiFetch('/api/quota/policies', {
      method: 'PUT',
      body: JSON.stringify({
        platform,
        modelId: modelId.trim() || null,
        metric,
        scope,
        limit: Number(limit),
        periodKind,
        // The API wants milliseconds; hours is the unit an operator thinks in,
        // and Ollama's measured session window is 5h.
        periodMs: periodKind === 'rolling' ? Math.round(Number(periodHours) * 3_600_000) : null,
        timezone: timezone.trim() || null,
        anchorDay: periodKind === 'billing_cycle' ? Number(anchorDay) : null,
      }),
    }),
    onSuccess: () => { setLimit(''); onSaved(); },
  });

  const positive = (value: string): boolean => Number(value) > 0 && Number.isFinite(Number(value));
  const incomplete = !platform || !positive(limit)
    || (periodKind === 'rolling' && !positive(periodHours))
    || (periodKind === 'billing_cycle' && !(Number(anchorDay) >= 1 && Number(anchorDay) <= 31));

  const field = (label: string, control: ReactNode) => (
    <label className="flex flex-col gap-1 text-xs text-muted-foreground">
      {label}
      {control}
    </label>
  );
  const dropdown = (value: string, set: (v: string) => void, options: readonly string[], label: string) => (
    <Select value={value} onValueChange={(v) => set(v ?? value)}>
      <SelectTrigger size="sm" aria-label={label}>
        <SelectValue>{(v: string) => v || value}</SelectValue>
      </SelectTrigger>
      <SelectContent>
        {options.map(o => <SelectItem key={o} value={o}>{o}</SelectItem>)}
      </SelectContent>
    </Select>
  );

  return (
    <div className="mt-4 space-y-3 border-t pt-4">
      <p className="text-xs text-muted-foreground">{t('quota.policyEditorHint')}</p>
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        {field(t('quota.colProvider'), dropdown(platform, setPlatform, platforms, t('quota.colProvider')))}
        {field(t('quota.colModel'), (
          <Input value={modelId} onChange={e => setModelId(e.target.value)}
            placeholder={t('quota.allModels')} className="h-8 text-sm" />
        ))}
        {field(t('quota.colMetric'), dropdown(metric, setMetric, METRICS, t('quota.colMetric')))}
        {field(t('quota.colScope'), dropdown(scope, setScope, SCOPES, t('quota.colScope')))}
        {field(t('quota.colLimit'), (
          <Input value={limit} onChange={e => setLimit(e.target.value)} inputMode="numeric"
            placeholder="1000" className="h-8 text-sm" />
        ))}
        {field(t('quota.colPeriod'), dropdown(periodKind, setPeriodKind, PERIOD_KINDS, t('quota.colPeriod')))}
        {periodKind === 'rolling' && field(t('quota.policyWindowHours'), (
          <Input value={periodHours} onChange={e => setPeriodHours(e.target.value)} inputMode="decimal"
            placeholder="5" className="h-8 text-sm" />
        ))}
        {periodKind === 'billing_cycle' && field(t('quota.policyAnchorDay'), (
          <Input value={anchorDay} onChange={e => setAnchorDay(e.target.value)} inputMode="numeric"
            placeholder="8" className="h-8 text-sm" />
        ))}
        {periodKind !== 'rolling' && field(t('quota.policyTimezone'), (
          <Input value={timezone} onChange={e => setTimezone(e.target.value)}
            placeholder="UTC" className="h-8 text-sm" />
        ))}
      </div>
      {save.error ? <p className="text-sm text-destructive">{(save.error as Error).message}</p> : null}
      <Button size="sm" disabled={incomplete || save.isPending} onClick={() => save.mutate()}>
        {t('quota.policySave')}
      </Button>
    </div>
  );
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
  const deletePolicy = useMutation({
    mutationFn: (id: string) => apiFetch(`/api/quota/policies/${id}`, { method: 'DELETE' }),
    onSuccess: () => { void queryClient.invalidateQueries({ queryKey: ['quota', 'policies'] }); },
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
                    {/* The pool key drops its platform prefix: the Provider
                        column to the left already says `nvidia`, and repeating
                        it in `nvidia::rolling-60s` on every row costs width the
                        numbers need.

                        Membership is a COUNT with the names on hover, not an
                        inline list. Spelling out seven NVIDIA models here wrapped
                        the cell to four lines and squeezed used/remaining/limit
                        down to unreadable — the panel's whole job. The count is
                        the part that is scanned ("is this one route or seven?");
                        the names are what you ask for once. */}
                    <TableCell className="text-muted-foreground">
                      <div className="whitespace-nowrap">{poolLabel(p)}</div>
                      {p.members.length > 0 && (
                        <HoverTooltip text={p.members.join('\n')}>
                          <span className="text-xs opacity-75 underline decoration-dotted underline-offset-2">
                            {p.members.length === 1 ? t('quota.poolMembersOne') : t('quota.poolMembers', { count: p.members.length })}
                          </span>
                        </HoverTooltip>
                      )}
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {p.metric ? t(`quota.metric_${p.metric}`) : '—'}
                    </TableCell>
                    <TableCell className="text-right tabular-nums whitespace-nowrap">{formatAmount(p.used, p.unit)}</TableCell>
                    <TableCell className="text-right tabular-nums whitespace-nowrap">{formatAmount(p.remaining, p.unit)}</TableCell>
                    {/* For a pool the provider reports only as a fraction, the
                        stored limit is a synthetic scale — showing "100.0%" as
                        a ceiling states nothing. The derived allowance is a
                        real figure when we have one, and a dash is honest when
                        we do not. */}
                    <TableCell className="text-right tabular-nums whitespace-nowrap">
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
                    {/* A predicted countdown is marked, because for these
                        pools the provider sends no reset at all: its 429
                        carries none and retry-after is empty. */}
                    <TableCell className="text-right tabular-nums whitespace-nowrap">
                      {formatCountdown(p.seconds_until_reset)}
                      {p.resetSource === 'inferred' && p.seconds_until_reset != null
                        ? <span className="ml-1 text-xs text-muted-foreground"
                            title={t('quota.resetInferredHint')}>{t('quota.resetInferredMark')}</span>
                        : null}
                    </TableCell>
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
                    {/* "(counted locally)" spelled out was the widest thing on
                        the row after the member list — long enough to push the
                        Status badge off the right edge entirely. Folded into a
                        marker with the full wording on hover, matching what the
                        Resets column already does for an inferred countdown. */}
                    <TableCell className="text-muted-foreground whitespace-nowrap">
                      {p.source ?? '—'}
                      {p.usedSource === 'local'
                        ? <HoverTooltip text={t('quota.locallyCountedHint')}>
                            <span className="ml-1 text-xs">{t('quota.locallyCountedMark')}</span>
                          </HoverTooltip>
                        : null}
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
          {/* Folded by year/month/week, same control as the catalogue log.
              This list only holds the rows where the two routers disagreed, so
              it is sparse and bursty - a flat table of it reads as noise, while
              the week summary reads as "the shadow router differed 4 times". */}
          <TimeTreeLog
            recentLabel={t('quota.divergenceRecent')}
            unit="day"
            items={decisionsData.decisions}
            at={d => parseSqliteUtc(d.createdAt)}
            itemKey={d => String(d.id)}
            summary={items => (
              <span className="tabular-nums">{t('log.disagreed', { count: items.length })}</span>
            )}
            row={d => (
              <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 text-xs">
                <span className="font-medium">{d.logicalModel}</span>
                {/* Endpoint disambiguates two relays that share a platform name. */}
                <span>{d.actualEndpoint ? `${d.actualPlatform} (${d.actualEndpoint})` : d.actualPlatform}</span>
                <span className="text-muted-foreground">→</span>
                <span>{d.shadowPlatform == null ? '—' : d.shadowEndpoint ? `${d.shadowPlatform} (${d.shadowEndpoint})` : d.shadowPlatform}</span>
                {d.reason && <span className="text-[11px] text-muted-foreground">{d.reason}</span>}
                <span className="ml-auto flex-shrink-0 text-[11px] text-muted-foreground tabular-nums">
                  {parseSqliteUtc(d.createdAt).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}
                </span>
              </div>
            )}
          />
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
                <TableHead className="text-right">{t('quota.colAction')}</TableHead>
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
                  <TableCell className="text-right">
                    {/* Only an operator declaration can be deleted; a derived
                        row would just be rebuilt on the next resolve. */}
                    {p.source === 'operator' ? (
                      <ConfirmButton onConfirm={() => deletePolicy.mutate(p.id)}
                        confirmLabel={t('quota.policyDeleteConfirm')} aria-label={t('quota.policyDelete')}>
                        <Trash2 className="size-4" aria-hidden="true" />
                      </ConfirmButton>
                    ) : null}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </PanelState>
        <PolicyEditor
          platforms={[...new Set(providers.map(r => r.platform))]}
          onSaved={() => { void queryClient.invalidateQueries({ queryKey: ['quota', 'policies'] }); }}
        />
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
