#!/usr/bin/env bash

# Build the current tree into the deployment image and start it, verifying at
# every step that what was asked for actually happened.
#
# Written because the ad-hoc command this replaces reported success on a failed
# deploy. It ended with `docker compose up -d 2>&1 | tail -1 && ...`, so the
# exit status came from `tail` rather than from compose: when `up` could not
# bind port 3001 the chain carried on and printed "deployed <tag>" while the
# container sat in Created. Only a manual `docker ps` caught it.
#
# So: no pipes on anything whose status matters, and the last thing this does
# is ask the running container whether it is actually serving.

set -euo pipefail

project_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
compose_dir="$project_root/freellmapi"
image_repo="jamesjdoan/freellmapi"
live_tag="provider-routing"
container="freellmapi-freellmapi-1"
volume="freellmapi_freellmapi-data"
health_url="http://127.0.0.1:3001/api/health"
# How long to wait for the container to come up. Overridable so the tests can
# exercise the give-up path without sitting through a real 90 seconds.
wait_seconds="${DEPLOY_WAIT_SECONDS:-90}"
poll_seconds="${DEPLOY_POLL_SECONDS:-3}"
skip_backup=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --skip-backup) skip_backup=1; shift ;;
    --help|-h) echo "Usage: $0 [--skip-backup]"; exit 0 ;;
    *) echo "Unknown argument: $1" >&2; exit 1 ;;
  esac
done

fail() { echo "deploy: $*" >&2; exit 1; }
step() { echo "==> $*"; }

[[ -f "$compose_dir/docker-compose.yml" ]] \
  || fail "no docker-compose.yml under $compose_dir"
command -v docker >/dev/null || fail "docker not on PATH"

stamp="$(date +%Y%m%d-%H%M%S)"
build_tag="$image_repo:main-$stamp"
rollback_tag="$image_repo:$live_tag-before-$stamp"

# ── 1. Back up the data volume, and prove the archive reads back ────────────
# The migrations run on first boot, so this is the only irreversible moment.
if [[ "$skip_backup" == "0" ]]; then
  step "backing up $volume"
  backup="$project_root/backups/freellmapi-data-$stamp.tar.gz"
  mkdir -p "$project_root/backups"
  docker run --rm -v "$volume:/data:ro" -v "$project_root/backups:/backup" alpine \
    tar czf "/backup/freellmapi-data-$stamp.tar.gz" -C /data . \
    || fail "volume backup failed"
  # An archive nobody can read is not a backup.
  docker run --rm -v "$project_root/backups:/backup:ro" alpine \
    tar tzf "/backup/freellmapi-data-$stamp.tar.gz" >/dev/null \
    || fail "backup written but unreadable: $backup"
  echo "    $backup"
fi

# ── 2. Build ────────────────────────────────────────────────────────────────
step "building $build_tag"
docker build -q -t "$build_tag" "$project_root" >/dev/null || fail "image build failed"

# ── 3. Keep a rollback point, then promote ──────────────────────────────────
# Tag the image that is live NOW, not the one being replaced by name, so the
# rollback tag points at whatever was actually serving.
if docker image inspect "$image_repo:$live_tag" >/dev/null 2>&1; then
  step "rollback point $rollback_tag"
  docker tag "$image_repo:$live_tag" "$rollback_tag" || fail "could not tag rollback point"
fi
docker tag "$build_tag" "$image_repo:$live_tag" || fail "could not promote $build_tag"

# ── 4. Start it ─────────────────────────────────────────────────────────────
step "recreating $container"
( cd "$compose_dir" && docker compose up -d ) || fail "compose up failed"

# ── 5. Verify. The step the old command skipped ─────────────────────────────
step "waiting for $container to serve"
deadline=$(( SECONDS + wait_seconds ))
state=""
while (( SECONDS < deadline )); do
  state="$(docker inspect "$container" --format '{{.State.Status}}' 2>/dev/null || echo missing)"
  if [[ "$state" == "running" ]]; then
    # 401 is the healthy answer here: the route exists and wants auth. Any
    # connection failure means it is not serving.
    #
    # No `|| echo 000` fallback: curl ALREADY writes 000 through -w when it
    # cannot connect, so appending one produced '000000', which then passed a
    # `!= 000` guard. This script reported a deploy as serving on its own first
    # real run because of it.
    code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 "$health_url" 2>/dev/null || true)"
    [[ -n "$code" && "$code" != "000" ]] && break
  fi
  sleep "$poll_seconds"
done

[[ "$state" == "running" ]] \
  || fail "container is '$state', not running — is something else holding port 3001? (lsof -nP -iTCP:3001 -sTCP:LISTEN)"
[[ -n "${code:-}" && "${code:-000}" != "000" ]] \
  || fail "container is running but $health_url did not answer (curl: ${code:-no output})"

# The image the container is actually on, which is the only claim worth making.
running_image="$(docker inspect "$container" --format '{{.Image}}')"
built_image="$(docker image inspect "$build_tag" --format '{{.Id}}')"
[[ "$running_image" == "$built_image" ]] \
  || fail "container is running $running_image, not the image just built ($built_image)"

echo
echo "deployed $build_tag — $container running, $health_url answering $code"
echo "rollback: docker tag $rollback_tag $image_repo:$live_tag && (cd $compose_dir && docker compose up -d)"
