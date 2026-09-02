import { useState } from 'react'
import { Check, Copy, TriangleAlert } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { copyText } from '@/lib/clipboard'

export function ProviderModelDetailsCopyAction({
  text,
  disabled = false,
}: {
  text: string
  disabled?: boolean
}) {
  const [status, setStatus] = useState<'idle' | 'copied' | 'failed'>('idle')

  const copy = async () => {
    const copied = await copyText(text)
    setStatus(copied ? 'copied' : 'failed')
    window.setTimeout(() => setStatus('idle'), 1800)
  }

  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      onClick={copy}
      disabled={disabled}
      aria-label="Copy provider model details"
    >
      {status === 'copied' ? <Check className="size-3.5" /> : status === 'failed' ? <TriangleAlert className="size-3.5" /> : <Copy className="size-3.5" />}
      {status === 'copied' ? 'Copied' : status === 'failed' ? 'Copy failed' : 'Copy provider details'}
    </Button>
  )
}
