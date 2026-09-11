import { useEffect, useState } from 'react'
import { Popover, PopoverTrigger, PopoverContent } from '@/components/ui/popover'
import { Button } from '@/components/ui/button'
import { ConfirmButton } from '@/components/confirm-button'
import { PlatformDot } from '@/components/platform-dot'
import { useI18n } from '@/i18n'

export interface ScopeRoute {
  platform: string
  modelId: string
}

/**
 * Add or remove routes from their provider key's scope.
 *
 * One route needs no choosing, so it stays a plain two-step confirm. Several is
 * a different question: a logical model can span providers whose keys the
 * operator feels differently about — a generous free tier and a 10-cent trial
 * are not one decision — so the routes are listed and each can be left out.
 *
 * Every route starts ticked, because acting on all of them is the common case
 * and this should not become a chore when it is.
 */
export function ScopePicker({ routes, allow, onApply, disabled }: {
  routes: ScopeRoute[]
  /** true adds to the key scope, false removes. */
  allow: boolean
  onApply: (routes: ScopeRoute[]) => void
  disabled?: boolean
}) {
  const { t } = useI18n()
  const [open, setOpen] = useState(false)
  const key = (r: ScopeRoute) => `${r.platform}:${r.modelId}`
  const [picked, setPicked] = useState<Set<string>>(() => new Set(routes.map(key)))

  // The row re-renders as scopes change under it; a stale selection would let
  // the count claim routes that are no longer in this state.
  useEffect(() => { setPicked(new Set(routes.map(key))) }, [routes.map(key).join('|')]) // eslint-disable-line react-hooks/exhaustive-deps

  const label = allow
    ? t('compare.scopeAdd', { count: routes.length })
    : t('compare.scopeRemove', { count: routes.length })
  const className = allow
    ? 'h-5 rounded-full border px-1.5 text-[10px] text-amber-600 dark:text-amber-400'
    : 'h-5 rounded-full border px-1.5 text-[10px] text-muted-foreground opacity-0 transition-opacity focus-within:opacity-100 group-hover/row:opacity-100'

  // Nothing to choose between: the confirm IS the decision.
  if (routes.length === 1) {
    return (
      <ConfirmButton
        onConfirm={() => onApply(routes)}
        confirmLabel={t(allow ? 'compare.scopeAddConfirm' : 'compare.scopeRemoveConfirm')}
        title={t(allow ? 'compare.scopeAddHint' : 'compare.scopeRemoveHint')}
        disabled={disabled}
        className={className}
      >
        {label}
      </ConfirmButton>
    )
  }

  const chosen = routes.filter(r => picked.has(key(r)))
  const toggle = (r: ScopeRoute) => setPicked(prev => {
    const next = new Set(prev)
    if (next.has(key(r))) next.delete(key(r))
    else next.add(key(r))
    return next
  })

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        onClick={e => { e.preventDefault(); e.stopPropagation() }}
        title={t(allow ? 'compare.scopeAddHint' : 'compare.scopeRemoveHint')}
        className={className}
      >
        {label}
      </PopoverTrigger>
      <PopoverContent align="start" className="w-72 space-y-2 p-3" onClick={e => e.stopPropagation()}>
        <p className="text-xs font-medium">{t(allow ? 'compare.scopePickAdd' : 'compare.scopePickRemove')}</p>
        <ul className="space-y-1">
          {routes.map(r => (
            <li key={key(r)}>
              <label className="flex items-center gap-2 text-[11px]">
                <input
                  type="checkbox"
                  checked={picked.has(key(r))}
                  onChange={() => toggle(r)}
                  className="size-3.5 accent-foreground"
                />
                <PlatformDot platform={r.platform} />
                <span className="truncate" title={`${r.platform}/${r.modelId}`}>{r.platform}</span>
                <code className="truncate text-muted-foreground">{r.modelId}</code>
              </label>
            </li>
          ))}
        </ul>
        <div className="flex items-center justify-between gap-2 pt-1">
          <Button variant="ghost" size="xs" onClick={() => setOpen(false)}>{t('common.cancel')}</Button>
          <Button
            size="xs"
            disabled={disabled || chosen.length === 0}
            onClick={() => { onApply(chosen); setOpen(false) }}
          >
            {t(allow ? 'compare.scopeAddConfirm' : 'compare.scopeRemoveConfirm')} ({chosen.length})
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  )
}
