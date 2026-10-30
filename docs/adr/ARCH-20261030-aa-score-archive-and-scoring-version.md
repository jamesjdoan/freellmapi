# ARCH-20261030-aa-score-archive-and-scoring-version

## Decision

Artificial Analysis (AA) data is read through one resolver
(`server/src/services/aa-scoring.ts`). Every surface that ranks, grades or prints
an AA index uses it.

1. **Archive.** `aa_score_archive` keeps the last non-null value AA published for
   each `(slug, metric, index_version)`. The metrics are intelligence, coding,
   agentic and index cost per task. Migration `20261030_000001` seeds it from
   `aa_measurement` and `aa_model`. Each successful sync adds to it. Nothing
   prunes it.
2. **Scoring version.** `settings.aa_scoring_version` pins the Intelligence Index
   version that rankings, chain minimums and the arranger read. The migration
   pins the version that holds the most archived intelligence scores (`v4.3` on
   the live database). A fresh install's first sync pins whatever version that
   sync returns. Only the operator moves the pin (`PUT
   /api/analysis/scoring-version`). Chain minimums are not converted when it
   moves.
3. **Retired metrics.** A metric counts as retired when the current snapshot has
   no value for it on any model. Coding and Agentic have been retired since
   2026-10-29. Each model then shows its last published value, with provenance
   `archived`, the index version and the publication date. While AA still
   publishes a metric, a model with no value shows null.
4. **Archived ranks as a measurement.** Precedence and grading treat it as a
   measurement, so retiring a metric changes no grade, and typed scores it
   superseded stay superseded. It is never shown as current. The Model Passport
   marks OMP role results that rest on archived values as provisional.
5. **Refresh.** `services/analysis-fetch.ts` fetches every page of
   `/api/v2/language/models/free` and validates it before anything is written.
   Retries are bounded: 3 attempts per page, with 1 s and 2 s backoff on
   network errors and 5xx. A `Retry-After` of 60 s or less is waited out. A
   longer one stops the refresh and blocks requests until the time it names.
   A refresh is refused before it starts if the remaining quota cannot cover
   every page. A malformed page, a duplicate slug carrying two ids, or a page
   count or index version that changes part-way publishes nothing. In every
   failure case the previous snapshot stays, and status reports it as `stale`
   with the time of the last good refresh.
6. **Capability indices.** AA's six capability indices are stored and shown on
   Compare for reference. No chain, grade, threshold or router reads them,
   except as an input to the estimates in 7.
7. **Derived estimates** (`services/aa-derive.ts`, added 2026-10-30 at James's
   request). A model can lack a Coding or Agentic value: AA never scored it,
   or it arrived after the indices were retired. Such a model gets an
   estimate with provenance `derived`.
   - **Method:** a least-squares line from one score AA still publishes to the
     archived target, fitted over every model that has both.
   - **Inputs:** intelligence on the pinned version; intelligence on the
     current version, when it differs; each capability index.
   - **Choice of input:** per model, the input with the smallest
     leave-one-out error, so the choice between the intelligence route and
     the capability-index route is measured rather than fixed.
   - **Refusals:** a fit is refused below 20 calibration models, and when it
     does not beat predicting the mean.
   - **Refitting:** it is refitted on every read, so each refresh or version
     switch updates it.
   - **Precedence:** an estimate is the last resort. Measured, archived,
     typed and proxy figures all win, and it stays editable, so typing a
     score replaces it.
   - **Grading:** it counts as an estimate (`judgeMetric`, client
     `isEstimate`), so it meets no chain minimum unless that chain accepts
     estimates. The arranger ignores it for ordering under the same
     condition. The cell shows `derived ±error`, and its tooltip names the
     input, the fit size and the scale, and marks extrapolation.

## Context

Measured on 2026-10-30 with the live key: 8 requests. Six of them counted
against the v2 quota of 100 per day. The two legacy calls returned no quota
headers.

| Fact | Evidence |
| --- | --- |
| Plan is Free, 100 requests per 24 h | `X-AA-Tier: free`, `X-RateLimit-Limit: 100`; `/api/v2/language/models` returned `403 "Language models list requires a Pro subscription"` |
| App was already on `/language/models/free` with nested `performance` | `git log -S` since `69cc7041` (2026-09-11); no caller of `/api/v2/data/llms/models` in any worktree |
| Legacy endpoint sunset | `Sunset: Wed, 04 Nov 2026 23:59:59 GMT` (5 Nov 10:59:59 AEDT), `Deprecation: @1785801600`, `Link: …/data-api/migrate-v2-data` |
| Free catalogue | 718 models, 4 pages of 200, `intelligence_index_version: 5` |
| Intelligence coverage | v5.0: 80 models. Cached v4.3: 698. Chained models: 15 of 56 have a v5.0 score |
| Coding / Agentic | 0 / 0 non-null on v5.0. Cached v4.3: 258 / 167. Documented "always null" on every tier |
| Scale change | For the 71 models scored on both versions, median v5.0/v4.3 = 0.74. Some models rose, some fell |
| Capability indices | 80–101 non-null of 718 |
| Prompt basis | `/free` states none. Its TTFT runs at a median 1.48× the legacy `medium` TTFT for the same models; throughput is equal. So it is not `medium` (inference) |

Replaying the captured v5.0 catalogue against a copy of the live database gave
these results:

- **Old code**: 82 intelligence, 59 coding and 55 agentic scores changed across
  the 84 chained routes. Null intelligence rose from 2 to 61. The arranger's plan
  changed for all six chains.
- **This change**: 0 score values changed and 0 chain plans changed. Provenance
  went from `measured` to `archived`.

## Field map (legacy `data/llms/models` → v2 `language/models/free`, as stored)

| Field | Legacy | v2 Free | Stored as | Status |
| --- | --- | --- | --- | --- |
| Intelligence Index | `evaluations.artificial_analysis_intelligence_index` | same, plus top-level `intelligence_index_version` | `intelligence_index` + `index_version` (`v5.0`) | kept; versioned |
| Coding Index | `evaluations.artificial_analysis_coding_index` | always null | archive only | **lost upstream**; archived v4.3 served |
| Agentic Index | absent in legacy response; v2 Free carried it until v4.3 | always null | archive only | **lost upstream**; archived v4.3 served |
| Per-benchmark (mmlu_pro, gpqa, hle, livecodebench, scicode, aime_25, ifbench, lcr, terminalbench_*, tau2, tau_banking, math_500, aime) | present | absent (Pro only) | not stored (never was) | lost to Free; raw legacy snapshot kept outside the repo |
| Capability indices ×6 | absent | `evaluations.artificial_analysis_*_index` | `finance_index` … `economics_index` | new, reference only |
| Input / output price | `pricing.price_1m_*` (0 where unpriced: 275 models) | same, null where unpriced | `price_1m_input/output` | kept; null ≠ 0 |
| Blended price | `pricing.price_1m_blended_3_to_1` | Pro only | not stored | unused |
| Cache hit / write price | absent | `pricing.price_1m_cache_*` | not stored | unused |
| Index cost per task | absent | `artificial_analysis_intelligence_index_cost.cost_per_task.total_cost` | `index_cost_per_task`, archived per version | kept; read under the scoring version |
| Output speed | top-level `median_output_tokens_per_second` | `performance.median_output_tokens_per_second` | same column | kept |
| TTFT | top-level `median_time_to_first_token_seconds` | `performance.…` | same column | kept |
| Time to first answer | top-level `median_time_to_first_answer_token` | `performance.median_time_to_first_answer_token_seconds` | `median_time_to_first_answer_token_seconds` | renamed, now stored |
| End-to-end time | absent | `performance.median_end_to_end_response_time_seconds` | not stored | unused |
| Prompt basis | `prompt_options.prompt_length` (medium) | none stated (Pro: `prompt_type`, default `long`) | `prompt_type` (NULL for Free) | recorded |
| Tier | none | `tier` + `X-AA-Tier` | `aa_tier` (account) | kept |
| Response shape | n/a | implied by endpoint | `response_shape`, `aa_response_shape` | new; separate from tier |

## Capability indices: where they could help (not wired)

AA builds each index from AA-Briefcase, AA-Omniscience, HLE-Diamond,
AutomationBench-AA, GDP.pdf, MLCR-AA, CritPt and Terminal-Bench 4.0, weighted per
profession
([methodology](https://artificialanalysis.ai/methodology/capability-indices)).
They measure professional knowledge work, not coding or tool reliability in our
sense.

- **Engineering** is the only one with an agentic-coding component (15%,
  Terminal-Bench 4.0 and FrontierCode 2.0). It is not a Coding Index substitute:
  85% of it is domain recall, science and reasoning.
- **Strategy & Ops** and **Finance & Accounting** weight agentic tool use and
  agentic knowledge work at 40–65%. They are the closest published signal to the
  retired Agentic Index, but they are not the same measure.
- No chain today is domain-specific (Default, Coding, Apex, Fast-Lane, Vision,
  Extra-Tier), so none of them has a natural consumer.
- Where they could improve classification: a future domain chain (legal or
  finance drafting) or OMP role, or as a tie-breaker inside Apex. Any of these
  needs operator-chosen thresholds, so none is wired here.

## Consequences

- No ranking changes on deploy or on the first v5.0 sync. Rankings stay on v4.3
  until the operator switches. After a switch, the ~600 models AA has not rescored
  show unknown, not zero, and every chain minimum (set in v4.3 units) needs review.
- Coding and Agentic will only ever be MEASURED for models AA scored before
  2026-10-29. Every other model shows a `derived` estimate where a fit exists,
  and the operator can type a score over it.
- Fit quality on the live copy, 2026-10-30, as leave-one-out error in index
  points:

  | Input | Coding n | Coding error | Agentic n | Agentic error |
  |---|---|---|---|---|
  | Intelligence v4.3 (pinned) | 261 | ±8.0 | 167 | ±5.2 |
  | Intelligence v5.0 (current) | 27 | ±11.1 | 26 | ±9.6 |
  | Strategy & Ops | 46 | ±7.2 | 45 | ±6.0 |
  | Healthcare | 39 | ±6.1 | 39 | ±7.5 |
  | Finance / Legal / Economics | 42 | ±8.8–9.2 | 41 | ±7.9–8.9 |
  | Engineering | 27 | ±10.7 | 26 | ±9.8 |

  These fits produced 242 estimates (127 coding, 115 agentic), 12 of them on
  chained routes. None was extrapolated. All six chain plans were unchanged,
  because no chain accepts estimates. The v5.0-intelligence route is the
  weakest input. It is used only for a model with no other input, which
  means mainly models released after 2026-10-29.
- Every model released from now on is newer than all the calibration models,
  so its estimates are the most likely to be extrapolated. The tooltip flags
  it.
- Token efficiency combines the archived v4.3 cost per task with the current
  prices. If a price has moved since, the estimate is skewed by that ratio.

## Alternatives rejected

- **Follow the current version automatically.** This silently mixes or swaps
  scales under the chain minimums: the old-code replay above.
- **Substitute intelligence or a capability index for Coding/Agentic.** That
  invents a measurement. The derived estimate in 7 is not a substitution: it
  is a fitted value, labelled with its error, ranked below every other
  source, and kept out of chain minimums by default.
- **Pro endpoint.** Coding and Agentic are null on Pro too. It would add
  per-benchmark scores we do not store and switch the performance basis to
  `long`, for 403s on the current key.
- **Scrape AA's pages for retired indices.** The site no longer shows a Coding
  or Agentic Index (checked on `/models/glm-5-3`), and `robots.txt` disallows
  `/_next/data/` and `/api/`.

## Testing seam

- `server/src/__tests__/services/analysis-sync.test.ts`
- `server/src/__tests__/db/aa-score-archive-migration.test.ts`
- `server/src/__tests__/services/aa-derive.test.ts`, and the derived cases in
  `analysis-sync.test.ts` and `chain-arrange.test.ts`
- The existing Compare/Keys tests, which cover the client side.

## Status

Implemented 2026-10-30. Not yet deployed.
