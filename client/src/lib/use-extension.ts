import { useSyncExternalStore } from 'react'
import { apiFetch } from '@/lib/api'
import type { ImperiumExtension } from '@freellmapi/shared/extension-registry'

type ExtensionRow = ImperiumExtension & { enabled: boolean }

/**
 * Enablement state for gating a surface.
 *
 * Deliberately NOT a react-query hook. Nineteen presentation extensions are
 * gated inside their own components, and those components are mounted all over
 * the dashboard — several of them in tests and in trees that have no
 * QueryClientProvider. Reading through `useQuery` would make a read-only flag
 * impose a provider on every host, which is the wrong dependency for a boolean.
 *
 * So: one module-level store, fetched once on first read, shared by every
 * caller, subscribed through useSyncExternalStore. The Extensions panel itself
 * still uses react-query (it needs revisions and mutations) and calls
 * `refreshExtensionState()` after a write so gated surfaces update with it.
 */
let rows: ExtensionRow[] | null = null
let inFlight: Promise<void> | null = null
const listeners = new Set<() => void>()

function emit(): void {
  for (const listener of listeners) listener()
}

function load(): void {
  if (inFlight) return
  inFlight = apiFetch<{ extensions: ExtensionRow[] }>('/api/extensions')
    .then(payload => {
      rows = Array.isArray(payload?.extensions) ? payload.extensions : null
      emit()
    })
    .catch(() => {
      // Unreadable state is not evidence that anything was switched off.
      rows = null
    })
    .finally(() => { inFlight = null })
}

/** Re-read after a toggle, so a gated surface appears or disappears at once. */
export function refreshExtensionState(): void {
  inFlight = null
  load()
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  load()
  return () => { listeners.delete(listener) }
}

function snapshot(): ExtensionRow[] | null {
  return rows
}

/**
 * Whether one extension's surface should render.
 *
 * Unknown, still loading, or a failed read all return TRUE — the opposite of
 * the server's rule, and on purpose. Here the cost of guessing wrong is a panel
 * that appears and then hides; guessing the other way would blank half the
 * dashboard on a slow request. Nothing here enforces anything: the server
 * checks its own gates, so a visible control is never why a write succeeds.
 */
export function useExtensionEnabled(id: string): boolean {
  const current = useSyncExternalStore(subscribe, snapshot, snapshot)
  if (!current) return true
  const row = current.find(extension => extension.id === id)
  return row ? row.enabled : true
}
