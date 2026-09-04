# GOTCHAS

**Purpose:** Genuinely non-obvious landmines only. Two-minute read maximum.

---

- Quota tests that insert `provider_quota_state` directly must call `invalidateKeyQuotaHeadroom(platform)`. Production writes already invalidate this five-second routing cache through `recordQuotaObservation`.

## 2026-09-04

- A container publishing `0.0.0.0:3001` (Docker Desktop, IPv4) and a dev server binding `*:3001` (node, IPv6) coexist without either failing to start. `curl localhost:3001` reaches the IPv6 listener while Vite's proxy — hardcoded to `http://127.0.0.1:${port}` — reaches the container, so the browser and the terminal talk to different servers. Symptom: `/api/auth/status` returns `needsSetup:true` on curl and `false` in the page. Check `lsof -nP -iTCP -sTCP:LISTEN | grep 3001` for two rows before debugging anything else.
- `client/vite.config.ts` reads the server port with `loadEnv(mode, <repo root>, '')`, so `PORT` in `.env` wins over both `process.env.PORT` and `.env.local`. Passing `PORT=3011` to `npm run dev -w client` silently proxies to whatever `.env` says; the compiled value is readable in the page as `__SERVER_PORT__`. Change `.env`, or run the server on the port `.env` already names.
- A wrong `ENCRYPTION_KEY` does not fail startup — every provider key logs `decrypt-error:1` at route time and requests end `routing exhausted (no upstream tried)`. Stored keys are unharmed; the fix is the right key, not a re-add. Verify with the container's own crypto: `initEncryptionKey(process.env.ENCRYPTION_KEY)` then `decrypt(encrypted_key, iv, auth_tag)` — three positional args, not a record.
- ⚠️ Recipe: `docker compose -p <project>` reattaches to an existing named volume from any directory, so a container whose original compose dir is gone can be rebuilt elsewhere without losing its DB. The project name, not the path, owns `<project>_<volume>`.
- `HOST_BIND` pinned to a single interface (e.g. a tailnet address, for iPad access) refuses loopback: `127.0.0.1:3001` and `localhost:3001` both return nothing, so every local agent configured against `http://localhost:3001/v1` stops routing and analytics flatlines with no error anywhere. Publish both interfaces if local clients still need it.
