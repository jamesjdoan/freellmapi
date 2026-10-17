import { useState, type FormEvent } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import type { ApiKey } from '../../../../shared/types'
import { apiFetch } from '@/lib/api'
import { useI18n } from '@/i18n'
import { Button } from '@/components/ui/button'
import { Dialog, DialogClose, DialogPopup, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Textarea } from '@/components/ui/textarea'
import { X } from 'lucide-react'
import type { UsageCredentialStatus } from '@/lib/quota-dashboard'

// Connect account usage (Keys → Quota → a supported provider's card). Some
// providers report account usage only to a credential other than the inference
// key; this stores one per key through PUT /api/quota/usage-credentials/:keyId
// and reports the immediate read's outcome inline. Secrets are write-only, so
// every field starts empty no matter what is already saved.

/** How each credential field is asked for, keyed by the server's field name
 *  (GET /api/quota/usage-credentials → supported, in display order). A field
 *  the server adds before this file learns of it still renders, labelled with
 *  its raw name. */
const FIELD_DEFS: Record<string, { labelKey: string; helpKey: string; multiline?: boolean }> = {
  userId: { labelKey: 'keys.usageCredUserId', helpKey: 'keys.usageCredUserIdHelp' },
  accessToken: { labelKey: 'keys.usageCredToken', helpKey: 'keys.usageCredTokenHelp' },
  cookie: { labelKey: 'keys.usageCredCookie', helpKey: 'keys.usageCredCookieHelp', multiline: true },
  serviceAccountJson: { labelKey: 'keys.usageCredServiceAccount', helpKey: 'keys.usageCredServiceAccountHelp', multiline: true },
}

export function UsageCredentialDialog({
  platform,
  providerLabel,
  keys,
  credentials,
  fields,
  onOpenChange,
}: {
  platform: string
  /** The card's provider name, already stripped of its catalogue note. */
  providerLabel: string
  keys: ApiKey[]
  credentials: UsageCredentialStatus[]
  fields: string[]
  onOpenChange: (open: boolean) => void
}) {
  const { t } = useI18n()
  const queryClient = useQueryClient()
  const platformKeys = keys.filter(k => k.platform === platform && k.enabled)
  const connected = credentials.filter(c => c.platform === platform)
  // One credential per key: default the selector to a key that already has
  // one, else the platform's first enabled key.
  const [keyId, setKeyId] = useState<number | null>(
    () => connected.find(c => platformKeys.some(k => k.id === c.keyId))?.keyId ?? platformKeys[0]?.id ?? null,
  )
  const [values, setValues] = useState<Record<string, string>>({})
  const selected = connected.find(c => c.keyId === keyId) ?? null
  const complete = fields.every(name => (values[name] ?? '').trim() !== '')

  // The dashboard refetches its overview and this status list from the
  // shared 'quota' prefix: the save already produced a reading server-side.
  const refresh = () => void queryClient.invalidateQueries({ queryKey: ['quota'] })

  const save = useMutation({
    mutationFn: (body: Record<string, string>) =>
      apiFetch<{ credential: UsageCredentialStatus }>(`/api/quota/usage-credentials/${keyId}`, {
        method: 'PUT',
        body: JSON.stringify({ fields: body }),
      }),
    onSuccess: () => {
      refresh()
    },
  })
  const remove = useMutation({
    mutationFn: () => apiFetch(`/api/quota/usage-credentials/${keyId}`, { method: 'DELETE' }),
    onSuccess: () => {
      refresh()
      onOpenChange(false)
    },
  })

  // Switching keys forgets the half-typed secret and the last save's outcome:
  // they belonged to the other credential.
  const switchKey = (id: string | null) => {
    if (id == null) return
    setKeyId(Number(id))
    setValues({})
    save.reset()
    remove.reset()
  }

  const submit = (event: FormEvent) => {
    event.preventDefault()
    if (keyId == null || !complete) return
    const body: Record<string, string> = {}
    for (const name of fields) body[name] = (values[name] ?? '').trim()
    save.mutate(body)
  }

  const outcome = save.data?.credential
  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogPopup maxWidth="max-w-lg">
        <div className="mb-4 flex items-center justify-between gap-4">
          <DialogTitle>{t('keys.usageCredTitle', { provider: providerLabel })}</DialogTitle>
          <DialogClose
            aria-label={t('common.dismiss')}
            className="-mr-1 rounded-lg p-1 text-muted-foreground/70 transition-colors outline-none hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50"
          >
            <X className="size-4" />
          </DialogClose>
        </div>

        {platformKeys.length > 1 && (
          <div className="mb-4 space-y-1.5">
            <Label className="text-xs">{t('keys.usageCredKey')}</Label>
            <Select value={keyId != null ? String(keyId) : ''} onValueChange={switchKey}>
              <SelectTrigger className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {/* label drives the trigger's SelectValue text (Base UI falls
                    back to the raw value without it — #837). */}
                {platformKeys.map(k => (
                  <SelectItem key={k.id} value={String(k.id)} label={k.label || k.maskedKey}>{k.label || k.maskedKey}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        )}

        <form onSubmit={submit} className="space-y-4">
          {fields.map(name => {
            const def = FIELD_DEFS[name]
            const id = `usage-cred-${name}`
            return (
              <div key={name} className="space-y-1.5">
                <Label className="text-xs" htmlFor={id}>{def ? t(def.labelKey) : name}</Label>
                {def?.multiline ? (
                  <Textarea
                    id={id}
                    autoComplete="off"
                    spellCheck={false}
                    value={values[name] ?? ''}
                    onChange={e => setValues(v => ({ ...v, [name]: e.target.value }))}
                    className="font-mono text-xs"
                  />
                ) : (
                  <Input
                    id={id}
                    type="password"
                    autoComplete="new-password"
                    value={values[name] ?? ''}
                    onChange={e => setValues(v => ({ ...v, [name]: e.target.value }))}
                    className="font-mono text-xs"
                  />
                )}
                {def && <p className="text-[11px] text-muted-foreground">{t(def.helpKey)}</p>}
              </div>
            )
          })}

          {outcome && (outcome.lastStatus === 'error' ? (
            <p role="alert" className="text-xs text-destructive">{outcome.lastMessage ?? t('keys.usageCredSaveFailed')}</p>
          ) : (
            <p className="text-xs text-emerald-700 dark:text-emerald-400">{outcome.lastMessage ?? t('keys.usageCredSaved')}</p>
          ))}
          {save.error && (
            <p role="alert" className="text-xs text-destructive">{save.error instanceof Error ? save.error.message : String(save.error)}</p>
          )}
          {remove.error && (
            <p role="alert" className="text-xs text-destructive">{remove.error instanceof Error ? remove.error.message : String(remove.error)}</p>
          )}

          <div className="flex items-center justify-end gap-2 pt-1">
            <Button type="button" variant="outline" size="sm" onClick={() => onOpenChange(false)}>
              {t('common.cancel')}
            </Button>
            {selected && (
              <Button type="button" variant="destructive" size="sm" onClick={() => remove.mutate()} disabled={remove.isPending}>
                {t('keys.usageCredRemove')}
              </Button>
            )}
            <Button type="submit" size="sm" disabled={!complete || save.isPending}>
              {save.isPending ? t('common.saving') : t('common.save')}
            </Button>
          </div>
        </form>
      </DialogPopup>
    </Dialog>
  )
}
