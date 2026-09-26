# 02 — VM loss and database restore

> **PRE-SEASON DRAFT (2026-09-23).** Not yet exercised on a live incident or on a real
> host. There is no production host yet. The C6 backup and restore CLIs exist but have
> never run against a real host, and J2's timed drill has never run. Revise after season 1
> and at every pre-season drill (see [README](README.md)).

**Class.** The single VM, its disk or its Postgres database is lost, corrupted or
suspected compromised. The read path survives by construction: T2 serves the last
snapshot from R2 with an honest age label. The write path and the interactive path
are down until recovery.

**Sources.**
- Review 04 RB-2 (VM loss, RTO 2–4 h) and RB-3 (DB restore), merged here because they
  are one recovery path.
- OPERATIONS §5: the RTO row names "RB-2 written and current"; rule 4 puts secrets on
  the RTO path.
- OPERATIONS §6.3 (restore drill) and §9 (host contract).
- RISKS R2 and the watchlist rows "No delivery path to a host" and "Single-operator
  archive survival".
- IMPLEMENTATION-PLAN WP8.

**Targets (OPERATIONS §5; not restated as new numbers here).** RTO 2–4 h for total VM
loss. RPO 24 h at MVP (nightly dump). RPO ≤ 15 min from the first stored watch zone
(WAL archiving).

## 1. Detection signal

| Signal | Where | Meaning |
|---|---|---|
| All worker checks go silent at once (`ingest-cycle`, `snapshot-push`, `effis-refresh`, `meta-alerts`) | healthchecks.io via `FIRE_WATCH_HEARTBEAT_URL` | The VM, or the whole stack, is gone. A single silent check is [01](01-pipeline-stale.md). |
| `/healthz` unreachable from outside | UptimeRobot (OPERATIONS §3 leg 3) | The origin is down. |
| `/readyz` non-200, `/healthz` 200 | health API | The process is up but the database is not (readiness is DB-only, review 02 §5.10). |
| `{"ingest_cycle": {...}, "degraded": true}` with `write_failed` / `status_write_failed` on every source | worker stdout | Database writes are failing. |
| `fire-watch.service` in `failed`; `fw-notify-failure` fired | systemd (`infra/cloud-init.yaml`, `StartLimitBurst=3` in 30 min) | The stack cannot come up. |
| `nightly-backup` row `warn`/`critical` (26 h / 50 h, does not 500) | `/api/health/freshness` | The last good backup is getting old. This does not page, but it widens the RPO window of any restore. |

Gaps:
- `NOT YET BUILT (C5)`: none of the healthchecks.io checks or the UptimeRobot monitors
  exist yet.
- `NOT YET BUILT (B9)`: there is no provisioned host to lose. `infra/provision.sh` is
  blocked on the 32 KiB user_data cap; see `infra/README.md`, "Known blocker".

## 2. Triage

1. **Is it the provider or us?** Check the Hetzner status page and the Hetzner console
   for the server (`fire-watch-prod-1` by default in `infra/provision.sh`). A host that
   is powered off or unreachable from the console means VM loss; go to M2.
2. **If SSH works** (as `deploy`, the only login):
   ```sh
   sudo systemctl status fire-watch.service
   cd /srv/fire-watch && docker compose logs --since 30m
   df -h
   curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:${FIRE_WATCH_API_PORT:-8080}/readyz
   ```
   A full disk, a crash-looping Postgres container or corrupted data files mean
   database loss; go to M3. A stack that simply stopped goes to M1.
3. **Is compromise suspected?** (unknown logins, unexpected processes, modified files)
   Then do not reuse the VM or its data directory. Go to M2 with a fresh VM, and rotate
   secrets per M4.
4. **Record the last good backup's timestamp** before you touch anything. It fixes the
   actual RPO of this incident.

## 3. Mitigation

- **M1 — The stack stopped; the host is fine.**
  ```sh
  sudo systemctl restart fire-watch.service
  ```
  If it returns to `failed`, read the logs for exit code `2` (misconfiguration names
  every missing variable) or a Postgres start error, then go to M3.
- **M2 — The VM is lost: build a new one** (review 04 RB-2 order).
  1. Create the VM from the host contract:
     `HCLOUD_TOKEN=<token> infra/provision.sh --deploy-key <path.pub>`.
     - `NOT YET BUILT (B9)`: this currently refuses at preflight (exit 2) because
       rendered user_data exceeds 32,768 bytes; the fix is the 21 E1 decision.
     - The token is taken from the environment only, never as a flag.
  2. Deploy the pinned images through `.github/workflows/deploy.yml`.
     - `NOT YET BUILT (J4)`: the `deploy` job is a stub (`DEPLOY_STEP_IS_STUB`) and
       `compose.yaml` / `deploy.sh` are not in the repository.
     - On boot the worker applies migrations to an empty database, behind the
       advisory lock (OPERATIONS §9.3 rule 3).
  3. Restore the secrets env from the password manager. The canonical store is GitHub
     Environments, rendered to `/etc/fire-watch/secrets.env` (OPERATIONS §8.2).
     Confirm the tier-0 offline copies (VAPID private key, zone-encryption key) are
     reachable. Rule 4 of §5: a restore without them is a failed recovery.
  4. Restore data: M3.
  5. Flip the origin IP in Cloudflare (proxied, so the change is instant). The origin
     hostname is never published (§10 rule 4).
- **M3 — Restore the database.**
  - The restore is `server/dist/app/restore-cli.js` (C6). It always restores into a
    **new scratch database** and never over an existing one. Its name must contain
    `restore`, `scratch` or `drill` as a word, and it cannot be `fire_watch`. Run it
    from the compose directory, on the rebuilt host or on the operator's machine with
    Docker access to the target Postgres. The environment it needs:
    - The **read** credential, as `FIRE_WATCH_RESTORE_R2_{ENDPOINT,BUCKET,ACCESS_KEY_ID,SECRET_ACCESS_KEY}`.
      Never use the VM's write-only backup token (OPERATIONS §6.2 rule 2). The read
      credential stays with the operator and is exported only for this shell.
    - `FIRE_WATCH_RESTORE_AGE_IDENTITY`: the absolute path of the age identity file
      (the tier-0 offline copy).
    - Optional: `PGUSER` (default `postgres`), `FIRE_WATCH_RESTORE_MAINTENANCE_DB`
      (default `postgres`), `FIRE_WATCH_RESTORE_WORKDIR` (default
      `/var/backups/fire-watch/restore`), and `FIRE_WATCH_BACKUP_PG_EXEC` (default
      `docker compose exec -T postgres`; `none` uses the host's client tools).

    ```sh
    cd /srv/fire-watch
    node server/dist/app/restore-cli.js --database=fw_restore_0924
    # a specific night instead of the newest:
    node server/dist/app/restore-cli.js --database=fw_restore_0924 \
      --key=fw-main/daily/2026/09/24/fire-watch-main-20260924T022000Z.dump.age
    ```

    - It restores the newest main artifact, or `--key`, then its personal companion
      from the same night. It checks each download against its recorded sha256 before
      anything is created.
    - A personal artifact at or past its 28-day retention is **never** restored. That
      is the erasure guarantee: an account erased more than 30 days ago cannot come
      back. `--main-only` skips the companion deliberately.
    - The last stdout line is `restore_summary`. Exit `0` means restored and verified.
      Exit `1` means it failed or it has `findings`; read them and do not promote.
      Exit `2` means misconfiguration.
  - Promote the verified scratch database. This is manual and has **not been
    exercised**. Stop the stack, rename the databases, then start the stack. The worker
    applies any newer migrations on boot.

    ```sh
    systemctl stop fire-watch.service
    docker compose exec -T postgres psql -U postgres -d postgres -v ON_ERROR_STOP=1 \
      -c 'ALTER DATABASE fire_watch RENAME TO fire_watch_replaced' \
      -c 'ALTER DATABASE fw_restore_0924 RENAME TO fire_watch'
    systemctl start fire-watch.service
    ```

  - `infra/provision.sh --restore-from` and `/usr/local/sbin/fw-restore-drill` in
    `infra/cloud-init.yaml` are still stubs that exit `64`. Use the CLI above.
  - After any restore, compare row counts against the gauges recorded at dump time
    (OPERATIONS §6.3). Record the migration version.
  - Detections lost inside the RPO window can be fetched again from FIRMS for
    `FIRMS_DAY_RANGE` days. Personal data (accounts, watch zones) cannot be, which is
    why RPO tightens to ≤ 15 min once zones exist (§5 rule 2).
  - `NOT YET BUILT (C6/J1)`: WAL archiving and PITR (`wal-archive` row exists in the
    budget table, `pages: false`).
- **M4 — Compromise suspected** (review 04 RB-3). Rotate the DB password and every
  tier-1 secret in OPERATIONS §8.1, then rebuild as in M2.
  - `NOT YET BUILT (OPERATIONS §8.2 rule 6)`: the one-line rotation procedure per
    secret.
  - `NOT YET BUILT (WP7/I-track)`: if personal data may have been accessed, the
    breach runbook with the КЗЛД 72-hour notification. That is a separate document.

## 4. Communication

- **Operator.** Pages come through fw-alerts (OPERATIONS §3.1). `NOT YET BUILT (C5)`:
  the legs that would raise them.
- **Public.** Users keep a read-only, honestly labelled map from T2 (OPERATIONS §5
  rule 1). Say what is and is not working: the map shows data up to HH:MM; alerts and
  sign-in are paused.
  - `NOT YET BUILT (J5)`: a status-page incident, which must be hosted off the VM.
  - `NOT YET BUILT (founder decision, OPERATIONS §10 rule 2)`: the second announcement
    channel.
- **Alerts.** Alerts queued in the outbox before the loss are lost or kept according
  to the restore point. Never re-send them blindly after a restore. Follow
  [03](03-alert-dispatch-misfire.md) M1 (kill switch) before re-enabling dispatch, and
  review what is pending.

## 5. Recovery verification

1. `/readyz` returns 200. `/api/health/freshness` returns 200, with no paging row
   `critical` after one full budget window.
2. `fire-watch.service` is `active`. No `stopping`/`stopped` lines appear after the
   final start.
3. Row counts match the dump-time gauges, and the migration version is expected.
   The restore CLI runs these checks and reports them in `restore_summary`:
   - `migrations`: every migration in the checkout is applied in the restored database.
   - `personalRows`: on a `--main-only` restore, every personal table is empty (rule 8).
   - `retention`: no personal artifact past the erasure horizon is in the bucket.
   `NOT YET BUILT (C6)`: comparing counts against gauges recorded at dump time. The
   backup does not record per-table gauges yet, so compare `detections` against the
   last known `/api/health` figures by hand.
4. All three monitoring legs are green (review 04 RB-2 last step). `NOT YET BUILT
   (C5)` until provisioned.
5. The T2 object (`FIRE_WATCH_STATIC_SNAPSHOT_URL`) is fresh again: `r2_mirror_age`
   reports `level: "ok"`.
6. Secrets check: VAPID and zone-key presence confirmed, because push and zone
   decryption need them. Zone keys come from `FIRE_WATCH_ZONE_KEY` /
   `FIRE_WATCH_ZONE_KEY_ID`.
7. Dispatch is re-enabled only deliberately ([03](03-alert-dispatch-misfire.md) §5).

## 6. Post-incident note

Record in `WORKLOG.md`:
- the wall-clock minutes to a serving stack; this is the real RTO (OPERATIONS §6.3
  rule 4) and replaces the drill's number
- the artifact id and its timestamp
- the actual data loss window
- whether secrets were restored
- every defect found in this runbook

Any incident that used more than 50% of the API budget (3 h 39 min/month) needs a
published postmortem within 72 h (§4.1 rule 2). Feed the measured RTO back into J2's
drill record and the RISKS watchlist.
