# ARCH-20261018-manual-benchmark-scores

## Decision

Let the operator type a benchmark score into an empty cell (intelligence, coding, agentic) for any model route. Every typed score must carry one of three provenances, chosen at entry:

- **Related family**: borrowed from a sibling or predecessor model.
- **Approximated**: the operator's estimate.
- **Tested**: the operator measured it.

The provenance is written under the score and the score is marked in that provenance's colour, on every surface that shows the score.

## Context

Live data on 2026-10-18, read-only, counting enabled models on providers with an enabled key:

| Gap | Models |
|---|---|
| Enabled models with a key | 142 |
| No scores at all (unlinked, deliberately no counterpart, or slug unresolved) | 28 (custom 7, mistral 6, electronhub 5, nvidia 5, google 3, zhipu 2) |
| Linked, but no coding index | 24 |
| Linked, but no agentic index | 32 |
| Linked, but no intelligence index | 0 |

No mechanism writes a score today. `aa_model.*_index` is written only by the Artificial Analysis sync. `nudge()` returns null for a null value ("an estimate of nothing is still nothing"). `model_overrides` has no benchmark fields. So a missing metric is a dash on every surface for good, and `getAdjustedScores` (an INNER JOIN on `aa_model`) gives those routes no score at all, so they sort last in chain recommendations whatever their real quality.

The existing provenance is only `link.source` (`auto`, `manual`, `proxy`). A proxy is shown as `≈` plus "estimated", in muted text. ARCH-20260911 requires that "every surface showing a score now has to say where it came from", and that operator judgement is its own provenance class, never written as a measurement.

## YC Forcing Questions

**Demand reality:** What breaks without this? → 28 keyed models have no score and 56 linked ones are missing coding or agentic, so they rank as unknown and the operator cannot record what they already know about them.

**Narrowest wedge:** The smallest version that proves it →
- An inline entry on the Compare page table for the three indices, with the provenance picker.
- A new table keyed per route and metric.
- Display on the Compare table and the Keys provider panel.
- Typed scores feed `getAdjustedScores`, so chain recommendations rank these models.
- Other surfaces keep their dash until the wedge proves useful.

**Future-fit:** Does it hold in 2–3 years? → Yes, if a typed score never overwrites a measurement and stays separately labelled. If Artificial Analysis later publishes the metric, the measurement takes over and the entry is kept as history. That matches the separation ARCH-20260911 already relies on.

## Decisions (James, 2026-10-18)

- **D1 — Routing:** typed scores feed chain recommendations and ordering through `getAdjustedScores`.
- **D2 — Existing proxies:** today's `proxy` links count as **Related family** and use its colour, so there are three provenance colours, not four.
- **D3 — Fields:** intelligence, coding and agentic only. Speed and price stay measured-only.
- **D4 — Precedence:** an Artificial Analysis measurement replaces a typed score when one arrives. The typed score is kept and marked superseded, never deleted.
- **D5 — Display:**
  - The provenance is a small italic note under the score, and the score and its note take the provenance colour.
  - The colour set avoids the tones already used on score text: emerald and amber (chain minimums), rose (fit and proxy delta) and sky (baseline).

    | Provenance | Light | Dark |
    |---|---|---|
    | Tested | `text-cyan-700` | `text-cyan-400` |
    | Related family | `text-indigo-600` | `text-indigo-400` |
    | Approximated | `text-fuchsia-700` | `text-fuchsia-400` |

  - Measured scores stay plain foreground with no note.

## Consequences

**Makes easier:**
- The operator can record what they know.
- Chains can rank these models on something.
- Every number shows where it came from.

**Makes harder:**
- A fourth provenance axis joins `link.source`.
- Every score surface has to read one shared provenance, or it misleads.
- Three surfaces already use different "missing" glyphs (`–`, `—`, nothing). Unifying them is out of scope.

**Risks:**
- **R1:** `TONE_CLASS` (chain-minimums) colours score text in the model table. That surface is outside the wedge, and D5's colour set shares no hue with it, so the two cannot be confused if the model table adopts provenance later.
- **R2:** A typed score that feeds routing can push a weak model up a chain. The provenance label and the existing chain-fit review are the only guard.

## Testing seam

The existing server seam is `services/analysis.ts`: `getComparePayload` and `getAdjustedScores`, tested in `__tests__/services/analysis-*.test.ts`, plus one route test. The client side is a component test on the Compare table cell. No new seam.

## Status

APPROVED 2026-10-18 — Pass 1 complete

IMPLEMENTED 2026-10-18 on `docs/freellm-assert-start-on-redeploy` (local, not deployed). One deviation from D5: the model table prints the italic note inline beside the number, because its rows have no height for a second line.
