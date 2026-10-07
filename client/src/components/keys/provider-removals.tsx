import { useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Trash2, RotateCcw } from 'lucide-react'
import { apiFetch } from '@/lib/api'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { useI18n } from '@/i18n'
import { formatStamp } from '@/lib/stamp'
import { Dialog, DialogPopup, DialogTitle } from '@/components/ui/dialog'
import { useProviderRemovals } from '@/lib/provider-removals'

// Providers the operator has given up on, and the log of why.
//
// The Keys page has one row per configured provider. Retiring one (a paid
// gateway you cancelled, a relay that stopped answering) left its row, its
// models and its catalogue churn behind, with nowhere to say why. This is that
// place: one entry per provider, the reason recorded once, and a restore that
// puts the provider back on the list. The models are tombstoned by the
// removal itself, so a catalogue refresh cannot re-add them.
//
// Keys owns the dialog; the log below it is the same list, so what was
// removed and when is readable without opening anything.

export function RemoveProviderDialog({ platform, label, onOpenChange, hasKeys = true }: {
  platform: string
  label: string
  onOpenChange: (open: boolean) => void
  /** False for a provider with no key yet (a checklist chip): nothing to delete. */
  hasKeys?: boolean
}) {
  const { t } = useI18n()
  const queryClient = useQueryClient()
  // A reason is required by the server, so the dialog cannot submit without one.
  const [reason, setReason] = useState('')
  const [note, setNote] = useState('')
  const [deleteKeys, setDeleteKeys] = useState(false)

  const remove = useMutation({
    mutationFn: () => apiFetch(`/api/keys/provider-removals/${platform}`, {
      method: 'POST', body: JSON.stringify({ reason: reason.trim(), note: note.trim() || null, deleteKeys }),
    }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['provider-removals'] })
      queryClient.invalidateQueries({ queryKey: ['keys'] })
      queryClient.invalidateQueries({ queryKey: ['keys-providers'] })
      queryClient.invalidateQueries({ queryKey: ['analysis'] })
      queryClient.invalidateQueries({ queryKey: ['models'] })
      queryClient.invalidateQueries({ queryKey: ['fallback'] })
      onOpenChange(false)
    },
  })

  return (
    <Dialog open onOpenChange={o => { if (!remove.isPending) onOpenChange(o) }}>
      <DialogPopup className="max-w-md">
        <DialogTitle>{t('keys.removeProviderTitle', { provider: label })}</DialogTitle>
        <label className="mt-3 block text-xs">
          {t('keys.removeProviderReason')}
          <Input
            autoFocus value={reason} maxLength={200} placeholder={t('keys.removeProviderReasonPlaceholder')}
            onChange={e => setReason(e.target.value)} className="mt-1 h-8 text-xs" disabled={remove.isPending}
          />
        </label>
        <label className="mt-3 block text-xs">
          {t('keys.removeProviderNote')}
          <Input
            value={note} maxLength={500} placeholder={t('keys.removeProviderNotePlaceholder')}
            onChange={e => setNote(e.target.value)} className="mt-1 h-8 text-xs" disabled={remove.isPending}
          />
        </label>
        {hasKeys && (
          <label className="mt-3 flex items-start gap-2 text-xs text-muted-foreground">
            <input
              type="checkbox" checked={deleteKeys} disabled={remove.isPending} className="mt-0.5 size-3.5 accent-primary"
              onChange={e => setDeleteKeys(e.target.checked)}
            />
            <span>{t('keys.removeProviderDeleteKeys')}</span>
          </label>
        )}
        <p className="mt-2 text-[11px] text-muted-foreground">{t('keys.removeProviderEffect')}</p>
        {remove.isError && <p className="mt-2 text-[11px] text-destructive">{(remove.error as Error).message}</p>}
        <div className="mt-4 flex justify-end gap-2">
          <Button variant="outline" size="sm" onClick={() => onOpenChange(false)} disabled={remove.isPending}>
            {t('common.cancel')}
          </Button>
          <Button
            size="sm" variant="destructive" disabled={!reason.trim() || remove.isPending}
            onClick={() => remove.mutate()}
          >
            <Trash2 className="size-3.5" />
            {remove.isPending ? t('common.saving') : t('keys.removeProviderConfirm')}
          </Button>
        </div>
      </DialogPopup>
    </Dialog>
  )
}

export function ProviderRemovalsLog() {
  const { t } = useI18n()
  const queryClient = useQueryClient()
  const { data } = useProviderRemovals()
  const removals = data?.removals ?? []

  const restore = useMutation({
    mutationFn: (platform: string) => apiFetch(`/api/keys/provider-removals/${platform}/restore`, { method: 'POST' }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['provider-removals'] })
      queryClient.invalidateQueries({ queryKey: ['keys'] })
      queryClient.invalidateQueries({ queryKey: ['keys-providers'] })
    },
  })

  if (removals.length === 0) return null

  return (
    <section className="rounded-xl border p-3">
      <h2 className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
        <Trash2 className="size-3.5" />
        {t('keys.removedProviders', { count: removals.length })}
      </h2>
      <ul className="mt-1.5 space-y-1">
        {removals.map(r => (
          <li key={r.platform} className="flex flex-wrap items-center gap-2 text-xs">
            <span className="font-medium">{r.platform}</span>
            {r.reason && <span className="text-muted-foreground">{r.reason}</span>}
            {r.note && <span className="text-muted-foreground/80">{r.note}</span>}
            {r.modelsRemoved > 0 && (
              <span className="text-muted-foreground">{t('keys.removedModels', { count: r.modelsRemoved })}</span>
            )}
            {r.removedBy === 'key' && (
              <span className="text-muted-foreground">{t('keys.removedByKey')}</span>
            )}
            <span className="ml-auto text-muted-foreground tabular-nums">
              {r.restoredAt ? t('keys.removedRestored', { when: formatStamp(r.restoredAt) }) : formatStamp(r.removedAt, { time: true })}
            </span>
            {!r.restoredAt && (
              <Button
                size="xs" variant="ghost" disabled={restore.isPending}
                onClick={() => restore.mutate(r.platform)}
              >
                <RotateCcw className="size-3" />
                {t('keys.restoreProvider')}
              </Button>
            )}
          </li>
        ))}
      </ul>
    </section>
  )
}
