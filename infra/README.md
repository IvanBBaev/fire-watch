# Fire Watch — infrastructure

Everything a single operator needs to take a fresh Hetzner Cloud VM from
nothing to a running Fire Watch host. The authoritative operational contract
is [`docs/OPERATIONS.md`](../docs/OPERATIONS.md) (cited below as §N); this
directory is its executable half.

| File | What it is |
| --- | --- |
| `cloud-init.yaml` | The host contract (§9): users, SSH policy, firewall, Docker, backup timer, host tuning. Applied exactly once, at first boot. |
| `provision.sh` | The B9 driver: renders `cloud-init.yaml`, creates the server, waits for cloud-init, hands off to the deploy path, verifies migrations. |
| `metrics/` | The Grafana Cloud leg (§3, C5): Alloy config and alert rules. See [`metrics/README.md`](metrics/README.md). |

## The one command

```sh
HCLOUD_TOKEN=<project-token> infra/provision.sh --deploy-key ~/.ssh/fire-watch-deploy.pub
```

Defaults: server `fire-watch-prod-1`, type `cx22`, location `fsn1`, image
`debian-12` — all per §9.1 and the `cloud-init.yaml` header; all overridable
(`--server-type cax11` for the ARM equivalent, `--location nbg1`, …).
Run `infra/provision.sh --help` for the full flag list.

What one run does, in order:

1. **Render** — strips YAML comments from `cloud-init.yaml` (transport-layer
   minification only; block-scalar file content is preserved byte-for-byte and
   self-checked), substitutes your deploy public key for the placeholder,
   gzips and base64-encodes the result (see "user_data size"), and enforces the
   Hetzner `user_data` size cap **before** calling the API.
2. **Create** — `hcloud server create` with the rendered user_data. Refuses if
   a server with that name already exists (see `--force-new` below).
3. **Wait** — polls SSH as `deploy` (the only login the box has), then
   `cloud-init status --wait`, then confirms `fire-watch.service` is enabled
   (the unprivileged proxy for the `fw-provision` completion marker, which
   lives in a root-only directory).
4. **First deploy** — hands off to *the* deploy path (§9.3). If
   `.github/workflows/deploy.yml` exists it is triggered via `gh workflow run`;
   until that pipeline exists (today it does not — only `ci.yml` does) the
   script prints the exact hand-off: what the deploy must deliver
   (`compose.yaml`, `deploy.sh`, `secrets.env`) and the start command. It never
   deploys by hand — a second deploy path is how `last_good` stops being true
   (§9.3 rules 1–2).
5. **Verify "migrations applied"** — see below. Re-runnable at any time:

```sh
HCLOUD_TOKEN=<project-token> infra/provision.sh --verify-only
```

## Prerequisites

- **`hcloud` CLI** — <https://github.com/hetznercloud/cli> (Homebrew:
  `brew install hcloud`). Not needed for `--verify-only --ip <addr>`.
- **`HCLOUD_TOKEN`** — a Hetzner Cloud *project* API token with **read & write**
  permission. Environment variable only: the script never accepts it as a flag
  (flags land in shell history and `ps` output) and never prints it (§8.3
  redaction discipline).
- **Deploy SSH keypair** (§8.1 "Deploy SSH key") — generate it once:

  ```sh
  ssh-keygen -t ed25519 -f ~/.ssh/fire-watch-deploy -C deploy@fire-watch-ci
  ```

  The **public** half goes to `--deploy-key`; the **private** half goes into
  GitHub Environments for the deploy pipeline (§8.1/§8.2) and into your local
  agent (or `--identity ~/.ssh/fire-watch-deploy`) so the wait/verify steps can
  log in. The script refuses a file containing a private key: user_data is
  readable via the instance metadata service, i.e. the same secrecy class as
  "in an image" (§8.2 rule 2).
- **No Hetzner-registered SSH key is needed.** Registered keys land on `root`,
  and the host contract disables root login entirely (`disable_root: true`,
  `ssh_pwauth: false`); the deploy key travels inside user_data instead.
- **`gh` CLI** — only once the deploy workflow exists; the script tells you
  the exact command if `gh` is missing.
- OpenSSH ≥ 7.6 (`StrictHostKeyChecking=accept-new` — trust-on-first-use for a
  brand-new VM; the accepted host key is pinned in `known_hosts` afterwards).

## user_data size

The Hetzner Cloud API caps `user_data` at **32,768 bytes** ("limited to 32KiB"
in the API reference; "Length must be between 0 and 32768" from the API).
`cloud-init.yaml` alone is well over that, so the render compresses it:

| Artifact | Size (2026-10-10) |
| --- | --- |
| `infra/cloud-init.yaml` raw | 59,806 bytes |
| Comment-stripped, deploy key substituted | 49,449 bytes |
| **Sent: gzip -9n, then base64 on one line** | **22,184 bytes** (margin 10,584, 32%) |
| API cap | 32,768 bytes |

How it reaches the box unchanged:

1. `hcloud server create --user-data-from-file` passes the file verbatim, and
   the API stores it as an opaque string (no compression or encoding of its own).
2. cloud-init's Hetzner datasource runs `maybe_b64decode` on it — upstream's
   own comment: Hetzner "does not support binary user-data", so the user "can
   provide base64 encoded (possibly gzipped) data". It decodes with
   `validate=True`, so the base64 must be **one line with no newline**; the
   render guarantees that.
3. cloud-init's user-data processing gunzips the result ("Content found to be
   gzip compressed will be uncompressed") and sees the `#cloud-config` document.

This needs **cloud-init ≥ 20.3** on the image. The Hetzner datasource has the
base64 step in 20.3 and not in 19.4. Debian 12 ships 22.4.2. On an older image the box
would receive base64 text it cannot use. The default `--image debian-12` is
fine; check before choosing another image.

Nothing encoded is committed: `cloud-init.yaml` stays the readable source, and
the encoding exists only in the render. `provision.sh` decodes its own output
and byte-compares it before use, prints the size and margin on every run,
warns below 4,096 bytes of headroom and **refuses with exit 2** over the cap.
`infra/user-data/render.test.ts` (unit project) runs the real `--dry-run`,
decodes the way the datasource does, and requires the decoded document — and
every `write_files` payload, byte for byte — to match the repo file. Write
`--emit-user-data <path>` to inspect what would be sent.

Validated off-box (2026-10-10): in a `debian:12` container with cloud-init
22.4.2, `cloudinit.sources.helpers.hetzner.maybe_b64decode` plus
`UserDataProcessor` turned the rendered file into exactly one
`text/cloud-config` part, byte-identical to the comment-stripped render, and
`cloud-init schema -c` reported it valid. A real first boot on Hetzner has not
been run yet.

Per-file `write_files` `encoding: gz+b64` was measured first and rejected: it
still came to 33,761 bytes. Each file compresses alone, so the vocabulary the
scripts share is never reused, and the YAML around them stays uncompressed.

What compression does **not** settle: whether the large on-box scripts
(`fw-backup`, `fw-restore-drill`, `fw-provision`) belong in first-boot
user_data at all, or should come with the deploy pipeline instead. That is a
§9 ownership question for the founder (TASKS 21 E1/Q1). Compression only removes
the size pressure that forced the question.

## What "migrations applied" looks like

Migrations are SQL files under `server/db/migrations/` applied by dbmate; the
**worker applies them on boot** behind a Postgres advisory lock (§9.3 rule 3),
so verification is observation, not execution. Postgres publishes **no host
port** (§9.2), so the check runs inside the container over SSH — the same
access path the `fw-backup` script uses:

```sh
ssh deploy@<ip> "cd /srv/fire-watch && docker compose exec -T postgres \
  psql -U postgres -d fire_watch -Atc 'select version from schema_migrations order by version'"
```

The script polls this (stack startup and the advisory lock take time), then
requires every local `server/db/migrations/NNN_*.sql` version to be present.
Success output (illustrative):

```text
provision: applied migration versions:
  001
  002
provision: MIGRATIONS APPLIED — every local version present (TASKS B9 done-when reached)
```

Service name `postgres` and identities `postgres`/`fire_watch` are the same
assumptions `backup.env` in `cloud-init.yaml` documents
(TODO: OPERATIONS §9.1/§8.2 — canonical names owed by the deploy contract);
override with `FW_PGUSER` / `FW_PGDATABASE` if the deploy decides otherwise.

## What the script deliberately does NOT do

- **Secrets** — no secret value is read, written, or logged. The deploy
  pipeline renders `/etc/fire-watch/secrets.env` (root:root, `0600`) from
  GitHub Environments at deploy time (§8.2 rule 1). The sole credential here
  is `HCLOUD_TOKEN`, environment-only.
- **`compose.yaml` / `deploy.sh`** — owned and delivered by the deploy
  pipeline (§9.1, §9.3). This script only observes their effect.
- **DNS / Cloudflare** — proxied-DNS setup, WAF, cache rules are out-of-band
  ops (§10; §11 rule 5). The origin IP is never published (§10 rule 4).
- **R2 bucket lifecycle** — bucket creation and the 30-day retention rule live
  in Cloudflare, applied out-of-band (§6.2 rules 1 and 9). `backup.env` on the
  box still says `R2_BUCKET=REPLACE_ME` until that happens.
- **Restore from backup** — `--restore-from <r2-path>` exists so the hook is
  visible on the §5 RTO path, but it **exits 64** ("not implemented") until
  TASKS C6 lands: the R2 backup token is write-only by design (§6.2 rule 2),
  so the restore-side credential and the tested procedure (runbook RB-2, §6.3)
  do not exist yet.

## Honest status

**The end-to-end path is untested against a real VM.** No Hetzner account or
token exists in this development environment. Preflight no longer blocks a
real create run: the user_data now fits (see "user_data size"). What *has* been
validated:

- `bash -n` and `shellcheck` clean;
- a real `--dry-run` execution (renders, measures, prints the full plan);
- the renderer proven lossless: the in-script byte-level self-checks (block
  scalars after minification, and the gzip+base64 round trip), and
  `infra/user-data/render.test.ts`, which compares the decoded document with
  the repo file;
- the encoded user_data decoded by cloud-init 22.4.2's own Hetzner code path
  and passed by `cloud-init schema` (Debian 12 container, not a VM).

Treat the first real provisioning as the test, per §9's own note that no
production VM has yet been provisioned from this contract.

## Exit codes

Repo convention (see the root `README.md`):

| Code | Meaning |
| --- | --- |
| `0` | Success (or: provisioned and honestly awaiting the first deploy). |
| `1` | Runtime failure (API/SSH/cloud-init/verify). |
| `2` | Misconfiguration — **every** problem named at once, then exit. |
| `64` | Not-implemented stub (`--restore-from`; same code as `fw-restore-drill`). |
