# Operations — budgets, SLOs, recovery, secrets, host contract

*Status: normative operations companion to the ADRs. Not an ADR.* Written pre-code
(2026-08) to restore the quantitative operations layer that review 13 finding C2 found
stranded in non-normative reviews. Inputs: review 04 (SRE) in full, review 05 §5.2.4 /
§5.6 (secrets, supply chain), review 02 §5.6 (API surface), reviews 13 §3.2(9) and 14.

**Precedence.** The five ADRs and [`GATES.md`](GATES.md) stay authoritative; this file
completes them with the operational quantities they assume and never restates a
decision they own. Where this file and an ADR appear to conflict, the ADR wins and the
conflict is a defect in this file. This file creates no gates and no ADR decisions;
where a decision is still owed to an ADR, the row says so.

**What this file owns:** per-source freshness budgets; the health/probe surface and its
500-on-stale semantics; three-leg meta-alerting; SLOs and the error-budget policy;
RTO/RPO; backup tiers and the restore drill; the upgrade-trigger table; the secrets
inventory and handling model; the host contract implemented by `infra/cloud-init.yaml`;
deploy safety; the status page; error tracking, log retention and abuse posture.

**Design constraint that shapes every rule below:** one operator, no rotation, no second
pair of hands. Every rule here is executable by one person without daily attention, or
it is not a rule. The product survives an unattended night because ADR-003's T1/T2 read
path degrades automatically and ADR-004's outbox keeps accumulating — not because
someone is watching.

---

## 1. Freshness budgets

### 1.1 What a budget measures

1. A budget is measured on **our last successful fetch** of a source
   (`source_status.last_success_at`, metric `fw_source_last_success_timestamp_seconds`)
   — never on the age of the satellite observation itself. Upstream latency (FIRMS NRT
   1–3 h) is an honesty/UX fact carried in the payload, not a pager condition. Paging on
   observation age would page continuously and correctly change nothing.
2. **Warn** = the miss is no longer explainable by normal cadence jitter (≈2–4 nominal
   cycles, or one grace hour for daily sources). **Critical** = the product is
   materially degraded and a human must act. Critical ≈ 2× warn, rounded to a number a
   tired person can remember.
3. Budgets are **config-as-data**, versioned like clustering parameters (CI-15 pattern),
   and are the single source of the "product's freshness budgets" ADR-003 Decision 2
   makes the client render against. One table, four consumers: the health endpoint
   (§2), the Grafana rules (§3), the payload freshness metadata, and the client's
   staleness banner. The client never hardcodes a threshold; ops and users read the same
   clock.
4. A budget that can never be met again is a **config change, not a silenced alert**. A
   retired satellite or a withdrawn product leaves the paging set by editing this table
   (with the change recorded), never by muting a rule (review 14 H1's operational half).
5. **Zero records is not a freshness failure.** `fw_source_records_fetched_total` flat
   across N polls in season is a separate warn-only anomaly (a plausible night, a
   plausible bug); it never 500s the health endpoint.
6. A known upstream outage may be **muted per source for at most 24 h** through the same
   versioned config, with a reason string; the mute expires automatically and is visible
   on the status page. Mutes are never open-ended and are never implemented by deleting
   a rule.

### 1.2 Per-source budgets

| Source | Nominal cadence | Warn | Critical | Health endpoint | What critical means operationally |
|---|---|---|---|---|---|
| **FIRMS Area API** (VIIRS S-NPP / NOAA-20 / NOAA-21) | poll every 5 min | 20 min | **45 min** | 500 | The detection backbone is blind. Events stop being created and lifecycle decay stalls. Page. |
| **Geostationary FRP** (LSA-502 SEVIRI operational; LSA-509 FCI once live) | 15 min product, ~30 min latency | 30 min | **60 min** | 500 | Sub-hourly corroboration is gone; polar-only cadence returns. GEO never creates events (ADR-002), so the map is thinner, not wrong. Page. |
| **Cloud mask** (MTG/MSG CLM) | 15 min | 45 min | **90 min** | 500 | The E-accumulator loses its cloud gate — the lifecycle ladder cannot honestly reach `no_longer_detected`. Silent honesty failure; page. |
| **EFFIS** (FWI danger + burnt-area perimeters, via our proxy) | daily | 26 h | **50 h** | 500 | Danger layer and the corroboration leg for CER go stale. Proxy serve-stale (ADR-001 A1.2) keeps pixels on screen — which is exactly why silence must page. |
| **Weather context** (ECMWF Open Data; Open-Meteo per the pending source-of-record decision) | 1–6 h | 6 h | 24 h | never 500 | Context only: wind/RH panels degrade, no correctness impact. Dashboard + daily review, never a 3 AM page. |
| **Sentinel-3 SLSTR FRP** (wave 2, once live) | ~daily NRT | 6 h | 12 h | never 500 | Supplementary third polar source. Absence must not wake anyone while it is not the backbone. |

Detection-source rows reuse the canonical strings from the frozen source-id registry
(`GLOSSARY.md` §1) verbatim — the poller and the pager speak the same names. The
remaining rows are identifiers this budget table mints itself, version-stamped by
`freshness_budgets_v1`: the three feeds the registry deliberately leaves unregistered
because they produce no detections (`eumetsat:clm`, `effis:layers`, `weather:context` —
`UNREGISTERED_FEED_IDS` in `packages/contracts`) and the four §1.3 job rows
(`snapshot-push`, `nightly-backup`, `wal-archive`, `effis-refresh`). A monitoring id
names something we fetch or run, never something we observed — it is not a uid input
and can never become one, which is why minting one is a normal versioned-config change
while the registry stays frozen.

### 1.3 Internal job budgets

Scheduled jobs get the same treatment, with **healthchecks.io as the primary detector**
(§3): the job pings after success, so a dead VM and a failed job are both silence.

| Job | Cadence | Warn | Critical | Health endpoint | Primary leg |
|---|---|---|---|---|---|
| **Snapshot push to R2** (the T2 lifeline) | 60 s | 5 min | **15 min** | 500 | healthchecks.io + Grafana |
| Nightly backup (all dump sets uploaded) | daily | 26 h | 50 h | never 500 | healthchecks.io |
| WAL archive lag (from v1, §5) | continuous | 15 min | 60 min | never 500 | Grafana |
| EFFIS layer refresh | daily | 26 h | 50 h | via §1.2 EFFIS row | healthchecks.io |
| Deploy smoke ping | per deploy | — | — | — | healthchecks.io |

Warn at 5 min on the snapshot push is deliberate: it is the exact moment T2 stops
meeting ADR-003's "≤5 min" freshness promise to users who have fallen back to R2.

**One paging condition, one primary leg.** Backup lateness pages through
healthchecks.io and therefore does *not* 500 the freshness endpoint — the endpoint
answers a data-freshness question, and duplicate pages for one fact are how a solo
operator learns to ignore the phone. This deliberately refines review 04 §5.3.3, which
put the backup row in the endpoint's table.

---

## 2. The probe surface and 500-on-stale

### 2.1 Canonical freshness endpoint

| Path | Status | Notes |
|---|---|---|
| **`GET /api/health/freshness`** | **canonical** | The only freshness probe. Named in ADR-003 Consequences and in `IMPLEMENTATION-PLAN.md` WP1. |
| `GET /api/v1/meta/freshness` | **superseded** | Proposed in review 02 §5.6; never built. Do not implement, do not alias. |

Why the health path wins:

1. ADR-003 (accepted) already names `/api/health/freshness`; review 02 is non-normative
   and loses by the corpus's own precedence rule. The ambiguity ends here.
2. It is an **operational contract with our monitors**, not a product API. The pager URL
   must not change because the product API version changes; probe URLs outlive
   API versions and are configured in third-party dashboards that nobody re-edits at
   3 AM.
3. Its siblings `/healthz` and `/readyz` are unversioned for the same reason. Whether or
   not the `/api/v1` prefix convention (review 02 §5.6, pending ADR-003 amendment per
   13 §3.5) lands for product routes, **the probe surface stays unversioned**.
4. A product-facing per-source freshness endpoint is redundant: ADR-003 Decision 2
   already requires freshness metadata inside every payload at every tier. If a
   versioned freshness *view* is ever needed for the v2 B2B surface, it is a new ADR —
   not a revival of the superseded path.

### 2.2 Endpoint contract

| Endpoint | Checks | 200 | Non-200 | Cache |
|---|---|---|---|---|
| `/healthz` | process liveness only, no dependencies | always when the process answers | — | `no-store` |
| `/readyz` | `SELECT 1` on the DB pool | DB reachable | 503 | `no-store` |
| `/api/health/freshness` | every source and job row with a health-endpoint effect in §1 | all rows within warn | **500** when any 500-eligible row exceeds **critical** | `no-store`, CDN bypass rule on `/api/health/*` |

The endpoint's expected set tracks the deployment, not the specification: today it
evaluates only the rows whose pollers exist — the three FIRMS VIIRS sources — and each
remaining §1 row joins the set as its poller or job lands (the LSA SAF feeds, the
EUMETSAT cloud mask, EFFIS and the job rows arrive with TASKS C3/C6/B9). A row missing
from the body today is work not yet built, not silent drift; listing it before anything
writes it would leave every deployment permanently `warn` on rows nobody runs.

Rules:

1. **500-on-stale is the whole trick**: it converts a dumb external uptime probe into a
   data-freshness pager for free. The external leg needs no metrics access, no vendor
   integration and no maintenance.
2. Band mapping: all rows within warn ⇒ `200 {"status":"ok"}`; any row in the warn band
   ⇒ `200 {"status":"warn"}` (dashboards and the status page react; nobody is woken);
   any 500-eligible row past critical ⇒ `500 {"status":"critical"}` with the offending
   rows first in the body. Two row states sit outside that ladder: `unknown` (a row this
   deployment has never even attempted — reported loudly, counted as `warn`, and
   deliberately never a 500, because a fresh database must not roll a first deploy back)
   and `muted` (a §1.1(6) mute in force — visible in the body, never a 500, and likewise
   counted as `warn`, because a known outage nobody is acting on is not health). The
   status code and the body also answer different questions: a non-paging row past its
   critical budget yields `200 {"status":"critical"}` — the wire only goes 500 for
   `pages: true` rows, so a body consumer must never treat `"status": "critical"` alone
   as a page condition.
3. The response body is machine-readable and is the `FreshnessReport` shape owned by
   `packages/contracts` — the same object the payload freshness metadata is built from.
   Top level: `status`, `budgetVersion` (the budget table the verdict was reached under,
   so a page cites its own thresholds), `generatedAt` and `rows`; per row: `row`,
   `state`, `pages`, `lastSuccessAt`, `lastDataAt`, `ageSeconds`, `warnSeconds`,
   `criticalSeconds`, `consecutiveFailures`, `mutedUntil` and `muteReason`. RB-1 starts
   by reading this body, so it must be sufficient to name the failing source without
   opening a dashboard.
4. It must **never be edge-cached**. A cached 500 pins the pager after recovery; a
   cached 200 hides a real outage.
5. It must answer within 500 ms, from a bounded query (≤1 s timeout) against
   `source_status`. A timeout or DB failure is a 500 with a reason — never a hang.
6. It is unauthenticated (probes are dumb), rate-limited, and leaks nothing: no
   hostnames, no versions, no credentials, no raw upstream URLs (§8.3).
7. The external probe pages only after **two consecutive failures** (≥5 min apart) —
   one flaky probe is not an incident.
8. Deploy smoke (§9.3) polls this endpoint; a deploy that cannot make it green rolls
   back.

---

## 3. Three-leg meta-alerting

The monitoring must itself be monitored. Three legs, each on an independent failure
path, all free tier; accounts are wave-0/1 registrations
([`EXTERNAL-ACCOUNTS.md`](EXTERNAL-ACCOUNTS.md)).

| Leg | Kind | Watches | Fires even if… |
|---|---|---|---|
| **Grafana Cloud alerting** | in-process metrics, evaluated off-box | freshness gauges, disk >80%, `fw_notification_queue_oldest_seconds` >600 s, `fw_degradation_tier`==2 >5 min, event-loop lag, SSE rejects, WAL archive lag | the VM is up but the app is sick |
| **healthchecks.io** | dead-man's switch (heartbeat) | every scheduled job, pinged **from job code after success**, with period + grace per §1.3 | the VM, the worker and the metrics agent are all dead — silence is the signal |
| **UptimeRobot** | independent external probe | `/api/health/freshness`, `/healthz`, the homepage, the **R2 snapshot URL**, TLS/domain expiry | Cloudflare, DNS or the origin are broken in ways invisible from inside |

Independence rules:

1. No leg may depend on another leg, on our VM, or on our metrics pipeline for its
   ability to notify. A leg that only works when the box is healthy is not a leg.
2. At least one leg must fire when the VM is **entirely dead** (healthchecks.io,
   UptimeRobot) and at least one when the VM is **alive but wrong** (Grafana, plus the
   freshness endpoint read by UptimeRobot).
3. Each leg has its own notification path to the phone. The Telegram bot used for
   operator alerts is a **different bot** from the user-facing alert bot: a revoked or
   flood-limited user bot must not silence the pager.
4. Ping URLs are secrets (§8.1) — anyone holding one can suppress a dead-man's switch by
   pinging it.
5. Job pings happen **after** the success path commits, never in a `finally`. A job that
   pings on failure is worse than no check.
6. Legs are exercised in the pre-season drill (review 04 Appendix B): kill the worker,
   kill the API, confirm each leg fires within its grace.

### 3.1 The 3 AM path (solo operator)

1. All critical alerts land in one dedicated `fw-alerts` Telegram chat with a custom
   loud sound and an OS-level Do-Not-Disturb exception. At MVP this is genuinely enough
   for one person.
2. **Season mode (June–September):** a critical alert unacknowledged for 10 min
   escalates to a voice call (~€2/mo, four months a year).
3. **Acknowledgement is a deliberate act.** "I saw it and went back to sleep" is a valid
   decision — recorded as an ack with a reason, never a default produced by ignoring the
   phone.
4. Expected response: critical page acknowledged within 30 min in season, best-effort
   out of season. The architecture, not the human, covers the rest: T2 keeps the map
   honest and the outbox keeps alerts durable for the hours nobody answers.

---

## 4. SLOs and the error budget

Internal SLOs, not customer SLAs, until the v2 B2B tier — then SLAs are sold only on the
API/webhook surface, backed by real history. **Availability is adjudicated by the
external probe leg only**; self-reported metrics inform, they never score.

| SLO | Target | Monthly budget | Surfaces covered | Measured by |
|---|---|---|---|---|
| **Map read path** | **99.9%** | 43 min | basemap tiles, style/sprites/glyphs, `/snapshot.json`, EFFIS overlay proxy, the R2 static snapshot, the app shell | UptimeRobot on the R2 snapshot URL + a tile URL |
| **API (interactive)** | **99.5%** | 3 h 39 min | event detail, `/api/v1/client-config`, permalink resolution, auth, watch-zone CRUD | UptimeRobot on `/healthz` + Grafana RED per route |
| **Freshness** | **99% of intervals** | ~7 h | FIRMS data visible ≤10 min after we could have fetched it | `fw_ingest_to_visible_seconds` against §1.2 |
| **Alert dispatch** | p95 ≤60 s push, ≤5 min email | — | decision → provider ack | owned by ADR-004 D9 and gate L-8; restated here only for completeness |
| **SSE (T0)** | **none — best-effort** | — | `/api/v1/stream` | ADR-003 Decision 1: SSE is an enhancement and carries no availability target. A T0 outage is not an incident. |

The 99.9% tier is achievable only because it is **origin-independent by construction**
(ADR-003 T2), not because the VM is reliable. The 99.5% tier is what a single VM with
draining deploys honestly buys. Resist upgrading the wrong one: fire season demands that
reading the map and receiving alerts never depend on one VM being healthy — it does not
demand five nines on the login page.

### 4.1 Error-budget policy (solo-dev version)

1. Budgets are monthly and calendar-aligned. Nothing is carried over.
2. A single incident consuming **>50% of any budget** ⇒ written postmortem within 72 h
   (published, linked from the status page) **and a one-week feature freeze** spent on
   the reliability item the incident exposed.
3. A budget **fully spent** in a month ⇒ freeze until the next month begins.
4. Freeze means: no new user-visible features merge. Always exempt — security fixes,
   data-loss fixes, incident hotfixes, and **ingestion continuity work** (a lost hour of
   season data is unrecoverable; a delayed feature is not).
5. There is no war room, no on-call rotation and no escalation policy beyond §3.1. The
   only two levers a solo operator actually has are automatic degradation and deferring
   work — this policy is the second lever, written down in advance so it is not a mood.
6. **Announced** planned degradation (status-page note ≥24 h ahead) does not consume
   budget. Unannounced degradation always does.
7. Deploys are not incidents on T1 — polling users cannot observe them (ADR-003, §9.3).
   A deploy that *is* observable on T1 is an incident and burns budget.
8. Budget state is reviewed monthly and at each season boundary, alongside the incident
   log. A freeze triggered in season is spent on season stability only.

---

## 5. Recovery objectives

| Objective | Target | Scope | What it requires | Verified by |
|---|---|---|---|---|
| **RTO** | **2–4 h** | total loss of the VM | host config entirely in `infra/cloud-init.yaml` (§9); images pulled from GHCR, never rebuilt during recovery; secrets restorable from the password manager in minutes (§8); Cloudflare-proxied origin so the IP flip is instant; RB-2 written and current | the quarterly drill, timed (§6.3) |
| **RPO — MVP** | **24 h** | through the 2026 shadow season | nightly `pg_dump -Fc`, `age`-encrypted, pushed to R2, heartbeat ping **after** upload; acceptable only while no tier-0 personal data exists and tier-2 data is re-fetchable from the FIRMS archive | drill restore + row counts |
| **RPO — v1** | **≤15 min** | from the **first stored watch zone**, not from a calendar date | continuous WAL archiving (wal-g → R2) with a weekly base backup; archive-lag gauge paging per §1.3; a tested PITR procedure; or managed Postgres with PITR (§7) | drill restore to a point in time |

Rules:

1. RTO governs the **write and interactive** path only. During a VM loss users keep a
   working map: T2 serves the last snapshot from R2 with an honest age label (ADR-003).
   The outage is a read-only, honestly-labeled product — this is why 2–4 h is an
   acceptable target for one person and why the RTO must never be met by improvising a
   faster rebuild instead of maintaining the code-as-config path.
2. The RPO tightening is **triggered by data, not by the calendar**: the day the schema
   can hold a real watch zone (WP7), 24 h stops being acceptable, because a lost watch
   zone is a lost user promise while a lost day of detections is a re-download.
3. Silent RPO decay is the real risk: if WAL archiving stalls, backups look fine and the
   recovery point walks backwards invisibly. Hence the archive-lag budget in §1.3 — its
   critical threshold is the RPO target itself.
4. Recovery of **secrets** is on the RTO path and is drilled with it (§6.3). A perfect
   database restore with an unavailable VAPID key is a failed recovery.

---

## 6. Backups and the restore drill

### 6.1 Data criticality tiers

| Tier | Data | Replaceable? | Protection |
|---|---|---|---|
| **0 — irreplaceable** | users, watch zones (encrypted), push subscriptions, notification audit log / outbox, curated incident log, **VAPID private key**, **zone-encryption key** | No | From v1: WAL archiving or managed-PG PITR, plus an hourly logical dump of just these tables (KBs–MBs); the two keys live in the password manager **and** an offline copy |
| **1 — expensive to lose** | fire events, event↔detection links | Partly — recomputable, but `public_id`s churn, breaking alert history and shared permalinks (ADR-002 I1) | Nightly dump; event ids are durable once any alert references them |
| **2 — re-fetchable** | raw detections, EFFIS layers, weather cache | Yes (FIRMS SP archive backfills history) | Nightly dump is convenience; the documented backfill script is the real protection |

Criticality is **not** the personal-data axis, and §6.2 rule 5 cuts on the other one:
the curated incident log is tier-0 and irreplaceable, but it is editorial work about
fires, not about people, so it rides the long-retention backup set while the tier-0 rows
that identify a subscriber do not.

### 6.2 Cadence, encryption, retention

1. Nightly `pg_dump -Fc`, encrypted with `age`, pushed to R2 via rclone with bucket
   versioning on; the job pings healthchecks.io **after** the last upload completes, so
   silence is an alert (§1.3).
2. R2 backup credentials are **write-only** for the backup path; a compromised VM cannot
   delete history (§8.1).
3. Bucket jurisdiction is EU. Backups contain home locations once watch zones exist —
   encryption at rest is a GDPR requirement, not a nicety (ADR-004 D8).
4. **Retention ceiling.** While the database holds no tier-0 personal data (the 2026
   shadow season), retain 14 daily + 8 weekly — review 04's schedule, a 56-day window,
   and nothing inside it can identify anyone. From the first stored watch zone that same
   schedule becomes a promise we are breaking: **ADR-004 D8**, as settled by its
   amendment A1.3, caps erasure propagation into any artifact holding alert-path
   personal data at **≤30 days**, so a 56-day artifact keeps a deleted user's zone 26
   days past the cap, and a restore — or simply the artifact's continued existence —
   re-materialises data that was supposed to be gone. The cap is not weakened here and
   the 56-day window is not shortened; both survive because the dump stops being one
   artifact (rule 5).
5. **The split — exclusion for the personal tables, pseudonymization for the audit
   trail.** ADR-004 A1.3 permits either mechanism; the two bodies of data need different
   ones, so both are adopted. From WP7 the nightly job writes **two** artifacts from one
   snapshot — a repeatable-read transaction exports it with `pg_export_snapshot()` and
   both `pg_dump` runs are given `--snapshot=<id>` — so the pair is consistent to a
   single instant and restores as a matched pair. The **main set** (`fw-main/`,
   retention unchanged at 14 daily + 8 weekly) holds everything that cannot identify
   a recipient: `detections`, `fire_events`, `event_detections`, `source_status`,
   clustering runs, the versioned config and the curated incident log, plus the
   pseudonymized outbox projection of rule 7. The **personal set** (`fw-personal/`,
   **28 daily, no weeklies**) holds the alert-path personal tables in full fidelity:
   accounts, `watch_zones` (encrypted geometry plus `user_id`), the channel endpoints
   (push subscriptions, Telegram chat ids, verified email addresses), the per-`(zone_id,
   event_id)` alert state, and `alert_outbox` with `user_id`, the endpoint reference and
   `zone_id` intact. Mechanically the main dump excludes **rows, not tables** —
   `pg_dump --exclude-table-data=` for each personal table, so the main artifact still
   carries their DDL — and the personal dump is `--data-only --table=` over exactly the
   same list, nightly from WP7 and hourly from v1 per §6.1's tier-0 row. 28 rather than
   30 because R2 lifecycle sweeps run daily and not to the minute: two days of margin
   means a late sweep is still inside the cap instead of a breach.
6. **Classification is fail-closed and CI-enforced.** The exclusion list is never
   hand-maintained. Every table carries a backup class in a versioned registry
   (config-as-data, the CI-15 pattern), the job generates its `--exclude-table-data`
   arguments from that registry, and a migration that adds a table without a class
   **fails CI**. The default class is `personal`. A deny list kept by memory is exactly
   how a later `subscriber_*` or `delivery_log` table rides into the 56-day window, and
   it fails silently — the artifact looks perfectly healthy and the breach is invisible
   until someone asks for their data back.
7. **The outbox travels pseudonymized in the main set.** The liability-defence artifact
   (ADR-004 D1) must not depend on a 28-day window, so the main dump carries a
   `COPY (SELECT …) TO` projection of `alert_outbox`, taken from the same exported
   snapshot, built from exactly A1.3's *retained verbatim* column list — row id,
   `trigger_type`, `trigger_ref`, `rule_version`, `template_id`, `priority`, `status`,
   the four stage timestamps, channel *type*, the rendered distance **band**, and
   `actor_id`/`approver_id`/`approval_mode` — and nothing else. `user_id` and the
   endpoint reference are absent, and `zone_id` is **dropped, not hashed**: A1.3's
   salted zone hash is unlinkable only once its per-year salt is destroyed, and while
   that year is current the salt still exists, so a hash sitting in a 56-day artifact
   would be relinkable by whoever holds it. What outlives 30 days therefore names a
   decision, never a recipient. The live database remains the 24-month/5-year store
   (A1.3); backups are disaster recovery, not the archive.
8. **What a restore looks like.** A real recovery restores the newest main and personal
   artifacts *of the same night* — plus WAL replay to the target point from v1 — and the
   matched pair reconstructs the database exactly as it was. A restore from a main
   artifact **older than the personal window** brings the personal tables back **present
   and empty**: their DDL is in the artifact, their rows are not, so there is nothing to
   resurrect and the row count is the proof. It is referentially clean by construction,
   because **no table in the main set carries a foreign key into the personal set** —
   the references run one way (`watch_zones` → accounts, `alert_outbox` → `watch_zones`
   and `fire_events`) — and WP7's migrations must preserve that direction; it is an
   invariant, not a happy accident. Restoring past 28 days is therefore explicitly a
   **non-personal recovery** (a bad migration, a clustering regression, a dropped
   partition), and re-hydrating zones or subscriptions from such an artifact is not
   merely forbidden but impossible. That is the point: an erased user cannot be restored
   into existence by a tired operator at 3 AM.
9. **Expiry is a bucket lifecycle rule, and encryption is not erasure.** The backup
   token is write-only (rule 2), so the VM cannot delete history even to enforce the cap
   — the 28-day expiry on `fw-personal/` is an R2 object-lifecycle policy, and it must
   expire **non-current versions** too, because rule 1 turns bucket versioning on and a
   retained non-current version defeats the cap silently. From v1 the same 28-day
   ceiling binds the WAL archive and its base backups (§5): WAL carries every row
   change, so the PITR window is 28 days — far more depth than the ≤15 min RPO needs.
   `age` at rest (rule 3) is a confidentiality control, not an erasure mechanism: we
   hold the key, so an encrypted artifact still contains personal data. Per-artifact
   crypto-shredding was considered and rejected — it moves the promise into key custody,
   where a drill can verify almost nothing, while expiry is observable and one
   `rclone lsjson` over `fw-personal/` is the entire audit.
10. **The 56-day window keeps the job it was given.** It exists for slow-burn corruption
    found weeks later — a bad migration, a clustering-config regression, a data-quality
    "fix" that quietly rewrote history — where the answer is a pre-incident copy of
    `detections`, `fire_events` and the event↔detection links to diff against, and where
    §6.1's tier-1 note bites: `public_id`s churn on recompute, so an old event copy is
    worth real money. None of those questions is about a recipient, and the main set
    answers every one of them exactly as well as the undivided dump did. The only
    capability traded away is the one we were never allowed to have.
11. Personal-data-free artifacts (detections/events partitions) may be retained longer
    than the main set's 56 days; the detection-retention policy itself (keep hot vs
    archive to R2 parquet) is an open question with no owner (review 04 §6 Q6) and is
    not answered here.

### 6.3 Quarterly restore drill

**The drill is the only proof a backup exists.** An untested backup is a rumor.

1. Cadence: quarterly, plus once inside the pre-season fire drill (review 04
   Appendix B). Never against the production database — always a scratch container or a
   scratch VM.
2. Scope: restore the latest artifacts — the main set, and the personal set once it
   exists (§6.2 rule 5) — apply migrations; run the row-count/consistency script against
   the metric gauges recorded at dump time; restore the secrets env file from the
   password manager; boot the stack far enough to answer `/readyz`.
3. Record, every time, in the incident/drill log: date, artifact identifier and
   timestamp, wall-clock minutes to a serving stack, migration version, row counts vs
   expected, secrets restored yes/no, defects found.
4. The recorded wall-clock time is the **real** RTO. If it exceeds 4 h, the gap is the
   next reliability work item at freeze priority (§4.1).
5. A quarter with no recorded drill means backups are **presumed broken** and is treated
   as an open reliability incident until a drill is recorded.
6. From v1 the drill includes a point-in-time restore, not just the latest dump —
   otherwise RPO ≤15 min is untested and therefore untrue.
7. **From WP7 the drill gains a retention leg** — the ops half of A1.3's "asserted by
   the WP7 erasure drill", whose live-database half WP7 owns. Three assertions: the
   oldest object under `fw-personal/`, non-current versions included, is ≤28 days old;
   a main artifact older than 28 days restored into scratch brings every personal table
   back with **zero rows**; and the pseudonymized outbox projection carries none of
   A1.3's destroyed columns. Recorded like every other drill result (rule 3), and a
   missing retention leg is a missing drill (rule 5).

### 6.4 FIRMS SP backfill — the raw-CSV season archive

**This is the "documented backfill script" §6.1's tier-2 row points at.** Raw
detections are re-fetchable only for as long as FIRMS keeps its standard-processing
archive and our key keeps working; the downloaded corpus is what the D7 parameter fit
actually runs over, so it is fetched once, verified by hash, and treated as an artifact
with provenance — not as a cache. Its register entry is DS-1 in `docs/data/DATASETS.md`: the
manifest sha256 at the last `--check`, failed chunks, promotion runs and the consumers
that cite the corpus are recorded there, not here.

1. **What it downloads.** The plan is config-as-data
   (`firms_sp_backfill_2020_2025_v1`, `server/src/core/backfill/backfill-plan.ts`):
   `MODIS_SP`, `VIIRS_SNPP_SP` and `VIIRS_NOAA20_SP` over the `polling_bbox_v1` area
   (`20,39,31,46`), 2020-01-01 through 2025-12-31 inclusive, chunked into ≤10-day
   windows (the Area API's archive maximum) that never cross a calendar-year boundary —
   37 chunks per year, 222 per source, **666 requests total**. NOAA-21 is deliberately
   absent: FIRMS serves it NRT-only, so a NOAA-21 SP spec is *appended* under a new plan
   version when the product appears. The manifest records the plan version and digest,
   and a run refuses to resume into an archive downloaded under a different plan or
   bbox — mixing differently-shaped windows would bias every metric fit across the seam.
2. **Directory layout.** Everything lives under `FIRE_WATCH_ARCHIVE_DIR`; year
   directories are truthful because chunks never straddle years, so the GATES season
   split (fit 2020–2023, calibrate 2024, test 2025) is a directory selection, not a
   filter:

   ```text
   $FIRE_WATCH_ARCHIVE_DIR/
     firms/
       sp-backfill-manifest.json
       MODIS_SP/
         2020/MODIS_SP_2020-01-01_10d.csv
         …
         2025/MODIS_SP_2025-12-27_5d.csv
       VIIRS_SNPP_SP/…
       VIIRS_NOAA20_SP/…
   ```

3. **Manifest format.** `firms/sp-backfill-manifest.json` is pretty-printed JSON with
   sorted keys (human-readable and diffable): a header pinning `manifest_version`,
   `plan`, `plan_digest`, `area` and `polling_bbox_version`, then one entry per chunk
   keyed `<product>/<start-date>/<Nd>` carrying `source`, `product`, `start_date`,
   `day_range`, `path`, `status` (`complete` | `failed` — "in progress" is deliberately
   unrepresentable), `fetched_at`, and for complete entries `bytes` and `sha256`. Files
   are written to a `.partial` name and renamed only when whole, the entry is written
   only after the rename, and the manifest itself is rewritten atomically after **every**
   chunk — so a kill at any instant leaves either a skippable complete chunk or an
   orphan file the next run re-downloads, never a partial file recorded as complete.
4. **Start command.** On the VM (or any box with the disk and the key):

   ```sh
   export FIRMS_MAP_KEY=…                       # §8.1; never in the repo
   export FIRE_WATCH_ARCHIVE_DIR=/var/lib/fire-watch/archive   # absolute path
   pnpm -F @fire-watch/server build && pnpm -F @fire-watch/server backfill
   ```

   Optional: `FIRE_WATCH_BACKFILL_DELAY_MS` (default 5000, bounds 1000–600000) and
   `FIRMS_BASE_URL` (same override the worker takes). One canonical-JSON line per chunk
   goes to stdout; exit 0 means nothing left undone (a clean SIGTERM/Ctrl+C also exits
   0 — interrupting and rerunning is the normal way to operate it), exit 1 means failed
   chunks to retry by rerunning, exit 2 is misconfiguration.
5. **Politeness and resume.** Single-flight — one request in the air, a fixed pause
   between consecutive requests, no parallelism. At the default 5 s spacing the full
   666-request plan takes ~70 minutes and sits far under the 5,000-transactions/10-min
   quota; reruns skip every chunk the manifest vouches for (entry complete **and** the
   file's size matches) without touching the network, so a resume with nothing to do
   finishes in seconds. FIRMS serves rate-limit notices as HTTP 200 text; the runner
   refuses any 200 whose header row is not detection CSV and records it as a failed
   chunk rather than archiving the notice.
6. **Integrity check.** `pnpm -F @fire-watch/server backfill -- --check` re-hashes every
   complete file against the manifest's sha256 — no network, no key needed — and exits
   non-zero on any mismatch or missing file. Run it after the initial download, after
   any disk event, and before handing the corpus to the fit.
7. **Copies.** The primary copy lives on the VM disk under `FIRE_WATCH_ARCHIVE_DIR`.
   Until TASKS C6 lands (season archive to R2), that is a **single copy** and §6.1's
   tier-2 logic is what tolerates it: the corpus is re-fetchable by rerunning this same
   plan. Once C6 syncs it to R2, `--check` before the sync is what keeps a corrupted
   file from silently replacing a good replica.

**Archive layout notes** (dated, per DATA-SOURCES §A9):

- **2026-08-12** — layout v1: `firms/<PRODUCT>/<year>/<PRODUCT>_<start>_<Nd>.csv` plus
  `firms/sp-backfill-manifest.json`, written by plan `firms_sp_backfill_2020_2025_v1`
  over `polling_bbox_v1`. Three SP products, 2020–2025, year-bounded ≤10-day chunks.
- **2026-09-03** — the archive is DS-1 in `docs/data/DATASETS.md` (23 E1); the season-1 live
  record is DS-2 there, with the proposed per-field retention floors (23 E5) that §6.2
  rule 11's schedule may not go below once it has an owner (23 E3).

---

## 7. Upgrade triggers

Nothing is scaled on a hunch. Each row is a measured condition with a predefined action.

**Ordering rule — always in this order:** (1) fix the cache, (2) let the ladder degrade,
(3) resize, (4) split. Hardware is the last lever, never the first. During a spike no
hardware action is taken before confirming auto-demotion happened and that the CDN
hit ratio on `/snapshot.json` and tiles is ≥95%; a regressed cache rule is the far more
likely cause and the only one that scales.

| # | Measured condition | Action | Cost | Notes |
|---|---|---|---|---|
| U-1 | Cache hit ratio on `/snapshot.json` or tiles <95% during elevated traffic | Fix the cache rule. No other action until resolved. | €0 | Origin load is a function of TTL, not audience |
| U-2 | Sustained CPU >70% for 1 h **at T1**, or `fw_event_loop_lag_p99_seconds` >200 ms sustained across a week | VM resize one step (2 vCPU/4 GB → 4 vCPU/8 GB class) | +€5–8/mo | ~1–2 min reboot; T2 covers the gap; never during an active incident |
| U-3 | Disk >80% used | Grow the volume one step; prune Docker logs/images first | +€2–4/mo | The retention/archive policy is a separate open decision (§6.2 rule 11) |
| U-4 | `pg_pool` waiting >0 for 5 min | Separate API and worker pools and cap each before adding hardware | €0 | Contention, not capacity |
| U-5 | Process FD or conntrack usage >60% of the configured maximum (§9) | Raise the tuned constants in `infra/cloud-init.yaml` and redeploy the host config; if already at the tuned values, go to U-6 | €0 | Never raise limits by hand on the box (§9.2) |
| U-6 | Sustained demand for **>5,000 concurrent SSE** as a product need | Split the VM: `api` on one, `worker`+`db` on another (compose already separates them) | +€5–8/mo | **The 5,000 cap itself is ADR-003's hard cap.** Raising it is an ADR-003 amendment gated on re-running the L-2 load battery — never an ops decision |
| U-7 | `fw_notification_queue_oldest_seconds` >600 s at steady state (not during a mass event) | Channel throughput: SES quota raise (L-6), token-bucket and priority tuning — not hardware | €0 | Dispatch is provider-bound, not CPU-bound |
| U-8 | First stored watch zone (v1) | WAL archiving to R2 (RPO ≤15 min), or move to managed Postgres if ops time is scarcer than money | €0 / ~€18/mo | §5 |
| U-9 | Fire-season entry (each June) | Voice escalation on (§3.1); pre-season drill executed | ~€2/mo, 4 months | |
| U-10 | First paying B2B customer with an SLA | Managed Postgres (if not already) + a staging environment + written on-call terms | +€25–40/mo | Also the first moment an external SLA may be sold (§4) |

Deliberately absent: Kubernetes, load balancers, multi-region, autoscaling. A solo-
operated service survives on a small surface.

---

## 8. Secrets

### 8.1 Inventory

| Secret | Lives in | Runtime holder | Blast radius | Rotation |
|---|---|---|---|---|
| **VAPID private key** | password manager **+ offline copy**; secret store for runtime | notification gateway only (ADR-004 D2) | Loss ⇒ every push subscription dies silently. Leak + subscription DB ⇒ fake alerts to the whole audience | **Not routinely.** Rotation invalidates all subscriptions; the re-subscribe flow must exist before v1 |
| **Zone-encryption key** (AES-256-GCM, ADR-004 D8) | password manager **+ offline copy**; secret store for runtime | API | Loss ⇒ watch zones undecryptable. Leak + DB ⇒ home locations | On suspicion only; rotation = re-encrypt pass |
| FIRMS MAP_KEY | GitHub Environments → VM env file | worker (ingest) | Polling stops; abuse gets it throttled | Annual + on suspicion; see §8.3 |
| EUMETSAT consumer key/secret | same | worker | Geostationary feeds stop | Portal-rotatable; exchanged for ~1 h tokens at runtime — only key/secret is stored |
| Telegram **user-alert** bot token | same | notification gateway | Attacker can impersonate the product to users — higher sensitivity than it looks | BotFather; immediate on suspicion |
| Telegram **operator-alert** bot token | same | alerting integrations | Pager can be spoofed or silenced | Separate bot from the user one (§3 rule 3) |
| SES/SMTP credentials | same | notification gateway | Spam from our domain ⇒ deliverability loss | IAM scoped to `ses:SendEmail`; rotate annually |
| R2 token — backups | same | backup job | Backup tampering/deletion | **Write-only** token; rotate annually |
| R2 token — snapshot push | same | worker | Snapshot tampering (T2 poisoning) | Read-write, separate token; rotate annually |
| Cloudflare API token | password manager | deploy/ops scripts only | DNS and cache control | Scoped to zone edit + cache purge; rotate annually |
| Deploy SSH key / GHCR token | GitHub Environments | CI runner | Code execution on the VM | Deploy-only user; environment-scoped; rotate on contributor change |
| DB password | VM env file | api, worker | Local-only (Postgres is never published off-host, §9) | Rotate at each restore drill that suspects compromise |
| Session/cookie signing secret (v1 auth) | GitHub Environments → VM env file | API | Session forgery | Rotate on suspicion; rotation logs everyone out |
| healthchecks.io ping URLs | GitHub Environments → VM env file | worker (job code) | Holder can suppress the dead-man's switch | Regenerate on suspicion |
| Grafana Cloud push token, Sentry DSN, UptimeRobot API key | GitHub Environments | Alloy / app / ops scripts | Telemetry spoofing or loss | Annual |
| Twilio credentials (season) | GitHub Environments | escalation webhook | Call spend; pager spoofing | Seasonal; disable out of season |

### 8.2 Handling model (no Vault, right-sized)

1. **Canonical store:** GitHub **Environments** (`production`). Deploy renders them to
   `/etc/fire-watch/secrets.env`, `root:root`, `0600`, referenced by compose `env_file`.
   Optional later upgrade: a SOPS+age-encrypted env file in the repo (auditable diffs)
   with the age key as the only GitHub secret.
2. **Never** baked into images, never in git, never in CI logs, never in a metric label,
   never in a status or health payload.
3. Human copy in the password manager. **Hardware-key 2FA on every root-of-trust
   account** (GitHub, Cloudflare, registrar, Hetzner, AWS, EUMETSAT, NASA Earthdata),
   with a separate browser profile for infra administration.
4. **Per-environment keys; no dev/prod sharing.** Non-production senders may only reach
   a staff allowlist, enforced inside the notification gateway, not by convention.
5. **Tier-0 offline rule:** the VAPID private key and the zone-encryption key are the
   only two secrets whose loss is unrecoverable — each has an offline copy outside every
   provider account, and its presence is verified in the pre-season drill.
6. Every row in §8.1 has a **one-line rotation procedure** in the runbook and a named
   owner for its quota/expiry alarm (`EXTERNAL-ACCOUNTS.md` standing rule).
7. **Rotation triggers:** suspected exposure, lost or stolen device, contributor
   offboarding, provider breach notice, and the annual pre-season review.
8. A secret that cannot be rotated without user-visible harm (VAPID) is a **design**
   constraint, not an ops one: the mitigating flow must exist before the secret is in
   production use.

### 8.3 The MAP_KEY rule (URL path segments defeat default redaction)

1. The FIRMS Area API carries the key as a **URL path segment**
   (`…/api/area/csv/<MAP_KEY>/<source>/<bbox>/<days>`), not as a header, query parameter
   or body field. Every default redaction list — pino's `redact` paths, Sentry's
   scrubbers, most HTTP-client loggers — is keyed on *names* and therefore **misses it
   entirely**. Treat this as the canonical case, not an exception: any upstream that
   embeds credentials in a path is subject to this rule.
2. Redaction is **by URL shape**: a single `redactUrl()` helper rewrites any path
   segment whose value matches a registered secret (or the registered URL patterns) to
   `***`. The helper is the contract; call sites must not implement their own.
3. HTTP errors are logged through a wrapper that attaches the already-redacted URL. Raw
   client error objects — which carry the full request URL — are never handed to the
   logger or to the error tracker.
4. The same redactor covers: application logs, the error tracker's payloads and
   breadcrumbs, quarantine artifacts for malformed upstream responses, job-heartbeat
   payloads, and the health/status bodies. Metric labels use **templated routes only**
   (cardinality and secrecy have the same fix).
5. **Verification, not intention:** an automated check greps the shipped log stream and
   the error tracker for the live key value — in CI against captured fixtures, and in
   the pre-season drill against real logs. A hit is an incident: rotate the key, then
   fix the call site.

---

## 9. Host contract — what `infra/cloud-init.yaml` implements

`infra/cloud-init.yaml` is the executable form of this section; this section is its
specification. The file now exists (TASKS B9); no production VM has yet been
provisioned from it, so until a fresh VM reaches "migrations applied" from one command
it is a written contract, not a deployed reality.

### 9.1 VM class and topology

| Concern | Contract | Why |
|---|---|---|
| VM class | 2 vCPU / 4 GB (Hetzner CX22/CAX11 class), one instance | Flat cost; the read path is CDN-absorbed so capacity is not the spike plan |
| Region | Falkenstein/Nuremberg | ~25–35 ms RTT to Sofia; near a managed-PG region if the DB ever moves out |
| IPv4 | Keep the address (~€0.60/mo) | GitHub-hosted runners have no IPv6; an IPv6-only origin breaks the deploy path |
| Deployable artifact | one `compose.yaml`: proxy, `api`, `worker` (same image, different entrypoint), `postgres:16-postgis`, Grafana Alloy | The images CI built are what runs; rollback is a tag change |
| Process split | jobs never run inside the API process and never in system cron | netCDF decode, clustering and notification bursts must not share an event loop with SSE/HTTP; scheduling inside the worker lets job code ping healthchecks.io and export metrics |
| Boot | one systemd unit running `docker compose up -d` | Reboot is a non-event |

### 9.2 Host tuning

| Setting | Value | Why | Verified by |
|---|---|---|---|
| Process file descriptors | `LimitNOFILE=131072` (systemd) and `ulimits.nofile: 131072` (compose) | The 1024 default fails `accept()` at ~1,000 viewers | drill; U-5 gauge |
| Reverse proxy | `worker_rlimit_nofile 131072`; `worker_connections 32768` | A proxied connection costs 2 FDs; the 768 default caps at ~380 streams | load battery (L-2) |
| SSE location | `proxy_buffering off`, `proxy_read_timeout 1h`, gzip/compression off, `X-Accel-Buffering: no` | Buffering silently turns "live" into "on flush" | L-2 |
| TLS/HTTP version | HTTP/2 terminated at the edge/proxy | HTTP/1.1 browsers cap at 6 connections per origin; SSE eats one per tab | L-2 |
| Keepalive | SSE comment frame every 25–30 s | Cloudflare kills a proxied response after 100 s without bytes (error 524); doubles as dead-connection detection | L-2 |
| Connection tracking | `net.netfilter.nf_conntrack_max = 262144` | The default fills under long-lived connections and the kernel **silently drops SYNs** — a classic 3 AM mystery | U-5 gauge |
| Container logs | json-file driver with `max-size`/`max-file` caps | Disk exhaustion is the most boring way to lose a season | U-3 |
| Postgres exposure | bound to the compose network only; no published port; firewall allows 80/443 and SSH only | The DB password's blast radius stays local (§8.1) | drill |
| Containers | non-root user; secrets injected at runtime via `env_file` | 05 §5.6.1 | CI/deploy |
| Runtime | Node LTS only; images referenced by immutable tag; previous good tag persisted in `/srv/fire-watch/last_good` | One-command rollback (§9.3) | deploy |
| Host updates | unattended security upgrades; SSH key-only, no password auth, dedicated deploy user | Smallest maintained surface | drill |
| Telemetry | Grafana Alloy scrapes `api` and `worker`, ships metrics and container logs off-box | Leg 1 of §3 must survive the app | §3 rule 6 |

**Configuration-drift rule:** anything configured by hand over SSH and not present in
`infra/cloud-init.yaml` is **presumed lost** at recovery time. The RTO in §5 is only
real because the host is code; the drill in §6.3 is what catches drift.

### 9.3 Deploy safety

1. Deploy is `deploy.sh <git-sha>`: pull images, restart `worker` (advisory lock makes
   an overlap safe), restart `api`, then smoke-test `/healthz` and the canonical
   freshness endpoint in a loop; on failure, redeploy the tag in `last_good`.
2. **Rollback is one command** — `deploy.sh <previous-sha>`. Image-tag deploys are the
   whole reason this is true.
3. Migrations are forward-only, expand/contract, applied by the worker on boot behind
   the advisory lock. Never write a migration the previous image cannot run against.
4. **Deploy freeze:** no deploys while `fw_degradation_tier > 0`, during an active
   major-fire event, or while an error-budget freeze is in force — except hotfixes for
   the incident itself.
5. Drain semantics for SSE are owned by ADR-003 (SIGTERM ⇒ stop accepting, `retry:` +
   close, clients resume via `Last-Event-ID`). T1 users cannot observe a deploy at all;
   if they can, §4.1 rule 7 applies.
6. Post-deploy: ping the deploy heartbeat, annotate the metrics timeline.

---

## 10. Status page

1. **Hosted off our own infrastructure**, always. A status page on the origin VM is
   unavailable in exactly the situation it exists for. MVP: the external probe vendor's
   hosted public status page (zero work, independent probes). Before public launch: a
   static page on R2 with our branding — still origin-independent.
2. It must not share a failure domain with the product where avoidable. An R2/Cloudflare
   page shares DNS with the product; that is accepted at this budget, and the mitigation
   is a **named second announcement channel** (the project's public social/Telegram
   channel), written into the runbook so it is not improvised mid-incident.
3. **What it publishes:** current state of the three probe targets (map read path, API,
   freshness); per-source freshness state using the same bands as §1.2, so users and
   operator read one clock; open incidents with start time, plain-language impact and an
   honest data-age statement; active per-source mutes (§1.1 rule 6); planned maintenance
   ≥24 h ahead; links to postmortems.
4. **What it never publishes:** internal hostnames, metric endpoints, vendor account
   details, or any claim about a specific fire's status. Status-page text is product
   copy: the never-send list and wording contract (`GLOSSARY.md` §3–§5) apply to it
   verbatim.
5. **Who updates it:** the founder, manually; probe state updates itself. In season, a
   critical page that reaches the phone gets a status-page note within 30 min of
   acknowledgement. Incidents consuming >50% of a monthly budget get a published
   postmortem within 72 h (§4.1 rule 2).
6. The app links the status page from every degraded and error surface, so a user who
   sees a stale banner has somewhere to go.

---

## 11. Error tracking, logs, abuse posture

1. **Error tracking** from the first commit (free tier), on both `api` and `worker`,
   with release/sha tagging — and passing through the §8.3 redactor before send.
2. **Logs** are structured and boring: container json-file with rotation caps on the
   host (§9.2), shipped to the hosted log backend with ~14-day retention. Logs are
   telemetry, not an archive: nothing whose loss would matter may exist only in a log
   line.
3. **Abuse posture:** one Cloudflare rate-limiting rule on `/api/*` (the free tier
   includes exactly one) plus a per-IP cap on the SSE route; strict CORS; the probe
   surface rate-limited but unauthenticated (§2.2 rule 6).
4. **Hotlinking the snapshot is a deliberate allowance, not an oversight** — it is
   edge-cached anyway, costs the origin nothing, and reads as free distribution. The
   snapshot URL is versioned so the allowance can be withdrawn without breaking the app.
5. **Email domain:** alerts send from a dedicated subdomain with SPF, DKIM and DMARC
   `p=reject` from the first message ever sent. DNS records are part of the §5 restore
   path — a recovered VM with unrecovered DNS still cannot deliver an alert.
6. Quota alarms are mandatory where a free tier has a cliff (imagery tiles, CDSE, SES,
   R2 operations); each alarm has a named owner in `EXTERNAL-ACCOUNTS.md`.
