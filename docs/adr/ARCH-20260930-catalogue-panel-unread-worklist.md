# ARCH-20260930-catalogue-panel-unread-worklist

## Decision

Turn the catalogue panel on the Models page into an **unread worklist** with a **permanent**
bulk dismissal.

- **One OK button.** Marks every arrival AND every departure currently shown as dealt with, then
  collapses the panel. It deletes nothing: the current `models` row, the tombstone and any
  `catalogue_event` rows all stay exactly as they are. What changes is whether the panel lists
  them.
- **Two stores, split by what each must mean.** Arrivals are marked in the new `catalogue_ack`
  table, permanently. Departures are marked with `catalog_model_tombstones.acknowledged_at`, the
  column that already exists for this. The split is not convenience — see F2 below, where an
  identity-only departure mark would hide a real incident forever.
- **Collapsed when there is nothing unread.** A quiet panel is a collapsed panel. The header count
  is what you scan; the rows are what you open.
- **Expanding with nothing new shows the 10 most recent** across both kinds combined, as a plain
  list. A "show all" control beside it lifts the panel to the full in-window list.
- **The unread set is computed in the client, not the server.** `getCatalogueChanges` returns
  everything in the window as today, plus a per-row `acknowledged` flag. No filtering happens
  server-side, so the Keys page's provider chips keep counting acknowledged rows and the client
  still has the data for the 10-row fallback and "show all".
- **New table, one new route, one extended query.** `catalogue_ack` marks ARRIVALS only, keyed
  `(platform, model_id)` with nothing else. No history, no read-stamps, no record of who
  acknowledged what — the point is to stop the same arrivals repeating, not to log the
  acknowledging. There is no `kind` column, because departures do not live here (see above).
  `localStorage` is **not** used: it is per-browser, and "I have looked at this" is a fact about
  the install, not about the window.

James, asked why the panel had gone quiet:

> "i haven't seen teh catlogue changed for a while"

and, on the first draft, which proposed a local dismissal:

> "i want a dismisasal to be permanet so write to i dpnt want a refresh to bring it back"

and, approving this design and cutting its scope back:

> "yes this sounds fine add a new table we dont need a complex structure its just to mark off and
> acknowledge we dont need to record or keep it logged its just to stop annoying the same x amount
> of models ahve arrived , and we dont need an undo if i want to look at whats new i will expand and
> see the recent events logge din"

## Context

The panel is not broken, and neither is sync. Measured on the running install
(2026-09-29, `/api/models/changes` over the 30-day window):

| Fact | Value |
|---|---|
| Arrivals in window | 372 |
| Arrivals on an activated provider | 50 |
| Departures shown | 0 |
| Tombstone rows in the database | 1 |
| Newest arrival | `aclide/anthropic/claude-haiku-4.5`, 2026-09-29 11:09 |
| Panel as rendered | "50 arrived · 0 departed · 6 already routing", collapsed |

Sync is healthy: 12 models arrived since 2026-09-20, and the extension `catalogue-log` is enabled.
The panel renders and reports correctly.

Why it reads as absent is two separate things:

1. **No notion of "unread".** Every arrival inside the 30-day window is a row, every visit. A
   routed arrival already carries a destructive "auto-routed" badge and an unrouted one an outline
   badge (`client/src/components/catalogue-changes.tsx:135-137`), so routing IS distinguished —
   what is missing is whether the operator has *read about it*. Read and unread rows look
   identical, so there is no reason to come back after dealing with something and no way to say
   "I have been through this".
2. **The panel hides most of its own content by default.** `client/src/lib/activated-platforms.ts`
   is a deliberate filter — 322 of the 372 arrivals belong to providers with no enabled key, which
   the operator can never call. That filter is correct and stays. But it means the visible 50 is
   mostly a month of history, not a worklist.

The window is **sliding, not accumulating**: `getCatalogueChanges` filters on
`first_seen_at >= since` (`server/src/services/catalogue-changes.ts:101`), so unacknowledged
arrivals do age out on their own. That is why the worklist needs a durable mark rather than a
count — but it also means "unread" is scoped to the window, not open-ended. An arrival older than
30 days is not unread, it is simply gone from this surface.

Separately, the "0 departed" is honest, not a fault: departures are filtered to
`kind = 'chat' AND source = 'upstream_eol'`, and this install has one tombstone row in total. That
count is also not proof that no upstream chat retirement ever occurred — the panel also drops
acknowledged rows and rows on unactivated providers. The bulk control must still cover departures,
because the day one is retired the same "I have looked at this" gesture should apply to it.

**Why a new table rather than the two stores that already exist.** Departures already have a
permanent marker: `catalog_model_tombstones.acknowledged_at`, written by
`POST /api/models/changes/acknowledge` and read by the panel's `!d.acknowledgedAt` filter. Arrivals
have no equivalent — `models.first_seen_at` records when a model appeared, never that anyone has
read about it, and the client-side `client/src/lib/seen-arrivals.ts` stores that fact in
`localStorage`. Three candidate homes, and why the third wins:

| Option | Verdict |
|---|---|
| `localStorage` (`seen-arrivals.ts`) | Rejected. Per-browser. The same install on the MacBook reports 50 unread after the Studio acknowledged them all, which is worse than the current state rather than better. |
| A new column on `models` | Rejected. `models` is a catalogue row rewritten by every sync; an operator's read-state on it would be at the mercy of the prune and relist paths, and it cannot hold a departure's acknowledgement at all. |
| **A separate `catalogue_ack` table, for arrivals** | **Chosen.** One row per `(platform, model_id)` the operator has read, independent of the sync lifecycle. Departures do **not** live here — see F2 below. |

**F1, the read contract (this constrains the implementation).** The Keys page consumes the *same*
response and the *same* react-query cache as this panel: `provider-list.tsx:572` and
`provider-models-panel.tsx:527` both call `useCatalogueChanges()`, whose key is
`['catalogue-changes', CHANGES_WINDOW_DAYS]` (`client/src/lib/catalogue-changes.ts:44`). A filter
applied inside `getCatalogueChanges` would therefore erase the provider churn chips and the
amber new-model marks — and `churnByPlatform` has a test asserting acknowledged departures still
contribute to churn (`client/src/lib/catalogue-changes.test.ts:47-53`). So:

- `getCatalogueChanges` keeps returning **every** in-window row, unchanged in shape, plus one new
  `acknowledged: boolean` on arrivals (from `catalogue_ack`) and on departures (from
  `acknowledged_at`, which is already being read and just renamed to the same field).
- The panel filters **client-side** via `unreadSelection()`.
- There is no `showAll` server flag, because no server filtering exists to switch off. "Show all" is
  a client control over the full payload, which is why the payload must not be filtered.
- Invariant, tested: bulk and per-row acknowledgement never change `churnByPlatform` output for
  either consumer.

**Why departures stay on `acknowledged_at`, and this is not a simplification.** Relisting DELETES
the tombstone (`server/src/services/model-state.ts:404`), so a retire → relist → retire again cycle
produces a *new* retirement that disabled routing a second time. `acknowledged_at` lives on the
tombstone, so it dies with it and the second retirement is correctly unread again. An identity-only
mark in `catalogue_ack` would survive that delete and suppress a genuine loss of routing forever —
the exact opposite of what this surface exists to report. So the bulk OK writes `acknowledged_at`
for departures and `catalogue_ack` for arrivals, and the two stores are never conflated.

**What permanence costs, and what is actually guaranteed.** There is no un-acknowledge path, and
this ADR does not add one: "we dont need an undo if i want to look at whats new i will expand and
see the recent events". The guarantee is precise and deliberately narrow: **acknowledgement deletes
nothing.** The current `models` row, the tombstone and any `catalogue_event` rows all survive. It is
NOT a guarantee that the event log is a complete history — `recordCatalogueEvent` swallows insert
failures by design (`server/src/services/catalogue-log.ts:89-100`, "losing a log row is strictly
better than failing the operation the log is describing"), and the log's own migration deliberately
does not backfill arrivals. A mistaken acknowledgement therefore cannot lose a current record, but
historical rediscovery is best-effort, not certain. `getCatalogueChanges` filters, never deletes,
so "show all" stays honest.

## YC Forcing Questions

**Demand reality:** does anything break today? Nothing breaks. The cost is attention: the same
in-window rows repeat on every visit, there is no way to say "I have read these", and the
`6 already routing` badge carries no more weight after the twentieth visit. The panel is rendered
collapsed by default because the expanded form is long. A worklist you cannot empty is not a
worklist.

**Narrowest wedge:** the panel plus the smallest durable store. One new table (arrivals only), one
bulk-acknowledge route, one `acknowledged` flag on the existing response, the panel's selection
logic, and the two controls. The full log and the Keys-page chips keep reading the same unfiltered
payload they read today, so the F1 ripple is designed out rather than avoided — the client filters,
so no consumer's data changes shape. If the store is wrong, it is wrong in one file and the
dismissal is still a single click.

**Future-fit:** yes. "Which catalogue changes have I not looked at" is a permanent question for any
catalogue that pulls from providers nobody controls, and it gets worse as provider count grows —
there are 40 providers in the key table and 850 catalogue models, with `electronhub` alone
contributing 71 arrivals in one window. A durable store is the right shape because this question
gets asked from more than one machine: the Studio builds and deploys, the MacBook reads the
dashboard, and a localStorage dismissal would diverge between them.

The arrival key carries no timestamp, which is a consequence of the simple table: an acknowledged
arrival that is later relisted stays acknowledged, because the mark is keyed by identity alone.
That is the correct behaviour for an ARRIVAL — "stop repeating the same arrivals" — and the event
log still records the relist as its own event. It is deliberately NOT the behaviour for a
departure, which is why departures use `acknowledged_at` and gain one when the tombstone is
recreated (see F2 above).

Adding a stamp later is additive at the schema level, but the honest limit: existing identity-only
rows carry no acknowledgement time to backfill, and the moment an operator actually acknowledged
cannot be reconstructed. A future timestamped design would have to decide what to do with those
rows rather than assume the column can be populated.

## Consequences

**Makes easier:**
- Coming back to the panel after a week shows what is new, not the same 50 rows, on any machine.
- The `6 already routing` badge means something again, because acknowledged rows leave the list.
- One gesture covers both lists, so an arrival and a retirement are dealt with the same way.
- The mark-off is a row, not a log, so there is nothing to reconcile and nothing to migrate later
  if the history is ever wanted — the event log already has it.

**Makes harder:**
- A migration, which the branch's own guidance treats as the highest-risk change in the repo. It
  needs three registrations in `server/src/db/migrate/defaults.ts` — module import, filename
  constant, and a `DEFAULT_MIGRATIONS` entry — because `runner.ts` executes that array rather than
  discovering files in the directory. A conflict-free rebase needs no re-registration; what must
  survive is a rebase that touches this file, which is the case `AGENTS.md:22` records happening 19
  times for v0.9.7 → v0.11.0.
- A new write path on a read-only surface. The panel's header comment currently says it "reports
  and does not act"; acknowledging is not routing, but it needs saying explicitly, because the
  reason that comment exists was `auto_include_new_models`.
- The two stores are split by kind, not by control, and a reader must not merge them: the bulk OK
  writes `catalogue_ack` for arrivals and `acknowledged_at` for departures, and the per-row
  departure button writes `acknowledged_at` only. Because relisting deletes the tombstone, that
  split is what makes a second retirement of the same model read as new again.
- An acknowledged ARRIVAL that is relisted stays acknowledged — the identity-only key makes that
  unavoidable, and it is the right trade for a surface whose job is to stop the same arrivals
  repeating. Departures deliberately do not share that property.
- `getCatalogueChanges` now joins a second store into its arrival query, so a new table is on the
  hot path of the Keys page's chips, not only the panel.

## Testing seam

**Two existing seams, no new ones.**

1. `server/src/__tests__/services/catalogue-changes.test.ts` (**9 tests today**, not 5) — extend
   for the server half. It already covers `untrackedArrivals` and the `retireCatalogModelUpstream`
   write path, so a durable arrival mark is tested in the same place with the same fixture. Cases:
   a marked arrival comes back with `acknowledged: true` and is still present in `arrived` (F1 —
   filtering is the client's job); the mark is idempotent on a second call; a re-retirement after
   relist reports unread again, proving departures are not stored in `catalogue_ack` (F2); a bulk
   departure dismissal sets `acknowledged_at`.
2. `client/src/lib/catalogue-changes.test.ts` (4 tests today) — extend with `unreadSelection()`,
   the pure function that decides what the panel shows. Beside `churnByPlatform`, which is the
   existing precedent for a rule both surfaces share, tested without a component. Cases: unread
   only; the 10-most-recent fallback **counted across both kinds**; the collapse decision; and the
   F1 invariant — `churnByPlatform` over a payload containing acknowledged rows returns the same
   counts as before, so the Keys chips cannot change.

**F3, corrected: the 10-row head is a plain list, not a narrowed `TimeTreeLog`.** Passing 10 rows
into `TimeTreeLog` does not produce a foldable 10-row view — `folded = items.length > foldAbove`
(`client/src/components/time-tree-log.tsx:114`), so exactly 10 renders no history control at all,
and the component can never widen to rows it was not given. So the quiet fallback is a **plain
combined list of the 10 most recent changes, sorted by timestamp, both kinds in one sequence**, and
"show all" is a panel-owned control that swaps it for the full in-window list. The two existing
`TimeTreeLog` instances stay for the unread case, where they receive the full unread set.

The component itself is not unit-tested and should not be. Verification beyond the suite is driving
`/models/chat` in a browser, including a reload to prove the dismissal survives one, and a second
machine or a cleared `localStorage` to prove it is not browser-local.

## Status

APPROVED 2026-09-30 — Pass 1 complete
