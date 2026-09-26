# 01 — Pipeline stale (feed stall or frozen pipeline)

> **PRE-SEASON DRAFT (2026-09-23).** Not yet exercised on a live incident or on a real
> host. Revise after season 1 and at every pre-season drill (see [README](README.md)).

**Class.** Detections stop reaching the map. Either one upstream feed stops (FIRMS
key, NASA outage, a satellite gone) or the whole pipeline freezes (the worker is dead,
the database is wedged, the snapshot push has stopped). The map keeps rendering, so it
looks healthy while it goes stale. This is the most direct route to R4, the kill
scenario.

**Sources.**
- Review 04 RB-1, "Pipeline stale".
- OPERATIONS §1 (budgets) and §2.2: "RB-1 starts by reading this body". The same line
  is in the `FreshnessRow` doc comment in `packages/contracts/src/freshness.ts`.
- Review 14 H1 (permanent source loss freezes E).
- RISKS R4 and the watchlist rows for S-NPP end of life and MODIS end of life.

## 1. Detection signal

| Signal | Where | Meaning |
|---|---|---|
| `GET /api/health/freshness` returns **500** | health API; body is `FreshnessReport` (`status`, `budgetVersion`, `rows[]`, offending rows first) | A row with `pages: true` is past its critical budget. For FIRMS rows (`firms:viirs:snpp`, `firms:viirs:noaa20`, `firms:viirs:noaa21`) that is 45 min; the warn budget is 20 min. For `snapshot-push` it is 15 min (warn 5 min). |
| Row `state: "unknown"` | same body | This deployment has never seen the row succeed or even attempt. It does not 500. The heartbeat leg is what catches "the job never started". |
| `ingest-cycle` check misses its ping | healthchecks.io via `FIRE_WATCH_HEARTBEAT_URL` | The worker only pings after a cycle that is not `degraded`. A silent check means a dead VM, a dead worker, or every cycle failing. |
| `snapshot-push` check misses its ping | healthchecks.io | The R2 mirror has stopped pushing. The T2 fallback is aging. |
| `{"ingest_cycle": {...}, "degraded": true}` | worker stdout | Every source failed to reach `stored`, or a `status_write_failed` happened. Read `sources[].outcome` (`poll_failed`, `write_failed`, `quarantine_write_failed`, `status_write_failed`), `sources[].error` and `sources[].upstream`. |
| `{"ingest_cycle_failed": {"error", "at"}}` | worker stdout | The cycle threw before it could produce a report. |
| `{"r2_mirror_push_failed": ...}` or `{"r2_mirror_push": ..., "degraded": true}` | worker stdout | The snapshot push is failing. |
| `{"r2_mirror_age": ..., "degraded": true}` | worker stdout | The public T2 object is old. `reason` is one of `stale`, `future_stamp`, `no_age_signal`, `missing`, `unreachable`. |
| `{"heartbeat_failed": {"job", "reason"}}` | worker stdout | The ping itself failed. Treat the matching check as unreliable, not as proof the job is down. |

Gaps in detection:
- `NOT YET BUILT (C5)`: the healthchecks.io checks, UptimeRobot on the snapshot URL
  and `/healthz`, and the Grafana probe of `/api/health/freshness` are not
  provisioned. Nothing turns the 500 into a page today.
- `NOT YET BUILT (J1)`: the end-to-end canary (`canary_round_trip_seconds` is `null`
  in `core/monitoring/meta-alert-params.ts`) and `/api/health/meta`.
- `NOT YET BUILT (C5/J1)`: `fw_ingest_to_visible_seconds`, the freshness SLO metric
  in OPERATIONS §4, is not exposed.

## 2. Triage

Five minutes. The goal is to decide which case applies: one feed, the whole pipeline,
or the push only.

1. **Read the freshness body first** (the host is loopback-only):
   ```sh
   curl -s -w '\n%{http_code}\n' http://127.0.0.1:${FIRE_WATCH_API_PORT:-8080}/api/health/freshness
   ```
   The offending rows come first. For each row note `row`, `lastSuccessAt`,
   `lastDataAt`, `consecutiveFailures`, `state` and `mutedUntil`. If
   `lastSuccessAt` is recent but `lastDataAt` is old, polls are succeeding with zero
   rows. That can be a quiet season, not an outage (§1.1(5)); check `upstream` in the
   cycle line before calling it an incident.
2. **Check readiness separately.** `/readyz` checks only the database. Freshness is
   deliberately never part of readiness (review 02 §5.10, R-13).
   ```sh
   curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:${FIRE_WATCH_API_PORT:-8080}/readyz
   ```
   A non-200 here means the database is down: go to [02](02-vm-loss-and-restore.md)
   if it does not come back after a restart.
3. **Read the source status table** (the same table the freshness rows are built
   from):
   ```sh
   psql "$DATABASE_URL" -c "select source, last_attempt_at, last_success_at, last_data_at, consecutive_failures, last_error, outage_frozen from source_status order by source;"
   ```
4. **Read the last half hour of logs** (`NOT YET BUILT (B9)`: compose service names
   are not fixed yet, so this reads all services):
   ```sh
   cd /srv/fire-watch && docker compose logs --since 30m | grep -E 'ingest_cycle|r2_mirror|heartbeat_failed|starting|stopping'
   ```
5. **Classify.**
   - **All FIRMS rows stale, and the cycle lines show `poll_failed` with an HTTP
     error.** This is upstream or key trouble. Check NASA FIRMS status. A rejected or
     over-quota `FIRMS_MAP_KEY` shows in `error`. The key itself is never logged, only
     its length.
   - **One satellite row stale, the others fine.** The satellite or its NRT product
     is late. Check `upstream` (provider availability) for that source. If NASA
     announces the satellite is gone for good (S-NPP end of life, late 2026), this is
     the permanent-loss case in step M4.
   - **No `ingest_cycle` lines at all.** The worker is not running. Check
     `sudo systemctl status fire-watch.service`, look for `stopping`/`stopped` lines,
     and look for exit code `2` (misconfiguration; the process names every missing
     variable).
   - **`write_failed` / `status_write_failed`.** This is a database problem, not
     upstream. Check `/readyz`, disk space, and the logs of the Postgres container.
   - **Only `snapshot-push` is stale.** R2 credentials, the bucket or the endpoint
     (`FIRE_WATCH_R2_*`) are the problem. Look for a `r2_mirror_disabled` note at
     start-up: if the `FIRE_WATCH_R2_*` group is incomplete, the mirror is off by
     design.

## 3. Mitigation

- **M1 — The worker is dead or wedged.**
  ```sh
  sudo systemctl restart fire-watch.service
  ```
  The unit uses `--wait`, so a stack that crash-loops fails the restart loudly. After
  3 failures in 30 min the unit enters `failed` and `fw-notify-failure` fires. If it
  exits with `2`, fix the env var the log names, then restart again.
- **M2 — The FIRMS key is rejected or over quota.** Put a new MAP_KEY in
  `FIRMS_MAP_KEY` (an env change, see the [README](README.md#shared-facts-every-runbook-assumes)). `NOT YET BUILT (C8 /
  OPERATIONS §8.2 rule 6)`: the written one-line rotation procedure for this secret.
  The key is requested from NASA FIRMS; lead time is in `docs/EXTERNAL-ACCOUNTS.md`.
- **M3 — The upstream is down (NASA outage).** There is nothing to fix locally. The
  worker keeps polling at `FIRE_WATCH_POLL_INTERVAL_MS` (default 10 min) and catches
  up by itself, because the poll window is `FIRMS_DAY_RANGE` days. After it recovers,
  `pnpm -F @fire-watch/server ingest` runs one cycle on demand if you want to confirm
  sooner. Do **not** mute: a mute is a code change (`MUTES` in
  `server/src/core/config/freshness-budgets.ts`, at most 24 h, with a reason) plus a
  deploy, and deploys are `NOT YET BUILT (J4)`.
- **M4 — The source is permanently lost (a satellite is retired).** Review 14 H1: this
  is fixed with a config change, never a mute. A mute expires after 24 h, and a lost
  source blows its budget forever. Retiring a source is a reviewed code change:
  - set its `status` to `'retired'` in `SOURCE_REGISTRY`
    (`packages/contracts/src/sources.ts`)
  - remove it from `MONITORED_SOURCE_IDS` (`packages/contracts/src/freshness.ts`),
    which also removes its budget row
  - write a migration for the matching `sources.status` row (migration 001 seeds
    `firms:modis` as `retired` as the precedent)

  Once retired, the source is no longer polled (`liveFirmsSources()`), and the static
  pass predictor stops counting passes from it
  (`core/lifecycle/static-pass-predictor.ts`; replay scenario "Source retired
  mid-replay"). `NOT YET BUILT (J4)`: the deploy that ships the change. Until then, the
  row stays critical and is known noise; record it in `WORKLOG.md`.
- **M5 — The database is the cause.** If `/readyz` stays non-200 after M1, go to
  [02](02-vm-loss-and-restore.md).
- **M6 — Only the snapshot push is failing.** Check or re-issue the R2 token in the
  `FIRE_WATCH_R2_ENDPOINT` / `_BUCKET` / `_ACCESS_KEY_ID` / `_SECRET_ACCESS_KEY` /
  `_OBJECT_KEY` group (an env change). While T2 is stale, the T0/T1 origin path
  still serves fresh data as long as the VM is up.

## 4. Communication

- **Operator.** The page arrives in fw-alerts (OPERATIONS §3.1) once C5 is
  provisioned; until then, nothing pages (`NOT YET BUILT (C5)`).
- **Public.**
  - The product's own honesty surface is automatic. The payload freshness metadata
    and the frozen-pipeline banner (F4) come from the same `FreshnessReport`, so
    users see "data is N minutes old" without any operator action.
  - `NOT YET BUILT (J5)`: a status-page incident. When J5 exists, post: which feed,
    since when (UTC and local), whether alerts are affected, and the next update
    time.
  - `NOT YET BUILT (founder decision, OPERATIONS §10 rule 2)`: the named second
    announcement channel.
- **Alerts.** A stale feed means no new alerts from that feed. Never announce "no
  fires". Say "no data since HH:MM".

## 5. Recovery verification

1. `/api/health/freshness` returns 200 and no row with `pages: true` is `critical`.
2. At least two consecutive `{"ingest_cycle": ..., "degraded": false}` lines, with
   `outcome: "stored"` for the recovered sources.
3. `source_status.consecutive_failures` is back to 0 for the affected sources.
4. The `ingest-cycle` and `snapshot-push` checks are green on healthchecks.io
   (`NOT YET BUILT (C5)` until provisioned).
5. `r2_mirror_age` lines show `level: "ok"`, or no `r2_mirror_age` degraded lines
   appear.
6. The gap is backfilled. FIRMS serves `FIRMS_DAY_RANGE` days, so a stall shorter
   than that fills itself. For a longer gap, check the archive (`FIRE_WATCH_ARCHIVE_DIR`)
   and record the unrecoverable window in `docs/data/DATASETS.md`.

## 6. Post-incident note

Record in `WORKLOG.md` and, if more than 50% of the freshness budget (~7 h/month,
OPERATIONS §4) was used, write the published postmortem within 72 h (§4.1 rule 2).
Record:
- the first stale timestamp per row
- the detection time and the channel that detected it (was it the page, or was it
  noticed by chance?)
- the root cause
- the window of season data lost for good
- whether any alert was delayed or missed; if so, it is also an R4 review item
- any budget, or any step in this runbook, that proved wrong

Update the RISKS watchlist (RISKS §3).
