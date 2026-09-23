# How this repository works

This fork is an **extension layer over an unmodified FreeLLMAPI release**. That
sentence is the whole design, and everything below follows from it.

Two rules decide almost every question that comes up:

1. **Upstream's code is upstream's.** We never hold a position against it. If a
   release does something we also do, we delete ours and take theirs.
2. **Our code is a layer, not a patch history.** It is re-applied to each
   release as a small ordered set of commits, and conflicts are resolved inside
   that layer, one subsystem at a time.

## The three branches

| Branch | Contains | Moves how |
|---|---|---|
| `main` | upstream, untouched | fast-forward to a release tag, never anything else |
| `docs/freellm-assert-start-on-redeploy` | the release + the overlay | rebuilt each release by re-applying the overlay |
| `imperium/pre-<version>-recovery` (tag) | the exact tree before an upgrade | never moves; the way back |

`main` exists so there is always a pristine answer to "what does stock
FreeLLMAPI do here". Do not commit to it.

## The overlay

The extension is **eight commits**, one per subsystem, in this order:

```
infra          migrations, migration manifest, shared types, scripts
quota-ledger   quota-policy, quota-clock, quota-routing, pressure, burn, forecast
routing-core   router, scoring, fallback-loop, ratelimit, provider-quota
catalogue      catalogue log, churn, model-state, catalog-sync, model-health
benchmarks     analysis, model groups, compare surfaces
keys-ui        Keys page panels, quota headroom and limits, model scope, provider list
pages-ui       Fallback page, Logs page, shared client lib
extensions     the registry, the state store, the toggle API and panel
```

The order is a dependency order, not a preference: `infra` carries the schema
everything else reads, and `extensions` sits last because every other commit
declares a registry entry.

**Why eight and not 189.** Measured on the v0.9.7 -> v0.11.0 upgrade: the branch
carried 189 commits, and 71 of them touched a file that conflicted, so replaying
them re-resolved about 127 file-conflicts across 71 stops — `defaults.ts`, the
migration manifest, nineteen separate times. Re-resolving a migration manifest
nineteen times is how an entry silently stops being registered, and a migration
that never runs is data that never arrives. With eight commits the same upgrade
stops at most eight times, and each stop has one subsystem's context in front of
it.

## Upgrading to a release

1. **Read both sides first.** `git log --oneline v<old>..v<new>` and
   `git diff --stat v<old> v<new>`. Look for features that duplicate ours before
   resolving anything — see "Deference" below.
2. **Fast-forward `main`** to the new tag.
3. **Tag the current tree** `imperium/pre-<version>-recovery`.
4. **Re-apply the overlay in a worktree**, never in the deployment checkout:
   `git rebase --rebase-merges --onto v<new> v<old> <overlay-branch>`.
5. **Resolve inside the overlay.** Conflicts arrive grouped by subsystem. Apply
   the resolution rules below.
6. **Regenerate locales rather than merging them.** `node
   scripts/apply-translations.mjs --fill-english` from `client/`, then
   `npm run check:i18n`. Never hand-merge a locale JSON conflict.
7. **Validate before touching anything live**: both suites, both typechecks, and
   a migration rehearsal against a *copy* of the volume (see "Data").
8. **Then deploy**, with the checklist in
   [03-imperium-extension-branch.md](./03-imperium-extension-branch.md).

## Deference: upstream wins by default

The point of a thin layer is that it can be thrown away in pieces. When a
release implements something we already had, the default is **delete ours**. Not
"keep both", not "ours is better here".

This is not theoretical. In the v0.11.0 upgrade:

- Upstream shipped our quota forecast back to us, constants and comments intact,
  with activity-based exhaustion added. We adapted to their signature and kept
  one function.
- Upstream deleted our `normalizeExpiredQuotaState` and our
  `COALESCE`/`MAX(confidence)` snapshot merge, replacing them with a recency
  guard. Theirs is better and the freshness migration depends on it; keeping
  ours would have undone that migration on the first write.
- Upstream's cooldown ceilings, account-suspension handling, key-wide 402
  benching and reset-header parser all replaced ours.

Three of those went against code we had reasoned about carefully and were
attached to. That is the rule working, not the rule failing.

**Keep ours only when it is measurably better on this install, and say why in
the commit.** The pool resolver is the standing example: upstream's flat table
calls Groq `groq::account`, and seven days of traffic here shows Groq metering
per model, so we keep the typed resolver and port their new providers into it.
That justification is written at `server/src/data/routing-curation.ts` and in
the resolver's own comments, so the next reader can re-check it rather than
inherit it.

**When upstream builds something better than ours, the correct outcome is that
our version disappears.** A shrinking overlay is the design succeeding.

## Resolution rules

Classify each conflict before resolving it:

- **Additive** (we add, upstream did not remove) — keep both. This is 83 of our
  92 upstream-file edits, so most conflicts are mechanical.
- **Convergent** (both implemented the same thing) — take upstream's, port our
  measured deltas onto it. Never keep two implementations behind a flag.
- **Invasive** (we replace upstream behaviour) — nine files today. Each one
  needs a stated reason. Every conversion of an invasive edit into an additive
  one is permanent progress, because it is a conflict that stops recurring.
- **Locale JSON** — regenerate, never merge.
- **Docs** — upstream owns structure (`docs/en/...` since v0.11.0); our
  four extension docs keep their content and move to wherever upstream's layout
  puts them.

A resolution that keeps a whole file from one side is almost always wrong. Read
both sides.

## Customisability: the extension registry

Every extension is individually switchable, so this fork can be run as a thin
skin over stock behaviour or with everything on.

- `shared/extension-registry.ts` declares each extension: what it does, where
  its settings live, which files implement it, **what stops happening when it is
  off**, and **when that takes effect**. Those last two are required fields.
- Enablement is one JSON document in `settings.imperium_extensions`, loaded once
  at boot into an immutable snapshot, read by `isExtensionEnabled(id)`.
- The registry is not a settings store. Provider order, quota limits, benchmark
  mappings and probe budgets stay where they already live.

**Off is never destructive.** Migrations still run, rows and saved scopes
survive, and a disabled editor never widens what it was editing. Disabling the
merge extension does not un-merge models; disabling the scope editor does not
open a key's scope.

**One exception, deliberately.** `paid-balance-guard` may be switched off, but
doing so requires typing `ALLOW PAID SPEND`, records an acknowledgement, and an
off state that has lost its acknowledgement is repaired to ON at load rather
than honoured. There is no second control over paid routing.

**Not everything belongs in the registry.** A bug fix is not an extension.
`model-health-verdicts` — a probe budget large enough for a model that reasons
before it answers, and reading a provider 5xx as `limited` rather than `dead` —
has no entry, because a switch for it would read "report wrong verdicts again".
When in doubt: if "off" would restore a behaviour we can demonstrate is wrong,
it is a fix, and it ships unconditionally.

## Data

Code and data upgrade independently, and data is the half that cannot be
rebuilt.

- Everything persistent lives in the `freellmapi_freellmapi-data` volume. No
  branch, rebase, merge or image build touches it.
- Schema moves **forward only**, through migrations tracked by filename in the
  `migrations` table. Never run `down` or `fresh` against real data.
- Production applies the **explicit `DEFAULT_MIGRATIONS` array** in
  `server/src/db/migrate/defaults.ts`, not a directory scan. An entry missing
  from that array is a migration that never runs. It is filename-sorted and a
  test asserts it matches the directory exactly — keep both true.
- **An upstream migration that rewrites existing rows needs an archive
  migration in front of it.** v0.11.0's
  `20260915_000001_quota_snapshot_freshness` rewrote 40 of 104
  `provider_quota_state` rows on this install, so
  `20260914_999999_preserve_quota_state` copies the originals first. Check every
  new upstream migration for `UPDATE` and `DELETE`, not just `CREATE`.
- **Rehearse on a copy, never on the live file**: restore the volume into a
  scratch path, run the production migration path twice, and compare rows and
  keys — not just counts. The second run must apply nothing.

## What this does not yet give you

The overlay makes re-applying the extension cheap. It does **not** make it a
package someone can install onto a stock FreeLLMAPI, because stock has no
extension loader: no hook registry, no UI slots, no way to register a route or a
migration from outside `server/src`.

Getting there needs six seams upstream — a score/ordering hook, an admission
hook, a quota-observation hook, route registration, migration registration, and
a client slot registry. Our 136 new files would then become a package, and a
release upgrade would touch none of them. Until then the distributable artifact
is the built image.

Each invasive edit converted to additive shrinks that ask. That is the direction
of travel, and it is compatible with rule 1: if upstream eventually implements
any of this better than we do, our version goes.
