import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { ChevronDown, Clock, FileText, Flame, Server, Shield, Trash2 } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { apiFetch } from '@/lib/api';
import { useI18n } from '@/i18n';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Badge } from '@/components/ui/badge';
import { Tooltip as HoverTooltip } from '@/components/tooltip';
import { TimeTreeLog } from '@/components/time-tree-log';
import { parseSqliteUtc } from '@/lib/time-tree';
import { ConfirmButton } from '@/components/confirm-button';
import { QuotaProbeLogPanel } from '@/components/quota-probe-log';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Fragment, useState } from 'react';
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
  /** Seconds for one unit to refill, when this allowance is a bucket. */
  refillSeconds?: number | null;
  /** Other windows on this same counter, folded onto one row by the server. */
  alsoBound?: Array<{
    pool: string | null;
    limit: number | null;
    used: number | null;
    remaining: number | null;
    remaining_pct: number | null;
    seconds_until_reset: number | null;
    source: string | null;
  }>;
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
  memberModelIds: string[];
  aggregated?: boolean;
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

interface UsageWindow {
  used: number;
  limit: number;
  resetAtMs: number | null;
  /** How the window ends. A countdown alone cannot distinguish a rolling
   *  window, which frees one call at a time, from a calendar one that returns
   *  the whole allowance at a fixed local hour. */
  period: { kind: string; timezone: string | null } | null;
}
interface ModelUsageRow {
  modelDbId: number;
  platform: string;
  modelId: string;
  rpm: UsageWindow | null;
  rpd: UsageWindow | null;
  tpm: UsageWindow | null;
}

interface PolicyRow {
  id: string;
  platform: string;
  modelId: string | null;
  metric: string;
  scope: string;
  limit: number | null;
  period: string;
  periodKind: string;
  periodMs: number | null;
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
/** A rolling window reads as its width, not as the word "rolling": one model
 *  legitimately holds 5 per minute AND 20 per day, and without the width those
 *  two rows look like one number contradicting itself. */
/** A model's live counters beneath its provider: spent, left, ceiling, reset.
 *  Left is coloured by pressure, because that is the number a reader acts on. */
function ModelUsageRow({ row, rowKey }: { row: ModelUsageRow; rowKey: string }) {
  const { t, locale } = useI18n();
  const day = row.rpd;
  const minute = row.rpm;
  const left = day ? Math.max(0, day.limit - day.used) : null;
  const spent = day && day.limit > 0 ? day.used / day.limit : 0;
  return (
    <TableRow key={rowKey} className="bg-muted/20">
      <TableCell />
      <TableCell colSpan={2} className="py-1">
        <code className="text-[11px] text-muted-foreground">{row.modelId}</code>
      </TableCell>
      <TableCell className="py-1 text-right tabular-nums">{day ? day.used : '—'}</TableCell>
      <TableCell className={`py-1 text-right tabular-nums ${spent >= 0.9 ? 'text-rose-600 dark:text-rose-400' : spent >= 0.67 ? 'text-amber-700 dark:text-amber-400' : ''}`}>
        {left ?? '—'}
      </TableCell>
      <TableCell className="py-1 text-right tabular-nums">
        {day ? <>{day.limit}<span className="text-muted-foreground">/day</span></> : '—'}
      </TableCell>
      {/* Seconds from the resolved window, not a guess: null when the limit
          came from a catalogue column, which states no period to reset. */}
      <TableCell className="py-1 text-right tabular-nums">
        {day?.resetAtMs != null
          ? formatCountdown(Math.max(0, Math.round((day.resetAtMs - Date.now()) / 1000)))
          : '—'}
        {day?.period && (
          <span
            className="ml-1 text-[10px] text-muted-foreground"
            title={`${t('quota.windowKindHint')}${day.period.timezone ? ` (${day.period.timezone})` : ''}`}
          >
            {day.period.kind === 'rolling'
              ? t('quota.windowRolling')
              : shortZone(day.period.timezone ?? 'UTC', locale)}
          </span>
        )}
      </TableCell>
      <TableCell className="py-1 text-[11px] text-muted-foreground">
        {minute ? t('quota.modelPerMinute', { used: minute.used, limit: minute.limit }) : ''}
      </TableCell>
    </TableRow>
  );
}

/**
 * The window a limit is counted over, read off the pool key.
 *
 * A bare "1000" in a Limit column is unreadable: per minute, per day and per
 * week are three different providers' worth of capacity. Empty when the key
 * names no window — a credit balance is an amount, not a rate, and guessing a
 * period for it would be worse than the silence.
 */
/** A zone as a reader recognises it — PDT, not America/Los_Angeles. The full
 *  name stays in the title, because the abbreviation is ambiguous worldwide and
 *  the column is four characters wide. */
function shortZone(timeZone: string, locale: string): string {
  try {
    const part = new Intl.DateTimeFormat(locale, { timeZone, timeZoneName: 'short' })
      .formatToParts(new Date())
      .find(p => p.type === 'timeZoneName');
    return part?.value ?? timeZone;
  } catch {
    return timeZone;
  }
}

export function poolPeriodSuffix(pool: string | null | undefined): string {
  if (!pool) return '';
  const tail = pool.slice(pool.lastIndexOf('::') + 2);
  if (tail === 'calendar_day') return '/day';
  if (tail === 'calendar_week' || tail === 'weekly') return '/week';
  if (tail === 'calendar_month' || tail === 'monthly') return '/month';
  const rolling = /^rolling-(\d+)s$/.exec(tail);
  if (!rolling) return '';
  const seconds = Number(rolling[1]);
  if (seconds === 60) return '/min';
  if (seconds === 3600) return '/hour';
  if (seconds === 86_400) return '/day';
  return `/${seconds}s`;
}

export function policyPeriodLabel(p: { periodKind: string; periodMs: number | null }): string {
  // A bucket has no period to be "per": it refills one unit at a time, so the
  // honest label is the rate. Measured on Groq at one per 86.4s.
  if (p.periodKind === 'bucket') {
    const seconds = (p.periodMs ?? 0) / 1000;
    return seconds > 0 ? `1 per ${Number(seconds.toFixed(1))}s` : 'refilling';
  }
  if (p.periodKind !== 'rolling') return p.periodKind.replace('calendar_', 'per ').replace('_', ' ');
  if (p.periodMs == null) return 'rolling';
  const minutes = p.periodMs / 60_000;
  if (minutes < 60) return minutes === 1 ? 'per minute' : `per ${minutes} minutes`;
  const hours = minutes / 60;
  return hours === 24 ? 'per day' : hours === 1 ? 'per hour' : `per ${hours} hours`;
}

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

function Panel({ icon: Icon, title, action, children }: {
  icon: LucideIcon;
  title: string;
  /** Header-level control, to the right of the title. */
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="border bg-card rounded-3xl px-4 py-3">
      <div className="flex items-center gap-2">
        <Icon className="size-4" aria-hidden="true" />
        <h3 className="text-sm font-semibold">{title}</h3>
        {action && <div className="ml-auto">{action}</div>}
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
const PERIOD_KINDS = ['rolling', 'calendar_day', 'calendar_week', 'calendar_month', 'billing_cycle', 'bucket'] as const;
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
  const [refillSeconds, setRefillSeconds] = useState('');
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
        periodMs: periodKind === 'rolling' ? Math.round(Number(periodHours) * 3_600_000)
          : periodKind === 'bucket' ? Math.round(Number(refillSeconds) * 1000)
          : null,
        timezone: timezone.trim() || null,
        anchorDay: periodKind === 'billing_cycle' ? Number(anchorDay) : null,
      }),
    }),
    onSuccess: () => { setLimit(''); onSaved(); },
  });

  const positive = (value: string): boolean => Number(value) > 0 && Number.isFinite(Number(value));
  const incomplete = !platform || !positive(limit)
    || (periodKind === 'rolling' && !positive(periodHours))
    || (periodKind === 'bucket' && !positive(refillSeconds))
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
        {periodKind === 'bucket' && field(t('quota.policyRefillSeconds'), (
          <Input value={refillSeconds} onChange={e => setRefillSeconds(e.target.value)} inputMode="decimal"
            placeholder="86.4" className="h-8 text-sm" />
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

  // Per-model usage, refreshed while the page is open: this panel is read to
  // decide whether a route can serve NOW, and a stale count answers a question
  // nobody asked.
  const { data: modelUsage = { rows: [] as ModelUsageRow[] } } = useQuery({
    queryKey: ['fallback', 'rate-limit-usage'],
    queryFn: () => apiFetch<{ rows: ModelUsageRow[] }>('/api/fallback/rate-limit-usage'),
    refetchInterval: 15_000,
  });
  const usageByModel = new Map(modelUsage.rows.map(r => [`${r.platform}\u0000${r.modelId}`, r]));
  // A pool lists its members, so an expansion shows those rows and nothing
  // else: a model outside this pool cannot appear beneath it.
  const [expandedPools, setExpandedPools] = useState<Set<string>>(new Set());
  const [expandedPlatforms, setExpandedPlatforms] = useState<Set<string>>(new Set());
  const [editingRows, setEditingRows] = useState(false);

  const { data: hiddenData = { pools: [] as string[] } } = useQuery({
    queryKey: ['quota', 'hidden-pools'],
    queryFn: () => apiFetch<{ pools: string[] }>('/api/quota/hidden-pools'),
  });
  const hiddenPools = new Set(hiddenData.pools);
  const setHidden = useMutation({
    mutationFn: (pools: string[]) =>
      apiFetch('/api/quota/hidden-pools', { method: 'PUT', body: JSON.stringify({ pools }) }),
    onSuccess: () => { void queryClient.invalidateQueries({ queryKey: ['quota', 'hidden-pools'] }); },
  });
  const toggleHidden = (pool: string) => {
    const next = new Set(hiddenPools);
    if (next.has(pool)) next.delete(pool); else next.add(pool);
    setHidden.mutate([...next]);
  };

  // One group per provider, so a provider that reports three per-model pools
  // (Groq) and one that reports a single account window (Google) read the same
  // way. A total is offered only where the pools count SEPARATELY, in the same
  // unit and window — summing a session credit balance onto a daily request
  // count would produce a number with no meaning.
  const providerGroups = (() => {
    const byPlatform = new Map<string, ProviderOverviewRow[]>();
    const visible = editingRows ? providers : providers.filter(p => !hiddenPools.has(p.pool ?? ''));
    for (const p of visible) {
      const list = byPlatform.get(p.platform);
      if (list) list.push(p); else byPlatform.set(p.platform, [p]);
    }
    return [...byPlatform.entries()].map(([platform, pools]) => {
      // A refilling bucket is a RATE. Three Groq models at 1,000 each are not
      // 3,000 of anything you can spend before a deadline — there is no
      // deadline — and the header totalled them into "3,000 remaining,
      // resets —". Only balances add up.
      const summable = pools.every(p =>
        p.metered && p.metric === 'requests' && p.unit == null && p.limit != null && p.used != null
        && p.refillSeconds == null);
      const resets = pools.map(p => p.seconds_until_reset).filter((n): n is number => n != null);
      const perModelPools = pools.length > 1
        && pools.every(p => p.metric === 'requests' && p.memberModelIds.length === 1);
      return {
        platform,
        pools,
        // Union, in pool order: the fold is presentational and must not change
        // which models a provider is shown to have.
        foldedModelIds: perModelPools ? pools.flatMap(p => p.memberModelIds) : null,
        total: summable && pools.length > 1
          ? {
              used: pools.reduce((n, p) => n + (p.used ?? 0), 0),
              limit: pools.reduce((n, p) => n + (p.limit ?? 0), 0),
              remaining: pools.reduce((n, p) => n + (p.remaining ?? 0), 0),
              secondsUntilReset: resets.length > 0 ? Math.min(...resets) : null,
            }
          : null,
      };
    });
  })();

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

      <Panel
        icon={Server}
        title={t('quota.overviewTitle')}
        action={
          <button
            type="button"
            onClick={() => setEditingRows(v => !v)}
            aria-pressed={editingRows}
            className={`rounded-full border px-2 py-0.5 text-[11px] ${editingRows ? 'bg-muted' : 'hover:bg-muted/50'}`}
          >
            {editingRows ? t('quota.rowsDone') : t('quota.rowsEdit')}
            {hiddenPools.size > 0 && !editingRows && (
              <span className="ml-1 text-muted-foreground tabular-nums">{t('quota.rowsHiddenCount', { count: hiddenPools.size })}</span>
            )}
          </button>
        }
      >
        <PanelState loading={providerLoading} error={providerError} empty={providers.length === 0} emptyKey="quota.emptyOverview">
          <Table containerClassName="max-h-[70vh] overflow-auto">
            {/* Pinned: with every provider expanded the numbers scroll far past
                the column names, and a row of bare figures says nothing. */}
            <TableHeader className="sticky top-0 z-10 bg-card">
              <TableRow>
                <TableHead>{t('quota.colProvider')}</TableHead>
                <TableHead>{t('quota.colPool')}</TableHead>
                <TableHead>{t('quota.colCounts')}</TableHead>
                <TableHead className="text-right">{t('quota.colUsed')}</TableHead>
                <TableHead className="text-right">{t('quota.colRemaining')}</TableHead>
                <TableHead className="text-right">{t('quota.colLimit')}</TableHead>
                <TableHead className="text-right">{t('quota.colReset')}</TableHead>
                <TableHead>{t('quota.colStatus')}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {providerGroups.map(group => (
                <Fragment key={`group:${group.platform}`}>
                  {group.pools.length > 1 && (
                    <TableRow className="border-t-2">
                      <TableCell className="font-medium">
                        <button
                          type="button"
                          onClick={() => setExpandedPlatforms(prev => {
                            const next = new Set(prev);
                            if (next.has(group.platform)) next.delete(group.platform); else next.add(group.platform);
                            return next;
                          })}
                          aria-expanded={expandedPlatforms.has(group.platform)}
                          className="inline-flex items-center gap-1 hover:underline"
                        >
                          <ChevronDown className={`size-3 transition-transform ${expandedPlatforms.has(group.platform) ? '' : '-rotate-90'}`} aria-hidden="true" />
                          {group.platform}
                        </button>
                      </TableCell>
                      <TableCell className="text-muted-foreground">
                        {group.foldedModelIds
                          ? t('quota.poolMembers', { count: group.foldedModelIds.length })
                          : t('quota.poolCount', { count: group.pools.length })}
                        {group.total && <div className="text-[10px]">{t('quota.poolSummed')}</div>}
                      </TableCell>
                      <TableCell className="text-muted-foreground">
                        {group.total ? t('quota.metric_requests') : '—'}
                      </TableCell>
                      {/* Summed only across pools that count separately and in
                          the same unit and window. Anything else — Ollama's
                          session credits beside its daily requests — has no
                          meaningful total, and a dash says so. */}
                      <TableCell className="text-right tabular-nums">{group.total ? group.total.used : '—'}</TableCell>
                      <TableCell className="text-right tabular-nums">{group.total ? group.total.remaining : '—'}</TableCell>
                      <TableCell className="text-right tabular-nums">
                        {group.total ? <>
                          {group.total.limit}
                          <span className="text-muted-foreground">
                            {group.foldedModelIds ? '/day' : poolPeriodSuffix(group.pools[0]?.pool)}
                          </span>
                        </> : '—'}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        {group.total?.secondsUntilReset != null ? formatCountdown(group.total.secondsUntilReset) : '—'}
                      </TableCell>
                      <TableCell />
                    </TableRow>
                  )}
                  {group.foldedModelIds && expandedPlatforms.has(group.platform) && group.foldedModelIds
                    .map(id => usageByModel.get(`${group.platform}\u0000${id}`))
                    .filter((r): r is ModelUsageRow => r != null)
                    .map(r => (
                      <ModelUsageRow key={`${group.platform}:${r.modelId}`} rowKey={`${group.platform}:${r.modelId}`} row={r} />
                    ))}
                  {!group.foldedModelIds
                    && (group.pools.length === 1 || expandedPlatforms.has(group.platform)) && group.pools.map(p => {
                // An unmetered provider has no percentage to judge; getStatus
                // already reports null as Unknown rather than as healthy.
                const status = getStatus(p.metered ? p.remaining_pct : null, p.low_balance);
                const poolKey = `${p.platform}:${p.pool ?? 'unknown'}`;
                const open = expandedPools.has(poolKey);
                const memberRows = (p.memberModelIds ?? [])
                  .map(id => usageByModel.get(`${p.platform}\u0000${id}`))
                  .filter((r): r is ModelUsageRow => r != null);
                return (
                  <Fragment key={poolKey}>
                  <TableRow>
                    <TableCell className="font-medium">
                      {/* The pool total answers "is there room"; the models
                          answer "room for WHICH route", which is the question
                          asked next and previously required another page. */}
                      {memberRows.length > 0 ? (
                        <button
                          type="button"
                          onClick={() => setExpandedPools(prev => {
                            const next = new Set(prev);
                            if (next.has(poolKey)) next.delete(poolKey); else next.add(poolKey);
                            return next;
                          })}
                          aria-expanded={open}
                          className="inline-flex items-center gap-1 hover:underline"
                        >
                          <ChevronDown className={`size-3 transition-transform ${open ? '' : '-rotate-90'}`} aria-hidden="true" />
                          {p.platform}
                        </button>
                      ) : p.platform}
                    </TableCell>
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
                      {p.aggregated && (
                        <div className="text-[10px] text-muted-foreground">{t('quota.poolSummed')}</div>
                      )}
                      <div className="text-[10px] text-muted-foreground">
                        {p.source ?? '—'}
                        {p.usedSource === 'local' && (
                          <HoverTooltip text={t('quota.locallyCountedHint')}>
                            <span className="ml-1">{t('quota.locallyCountedMark')}</span>
                          </HoverTooltip>
                        )}
                        {/* Estimates stay prefixed and keep their sample count:
                            a reader must be able to tell one from a number the
                            provider stated. */}
                        {p.inferred.map(w => (
                          <span key={`${w.method}:${w.period}`} className="ml-1" title={w.note}>
                            {t('quota.inferredWindow', { period: t(`quota.period_${w.period}`), samples: w.samples })}
                          </span>
                        ))}
                      </div>
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
                      {editingRows && p.pool && (
                        <button
                          type="button"
                          onClick={() => toggleHidden(p.pool!)}
                          disabled={setHidden.isPending}
                          className="ml-2 rounded-full border px-1.5 py-0.5 text-[10px] hover:bg-muted"
                        >
                          {hiddenPools.has(p.pool) ? t('quota.rowShow') : t('quota.rowHide')}
                        </button>
                      )}
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
                        : <>
                            {formatAmount(p.limit, p.unit)}
                            <span className="text-muted-foreground">
                              {p.refillSeconds != null
                                ? t('quota.refillRate', { seconds: p.refillSeconds })
                                : poolPeriodSuffix(p.pool)}
                            </span>
                          </>}
                      {/* The other windows bounding this same counter, rendered
                          for every shape of row. Ollama's balance takes the
                          derived-allowance branch above, so a copy inside the
                          plain-count branch left its session window invisible —
                          a limit that still refuses requests, hidden by the
                          fold meant to clarify it. */}
                      {(p.alsoBound ?? []).map(w => (
                        <span key={w.pool ?? 'w'} className="text-muted-foreground">
                          {' · '}{formatAmount(w.limit, p.unit)}{poolPeriodSuffix(w.pool)}
                        </span>
                      ))}
                    </TableCell>
                    {/* A predicted countdown is marked, because for these
                        pools the provider sends no reset at all: its 429
                        carries none and retry-after is empty. */}
                    <TableCell className="text-right tabular-nums whitespace-nowrap">
                      {formatCountdown(p.seconds_until_reset)}
                      {p.pool?.includes('::rolling-') && (
                        <span className="ml-1 text-[10px] text-muted-foreground" title={t('quota.windowKindHint')}>
                          {t('quota.windowRolling')}
                        </span>
                      )}
                      {p.resetSource === 'inferred' && p.seconds_until_reset != null
                        ? <span className="ml-1 text-xs text-muted-foreground"
                            title={t('quota.resetInferredHint')}>{t('quota.resetInferredMark')}</span>
                        : null}
                    </TableCell>
                    <TableCell><Badge variant={status.variant}>{t(status.labelKey)}</Badge></TableCell>
                  </TableRow>
                  {open && memberRows.map(r => (
                    <ModelUsageRow key={`${poolKey}:${r.modelId}`} rowKey={`${poolKey}:${r.modelId}`} row={r} />
                  ))}
                  </Fragment>
                );
              })}
                </Fragment>
              ))}
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
                <TableHead>{t('quota.colPeriod')}</TableHead>
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
                  <TableCell className="text-right tabular-nums">{p.limit ?? '—'}</TableCell>
                  <TableCell className="text-muted-foreground">{policyPeriodLabel(p)}</TableCell>
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

      {/* Measured limits, beside the declared ones above: the policies panel
          says what the system believes, this says what a provider was actually
          observed to allow. Related to the burn runs below but not the same
          record — a burn finds one platform's ceiling, a probe reads the limit
          a single model names in its refusal. */}
      <QuotaProbeLogPanel />

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
