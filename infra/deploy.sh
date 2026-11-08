#!/usr/bin/env bash
# deploy.sh <git-sha> — the one deploy command (OPERATIONS §9.3 rules 1–2, 6).
#
# Shipped inside the image it deploys (/app/stack/deploy.sh) and started by the host
# trampoline `/usr/local/sbin/fw-deploy <sha>` as root, so the script that runs is always
# the one that shipped with the code it deploys, and a rollback runs the old script
# against the old stack. Rollback is the same command with the previous sha.
#
#   1. pull the image `$FIRE_WATCH_REGISTRY:<sha>` unless it is already local (a
#      rollback or a recovering box never needs the registry for a known sha);
#   2. unpack that image's /app/stack into $COMPOSE_DIR and write $COMPOSE_DIR/.env;
#   3. start postgres and run the `migrate` one-shot (advisory lock, forward-only);
#   4. restart `worker`, then `api` (the per-loop locks make the worker overlap safe),
#      then bring the rest of the stack to the new definition;
#   5. smoke-test in a loop: the deploy-smoke CLI inside the worker (healthz, readyz,
#      freshness, worker meta) and /healthz through the proxy;
#   6. pass: write `last_good`, write the deploy textfile metric, ping the deploy
#      heartbeat. Fail: redeploy the sha in `last_good` and exit non-zero either way.
#
# Exit codes: 0 deployed; 1 failed (rolled back when possible); 2 usage.
set -euo pipefail

readonly COMPOSE_DIR="${FIRE_WATCH_COMPOSE_DIR:-/srv/fire-watch}"
readonly REGISTRY="${FIRE_WATCH_REGISTRY:-ghcr.io/ivanbbaev/fire-watch}"
readonly DEPLOY_ENV_FILE="${FIRE_WATCH_DEPLOY_ENV_FILE:-/etc/fire-watch/deploy.env}"
readonly SECRETS_ENV_FILE="${FIRE_WATCH_SECRETS_ENV_FILE:-/etc/fire-watch/secrets.env}"
readonly METRICS_DIR="${FIRE_WATCH_DEPLOY_METRICS_DIR:-/var/lib/fire-watch/metrics}"
readonly SMOKE_DEADLINE_S="${FIRE_WATCH_DEPLOY_SMOKE_DEADLINE_S:-180}"
readonly ROLLBACK="${FW_DEPLOY_ROLLBACK:-0}"

log() { printf '%s deploy: %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*" >&2; }

sha="${1:-}"
if [[ ! "$sha" =~ ^[0-9a-f]{40}$ ]]; then
  echo "usage: deploy.sh <40-hex git sha>" >&2
  exit 2
fi
readonly sha
readonly image="${REGISTRY}:${sha}"

# Non-secret host settings: PG_IMAGE (an arm64 rehearsal overrides the amd64 default),
# GRAFANA_CLOUD_PROM_URL/USERNAME, FIRE_WATCH_ENVIRONMENT.
if [[ -r "$DEPLOY_ENV_FILE" ]]; then
  set -a
  # shellcheck disable=SC1090
  . "$DEPLOY_ENV_FILE"
  set +a
fi

compose() { docker compose --project-directory "$COMPOSE_DIR" "$@"; }

rollback() {
  local reason="$1" previous
  previous="$(tr -d '[:space:]' <"$COMPOSE_DIR/last_good" 2>/dev/null || true)"
  if [[ "$ROLLBACK" == "1" ]]; then
    log "rollback to ${sha} failed too (${reason}); the stack needs a human"
    exit 1
  fi
  if [[ ! "$previous" =~ ^[0-9a-f]{40}$ || "$previous" == "$sha" ]]; then
    log "${reason}; no other last_good to return to — leaving the stack as it is"
    exit 1
  fi
  log "${reason}; rolling back to last_good ${previous}"
  local script
  script="$(mktemp)"
  # The previous release's own deploy.sh, against its own stack definition.
  extract_stack_file "${REGISTRY}:${previous}" deploy.sh "$script"
  FW_DEPLOY_ROLLBACK=1 bash "$script" "$previous" || true
  rm -f "$script"
  exit 1
}

# Copy one file out of an image's /app/stack without running the image.
extract_stack_file() {
  local ref="$1" name="$2" dest="$3" cid
  cid="$(docker create "$ref")"
  docker cp "${cid}:/app/stack/${name}" "$dest"
  docker rm "$cid" >/dev/null
}

ensure_image() {
  if docker image inspect "$image" >/dev/null 2>&1; then
    log "image ${image} present locally"
  else
    log "pulling ${image}"
    docker pull --quiet "$image" >/dev/null
  fi
}

install_stack() {
  local staging cid
  staging="$(mktemp -d)"
  cid="$(docker create "$image")"
  docker cp "${cid}:/app/stack/." "$staging"
  docker rm "$cid" >/dev/null
  install -m 0644 "$staging/compose.yaml" "$COMPOSE_DIR/compose.yaml"
  install -m 0755 "$staging/deploy.sh" "$COMPOSE_DIR/deploy.sh"
  install -d -m 0755 "$COMPOSE_DIR/proxy" "$COMPOSE_DIR/metrics"
  install -m 0644 "$staging/proxy/nginx.conf" "$COMPOSE_DIR/proxy/nginx.conf"
  install -m 0644 "$staging/metrics/config.alloy" "$COMPOSE_DIR/metrics/config.alloy"
  rm -rf "$staging"

  # Interpolation values only — nothing here is a secret. Written atomically so a crash
  # mid-write never leaves systemd's `compose up` with half a file.
  local env_tmp="$COMPOSE_DIR/.env.tmp"
  {
    echo "FIRE_WATCH_IMAGE=${image}"
    [[ -n "${PG_IMAGE:-}" ]] && echo "PG_IMAGE=${PG_IMAGE}"
    echo "GRAFANA_CLOUD_PROM_URL=${GRAFANA_CLOUD_PROM_URL:-}"
    echo "GRAFANA_CLOUD_PROM_USERNAME=${GRAFANA_CLOUD_PROM_USERNAME:-}"
    echo "FIRE_WATCH_ENVIRONMENT=${FIRE_WATCH_ENVIRONMENT:-production}"
  } >"$env_tmp"
  chmod 0644 "$env_tmp"
  mv -f "$env_tmp" "$COMPOSE_DIR/.env"
  install -d -m 0755 "$METRICS_DIR"
}

smoke() {
  local deadline=$((SECONDS + SMOKE_DEADLINE_S))
  # The CLI has its own retry loop with a deadline; the outer loop covers the window in
  # which the worker container itself is still starting and `exec` cannot reach it.
  # `timeout` bounds each attempt: the deadline is only checked between attempts, and on
  # a starved host one `exec` was seen to take two minutes (infra/rehearsal/).
  until timeout --kill-after=10 150 \
    docker compose --project-directory "$COMPOSE_DIR" exec -T worker node dist/app/deploy-smoke-cli.js; do
    if ((SECONDS >= deadline)); then return 1; fi
    sleep 5
  done
  until curl -fsk --max-time 5 -o /dev/null https://127.0.0.1/healthz; do
    if ((SECONDS >= deadline)); then
      log "proxy /healthz did not answer"
      return 1
    fi
    sleep 3
  done
}

record_success() {
  printf '%s\n' "$sha" >"$COMPOSE_DIR/last_good.tmp"
  mv -f "$COMPOSE_DIR/last_good.tmp" "$COMPOSE_DIR/last_good"

  # The metrics-timeline annotation (§9.3 rule 6): Alloy's textfile collector ships this.
  local prom="$METRICS_DIR/fire_watch_deploy.prom"
  {
    echo '# HELP fire_watch_deploy_timestamp_seconds Unix time of the last successful deploy.'
    echo '# TYPE fire_watch_deploy_timestamp_seconds gauge'
    echo "fire_watch_deploy_timestamp_seconds{sha=\"${sha}\",rollback=\"${ROLLBACK}\"} $(date +%s)"
  } >"$prom.tmp"
  chmod 0644 "$prom.tmp"
  mv -f "$prom.tmp" "$prom"

  # The deploy heartbeat. The URL is a secret (§3 rule 4) and is never echoed.
  if [[ -r "$SECRETS_ENV_FILE" ]]; then
    local url
    url="$(
      set -a
      # shellcheck disable=SC1090
      . "$SECRETS_ENV_FILE"
      printf '%s' "${HEALTHCHECKS_DEPLOY_URL:-}"
    )"
    if [[ -n "$url" ]]; then
      curl -fsS --max-time 15 --retry 3 --data-raw "deployed ${sha} rollback=${ROLLBACK}" \
        "$url" >/dev/null 2>&1 || log "deploy heartbeat ping failed (deploy itself succeeded)"
    fi
  fi
}

main() {
  log "deploying ${sha}$([[ "$ROLLBACK" == "1" ]] && echo ' (rollback)')"
  ensure_image
  install_stack

  compose up -d --wait --wait-timeout 120 postgres || rollback "postgres did not become healthy"
  compose run --rm --no-deps migrate || rollback "migrations failed"
  compose up -d --no-deps --force-recreate worker || rollback "worker did not start"
  compose up -d --no-deps --force-recreate api || rollback "api did not start"
  compose up -d --no-deps --remove-orphans proxy alloy || rollback "proxy/alloy did not start"

  smoke || rollback "smoke test failed"
  record_success
  log "deployed ${sha}"
}

main
