import { useQuery } from '@tanstack/react-query'
import { apiFetch } from '@/lib/api'

export interface ProviderRemoval {
  platform: string
  reason: string | null
  note: string | null
  removedAt: string
  removedBy: 'provider' | 'key'
  modelsRemoved: number
  keyIds: number[]
  restoredAt: string | null
  restoredBy: string | null
}

/** Active removals: platforms to keep off the Keys list. */
export function useProviderRemovals() {
  return useQuery<{ removals: ProviderRemoval[] }>({
    queryKey: ['provider-removals'],
    queryFn: () => apiFetch('/api/keys/provider-removals'),
  })
}

export function useRemovedPlatforms(): Set<string> {
  const { data } = useProviderRemovals()
  return new Set((data?.removals ?? []).filter(r => !r.restoredAt).map(r => r.platform))
}

