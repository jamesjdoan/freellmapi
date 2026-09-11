import { useEffect, useState } from 'react'
import { Popover, PopoverTrigger, PopoverContent } from '@/components/ui/popover'
import { Button } from '@/components/ui/button'
import { ConfirmButton } from '@/components/confirm-button'
import { useI18n } from '@/i18n'

/**
 * Which chains a model serves, and the control to change that.
 *
 * Membership is the decision Compare exists to inform: you rank the catalogue
 * on measured capability and the next thing you want is to put the winner in a
 * chain. Doing that used to mean leaving for the Models page, finding the model
 * again, and remembering what the scores said.
 *
 * Confirm-gated, because this edits live routing — the chain named here decides
 * what answers real requests. Nothing is written until Apply is pressed twice.
 */
export function ChainPicker({ chains, member, onApply, disabled }: {
  /** Every chain that exists, in display order. */
  chains: string[]
  /** Chains this model currently serves. */
  member: string[]
  onApply: (changes: { chain: string; member: boolean }[]) => void
  disabled?: boolean
}) {
  const { t } = useI18n()
  const [open, setOpen] = useState(false)
  const [picked, setPicked] = useState<Set<string>>(() => new Set(member))

  // The row re-renders as membership changes under it; a stale selection would
  // let Apply write the state the operator saw two edits ago.
  useEffect(() => { setPicked(new Set(member)) }, [member.join('|')]) // eslint-disable-line react-hooks/exhaustive-deps

  const changes = chains
    .filter(c => picked.has(c) !== member.includes(c))
    .map(c => ({ chain: c, member: picked.has(c) }))

  return (
    <Popover open={open} onOpenChange={next => { setOpen(next); if (!next) setPicked(new Set(member)) }}>
      <PopoverTrigger
        onClick={e => e.stopPropagation()}
        title={t('compare.chainEdit')}
        className="flex max-w-[120px] flex-wrap gap-1 text-left"
        disabled={disabled}
      >
        {member.length > 0
          ? member.map(c => (
            // Highlighted: a model that is actually routing somewhere is the
            // thing a reader scans this column for.
            <span key={c} className="rounded-full bg-emerald-500/15 px-1.5 py-0.5 text-[10px] text-emerald-700 dark:text-emerald-300">
              {c}
            </span>
          ))
          : <span className="text-[10px] text-muted-foreground underline decoration-dotted">{t('compare.chainNone')}</span>}
      </PopoverTrigger>
      <PopoverContent align="start" className="w-60 space-y-2 p-3" onClick={e => e.stopPropagation()}>
        <p className="text-xs font-medium">{t('compare.chainPick')}</p>
        <ul className="space-y-1">
          {chains.map(c => (
            <li key={c}>
              <label className="flex items-center gap-2 text-[11px]">
                <input
                  type="checkbox"
                  checked={picked.has(c)}
                  onChange={() => setPicked(prev => {
                    const next = new Set(prev)
                    if (next.has(c)) next.delete(c)
                    else next.add(c)
                    return next
                  })}
                  className="size-3.5 accent-foreground"
                />
                <span>{c}</span>
                {member.includes(c) && <span className="text-[10px] text-muted-foreground">{t('compare.chainServing')}</span>}
              </label>
            </li>
          ))}
        </ul>
        <div className="flex items-center justify-between gap-2 pt-1">
          <Button variant="ghost" size="xs" onClick={() => setOpen(false)}>{t('common.cancel')}</Button>
          {changes.length > 0 && (
            <ConfirmButton
              size="xs"
              variant="default"
              onConfirm={() => { onApply(changes); setOpen(false) }}
              confirmLabel={t('compare.chainConfirm')}
              disabled={disabled}
            >
              {t('compare.chainApply', { count: changes.length })}
            </ConfirmButton>
          )}
        </div>
      </PopoverContent>
    </Popover>
  )
}
