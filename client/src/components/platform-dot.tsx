import { platformColors } from '@/lib/routing'

// Platform swatch. Same colour source as the token-usage legend
// (lib/routing.ts), same gray fallback for a platform with no assigned colour.
//
// Lifted out of AnalyticsPage when the catalogue log needed it too: two copies
// would drift, and a provider showing as one colour in the failover ladder and
// another in the log is worse than no colour at all.
export function PlatformDot({ platform }: { platform: string }) {
  return (
    <span
      className="size-2 rounded-full flex-shrink-0"
      style={{ backgroundColor: platformColors[platform] ?? '#94a3b8' }}
    />
  )
}
