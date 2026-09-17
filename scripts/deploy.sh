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
#
# Two later corrections, both found by reading this script against a live
# install rather than by it failing:
#
#   * It hardcoded `compose_dir="$project_root/freellmapi"`. On this machine
#     that path holds a NESTED CLONE with its own docker-compose.yml, so the
#     existence check passed and the script would have deployed a different
#     compose project — potentially against a different data volume — while
#     reporting success. The live project is now resolved from the running
#     container's own compose labels, which is the only authority on what is
#     actually deployed.
#   * It archived the data volume while the service was still writing to it.
#     SQLite with WAL can be mid-checkpoint, so the tar could capture a
#     torn database and a stale -wal in the same archive. The backup is the
#     one thing that has to be right when a migration goes wrong, and this
#     release rewrites rows on first boot, so the service is stopped first
#     and the stop is verified before anything is read.

set -euo pipefail

project_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
image_repo="jamesjdoan/freellmapi"
live_tag="provider-routing"
container="${DEPLOY_CONTAINER:-freellmapi-freellmapi-1}"
health_url="${DEPLOY_HEALTH_URL:-http://127.0.0.1:3001/api/health}"
# How long to wait for the container to come up. Overridable so the tests can
# exercise the give-up path without sitting through a real 90 seconds.
wait_seconds="${DEPLOY_WAIT_SECONDS:-90}"
poll_seconds="${DEPLOY_POLL_SECONDS:-3}"
stop_seconds="${DEPLOY_STOP_SECONDS:-30}"
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

command -v docker >/dev/null || fail "docker not on PATH"

# Skipping the backup is for the tests and for a code-only redeploy. A schema
# change makes it the difference between a bad deploy and lost data, so it
# needs a second, explicit acknowledgement rather than one flag.
if [[ "$skip_backup" == "1" && "${DEPLOY_I_ACCEPT_NO_BACKUP:-}" != "1" ]]; then
  fail "--skip-backup also needs DEPLOY_I_ACCEPT_NO_BACKUP=1; migrations run on first boot and are forward-only"
fi

# ── 0. Resolve what is actually deployed, from the container itself ──────────
label() { docker inspect "$container" --format "{{index .Config.Labels \"$1\"}}" 2>/dev/null || true; }

compose_file="$(label com.docker.compose.project.config_files)"
compose_workdir="$(label com.docker.compose.project.working_dir)"
compose_project="$(label com.docker.compose.project)"
compose_service="$(label com.docker.compose.service)"
# The volume the container really mounts, rather than a name assumed from the
# project. A deploy that backs up the wrong volume is not backed up.
# The image NAME compose selects, which is not necessarily ours: this install's
# compose file says `image: ghcr.io/tashfeenahmed/freellmapi:latest`. Tagging
# only jamesjdoan/freellmapi:provider-routing would leave `up --no-build`
# reusing the OLD image -- the build would succeed and change nothing.
compose_image="$(docker inspect "$container" --format '{{.Config.Image}}' 2>/dev/null || true)"
volume="$(docker inspect "$container" \
  --format '{{range .Mounts}}{{if eq .Destination "/app/server/data"}}{{.Name}}{{end}}{{end}}' 2>/dev/null || true)"

if [[ -z "$compose_file" || -z "$compose_workdir" ]]; then
  # First deploy, or the container is gone: fall back to this repository, and
  # say so, because the fallback is a guess where the labels were evidence.
  compose_workdir="$project_root"
  compose_file="$project_root/docker-compose.yml"
  compose_project="${compose_project:-freellmapi}"
  compose_service="${compose_service:-freellmapi}"
  volume="${volume:-freellmapi_freellmapi-data}"
  compose_image="${compose_image:-$(grep -m1 -E '^\s*image:' "$project_root/docker-compose.yml" | sed 's/.*image:[[:space:]]*//')}"
  step "no live container to read; falling back to $compose_file"
else
  step "deploying into project '$compose_project' from $compose_file"
fi

[[ -f "$compose_file" ]] || fail "compose file $compose_file does not exist"
[[ -n "$volume" ]] || fail "could not determine the data volume for $container"
[[ -n "$compose_image" ]] || fail "could not determine which image tag compose selects"

compose() { docker compose --project-directory "$compose_workdir" -f "$compose_file" -p "$compose_project" "$@"; }

stamp="$(date +%Y%m%d-%H%M%S)"
build_tag="$image_repo:main-$stamp"
rollback_tag="$image_repo:$live_tag-before-$stamp"

# ── 1. Build first, so the service is only down for the swap ────────────────
step "building $build_tag"
docker build -q -t "$build_tag" "$project_root" >/dev/null || fail "image build failed"

# ── 2. Keep a rollback point ────────────────────────────────────────────────
# Tag the image that is live NOW, not the one being replaced by name, so the
# rollback tag points at whatever was actually serving.
# By image ID, not by tag: the tag is about to be reassigned, and the thing
# worth being able to return to is whatever is serving right now.
live_image_id="$(docker inspect "$container" --format '{{.Image}}' 2>/dev/null || true)"
if [[ -n "$live_image_id" ]]; then
  docker tag "$live_image_id" "$rollback_tag" || fail "could not tag rollback point"
  step "rollback point $rollback_tag -> $live_image_id"
elif docker image inspect "$image_repo:$live_tag" >/dev/null 2>&1; then
  docker tag "$image_repo:$live_tag" "$rollback_tag" || fail "could not tag rollback point"
  step "rollback point $rollback_tag"
fi

# ── 3. Stop, THEN back up ───────────────────────────────────────────────────
# Order matters and it is the whole point of this section: a tar taken while
# SQLite is writing can capture a torn page and a mismatched -wal.
if [[ "$skip_backup" == "0" ]]; then
  step "stopping $compose_service so the volume is quiescent"
  compose stop -t "$stop_seconds" "$compose_service" || fail "could not stop $compose_service"

  state="$(docker inspect "$container" --format '{{.State.Status}}' 2>/dev/null || echo missing)"
  [[ "$state" != "running" ]] \
    || fail "$container is still running after stop; refusing to archive a live database"

  step "backing up $volume"
  backup="$project_root/backups/freellmapi-data-$stamp.tar.gz"
  mkdir -p "$project_root/backups"
  # The WHOLE volume, including the -wal and -shm sidecars: a .db without its
  # -wal is a database missing its most recent commits.
  docker run --rm -v "$volume:/data:ro" -v "$project_root/backups:/backup" alpine \
    tar czf "/backup/freellmapi-data-$stamp.tar.gz" -C /data . \
    || fail "volume backup failed"
  # An archive nobody can read is not a backup.
  docker run --rm -v "$project_root/backups:/backup:ro" alpine \
    tar tzf "/backup/freellmapi-data-$stamp.tar.gz" >/dev/null \
    || fail "backup written but unreadable: $backup"
  # And one that does not contain the database is not a backup either.
  docker run --rm -v "$project_root/backups:/backup:ro" alpine \
    tar tzf "/backup/freellmapi-data-$stamp.tar.gz" 2>/dev/null | grep -q 'freeapi.db' \
    || fail "backup contains no freeapi.db: $backup"
  echo "    $backup"
fi

# Both names: the one compose will actually run, and ours for provenance.
docker tag "$build_tag" "$compose_image" || fail "could not promote $build_tag to $compose_image"
docker tag "$build_tag" "$image_repo:$live_tag" || fail "could not promote $build_tag"

# ── 4. Start it ─────────────────────────────────────────────────────────────
step "recreating $container"
# `up -d` removes the old container and immediately rebinds the host port, and
# Docker does not always release it in time: seen twice, failing with
# "ports are not available ... address already in use" while the port was free
# a second later. Retried a few times, so the transient race resolves itself
# while a genuine conflict - something else actually listening - still fails.
compose_attempts="${DEPLOY_COMPOSE_ATTEMPTS:-4}"
compose_ok=0
for attempt in $(seq 1 "$compose_attempts"); do
  if compose up -d --no-build --force-recreate "$compose_service"; then compose_ok=1; break; fi
  if (( attempt < compose_attempts )); then
    echo "    compose up failed (attempt $attempt/$compose_attempts), retrying"
    sleep "${DEPLOY_COMPOSE_BACKOFF:-4}"
  fi
done
if (( compose_ok == 0 )); then
  # Name what is holding the port. "compose up failed" sends you looking at
  # compose; the holder is the answer.
  holder="$(lsof -nP -iTCP:3001 -sTCP:LISTEN 2>/dev/null | tail -1 || true)"
  fail "compose up failed after $compose_attempts attempts${holder:+ — port 3001 held by: $holder}"
fi

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
    # Docker's healthcheck reports 'starting' for its first interval, so the
    # loop must WAIT for it rather than break on the HTTP answer and then
    # assert it: the first fixed deploy failed on exactly that, a few seconds
    # before the container reported healthy.
    health="$(docker inspect "$container" --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' 2>/dev/null || echo none)"
    if [[ -n "$code" && "$code" != "000" && ( "$health" == "healthy" || "$health" == "none" ) ]]; then break; fi
  fi
  sleep "$poll_seconds"
done

[[ "$state" == "running" ]] \
  || fail "container is '$state', not running — is something else holding port 3001? (lsof -nP -iTCP:3001 -sTCP:LISTEN)"
[[ -n "${code:-}" && "${code:-000}" != "000" ]] \
  || fail "container is running but $health_url did not answer (curl: ${code:-no output})"
# A 5xx is the container answering that it is broken. The old check accepted
# any code that was not 000, so a server failing every request read as served.
[[ "${code}" != 5* ]] \
  || fail "$health_url answered $code — the container is up but failing"

# Docker's own healthcheck, where the compose file defines one. AGENTS.md is
# explicit that a container left in Created stays down through reboots, so
# "running" alone is not the bar.
health="$(docker inspect "$container" --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' 2>/dev/null || echo none)"
[[ "$health" == "healthy" || "$health" == "none" ]] \
  || fail "container health is '$health' after ${wait_seconds}s, not healthy"

# A published port, because a container serving only on its internal network is
# not reachable by the harness roles pointed at it.
ports="$(docker inspect "$container" --format '{{range $p, $conf := .NetworkSettings.Ports}}{{$p}}={{len $conf}} {{end}}' 2>/dev/null || true)"
[[ "$ports" == *"=0"* ]] && fail "container has an unpublished port ($ports)"

# The volume it came back on must be the one that was backed up, or the
# migrations just ran against something else.
remounted="$(docker inspect "$container" \
  --format '{{range .Mounts}}{{if eq .Destination "/app/server/data"}}{{.Name}}{{end}}{{end}}' 2>/dev/null || true)"
[[ "$remounted" == "$volume" ]] \
  || fail "container remounted '$remounted', not the backed-up volume '$volume'"

# The image the container is actually on, which is the only claim worth making.
running_image="$(docker inspect "$container" --format '{{.Image}}')"
built_image="$(docker image inspect "$build_tag" --format '{{.Id}}')"
[[ "$running_image" == "$built_image" ]] \
  || fail "container is running $running_image, not the image just built ($built_image)"

echo
echo "deployed $build_tag — $container $state/$health on $volume, $health_url answering $code"
echo "rollback: docker tag $rollback_tag $compose_image && docker compose --project-directory $compose_workdir -f $compose_file -p $compose_project up -d --no-build --force-recreate $compose_service"
