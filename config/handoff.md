# Handoff Log

**Purpose:** Cross-session and cross-device continuity. read at the start of every session.

## Format

Append-only. Each session adds a `## Session <YYYY-MM-DD> — <device>` block at the top (newest first); never overwrite another session's block. Per-block fields: **What was done**, **What's next**, **In progress** (`—` when nothing is in flight). Consolidation collapses blocks and archives the originals under `## Archived sessions` — never deletes. jd-context defines and maintains this format.

---

## Session 2026-09-02 — Mac Studio
**What was done:** Implemented Phase 1 unified-model provider preferences, quota-pool-aware routing, legacy quota-record compatibility, provider catalogue model scopes, and per-credential account limits on `codex/provider-routing-controls`. Full repository tests and production build pass.
**What's next:** Review the uncommitted branch diff, then invoke `jd-ship` when ready to commit and open the upstream-friendly change.
**In progress:** —

## Session 2026-09-01 — Mac Studio (2)
**What was done:** Session-continuity scaffold created
**What's next:** Start work
**In progress:** —
