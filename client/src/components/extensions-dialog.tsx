import { useState } from 'react'
import { ArrowUpRight, ExternalLink, ShieldAlert, TriangleAlert } from 'lucide-react'
import { Link } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Dialog, DialogPopup, DialogTitle } from '@/components/ui/dialog'
import { Button, buttonVariants } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import { Input } from '@/components/ui/input'
import { apiFetch } from '@/lib/api'
import { useI18n } from '@/i18n'
import { refreshExtensionState } from '@/lib/use-extension'
import {
  PAID_BALANCE_GUARD_ID,
  PAID_SPEND_CONFIRMATION,
  type ImperiumExtension,
} from '@freellmapi/shared/extension-registry'

type ExtensionRow = ImperiumExtension & { enabled: boolean }
type ExtensionsPayload = {
  revision: number
  paidSpendAcknowledgement: null | { policyVersion: 1; confirmedAt: string }
  extensions: ExtensionRow[]
}

const CATEGORY_ORDER: ImperiumExtension['category'][] = ['safety', 'routing', 'presentation', 'tooling']

export function ExtensionFeatureList({ onNavigate }: { onNavigate?: () => void }) {
  const { t } = useI18n()
  const queryClient = useQueryClient()
  const categoryLabel: Record<ImperiumExtension['category'], string> = {
    routing: t('extensions.catRouting'),
    presentation: t('extensions.catPresentation'),
    safety: t('extensions.catSafety'),
    tooling: t('extensions.catTooling'),
  }
  const { data, isPending, isError } = useQuery<ExtensionsPayload>({
    queryKey: ['extensions'],
    queryFn: () => apiFetch('/api/extensions'),
  })
  const [confirmFor, setConfirmFor] = useState<string | null>(null)
  const [confirmText, setConfirmText] = useState('')
  const [error, setError] = useState<string | null>(null)

  const toggle = useMutation({
    mutationFn: ({ id, enabled, confirmation }: { id: string; enabled: boolean; confirmation?: string }) =>
      apiFetch(`/api/extensions/${encodeURIComponent(id)}`, {
        method: 'PUT',
        body: JSON.stringify({ enabled, expectedRevision: data?.revision, confirmation }),
      }),
    onSuccess: () => {
      setConfirmFor(null)
      setConfirmText('')
      setError(null)
      queryClient.invalidateQueries({ queryKey: ['extensions'] })
      // Gated surfaces read a separate module store (see use-extension.ts), so
      // they need telling too — otherwise a panel stays visible until reload.
      refreshExtensionState()
    },
    onError: (err: unknown) => setError(err instanceof Error ? err.message : String(err)),
  })

  // Loading and failure are NOT "everything on": showing a switch whose
  // position we cannot read would misreport what the server is doing.
  if (isPending) return <p className="mt-5 text-xs text-muted-foreground">{t('extensions.reading')}</p>
  if (isError || !data) return <p className="mt-5 text-xs text-rose-600">{t('extensions.unreadable')}</p>

  return (
    <div className="mt-5 space-y-6">
      {error && (
        <p className="rounded-xl bg-rose-500/10 px-3 py-2 text-xs text-rose-700 dark:text-rose-400">{error}</p>
      )}
      {CATEGORY_ORDER.map(category => {
        const rows = data.extensions.filter(row => row.category === category)
        if (!rows.length) return null
        return (
          <section key={category} className="space-y-3">
            <h3 className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
              {categoryLabel[category]}
            </h3>
            {rows.map(feature => {
              const isGuard = feature.id === PAID_BALANCE_GUARD_ID
              const confirming = confirmFor === feature.id
              return (
                <div key={feature.id} className="rounded-2xl border bg-background p-4">
                  <div className="flex flex-wrap items-start gap-3">
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <h4 className="text-sm font-medium">{feature.title}</h4>
                        {isGuard && !feature.enabled && (
                          <span className="inline-flex items-center gap-1 rounded-full bg-rose-500/10 px-2 py-0.5 text-[10px] font-medium text-rose-700 dark:text-rose-400">
                            <ShieldAlert className="size-3" />
                            {t('extensions.paidPermitted')}
                          </span>
                        )}
                      </div>
                      <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{feature.summary}</p>
                      <p className="mt-2 text-[11px] text-muted-foreground">
                        <span className="font-medium text-foreground">{t('extensions.settingsLabel')}</span> {feature.settingsLocation}
                      </p>
                      <p className="mt-1 text-[11px] text-muted-foreground">
                        <span className="font-medium text-foreground">{t('extensions.whenOffLabel')}</span> {feature.offBehaviour}
                      </p>
                      <p className="mt-1 text-[11px] text-muted-foreground">
                        <span className="font-medium text-foreground">{t('extensions.takesEffectLabel')}</span> {feature.takesEffect}
                      </p>
                      <p className="mt-1 font-mono text-[10px] leading-relaxed text-muted-foreground/80">
                        {feature.codeLocations.join(' · ')}
                      </p>
                    </div>
                    <Switch
                      checked={feature.enabled}
                      disabled={toggle.isPending}
                      onCheckedChange={next => {
                        setError(null)
                        // Disabling the guard is a spend authorisation, not a
                        // checkbox: it needs the phrase typed, so it cannot be
                        // done by a stray click.
                        if (isGuard && !next) {
                          setConfirmFor(feature.id)
                          setConfirmText('')
                          return
                        }
                        toggle.mutate({ id: feature.id, enabled: next })
                      }}
                    />
                  </div>

                  {confirming && (
                    <div className="mt-3 rounded-xl border border-rose-500/30 bg-rose-500/5 p-3">
                      <p className="flex items-start gap-2 text-[11px] leading-relaxed text-rose-700 dark:text-rose-400">
                        <TriangleAlert className="mt-0.5 size-3.5 shrink-0" />
                        <span>{t('extensions.paidWarning', { phrase: PAID_SPEND_CONFIRMATION })}</span>
                      </p>
                      <div className="mt-2 flex flex-wrap gap-2">
                        <Input
                          value={confirmText}
                          onChange={event => setConfirmText(event.target.value)}
                          placeholder={PAID_SPEND_CONFIRMATION}
                          className="h-8 max-w-xs font-mono text-xs"
                        />
                        <Button
                          size="sm"
                          variant="destructive"
                          disabled={confirmText !== PAID_SPEND_CONFIRMATION || toggle.isPending}
                          onClick={() => toggle.mutate({ id: feature.id, enabled: false, confirmation: confirmText })}
                        >
                          {t('extensions.authorisePaid')}
                        </Button>
                        <Button size="sm" variant="outline" onClick={() => { setConfirmFor(null); setConfirmText('') }}>
                          {t('extensions.cancel')}
                        </Button>
                      </div>
                    </div>
                  )}

                  <div className="mt-3 flex flex-wrap gap-2">
                    {feature.destinations.map(destination => destination.kind === 'internal' ? (
                      <Link
                        key={destination.href}
                        to={destination.href}
                        onClick={onNavigate}
                        className={buttonVariants({ variant: 'outline', size: 'xs' })}
                      >
                        {destination.label}
                        <ArrowUpRight className="size-3" />
                      </Link>
                    ) : (
                      <a
                        key={destination.href}
                        href={destination.href}
                        target="_blank"
                        rel="noreferrer"
                        className={buttonVariants({ variant: 'outline', size: 'xs' })}
                      >
                        {destination.label}
                        <ExternalLink className="size-3" />
                      </a>
                    ))}
                  </div>
                </div>
              )
            })}
          </section>
        )
      })}
    </div>
  )
}

export function ExtensionsDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const { t } = useI18n()
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPopup maxWidth="max-w-2xl">
        <div className="flex flex-wrap items-center gap-2">
          <DialogTitle>{t('extensions.title')}</DialogTitle>
          <span className="rounded-full bg-violet-500/10 px-2 py-0.5 text-[10px] font-medium text-violet-700 dark:text-violet-400">
            provider-routing-controls
          </span>
        </div>
        <p className="mt-1 text-sm text-muted-foreground">
          {t('extensions.intro')}
        </p>
        <ExtensionFeatureList onNavigate={() => onOpenChange(false)} />
        <p className="mt-4 text-[11px] leading-relaxed text-muted-foreground">
          {t('extensions.footer')}
        </p>
      </DialogPopup>
    </Dialog>
  )
}
