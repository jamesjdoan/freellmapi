# Handoff Log

**Purpose:** Cross-session and cross-device continuity. read at the start of every session.

## Format

Append-only. Each session adds a `## Session <YYYY-MM-DD> — <device>` block at the top (newest first); never overwrite another session's block. Per-block fields: **What was done**, **What's next**, **In progress** (`—` when nothing is in flight). Consolidation collapses blocks and archives the originals under `## Archived sessions` — never deletes. jd-context defines and maintains this format.

---

## Session 2026-09-04 — Mac Studio
**What was done:** Confirmed the OpenCode Zen catalogue already carries `nemotron-3-ultra-free` (V24) and `mimo-v2.5-free` (V18), and that four newer Zen free models cannot be added from this repo — model data ships via the signed catalogue service, not migrations (`legacy_baseline.ts:36-43`). Fast-forwarded `main` 0→51 commits to v0.9.5 and replayed the uncommitted `auto:<profile>` chain fix in `anthropic.ts` on top of upstream's task-type routing. Merged v0.9.5 into `imperium/eol-reinstatement-base` (`7169b82`), resolving six additive conflicts in `defaults.ts`, `roundtrip.test.ts` and `router.ts`; the other three extension branches now merge into it cleanly. Then built the retirement-reconciliation feature across three commits (`152c4d7`, `105b363`, `67cac72`): a provider's first-hand 410/404 refusal now outranks the catalogue that still lists the model, disagreements are recorded (`relisted_at`/`relist_count`/`acknowledged_at` on `catalog_model_tombstones`, migration `20260904_000001`), surfaced on Models → Chat models until settled, kept decisions stay reviewable and undoable, and a disagreement the catalogue stops making closes itself. Registered as the tenth Imperium extension. Rebuilt the live container from the merged branch, recovering the correct `ENCRYPTION_KEY` from the nested checkout after the first rebuild broke all seven provider keys, and converted the hand-pinned `nvidia/openai/gpt-oss-120b` and `google/gemini-2.5-flash` into real tombstoned retirements (zero hand pins left). Server suite 2946 passed / 252 files; client 297 passed / 29 files.
**What's next:** Decide whether to publish the four missing Zen free models (`muse-spark-1.3-contributor-free`, `muse-spark-1.2-contributor-free`, `nemotron-3.5-lightning-free`, `ling-3.0-flash-fin-free`) to the catalogue service, since Muse Spark 1.3 was the intended primary free worker and cannot land from this repo. Also outstanding: `deepseek-v4-flash-free` is still enabled but absent from Zen's current free table (likely a dead promo, unverified — no Zen key here), and the container is bound to the tailnet only, so local clients on `localhost:3001/v1` cannot route and analytics has been flat since 07:43 — publish both interfaces if that matters.
**In progress:** —

## Session 2026-09-02 — Mac Studio
**What was done:** Implemented Phase 1 unified-model provider preferences, quota-pool-aware routing, legacy quota-record compatibility, provider catalogue model scopes, and per-credential account limits on `codex/provider-routing-controls`. Full repository tests and production build pass.
**What's next:** Review the uncommitted branch diff, then invoke `jd-ship` when ready to commit and open the upstream-friendly change.
**In progress:** —

## Session 2026-09-01 — Mac Studio (2)
**What was done:** Session-continuity scaffold created
**What's next:** Start work
**In progress:** —
