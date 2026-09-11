import { Link } from 'react-router-dom'
import { platformColors } from '@/lib/routing'
import { useI18n } from '@/i18n'
import { Tooltip } from '@/components/tooltip'

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
export interface PlatformScope {
  /** Models on this provider the key names, so the router may call them. */
  inScope: string[]
  /** Models on this provider the key does NOT name — present, unreachable. */
  outOfScope: string[]
  /** Models this provider serves while we hold no key at all. */
  noKey: string[]
}

/** At most this many ids per section: a swatch tooltip is a summary, and a
 *  hundred-line list is unreadable at any size. */
const TOOLTIP_IDS = 8

// The tooltip surface is inverted (bg-foreground / text-background), so these
// are picked to read on a dark panel in light mode and a light one in dark:
//   green      routable now
//   dimmed     present and switched off — deliberately recessive, since the
//              point is that it is NOT in play. True black would be invisible
//              against this surface, so it is a dim neutral instead.
//   light blue served here, no key at all
const SECTION_CLASS = {
  in: 'text-emerald-400',
  off: 'text-background/50',
  none: 'text-sky-300',
} as const

function Section({ tone, label, ids, t }: {
  tone: keyof typeof SECTION_CLASS
  label: string
  ids: string[]
  t: (k: string, v?: Record<string, string | number>) => string
}) {
  if (ids.length === 0) return null
  const rest = ids.length > TOOLTIP_IDS ? ' ' + t('models.andMore', { count: ids.length - TOOLTIP_IDS }) : ''
  return (
    <span className={`block ${SECTION_CLASS[tone]}`}>
      {t(label, { count: ids.length })}: {ids.slice(0, TOOLTIP_IDS).join(', ')}{rest}
    </span>
  )
}

export function PlatformDot({ platform, hasKey, linkToKeys, scope, keyState }: {
  platform: string
  /** Omit when reachability is unknown or irrelevant: the dot renders solid. */
  hasKey?: boolean
  /** Turn an unreachable dot into a link to the right screen for fixing it. */
  linkToKeys?: boolean
  /** What this provider serves and how much of it the key permits. Hovering a
   *  dot is the only place that question gets asked, so it is answered here in
   *  full rather than by sending the reader to the Keys page to compare lists. */
  scope?: PlatformScope
  /** 'disabled' means a key EXISTS and is switched off or unhealthy. That is a
   *  decision, not an oversight, so the dot offers to enable rather than to add
   *  a second key the operator already has. */
  keyState?: 'none' | 'disabled' | 'unscoped' | 'in' | 'out'
}) {
  const { t } = useI18n()
  const colour = platformColor(platform)
  const missing = hasKey === false
  const disabled = keyState === 'disabled'
  const headline = !missing
    ? t('models.platformHasKey', { platform })
    : disabled
      ? t('models.platformKeyDisabled', { platform })
      : t('models.platformNoKey', { platform })
  const headTone: keyof typeof SECTION_CLASS = !missing ? 'in' : disabled ? 'off' : 'none'

  const detail = (
    <span className="block space-y-1">
      <span className={`block font-medium ${SECTION_CLASS[headTone]}`}>{headline}</span>
      {scope && <Section tone="in" label="models.scopeInList" ids={scope.inScope} t={t} />}
      {scope && <Section tone="off" label="models.scopeOutList" ids={scope.outOfScope} t={t} />}
      {scope && <Section tone="none" label="models.scopeNoKeyList" ids={scope.noKey} t={t} />}
    </span>
  )
  // Kept as a plain string too: the accessible name cannot carry colour, and a
  // screen reader still needs the same facts.
  const title = headline

  // Shape carries the state, not just fill, so the three cases stay apart for a
  // reader who cannot separate the colours — and colour keeps meaning provider
  // rather than being overloaded with status:
  //   filled circle   usable key
  //   hollow circle   key exists, switched off
  //   hollow square   no key at all
  const dot = (
    <Tooltip text={detail} wide>
      <span
        aria-label={title}
        className={`size-2 flex-shrink-0 border ${keyState === 'none' ? 'rounded-[1px]' : 'rounded-full'}`}
        style={{
          backgroundColor: missing ? 'transparent' : colour,
          borderColor: colour,
        }}
      />
    </Tooltip>
  )

  if (!missing || !linkToKeys) return dot
  // A disabled key goes to the Keys page for that provider; only a genuinely
  // absent one opens the add dialog.
  const href = disabled
    ? `/keys?platform=${encodeURIComponent(platform)}`
    : `/keys?add=${encodeURIComponent(platform)}`
  return (
    <Link to={href} onClick={e => e.stopPropagation()} className="inline-flex">
      {dot}
    </Link>
  )
}

/**
 * Which colour is which provider, for the dots above. Rendered from the rows on
 * screen rather than the whole catalogue: a legend naming providers that are
 * not in the table teaches nothing.
 */
export function PlatformLegend({ platforms, keyed, scopes, keyStates }: {
  platforms: string[]
  /** Platforms we hold a usable key for; the rest render hollow, as the dots do. */
  keyed?: ReadonlySet<string>
  /** Same per-provider detail the row dots carry, so the legend is hoverable too. */
  scopes?: ReadonlyMap<string, PlatformScope>
  keyStates?: ReadonlyMap<string, 'none' | 'disabled' | 'unscoped' | 'in' | 'out'>
}) {
  const { t } = useI18n()
  if (platforms.length === 0) return null
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[10px] text-muted-foreground">
      <span>{t('models.legendTitle')}</span>
      {platforms.map(p => (
        <span key={p} className="inline-flex items-center gap-1">
          <PlatformDot platform={p} hasKey={keyed ? keyed.has(p) : undefined} scope={scopes?.get(p)} keyState={keyStates?.get(p)} />
          <span>{p}</span>
        </span>
      ))}
      {keyed && (
        <span className="inline-flex items-center gap-2 italic">
          <span className="inline-flex items-center gap-1">
            <span className="size-2 rounded-full border border-foreground bg-foreground" />
            {t('models.legendKeyed')}
          </span>
          <span className="inline-flex items-center gap-1">
            <span className="size-2 rounded-full border border-foreground" />
            {t('models.legendDisabled')}
          </span>
          <span className="inline-flex items-center gap-1">
            <span className="size-2 rounded-[1px] border border-foreground" />
            {t('models.legendNoKey')}
          </span>
        </span>
      )}
    </div>
  )
}
