# Imperium extension branch deployment

The Imperium provider-routing work is maintained as a bolt-on branch. It is not merged into upstream FreeLLMAPI `main`.

## Current installation

| Item | Value |
| --- | --- |
| Upstream remote | `https://github.com/tashfeenahmed/freellmapi.git` (`origin`) |
| Fork remote | `https://github.com/jamesjdoan/freellmapi.git` (`fork`) |
| Extension branch | `codex/provider-routing-controls` |
| Extension worktree | `/Users/jamesdoan/Code/Instrumenta/worktrees/freellmapi-provider-routing` |
| Compose deployment | `/Users/jamesdoan/Code/Instrumenta/imperium/freellmapi/freellmapi` |
| Local Docker image | `jamesjdoan/freellmapi:provider-routing` |
| Persistent volume | `freellmapi_freellmapi-data` |
| Compose override | `docker-compose.override.yml` in the deployment directory |

The override selects the local extension image with `pull_policy: never`. The stock `docker-compose.yml`, deployment `.env`, encryption key and named data volume remain unchanged.

## Safe upstream refresh

1. Fetch `origin` in the extension worktree.
2. Rebase `codex/provider-routing-controls` onto the selected upstream `origin/main` revision. This updates the base beneath the extension; it does not merge the extension into upstream.
3. Resolve any conflicts on the extension branch and run the repository test suite plus production build.
4. Push the rebased branch to `fork` with lease protection only after explicit approval.
5. Build `jamesjdoan/freellmapi:provider-routing` from the extension worktree, passing the new commit SHA as `FREELLMAPI_COMMIT_SHA`.
6. Stop the Compose service and archive the complete named volume while SQLite is quiescent.
7. Recreate the service from the deployment directory with `docker compose up -d --no-build freellmapi`.
8. Confirm the service actually started: `docker compose ps` must read `Up (healthy)` with a published port. Step 7 creating a container is not step 7 starting one — an `up -d` interrupted between create and start, or a bare `docker compose create`, leaves it in `Created`, where it stays down through reboots.
9. Verify container health, the reported extension commit, authenticated `/v1/models`, a real chat completion and the Extensions dashboard panel.

Do not use the stock dashboard’s `docker compose pull` instruction for this custom image. It updates the upstream image, not the separately built extension.

## Persistence and reboot

The container uses `restart: unless-stopped`, which restarts a container that *was* running when Docker Desktop stopped. It does not start one that has never run: a container in `Created` is not restarted at daemon start, at reboot, or ever, and there is no log line because the entrypoint never executed. Confirm `State.Status` rather than assuming the policy covers it. Provider keys, preferences, scopes, limits, quota history and request history live in the named volume, not in the image, and survive image rebuilds and container recreation.

## Rollback boundary

Keep a timestamped full-volume archive from immediately before every extension upgrade. The schema migration is additive, so the upstream image can ignore the extra key-limit columns, but restoring an older database should still use the matching full-volume backup and encryption key. Never copy only `freeapi.db` while leaving mismatched WAL/SHM sidecars.
