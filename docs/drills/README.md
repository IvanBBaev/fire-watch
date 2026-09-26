# Drills

Two operational drills. Each one runs as a single command and writes a dated record under
[`records/`](records/). The operator reviews the record, adds notes and commits it. A drill
does not count until its record is committed.

| Drill | Task | Command | Proves |
|---|---|---|---|
| Erasure | TASKS I7 | `pnpm --filter server run erasure-drill -- --environment=staging` | A new account's personal rows are gone, the tombstone and ledger are right, outbox rows are pseudonymized, a write for the erased account is refused, and (optionally) the personal backups expire inside the horizon. ADR-004 D8; OPERATIONS §6.2 rules 5, 7 and 9. |
| Backup/restore + RTO | TASKS J2 | `pnpm --filter server run restore-drill -- --environment=staging --manual-step=…` | A backup taken now can be restored into a scratch database. The restore has the migrations, and its row counts match the gauges the backup recorded. The RTO path fits the 2–4 h target. OPERATIONS §5 and §6.3; runbook [02](../runbooks/02-vm-loss-and-restore.md). |

Build first (`pnpm --filter server run build`). The scripts run `server/dist/`.

## Refusing production

Both drills write data. The erasure drill creates and erases an account. The restore
drill uploads a backup and creates a database. So both refuse a target that does not
name itself non-production:

- The target is the database host, the database name and the bucket (or local store
  directory). They are split into tokens on non-alphanumerics.
- At least one token must be a non-production marker: `staging`, `stage`, `stg`,
  `drill`, `scratch`, `test`, `testing`, `dev`, `ci` or `sandbox`.
- No token may be a production marker: `prod`, `production` or `live`.
- `--confirm-not-production` lifts the first rule only. Use it, for example, for a
  laptop Postgres on `localhost/fire_watch`. The record states the override in its
  `target_check` fact.
  **A production marker is never overridable.**

## Erasure drill (I7)

```sh
DATABASE_URL=postgres://…@db.staging…/fire_watch \
  pnpm --filter server run erasure-drill -- --environment=staging [--audit-backups]
```

| Input | Meaning |
|---|---|
| `DATABASE_URL` | Database to seed and erase. The password is never logged. |
| `FIRE_WATCH_DB_ROLE` | Role to assume. Default: `fire_watch_app`. The drill proves the runtime role's grants are enough. |
| `--audit-backups` | Also list `fw-personal/` and check that every artifact expires by the erasure deadline. Needs the restore-side store settings (`FIRE_WATCH_RESTORE_R2_…` or `FIRE_WATCH_RESTORE_LOCAL_DIR`, plus `FIRE_WATCH_RESTORE_AGE_IDENTITY`), as `restore-cli.ts` reads them. |
| `--record-dir=<dir>` | Where to write the record. Default: `docs/drills/records/`. |

What the drill does:

1. **Seed.** It creates, in one transaction, a `drill-<uuid>@example.invalid` account
   with:
   - 4 zones, a subscription, a session, a link request and 2 confirmations;
   - an alert state and 2 decision-log rows;
   - an `alerts_shadow` row;
   - 2 digest-log rows (a spent `suppress` window and a `hold`; keyed by zone only, so
     seeded even on an empty database);
   - 3 outbox rows (sent, claimed, pending).

   The fire-keyed rows borrow the newest `fire_events` and `events_shadow` rows. On an
   empty database those legs are recorded as not seeded, and the verdict is
   `incomplete`.
2. **Erase.** It runs the production eraser (`pg-account-erasure.ts`).
3. **Verify.** It re-reads every table in the erasure plan and checks:
   - the plan covers every personal table in `table_backup_class`;
   - the tombstone has no email;
   - the ledger row has the deadline;
   - outbox rows are pseudonymized and not deleted;
   - an insert for the erased account is refused (inside a rolled-back transaction).
4. **Audit backups** (only with `--audit-backups`).

What stays after the drill: the account tombstone, its `erasure_requests` ledger row and
the pseudonymized outbox rows. That is exactly what a real erasure leaves. The record
keeps the account id, so these rows can be traced back to a drill.
Do not run the drill against a database that must not hold synthetic tombstones.

## Backup/restore + RTO drill (J2)

```sh
pnpm --filter server run restore-drill -- --environment=staging \
  --manual-step=provision_vm:18 --manual-step=deploy_stack:12 \
  --manual-step=restore_secrets:6 --manual-step=promote_and_boot:9 \
  --manual-step=flip_origin:4
```

**Configuration.** It needs both backup-side and restore-side settings:

- Backup side, as `backup-cli.ts` reads it: `BACKUP_AGE_RECIPIENT`, the store,
  `PGDATABASE` and the rest.
- Restore side, as `restore-cli.ts` reads it: `FIRE_WATCH_RESTORE_…`.

Both sides must point at the same store.

The drill's backup does not ping the nightly heartbeat and does not touch the nightly
gauge ledger. It *does* upload a real `fw-main/daily/…` artifact to the store, which
the normal retention then sweeps.

| Flag | Meaning |
|---|---|
| `--database=<name>` | Scratch database to create. Default: `fw_restore_drill_<YYYYMMDDHHMM>`. It must contain `scratch`, `restore` or `drill`. The drill never restores over an existing database. |
| `--main-only` | Restore only the main artifact. This is the §6.2 rule-8 leg: no personal rows. |
| `--restore-only [--key=<main key>]` | Skip the backup and restore the newest artifact (or `--key`). The artifact's age is recorded. |
| `--manual-step=<id>:<minutes>` | Repeatable. Minutes the operator measured for a manual step on the RTO path. |
| `--record-dir=<dir>`, `--confirm-not-production` | Same as for the erasure drill. |

The RTO path follows runbook 02. Only `restore_database` is timed by the drill:

| Step id | Mode | Runbook |
|---|---|---|
| `provision_vm` | manual | 02 M2.1 |
| `deploy_stack` | manual | 02 M2.2 |
| `restore_secrets` | manual | 02 M2.3 |
| `restore_database` | automated | 02 M3 |
| `promote_and_boot` | manual | 02 M3, §5 |
| `flip_origin` | manual | 02 M2.5 |

**RTO results.** A manual step that is not reported makes the measured time a lower
bound, and the RTO result is `incomplete`. `met` means at most 240 min, the upper end of
§5's 2–4 h. `exceeded` triggers §6.3 rule 4: freeze-priority work.

**Verification** checks that:

- the restore has the migrations the code expects;
- the `main` rows are present, and personal rows appear only when the companion was
  restored;
- every table's row count matches the gauge the backup recorded in its snapshot.

**Cleanup.** The scratch database is left for inspection. Drop it when done:
`dropdb fw_restore_drill_…`.

## Local rehearsal

Both drills can be rehearsed on a laptop against a throwaway PostGIS. This stands in for
staging. It is not a drill: its records stay out of `records/` and count for nothing.
The executable form is
[`server/src/app/drills.integration.test.ts`](../../server/src/app/drills.integration.test.ts),
which runs in the `integration` project:

- It seeds representative data: detections, two fire events, a shadow event, and two
  live accounts with personal rows.
- It runs the restore drill (backup, restore into a scratch database, verification).
- It runs the erasure drill with the backup audit.
- It runs a second restore drill after the erasure. That one checks, as `fire_watch_app`,
  that the restored tombstone still refuses writes (23503) and edits (23514).
- It runs a `--main-only` leg.

It uses the real `age` when `age` and `age-keygen` are on `PATH`, and a pass-through
stand-in otherwise.

**By hand**, with Docker and no host Postgres tools:

1. Start a container whose name carries a non-production token. Migrate it, then seed
   it with the same rows as the test's `REPRESENTATIVE_SEED`. For example:
   `docker run -d --name fw-drill-pg -e POSTGRES_PASSWORD=… -e POSTGRES_DB=fw_staging_drill -p 127.0.0.1:55432:5432 postgis/postgis:16-3.4`,
   then `dbmate --no-dump-schema up` with `DATABASE_URL=…/fw_staging_drill?sslmode=disable`.
2. Run the Postgres tools inside the container:
   `FIRE_WATCH_BACKUP_PG_EXEC="docker exec -i fw-drill-pg"`, `PGUSER=postgres` and
   `PGDATABASE=fw_staging_drill`.
3. `age` always runs on the host. Without it, a two-line wrapper on `PATH` can run
   `age` from an `alpine` image with `apk add age`. On `-d -i <file>`, pass the identity
   in through an environment variable rather than a mount. Create a key pair with
   `age-keygen`. Set `BACKUP_AGE_RECIPIENT` to the public key and
   `FIRE_WATCH_RESTORE_AGE_IDENTITY` to the key file.
4. Set the store. `FIRE_WATCH_BACKUP_LOCAL_DIR` and `FIRE_WATCH_RESTORE_LOCAL_DIR` must
   name the same absolute directory, and that directory's name must carry a drill
   token (`…/drill-bucket`). Also set absolute paths for `BACKUP_STAGING` and
   `FIRE_WATCH_RESTORE_WORKDIR`.
5. Run each drill with `--environment=local-rehearsal`, and point `--record-dir` at a
   scratch directory:
   - `restore-drill` with all five manual steps;
   - `restore-drill --main-only`;
   - `erasure-drill --audit-backups`.
6. Remove the container.

The R2 store is not exercised. `FIRE_WATCH_BACKUP_R2_ENDPOINT` must be `https`, and
there is no local stand-in for R2's SigV4 and lifecycle rules. A local rehearsal also
proves nothing about VM provisioning time: the manual minutes it reports are made up.

**2026-09-26 rehearsal results.** Container on PostGIS 16-3.4 with migrations
001–015, real age 1.2.1 (in a container), local store:

| Run | Exit | Result |
|---|---|---|
| `restore-drill`, all five manual steps | 0 | passed, 8/8 checks, 78 main and 13 personal rows restored, RTO met |
| `restore-drill --main-only` | 3 | incomplete (by design, no manual steps given); 8/8 checks, 0 personal rows |
| `erasure-drill` | 3 | incomplete (by design, no `--audit-backups`); 16 pass, 2 not run |
| `erasure-drill --audit-backups` | 0 | passed, 18/18 checks |

The rehearsal found two defects in `pg-erasure-drill.ts`, both now fixed:

- **The seed predated migration 015.** It wrote a `claimed` outbox row without
  `claimed_at`, which `alert_outbox_claim_has_lease` rejects. Before the fix, the drill
  could not seed on any database at 015.
- **The write probe was too broad.** It counted any error as "refused by the guard".
  A missing grant (42501) would have passed. It now accepts only the tombstone trigger's
  23503.

## Exit codes and output

| Code | Meaning |
|---|---|
| 0 | Passed |
| 1 | Failed, or the RTO was exceeded |
| 2 | Misconfiguration, or a refused target. No record is written. |
| 3 | Incomplete: a leg could not be exercised, or manual steps are missing |

stdout ends with one canonical-JSON `drill_summary` line: verdict, check tally, RTO and
record path. Progress and lifecycle lines go to stderr.

## Records

- File name: `records/<YYYY-MM-DD>T<HHMMSS>Z-<kind>-<environment>.md`. The drill never
  overwrites an existing record.
- Structure: see [`record-template.md`](record-template.md). The drill fills in
  everything except **Operator notes**.
- After a run:
  1. Read the record.
  2. Fill in the notes, including anything you did by hand.
  3. Drop the scratch database.
  4. Commit the record.

  A `failed` or `exceeded` record also gets an entry in the risk register or a task.
