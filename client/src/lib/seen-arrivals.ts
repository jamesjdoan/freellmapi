import { useCallback, useEffect } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { apiFetch } from '@/lib/api'
import type { ArrivedModel } from '@/lib/catalogue-changes'

// Which catalogue arrivals the operator has already seen on Keys.
//
// "Seen" is the server's acknowledgement (`catalogue_ack`), the same record
// Premium → Catalog updates writes. It used to live in this browser's
// localStorage, so marking a model seen on the Mac left it "new" on the iPad,
// on the tailnet address, and after site data was cleared (2026-10-22). Now a
// mark made anywhere clears the tag everywhere.

/** Where the browser-only list lived. Read once, sent to the server, removed. */
const LEGACY_STORAGE_KEY = 'imperium.keys.seenArrivals'

/** The arrivals in `arrived` not yet acknowledged on the server. */
export function useUnseenArrivals(arrived: readonly ArrivedModel[] | undefined): ArrivedModel[] {
  return (arrived ?? []).filter(m => !m.acknowledged)
}

/** Mark arrivals seen for every device: one acknowledgement on the server. */
export function useMarkArrivalsSeen(): (models: readonly ArrivedModel[]) => void {
  const queryClient = useQueryClient()
  const acknowledge = useMutation({
    mutationFn: (models: readonly ArrivedModel[]) => apiFetch('/api/models/changes/acknowledge-bulk', {
      method: 'POST',
      body: JSON.stringify({ arrived: models.map(m => ({ platform: m.platform, modelId: m.modelId })) }),
    }),
    // Every view of catalogue changes (the Keys tag, the panel chip, Premium's
    // Catalog updates) reads the same query family, so all of them clear.
    onSettled: () => queryClient.invalidateQueries({ queryKey: ['catalogue-changes'] }),
  })
  const { mutate } = acknowledge
  return useCallback((models: readonly ArrivedModel[]) => {
    if (models.length > 0) mutate(models)
  }, [mutate])
}

/**
 * One-time carry-over of marks made before the server record was used: any
 * arrival this browser had marked seen is acknowledged on the server, then the
 * browser list is removed so it never runs again.
 */
export function useMigrateLegacySeenArrivals(arrived: readonly ArrivedModel[] | undefined): void {
  const markSeen = useMarkArrivalsSeen()
  useEffect(() => {
    if (!arrived || arrived.length === 0) return
    let raw: string | null
    try { raw = localStorage.getItem(LEGACY_STORAGE_KEY) } catch { return }
    if (!raw) return
    let ids: Set<string>
    try {
      const parsed: unknown = JSON.parse(raw)
      ids = new Set(Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === 'string') : [])
    } catch {
      ids = new Set()
    }
    const legacyId = (m: ArrivedModel) => `${m.platform}\u0000${m.modelId}\u0000${m.firstSeenAt}`
    const carried = arrived.filter(m => !m.acknowledged && ids.has(legacyId(m)))
    if (carried.length > 0) markSeen(carried)
    try { localStorage.removeItem(LEGACY_STORAGE_KEY) } catch { /* private mode: nothing to remove */ }
  }, [arrived, markSeen])
}
