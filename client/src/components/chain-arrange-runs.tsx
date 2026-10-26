import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { ChevronDown, ChevronRight } from 'lucide-react'
import { useI18n } from '@/i18n'
import { apiFetch } from '@/lib/api'
import { formatStamp } from '@/lib/stamp'
import { Dialog, DialogPopup, DialogTitle, DialogDescription } from '@/components/ui/dialog'
import { ArrangePreviewTable } from '@/components/chain-arrange-preview'
import { chainArrangePaths, type RunDetail, type RunSummary } from '@/lib/chain-arrange'

// Run history (ARCH-20261026): every written arrangement, newest first, with
// the before -> after of the selected one. This is the "a bad run can be read
// and reverted" half of the control story — the table is what actually
// reverts it, by pinning a route back to where it was.

export function RunHistoryDialog({ chain, open, onClose }: {
  chain: string
  open: boolean
  onClose: () => void
}) {
  const { t } = useI18n()
  const [selectedId, setSelectedId] = useState<number | null>(null)

  const { data, isPending } = useQuery<{ runs: RunSummary[] }>({
    queryKey: ['chain-arrange', 'runs', chain],
    queryFn: () => apiFetch(chainArrangePaths.runs(chain)),
    enabled: open,
  })
  const { data: detail, isPending: detailPending } = useQuery<{ run: RunDetail }>({
    queryKey: ['chain-arrange', 'run', selectedId],
    queryFn: () => apiFetch(chainArrangePaths.runDetail(selectedId as number)),
    enabled: open && selectedId != null,
  })

  const close = () => {
    setSelectedId(null)
    onClose()
  }

  return (
    <Dialog open={open} onOpenChange={next => { if (!next) close() }}>
      <DialogPopup maxWidth="max-w-3xl">
        <DialogTitle>{t('chainArrange.runsTitle', { chain })}</DialogTitle>
        <DialogDescription className="mt-1">{t('chainArrange.runsHint')}</DialogDescription>

        {selectedId == null ? (
          isPending ? (
            <p className="mt-3 text-xs text-muted-foreground">{t('common.loading')}</p>
          ) : (data?.runs ?? []).length === 0 ? (
            <p className="mt-3 text-xs text-muted-foreground">{t('chainArrange.runsEmpty')}</p>
          ) : (
            <ul className="mt-3 divide-y">
              {(data?.runs ?? []).map(run => (
                <li key={run.id}>
                  <button
                    type="button"
                    onClick={() => setSelectedId(run.id)}
                    className="flex w-full items-center gap-3 rounded-lg px-2 py-2 text-left text-xs hover:bg-muted/50"
                  >
                    <span className="tabular-nums">{formatStamp(new Date(run.ranAtMs), { time: true })}</span>
                    <span className="rounded-full bg-muted px-2 py-0.5 text-[10px] text-muted-foreground">
                      {t(run.trigger === 'manual' ? 'chainArrange.triggerManual' : 'chainArrange.triggerSchedule')}
                    </span>
                    <span className="text-muted-foreground tabular-nums">
                      {t('chainArrange.runMoved', { count: run.moved })}
                    </span>
                    <span className="flex-1" />
                    <ChevronRight className="size-3.5 text-muted-foreground" />
                  </button>
                </li>
              ))}
            </ul>
          )
        ) : detailPending || !detail ? (
          <p className="mt-3 text-xs text-muted-foreground">{t('common.loading')}</p>
        ) : (
          <div className="mt-3">
            <button
              type="button"
              onClick={() => setSelectedId(null)}
              className="mb-2 inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
            >
              <ChevronDown className="size-3 -rotate-90" />
              {t('chainArrange.backToList')}
            </button>
            <p className="text-xs text-muted-foreground">
              {t('chainArrange.runDetail', {
                when: formatStamp(new Date(detail.run.ranAtMs), { time: true }),
                revision: detail.run.settingsRevision,
              })}
            </p>
            <div className="mt-2">
              <ArrangePreviewTable entries={detail.run.entries} readOnly />
            </div>
          </div>
        )}
      </DialogPopup>
    </Dialog>
  )
}
