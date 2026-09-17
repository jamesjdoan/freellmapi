# Imperium extension branch deployment

The Imperium provider-routing work is maintained as a bolt-on branch. It is not merged into upstream FreeLLMAPI `main`.

## Current installation

| Item | Value |
| --- | --- |
| Upstream remote | `https://github.com/tashfeenahmed/freellmapi.git` (`origin`) |
| Fork remote | `https://github.com/jamesjdoan/freellmapi.git` (`fork`) |
| Upstream base | `v0.9.7` (`1edb8d5`) |
| Extension branch | `docs/freellm-assert-start-on-redeploy` — carries the whole extension, 66 commits on `v0.9.7` |
| Publishable subset | `codex/provider-routing-controls` — an ancestor of the above, still on the `v0.9.4` base |
| Extension worktree | `/Users/jamesdoan/Code/Instrumenta/worktrees/freellmapi-provider-routing` (holds the `codex/…` subset, not the live branch) |
| Compose deployment | `/Users/jamesdoan/Code/Instrumenta/freellmapi` — confirmed from the live container's `com.docker.compose.project.working_dir` label, not from this table |
| Live image | `ghcr.io/tashfeenahmed/freellmapi:latest` (`ba22f5c8`), built locally from the extension checkout and tagged with the upstream name |
| Local Docker image | `jamesjdoan/freellmapi:provider-routing` — built, but not what the running container uses |
| Persistent volume | `freellmapi_freellmapi-data` |
| Compose override | none in the deployment directory; the stock `docker-compose.yml` is used as-is |
| Vestigial clone | `freellmapi/` — an upstream `main` checkout whose directory basename gives it the **same** Compose project name, so `docker compose` run there targets this same container and volume. Its `.env` is a symlink to the deployment `.env` so the two can never hold different keys again. |

The stock `docker-compose.yml`, deployment `.env`, encryption key and named data volume remain unchanged by an image rebuild.

## Safe upstream refresh

1. Fetch `origin --tags`.
2. Rebase the extension branch onto the release **tag**, not `origin/main`: `git rebase --rebase-merges --onto vX.Y.Z <current base>`. This updates the base beneath the extension; it does not merge the extension into upstream. Two reasons for the exact command:
   - `origin/main` runs ahead of the tag with work that is not in any release — the per-language `docs/{en,zh-cn}` move after `v0.9.7` rewrites all 60 locale files and every doc path the extension has edited. The tag has none of that.
   - `--rebase-merges` is required, not cosmetic. The branch carries two reconciliation merges (`Merge branch 'main' into quota-integration`, `Merge quota-integration`) whose resolutions chose one of two diverged quota lineages. A default rebase drops merge commits and replays both lineages flat, silently discarding those choices.
3. Resolve conflicts, then check the one invariant that proves nothing was lost: `git diff <old tip>..<new tip>` must contain only the upstream delta for that release plus whatever you deliberately added. Then run the repository test suite plus production build.
4. Push the rebased branch to `fork` with lease protection only after explicit approval.
5. Build `jamesjdoan/freellmapi:provider-routing` from the extension worktree, passing the new commit SHA as `FREELLMAPI_COMMIT_SHA`.
6. Stop the Compose service and archive the complete named volume while SQLite is quiescent.
7. Recreate the service from the deployment directory with `docker compose up -d --no-build freellmapi`.
8. Confirm the service actually started: `docker compose ps` must read `Up (healthy)` with a published port. Step 7 creating a container is not step 7 starting one — an `up -d` interrupted between create and start, or a bare `docker compose create`, leaves it in `Created`, where it stays down through reboots.
9. Verify container health, the reported extension commit, authenticated `/v1/models`, a real chat completion and the Extensions dashboard panel.
10. Prove the provider keys still decrypt under the key the new container was created with — see below. A container recreate bakes `ENCRYPTION_KEY` in at create time, so a healthy container with a published port can still be unable to read a single stored key.

Do not use the stock dashboard’s `docker compose pull` instruction for this custom image. It updates the upstream image, not the separately built extension.

## Encryption key drift

Provider API keys are AES-256-GCM ciphertext in `api_keys`, keyed solely by `ENCRYPTION_KEY`. Docker fixes a container's environment at **create** time, so the value a running container holds is whichever `.env` the last `docker compose up -d` read — not whatever `.env` says today. On 2026-09-07 a recreate from this directory picked up a different key from the one the stored ciphertext was written under, and all seven keys failed to decrypt for eleven hours. The dashboard stayed `Up (healthy)` on a published port the whole time; the only symptoms were `decrypt-error:1` in the health log, every key stuck at `status='error'`, and `no_providers_configured` on every completion.

Two aggravating details, both fixed but worth knowing:

- The vestigial `freellmapi/` clone carries its own `docker-compose.yml` and, because of its directory name, the same Compose project. `docker compose up -d` run there recreates *this* container against *this* volume using *that* `.env`. Its `.env` is now a symlink, so the values cannot diverge.
- Four providers (nvidia, openrouter, opencode, ollama) return 200 to an unauthenticated probe, so `checkKey` reports them unverifiable and deliberately preserves the previous status (`server/src/services/health.ts:143`). A key marked `error` during a decrypt outage therefore stays `error` after the key is corrected, and routing keeps skipping it. Clear those rows explicitly; a health cycle will not.

Preflight, after any recreate — this decrypts every stored key with the key the container actually holds and prints one line per row:

```sh
docker compose exec -T freellmapi node -e '
const crypto = require("crypto");
const key = Buffer.from(process.env.ENCRYPTION_KEY.trim(), "hex");
const db = require("better-sqlite3")("/app/server/data/freeapi.db", { readonly: true });
let ok = 0, bad = 0;
for (const r of db.prepare("select id, platform, encrypted_key, iv, auth_tag from api_keys").all()) {
  try {
    const d = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(r.iv, "hex"), { authTagLength: 16 });
    d.setAuthTag(Buffer.from(r.auth_tag, "hex"));
    Buffer.concat([d.update(Buffer.from(r.encrypted_key, "hex")), d.final()]);
    ok++;
  } catch { bad++; console.log(r.id, r.platform, "DECRYPT FAILED"); }
}
console.log("ok=" + ok, "fail=" + bad);
'
```

`fail` must be `0`. Anything else means the container holds the wrong key: find the `.env` whose key does decrypt, correct the deployment `.env`, and recreate. Never re-enter the provider keys before checking this — the old ciphertext is recoverable, a re-entry is not.

## Persistence and reboot

The container uses `restart: unless-stopped`, which restarts a container that *was* running when Docker Desktop stopped. It does not start one that has never run: a container in `Created` is not restarted at daemon start, at reboot, or ever, and there is no log line because the entrypoint never executed. Confirm `State.Status` rather than assuming the policy covers it. Provider keys, preferences, scopes, limits, quota history and request history live in the named volume, not in the image, and survive image rebuilds and container recreation.

## Rollback boundary

Keep a timestamped full-volume archive from immediately before every extension upgrade. The schema migration is additive, so the upstream image can ignore the extra key-limit columns, but restoring an older database should still use the matching full-volume backup and encryption key. Never copy only `freeapi.db` while leaving mismatched WAL/SHM sidecars.
