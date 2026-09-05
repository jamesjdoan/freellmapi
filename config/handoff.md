# Session Handoff

## Latest session — 2026-09-05 (MacBook Pro M2 Max)

**Branch:** main
**Repo:** freellmapi
**Work:** Quota ledger + quota-aware router, Pass 1 through W3

### Decision record

`docs/adr/ARCH-20260905-quota-ledger-and-quota-aware-router.md` — APPROVED.
`config/plan-current.md` points at it.

**Revision 2 supersedes revision 1.** An outside review (Codex `gpt-5.6-sol`, spec at
`codex/tasks/quota-ledger-adr-review.md`) returned NO and corrected five of seven findings.
Every correction was re-verified against source before being accepted. One of them — F4,
"zero 429s in the request log" — was my own measurement error: the query's `%` wildcards were
percent-decoded by the tooling before SQLite saw them. The real count is 38.

**The motivation changed as a result.** Not "recurring free quota is being wasted" — at 375
requests/day peak, idle Groq capacity was unavoidable, not waste. The measured harm is
scarce-provider exhaustion: 35 rate-limited Google attempts, **10 of which ended in a request
that failed for the user**, while Groq and NVIDIA sat idle. That argues for a scarcity term,
not a pacing engine.

### Landed (11 commits, suite green: 253 files / 2975 tests)

| Wedge | State | What |
|---|---|---|
| W0 | 3 of 5 | Pool-key/scope decoupling; raw header capture + `status_code`; failed-attempt metering |
| W1 | ✅ | Provider-wide autoroute exclusion (Hugging Face, SambaNova off by default) |
| W2 | ✅ | Timezone-safe reset clock; `quota_policy` table, resolver, `/api/quota` |
| W3 | ✅ | Shadow decision ledger + `quota_routing_mode` (defaults to `shadow`) |

New files: `services/quota-clock.ts`, `services/quota-policy.ts`, `services/quota-routing.ts`,
`routes/quota.ts`, migrations `20260905_000001_quota_policy`, `20260905_000002_routing_decision`.

### Open, and why

- **F3 duration parsing** and **F8 subject identity** are both blocked on the same trigger:
  one live Groq call. `parseResetAtFromHeader` accepts numerics only, so Groq's documented
  `2m59.56s` form was dropped with no record it ever arrived — raw capture now retains it, but
  only from the next request forward. The 4,469 historical observations stay NULL.
  Check: `sqlite3 server/data/freeapi.db "SELECT quota_pool_key, limit_value, raw_json FROM
  provider_quota_observations WHERE source='header' ORDER BY created_at DESC LIMIT 5"`.
  Differing `limit_value` per Groq model settles F8; the `raw_json` reset string settles F3.
- **F8 is probably not a migration.** The primary key already contains `quota_pool_key`, so a
  per-model Groq pool key separates the rows with no schema change. Hazard either way:
  `services/health.ts:100,183` pass `modelId: null`, which would split-brain against request
  traffic. See the 2026-09-05 amendment in the ADR.
- **Hard-gate consolidation moved out of W2** to the W3→W4 boundary. Switching
  `canMakeRequest` from rolling-24h to policy windows changes what gets rejected, live, on
  every model; running the one irreversible enforcement change before the observation layer
  inverts the point of shadow.
- **F9 attempt metering** counts requests only, never tokens — on a failure we do not know
  what the provider billed.

### Notes for next session

- `server/data/freeapi.db` is **empty** (0 keys, 0 requests). All evidence in the ADR came from
  `backups/freellmapi-data-20260902-131315.tar.gz`. The live-capture trigger is the real
  deployment, not this checkout.
- The DB path env var is **`FREEAPI_DB_PATH`**, not `DATA_DIR` — `DATA_DIR` does not exist and
  is silently ignored, so a smoke test pointed at it writes to the live
  `server/data/freeapi.db`. An earlier one did exactly that; the test data was cleaned out and
  the new tables legitimately remain.
- `package-lock.json` was already modified before this session; left alone.
- Untracked and deliberately not committed: `.compressa/`, `backups/`, `config/`, `freellmapi/`.

### What's next

1. **W4** — bounded canary, then active mode and the dashboard. Shadow must produce data first,
   which needs live traffic.
2. Remaining W0 items once a live capture lands.
