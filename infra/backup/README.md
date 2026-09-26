# infra/backup — the nightly backup job

The systemd unit and timer for `server/src/app/backup-cli.ts` (TASKS C6;
OPERATIONS §6.2). The restore side is `server/src/app/restore-cli.ts`, run by
hand; runbook 02 has the procedure.

| File | What it is |
|---|---|
| `fire-watch-backup.service` | Oneshot, root, `node server/dist/app/backup-cli.js` from `/srv/fire-watch`. |
| `fire-watch-backup.timer` | 02:20 UTC ± 15 min, `Persistent=true`. |

## What a night produces

Two age-encrypted `pg_dump --format=custom` artifacts, both from **one**
exported snapshot, so they describe the same instant:

| Set | Prefix | Holds | Kept (R2 lifecycle) |
|---|---|---|---|
| main | `fw-main/daily/`, `fw-main/weekly/` (Sundays) | schema + every non-personal table's rows | 14 days daily, 56 days weekly |
| personal | `fw-personal/daily/` | rows of the tables classed `personal` in `table_backup_class` | 28 days |

The personal set never lives longer than 28 days, under the 30-day erasure
horizon: an erased account can never be restored from a backup. The restore
enforces it too: it refuses a personal artifact at or past the retention and
fails its verdict if the bucket holds one past the horizon. The job refuses to
run if the registry has an unclassified table, or if the policy it was built
with would outlive the horizon.

A local-directory store (`FIRE_WATCH_BACKUP_LOCAL_DIR`) has no lifecycle
rules, so it applies the same retention itself after every upload.

## Configuration

Read from `/etc/fire-watch/backup.env` and `/etc/fire-watch/secrets.env`. The
full list is in `server/src/app/backup-config.ts`.

| Variable | Where | Notes |
|---|---|---|
| `FIRE_WATCH_BACKUP_R2_ENDPOINT` | secrets.env | `https://<account>.eu.r2.cloudflarestorage.com` |
| `FIRE_WATCH_BACKUP_R2_BUCKET` | secrets.env | |
| `FIRE_WATCH_BACKUP_R2_ACCESS_KEY_ID` / `_SECRET_ACCESS_KEY` | secrets.env | **Write-only** token (§6.2 rule 2). |
| `BACKUP_AGE_RECIPIENT` | secrets.env | `age1…` public key. The identity (private key) is never on the VM. |
| `FIRE_WATCH_HEARTBEAT_URL` | secrets.env | The job pings `<url>/nightly-backup` on success, `/fail` on failure. Unset means unmonitored, and the job warns about it. |
| `BACKUP_STAGING` | backup.env | Default `/var/backups/fire-watch`. |
| `BACKUP_KEEP_LOCAL` | backup.env | `1` keeps tonight's main artifact staged. The personal artifact is never kept. |
| `PGUSER`, `PGDATABASE` | either | Defaults `postgres`, `fire_watch`. |
| `FIRE_WATCH_BACKUP_PG_EXEC` | either | Default `docker compose exec -T postgres`. `none` uses the host's client tools. |

Check the configuration without dumping anything:

```sh
cd /srv/fire-watch && set -a && . /etc/fire-watch/backup.env && . /etc/fire-watch/secrets.env && set +a \
  && node server/dist/app/backup-cli.js --dry-run
```

## Paging

- A failed run pings `nightly-backup/fail` itself.
- `OnFailure=fw-notify-failure@%n.service` pages on anything the job cannot
  report: misconfiguration (exit 2), a crash, or the `TimeoutStartSec`.
- A night that never runs is caught by the `nightly-backup` check's grace
  period.
- A dry run never pings.

## Installing (the cloud-init swap)

`infra/cloud-init.yaml` still installs the older shell job
(`/usr/local/sbin/fw-backup`, rclone, one artifact, no personal split). It is
not edited here: the file is at its size cap, and the swap belongs to the
"slim the contract" decision in `infra/README.md`. On a host the swap is:

```sh
install -m 0644 infra/backup/fire-watch-backup.service infra/backup/fire-watch-backup.timer /etc/systemd/system/
systemctl daemon-reload && systemctl restart fire-watch-backup.timer
systemctl start fire-watch-backup.service && journalctl -u fire-watch-backup.service -n 50
```

Before the swap:

1. `server/dist/` (built) must be at `/srv/fire-watch/server/dist/`. At runtime
   the CLI imports only Node built-ins, so `node_modules` is not needed. The
   path is a placeholder until the deploy pipeline fixes where the build
   lives.
2. `secrets.env` must carry the `FIRE_WATCH_BACKUP_R2_*` group. The shell job's
   rclone remote is not read.
3. `age` must be installed on the host (`apt install age`).
