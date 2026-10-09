import { useQuery } from '@tanstack/react-query'
import { apiFetch } from '@/lib/api'

// Shared by the chain page's full panel and the per-provider chip on the Keys
// page. ONE query serves both: the widest window either surface needs is
// fetched once and each narrows it locally. Two queries here would mean two
// requests and two cutoffs that could disagree on screen.

export interface ArrivedModel {
  platform: string
  modelId: string
  displayName: string
  firstSeenAt: string
  routed: boolean
  chains: string[]
  /** The operator has read this one. Server-side and permanent, so two
   *  machines agree; see docs/adr/ARCH-20260930-catalogue-panel-unread-worklist.md. */
  acknowledged: boolean
  supportsTools: boolean
  supportsVision: boolean
  contextWindow: number | null
}

export interface DepartedModel {
  platform: string
  modelId: string
  retiredAt: string
  reason: string | null
  lostFrom: { chain: string; priority: number }[]
  acknowledgedAt: string | null
  /** Same field the arrivals carry, so one rule covers both lists. Set from
   *  the tombstone's `acknowledged_at`, which a relist deletes along with the
   *  tombstone — so a second retirement reads as new again. */
  acknowledged: boolean
}

export interface CatalogueChanges {
  since: string
  arrived: ArrivedModel[]
  departed: DepartedModel[]
  untrackedArrivals: number
}
/** How many recent changes the panel shows when nothing is unread. */
export const RECENT_HEAD = 10;

/** One row in the panel's recent head, whichever list it came from. */
export type RecentChange =
  | { kind: 'arrived'; at: string; model: ArrivedModel }
  | { kind: 'departed'; at: string; model: DepartedModel };

export interface UnreadSelection {
  arrived: ArrivedModel[];
  departed: DepartedModel[];
  /** False when there is nothing new, which is the panel's collapsed state. */
  hasUnread: boolean;
  /** Newest-first across BOTH kinds, for the quiet-panel head. `null` when
   *  there is unread, because the head is only what you see once everything is
   *  read. */
  recent: RecentChange[] | null;
}

const stamp = (iso: string) => iso.replace(' ', 'T');

/**
 * What the catalogue panel shows, given everything in the window.
 *
 * Pure, and deliberately in this module rather than the component: the server
 * returns every row unfiltered (the Keys page's churn chips read the same
 * payload and must keep counting acknowledged ones), so the read/unread
 * decision happens here, once, where it can be tested.
 *
 * With something unread it is a worklist — only unread rows, in both lists.
 * With nothing unread it is a quiet panel: collapsed, and on expansion the
 * {@link RECENT_HEAD} newest changes of either kind as one list, because
 * "nothing new" should still answer "what changed lately" rather than showing
 * nothing at all.
 */
export function unreadSelection(
  data: Pick<CatalogueChanges, 'arrived' | 'departed'>,
): UnreadSelection {
  const arrived = data.arrived.filter(a => !a.acknowledged);
  const departed = data.departed.filter(d => !d.acknowledged);
  const hasUnread = arrived.length > 0 || departed.length > 0;
  if (hasUnread) return { arrived, departed, hasUnread, recent: null };
  const recent: RecentChange[] = [
    ...data.arrived.map(m => ({ kind: 'arrived' as const, at: m.firstSeenAt, model: m })),
    ...data.departed.map(m => ({ kind: 'departed' as const, at: m.retiredAt, model: m })),
  ]
    .sort((a, b) => (stamp(b.at) < stamp(a.at) ? -1 : stamp(b.at) > stamp(a.at) ? 1 : 0))
    .slice(0, RECENT_HEAD);
  return { arrived, departed, hasUnread, recent };
}

/** The panel's window. The chip's is narrower and applied client-side. */
export const CHANGES_WINDOW_DAYS = 30

/** How recently a model must have arrived or left to show on a provider row. */
export const PROVIDER_CHURN_DAYS = 14

export function useCatalogueChanges() {
  return useQuery<CatalogueChanges>({
    queryKey: ['catalogue-changes', CHANGES_WINDOW_DAYS],
    queryFn: () => apiFetch(`/api/models/changes?sinceDays=${CHANGES_WINDOW_DAYS}`),
  })
}

/** Stored as `YYYY-MM-DD HH:MM:SS` UTC; the date alone is what a reader needs. */
export function shortDate(value: string): string {
  return value.slice(0, 10)
}

export interface ProviderChurn {
  arrived: ArrivedModel[]
  departed: DepartedModel[]
}

/**
 * Per-platform arrivals and departures inside `days`.
 *
 * Departures are windowed here even though the panel keeps every
 * unacknowledged one forever. The two surfaces answer different questions: the
 * panel is a worklist ("what still needs dealing with"), while a provider row
 * is asking "what has this provider done lately" — and a retirement from four
 * months ago is not news about the provider, acknowledged or not.
 */
export function churnByPlatform(
  data: CatalogueChanges | undefined,
  days = PROVIDER_CHURN_DAYS,
): Map<string, ProviderChurn> {
  const out = new Map<string, ProviderChurn>()
  if (!data) return out
  const cutoff = new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10)
  const bucket = (platform: string): ProviderChurn => {
    let b = out.get(platform)
    if (!b) { b = { arrived: [], departed: [] }; out.set(platform, b) }
    return b
  }
  // A secondary display payload must not take the Keys page down with it: the
  // churn chip is decoration on a row that has other things to show, so a body
  // missing either list renders no chip instead of throwing during render.
  for (const m of data.arrived ?? []) {
    if (shortDate(m.firstSeenAt) >= cutoff) bucket(m.platform).arrived.push(m)
  }
  for (const m of data.departed ?? []) {
    if (shortDate(m.retiredAt) >= cutoff) bucket(m.platform).departed.push(m)
  }
  return out
}
