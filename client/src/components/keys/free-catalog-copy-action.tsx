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

// One trigger, two choices, on the Keys page toolbar rather than inside a
// provider's dialog: what it copies spans every provider, so scoping it to one
// key's screen would misrepresent it. "Copy provider details" in the
// model-scope dialog remains the single-provider action.
export function FreeCatalogCopyAction({
  buildText,
  disabled = false,
}: {
  /**
   * Formats on demand, inside the click, so a 100+ model export costs nothing
   * until it is asked for — and `copyText` still runs in the user gesture it
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
        aria-label="Copy free catalogue models"
      >
        {status === 'copied' ? <Check className="size-3.5" /> : status === 'failed' ? <TriangleAlert className="size-3.5" /> : <Copy className="size-3.5" />}
        {status === 'copied' ? 'Copied' : status === 'failed' ? 'Copy failed' : 'Copy free catalogue'}
        <ChevronDown className="size-3.5" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-64">
        {/* Base UI requires a Menu.Group parent for a group label; without it
            MenuGroupContext is missing and the whole page crashes on open. */}
        <DropdownMenuGroup>
          <DropdownMenuLabel>Whole catalogue, every provider</DropdownMenuLabel>
          <DropdownMenuItem onClick={() => copy('all')}>All providers and models</DropdownMenuItem>
          <DropdownMenuItem onClick={() => copy('active')}>Active providers and models</DropdownMenuItem>
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
