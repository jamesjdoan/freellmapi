# ARCH-20261004-analytics-windows-and-page-filters

## Decision

Give the Analytics page **one window resolver and one page-wide filter bar**, and widen the
window choices past 90 days.

- **One window, resolved server-side.** Every analytics endpoint reads the same half-open
  interval `[since, until)` in SQLite UTC text, produced by one `resolveWindow()` from a `range`
  preset **or** a `from`/`to` date pair. There is no per-endpoint window arithmetic left.
- **Presets: `24h 7d 30d 90d 180d 365d`, plus `custom`.** The timeline picks its bucket from the
  **window's own span** (`hour` ≤3d, `day` ≤150d, else `month`), not from a `range === '24h'` test.
- **Filters sit above the panels.** Status, provider and model are page state. `pageFilters()` is
  the single place any of them becomes SQL, and every endpoint composes it.
- **The hourly aggregate is retained for 365 days**, matching the widest preset, and `/summary`
  reports `rawWindowTruncated` + `rawWindowOldest` so the UI can say when a window reaches past
  the oldest request on record.

## Context

Reported as "the 30 day and 90 day does not rerender the charts". It was not a render bug — the
chart was redrawing, with identical data. Measured on a copy of the live DB before any change:

| window | request_hourly rows | distinct day buckets | sum(total_requests) |
|---|---|---|---|
| 30d | 415 | 31 | 70,330 |
| 90d | 420 | 31 | 71,104 |

**F1 — 30d and 90d drew the same 31 daily buckets.** `/timeline` chose its interval with
`range === '24h' ? 'hour' : 'day'` (`routes/analytics.ts:599`), so every window past a day drew
one point per day. Past 30 days of retention there is nothing else to draw, so the two windows
were byte-identical and read as frozen. This is the direct cause.

**F2 — the aggregate was pruned shallower than the UI offered.**
`HOURLY_RETENTION_DAYS = 30` while the toggle already offered 90d
(`services/request-retention.ts:9`). The 90d view was reading a 30-day window and labelling it
90 days. Retention, not rendering.

**F3 — filters were table-local.** `?status=` and `?provider=` existed only on `/requests`. The
page's own status control lived in the **recent-calls table header**
(`AnalyticsPage.tsx`, the `SegmentedControl` over `statusFilter`), so choosing "errors" moved that
one table and left the stat cards, the timeline, both breakdowns and the error charts describing
all traffic. Two populations on one screen, with nothing on screen saying so.

**F4 — the range rode eight hand-built URLs.** Each query built its own
`?range=${range}${deviceParam}`. Adding a filter dimension meant touching eight call sites, and
the last one to be missed would silently disagree with the rest. That is what F3 looked like
before someone noticed.

## YC Forcing Questions

**Demand reality:** an operator comparing two windows cannot. 30d and 90d return the same
totals and the same chart on an install with 38 days of traffic, so the widest window is
unfalsifiable — and filtering by status is only available on the one panel where it is least
useful. Measured, not inferred (F1, F2 above).

**Narrowest wedge:** make the window honest and the filters global. Not a reporting redesign,
not new metrics, not an export. Everything else on the page stays exactly as it is.

**Future-fit:** yes, with one condition — the retention constant must be derived from, or at
minimum kept in step with, the widest preset. They are the same fact stated twice, and F2 is
what happens when they drift.

## Consequences

**Makes easier:** any new panel gets the window and the filters by composing two functions, so it
cannot answer a different question than its neighbours. Adding a filter dimension is one edit in
`pageFilters()`. Any window the operator can name is available, not only the ones someone thought
to add a toggle for.

**Makes harder:** the aggregate carries no dimensions, so **any** filter forces the raw-row
readers, which are bounded by `REQUEST_ANALYTICS_RETENTION_DAYS` (90d) — a filtered total past
90 days undercounts where the unfiltered one stays right. That trade already existed for the
device filter and now covers three more dimensions. It is surfaced rather than hidden:
`rawWindowTruncated` names the oldest row held.

**Deleted:** the bespoke status/provider/providerFilter block on `/requests` (~55 lines), the
table-local status `SegmentedControl` and provider `Select`, and `getSinceTimestamp`'s switch —
replaced by `resolveWindow`, kept as a one-line wrapper only because `clifree-fleet.ts` reads a
cutoff with no upper bound of its own.

### Findings that shaped the implementation

**F5 — the hourly bucket's upper bound must NOT be ceiled.** A bucket is keyed by its **first**
second, so a bucket at exactly `until` holds only time at or past the bound. Ceiling `until` to
the next hour pulls in a whole bucket the window excludes: a custom window ending at midnight
counted the following hour. `since` IS floored — a rolling 24h window opens mid-hour and
dropping that partial hour would understate it. Found by a probe against the live DB: a
one-day custom window returned 6,117 requests, 248 of them from the next day.

**F6 — the span cap must keep the window's RECENT end.** Clamping `from=1900&to=2100` by
keeping the old end returns an empty chart. The cap measures back from `end`, and a `to` past
the present is clamped to now, because "everything so far" is the question being asked.

**F7 — filter dropdowns must not read the filtered list.** Selecting `groq` and then finding
`openrouter` unselectable would make the filter a one-way door. The provider and model options
are fetched unfiltered at 365d — the same idiom the device tabs already used, and for the same
reason.

**F8 — joining `api_keys` made bare column references ambiguous.** `api_keys` has its own
`platform` column, so adding the join (required for the endpoint-scoped provider filter) turned
`SELECT platform` into an error. The error-distribution queries needed `r.platform`.

## Testing seam

`server/src/__tests__/routes/analytics.test.ts` — the existing HTTP-level suite, no new seam. It
already drives every endpoint through the real router against an in-memory DB, which is what the
window contract needs: the assertions are about windows and cross-panel agreement, and those are
observable only over HTTP.

The tests that matter are the ones that would have caught F1 and F2:

- `gives a longer preset a strictly wider window` — counts differ per preset **and** the
  `windowSince` bounds are monotonic, which F2 violated silently.
- `buckets the timeline by the window span` — asserts the 30d and 90d **label sets differ**,
  which is F1 verbatim.
- `reads a custom from/to pair and treats 'to' as inclusive` — pins F5's boundary.
- `scopes every panel to the same slice` — asserts `/summary`, `/by-platform`, `/by-model`,
  `/timeline` and `/requests` return the **same number** for one filter, which is F3's fix.
- `caps an absurd window and keeps its recent end` — F6.

### Findings the browser caught, after the suite was green

**F9 — recharts infers the X-axis type, and from two points it infers a numeric one.**
`type` was left unstated, so a 180d or 365d window over this install (38 days of
traffic → two monthly buckets) rendered `2 empty tick groups` instead of two
labelled ones: the X axis showed no dates at all, and "Sept 26 / Oct 26" were
being drawn as Y-axis ticks. Verified by walking `.recharts-xAxis` and finding
zero `.recharts-cartesian-axis-tick-value` descendants. Fixed by stating
`type="category"` on the three timeline `XAxis` elements — which invents no data:
the honest two points stay two points and get their labels back. This is the one
defect in this change no server-side test could have caught; it needed a
rendered axis.

**F10 — `--fill-english` does not update a CHANGED key.** The horizon notice was
written, filled across 59 locales, then reworded for accuracy (it claimed rows
were "no longer retained", which is false on a young install that has never
pruned). `npm run check:i18n` then failed with 59 "text in the wrong language"
errors, because the fill script only ever adds missing keys. Overwriting the key
across locales by hand is the fix; it is already in `docs/GOTCHAS.md` for the
general case.

**On the two-bucket chart specifically:** it is not a bug and was not "fixed".
This install holds 38 days of traffic, so a 365-day window legitimately has two
months in it. The earlier `fillMonthlyGaps` was built on a wrong diagnosis (it
filled gaps between buckets, and September/October are adjacent) and is retained
only for the real case it does handle — a month with no traffic between two that
have some.

Beyond the suite, two passes against the running container:

- A throwaway script against a **copy** of the live database (never the volume
  itself) exercised all six presets, four custom windows, all three filters across
  seven panels, and five malformed inputs. Not committed.
- A Chromium pass against the deployed page. It selected each of the six presets
  and read the rendered X-axis labels; set a custom `2026-09-20 → 2026-09-26`
  window and watched the Requests card move to 12,789; then applied
  `provider=nvidia` and `status=error` and read the network log to confirm all
  nine analytics endpoints carried `range=30d&status=error&provider=nvidia`.
  That last check is the one that matters for F3 — the list and the charts now
  describe the same traffic, and the request URLs are the proof.

## Status

APPROVED 2026-10-04 — Pass 1 complete