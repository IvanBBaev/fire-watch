# Runbooks

> **Status: PRE-SEASON DRAFT (2026-09-23).** Nothing here has been exercised against a
> live incident. There has been no live season and there is no production host yet
> (TASKS B9, J4). Every step names a signal, command, env var or file that exists in
> the repository today. Anything that does not exist yet is marked
> `NOT YET BUILT (task id)` instead of being described as if it worked. Treat each
> runbook as a hypothesis to be corrected by the first season, not as a procedure
> proven under fire.

These runbooks implement the R2 mitigation in [`RISKS.md`](../RISKS.md): one operator
must be able to run the system without paying daily attention to it. They also cover
the WP8 definition of done in [`IMPLEMENTATION-PLAN.md`](../IMPLEMENTATION-PLAN.md),
"runbooks exist for the top 5 incident classes" (task J3). The normative quantities
they rely on (budgets, SLOs, RTO/RPO, host contract) live in
[`OPERATIONS.md`](../OPERATIONS.md). A runbook never restates or overrides those
quantities; it points at them.

## Index

| # | Runbook | Incident class | Derived from |
|---|---|---|---|
| 01 | [Pipeline stale](01-pipeline-stale.md) | The FIRMS/detection feed or the whole pipeline stops moving; the map goes stale | review 04 RB-1; OPERATIONS §1–§2 (§2.2 names RB-1); review 14 H1; RISKS R4 + watchlist |
| 02 | [VM loss and restore](02-vm-loss-and-restore.md) | The VM, its disk or Postgres is lost or corrupted | review 04 RB-2 + RB-3; OPERATIONS §5 (RTO row names RB-2) and §6.3; RISKS R2 |
| 03 | [Alert dispatch misfire](03-alert-dispatch-misfire.md) | Alerts storm, go out wrong, or stall in the outbox | RISKS R4 ("alerts fail closed"); ADR-004 outbox, kill switch and budget G; GATES L-8; OPERATIONS §3, §7 U-7 |
| 04 | [Upstream overlay, quota or licence failure](04-upstream-overlay-quota-licence.md) | EFFIS/GIBS outage or a bad image, a CDSE/ArcGIS quota cliff, or a licence or attribution change | RISKS watchlist (GIBS/EFFIS no SLA, CDSE quota, ArcGIS cliff, NC-licence traps) + R5; review 14 minors; OPERATIONS §1.1(6), §11 |
| 05 | [Traffic surge](05-traffic-surge.md) | A viral fire brings 100–1000× traffic; transport demotes to T1/T2 | review 04 RB-4 (§5.2.4 checklist); RISKS R1; OPERATIONS §7 ordering rule, §9.3 rule 4 |

The five classes are not invented. Review 04 seeds four runbooks (RB-1 pipeline
stale, RB-2 VM loss, RB-3 DB restore, RB-4 spike). RB-2 and RB-3 share one recovery
path (new VM, restore database, redeploy), so they are merged into 02. The two
remaining classes come from the RISKS register: R4, the kill scenario, gives 03, and
the watchlist rows about free-data dependency and licences give 04.

**Naming note.** Review 04 and OPERATIONS refer to these runbooks as `RB-1`…`RB-4`.
`IMPLEMENTATION-PLAN.md` also uses "RB-1/2/3", but there they are founder *recovery
blocks* (planned time off), not runbooks. The mapping for runbooks is: RB-1 → 01;
RB-2 and RB-3 → 02; RB-4 → 05.

**Out of scope here.**
- The personal-data breach runbook (WP7, with the КЗЛД 72-hour notification
  templates) belongs to the I-track legal work and will be a separate document.
- Credential rotation is not a class of its own. OPERATIONS §8.2 rule 6 asks for a
  one-line rotation procedure per secret; those lines are still owed. Runbooks 01 and
  03 cover the few rotations they need.

## Shared facts every runbook assumes

- **Where the signals come from.**
  - The worker and the API write one canonical-JSON line per cycle to stdout. Each
    runbook quotes the exact top-level key it looks for (e.g. `ingest_cycle_failed`).
  - The health API serves `/healthz`, `/readyz` (DB only; freshness is never mixed
    into readiness) and `/api/health/freshness`. On the host it listens on
    `127.0.0.1:${FIRE_WATCH_API_PORT:-8080}`.
- **How the operator is reached.**
  - The worker pings healthchecks.io at `FIRE_WATCH_HEARTBEAT_URL`, once per job.
  - The 3 AM path in OPERATIONS §3.1 is the fw-alerts Telegram chat.
  - `NOT YET BUILT (C5)`: the healthchecks.io checks themselves, the UptimeRobot leg
    and the Grafana leg are not provisioned.
  - `/metrics` (Prometheus text) is built but not deployed: an internal listener on
    `FIRE_WATCH_METRICS_PORT` (off when unset, loopback by default, bearer token file
    on any other bind; never on the public API). The series are listed in
    `server/src/core/observability/metric-catalog.ts`; the Alloy config and Mimir
    rules are in `infra/metrics/`. `NOT YET BUILT (C5)`: a host, a Grafana Cloud
    stack, compose wiring and rule loading. Exported since 2026-09-25: degradation tier
    (0/1 only; T2 is invisible server-side), SSE connections and rejects, event-loop
    lag p99 (both processes), dispatch and R2 mirror loop runs, and dropped alert sends
    (`ttl_expired`, paged by `AlertSendsDropped`). Still not exported: the deferred
    counter and `expired_unapproved` drops (no producer), and WAL archive lag (no WAL
    archiving). See `infra/metrics/README.md`.
  - `NOT YET BUILT (J1)`: voice escalation.
- **Host operations.**
  - The host contract is `infra/cloud-init.yaml`. The stack runs as
    `fire-watch.service`, which runs `docker compose up -d` in `/srv/fire-watch`. The
    deploy user may run `sudo systemctl start|stop|restart|status|is-active|reload-or-restart fire-watch.service`
    and `sudo journalctl -u fire-watch.service`, and nothing broader
    (`/etc/sudoers.d/60-deploy`).
  - `NOT YET BUILT (B9)`: the stack's `compose.yaml` is not in the repository yet, so
    compose service names are not fixed. `docker compose logs --since 30m` (all
    services) is the only log command these drafts use.
  - Configuration comes only from the environment. There is no config file and no
    live toggle surface.
  - **What "env change" means in these runbooks.** The canonical store is GitHub
    Environments (`production`). Deploy renders it to `/etc/fire-watch/secrets.env`
    (`root:root`, `0600`, compose `env_file`; OPERATIONS §8.2 rule 1). So the
    sanctioned path is: change the value in GitHub Environments, then deploy.
  - `NOT YET BUILT (J4)`: that deploy. Until it exists, an emergency env change is a
    root edit of that file followed by `sudo systemctl restart fire-watch.service`.
    - Root SSH is disabled (`disable_root`), so the root edit needs the provider
      console.
    - The same change must be mirrored into GitHub Environments the same day, or the
      next deploy silently reverts it.
  - Exit code `2` at start means misconfiguration. The process names every missing
    variable in a single pass.
- **Deploys.**
  - `.github/workflows/deploy.yml` (manual dispatch, gated by `pnpm run deploy-gate`)
    is the only route to the host (L-17).
  - `NOT YET BUILT (J4/B9)`: its `deploy` job is a stub (`DEPLOY_STEP_IS_STUB`), so no
    runbook step can rely on a real deploy or rollback yet.
  - A code change is therefore not a mitigation available at 3 AM. That includes a
    freshness mute, because mutes are the `MUTES` array in
    `server/src/core/config/freshness-budgets.ts`.
- **Public communication.**
  - `NOT YET BUILT (J5)`: the status page (OPERATIONS §10).
  - OPERATIONS §10 rule 2 also requires a second, named announcement channel. No
    channel has been named yet (founder decision). Until both exist, every "tell the
    public" step says what would be posted and where it will go.

## When to revise

1. **After season 1**, as part of the CP1 retrospective. Rewrite every step that did
   not match what happened. Remove the DRAFT banner only from a runbook that has been
   used in a real incident or in a drill on the real host.
2. **At every pre-season fire drill** (review 04 Appendix B, step 7: "Re-read
   RB-1…RB-4"), and whenever J2's restore drill records a new real RTO.
3. **Within 72 h of any incident** that used more than 50% of an error budget, as part
   of the postmortem required by OPERATIONS §4. Each runbook's post-incident section
   says what to record.
4. **When a `NOT YET BUILT` item lands.** The task that builds it updates the runbook
   step that names it, in the same change.

Per RISKS §3, every post-incident review also updates the RISKS watchlist and gets a
public retrospective (R4 mitigation).
