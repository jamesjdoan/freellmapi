import { useState } from 'react'
import { AlertTriangle, ExternalLink } from 'lucide-react'
import type {
  ModelQuotaGuidance,
  ProviderQuotaGuidance,
  QuotaGuidanceLimits,
  QuotaGuidanceScope,
  QuotaGuidanceStatus,
} from '../../../../shared/types'
import { Button } from '@/components/ui/button'

const SCOPE_LABELS: Record<QuotaGuidanceScope, string> = {
  model: 'Per model',
  account: 'Provider account',
  project: 'Project + model',
  shared_pool: 'Shared pool',
  unmetered: 'Local / unmetered',
}

const STATUS_LABELS: Record<QuotaGuidanceStatus, string> = {
  verified: 'Verified',
  uncertain: 'Uncertain',
  contradictory: 'Contradictory',
  superseded: 'Superseded',
}

const ACCESS_LABELS: Record<ProviderQuotaGuidance['currentAccess'], string> = {
  available: 'Free access documented',
  payment_required: 'Payment required',
  unmetered: 'Local and unmetered',
  unknown: 'Account access unverified',
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

function formatDate(value: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value)
  if (!match) return value
  return `${Number(match[3])} ${MONTHS[Number(match[2]) - 1]} ${match[1]}`
}

function isStale(reviewAfter: string): boolean {
  return Date.now() > Date.parse(`${reviewAfter}T23:59:59Z`)
}

function LimitAction({
  limits,
  disabled,
  onUseLimits,
}: {
  limits: QuotaGuidanceLimits | null
  disabled: boolean
  onUseLimits?: (limits: QuotaGuidanceLimits) => void
}) {
  const [armed, setArmed] = useState(false)
  if (!limits || !onUseLimits) return null
  return (
    <Button
      type="button"
      size="sm"
      variant="outline"
      disabled={disabled}
      onClick={() => {
        if (!armed) {
          setArmed(true)
          return
        }
        setArmed(false)
        onUseLimits(limits)
      }}
    >
      {armed ? 'Confirm use' : 'Use these limits'}
    </Button>
  )
}

function GuidanceFacts({ guidance }: { guidance: Pick<ProviderQuotaGuidance, 'facts'> | Pick<ModelQuotaGuidance, 'facts'> }) {
  return (
    <div className="space-y-1.5">
      {guidance.facts.map((fact, index) => (
        <div key={`${fact.metric}-${fact.period}-${index}`} className="flex items-center justify-between gap-3 rounded-lg bg-muted/35 px-2.5 py-2 text-xs">
          <span>{fact.label}</span>
          {fact.applicability === 'reference_only' && (
            <span className="shrink-0 rounded-full border px-1.5 py-0.5 text-[10px] text-muted-foreground">Reference only</span>
          )}
        </div>
      ))}
    </div>
  )
}

/** What this install observed, as opposed to what the shipped guide documents.
 *  Deliberately not merged into the guidance catalogue: that file is research
 *  about a provider, reviewed on a date and shared by every install, while this
 *  is one key's behaviour on one account. Shown beside it, never over it. */
export interface MeasuredLimits {
  rpm: number | null
  rpd: number | null
  finding: string
  ranAt: string
}

export function QuotaGuidancePanel({
  guidance,
  modelGuidance,
  selectedModelId,
  measured,
  onUseLimits,
  onUseModelLimits,
  onUseMeasured,
}: {
  guidance: ProviderQuotaGuidance
  modelGuidance?: ModelQuotaGuidance | null
  selectedModelId?: string | null
  measured?: MeasuredLimits | null
  onUseLimits?: (limits: QuotaGuidanceLimits) => void
  onUseModelLimits?: (limits: QuotaGuidanceLimits) => void
  onUseMeasured?: (limits: QuotaGuidanceLimits) => void
}) {
  const stale = isStale(guidance.reviewAfter)
  const canApply = guidance.status === 'verified' && !stale
  const modelCanApply = modelGuidance?.status === 'verified' && !stale

  return (
    <aside className="space-y-4 rounded-2xl border bg-muted/10 p-4" aria-label="Free-tier quota guidance">
      <div>
        <div className="flex flex-wrap items-center gap-2">
          <h3 className="text-sm font-semibold">Free-tier guide</h3>
          <span className="rounded-full border px-2 py-0.5 text-[10px]">{SCOPE_LABELS[guidance.scope]}</span>
          <span className={`rounded-full px-2 py-0.5 text-[10px] ${guidance.status === 'verified' ? 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-300' : 'bg-amber-500/10 text-amber-700 dark:text-amber-300'}`}>
            {STATUS_LABELS[guidance.status]}
          </span>
          {stale && <span className="rounded-full bg-amber-500/10 px-2 py-0.5 text-[10px] text-amber-700 dark:text-amber-300">Needs review</span>}
        </div>
        <p className="mt-2 text-xs leading-relaxed text-muted-foreground">{guidance.summary}</p>
        <p className="mt-2 text-[11px] font-medium">Current access: {ACCESS_LABELS[guidance.currentAccess]}</p>
        <p className="mt-2 text-[11px] text-muted-foreground">Verified {formatDate(guidance.verifiedAt)} · review after {formatDate(guidance.reviewAfter)}</p>
      </div>

      <GuidanceFacts guidance={guidance} />

      {guidance.advisory && (
        <div className="flex gap-2 rounded-xl border border-amber-500/30 bg-amber-500/5 p-3 text-xs text-amber-800 dark:text-amber-200">
          <AlertTriangle className="mt-0.5 size-4 shrink-0" />
          <span>{guidance.advisory.message}</span>
        </div>
      )}

      <LimitAction limits={guidance.recommendedLimits} disabled={!canApply} onUseLimits={onUseLimits} />

      {modelGuidance && (
        <div className="space-y-3 border-t pt-4">
          <div>
            <p className="text-[10px] uppercase tracking-wide text-muted-foreground">Selected model</p>
            <code className="mt-1 block break-all text-xs">{modelGuidance.modelId}</code>
            <p className="mt-1 text-xs text-muted-foreground">{modelGuidance.summary}</p>
          </div>
          <GuidanceFacts guidance={modelGuidance} />
          {modelGuidance.advisory && <p className="text-xs text-amber-700 dark:text-amber-300">{modelGuidance.advisory.message}</p>}
          <LimitAction limits={modelGuidance.recommendedLimits} disabled={!modelCanApply} onUseLimits={onUseModelLimits} />
        </div>
      )}

      {measured && (measured.rpm != null || measured.rpd != null) && (
        <div className="space-y-2 border-t pt-4">
          <div className="flex flex-wrap items-center gap-2">
            <p className="text-[10px] uppercase tracking-wide text-muted-foreground">Measured here</p>
            <span className="rounded-full bg-emerald-500/10 px-2 py-0.5 text-[10px] text-emerald-700 dark:text-emerald-300">
              observed
            </span>
          </div>
          <p className="text-xs tabular-nums">
            {[measured.rpm == null ? null : `${measured.rpm}/min`, measured.rpd == null ? null : `${measured.rpd}/day`]
              .filter(Boolean).join(' · ')}
          </p>
          <p className="text-[11px] leading-relaxed text-muted-foreground">{measured.finding}</p>
          {/* The guide above documents a provider in general; this is what this
              key was actually allowed, which is the number worth applying when
              the two disagree. */}
          {onUseMeasured && (
            <button
              type="button"
              onClick={() => onUseMeasured({ rpmLimit: measured.rpm, rpdLimit: measured.rpd, tpmLimit: null, tpdLimit: null })}
              className="rounded-full border px-2 py-0.5 text-[10px] hover:bg-muted"
            >
              Use measured limits
            </button>
          )}
        </div>
      )}

      {selectedModelId && !modelGuidance && guidance.scope === 'model' && (
        <div className="border-t pt-4 text-xs text-muted-foreground">
          No verified model-specific guidance is recorded for <code className="break-all text-foreground">{selectedModelId}</code>.
        </div>
      )}

      <div className="space-y-1 border-t pt-3">
        {guidance.sources.map(source => (
          <a
            key={source.url}
            href={source.url}
            target="_blank"
            rel="noreferrer"
            className="flex items-center gap-1 text-[11px] text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
          >
            <ExternalLink className="size-3" />
            {source.title}
          </a>
        ))}
      </div>
    </aside>
  )
}
