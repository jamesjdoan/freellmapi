Plan: see ADR at docs/adr/ARCH-20260922-clifree-fleet-telemetry.md

Status APPROVED 2026-09-22. O1 (FreeLLM panel) shipped in 8688c534 over SSH delivery;
Tailscale exposure was rejected, so O1 is no longer gated. O3 (CLI surface) is unblocked.

Uncommitted as of 2026-09-23: migration 20260922_000003_clifree_fleet_usage, guarded
000002 ALTER, quota sections moved into the Keys page. Passes the image-build gate;
awaiting approval to commit and deploy via scripts/deploy.sh.
