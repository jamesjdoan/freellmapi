import { useState } from 'react'
import { Check, ChevronDown, Copy, TriangleAlert } from 'lucide-react'
import { buttonVariants } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { copyText } from '@/lib/clipboard'
import type { FreeCatalogScope } from '@/lib/provider-model-details-export'

// The single-provider twin of the Keys page's Copy List: same trigger, same two
// scopes, narrowed to the provider whose key row opened this dialog. Sharing
// the wording is the point — "all" and "enabled" have to mean the same thing on
// both surfaces or the two exports invite the wrong comparison.
export function ProviderModelDetailsCopyAction({
  buildText,
  disabled = false,
}: {
  /**
   * Formats on demand, inside the click, so unsaved limit edits in the dialog
   * are picked up at copy time and `copyText` still runs in the user gesture it
   * needs to survive an insecure origin (see lib/clipboard).
   */
  buildText: (scope: FreeCatalogScope) => string
  disabled?: boolean
}) {
  const [status, setStatus] = useState<'idle' | 'copied' | 'failed'>('idle')

  const copy = async (scope: FreeCatalogScope) => {
    const copied = await copyText(buildText(scope))
    setStatus(copied ? 'copied' : 'failed')
    window.setTimeout(() => setStatus('idle'), 1800)
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        className={buttonVariants({ variant: 'outline', size: 'sm' })}
        disabled={disabled}
        // WCAG 2.5.3: the accessible name has to contain the visible text.
        aria-label="Copy list of this provider's free models"
      >
        {status === 'copied' ? <Check className="size-3.5" /> : status === 'failed' ? <TriangleAlert className="size-3.5" /> : <Copy className="size-3.5" />}
        {status === 'copied' ? 'Copied' : status === 'failed' ? 'Copy failed' : 'Copy List'}
        <ChevronDown className="size-3.5" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-60">
        {/* Base UI requires a Menu.Group parent for a group label; without it
            MenuGroupContext is missing and the dialog crashes on open. */}
        <DropdownMenuGroup>
          <DropdownMenuLabel>Free models, this provider</DropdownMenuLabel>
          <DropdownMenuItem onClick={() => copy('all')}>All free models offered</DropdownMenuItem>
          <DropdownMenuItem onClick={() => copy('selected')}>Enabled free models only</DropdownMenuItem>
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
