import { useSyncExternalStore } from 'react'
import type { ArrivedModel } from '@/lib/catalogue-changes'

// Which catalogue arrivals the operator has already looked at on Keys.
//
// "New" is the provider chip's own window (PROVIDER_CHURN_DAYS) minus what has
// been marked seen, so the tag and the +N count can never disagree about what
// arrived. Seen is view state, so it lives in localStorage like the page's
// other view preferences: marking a model seen changes nothing about routing.
// The id carries the arrival stamp, so a model that leaves and comes back is
// news again rather than silently remembered.

const STORAGE_KEY = 'imperium.keys.seenArrivals'
const CHANGE_EVENT = 'imperium:seen-arrivals'

export function arrivalId(m: Pick<ArrivedModel, 'platform' | 'modelId' | 'firstSeenAt'>): string {
  return `${m.platform}\u0000${m.modelId}\u0000${m.firstSeenAt}`
}

function read(): string {
  try { return localStorage.getItem(STORAGE_KEY) ?? '[]' } catch { return '[]' }
}

// Cached by raw string so useSyncExternalStore sees a stable snapshot between
// writes instead of a fresh Set on every render.
let cachedRaw = ''
let cachedSet = new Set<string>()
function snapshot(): Set<string> {
  const raw = read()
  if (raw !== cachedRaw) {
    cachedRaw = raw
    try {
      const parsed: unknown = JSON.parse(raw)
      cachedSet = new Set(Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === 'string') : [])
    } catch {
      cachedSet = new Set()
    }
  }
  return cachedSet
}

function subscribe(onChange: () => void): () => void {
  // `storage` covers other tabs; the custom event covers this one, where
  // `storage` never fires.
  window.addEventListener('storage', onChange)
  window.addEventListener(CHANGE_EVENT, onChange)
  return () => {
    window.removeEventListener('storage', onChange)
    window.removeEventListener(CHANGE_EVENT, onChange)
  }
}

export function markArrivalsSeen(models: readonly ArrivedModel[]): void {
  if (models.length === 0) return
  const next = new Set(snapshot())
  for (const m of models) next.add(arrivalId(m))
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify([...next])) } catch { /* private mode: stays unseen */ }
  window.dispatchEvent(new Event(CHANGE_EVENT))
}

/** The arrivals in `arrived` not yet marked seen, live across components and tabs. */
export function useUnseenArrivals(arrived: readonly ArrivedModel[] | undefined): ArrivedModel[] {
  const seen = useSyncExternalStore(subscribe, snapshot, snapshot)
  return (arrived ?? []).filter(m => !seen.has(arrivalId(m)))
}
