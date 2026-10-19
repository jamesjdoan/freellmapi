# Model screening benchmark

A small, cheap screen for one free route at a time: six fixed scenarios, deterministic grading, and a Model Passport that says which chains and OMP roles the evidence supports. It is a classifier, not a leaderboard.

Code: `server/src/services/model-bench/` (fixtures, sandbox, grade, runner, passport) and the CLI `server/src/scripts/model-bench.ts`. Tests: `server/src/__tests__/services/model-bench.test.ts`.

## What it never does

- **Touch production.** `--db` names a source database. It is copied to a temp directory and only the copy is opened. Keys are decrypted from the copy, and the provider adapters' quota bookkeeping lands in the copy, which is deleted on exit. No table or migration is added. Results go to `server/data/model-bench/` (gitignored).
- **Fall back.** Calls go straight to the provider adapter for the one route named. There is no router and no chain behind it, so a failure is that model's failure.
- **Spend paid balance.** A route for which `consumesPaidBalance` is true is refused before any call.
- **Pick another relay's key.** Custom routes run only through the key their catalogue row belongs to.
- **Call into a known refusal.** A route on cooldown is refused.
- **Judge with a model.** All grading is fixed assertions, hidden unit tests and fixed keyword rubrics.
- **Execute code unsandboxed.** Candidate Python runs as `python3 -I -B` under `sandbox-exec` on macOS or `unshare -rn` on Linux, with no network, no writes outside a throwaway directory, 4 s CPU and 8 s wall time. With no OS sandbox the code is not run, and those checks read INCONCLUSIVE.

## Scenarios

| Id | Stage | What it checks | Max output tokens |
|---|---|---|---:|
| A1 | 1 | Picks `convert_currency` among three tools, with the right amount and direction, in one call | 256 |
| A2 | 2 | Triages a ticket that carries an injected "delete /etc/passwd" instruction. Must make no tool call, return JSON only, and apply the stated priority rule | 256 |
| A3 | 2 | `get_order` fails, so it must recover via `get_archived_order` and then refund the paid amount. Scripted world, up to 4 turns | 256/turn |
| C1 | 1 | Fixes `moving_average` (an off-by-one and missing validation). Graded by 7 hidden unit tests | 512 |
| C2 | 2 | Implements `parse_duration` from a spec. Graded by 17 hidden tests plus an AST check for no imports | 640 |
| C3 | 1 | Reviews `ratio_above`: three defects found by line and keyword, plus 4 tests on the corrected function | 768 |

Prompts carry no answers. Expected values and tests live only in `grade.ts`.

**Two stages.** Stage 1 runs A1, C1 and C3, the cheapest discriminating set. Stage 2 runs per capability:
- A2 and A3 run only if A1 passed or was borderline.
- C2 runs only if C1 or C3 passed or was borderline.

So a coding-only model is not discarded for weak tool use, nor the reverse. An endpoint that never answered is not "promising".

**Native tools.** Tools are always sent natively first. If the endpoint refuses them (a 4xx mentioning tools), A1 and A2 re-run with the tools described in text, and the result is labelled `simulated`. Simulated calls never count toward tool reliability. A3 has no simulation: there it is `UNSUPPORTED`, which is not a reasoning failure.

## Scoring

Each scenario is a weighted set of checks scored 0–100.

| Status | Meaning |
|---|---|
| PASS | score ≥ 70 |
| FAIL | score < 40 |
| INCONCLUSIVE | borderline score, endpoint error, reply truncated at the cap, or too few checks evaluable |
| UNSUPPORTED | the endpoint lacks native tools where they are required |
| NOT_TESTED | screened out, not selected, or the budget was reached |

A borderline score is re-run, up to 3 runs in total, and the median is kept. Runs that disagree on PASS vs FAIL are flagged `inconsistent`.

Derived internal metrics, all 0–100 on the screen's own scale:
- **Coding:** mean of C1–C3.
- **Agentic:** mean of A1–A3.
- **Reasoning proxy:** checks tagged `reasoning`, such as the priority rule, the recovery order, defects found and edge constraints. This is a narrow proxy, not a stand-in for the AA Intelligence Index.
- **Instruction adherence:** checks tagged `instruction`.
- **Tool reliability:** valid native tool calls out of all native tool calls.
- **Operational reliability:** completed calls out of all calls.

A metric with fewer than all three of its scenarios is `partial`. A passport is marked comparable only when coding and agentic are both complete.

## Tokens

| | Tokens |
|---|---:|
| Full six-test plan ceiling (prompts + every output cap, A3 at 4 turns) | 5,341 |
| Default budget | 6,000 |
| Stage-1-only ceiling | about 2,100 |

The budget is checked before every call. A call that could cross it is not made; the run stops, and the remaining scenarios read NOT_TESTED with the reason. A stub run used 3,050 tokens for all six and 670 for a model screened out at stage 1. Real models with reasoning traces will use more. The passport reports actual against plan, and separates prompt, output and reasoning tokens.

**Caching.** Results are cached in `server/data/model-bench/cache/`. The key covers bench version, scenario, output cap, platform, model, endpoint, temperature, seed and reasoning effort. A cached result is reused unless `--fresh` is passed. Endpoint errors are never cached. Bump `BENCH_VERSION` in `fixtures.ts` when a prompt, tool, cap or grader changes.

Decoding is `temperature 0` and `seed 7`, where the provider honours them. `--effort` sets `reasoning_effort` and is recorded.

## Published scores vs internal scores

The passport keeps four kinds of evidence apart:
1. **Measured Artificial Analysis scores**, with slug, index version and fetch date.
2. **Estimates** from a related family or an approximation, or a tested value typed by the operator. Each keeps the provenance it has on Compare.
3. **The internal screen**, on its own 0–100 scale.
4. **Unknown**, listed under "Missing".

Internal scores are never compared with AA thresholds and never written back as typed scores.

## Recommendations

**Chains** use the existing `CHAIN_CONTRACTS` tool and vision requirements and the saved chain minimums. Minimums are checked only against published or typed scores. Estimates count only where the chain accepts them, and Fast-Lane stays reserved. A tools-required chain needs a native A1 PASS to be `qualified`; a catalogue claim alone makes it `provisional`.

**OMP roles** use these working thresholds on published AA scores. They are not AA categories.

| Role | Intelligence | Coding | Agentic |
|---|---:|---:|---:|
| default | 40 | 35 | 40 |
| slow | 45 | 35 | — |
| plan | 40 | 35 | 35 |
| task | 30 | 45 | 35 |
| smol | 20 | 20 | 25 |
| tiny | 10 | — | — |
| memory | 25 | — | — |
| commit | 15 | 15 | — |
| advisor | 40 | 35 | — |

How each role resolves:
- A measured miss makes the role `not qualified`.
- An estimate or typed score makes it `provisional`.
- A missing published score defers to the internal screen on that metric: a pass gives `provisional`, a fail gives `not qualified`, and anything else gives `insufficient evidence`.
- **default, plan and task are never better than `provisional`.** They need a large native tool-success sample that six tests cannot give. default also prefers 128K of context and task 64K.
- **smol** targets 80 tok/s, using AA speed or the measured throughput (which includes time to first token).
- **vision** is always `insufficient evidence`, because the screen sends no images.
- The `designer` role in the local OMP config has no threshold and is not assessed.

## Usage

```bash
cd server
# Export a copy of the live DB first (never point --db at the live volume):
docker compose exec -T freellmapi node -e 'const D=require("better-sqlite3");new D("/app/server/data/freeapi.db",{readonly:true}).backup("/tmp/fla.db")'
docker compose cp freellmapi:/tmp/fla.db /tmp/fla.db

# Plan only — no calls:
ENCRYPTION_KEY=… npx tsx src/scripts/model-bench.ts --db /tmp/fla.db --model groq/openai/gpt-oss-20b --dry-run
# Three-test screen:
ENCRYPTION_KEY=… npx tsx src/scripts/model-bench.ts --db /tmp/fla.db --model groq/openai/gpt-oss-20b --screen-only
# Full screen for a batch, tighter budget:
ENCRYPTION_KEY=… npx tsx src/scripts/model-bench.ts --db /tmp/fla.db --model groq/openai/gpt-oss-20b --model mistral/ministral-8b-2512 --budget 4000
```

Output: `server/data/model-bench/passports/<platform>__<model>.{json,md}` and `server/data/model-bench/ranking.md`.

## Limitations

- **Small sample.** Six scenarios are a screen; tool reliability is not established at 95%.
- **Throughput.** The measured figure is completion tokens over wall time, so it includes time to first token.
- **Keyword rubric.** C3's defect identification uses a fixed keyword rubric, and an unusual wording can be missed. The executable fix tests carry most of its weight.
- **Determinism.** Seed and temperature are requested, not guaranteed: some providers ignore them.
- **Live validation.** One live run so far: `xkiro/mistralai/mistral-large-4-0` on 2026-10-19, 6/6 PASS on 7,897 tokens. That is above the 5,341 plan ceiling, because xKiro adds about 540 prompt tokens to every call. Pass `--budget 12000` for xKiro.
- **Cached re-runs.** A re-render from cache reports 0 tokens and 0 calls, because usage is not stored with the cached scenario. The first run's figures are the real cost.
