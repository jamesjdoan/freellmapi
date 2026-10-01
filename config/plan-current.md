Plan: see ADR at docs/adr/ARCH-20260930-catalogue-panel-unread-worklist.md

Status APPROVED 2026-09-30 — Pass 1 complete. Supersedes the clifree-fleet-telemetry
plan, whose uncommitted work shipped in ac7daf70 on 2026-09-29. The catalogue panel
becomes an unread worklist: a permanent bulk mark-off in a new `catalogue_ack` table
(keyed `(kind, platform, model_id)`, no history), a collapsed-when-quiet default, and
a 10-row recent head on expansion.
