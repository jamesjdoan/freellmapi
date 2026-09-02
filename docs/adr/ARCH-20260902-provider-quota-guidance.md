# ARCH-20260902-provider-quota-guidance

## Decision

Add a quota-guidance panel beside each provider credential's existing model-access
controls in the Imperium-maintained FreeLLMAPI extension.

The panel presents researched free-tier facts at the scope where the provider
actually meters them: provider account, shared pool, project, or individual model.
Each fact records its metric and period, a concise human-readable allowance, source
URL, verification date, and confidence/status when the source is contradictory or
unofficial. The panel is guidance for configuring the existing provider- and
model-level caps; it does not silently change those caps.

When published documentation conflicts with a supervised request made through the
operator's account, the observed account result controls the panel's current-access
status. The published allowance remains visible as a separately attributed claim.
The record is visibly flagged with an operator-facing reason and suggested follow-up,
such as provider/model retired, model identifier changed, access or billing research
needed, or documented policy contradicted by observed behavior.

All flags are advisory. A flag may link or focus the existing model-access controls,
but it never disables or deletes a provider/model and never changes routing policy.
The operator must make any access change explicitly so temporary outages and disputed
quota claims do not erase useful configuration or history.

Every guidance record displays its exact `verifiedAt` date. It becomes visibly due
for review after 30 days by default, while volatile previews, promotions and disputed
policies may declare an earlier review date. Stale records remain visible and retain
their history; staleness never deletes, hides or applies a quota value.

Published quota facts, operator-configured limits, and observed live usage remain
three separate kinds of data. Updating catalogue guidance must not overwrite local
limits or usage history.

Model-specific RPM, RPD, TPM and TPD settings remain attached once to the
provider/model endpoint and apply across every configured key for that provider. The
provider-key screen may expose those existing model settings beside model-access
toggles, but it must label their shared effect clearly. Credential-specific account
limits remain attached to the individual key; this decision does not introduce
per-key/per-model overrides.

The existing provider dialog becomes a responsive two-column workspace. On desktop,
model access and editable limits remain on the left while free-tier guidance,
provenance, freshness and advisory flags appear on the right. Smaller layouts stack
the guidance below the controls. Per-model guidance remains visually associated with
its provider/model row rather than appearing as an unrelated provider-wide total.

Verified and current guidance may offer an explicit `Use these limits` action. The
action previews the exact provider/account or provider/model fields it will populate
and requires confirmation through the existing save boundary. Unknown, stale or
contradictory guidance is display-only and cannot be applied through this shortcut.
The catalogue may describe other units, including monthly credit, concurrency and
provider-defined rolling windows, but the first version marks them `Reference only`.
Only RPM, RPD, TPM and TPD map to enforceable fields in this decision; unsupported
units are never coerced into an inaccurate gate.

Quota guidance may be refreshed through an explicit agent-assisted research
workflow. The agent may search current provider documentation and, where necessary,
recent secondary sources, then propose source-linked updates for review. A model
served by FreeLLMAPI may assist with interpretation only when the calling workflow
also supplies an external web/search tool. FreeLLMAPI's request router will not
scrape the web or accept unreviewed model output as quota truth during normal
routing.

The researched records live in a version-controlled quota-guidance catalogue on the
extension branch. They are reviewed, validated and delivered through the extension's
normal image rebuild. They are not written directly into the live SQLite database or
mixed into FreeLLMAPI's remotely signed upstream catalogue.

Evidence precedence is explicit: supervised authenticated account/API observations
determine current access; official provider documentation determines published
allowances; official provider announcements may supplement those documents; forums
and third-party pages are research leads only. Unverified secondary claims are
visibly labelled and cannot drive `Use these limits` until confirmed by a stronger
source.

The catalogue shape supports every FreeLLMAPI provider, but the initial researched
dataset is limited to providers currently configured or enabled in the operator's
installation. An unresearched provider renders an explicit `Quota guidance not
researched` state rather than an invented default. Later reviewed agent refreshes may
expand coverage.

The first release has no background scraper or dashboard-triggered AI research. A
documented, user-triggered Codex maintenance task performs web research, updates the
extension catalogue, validates dates and source classes, and presents a reviewable
diff. The reviewed change reaches the dashboard only through the ordinary extension
rebuild. Runtime automation may be reconsidered only if this workflow proves
materially burdensome.

Guidance identity includes the provider and provider-native model ID. When an ID is
renamed or retired, its record is retained as `Superseded` historical evidence and
may point to the replacement ID. A replacement receives a new current record; old
limits never transfer automatically across model identities.

Research is read-only by default and consumes no provider inference quota. A live
account/API probe requires explicit operator authorization, uses the smallest
practical completion, never adds billing or creates/regenerates credentials, and
records that its outcome is an account-specific observation at a particular time.

## Context

The current provider-key screen can control model access and FreeLLMAPI can record
live quota signals, but the operator still has to search externally to learn whether
an allowance is account-wide or per model, whether it is measured in requests,
tokens or credit, and when it resets. This makes it easy to configure the wrong
scope or treat stale marketing and documentation as current policy. SambaNova's
contradictory free-tier documentation and live payment-required response demonstrate
why source and verification dates must be visible.

## YC Forcing Questions

**Demand reality:** What's the evidence this is actually the problem? What breaks or
hurts right now without this? → The model-access UI lacks the provider's documented
free allowance and its scope. Operators must search for limits outside the product,
and contradictory or stale information can lead to incorrect account/model caps and
wasted routing attempts.

**Narrowest wedge:** What's the smallest version that proves the idea is worth
pursuing? → A source-linked, dated guidance panel beside the existing provider and
model controls, showing account/shared-pool facts and per-model facts such as `200K
tokens/day/model`. It guides deliberate edits through existing controls and performs
no automatic cap mutation.

**Future-fit:** Does this still make sense in 2–3 years, or are we solving today's
pain with tomorrow's debt? → Yes. Treating published facts as dated evidence,
separate from configured policy and observed usage, survives provider policy changes
and supports later user-triggered research refreshes without coupling request routing
to web scraping or a particular model.

## Consequences

**Makes easier:** Correctly setting account and model caps without leaving the
provider screen; recognizing shared versus per-model allowances; seeing when a fact
may be stale; preserving an auditable source trail; refreshing guidance with a web-
enabled agent without changing runtime routing semantics.

**Makes harder:** Quota claims require provenance and periodic review. Provider pages
can contradict live account behavior, so the UI must distinguish documented,
observed and uncertain facts rather than presenting every value as guaranteed.
Agent-assisted updates need a review boundary and cannot treat forum posts as equal
to provider documentation. Guidance changes require the extension's normal reviewed
rebuild before they appear in the running dashboard.

## Testing seam

Use the existing authenticated provider-key detail API and dashboard screen as the
single integration seam. Tests should prove scope-aware rendering, source and
verification-date display, stale/uncertain states, separation from configured limits
and observed usage, and that a guidance refresh cannot mutate routing caps without a
separate explicit operator action.

## Status

IMPLEMENTED 2026-09-02 — verified by authenticated route tests, rendered UI tests,
the full repository test suite, focused lint, and production builds.
