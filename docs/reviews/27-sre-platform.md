# Review 27 — SRE & platform (as built)

*Reviewer role: senior SRE / platform engineer, fifth-round "as built" seat. Date: 2026-10-30. Status: complete.*
*Inputs reviewed: `docs/reviews/04-sre.md`, `docs/reviews/21-platform-release-engineering.md`,
`docs/OPERATIONS.md`, `docs/GATES.md`, `docs/TASKS.md` (Tracks B, C, J and the release-progress
table), `docs/EXTERNAL-ACCOUNTS.md`, `docs/drills/`, `docs/runbooks/`, `infra/` (README,
`cloud-init.yaml`, `provision.sh`, `backup/`, `metrics/`, `deploy-gate/`, `tiles/`),
`.github/workflows/ci.yml` and `deploy.yml`, `server/src/app/worker.ts` and the monitoring core,
`packages/contracts/src/freshness.ts`, the GitHub Actions run history and repo settings (read-only
`gh api`), `git log` to HEAD `ccd541a`, and `du` of the local asset directories. No suite, build or
deploy was run.*

---

## 1. Summary verdict

**CONDITIONAL GO for a May 2027 launch — measured against today, NO-GO.** The operational *design*
is among the best parts of this project, and review 04's structural concerns have all been
answered on paper. However, nothing has yet run anywhere except the founder's laptop and GitHub's
runners. The main CI has been red for five weeks without anyone noticing.

1. **CI on `main` has been red since 2026-09-26** (last green push run 36255108495, `1e0bba7`).
   The nine push runs since then have all failed, for three successive reasons:
   - `pnpm audit` (four runs, 10-02 to 10-22)
   - a stale `types.generated.ts` (10-27, 10-28)
   - an integration test still asserting `source_registry_v1` after V3-P4 moved the registry to v2
     (10-29, 1 of 396 tests failing)

   WORKLOG kept saying "gates green" because local `pnpm verify` excludes both the integration
   suite and the codegen drift gate.
2. **There is no path from zero to a running host.** The repo has:
   - no Dockerfile
   - no `compose.yaml`
   - no `deploy.sh`
   - no reverse-proxy config

   The `deploy` job in `deploy.yml` is an `echo` marked `DEPLOY_STEP_IS_STUB`. Beyond that:
   - No Hetzner, R2, healthchecks.io, UptimeRobot or Grafana Cloud account exists.
   - There is no GitHub Environment (`total_count: 0`).
   - `provision.sh` has never booted a real VM.
3. **Restore has never been proven.** `docs/drills/records/` contains only `.gitkeep`. Both
   `provision.sh --restore-from` and the on-box `fw-restore-drill` still `exit 64`. The drills
   require `--environment=staging`, but OPERATIONS U-10 defers staging until the first paying
   B2B customer.
4. **Paging is thin for a solo operator.**
   - Only 1 of 8 meta-alert keys is armed.
   - There are 6 heartbeat ids for about 18 worker loops.
   - Dispatch, alert evaluation, the digest, identity and webhooks have no stall rule of their own.
   - If `FIRE_WATCH_HEARTBEAT_URL` is unset, the pager stays silent.
5. **Single-VM capacity is unmeasured.** One worker process runs about 18 `runRepeatedly` loops
   and more than ten separate pg pools on a 4 GB CX22, yet Postgres and Node have no memory
   budget anywhere. V2 and V3 keep adding loops (V3-A1 FireSat landed yesterday).
6. **About 2.7 GB of build output and caches lives only on the laptop.** Their only production
   path is an R2 upload, and that upload is blocked on an account that does not exist.
7. **Cost is not the problem.** The MVP bill fits €6–21/mo with room to spare. The risk is that
   three documents quote three different ceilings.

**GO is conditional on:**
- (a) CI green on `main`, staying green, and noticed when it is not (E-1–E-4), by **2026-11-15**
- (b) wave-0 accounts registered by **2027-01-15** (E-6)
- (c) the deploy artefacts built and exercised end to end on a real CX22 by **2027-02-28** (E-5)
- (d) one committed restore-drill record with RTO met, on real R2, by **2027-03-31** (E-7)
- (e) every worker loop observable and the meta-alerts armed before the L-11 pre-season drill
  (E-8)
- (f) a 24 h soak at CX22 shape (E-9)

## 2. Strengths (sound as built)

- **Review 04 was absorbed, not filed.**
  - The inverted transport was fixed: ADR-003 makes edge-cached polling the default and SSE an
    enhancement capped at 5,000.
  - Managed-Postgres free tiers were dropped for VM-local PostGIS plus encrypted backups
    (OPERATIONS §5–§6).
  - Meta-alerting now has three independent legs (§3).
  - Secrets have an inventory (§8.1).
  - Backup, retention and restore have a written contract (§6).

  All four review-04 gaps exist as specification *and* as code.
- **The host contract is executable and honest.** `infra/cloud-init.yaml` with `provision.sh` covers:
  - user, SSH and firewall policy
  - FD limits (`LimitNOFILE=131072`)
  - conntrack (`nf_conntrack_max = 262144`)
  - log caps

  Review 21's size blocker was solved by gzip and base64. The sent payload is 22,184 B against a
  32,768 B cap (32% margin), and it is validated by `infra/user-data/render.test.ts` and by
  cloud-init 22.4.2's own Hetzner decoder. The README says plainly that the end-to-end path is
  untested on a VM.
- **The deploy gate exists as code.** `infra/deploy-gate/` (28 tests) encodes the eight L-12
  boxes and the season calendar. `deploy.yml` runs it after `ci` through `workflow_call`. Today
  a live run is DENIED, which is the intended answer.
- **The monitoring core is well factored:**
  - pure monitors
  - a 2-in-a-row hysteresis evaluator (persisted in migration 036)
  - `/api/health/meta` served only on the bearer-protected metrics listener
  - 20 Grafana rules in `infra/metrics/rules/`
  - a freshness vocabulary shared by pager and banner (`packages/contracts/src/freshness.ts`)
  - advisory loop locks on `ingest`, `alert_evaluation` and `dispatch`
    (`core/ports/loop-lock.ts:20`)
- **The backup and restore tooling has been rehearsed locally.** J2's `restore-drill` CLI passed
  8/8 against a local R2 stand-in with real `age` 1.2.1, and the erasure tombstone survived.
  The rehearsal is covered by `drills.integration.test.ts`.
- **The CI is well engineered.**
  - Actions are pinned to SHAs.
  - Node is pinned through `.nvmrc` (22.23.0).
  - Integration runs on real PostGIS with `FIRE_WATCH_REQUIRE_DOCKER=1`.
  - There is a codegen drift gate and secret-shape greps.

  The pipeline caught every one of the three regressions. Nobody was listening.
- **Runbooks 01–06 exist.** Each step cites a real log line or env var, and every gap is marked
  NOT YET BUILT with its task.
- **The silent Ubuntu 26 migration was absorbed.** Run 40939772318 ran on `ubuntu-26.04` (image
  20261025.179), and every non-integration job passed. The only failure is unrelated to the
  runner.

## 3. Risks & gaps (severity-ranked)

| # | Severity | Risk | Where |
|---|---|---|---|
| R-1 | Critical | `main` red for 5 weeks (9/9 push runs). The current cause is the `'source_registry_v1'` literal in about 10 integration files after migration 060. Whether 060 leaves `types.generated.ts` stale is **unknown**, because the drift step was never reached. | `server/src/**/*.integration.test.ts`; `ci.yml` integration job |
| R-2 | Critical | No deploy artefacts and no host. `deploy` job is a stub. Every wave-0 account is missing. No GitHub Environment or secret. Seven months to launch. | `deploy.yml` (`DEPLOY_STEP_IS_STUB`); `git ls-files infra`; EXTERNAL-ACCOUNTS rows 1–10 |
| R-3 | High | Local "green" ≠ remote green. `pnpm verify` omits integration and codegen. CI triggers only on push, PR and `workflow_call`, so audit advisories and runner drift surface only when someone pushes. No failure notification is routed. | root `package.json` verify; `ci.yml` `on:`; WORKLOG |
| R-4 | High | `main` unprotected on a **public** repo (branch protection 404, 0 rulesets). Force-push or deletion is unguarded. | `gh api …/branches/main/protection` |
| R-5 | High | Restore unproven: 0 drill records. The two restore entry points exit 64. The restore credential is a TODO. "Staging" is required by the drills and L-12 box 6 but deferred by U-10. L-17's deadline ("Sep 2026") has passed. | `docs/drills/records/`; `provision.sh:215`; `cloud-init.yaml:868,888`; OPERATIONS U-10; GATES L-17 |
| R-6 | High | Paging gaps: 7/8 meta-alerts unarmed; 6 heartbeat ids for about 18 loops; no stall rule for dispatch, alert evaluation, digest, identity or webhooks; pager silent if heartbeat URL unset; canary has no deployed probe. | `meta-alert-params.ts`; `freshness.ts:127`; `infra/metrics/rules/`; `worker.ts:247` |
| R-7 | High | Solo operator through Jun–Oct with no second responder, no on-call rota and no relief. L-12 box 2 assumes a second person. | GATES L-12; TASKS J4 open list |
| R-8 | Medium | Single-VM sizing unmeasured: no `shared_buffers`, `max_connections`, `--max-old-space-size` or `mem_limit` anywhere. More than 10 pools across api and worker. One process hosts every loop, so a crash in one loop takes the others down with it. | `worker.ts` (12 `runRepeatedly` call sites, ~18 loops); `cloud-init.yaml`; OPERATIONS §9 |
| R-9 | Medium | Two backup implementations: cloud-init installs the old shell `fw-backup` with rclone, while the Node job is a manual swap. `R2_BUCKET=REPLACE_ME`. WAL archiving is not built, but the `wal-archive` heartbeat id ships. | `infra/backup/README.md`; `cloud-init.yaml:554` |
| R-10 | Medium | RPO ≤15 min is owed at the first stored watch zone (U-8). Zone and account routes already exist (wave C, 2026-09-26). | OPERATIONS §5, U-8 |
| R-11 | Medium | Laptop-only assets: `tiles/` 1.0 G (94,802 files in `tree/`), `tiles-dem/` 624 M (6,420 files), `data/` 1.1 G (`worldcover-cache` 969 M). All gitignored, all single copy. The tile upload is blocked on R2. | `.gitignore:19–21`; `infra/tiles/README.md`; OPERATIONS §6.4(7) |
| R-12 | Medium | The cloud-init contract carries 16 `TODO(OPERATIONS §9.x)` markers. Review 21 E1 ("slim the contract") is still a founder question. A first real boot has never happened. | `cloud-init.yaml`; `infra/README.md` "Honest status" |
| R-13 | Low | Floating `ubuntu-latest` moved to 26.04 on 2026-10-29 without anyone choosing it. | `ci.yml`, `deploy.yml` `runs-on` |
| R-14 | Low | Three cost ceilings: ANALYSIS "≈ €10–30/month", EXTERNAL-ACCOUNTS "€6–21/mo", RISKS R3 "≤ €25/mo". | ANALYSIS:245; EXTERNAL-ACCOUNTS row 5; RISKS R3 |

## 4. Detailed recommendations

**E-1 [MVP] — Restore CI green (R-1).**
- Replace the `'source_registry_v1'` literal in the integration files with an import of
  `SOURCE_REGISTRY_VERSION`, or with the value a fixture row was written under. Grep for
  `source_registry_v1` across `server/src`.
- Run `pnpm codegen` against migrated Postgres 16 and commit the diff if one appears.
- Push, and confirm a green run id.

Owner: Opus. Effort: 1.5 h.

**E-2 [MVP] — One definition of "green" (R-3).**
- Add `pnpm verify:full`, which runs `verify`, then integration on the `fwtest` colima profile,
  then the codegen drift check. Run its steps separately to avoid the known OOM.
- Rule: WORKLOG and memory may say "gates green" only when they cite a GitHub run id.
- Add a `schedule:` trigger (daily 05:00 UTC) to `ci.yml` so audit and runner drift surface
  without a push.
- Route failures to the founder: GitHub notification settings, plus later the Telegram operator
  bot.

Owner: Opus 2 h, founder 0.25 h.

**E-3 [MVP] — Protect `main` (R-4).** Add a ruleset on `main` that:
- blocks force-push and deletion
- requires the `verify`, `integration` and `supply-chain` checks for PR merges

For direct pushes by the solo owner, E-2's notification is the real control. Owner: founder
0.25 h, Opus 0.5 h (ruleset JSON + doc).

**E-4 [MVP] — Pin the runner (R-13).** Replace `ubuntu-latest` with an explicit `ubuntu-26.04`
(validated by run 40939772318), so the next image migration is a deliberate commit. Owner: Opus 0.3 h.

**E-5 [MVP] — Build the deploy path (R-2, R-12).**
- Write the `api`/`worker` Dockerfile (multi-stage, non-root, `node:22` digest-pinned).
- Write `compose.yaml` with the proxy, api, worker, `postgres:16-postgis` and alloy. It must set
  the canonical service names the README owes and `ulimits.nofile`.
- Write `deploy.sh <sha>`: pull GHCR, migrate under the advisory lock, smoke `/healthz` and
  `/api/health/meta`, write `last_good`, roll back on failure.
- Write the proxy config.
- Replace the stub step with an SSH deploy from the `production` Environment.
- Before any account exists, rehearse the whole sequence on a local Debian 12 VM (colima or
  multipass) booted from the rendered user_data. This also closes the "never booted" half of R-12.

Owner: Opus. Effort: 12 h.

**E-6 [MVP] — Wave-0 accounts on a date (R-2).**
- Register Hetzner, Cloudflare (R2 and DNS), healthchecks.io, UptimeRobot, Grafana Cloud and
  Sentry, with hardware-key 2FA. Do it by 2027-01-15.
- Add a `Status / date` column to EXTERNAL-ACCOUNTS so registration is visible.
- Create the GitHub `production` Environment and the secrets listed in §8.1.

Owner: founder 5 h, Opus 0.5 h (doc column).

**E-7 [MVP] — Prove restore (R-5, R-12).**
- Decide that "staging" for drills means a **throwaway CX22 that lives for the drill** (hourly
  billing). Amend L-12 box 6, the drills README and U-10 to say so.
- Implement `--restore-from` by delegating to the Node `restore` CLI, and delete the on-box
  `fw-restore-drill` stub.
- Add the restore-side R2 token row to §8.1.
- Run a full and a `--main-only` drill on real R2, and commit both records.
- Re-date L-17.

Owner: Opus 4 h, founder 3 h.

**E-8 [MVP] — Every loop observable, every pager armed (R-6).**
- Have `runRepeatedly` emit one generic `fw_loop_last_success_timestamp{loop=…}` gauge.
- Add one Grafana rule template: stall at 3× interval, paging only for `ingest`, `dispatch`,
  `alert_evaluation` and `identity`.
- In production mode, make the worker refuse to start without `FIRE_WATCH_HEARTBEAT_URL`.
- Arm the seven meta-alert keys with proposed defaults for the founder to sign.
- Deploy the canary probe as a healthchecks check fed from off-box (the status-page cron).

Owner: Opus 5 h, founder 1 h.

**E-9 [MVP] — Capacity budget and soak (R-8).**
- Write a 4 GB memory budget into OPERATIONS §9:
  - Postgres `shared_buffers` 1 GB
  - `max_connections` equal to the summed pool maxima plus 20%
  - `--max-old-space-size` per Node process
  - compose `mem_limit`
- Add a test that sums the pool constants against `max_connections`.
- Run a 24 h soak at 2 vCPU / 4 GB (colima) with every loop on fixtures plus replay.
- Record RSS, event-loop lag p99 and the pg-pool wait in a dated table.
- Name the threshold at which the worker splits into two processes (ingest/alerting vs context
  feeds).

Owner: Opus 5 h.

**E-10 [MVP] — One backup path (R-9).**
- Install the Node backup job in the deploy pipeline, not in cloud-init. This is review 21 E1
  for the backup half.
- Remove the shell `fw-backup` and rclone from cloud-init.
- Drop `wal-archive` from `HEARTBEAT_JOB_IDS` until E-11 lands, so that no unarmed check
  exists.

Owner: Opus 3 h.

**E-11 [v1] — WAL archiving before the first stored watch zone (R-10).** Use `archive_command`
to R2 with age encryption, the `wal-archive` heartbeat and a lag gauge. Alternatively, buy
managed Postgres if founder hours are scarcer than €18/mo. Owner: Opus 8 h.

**E-12 [MVP] — Asset gravity (R-11).**
- Commit a sha256 manifest (`tiles/tree`, `tiles-dem`, the `data/` caches) under `infra/tiles/`.
- Make `build.sh` reproduce the tree byte-identically from pinned extracts. Verify on a second
  directory.
- On R2 day 1, run `upload-plan --apply` and set immutable cache headers. About 101 k objects is
  well inside R2's free Class A quota.
- Put a second copy of `data/` (the FIRMS archive and caches) on R2 per OPERATIONS §6.4(7).

Owner: Opus 3 h, founder 0.5 h.

**E-13 [MVP] — A season operating model a solo founder survives (R-7).**
- Write `docs/runbooks/00-season-on-call.md` covering:
  - paging hours
  - voice escalation (U-9)
  - the Telegram operator bot as the first channel
  - a named second person with read-only access and kill-switch authority only
  - a published "degraded service" posture for the founder's unavailable hours
- Rewrite L-12 box 2 so that it works with one person.

Owner: founder 4 h, Opus 3 h.

**E-14 [MVP] — Documentation hygiene (R-14, R-5).**
- Make one cost ceiling. €25/mo fixed is recommended, cited from ANALYSIS, EXTERNAL-ACCOUNTS
  and RISKS.
- Reword L-12 box 6 for the E-7 staging decision.
- Re-date L-17 to "before the first unattended poller on the production host".

Owner: Opus 1 h.

**Not recommended:**
- blue-green or a second VM before U-6, which keeps review 21 E10
- Kubernetes or Nomad
- a self-hosted Grafana stack

## 5. SRE & platform deep dive

### 5.1 Zero to a running host — the critical path

| Step | Exists today | Blocked on | Latest date for May 2027 |
|---|---|---|---|
| Accounts (Hetzner, R2, hc, UR, Grafana, Sentry, domain) | none | founder | 2027-01-15 |
| GitHub `production` Environment + secrets | none (`total_count: 0`) | accounts | 2027-01-31 |
| Image build + GHCR push | none (no Dockerfile) | nothing | 2026-12-15 |
| `compose.yaml`, `deploy.sh`, proxy config | none | nothing | 2026-12-15 |
| Local VM rehearsal of cloud-init + deploy | none | E-5 | 2026-12-31 |
| First real `provision.sh` run | dry-run only | accounts | 2027-02-15 |
| Backup to real R2 + restore drill record | local rehearsal only | R2, age key | 2027-03-31 |
| Tiles + DEM uploaded, client switched | built locally | R2 bucket, host name | 2027-03-31 |
| L-11 pre-season drill (5 legs) | not run | all above | 2027-04-30 |

Only the first and sixth rows need the founder. Everything in rows 3–5 can start this week, and
should, because it is the half that will surface surprises. The README already admits that "the
first real provisioning is the test".

### 5.2 Anatomy of five red weeks

| Window | Runs | Failing job | Cause |
|---|---|---|---|
| 10-02 → 10-22 | 37060550718, 38319673396, 39320546516, 39829918069 | Supply chain | `pnpm audit` highs (fastify 5.11). Fixed by `2f14968` on 10-24. 10-02 also failed e2e. |
| 10-27 → 10-28 | 40551528674, 40591069990, 40767718700 | Generated DB types drift | `types.generated.ts` stale. 40591069990 also failed CI-12 timing. Integration passed (38/38, 40/40 files). |
| 10-29 | 40939772318 | Integration | `pg-detection-store.integration.test.ts`: expected `source_registry_v1`, got `source_registry_v2` (V3-P4 `a4bfe50`, migration 060). 1 failed / 395 passed. |

There are three different causes, and each one would have been a 10-minute fix on the day it
appeared. The cost was not the bugs. The cost was:
- a gate the developer does not run locally
- a pipeline that runs only on push (nine runs in five weeks)
- no failure route to a human

HEAD `ccd541a` is two commits ahead of `origin/main`, so the next push will tell us whether 060
also stales the types. E-1 and E-2 close the loop. E-3 stops the worst case, a force-push over a
red history, on a public repo.

### 5.3 Solo operator in a fire season

What wakes the founder at 03:00 today, if the stack were deployed:
- queue age over 600 s (the only armed meta-alert)
- the six heartbeat ids
- 20 Grafana rules

What would *not* wake anyone:
- a hung `alert_evaluation` loop with an empty outbox. Queue age stays 0, so this looks healthy.
- a stalled identity loop (no heartbeat, by founder deferral)
- a digest or webhook loop that throws every cycle
- a worker started without `FIRE_WATCH_HEARTBEAT_URL`

For a product whose core promise is "a stale map is worse than a down map", the pipeline from
evaluation to dispatch needs liveness signals that do not depend on traffic. E-8 achieves this
with one gauge and one rule template rather than per-loop code.

The human side is not designed at all. Jun–Oct is about 140 nights. OPERATIONS §3.1 voice
escalation (~€2/mo) handles *reaching* the founder. Nothing handles the founder being asleep,
ill or on a plane. E-13 does not invent a team. It writes down the degraded posture and gives
one trusted person the kill switch, which runbook 03 already assumes someone can pull.

### 5.4 Single-VM capacity vs loops and V2/V3

`server/src/app/worker.ts` (614 lines) starts about 18 loops in **one** Node process:
- ingest, identity, outlines, lag histograms, monitors, QA weekly report, erasure purge
- dispatch with webhooks, alert evaluation, digest
- EFFIS, weather, passes, Meteoalarm, CEMS, lightning
- two R2-mirror loops

Each loop has its own small pg pool. Named maxima run from 1 to 4, and the API holds about five
more pools. Only three loops take an advisory lock. This shape is fine for CPU: the data cadence
is minutes, and U-2's trigger is sensible. It is untested for **memory and blast radius**:
- No document says how 4 GB is split between Postgres, two Node processes, Alloy, the proxy and
  the page cache.
- No test checks that the summed pool maxima fit `max_connections`.
- An OOM in a context feed (WorldCover joins, lightning) kills alert dispatch, because they share
  one process.

V3 reserves migrations 060–071, and V3-A1 already adds a FireSat ingest. The loop count will
grow. E-9 turns this into a measured number and a named split point, before the first season
rather than during it.

### 5.5 Heavy local assets

| Directory | Size | Files | Production path | Copies |
|---|---|---|---|---|
| `tiles/` (`tree/` 553 M, `extracts/` 315 M, fonts) | 1.0 G | 94,802 in `tree/` | `infra/tiles` `upload-plan --apply` → R2 (G1) | 1 (laptop) |
| `tiles-dem/` | 624 M | 6,420 | same bucket under `dem/terrarium/` (G3, undecided) | 1 |
| `data/` (`worldcover-cache` 969 M, `effis-ba-cache` 106 M) | 1.1 G | — | none (dev caches; backfill archive per §6.4) | 1 |

All three are correctly gitignored (`.gitignore:19–21`). The risk is not the repo. The risk is
that the only copy of a 1.0 G tile build sits on a laptop whose disk filled up once already
(ENOSPC, 2026-09-26). The second risk is that the build cannot be shown to be reproducible.

The DEM source matters here: the EU replica returned 403 on 2026-10-10, so the US bucket is the
source. A re-fetch therefore depends on a third party. E-12 adds a manifest and a second copy.
Storage cost on R2 is negligible at this size, about 3 GB in total.

### 5.6 Cost

| Line | Source of the number | MVP €/mo |
|---|---|---|
| CX22, 2 vCPU / 4 GB, plus IPv4 | OPERATIONS §9.1, EXTERNAL-ACCOUNTS row 1 | inside €6–21 band |
| R2: backups, about 3 GB tiles/DEM, T2 mirror | EXTERNAL-ACCOUNTS; §6.2 | ≈0 at this size (egress free) |
| healthchecks.io (20 checks), UptimeRobot (50), Grafana Cloud, Sentry | free tiers per EXTERNAL-ACCOUNTS | 0 |
| Voice escalation, Jun–Oct | U-9 | ~2 |
| Throwaway drill VM (E-7), about 4 h per quarter | hourly billing | < 0.1 |
| **Upgrade steps that breach €21** | U-2 +€5–8, U-8 managed PG ~€18, U-10 +€25–40 | — |

The MVP fits comfortably. Two points need care:
- **E-8 must not push the heartbeat count past the 20-check free tier.** A generic loop gauge in
  Grafana costs nothing. Twenty healthchecks would cost a plan.
- **U-8's managed-Postgres option alone breaks the €21 upper bound.** This is why E-11 recommends
  self-built WAL archiving and why E-14 should settle on one ceiling.

### 5.7 What changed since reviews 04 and 21

**Review 04 (2026-07-21, pre-code):** the transport inversion, the Postgres budget, meta-alerting
and backup/secrets/deploy were all answered in OPERATIONS and ADR-003, and in code as far as code
can go without a host. The parts not yet built are the deploy half and anything that needs an
account.

**Review 21:**

| Item | Status 2026-10-30 | Evidence |
|---|---|---|
| E1 slim cloud-init contract | **Not decided.** Size pressure removed by gzip+b64, ownership question open | `infra/README.md` "user_data size" |
| E2 deploy.yml + deploy.sh + compose | **Partial.** `deploy.yml` + gate built; deploy step is a stub; no `deploy.sh`/compose/Dockerfile | `deploy.yml`; `git ls-files infra` |
| E3 production env + secrets | **Not done** | `gh api …/environments` → 0 |
| E4 override expiry policy | Encoded in the deploy-gate register, unexercised | `infra/deploy-gate/` |
| E5 protect `main` | **Not done** | protection 404, 0 rulesets |
| E6 restore drill before poller | **Partial.** CLIs built and rehearsed locally; 0 records; entry points exit 64 | `docs/drills/records/` |
| E7 one first-deploy checklist | Partial. `provision.sh` prints the hand-off; no single checklist | `infra/README.md` step 4 |
| E8 L-12/L-15 staging wording | **Not done.** Box 6 still says "staging" | GATES L-12; `deploy.yml` `l12_6_kill_switches` |
| E9 drift job | Not done. No scheduled CI or infra drift check | `ci.yml` `on:` |
| E10 reject blue-green | Held | no second-VM artefacts |

Review 21 got one item done in substance (E2's gate half) and partial progress on three. The
infrastructure has not moved since 2026-10-10 while feature work (V2, V3) continued.

## 6. Open questions for the founder

1. **How should `main` be guarded: a PR-only flow, or direct pushes plus nightly CI and a failure
   notification?** *Recommended:* direct pushes, plus a ruleset that blocks force-push and
   deletion, plus daily scheduled CI with the failure routed to you (E-2, E-3). A PR flow for a
   solo author mostly adds ceremony.
2. **Will you commit to wave-0 accounts by 2027-01-15?** *Recommended:* yes. Every later date in
   §5.1 hangs off it.
3. **Is a throwaway CX22 that lives for the duration of a drill acceptable as "staging"?**
   *Recommended:* yes. Amend L-12 box 6, the drills README and U-10 (E-7).
4. **Review 21 E1: do backup and restore scripts belong in cloud-init or in the deploy
   pipeline?** *Recommended:* the deploy pipeline. cloud-init stays the host contract only (E-10).
5. **Who is the second person in season, and what may they do?** *Recommended:* one named person
   with read-only access and kill-switch authority only. Publish a degraded posture for your
   off-hours (E-13).
6. **What is the watch-zone RPO path: self-built WAL to R2, or managed Postgres at about
   €18/mo?** *Recommended:* WAL to R2 (E-11). It keeps the budget, and the backup crypto already
   exists.
7. **Which cost ceiling holds?** *Recommended:* €25/mo fixed (RISKS R3), quoted identically in
   ANALYSIS and EXTERNAL-ACCOUNTS (E-14).
8. **Should the runner label be pinned?** *Recommended:* yes, to `ubuntu-26.04` (E-4).

## Appendix A

### (a) TASKS rows

- [ ] **R5-SRE-1 — Restore CI green on main.** Spec: review 27 E-1. Writes: `server/src/**/*.integration.test.ts`, `server/src/db/types.generated.ts`. Done when: a push run on `main` is green in all jobs and its run id is recorded in WORKLOG. Est: 1.5 h. Status: open
- [ ] **R5-SRE-2 — One definition of green (verify:full, nightly CI, failure route).** Spec: review 27 E-2. Writes: `package.json`, `.github/workflows/ci.yml`, `README.md`. Done when: `pnpm verify:full` runs integration and the codegen drift check locally; `ci.yml` has a `schedule:` trigger; a deliberately failing scheduled run reaches the founder. Est: 2 h. Status: open
- [ ] **R5-SRE-3 — Protect main with a ruleset.** Spec: review 27 E-3. Writes: `docs/OPERATIONS.md` §9.3 (ruleset recorded). Done when: `gh api repos/IvanBBaev/fire-watch/rulesets` lists a ruleset that blocks force-push and deletion on `main`. Est: 0.5 h. Status: blocked-owner
- [ ] **R5-SRE-4 — Pin the CI runner image label.** Spec: review 27 E-4. Writes: `.github/workflows/ci.yml`, `.github/workflows/deploy.yml`. Done when: no workflow uses `ubuntu-latest` and a green run shows the pinned label. Est: 0.3 h. Status: open
- [ ] **R5-SRE-5 — Build the deploy path and rehearse it on a local Debian 12 VM.** Spec: review 27 E-5. Writes: `Dockerfile`, `infra/compose.yaml`, `infra/deploy.sh`, `infra/proxy/`, `.github/workflows/deploy.yml`, `infra/README.md`. Done when: `DEPLOY_STEP_IS_STUB` is gone; a local VM booted from the rendered user_data runs `deploy.sh <sha>`, passes the smoke, writes `last_good`, and a forced bad deploy rolls back; transcript committed. Est: 12 h. Status: open
- [ ] **R5-SRE-6 — Register wave-0 accounts and the production Environment.** Spec: review 27 E-6. Writes: `docs/EXTERNAL-ACCOUNTS.md` (status/date column). Done when: rows 1–10 carry a registration date; `gh api …/environments` lists `production`. Est: 0.5 h (+5 founder-h). Status: blocked-owner
- [ ] **R5-SRE-7 — Prove restore on real R2 with a throwaway drill VM.** Spec: review 27 E-7. Writes: `infra/provision.sh`, `infra/cloud-init.yaml`, `docs/OPERATIONS.md` §8.1/U-10, `docs/drills/README.md`, `docs/GATES.md` L-12/L-17, `docs/drills/records/`. Done when: `--restore-from` no longer exits 64; two records (full, `--main-only`) with RTO met are committed. Est: 4 h (+3 founder-h). Status: blocked-external
- [ ] **R5-SRE-8 — Every worker loop observable; meta-alerts armed.** Spec: review 27 E-8. Writes: `server/src/app/worker.ts`, `server/src/core/monitoring/meta-alert-params.ts`, `infra/metrics/rules/loops.yaml`. Done when: every `runRepeatedly` loop exports `fw_loop_last_success_timestamp`; one rule pages on the four critical loops; the worker refuses production start without a heartbeat URL (unit test); 8/8 meta-alert keys armed with founder-signed values. Est: 5 h (+1 founder-h). Status: blocked-owner
- [ ] **R5-SRE-9 — 4 GB memory budget and 24 h soak.** Spec: review 27 E-9. Writes: `docs/OPERATIONS.md` §9, `infra/cloud-init.yaml`, `infra/compose.yaml`, a pool-sum unit test. Done when: the budget table is in §9; a test fails if the summed pool maxima exceed `max_connections`; a dated 24 h soak table (RSS, loop-lag p99, pool wait) is committed. Est: 5 h. Status: open
- [ ] **R5-SRE-10 — One backup implementation.** Spec: review 27 E-10. Writes: `infra/cloud-init.yaml`, `infra/backup/README.md`, `packages/contracts/src/freshness.ts`. Done when: cloud-init contains no `fw-backup` or rclone; the deploy path installs the Node timer; `wal-archive` is not in `HEARTBEAT_JOB_IDS`. Est: 3 h. Status: open
- [ ] **R5-SRE-11 — WAL archiving to R2 before the first stored watch zone.** Spec: review 27 E-11. Writes: `infra/backup/`, `docs/OPERATIONS.md` §5. Done when: an integration test restores to a point in time within 15 min of a write. Est: 8 h. Status: blocked-owner
- [ ] **R5-SRE-12 — Asset manifest, reproducible tiles, second copy.** Spec: review 27 E-12. Writes: `infra/tiles/manifest.json`, `infra/tiles/build.sh`, `infra/tiles/README.md`. Done when: a rebuild in a fresh directory matches the committed sha256 manifest; tiles, DEM and `data/` have a second copy on R2. Est: 3 h (+0.5 founder-h). Status: blocked-external
- [ ] **R5-SRE-13 — Season on-call runbook for a solo operator.** Spec: review 27 E-13. Writes: `docs/runbooks/00-season-on-call.md`, `docs/GATES.md` L-12. Done when: the runbook names the paging hours, escalation, second person and degraded posture, and L-12 box 2 is satisfiable by one person. Est: 3 h (+4 founder-h). Status: blocked-owner
- [ ] **R5-SRE-14 — Cost ceiling and gate wording hygiene.** Spec: review 27 E-14. Writes: `docs/ANALYSIS.md`, `docs/EXTERNAL-ACCOUNTS.md`, `docs/RISKS.md`, `docs/GATES.md`. Done when: one ceiling is quoted identically in three places; L-17 carries no past date. Est: 1 h. Status: blocked-owner

### (b) Proposed RISKS §2 / GATES rows

- **RISKS — R-SRE-a "Silent red main".** Likelihood: high (it happened, 5 weeks). Impact: high, because a release would be cut from an untested tree. Mitigation: R5-SRE-1/2/3. Owner: founder.
- **RISKS — R-SRE-b "First boot in season".** The host path has never booted. If the first real provision slips past March, the first incident becomes the first test. Mitigation: R5-SRE-5/6/7. Owner: founder.
- **GATES — L-18 (proposed) "CI truth".** Before any production deploy, the last three push runs on `main` and the last scheduled run are green. Enforced by the deploy-gate box 1 reading the Actions API.
- **GATES — L-17 (amend).** Replace "before the poller runs unattended (Sep 2026)" with "before the first unattended poller on the production host; evidence: a committed drill record".

### (c) 00-summary paragraph

Review 27 (SRE & platform, as built) finds the operational design sound and review 04's gaps
closed on paper. It also finds that nothing has run outside a laptop and GitHub's runners:
- no Dockerfile, compose file or deploy script
- no accounts
- no restore drill record
- a `main` branch that has been red in CI since 2026-09-26 while local gates reported green

Verdict: conditional GO for May 2027, conditional on four things:
- CI green and noticed by mid-November
- accounts by mid-January
- a rehearsed deploy path and a real-VM boot by end of February
- a committed restore drill by end of March

Fourteen rows (R5-SRE-1…14, about 49 Opus hours plus about 14 founder-hours) carry it.

## Appendix B — What was verified, and how

| Claim | Method |
|---|---|
| Last green push run 2026-09-26, 9 failing since | `gh run list --branch main --event push` |
| Failure causes per run | `gh run view <id> --log-failed` on the seven listed runs |
| `source_registry_v1` vs `v2`, 1/396 failing | log of run 40939772318; `git show a4bfe50`; `git grep source_registry_v1 server/src` |
| Runner moved to ubuntu-26.04 | run 40939772318 job metadata (image 20261025.179) vs earlier 24.04 (20261012.601) |
| CI triggers push/PR/workflow_call only | `ci.yml` `on:` block |
| `main` unprotected, repo public, no rulesets/environments | `gh api …/branches/main/protection` (404), `…/rulesets`, `…/environments`, `gh repo view` |
| No Dockerfile/compose/deploy.sh/proxy | `git ls-files` (infra holds only `metrics/config.alloy` among configs) |
| Deploy step is a stub | `grep DEPLOY_STEP_IS_STUB .github/workflows/deploy.yml` |
| user_data 22,184 B vs 32,768 cap | `infra/README.md` table; `render.test.ts` exists |
| Restore entry points exit 64; restore credential TODO | `provision.sh:215`; `cloud-init.yaml:868,888` |
| Zero drill records | `ls docs/drills/records/` |
| 16 `TODO(OPERATIONS §9.x)` markers, `R2_BUCKET=REPLACE_ME` | `grep -n` on `cloud-init.yaml` |
| ~18 loops, 12 `runRepeatedly` call sites, 3 locked | `grep -c runRepeatedly worker.ts`; `loop-lock.ts:20` |
| Pool constants; no memory sizing | `git grep` for pool max constants; `grep -E "max_connections|shared_buffers|mem_limit|max-old-space"` over `infra/` and OPERATIONS → none |
| 6 heartbeat ids; 1/8 meta-alerts armed; pager unset → silent | `freshness.ts:91–127`; `meta-alert-params.ts`; `worker.ts:247` |
| 20 Grafana rules, no per-loop stall rule beyond monitors/ingest | `grep alert: infra/metrics/rules/*.yaml` |
| Staging deferred to U-10 | OPERATIONS §7 table |
| Asset sizes and file counts | `du -sh tiles tiles-dem data data/* tiles/*`; `find … -type f \| wc -l` |
| Assets gitignored | `.gitignore:19–21` |
| Cost figures | ANALYSIS:245; EXTERNAL-ACCOUNTS rows 1–10; RISKS R3; OPERATIONS §7 |
| Review 21 E1–E10 status | each item checked against the evidence column of §5.7 |
| HEAD 2 ahead of origin; migrations 001–036 + 060 | `git rev-list --count origin/main..HEAD`; `ls server/db/migrations` |
