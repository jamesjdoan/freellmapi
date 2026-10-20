# ARCH-20261020-task-efficiency-column

## Decision

Add **token efficiency** as a base stat of the model, alongside intelligence, coding, agentic and speed. It describes the model, not any route or provider: how many tokens the model spends to finish a task. It is shown wherever those analysis numbers appear today (Compare, Keys → provider model table, and the benchmark passport), with the same source marking the scores use.

Routing, quotas and per-provider "tasks per day" are out of scope. Choosing by efficiency or cost is done by reading and sorting this stat.

## Context

Models differ a lot in how many tokens they spend on the same work. The screening benchmark measured this on 2026-10-19/20 (total tokens ÷ scenarios completed):

| Model | Tokens per task |
|---|---:|
| Qwen3-32B (reasoning off) | ~600 |
| Mistral Large 4 | ~1,320 |
| MiniMax M3.1 Flash (low effort) | ~1,380 |

## Sources

Same ladder as scores. Every value carries its source, and two sources are never mixed in one number.

1. **AA estimate (published models).** AA's API gives the cost per Intelligence Index task (`aa_model.index_cost_per_task`, already synced) and the model's input and output prices. It gives no token counts and no input/output cost split (checked on the live payload 2026-10-20: `cost_per_task` carries only `total_cost`).
   - Estimate: tokens per task ≈ cost per task ÷ blended price (3 input : 1 output). Mistral Large 4: $1.1341 ÷ $2.07/M ≈ 549K tokens per AA task. The all-input and all-output bounds are 834K and 271K.
   - Shown as a token range, all-output price (fewest) to all-input price (most), per James 2026-10-20. It was first a rank, which he rejected the same day for a token figure. The column sorts on the 3:1 blend, which is shown in the tooltip.
   - It needs a price, so a model with no AA cost or a $0 blended price gets none and falls through to source 2.
2. **Screen (unpublished models).** The screening benchmark's measured tokens per completed scenario, on our small task scale. It is shown as a number with a "screen" mark, and never sorted together with source 1.
3. **Unknown.** "—", never guessed.

## Storage

- **Source 1:** no new storage. It is computed at read time from `aa_model`, like the scores.
- **Source 2:** a `model_bench_result` table keyed by route (platform, model id), filled only by an explicit import (`POST /api/analysis/bench-results` with a passport JSON). A logical model shows the result of any of its routes. Re-importing a route replaces its row. The benchmark itself still never writes to the live database.

## Questions for James

- **Q1.** Answered (James, 2026-10-20): yes, benchmark results are importable into the live database by an explicit per-model import.
- **Q2.** Answered (James, 2026-10-20): yes, show the AA estimate, as a token range.
- **Q3.** Answered (James, 2026-10-20): everywhere the model's analysis numbers show.

## Consequences

- **Makes easier:** choosing between models of similar quality by how far a token-limited allowance stretches, and spotting a verbose model before it burns one.
- **Makes harder:** a sixth stat to keep fresh. The AA estimate moves with AA's price data, and screen values age with the bench version.
- **Risk:** the AA estimate assumes a 3:1 token mix, and the screen is six small, coding-heavy tasks. Both are labelled as estimates.

## Testing seam

- Server: estimate maths (no price → null, $0 → null, range bounds), and the import (valid passport, re-import replaces, unknown route refused, malformed refused).
- Client: render and sort for the three sources on Compare, and presence on Keys → provider model table.

## Status

APPROVED 2026-10-20. James answered Q1–Q3. The approval doesn't cover commit, push or deploy.
