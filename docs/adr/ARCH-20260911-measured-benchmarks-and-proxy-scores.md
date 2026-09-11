# Measured Benchmarks, Proxy Scores and Key Reachability

Status: IMPLEMENTED 2026-09-11 — on `docs/freellm-assert-start-on-redeploy`

## Context

FreeLLMAPI ordered models by `intelligence_rank` and `speed_rank`: hand-tuned per-provider integers shipped with the catalogue. They are useful for breaking ties inside a chain and they are not measurements. Nothing in the product could answer whether a chain head was actually the strongest route available, so chain membership on this install was assembled before any evidence existed and had never been revisited against any.

Three specific failures made the gap concrete while curating the eight chains:

1. `auto:apex` was headed by a model scoring 23.4 on measured intelligence while a 39.4 model sat behind it in the same chain and a 43.8 model sat outside it.
2. `auto:default` and `auto:workhorse` were headed by a model with an agentic score of 3.2 — effectively no tool-use capability — which is the one thing both chains need.
3. Scores alone then produced a chain whose head returned 403 on every call, because benchmark quality says nothing about whether a route works. Thirty days of outcomes in the local `requests` table contradicted the benchmark ranking on three of five edits.

Separately, the dashboard could not say whether a model was reachable at all. "Enabled" meant a catalogue row was switched on; it did not mean a usable key existed, and provider keys carry a per-model scope, so holding a key for a platform does not imply being able to call a given model on it. On this install 330 of 407 logical models were enabled and unreachable, and four members of freshly curated chains were silently dead.

## Decision

### Measured data as a separate axis, not a replacement

1. Cache Artificial Analysis benchmark data locally (`aa_model`) and link it to catalogue rows (`aa_model_link`). Store slugs, never copied scores: a sync refreshes them, and a withdrawn slug resolves to nothing rather than to a number that quietly stopped being true.
2. Keep `intelligence_rank` and `speed_rank`. They are our ordering, the benchmark is somebody's measurement, and the value is in seeing them disagree. Neither is derived from the other.
3. The API key is stored encrypted at rest like provider credentials, and never returned.
4. Attribution is rendered wherever the data is, as their terms require.

### One source of scores for every surface

`getAdjustedScores` is the single place any screen obtains these numbers. The Models page previously showed our rank while Compare showed the measured index, so the two disagreed about the same model by construction. Every consumer now reads one server-side function, adjustments included, so no screen can print a figure another screen would print differently.

### Matching is reported, never silently trusted

5. Automatic matches record HOW they matched (`slug`, `name`) and the row displays WHICH benchmark it matched to. An automatic match is a guess, and a guess that cannot be inspected cannot be corrected — on this install every Gemini row matched a reasoning-effort variant, which is a judgement the operator should get to see.
6. A manual link overrides the matcher and survives every re-match. Only `source = 'auto'` rows are ever re-proposed.
7. `aa_slug = NULL` with a manual source is a decision — "this has no counterpart" — distinct from an absent row, which is merely unexamined.

### Proxy scores for unpublished models

8. A model the upstream does not publish may borrow another model's scores, recorded as `source = 'proxy'`. This is a WEAKER claim than a match: "read this as roughly that", not "this is that model".
9. A proxy must never be evidence that two routes are the same model. It is excluded from group conflict detection, and nothing merges on it. Merging is a routing decision; a benchmark match is an evidence claim; conflating them would let a mapping correction silently rewrite failover.
10. Proxies carry a per-metric adjustment (`proxy_delta_*`), because a stand-in is rarely uniformly close — a model can code like its proxy and reason worse. Bounded to three coarse steps each way and rendered `+++` / `---`: this is a judgement, and an unbounded offset would be indistinguishable from inventing a measurement.
11. Index adjustments are in points; speed is proportional (15% per step), because tokens/sec spans 30–350 here and a point would be noise at one end and decisive at the other.
12. Adjusting an `auto` or `manual` link is refused. There the numbers measure the model, and shifting them would be falsification rather than estimation.
13. When a sync publishes the real model, the dashboard PROMPTS rather than swapping. A proxy is deliberate, so no re-match touches it — which means it can outlive its usefulness silently. Replacing an operator's judgement with a fresh guess unasked is the same mistake as ignoring the new data, in the other direction.

### Reachability as a first-class state

14. Reachability is judged with the same `scopeAllows` the router uses, so no view can claim a route is available that the router would reject for want of a key.
15. Four states are distinguished, because they imply different actions: no key (add one), key disabled (enable it — a decision, not an oversight), key scoped elsewhere (widen the scope), key usable.
16. Narrowing an unscoped key is refused. `NULL` scope means every model on the platform; removing one id would freeze the rest into a list and silently revoke everything discovered later.

## YC Forcing Questions

**Demand reality:** Demonstrated by the curation itself. Every chain head on this install was wrong on measured capability, three of eight chains were headed by models that could not do what the chain is for, and one curated chain pointed at a route that had never once succeeded.

**Narrowest wedge:** A read-only benchmark cache, a link table, and views that display both numbers side by side. No scoring changes, no routing changes, no automatic chain edits. Routing continues to use its own ranks; this subsystem informs the human who edits chains.

**Future-fit:** If measured indices later prove better than hand-tuned ranks for ordering, the data and its provenance are already present and already separated from our own numbers. Nothing needs to be un-picked first.

## Consequences

**Makes easier:** Judging chain membership on evidence; noticing that a route is unreachable rather than merely idle; comparing a free catalogue against a paid baseline; giving unpublished models a defensible position in a sorted list.

**Makes harder:** Four more tables/columns to migrate, and a second opinion about model quality that must not be confused with the first. Every surface showing a score now has to say where it came from — measured, manual or estimated — or it misleads. Proxy adjustments are operator judgement with no audit trail beyond the value itself.

**Deliberately not done:** Automatic merging on shared benchmark slugs. Nine of this install's routes map to `gemma-4-31b` under different display names; merging them on that basis would rewrite routing every time a mapping was corrected, across providers whose quotas and reliability the operator has judged differently.

## Testing seam

Server: `analysis-match.test.ts` for the matcher's ambiguity and suffix rules; `analysis-link.test.ts` and `routes/analysis-link.test.ts` for link semantics and the set-of-routes endpoint; `analysis-grouped.test.ts` for proxy sources, per-metric adjustments, clamping, upgrade detection and its memo, key scope and reachability states.

Client: `compare-sort.test.ts` pins that unmeasured models sink in both sort directions and that a genuine zero price does not; `alias-merge.test.ts` pins that undoing one group leaves other groups untouched.

The live install is the authority for matching quality: the matcher is probed against the real catalogue rather than fixtures, because fixture names are chosen by whoever writes them and the real ones are not.

## Status

IMPLEMENTED 2026-09-11 — benchmark cache, matching, mapping, baselines, proxy scores with per-metric adjustment, upgrade prompts, and key reachability signals all shipped and verified against the running install.
