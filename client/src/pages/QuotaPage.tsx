import { useQuery } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { Clock, FileText, Server, Shield } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { apiFetch } from '@/lib/api';
import { useI18n } from '@/i18n';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Badge } from '@/components/ui/badge';
import { formatSqliteUtcToLocalTime } from '@/lib/utils';

// Define interfaces based on API contracts
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

  const providers = forecastData.forecast;
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
        <PanelState loading={forecastLoading} error={forecastError} empty={providers.length === 0} emptyKey="quota.emptyOverview">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t('quota.colProvider')}</TableHead>
                <TableHead>{t('quota.colPool')}</TableHead>
                <TableHead className="text-right">{t('quota.colUsed')}</TableHead>
                <TableHead className="text-right">{t('quota.colRemaining')}</TableHead>
                <TableHead className="text-right">{t('quota.colLimit')}</TableHead>
                <TableHead className="text-right">{t('quota.colReset')}</TableHead>
                <TableHead>{t('quota.colStatus')}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {providers.map(p => {
                const status = getStatus(p.remaining_pct, p.low_balance);
                return (
                  <TableRow key={`${p.platform}:${p.pool}`}>
                    <TableCell className="font-medium">{p.platform}</TableCell>
                    <TableCell className="text-muted-foreground">{p.pool}</TableCell>
                    <TableCell className="text-right">{p.used ?? '—'}</TableCell>
                    <TableCell className="text-right">{p.remaining ?? '—'}</TableCell>
                    <TableCell className="text-right">{p.limit ?? '—'}</TableCell>
                    <TableCell className="text-right">{formatCountdown(p.seconds_until_reset)}</TableCell>
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
    </div>
  );
}
