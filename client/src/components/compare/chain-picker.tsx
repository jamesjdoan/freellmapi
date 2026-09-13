import { useEffect, useState } from 'react'
import { Popover, PopoverTrigger, PopoverContent } from '@/components/ui/popover'
import { Button } from '@/components/ui/button'
import { ConfirmButton } from '@/components/confirm-button'
import { useI18n } from '@/i18n'

/**
 * A chain position, editable inside its chip.
 *
 * Commits on blur or Enter, never on keystroke: committing per keystroke reads
 * "12" as 1 first, reorders the chain, then reorders it again — landing
 * somewhere nobody asked for. Clicks are stopped so editing a number does not
 * also open the membership popover behind it.
 */
export function RankInput({ chain, rank, onSet, disabled }: {
  chain: string
  rank: number
  onSet: (position: number) => void
  disabled?: boolean
}) {
  const [draft, setDraft] = useState(String(rank))
  // The row re-renders as other models move around it; a stale draft would
  // write back the position this model held two edits ago.
  useEffect(() => { setDraft(String(rank)) }, [rank])

  const commit = () => {
    const next = Number(draft)
    if (!Number.isFinite(next) || next < 1 || next === rank) { setDraft(String(rank)); return }
    onSet(Math.floor(next))
  }

  return (
    <input
      value={draft}
      disabled={disabled}
      inputMode="numeric"
      aria-label={`${chain} position`}
      onClick={e => e.stopPropagation()}
      onChange={e => setDraft(e.target.value.replace(/[^0-9]/g, ''))}
      onBlur={commit}
      onKeyDown={e => {
        e.stopPropagation()
        if (e.key === 'Enter') e.currentTarget.blur()
        if (e.key === 'Escape') { setDraft(String(rank)); e.currentTarget.blur() }
      }}
      className="w-5 rounded bg-emerald-500/20 px-0.5 text-center tabular-nums text-emerald-800 disabled:opacity-50 dark:text-emerald-200"
    />
  )
}

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
export function ChainPicker({ chains, member, ranks, onApply, onRank, disabled }: {
  /** Every chain that exists, in display order. */
  chains: string[]
  /** Chains this model currently serves. */
  member: string[]
  /** Position within each served chain, and the member row holding that slot.
   *  Rendered inside the chip rather than beside it: "Apex" and "Apex #2" are
   *  the same fact at different resolutions, and listing them separately
   *  repeated every chain name twice. */
  ranks?: Record<string, { rank: number; modelDbId: number }>
  onApply: (changes: { chain: string; member: boolean }[]) => void
  onRank?: (chain: string, modelDbId: number, position: number) => void
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
      {/* The chips are the trigger AND the rank editor, so the popover is
          anchored to a zero-size span instead: an <input> cannot live inside a
          <button>, and a chain's name and its position belong on one chip. */}
      <PopoverTrigger
        aria-hidden="true"
        tabIndex={-1}
        disabled={disabled}
        className="block h-0 w-0 overflow-hidden p-0"
      />
      <div className="flex max-w-[150px] flex-wrap gap-1 text-left">
        {member.length > 0
          ? member.map(c => (
            // Highlighted: a model that is actually routing somewhere is the
            // thing a reader scans this column for.
            <span
              key={c}
              className="inline-flex items-center gap-1 rounded-full bg-emerald-500/15 py-0.5 pl-1.5 pr-1 text-[10px] text-emerald-700 dark:text-emerald-300"
            >
              <button
                type="button"
                title={t('compare.chainEdit')}
                disabled={disabled}
                onClick={e => { e.stopPropagation(); setOpen(true) }}
                className="hover:underline"
              >
                {c}
              </button>
              {ranks?.[c] && onRank && (
                <RankInput
                  chain={c}
                  rank={ranks[c].rank}
                  disabled={disabled}
                  onSet={next => onRank(c, ranks[c].modelDbId, next)}
                />
              )}
            </span>
          ))
          : (
            <button
              type="button"
              disabled={disabled}
              onClick={e => { e.stopPropagation(); setOpen(true) }}
              className="text-[10px] text-muted-foreground underline decoration-dotted"
            >
              {t('compare.chainNone')}
            </button>
          )}
      </div>
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
