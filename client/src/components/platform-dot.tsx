import { Link } from 'react-router-dom'
import { platformColors } from '@/lib/routing'
import { useI18n } from '@/i18n'

// Platform swatch. Same colour source as the token-usage legend
// (lib/routing.ts), same gray fallback for a platform with no assigned colour.
//
// Lifted out of AnalyticsPage when the catalogue log needed it too: two copies
// would drift, and a provider showing as one colour in the failover ladder and
// another in the log is worse than no colour at all.

export function platformColor(platform: string): string {
  return platformColors[platform] ?? '#94a3b8'
}

/**
 * A provider swatch, optionally saying whether we can actually call it.
 *
 * `hasKey` false renders the dot hollow — the colour still identifies the
 * provider, so it stays legible against the legend, but the row reads at a
 * glance as "this model is served here and we cannot reach it". Those dots link
 * to the Keys page with the provider preselected, because the next useful
 * action after noticing a missing key is adding one.
 */
export function PlatformDot({ platform, hasKey, linkToKeys }: {
  platform: string
  /** Omit when reachability is unknown or irrelevant: the dot renders solid. */
  hasKey?: boolean
  /** Turn an unkeyed dot into a link to add that provider's key. */
  linkToKeys?: boolean
}) {
  const { t } = useI18n()
  const colour = platformColor(platform)
  const missing = hasKey === false
  const title = missing
    ? t('models.platformNoKey', { platform })
    : t('models.platformHasKey', { platform })

  const dot = (
    <span
      title={title}
      aria-label={title}
      className="size-2 rounded-full flex-shrink-0 border"
      style={{
        backgroundColor: missing ? 'transparent' : colour,
        borderColor: colour,
      }}
    />
  )

  if (!missing || !linkToKeys) return dot
  return (
    <Link to={`/keys?add=${encodeURIComponent(platform)}`} onClick={e => e.stopPropagation()} className="inline-flex">
      {dot}
    </Link>
  )
}

/**
 * Which colour is which provider, for the dots above. Rendered from the rows on
 * screen rather than the whole catalogue: a legend naming providers that are
 * not in the table teaches nothing.
 */
export function PlatformLegend({ platforms, keyed }: {
  platforms: string[]
  /** Platforms we hold a usable key for; the rest render hollow, as the dots do. */
  keyed?: ReadonlySet<string>
}) {
  const { t } = useI18n()
  if (platforms.length === 0) return null
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[10px] text-muted-foreground">
      <span>{t('models.legendTitle')}</span>
      {platforms.map(p => (
        <span key={p} className="inline-flex items-center gap-1">
          <PlatformDot platform={p} hasKey={keyed ? keyed.has(p) : undefined} />
          <span>{p}</span>
        </span>
      ))}
      {keyed && <span className="italic">{t('models.legendHollow')}</span>}
    </div>
  )
}
