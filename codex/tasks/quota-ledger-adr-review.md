# Spike: independent reassessment of the quota-ledger ADR

## Type
`spike` — findings only. **Make no code changes. Write no files. Output your findings to stdout.**

## Hard core
The output of this task is a **judgment that will be acted on**, not code that a test can
catch. A confident wrong YES propagates straight into an implementation plan with nothing to
stop it. **A wrong YES is worse than a NO.** Every factual claim you make MUST carry a
`path:line` citation you actually read. If you cannot verify something, say "unverified" and
say what you would need. Do not soften a disagreement to be agreeable — you are here as an
outside voice precisely to disagree where disagreement is warranted.

## Context
Repo: FreeLLMAPI, a self-hosted gateway that routes LLM requests across ~40 free-tier
providers. Monorepo: `server/` (Node + TypeScript + SQLite via `node:sqlite`), `client/`
(React + Vite + react-query + Recharts), `shared/types.ts`.

The operator asked for a "quota ledger + quota-aware router": accurate per-provider metering,
timezone-correct quota reset clocks, pacing/projection so recurring free quota is not wasted
before it resets, and provider selection between providers serving the same logical model —
delivered in phases, shadow mode before active, with existing routing kept as fallback.

Another agent (Claude Opus) audited the repo and wrote a Pass-1 architecture decision record:

    docs/adr/ARCH-20260905-quota-ledger-and-quota-aware-router.md

**Read that ADR first.** It contains findings F1–F7 with citations, a table of what already
exists, and a proposed split of the operator's requested 8 phases into two wedges (W1, W2).

### Evidence base the ADR used
- The working-tree database `server/data/freeapi.db` is **empty** (0 requests, 0 api_keys).
- Real usage history came from a backup, already extracted for you at **`/tmp/qa/freeapi.db`**
  (772 requests, 2026-08-27 → 2026-09-02). Query it read-only if you want to check the ADR's
  numbers — `sqlite3 /tmp/qa/freeapi.db` — and you are encouraged to.

### Primary source files
- `server/src/services/provider-quota.ts` — observations, source/confidence, header specs, pool keys
- `server/src/services/quota-forecast.ts` — existing remaining/reset forecast
- `server/src/services/ratelimit.ts` — RPM/RPD/TPM/TPD windows, leases, provider caps
- `server/src/services/router.ts` — `routeRequest`, `scoreChainEntry`, `resolveModelGroupCandidates`
- `server/src/services/scoring.ts` — the scoring axes and guardrail multipliers
- `server/src/db/migrations/20260101_000000_legacy_baseline.ts` — baseline schema
- `shared/types.ts` — `QuotaMetric`, `QuotaResetStrategy`, `QuotaObservationSource`
- `docs/architecture/01-routing-and-bandit-scoring.md`, `02-quota-and-cooldown-engine.md`

## The question
**What is the best path forward, and where is the ADR wrong?**

## Criteria — answer each of these six explicitly
1. **Factual accuracy.** Verify findings F1–F7 against the source. Name every claim that is
   wrong, overstated, or unverifiable, with the citation that contradicts it. This is the most
   valuable thing you can produce — the ADR's whole argument rests on these seven claims.
2. **The wedge split.** The ADR splits the operator's phases A–H into W1 (a persistent
   per-platform `autoroute` flag, fixing a measured defect) and W2 (reset clock + policy table
   + pacing + shadow decision ledger). Is that the right decomposition and sequencing? If not,
   propose a better one and say why.
3. **Deferring dashboard / API / active mode.** The ADR defers all three until shadow-mode data
   justifies them. Is that correct engineering, or does it withhold something the operator
   materially needs sooner?
4. **Viability given missing provider data.** The ADR's F3 claims only 4 platforms have
   response-header specs, that NVIDIA/Google/Ollama/OpenCode report nothing usable, and that
   even Groq — the one high-confidence source — returns `reset_at = NULL` on every row. If that
   holds, the pacing metric (`pace_delta = usage_percent − period_elapsed_percent`) mostly runs
   on operator-typed limits. **Is a pacing-driven router worth building on that basis?** Is
   there a better information strategy the ADR missed (e.g. deriving reset time from observed
   remaining-counter rollover, provider usage APIs, or something else)?
5. **Integration risk.** The ADR flags that two reset clocks will coexist during W2 — the
   hardcoded `msSinceUtcMidnight` still governing hard RPD/TPD gates while policy windows
   govern scoring. Is that acceptable for a shadow phase, or a double-counting bug waiting to
   happen? Name any other integration hazard the ADR missed.
6. **The biggest thing the ADR got wrong or missed.** One item. Your judgment.

## What "done" looks like
A findings report, to stdout, structured under the six criteria above, that:
- names at least one thing the ADR got wrong or cannot support (if you genuinely find none,
  say so explicitly and state what you checked to conclude that);
- ends with a single recommended path forward, in order, with the reasoning compressed to a
  few lines;
- carries `path:line` citations on every factual claim.

Do not write code. Do not create or modify any file. Do not commit.
