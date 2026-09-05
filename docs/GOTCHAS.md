# GOTCHAS

**Purpose:** Genuinely non-obvious landmines only. Two-minute read maximum.

---

- Quota tests that insert `provider_quota_state` directly must call `invalidateKeyQuotaHeadroom(platform)`. Production writes already invalidate this five-second routing cache through `recordQuotaObservation`.
