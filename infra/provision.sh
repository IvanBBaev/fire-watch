#!/usr/bin/env bash
# =============================================================================
# Fire Watch — VM provisioning driver (TASKS B9)
#
# One operator command that takes a fresh Hetzner Cloud VM from nothing toward
# "migrations applied" (the B9 done-when), by driving the pieces that already
# own each step — it owns none of them itself:
#
#   render  infra/cloud-init.yaml (the host contract, OPERATIONS §9) into
#           Hetzner user_data: deploy public key substituted for the
#           placeholder, YAML comments stripped for transport only — the repo
#           file stays the single source of truth (§9.2 configuration-drift
#           rule; the minification is size plumbing, never a second config).
#   create  the server with the documented class/region/image (§9.1: CX22 or
#           CAX11 class, Falkenstein/Nuremberg, Debian 12/13 or Ubuntu 22.04+
#           per the cloud-init header; IPv4 kept — GitHub-hosted runners have
#           no IPv6 and an IPv6-only origin breaks the deploy path).
#   wait    for cloud-init to finish: `cloud-init status --wait` over SSH as
#           `deploy` — the only login the box has (cloud-init "Accounts").
#   deploy  hand off to THE deploy path (§9.3): trigger the GitHub Actions
#           deploy workflow when it exists, otherwise print the exact next
#           command. This script never performs a deploy itself — a second
#           deploy path is how `last_good` stops being true (§9.3 rules 1–2).
#   verify  "migrations applied" by reading dbmate's `schema_migrations`
#           through the deployed stack itself: `docker compose exec` into the
#           postgres service — the same access path fw-backup uses, because
#           Postgres has no published port (§9.2 "Postgres exposure") and
#           migrations are applied by the worker on boot behind the advisory
#           lock (§9.3 rule 3), so there is nothing to "run", only to observe.
#
# SCOPE — what this script deliberately does NOT do:
#   * secrets: no secret value is read, written or logged here. Deploy renders
#     /etc/fire-watch/secrets.env from GitHub Environments (§8.2 rule 1). The
#     only credential this script touches is HCLOUD_TOKEN, accepted from the
#     environment ONLY — never a flag (flags land in shell history and `ps`
#     output) — and never printed (§8.3's redaction discipline applies to ops
#     scripts too).
#   * compose.yaml / deploy.sh: delivered by the deploy pipeline (§9.1/§9.3).
#   * DNS / Cloudflare / R2 lifecycle rules: out-of-band ops (§10; §11 rule 5;
#     §6.2 rule 9).
#   * restore from backup: --restore-from is a STUB until TASKS C6 — see the
#     handler below for the two documented blockers (§6.2 rule 2, §6.3).
#
# KNOWN BLOCKER (verified 2026-08): the Hetzner Cloud API caps user_data at
# 32,768 bytes ("Length must be between 0 and 32768"). infra/cloud-init.yaml
# renders to ~49.4 KiB even with every YAML comment stripped (~58.4 KiB raw),
# so preflight currently refuses with exit 2. Resolving this is a design
# decision this script must not take alone; see infra/README.md "Known
# blocker" for the two documented options and their owners.
#
# Exit codes (repo convention — README "Exit codes" and server/src/app/config.ts:
# misconfiguration names every missing thing at once):
#   0  success                2  misconfiguration — ALL problems named at once
#   1  runtime failure       64  not-implemented stub (--restore-from; the same
#                                code fw-restore-drill uses in cloud-init.yaml)
# =============================================================================
set -euo pipefail

# --- Constants ---------------------------------------------------------------

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
CLOUD_INIT="${SCRIPT_DIR}/cloud-init.yaml"

# Hetzner Cloud API hard cap on user_data. Not configurable — the API rejects
# anything larger with "Length must be between 0 and 32768".
USER_DATA_CAP=32768

# The literal placeholder in cloud-init.yaml's ssh_authorized_keys. The file
# itself warns: a VM booted with this value has NO way in except the provider
# console (disable_root + ssh_pwauth false). Exactly one occurrence is
# expected; any other count means the file drifted and this script's
# substitution can no longer be trusted.
KEY_PLACEHOLDER='REPLACE_ME_WITH_THE_DEPLOY_PUBLIC_KEY'

# Defaults per OPERATIONS §9.1 and the cloud-init header. The server name is
# cosmetic on the Hetzner side (the hostname comes from cloud-init; the origin
# hostname is never published — §10 rule 4) but must be unique per project.
DEFAULT_NAME='fire-watch-prod-1'
DEFAULT_TYPE='cx22'        # §9.1: "2 vCPU / 4 GB (Hetzner CX22/CAX11 class)"
DEFAULT_LOCATION='fsn1'    # §9.1: "Falkenstein/Nuremberg" — fsn1 | nbg1
DEFAULT_IMAGE='debian-12'  # cloud-init header: Debian 12/13 or Ubuntu 22.04+

# The compose service name and DB identity for the verify step. Same
# assumption, same caveat as /etc/fire-watch/backup.env in cloud-init.yaml:
# TODO(OPERATIONS §9.1): the compose service name for Postgres is not stated.
# TODO(OPERATIONS §8.2): canonical env-var names are owned by the app/deploy;
# FW_PGUSER/FW_PGDATABASE here are overrides for the drill, defaulting to what
# fw-backup assumes.
PG_SERVICE='postgres'
PG_USER="${FW_PGUSER:-postgres}"
PG_DB="${FW_PGDATABASE:-fire_watch}"

# How long to wait, and how often to look. cloud-init itself blocks via
# `status --wait`, so only SSH reachability and the verify poll need budgets.
SSH_WAIT_TIMEOUT=600       # seconds until first SSH contact after create
SSH_WAIT_INTERVAL=5
VERIFY_TIMEOUT=600         # §9.3 rule 3: the worker applies migrations on
VERIFY_INTERVAL=15         # boot — observing them is a poll, not a command

usage() {
  cat <<'EOF'
Fire Watch VM provisioning (TASKS B9) — drives Hetzner + infra/cloud-init.yaml.

Usage:
  HCLOUD_TOKEN=<token> infra/provision.sh --deploy-key <path.pub> [options]
  HCLOUD_TOKEN=<token> infra/provision.sh --verify-only [--ip <addr>] [options]

Required for a create run:
  HCLOUD_TOKEN           Hetzner Cloud API token — environment only, never a
                         flag, never logged (OPERATIONS §8.2/§8.3).
  --deploy-key <path>    PUBLIC half of the deploy keypair (OPERATIONS §8.1
                         "Deploy SSH key"); substituted for the placeholder in
                         cloud-init.yaml at render time. Never the private key.

Options:
  --name <name>          Server name (default: fire-watch-prod-1).
  --server-type <type>   cx22 | cax11 (default: cx22) — OPERATIONS §9.1.
  --location <loc>       fsn1 | nbg1 (default: fsn1) — OPERATIONS §9.1.
  --image <image>        Default: debian-12 (cloud-init header target list).
  --identity <path>      SSH private key for the wait/verify steps
                         (default: whatever your ssh-agent offers).
  --force-new            A server with --name already exists: delete it first.
                         DESTRUCTIVE — interactive confirmation required.
  --verify-only          Skip create/wait; only check schema_migrations on the
                         existing server (the post-deploy half of this script).
  --ip <addr>            With --verify-only: reach the box directly instead of
                         asking the Hetzner API for the address.
  --restore-from <path>  Restore-from-backup stub — exits 64; real
                         implementation is TASKS C6 (OPERATIONS §5, §6.3).
  --dry-run              Print every action without executing anything remote.
  -h, --help             This text.

Exit codes: 0 ok; 1 runtime failure; 2 misconfiguration (all problems named
at once); 64 not-implemented stub.
EOF
}

# --- Small helpers -----------------------------------------------------------

say()  { printf 'provision: %s\n' "$*"; }
warn() { printf 'provision: WARN %s\n' "$*" >&2; }
die()  { printf 'provision: ERROR %s\n' "$*" >&2; exit 1; }
plan() { printf '  + %s\n' "$*"; }   # dry-run: one line per action, verbatim

# --- Argument parsing ----------------------------------------------------------

NAME="$DEFAULT_NAME"
SERVER_TYPE="$DEFAULT_TYPE"
LOCATION="$DEFAULT_LOCATION"
IMAGE="$DEFAULT_IMAGE"
DEPLOY_KEY=''
IDENTITY=''
FORCE_NEW=0
VERIFY_ONLY=0
IP_OVERRIDE=''
RESTORE_FROM=''
DRY_RUN=0

need_value() { # flag name must be followed by a value
  [[ $# -ge 2 && "${2#-}" == "$2" ]] || { printf 'provision: ERROR %s requires a value\n' "$1" >&2; exit 2; }
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --name)         need_value "$@"; NAME="$2"; shift 2 ;;
    --server-type)  need_value "$@"; SERVER_TYPE="$2"; shift 2 ;;
    --location)     need_value "$@"; LOCATION="$2"; shift 2 ;;
    --image)        need_value "$@"; IMAGE="$2"; shift 2 ;;
    --deploy-key)   need_value "$@"; DEPLOY_KEY="$2"; shift 2 ;;
    --identity)     need_value "$@"; IDENTITY="$2"; shift 2 ;;
    --ip)           need_value "$@"; IP_OVERRIDE="$2"; shift 2 ;;
    --restore-from) need_value "$@"; RESTORE_FROM="$2"; shift 2 ;;
    --force-new)    FORCE_NEW=1; shift ;;
    --verify-only)  VERIFY_ONLY=1; shift ;;
    --dry-run)      DRY_RUN=1; shift ;;
    -h|--help)      usage; exit 0 ;;
    *)              printf 'provision: ERROR unknown argument: %s\n\n' "$1" >&2; usage >&2; exit 2 ;;
  esac
done

# --- Restore stub — before anything else -------------------------------------
# OPERATIONS §5 puts restore-from-backup on the RTO path of a VM loss, so the
# hook must exist here rather than be silently ignored. It is a stub for the
# same two reasons fw-restore-drill (cloud-init.yaml) is one:
#   1. No read credential exists: §8.1 lists exactly one R2 backup token and
#      §6.2 rule 2 makes it WRITE-ONLY, precisely so a compromised VM cannot
#      destroy history. The restore-side credential is owed to the §8.1
#      inventory (holder: the operator's workstation, never the VM).
#   2. The restore procedure itself is TASKS C6 ("restore script tested once")
#      and runbook RB-2 (§5); implementing it here before C6 would create an
#      untested restore path, which §6.3 calls a rumor.
if [[ -n "$RESTORE_FROM" ]]; then
  cat >&2 <<EOF
provision: --restore-from is not implemented until TASKS C6.
  Requested artifact: ${RESTORE_FROM}
  Why: the R2 backup token is write-only (OPERATIONS §6.2 rule 2), so no
  credential that can READ a backup may exist on or near the production VM;
  the restore-side credential and procedure are owed to OPERATIONS §8.1 and
  runbook RB-2 (§5), and land with TASKS C6. Until then a fresh VM starts
  empty and the worker applies migrations to an empty database (§9.3 rule 3).
EOF
  exit 64   # same "stub" code as fw-restore-drill in cloud-init.yaml
fi

# --- Preflight — every problem named at once (exit 2) ------------------------
# Repo convention (README "Exit codes", server/src/app/config.ts): a
# misconfigured run reports EVERY missing thing by name in one pass, so the
# operator fixes the environment once, not once per attempt.

PROBLEMS=()
WARNINGS=()
problem() { PROBLEMS+=("$1"); }
note()    { WARNINGS+=("$1"); }

# Tooling. ssh is needed by every mode; hcloud only when we talk to the API.
command -v ssh >/dev/null 2>&1 || problem 'ssh: not found in PATH'
if ! command -v hcloud >/dev/null 2>&1; then
  if [[ "$VERIFY_ONLY" -eq 1 && -n "$IP_OVERRIDE" ]]; then
    : # verify with --ip needs no Hetzner API at all
  else
    problem 'hcloud: CLI not found in PATH (https://github.com/hetznercloud/cli)'
  fi
fi

# HCLOUD_TOKEN — environment only. Its VALUE is never expanded anywhere in
# this script: hcloud reads it from the environment natively, so it never
# appears in argv, logs, or dry-run output.
if [[ -z "${HCLOUD_TOKEN:-}" ]]; then
  if [[ "$VERIFY_ONLY" -eq 1 && -n "$IP_OVERRIDE" ]]; then
    : # no API call in this mode
  else
    problem 'HCLOUD_TOKEN: unset (environment variable; never passed as a flag)'
  fi
fi

# Flag combinations.
if [[ -n "$IP_OVERRIDE" && "$VERIFY_ONLY" -ne 1 ]]; then
  problem '--ip: only meaningful together with --verify-only'
fi
if [[ "$FORCE_NEW" -eq 1 && "$VERIFY_ONLY" -eq 1 ]]; then
  problem '--force-new: conflicts with --verify-only'
fi

# Server name: Hetzner requires a valid hostname-shaped name.
if ! [[ "$NAME" =~ ^[A-Za-z0-9][A-Za-z0-9.-]{0,62}$ ]]; then
  problem "--name: '${NAME}' is not a valid Hetzner server name"
fi

# VM class / region / image: warn rather than refuse on values outside the
# documented set — §7 U-2 (resize) and an incident may legitimately need a
# bigger box, and a provisioning script that blocks the operator mid-incident
# would violate the "executable by one person" constraint in OPERATIONS' own
# preamble. The contract citation makes the deviation a decision, not a typo.
case "$SERVER_TYPE" in
  cx22|cax11) : ;;
  *) note "--server-type '${SERVER_TYPE}' is outside OPERATIONS §9.1 (cx22/cax11 class); resize policy is §7 U-2" ;;
esac
case "$LOCATION" in
  fsn1|nbg1) : ;;
  *) note "--location '${LOCATION}' is outside OPERATIONS §9.1 (fsn1/nbg1)" ;;
esac
case "$IMAGE" in
  debian-12|debian-13|ubuntu-22.04|ubuntu-24.04) : ;;
  *) note "--image '${IMAGE}' is outside the cloud-init header target list (Debian 12/13, Ubuntu 22.04+)" ;;
esac

# The deploy PUBLIC key — required for any create run: cloud-init.yaml itself
# warns that a VM booted with the placeholder has no way in.
PUBKEY_LINE=''
if [[ "$VERIFY_ONLY" -ne 1 ]]; then
  if [[ -z "$DEPLOY_KEY" ]]; then
    problem '--deploy-key: required (public half of the deploy keypair, OPERATIONS §8.1)'
  elif [[ ! -r "$DEPLOY_KEY" ]]; then
    problem "--deploy-key: '${DEPLOY_KEY}' is not readable"
  elif grep -q 'PRIVATE KEY' "$DEPLOY_KEY"; then
    # Refuse loudly: embedding a private key in user_data would hand the
    # deploy identity to anyone who can read the instance metadata. §8.2
    # rule 2: never in images, git, logs — instance user_data is the same class.
    problem "--deploy-key: '${DEPLOY_KEY}' contains a PRIVATE key — pass the .pub file"
  else
    PUBKEY_LINE="$(head -n1 "$DEPLOY_KEY")"
    case "$PUBKEY_LINE" in
      ssh-ed25519\ *|ssh-rsa\ *|ecdsa-sha2-*|sk-ssh-ed25519@openssh.com\ *|sk-ecdsa-sha2-*)
        # Single-quoted into YAML below, so a quote inside would break the
        # render; no OpenSSH public key legitimately contains one.
        if [[ "$PUBKEY_LINE" == *"'"* ]]; then
          problem "--deploy-key: key line contains a quote character"
        fi
        ;;
      *) problem "--deploy-key: '${DEPLOY_KEY}' does not look like an OpenSSH public key" ;;
    esac
  fi
fi

if [[ -n "$IDENTITY" && ! -r "$IDENTITY" ]]; then
  problem "--identity: '${IDENTITY}' is not readable"
fi

[[ -r "$CLOUD_INIT" ]] || problem "cloud-init.yaml: not found at ${CLOUD_INIT}"

# psql user/db names go into a remote command line; keep them boring.
[[ "$PG_USER" =~ ^[A-Za-z0-9_]+$ ]] || problem "FW_PGUSER: '${PG_USER}' must match [A-Za-z0-9_]+"
[[ "$PG_DB"   =~ ^[A-Za-z0-9_]+$ ]] || problem "FW_PGDATABASE: '${PG_DB}' must match [A-Za-z0-9_]+"

# The local migrations dir makes the verify step exact (every local version
# must be applied remotely); without it the check degrades to "non-empty".
MIGRATIONS_DIR="${REPO_ROOT}/server/db/migrations"
if [[ ! -d "$MIGRATIONS_DIR" ]]; then
  note "server/db/migrations not found — verify degrades to 'schema_migrations is non-empty'"
fi

# --- Render — cloud-init.yaml -> Hetzner user_data ---------------------------
# Two transformations, both mechanical, both verified, neither semantic:
#
#   1. Strip YAML comments and blank lines OUTSIDE block scalars. Inside a
#      `content: |` block every line — including "# ..." lines — is file
#      content headed for the box and is preserved byte-for-byte: the on-box
#      scripts' comments are incident documentation (§9.2 drift rule: the
#      host is code, and that code must still explain itself at 3 AM).
#      This is transport-layer minification against the API's 32 KiB cap;
#      infra/cloud-init.yaml in the repo remains the single readable source.
#   2. Substitute the deploy public key for the placeholder (exactly one
#      occurrence, or refuse).
#
# The state machine and its self-check share one classifier: a line opens a
# block scalar when it ends in `: |`/`: >` (with optional +/- chomping), the
# scalar's content is every following line indented deeper than the key (blank
# lines included), and the scalar ends at the first non-blank line at or above
# the key's indent. The self-check extracts scalar content from source and
# rendered output and requires a byte-identical match — a minifier bug aborts
# the run instead of shipping a corrupted host.

# The single quotes are the point: $0 below is awk's, not the shell's.
# shellcheck disable=SC2016
AWK_MINIFY='
BEGIN { in_scalar = 0; scalar_indent = -1 }
{
  line = $0
  n = match(line, /[^ ]/) - 1
  if (n < 0) n = length(line)
  blank = (line ~ /^[[:space:]]*$/)
  if (in_scalar) {
    if (blank)            { print; next }
    if (n > scalar_indent) { print; next }
    in_scalar = 0
  }
  if (NR == 1) { print; next }          # "#cloud-config" sentinel must survive
  if (line ~ /^[[:space:]]*#/) next     # YAML comment outside any scalar
  if (blank) next                       # blank line outside any scalar
  print
  if (line ~ /:[[:space:]]*[|>][+-]?[[:space:]]*$/) {
    in_scalar = 1
    scalar_indent = n
  }
}'

# shellcheck disable=SC2016
AWK_SCALARS_ONLY='
BEGIN { in_scalar = 0; scalar_indent = -1 }
{
  line = $0
  n = match(line, /[^ ]/) - 1
  if (n < 0) n = length(line)
  blank = (line ~ /^[[:space:]]*$/)
  if (in_scalar) {
    if (blank)            { print; next }
    if (n > scalar_indent) { print; next }
    in_scalar = 0
  }
  if (line ~ /:[[:space:]]*[|>][+-]?[[:space:]]*$/) {
    in_scalar = 1
    scalar_indent = n
  }
}'

WORKDIR="$(mktemp -d "${TMPDIR:-/tmp}/fw-provision.XXXXXX")"
trap 'rm -rf "$WORKDIR"' EXIT
chmod 0700 "$WORKDIR"
RENDERED="${WORKDIR}/user-data.yaml"

RAW_SIZE=0 RENDERED_SIZE=0
if [[ -r "$CLOUD_INIT" ]]; then
  awk "$AWK_MINIFY" "$CLOUD_INIT" >"${WORKDIR}/minified.yaml"

  # Self-check: block-scalar content must be untouched, byte for byte.
  awk "$AWK_SCALARS_ONLY" "$CLOUD_INIT"            >"${WORKDIR}/scalars.src"
  awk "$AWK_SCALARS_ONLY" "${WORKDIR}/minified.yaml" >"${WORKDIR}/scalars.out"
  if ! cmp -s "${WORKDIR}/scalars.src" "${WORKDIR}/scalars.out"; then
    die 'minifier self-check failed: block-scalar content changed — refusing to ship a corrupted host config'
  fi

  # Placeholder discipline: exactly one, then exactly zero.
  PLACEHOLDER_COUNT="$(grep -c "$KEY_PLACEHOLDER" "${WORKDIR}/minified.yaml" || true)"
  if [[ "$PLACEHOLDER_COUNT" -ne 1 ]]; then
    problem "cloud-init.yaml: expected exactly 1 '${KEY_PLACEHOLDER}' placeholder, found ${PLACEHOLDER_COUNT} — file drifted, substitution untrusted"
  fi

  if [[ -n "$PUBKEY_LINE" && "$PLACEHOLDER_COUNT" -eq 1 ]]; then
    awk -v key="$PUBKEY_LINE" -v ph="$KEY_PLACEHOLDER" '
      index($0, ph) {
        n = match($0, /[^ ]/) - 1
        printf "%*s- '\''%s'\''\n", n, "", key
        next
      }
      { print }
    ' "${WORKDIR}/minified.yaml" >"$RENDERED"
    if grep -q "$KEY_PLACEHOLDER" "$RENDERED"; then
      die 'placeholder substitution failed — placeholder still present after render'
    fi
  else
    # Dry-run without a key still renders, so the size verdict below is real;
    # a real create run without a key was already named a problem above.
    cp "${WORKDIR}/minified.yaml" "$RENDERED"
  fi

  RAW_SIZE="$(wc -c <"$CLOUD_INIT" | tr -d ' ')"
  RENDERED_SIZE="$(wc -c <"$RENDERED" | tr -d ' ')"

  # The hard gate. This is a fact about the transport, not a policy choice:
  # the API rejects the create call outright, so failing preflight here is
  # strictly more honest than letting hcloud fail with the same number.
  if [[ "$VERIFY_ONLY" -ne 1 && "$RENDERED_SIZE" -gt "$USER_DATA_CAP" ]]; then
    problem "user_data: rendered cloud-init is ${RENDERED_SIZE} bytes; Hetzner caps user_data at ${USER_DATA_CAP} bytes (raw file ${RAW_SIZE}). See infra/README.md 'Known blocker' — resolving this is a §9-level decision, not a flag"
  fi
fi

# --- Preflight verdict --------------------------------------------------------

if [[ "$DRY_RUN" -eq 1 ]]; then
  say 'DRY-RUN — no server is created, no SSH is opened, no workflow is triggered.'
  say "plan for server '${NAME}' (${SERVER_TYPE}, ${LOCATION}, ${IMAGE}):"
  say "  HCLOUD_TOKEN: $( [[ -n "${HCLOUD_TOKEN:-}" ]] && echo 'set' || echo 'UNSET' ) (value never printed)"
  say "  user_data: raw ${RAW_SIZE} B -> rendered ${RENDERED_SIZE} B (API cap ${USER_DATA_CAP} B)$( [[ "$RENDERED_SIZE" -gt "$USER_DATA_CAP" ]] && echo ' — OVER CAP, see Known blocker' )"
fi

for w in ${WARNINGS[@]+"${WARNINGS[@]}"}; do warn "$w"; done

if [[ ${#PROBLEMS[@]} -gt 0 ]]; then
  if [[ "$DRY_RUN" -eq 1 ]]; then
    printf 'provision: DRY-RUN — a real run would exit 2 with the following problem(s):\n' >&2
    for p in "${PROBLEMS[@]}"; do printf '  - %s\n' "$p" >&2; done
  else
    printf 'provision: misconfiguration — %d problem(s), all named:\n' "${#PROBLEMS[@]}" >&2
    for p in "${PROBLEMS[@]}"; do printf '  - %s\n' "$p" >&2; done
    exit 2
  fi
fi

# --- SSH plumbing --------------------------------------------------------------
# BatchMode: this script must never hang on a password prompt (§9.2: key-only
# is the host contract anyway). accept-new: a freshly created VM has no prior
# host key and hcloud exposes no out-of-band fingerprint channel, so trust-on-
# first-use at create time is the honest option; the accepted key lands in
# known_hosts and every later connection is verified against it.
SSH_OPTS=(
  -o BatchMode=yes
  -o ConnectTimeout=10
  -o StrictHostKeyChecking=accept-new
  -o ServerAliveInterval=15
  -o ServerAliveCountMax=40
)
[[ -n "$IDENTITY" ]] && SSH_OPTS+=(-i "$IDENTITY" -o IdentitiesOnly=yes)

ssh_deploy() { # ssh_deploy <ip> <remote command...>
  local ip="$1"; shift
  # Remote-side expansion is intentional: commands are composed locally from
  # validated identifiers only ([A-Za-z0-9_]-checked in preflight).
  # shellcheck disable=SC2029
  ssh "${SSH_OPTS[@]}" "deploy@${ip}" "$@"
}

# --- Phase: create -------------------------------------------------------------

server_exists() { hcloud server describe "$NAME" >/dev/null 2>&1; }

create_server() {
  local create_cmd=(
    hcloud server create
    --name "$NAME"
    --type "$SERVER_TYPE"
    --image "$IMAGE"
    --location "$LOCATION"
    --user-data-from-file "$RENDERED"
    --label project=fire-watch
  )
  # No --without-ipv4: §9.1 keeps the IPv4 address (GitHub-hosted runners have
  # no IPv6; an IPv6-only origin breaks the deploy path). No --ssh-key either:
  # Hetzner-registered keys land on root, and root login is disabled by the
  # host contract — the deploy key travels inside user_data instead.

  if [[ "$DRY_RUN" -eq 1 ]]; then
    plan "hcloud server describe ${NAME}   # refuse if it exists (idempotence guard)"
    if [[ "$FORCE_NEW" -eq 1 ]]; then
      plan "[interactive] type '${NAME}' to confirm PERMANENT deletion"
      plan "hcloud server delete ${NAME}"
    fi
    plan "${create_cmd[*]}"
    plan "hcloud server ip ${NAME}"
    return 0
  fi

  if server_exists; then
    if [[ "$FORCE_NEW" -ne 1 ]]; then
      cat >&2 <<EOF
provision: ERROR a server named '${NAME}' already exists.
  This script refuses to touch a live box: it may hold the season database,
  and season data is unrepeatable (RISKS "Season-window dependency"). Either:
    - verify the existing box instead:   infra/provision.sh --verify-only --name ${NAME}
    - or, to replace a LOST VM (§5 RTO): re-run with --force-new (interactive
      confirmation required; the old server is deleted permanently).
EOF
      exit 1
    fi
    # --force-new is the §5 "total loss of the VM" path. It is destructive and
    # therefore never non-interactive: an unattended job must not be able to
    # delete the production server by re-running a provisioning script.
    [[ -t 0 ]] || die '--force-new requires an interactive terminal (destructive confirmation)'
    printf "provision: --force-new will PERMANENTLY delete server '%s' and its disk.\n" "$NAME"
    printf 'Type the server name to confirm: '
    local answer; read -r answer
    [[ "$answer" == "$NAME" ]] || die 'confirmation did not match — nothing deleted'
    say "deleting server '${NAME}'"
    hcloud server delete "$NAME"
  fi

  say "creating server '${NAME}' (${SERVER_TYPE}, ${LOCATION}, ${IMAGE}; user_data ${RENDERED_SIZE} bytes)"
  "${create_cmd[@]}"
  SERVER_IP="$(hcloud server ip "$NAME")"
  say "server created; IPv4 ${SERVER_IP}"
}

# --- Phase: wait for cloud-init ------------------------------------------------

wait_cloud_init() {
  local ip="$1"

  if [[ "$DRY_RUN" -eq 1 ]]; then
    plan "ssh deploy@<ip> true   # retry up to ${SSH_WAIT_TIMEOUT}s, every ${SSH_WAIT_INTERVAL}s"
    plan "ssh deploy@<ip> cloud-init status --wait   # blocks until first boot finishes"
    plan "ssh deploy@<ip> systemctl is-enabled fire-watch.service   # fw-provision's completion proxy"
    return 0
  fi

  say "waiting for SSH on ${ip} (deploy user; up to ${SSH_WAIT_TIMEOUT}s)"
  local waited=0
  until ssh_deploy "$ip" true 2>/dev/null; do
    waited=$((waited + SSH_WAIT_INTERVAL))
    if [[ "$waited" -ge "$SSH_WAIT_TIMEOUT" ]]; then
      die "no SSH contact after ${SSH_WAIT_TIMEOUT}s — check 'hcloud server describe ${NAME}' and the provider console"
    fi
    sleep "$SSH_WAIT_INTERVAL"
  done
  say 'SSH is up; waiting for cloud-init to finish (package upgrade + Docker install — this takes minutes)'

  # `cloud-init status --wait` needs no privileges (it reads
  # /run/cloud-init/status.json) — which matters, because the deploy user's
  # sudo grant is deliberately only the stack unit (sudoers.d/60-deploy).
  # Exit codes: 0 done, 2 done-with-recoverable-errors, anything else failed.
  local rc=0
  ssh_deploy "$ip" 'cloud-init status --wait' || rc=$?
  if [[ "$rc" -eq 2 ]]; then
    warn 'cloud-init finished with recoverable errors — read: ssh deploy@'"$ip"' cloud-init status --long'
  elif [[ "$rc" -ne 0 ]]; then
    die "cloud-init failed (rc=${rc}) — inspect via the provider console; /var/log/cloud-init-output.log is root-readable only"
  fi

  # fw-provision's last acts are `systemctl enable fire-watch.service` and the
  # /etc/fire-watch/provisioned marker. The marker sits in a 0750 root dir the
  # deploy user cannot read, so the enabled unit is the unprivileged proxy.
  if ! ssh_deploy "$ip" 'systemctl is-enabled fire-watch.service' >/dev/null 2>&1; then
    die 'cloud-init reported done but fire-watch.service is not enabled — fw-provision did not complete; inspect via the provider console'
  fi
  say 'cloud-init complete; host contract applied (OPERATIONS §9)'
}

# --- Phase: first deploy — hand off, never reimplement -------------------------
# OPERATIONS §9.3: deploy is `deploy.sh <git-sha>` on the box, delivered and
# driven by the deploy pipeline, with secrets rendered from GitHub Environments
# (§8.2 rule 1). `deploy.yml` exists (TASKS J4) but its deploy job is still a
# stub (marker DEPLOY_STEP_IS_STUB), so while the marker is present this phase
# prints the contract instead of pretending.
# TODO(OPERATIONS §9.3): when the deploy job becomes real, the trigger below
# must pass the L-12 checklist inputs — a bare dispatch fails the gate.

first_deploy() {
  local ip="$1"
  local workflow="${REPO_ROOT}/.github/workflows/deploy.yml"

  # A deploy.yml whose deploy job is a stub is not yet a deploy pipeline.
  local pipeline=0
  if [[ -f "$workflow" ]] && ! grep -q 'DEPLOY_STEP_IS_STUB' "$workflow"; then
    pipeline=1
  fi

  if [[ "$DRY_RUN" -eq 1 ]]; then
    if [[ "$pipeline" -eq 1 ]]; then
      plan 'gh workflow run deploy.yml --ref main   # THE deploy path, §9.3'
    else
      plan 'print first-deploy hand-off (deploy workflow absent or still a stub — §9.3)'
    fi
    return 0
  fi

  if [[ "$pipeline" -eq 1 ]]; then
    if command -v gh >/dev/null 2>&1; then
      say 'triggering the deploy workflow (OPERATIONS §9.3)'
      gh workflow run deploy.yml --ref main
      say 'deploy workflow triggered — follow it with: gh run watch'
      return 0
    fi
    warn 'deploy workflow exists but gh CLI is missing — trigger it yourself: gh workflow run deploy.yml --ref main'
    return 1
  fi

  cat <<EOF

provision: VM is provisioned. The FIRST DEPLOY is the deploy pipeline's job
(OPERATIONS §9.1/§9.3) and that pipeline does not exist in this repo yet.
Per the host contract (cloud-init final_message), the deploy must deliver:

  /srv/fire-watch/compose.yaml   proxy, api, worker, postgres+postgis, Alloy
  /srv/fire-watch/deploy.sh      OPERATIONS §9.3
  /etc/fire-watch/secrets.env    root:root 0600, rendered from GitHub
                                 Environments (§8.2 rule 1)

then start the stack (the deploy user's sudo grant covers exactly this):

  ssh deploy@${ip} sudo systemctl start fire-watch.service

and verify migrations (the worker applies them on boot, §9.3 rule 3):

  HCLOUD_TOKEN=... infra/provision.sh --verify-only --name ${NAME}

EOF
  return 1
}

# --- Phase: verify — "migrations applied" --------------------------------------
# dbmate records applied migrations in `schema_migrations` (server/package.json
# db:migrate). Postgres is bound to the compose network with no published port
# (§9.2 "Postgres exposure"), so the query runs INSIDE the postgres container —
# the same access path fw-backup uses — over SSH as the deploy user, who is in
# the docker group. Success = every local migration version (server/db/
# migrations/NNN_*.sql) is present remotely; without a local checkout of the
# migrations, success degrades to "at least one row", loudly.

verify_migrations() {
  local ip="$1" wait_for_deploy="${2:-0}"
  local psql_remote="cd /srv/fire-watch && docker compose exec -T ${PG_SERVICE} psql -U ${PG_USER} -d ${PG_DB} -Atc 'select version from schema_migrations order by version'"

  if [[ "$DRY_RUN" -eq 1 ]]; then
    plan "ssh deploy@<ip> test -f /srv/fire-watch/compose.yaml   # has the first deploy happened?"
    plan "ssh deploy@<ip> \"${psql_remote}\"   # poll up to ${VERIFY_TIMEOUT}s, every ${VERIFY_INTERVAL}s"
    plan 'compare against server/db/migrations/*.sql versions'
    return 0
  fi

  local local_versions=''
  if [[ -d "$MIGRATIONS_DIR" ]]; then
    local f base
    for f in "$MIGRATIONS_DIR"/*.sql; do
      [[ -e "$f" ]] || continue
      base="$(basename "$f")"
      local_versions="${local_versions}${base%%_*}"$'\n'
    done
  fi

  say "verifying migrations on ${ip} (schema_migrations via docker compose exec, §9.2)"
  local waited=0 out='' rc=0
  while :; do
    if ! ssh_deploy "$ip" 'test -f /srv/fire-watch/compose.yaml' 2>/dev/null; then
      if [[ "$wait_for_deploy" -ne 1 ]]; then
        die 'no /srv/fire-watch/compose.yaml on the box — the first deploy has not happened (OPERATIONS §9.3); nothing to verify yet'
      fi
    else
      rc=0
      out="$(ssh_deploy "$ip" "$psql_remote" 2>/dev/null)" || rc=$?
      if [[ "$rc" -eq 0 && -n "$out" ]]; then
        break
      fi
      # rc != 0 or empty: stack still starting, worker still holds the
      # advisory lock, or the table does not exist yet (§9.3 rule 3) — poll.
    fi
    waited=$((waited + VERIFY_INTERVAL))
    if [[ "$waited" -ge "$VERIFY_TIMEOUT" ]]; then
      die "migrations not observable after ${VERIFY_TIMEOUT}s — read the worker: ssh deploy@${ip} sudo journalctl -u fire-watch.service -n 100"
    fi
    sleep "$VERIFY_INTERVAL"
  done

  say 'applied migration versions:'
  # Word-splitting is on purpose: $out is newline-separated version tokens
  # (validated identifiers), printed one per line.
  # shellcheck disable=SC2086
  printf '  %s\n' $out

  if [[ -n "$local_versions" ]]; then
    local missing='' v
    while IFS= read -r v; do
      [[ -z "$v" ]] && continue
      printf '%s\n' "$out" | grep -qx "$v" || missing="${missing} ${v}"
    done <<<"$local_versions"
    if [[ -n "$missing" ]]; then
      die "migrations applied remotely but these local versions are missing:${missing} — deployed sha may predate them"
    fi
    say "MIGRATIONS APPLIED — every local version present (TASKS B9 done-when reached)"
  else
    warn 'no local migrations dir — verified only that schema_migrations is non-empty'
    say 'MIGRATIONS APPLIED (weak check — see warning above)'
  fi
}

# --- Main ----------------------------------------------------------------------

SERVER_IP="$IP_OVERRIDE"

if [[ "$VERIFY_ONLY" -eq 1 ]]; then
  if [[ -z "$SERVER_IP" ]]; then
    if [[ "$DRY_RUN" -eq 1 ]]; then
      plan "hcloud server ip ${NAME}"
      SERVER_IP='<ip>'
    else
      SERVER_IP="$(hcloud server ip "$NAME")" || die "cannot resolve '${NAME}' — pass --ip or check the name"
    fi
  fi
  verify_migrations "$SERVER_IP"
  exit 0
fi

create_server
if [[ "$DRY_RUN" -eq 1 ]]; then SERVER_IP='<ip>'; fi
wait_cloud_init "$SERVER_IP"

if first_deploy "$SERVER_IP"; then
  # A deploy was actually triggered — wait for it to land, then verify.
  verify_migrations "$SERVER_IP" 1
else
  # No pipeline yet: provisioned is the honest end state today. Exit 0 —
  # the VM did everything cloud-init owns; "migrations applied" is gated on
  # the deploy pipeline (§9.3), and the hand-off above says exactly that.
  say "done: host provisioned, awaiting first deploy (OPERATIONS §9.3)"
fi
