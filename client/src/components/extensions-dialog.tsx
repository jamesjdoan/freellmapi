import { ArrowUpRight, Check, ExternalLink } from 'lucide-react'
import { Link } from 'react-router-dom'
import { Dialog, DialogPopup, DialogTitle } from '@/components/ui/dialog'
import { buttonVariants } from '@/components/ui/button'
import { IMPERIUM_EXTENSIONS } from '@/lib/extension-registry'

export function ExtensionFeatureList({ onNavigate }: { onNavigate?: () => void }) {
  return (
    <div className="mt-5 space-y-3">
      {IMPERIUM_EXTENSIONS.map(feature => (
        <section key={feature.id} className="rounded-2xl border bg-background p-4">
          <div className="flex flex-wrap items-start gap-2">
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2">
                <h3 className="text-sm font-medium">{feature.title}</h3>
                <span className="inline-flex items-center gap-1 rounded-full bg-emerald-500/10 px-2 py-0.5 text-[10px] font-medium text-emerald-700 dark:text-emerald-400">
                  <Check className="size-3" />
                  Installed
                </span>
              </div>
              <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{feature.summary}</p>
              <p className="mt-2 text-[11px] text-muted-foreground">
                <span className="font-medium text-foreground">Settings:</span> {feature.settingsLocation}
              </p>
            </div>
          </div>
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
        </section>
      ))}
    </div>
  )
}

export function ExtensionsDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPopup maxWidth="max-w-2xl">
        <div className="flex flex-wrap items-center gap-2">
          <DialogTitle>Imperium extensions</DialogTitle>
          <span className="rounded-full bg-violet-500/10 px-2 py-0.5 text-[10px] font-medium text-violet-700 dark:text-violet-400">
            provider-routing-controls
          </span>
        </div>
        <p className="mt-1 text-sm text-muted-foreground">
          Features added by the separate Imperium FreeLLMAPI branch. The links below open the pages that own each real setting.
        </p>
        <ExtensionFeatureList onNavigate={() => onOpenChange(false)} />
        <p className="mt-4 text-[11px] leading-relaxed text-muted-foreground">
          This panel is an index, not a second configuration store. Automatic routing remains the default until a preference is explicitly selected.
        </p>
      </DialogPopup>
    </Dialog>
  )
}
