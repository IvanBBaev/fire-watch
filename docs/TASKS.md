# Task register — small, independently executable work items

*Status: working backlog. Derived from the ADRs, `IMPLEMENTATION-PLAN.md`, and the
amendment plans in `reviews/13-second-round-audit.md` §3 and
`reviews/14-corner-cases.md`. The ADRs and `GATES.md` stay authoritative — a task
never overrides them; if executing a task would contradict an ADR, stop and flag
instead of writing.*

## 0. Execution contract (read first, applies to every task)

Each task is written so a single agent can execute it in one session with no
context beyond this file and the task's **Spec** pointers.

1. **Read only the Spec inputs; write only the Writes targets.** If a task seems to
   require touching another file, that is a scope error — flag it, don't do it.
2. **Everything written to files is English** (code, docs, comments, commit
   messages). Bulgarian appears only inside user-facing copy strings explicitly
   marked BG (e.g. GLOSSARY wording tables).
3. **Same-file serialization:** tasks that share a Writes target are grouped under
   one heading and must run one at a time, in the listed order. Tasks in different
   groups are safe to run in parallel.
4. **Never `git commit`/`git push`** unless the dispatching human asks. When the
   repo is first initialized (task B1), AI-harness exclusions go into
   `.git/info/exclude` before anything else.
5. **Done means checked:** on completion, tick the task's checkbox in this file and
   append a short entry to `WORKLOG.md` (worklog format).
6. **Acceptance is testable:** every task has a **Done when** — if you cannot
   demonstrate it, the task is not done.
7. Track A tasks *apply* the recommendations of reviews 13/14 to the corpus.
   Dispatching a Track A task constitutes sign-off for that amendment; the review
   text is the spec, the ADR gets the normative wording.

**Spec shorthand:** `13 §3.1(5)` = review 13, amendment plan §3.1 item 5.
`14 H3` = review 14, finding H3. `IP` = `IMPLEMENTATION-PLAN.md`.

## 1. Dispatch waves

| Wave | When | Tasks | Precondition |
|---|---|---|---|
| 1 | Now (docs only) | all Track A | none — repo not even needed |
| 2 | WP0, Aug 2026 | Track B | git init; wave 1 items A1–A2, A10, A20 done |
| 3 | WP1, Aug–Sep 2026 | Track C | B1–B5 done |
| 4 | WP2, Sep–Oct 2026 | Track D | C1 recording; fixtures gate per CI-1 (as re-scoped by A1) |
| 5 | WP3/WP4, Nov 2026–Jan 2027 | Tracks E, F | D-track events exist |
| 6 | WP5–WP7, Dec 2026–Mar 2027 | Tracks G, H, I | E1 contracts frozen |
| 7 | WP8/WP9, continuous → May 2027 | Tracks J, K | per GATES §3 |

**Not agent-delegable (founder actions, kept visible so they don't vanish):**
Eurostars skip/go decision by 1 Sep 2026 (13 §3.1(8)); external account
registrations incl. FIRMS MAP_KEY and FireSat Early Adopter
(`EXTERNAL-ACCOUNTS.md`); 3–5 volunteer-formation duty-officer interviews in
Q4 2026; Bulgarian lawyer engagement / ЕООД formation / EUTM filing (Wave-2 legal);
T-approver nomination; Project Galileo + Mapbox community applications; news-log
curation (~30 min/week from WP1).

---

## Track A — Documentation amendments (docs only, executable now)

### Group A-GATES — `docs/GATES.md` (serial, in this order)

- [x] **A1 — Re-scope CI-1 + add S10.**
  Spec: 13 §3.1(1). Writes: `GATES.md` §1.
  Reword CI-1 so S1–S6 gate *clustering/identity* code paths (raw-capture ingest is
  gated only by schema/determinism-neutral checks); add S10 to the pre-season
  fixture list. **Done when:** CI-1 no longer blocks WP1 raw capture as written and
  S10 appears alongside S7–S9.

- [x] **A2 — CP1 shadow definitions + checkpoint hygiene.**
  Spec: 13 §3.1(2), B1. Writes: `GATES.md` §4.
  Replace CP1 criteria with shadow definitions (shadow-PCR = events created for
  ≥95% of EFFIS-confirmed ≥50 ha fires vs a synthetic zone grid; shadow-PLB =
  `available_at` → event-visible p95); require a dated one-page evaluation-protocol
  artifact; restore the "≥ 50 ha" qualifier; fix the CP2 "all three/four"
  discrepancy; define partial-miss consequences and per-criterion evidence
  artifacts for CP2/CP3. **Done when:** every CP1 criterion is computable with only
  WP1+WP2 outputs existing.

- [x] **A3 — GATES §3 launch-gate additions.**
  Spec: 13 §3.2(13). Writes: `GATES.md` §3.
  Add L-10 (legal/security launch gate), L-11 (pre-season fire drill), L-12 (season
  deploy regime + 8-checkbox deploy gate); calibration row (ECE ≤ 0.07, per-bucket
  precision); 2027-constellation replay gate (NOAA-20/21+SLSTR-only re-run passes
  §2); assign L-2 to the WP3→WP8 boundary; define the 50× load baseline.
  **Done when:** all six additions present with pass criteria.

- [x] **A4 — GATES §2 metric-scope sentences + fixture register.**
  Spec: 13 §3.4(18); 14 §5. Writes: `GATES.md` §2 + fixture list.
  Add hard-negative pairwise precision (≤20 km, ≤7 d); EFFIS-labeled population
  caveat + size stratification; per-source metrics next to the split rule; eps_geo
  exemption; fix citation (11 §9.1). Register fixtures S11–S16 from 14 §5 with
  their one-line assertions. **Done when:** S11–S16 listed with owners (S11–S12,
  S16 → WP2; S13–S14 → WP6; S15 → WP3 client suite).

### Group A-IP — `docs/IMPLEMENTATION-PLAN.md` (serial)

- [x] **A5 — Re-baseline the plan (B3 capacity fix).**
  Spec: 13 §3.1(3), B3. Writes: `IP`.
  Tier WP1's DoD (FIRMS raw capture early Sep = hard; LSA SAF/CLM/EFFIS by end
  Sep); state the hours/week baseline; publish the single-threaded winter sequence
  and the WP6 split (engine by end Feb, channels during Mar–Apr shadow); move WP5
  self-hosted tiles off the beta path (beta on OpenFreeMap, self-hosted before
  public launch); add the ordered scope-cut list + never-cut list; add recovery
  blocks (late-Dec ≥2 w, post-CP1 1 w, Oct–Nov 2027). **Done when:** the calendar
  table and WP1/WP5/WP6 sections reflect all six changes.

- [x] **A6 — WP2 scope additions.**
  Spec: 13 §3.4(17). Writes: `IP` WP2.
  Add: QA metrics harness + weekly report job; pure alert-decision function pulled
  forward; PassPredictor port + static pass-time table v0; fixture-sourcing item
  (EFFIS BA archive access, S1–S6 fire dates, `availability.json` from measured
  lag); static hot-source mask + solar seed, land-cover prep, cloud-cover join;
  FER backfill replay; minimal CP1 backfill subset with the rest explicitly
  deferred. **Done when:** WP2 lists all seven items in scope/DoD.

- [x] **A7 — WP4 scope/DoD additions (trust surfaces + a11y).**
  Spec: 13 §3.5(23). Writes: `IP` WP4.
  Add About/Methodology + "How fresh?" pages, 3-card onboarding with logged
  disclaimer, OG/share cards, education pack, list view as a11y/low-bandwidth peer
  surface, a11y criteria (200% reflow, 44 px targets, 16 px floor),
  visual-regression suite, place-name localization. **Done when:** WP4 DoD names
  each; share cards noted as CP3's embed artifact.

- [x] **A8 — WP6/WP7 scope additions.**
  Spec: 13 §3.5(24). Writes: `IP` WP6/WP7.
  Add: minimal curation tooling for officially_* states; shadow-diff machinery as
  code (`events_shadow`/`alerts_shadow`, nightly diff report, fixture-refresh
  policy); staging environment provisioned; WP7 DoD enumerates DPIA (incl.
  C-184/20), RoPA, DPAs, LIA, breach runbook with КЗЛД-72h templates, self-serve
  export, auth design cited from 05 §5.4; WP7 starts earlier than Feb 2027.
  **Done when:** all items present; staging named as an explicit deliverable.

- [x] **A9 — GTM plan lines.**
  Spec: 13 §3.5(26). Writes: `IP` (business column or WP10 section).
  Add the review-10 outreach table (WWF, НАДРБ, Meteo Balkans, regional outlets),
  funding calendar (CASSINI Q1 2027), seeding targets, north-star instrumentation
  ("alert-armed weekly users") in WP7/WP8, B2B demo decks from replays, press kit,
  moderator recruitment in WP9 DoD. **Done when:** each GTM item has a WP home.

### Group A-GLOSSARY — `docs/GLOSSARY.md` (serial)

- [x] **A10 — §1 source-id registry + uid canonicalization + intro typo.**
  Spec: 13 §3.1(5,7); 14 H3. Writes: `GLOSSARY.md` intro + §1.
  Freeze the closed v1 source-id table (canonical strings entering
  `detection_uid`; platform derived from the queried source name, never the CSV
  column; status column incl. `retired`). Add a uid-canonicalization subsection:
  exact `acq_ts_iso` shape (FIRMS `HHMM` zero-padded → `THH:MM:00Z`), 5dp rounding
  mode pinned, one product tier polled per source (NRT only — RT re-delivery with
  revised geolocation would mint duplicate uids). Fix intro "CI-10/CI-12" →
  "CI-10/CI-11". **Done when:** registry is a closed table marked frozen-v1 and
  the three canonicalization rules are explicit.

- [x] **A11 — §8 metric formulas restored.**
  Spec: 13 §3.4(19). Writes: `GLOSSARY.md` §8.
  Restore the 06 §5.1.2 formulas (PCR event-based, CER, ZAP, DAR = *Duplicate*
  Alert Rate with formula, FLR, PLB stage budgets); one canonical FER row (False
  Extinguish Rate); define "alertable event". **Done when:** every metric named in
  GATES has a formula here.

- [x] **A12 — §3/§3b/§5 copy contract completion.**
  Spec: 13 §3.5(21); 14 H1/H2 copy needs. Writes: `GLOSSARY.md` §3, new §3b, §5.
  Restore the three BG lifecycle strings verbatim from 12 §4.3 (fixed templates,
  not quoting); add §3b degraded/empty-state table (stale banner, frozen-state
  label, empty-state, cloud-fallback string from 14 H1, dual-fact re-detection
  string from 14 H2) EN+BG in CI-11 scope; specify CI-10 as banned-vocabulary
  minus the §3 negation allowlist with word-boundary + own-voice + BG morphology;
  add BG synonyms to the banned list; add H2 safety copy, agri-burn context tag,
  дка+ha both-units rule as lintable entries; add the defer-always list (road
  closures, cause attribution). **Done when:** no "—" placeholders remain in §3
  and §3b exists with ≥5 rows.

### Group A-ADR2 — `docs/decisions/002-…` (serial)

- [x] **A13 — ADR-002 amendments from review 13.**
  Spec: 13 §3.3(15). Writes: ADR-002.
  Rewrite D7 to staging → sanity checks → partition swap → month-scoped
  re-cluster (uid row-alignment is impossible); add the D1 sentence adjudicating
  dedup as intentional no-op (02 §5.3/§5.11 superseded); supersession note for the
  GEO-only fixture conflict (11 §9.4); ODbL rule (no OSM element IDs in fire-event
  records) in D1; display-window rule (48 h map / 7 d permalink) in D6.
  **Done when:** all five amendments landed as clearly-marked amendment paragraphs.

- [x] **A14 — ADR-002 lifecycle amendments from review 14.**
  Spec: 14 H1, H2, M5, minors. Writes: ADR-002 D1/D6 + config-spec appendix.
  D6: E freezes per-source; `retired` sources leave the expected-overpass set;
  14-day zero-observability fallback → `no_longer_detected` with the §3b cloud
  copy. D6 diagram: officially_* states gain the within-T_LINK re-detection →
  `active` transition (escalation, dual-fact copy). D1: mint-year note for
  `fw-<year>`. New "boundary and tie rules" appendix: GEO-attach equidistant tie →
  lowest cluster id; reignition parent = nearest centroid then oldest; `≤`
  everywhere; MODIS missing scan/track default 1.0×2.0; unclassified-fuel
  reignition window 14 d. **Done when:** the deadlock paths from 14 H1 are closed
  on paper and every tie-break in 14 M5 is pinned.

### Single-file groups (parallel-safe against each other)

- [x] **A15 — ADR-003 amendments.**
  Spec: 13 §3.5(25); 14 M1 + clock-skew minor. Writes: ADR-003.
  Add: auto T0→T1 demotion thresholds as L-2 criteria; T2 flip normative path =
  client-side supervisor with second R2 hostname; RFC 7807 + `/api/v1` +
  rate-limit/CORS conventions. From 14: invariant "every set-membership change is
  a status transition that bumps global seq — no wall-clock filters at
  snapshot-build time"; cursor-mode clients fetch a full snapshot ≥ every 10 min;
  staleness math uses server-time offset (Date header). **Done when:** all six
  landed; the seq invariant is stated as an invariant, not advice.

- [x] **A16 — ADR-004 amendments.**
  Spec: 13 §3.5(22); 14 H4, M3, M4, minors. Writes: ADR-004.
  From 13: trigger_type regains `manual` + actor_id/approver_id; outbox priority
  ordering; retention decision + pseudonymized field list; T-approver fallback;
  ingest-side breaker leg; reignition alert-type decision; zone-default
  sensitivity + quiet-hours default 22:00–07:00. From 14: zone creation seeds
  state `notified_new` (no send) for pre-existing alertable events (D3); deletion
  cancels pending outbox rows in-transaction + dispatch-time liveness re-check
  (D8); minimum zone radius ≥ 2 km vs coarsening (D8); escalation hysteresis
  (watermark rule); deterministic B-budget cutoff + deferred-sends metric;
  nearest-zone template tie-break. **Done when:** all twelve landed; 14 H4's
  seeding rule is normative in D3.

- [x] **A17 — ADR-001 minors.**
  Spec: 14 §3 minors. Writes: ADR-001.
  Glyph ranges: add Greek U+0370–03FF + Latin-Extended to A1.1's self-hosted PBF
  scope; A1.2: EFFIS proxy content sanity (content-type + non-trivial size) before
  caching as good; A1.3: quota-cliff degrade = toggle disabled via
  `/api/client-config`. **Done when:** all three present.

- [x] **A18 — DATA-SOURCES: bbox as config + FIRMS pitfalls + attribution table.**
  Spec: 14 M2; 13 lost-items (01 audit); 13 §3.6(27). Writes: `DATA-SOURCES.md`.
  Polling bbox becomes versioned config-as-data with the rule *bbox ⊇ alertable
  area buffered ≥ 2×ε_max + max zone radius*; restore the FIRMS ingestion pitfall
  table (day_range UTC-calendar trap, acq_time zero-pad, `/api/data_availability/`
  staleness alarm, satellite-code normalization); add the verbatim
  attribution-string table (incl. the Cop-DEM sentence) that WP5's CI-13 will
  assert. **Done when:** bbox has a config name + rule; pitfall table ≥4 rows;
  attribution strings verbatim.

- [x] **A19 — Weather source of record.**
  Spec: 13 §3.3(16). Writes: `DATA-SOURCES.md` + `RISKS.md` (serial with A18 on
  DATA-SOURCES).
  Reclassify Open-Meteo free tier as dev-only; ECMWF Open Data = wave-2 source of
  record (or budget $29/mo from beta); declare the Open-Meteo `cloud_cover` proxy
  sufficient for CP1; schedule the FCI/SEVIRI CLM sidecar for pre-season 2027.
  **Done when:** exactly one source of record named per weather use.

- [x] **A20 — EXTERNAL-ACCOUNTS additions.**
  Spec: 13 §3.1(4), B2. Writes: `EXTERNAL-ACCOUNTS.md`.
  Add monitoring SaaS (healthchecks.io, UptimeRobot, Grafana Cloud/Sentry,
  Twilio-later) to Wave 0/1; move Project Galileo to Wave 0/1 + Mapbox community
  application; Wave-2 rows for ЕООД, lawyer, EUTM; standing rule hardware-key 2FA
  on root-of-trust accounts; "DPA accepted?" column. **Done when:** all five
  changes present.

- [x] **A21 — README + ANALYSIS honesty fix.**
  Spec: 13 §3.1(6), C6. Writes: `README.md` line 3, `docs/ANALYSIS.md` line 3.
  "Real-time" → "Near-real-time (15 min–3 h)…"; reword invariant 2 ("never in our
  own assertive voice; the exact §3 negation strings excepted"). **Done when:**
  the word "real-time" appears nowhere unqualified in either file.

- [x] **A22 — New `docs/OPERATIONS.md` (ops ADR-006).**
  Spec: 13 §3.2(9), C2. Writes: new file `docs/OPERATIONS.md` (+ one link line in
  `docs/decisions/README.md`).
  The single largest restoration: freshness budget table (FIRMS 20/45 min, FCI
  30/60, EFFIS 26/50 h, snapshot 5/15 min) + three-leg meta-alerting +
  500-on-stale semantics; SLOs (99.9/99.5/99%) + solo-dev error-budget policy;
  RTO 2–4 h / RPO 24 h→≤15 min; backup tiers + quarterly restore drill;
  upgrade-trigger table; secrets inventory + handling model; VM class + host
  tuning as `infra/cloud-init.yaml` pointer; status page; canonical freshness
  endpoint path (resolves `/api/health/freshness` vs `/api/v1/meta/freshness`).
  **Done when:** every family listed has a table/rule, and the endpoint-path
  conflict is resolved to one canonical path.

- [x] **A23 — WP1 DoD hardening block.**
  Spec: 13 §3.3(14). Writes: `IP` WP1 (serial with Group A-IP).
  Add: monitoring/backup items (paging + nightly encrypted pg_dump to R2 — B2);
  E1-grade FIRMS CSV validation + quarantine (raw bytes retained) +
  ingest-anomaly breaker leg; sandboxed netCDF worker for LSA SAF;
  ingestion-parity monitor vs the FIRMS map in week one; `available_at` capture +
  NRT-lag histograms; licence text + date pinned into `docs/licenses/` per
  adapter; pino redaction covering MAP_KEY as URL path segment. **Done when:**
  WP1 DoD contains all seven; run after A5 (same file).

---

## Track B — WP0 scaffolding (Aug 2026)

*Landed alongside B2 and ahead of the tracks that consume them:
`packages/contracts` implements the frozen GLOSSARY §1a source-id registry and the
§1b `detection_uid` canonicalization (B4, C1 and D1 import them, never re-derive
them), and `web/src/core/credits.ts` implements the DATA-SOURCES attribution table
verbatim (G5 wires CI-13 onto that registry rather than authoring a new one).*

- [x] **B1 — Repo init + hygiene.** Spec: IP WP0. Writes: repo root.
  `git init`; `.git/info/exclude` gets `CLAUDE.md`, `CLAUDE.local.md`,
  `WORKLOG.md`, `.claude/`, `docs/ai/` *before the first commit*; `.gitignore`,
  `.editorconfig`, LICENSE decision, README kept as-is. **Done when:** first
  commit contains no harness files.
- [x] **B2 — pnpm workspace + TS baseline.** Spec: IP WP0; ADR-005 D3. Needs: B1.
  `packages/contracts` (TypeBox), `server/`, `web/`; TS `strict`,
  `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`,
  `verbatimModuleSyntax`; Vite 8 pinned exact. **Done when:** `pnpm -r typecheck`
  green on the empty workspace.
- [x] **B3 — CI skeleton + supply-chain hardening.** Spec: IP WP0; 13 §3.2(10).
  Needs: B2. Typecheck/lint/test/dependency-cruiser (CI-9 incl. the server import
  matrix + single-writer rule) + bundle-budget placeholder (CI-12); secret
  scanning + push protection, npm audit gate, SHA-pinned Actions, Renovate
  cool-down; CSP/security headers from first deploy config. **Done when:** CI
  green; a seeded boundary violation fails CI-9.
- [ ] **B4 — Migration 001 (one schema owner).** Spec: 13 §3.2(11), C7; ADR-002 D1.
  Needs: B2, A10 (registry frozen first). dbmate SQL-first: `detections`,
  `fire_events`, `source_status`, `watch_zones`, alert-state, `alert_outbox`
  skeletons; append-only grants; kysely-codegen as the only type import path;
  Testcontainers-PostGIS migration up/down test. **Done when:** migrate
  up/down/up green in CI; review DDLs marked non-normative.
- [ ] **B5 — Determinism machinery.** Spec: 13 §3.2(12). Needs: B2.
  Virtual-clock port, fixed batch ordering `(available_at, source, lat, lon)`,
  config-as-data versioning, fixture-harness skeleton (manifest format + replay
  runner stub). **Done when:** a trivial double-run byte-diffs identical in CI.
- [ ] **B6 — Spike F-6 (feature-state on public ids).** Spec: IP WP0; ADR-005 D4.
  Needs: B2. MapLibre `promoteId` + feature-state on `fw-<year>-<base32>` ids
  (not UUIDs — 13 finding); plan B = numeric alias map. **Done when:** written
  outcome doc in `docs/spikes/`.
- [ ] **B7 — Spike F-4 (`transformStyle` idempotence).** Spec: IP WP0; ADR-005 D4.
  Needs: B2. `LayerRegistry.apply()` idempotence across style reloads.
  **Done when:** written outcome doc in `docs/spikes/`.
- [ ] **B8 — FIRMS 2020–2025 SP backfill kickoff.** Spec: IP WP0 week-1. Needs: B1.
  Start the download (long lead time); resumable script + integrity manifest;
  archive layout documented. **Done when:** download running unattended with
  progress logging; feeds D7.
- [ ] **B9 — `infra/cloud-init.yaml` + VM provisioning script.** Spec: A22
  (OPERATIONS). Needs: B1, A22. VM class, host tuning, Postgres+PostGIS install,
  restore path stub. **Done when:** a fresh VM reaches "migrations applied" from
  one command.

## Track C — WP1 ingestion in shadow mode (Aug–Sep 2026) — THE PRIORITY

- [ ] **C1 — FIRMS Area API poller (hard deadline: recording by early Sep).**
  Spec: DATA-SOURCES wave 1; ADR-002 D1; A18 pitfall table. Needs: B4, B5.
  Poller with the versioned bbox config, canonical source ids (A10), full
  provenance + reserved footprint fields, `available_at` capture. **Done when:**
  live rows landing continuously; double-poll idempotent (uid no-op).
- [x] **C2 — CSV validation + quarantine + anomaly breaker leg.** Spec: A23; 01
  §6.1.3. Needs: C1. E1-grade validation (incl. MODIS scan/track NaN guard,
  `available_at < acq_ts` clamp/flag), raw bytes retained on quarantine, batch
  size > N× baseline → quarantine + skip alerting. **Done when:** malformed
  fixture rows quarantine instead of landing.
- [ ] **C3 — LSA SAF LSA-502 adapter + sandboxed netCDF worker.** Spec:
  DATA-SOURCES wave 1; A23. Needs: C1 pattern. SEVIRI FRP + CLM cloud mask;
  netCDF parsing in a sandboxed worker (E3). **Done when:** recording; a poisoned
  netCDF cannot crash the ingest process.
  *Second leg met: the sandbox boundary, the slot planner, the untrusted-payload
  reader and the GEO poll cycle are in and covered — a decoder that segfaults,
  hangs, ignores SIGTERM or floods its pipe is recorded as an outcome and the
  cycle survives. Two blockers remain for "recording": EUMETSAT/LSA SAF
  credentials for the fetch adapter (EXTERNAL-ACCOUNTS), and C3a below — nothing
  yet turns HDF5 bytes into the payload the reader expects.*
- [ ] **C3a — Spike: granule decode implementation.** Spec: 02 R-9; 05 §5.6.2 E3.
  Needs: C3 boundary (landed). h5wasm in-process vs a Python sidecar behind the
  existing `GranuleDecoder` port: LSA-502 HDF5 and LSA-509 netCDF-4, decode time
  per slot, image size, and what each does to the E3 containment argument.
  **Done when:** written outcome doc in `docs/spikes/`, and one real LSA-502
  granule decodes to a `fire-watch.granule.v1` payload.
- [ ] **C4 — EFFIS + weather adapters.** Spec: DATA-SOURCES; ADR-001 A1.2; A19.
  Needs: C1 pattern. FWI + BA perimeters via our proxy (serve-stale + content
  sanity); weather per the A19 source-of-record decision. **Done when:**
  recording with freshness tracked.
- [ ] **C5 — Freshness budgets + health endpoint + meta-alerting.** Spec: A22.
  Needs: C1. Per-source budget table live, canonical freshness endpoint,
  three-leg meta-alerting (healthchecks.io heartbeat), 500-on-stale. **Done
  when:** killing a poller pages within budget.
  *Code legs met: the budget table (`core/config/freshness-budgets.ts`, version
  `freshness_budgets_v1`), the evaluator, `GET /api/health/freshness` on
  `dist/app/api.js` — 500-on-critical, `no-store` + CDN bypass, rate-limited,
  unauthenticated, `/api/v1/meta/freshness` deliberately 404 — plus the
  healthchecks.io heartbeat pinged from the worker after any non-failed cycle
  (failed = zero sources ran, the status write failed, or nothing was stored;
  one source of three failing still pings, deliberately — per-source failures
  are the freshness budgets' job, not the heartbeat's).
  Remaining for "pages within budget": the deployed VM and FIRMS credentials
  (C1), the healthchecks.io check and UptimeRobot monitor themselves
  (EXTERNAL-ACCOUNTS), and the Grafana Cloud leg.*
- [ ] **C6 — Backups + paging (shadow season protection, B2 blocker).** Spec: A22;
  13 B2. Needs: B9. Nightly encrypted pg_dump to R2, restore script tested once,
  uptime paging. **Done when:** a restore onto a scratch VM succeeds; the season
  archive is no longer single-copy.
- [ ] **C7 — NRT→SP partition-swap machinery (stub).** Spec: ADR-002 D7 as amended
  by A13. Needs: B4. Staging load + sanity counts + swap + month-scoped
  re-cluster hook (no-op until D-track exists). **Done when:** dry-run on a
  backfill month passes sanity checks.
- [ ] **C8 — Licence pinning + log redaction.** Spec: A23. Needs: C1–C4.
  `docs/licenses/` per adapter with text + date; pino redact covering MAP_KEY as
  URL path segment. **Done when:** grep for the key in logs finds nothing.
- [ ] **C9 — Ingestion-parity + lag monitors.** Spec: A23. Needs: C1.
  Week-one parity check vs the FIRMS map; NRT-lag histograms feeding
  `availability.json` (D-track fixture input). **Done when:** parity report
  produced; histograms persisted.

## Track D — WP2 clustering & identity engine (Sep–Oct 2026, critical path)

- [ ] **D1 — Incremental clustering core.** Spec: ADR-002 D2/D3 + A14 tie-break
  appendix. Needs: B5, C1. Per-batch algorithm, eps per source, T_LINK, GEO
  attach-only with pinned tie-break. **Done when:** S1/S4/S5 fixtures pass;
  double-run byte-identical (CI-2).
- [ ] **D2 — Merge semantics + `migrateAlertState`.** Spec: ADR-002 D4, I2/I3.
  Needs: D1, B4 (alert-state tables exist). Survivor rule, tombstones + path
  compression, same-transaction alert-state migration, 20 km hull →
  `needs_review`. **Done when:** S2 passes; I2/I3 property tests green.
- [ ] **D3 — Reignition linking.** Spec: ADR-002 D5 + A14 defaults. Needs: D1.
  Within/past-T_LINK paths, fuel windows incl. unclassified default, parent
  tie-break, `possible_reignition` + `related_event_id`. **Done when:** S6
  passes.
- [ ] **D4 — Lifecycle E-accumulator + PassPredictor.** Spec: ADR-002 D6 as
  amended by A14; A6. Needs: D1, C3 (cloud mask), C9 (lag data).
  PassPredictor port + static pass-time table v0 validated against WP1 data;
  per-source weights, cloud gating, per-source freeze, retired-source exclusion,
  14-day fallback, officially_* re-detection transition. **Done when:** S7, S8,
  S11, S12 pass.
- [ ] **D5 — Golden fixture suite S1–S6.** Spec: GATES CI-1 (as re-scoped by A1);
  A6 fixture-sourcing. Needs: B5. Pin fire dates from EFFIS BA archive, build
  `availability.json`, author manifests + expected outputs. **Done when:** CI-1
  wired: clustering merges blocked unless S1–S6 green.
- [ ] **D6 — Fixture suite S7–S16.** Spec: A4 register. Needs: D5 harness.
  S7–S10 (per GATES) + S11 (retired source), S12 (officially_* re-detection),
  S16 (bbox-edge fire); S13–S15 stubs handed to their owner tracks. **Done
  when:** all pre-season fixtures green or explicitly stubbed with owner noted.
- [ ] **D7 — Parameter fit.** Spec: GATES §2; ADR-002 D2. Needs: B8 (backfill),
  D1. Grid search (~600 configs) vs EFFIS BA labels; plateau rule; fitted params
  land as versioned config-as-data. **Done when:** GATES §2 acceptance thresholds
  met and the chosen config committed with its fit report.
- [ ] **D8 — QA metrics harness + weekly report.** Spec: A2 (shadow definitions);
  A11 formulas. Needs: D1. Shadow-PCR/PLB + FER/FLR/DAR computed from the shadow
  pipeline; weekly job. **Done when:** one real weekly report generated.
- [ ] **D9 — Pure alert-decision function (pulled forward).** Spec: ADR-004 D4
  gating as amended by A16. Needs: D1. Side-effect-free decision fn over
  (event, zone, config) so fixtures can assert alerts years before channels
  exist. **Done when:** S13 stub asserts decisions (no sends).
- [ ] **D10 — Data prep: masks + land cover + cloud join.** Spec: A6. Needs: B8.
  Static hot-source mask (backfill + curated seed), WorldCover/CORINE prep,
  hourly cloud-cover join. **Done when:** S3/S4 use real mask data.
- [ ] **D11 — CP1 evaluation run.** Spec: A2 protocol. Needs: D7, D8. Execute the
  protocol, produce the dated report artifact, record go/pause. **Done when:**
  the CP1 report exists and is linked from GATES §4.

## Track E — WP3 read path (Nov–Dec 2026)

- [ ] **E1 — Snapshot endpoint + seq discipline.** Spec: ADR-003 D1 (T1 row) as
  amended by A15 (A1.4/A1.5). Needs: D1. `/snapshot.json` ETag-from-maxSeq,
  `?updated_after_seq` cursor, the set-membership seq invariant enforced in the
  status layer. **Done when:** removal test — an event leaving the set always
  changes the ETag.
- [ ] **E2 — SSE tier (T0).** Spec: ADR-003 D1 (T0 row) + D3 (the 10-min safety
  snapshot). Needs: E1. Ring buffer, 5,000 cap + 503/Retry-After, drain
  semantics, 10-min safety snapshot. **Done when:** replay/gap/reset property
  tests green.
- [ ] **E3 — R2 static mirror (T2) + age monitor.** Spec: ADR-003 D1 (T2 row) as
  amended by A15 (A1.2 — the flip is client-side, never a Worker route);
  14 E-minor. Needs: E1. Upload job, second hostname, object-age monitor.
  **Done when:** killing origin in staging leaves T2 serving fresh-enough data
  with the age alarm quiet.
- [ ] **E4 — `/api/client-config` fleet control.** Spec: ADR-003 D1 (server-side
  transport control) as amended by A15 (A1.1 demotion triggers; A1.3 renames the
  route `/api/v1/client-config`). Needs: E1. Poll intervals, tier demotion flags,
  Esri-toggle kill. **Done when:** changing config moves the test fleet without
  deploy.
- [ ] **E5 — Client reconciler + transport supervisor.** Spec: ADR-003 D3 as
  amended by A15 (A1.5/A1.6); CI-7/CI-8; 14 M1/S15. Needs: E1. Framework-free
  core, five rules, 30-min hysteresis, server-time offset, cursor-mode
  full-snapshot cadence; fast-check suites incl. S15 (cursor-only removal
  convergence). **Done when:** CI-7/CI-8 + S15 green.
- [ ] **E6 — Polling-only e2e + T2 failover demo.** Spec: IP WP3 DoD. Needs:
  E1–E5. **Done when:** both demonstrated in staging and recorded.

## Track F — WP4 map frontend (Nov 2026–Jan 2027)

- [ ] **F1 — Preact shell + signals (`ui/`).** Spec: ADR-005. Needs: E5.
- [ ] **F2 — MapLibre controller + LayerRegistry (`map/`).** Spec: ADR-005 D4;
  B6/B7 outcomes. Needs: F1.
- [ ] **F3 — Event list/detail + permalinks.** Spec: IP WP4; ADR-002 D4.
  Needs: F1. `/event/:id`, `mergedInto` `replaceState` redirect, URL-hash
  viewport, list view as peer surface (A7). **Done when:** merged-id permalink
  test green.
- [ ] **F4 — Honest-clock staleness UX + degraded banner.** Spec: ADR-005; A12
  §3b copy. Needs: F1, E5. Single-slot banner, freshness chip + "[?]" target,
  frozen-state label. **Done when:** copy strings come from the GLOSSARY tables
  (CI-11 lintable), not hardcoded.
- [ ] **F5 — i18n `bg`/`en` typed messages.** Spec: ADR-005; A12. Needs: F1.
  Incl. place-name localization scope. **Done when:** CI-10/CI-11 lint runs over
  message catalogs.
- [ ] **F6 — Trust surfaces.** Spec: A7. Needs: F1. About/Methodology, "How
  fresh?", 3-card onboarding + logged disclaimer, OG/share cards, education
  pack. **Done when:** share card renders with observation timestamp baked in.
- [ ] **F7 — A11y pass.** Spec: A7. Needs: F1–F6. 200% reflow, 44 px targets,
  16 px floor, list view reachable without the map. **Done when:** the named
  checks are CI or a documented manual protocol.
- [ ] **F8 — Budgets + Lighthouse + fire-owns-red.** Spec: IP WP4 DoD. Needs:
  F1–F7. CI-12 real budgets, map-ready ≤6 s 4G / ≤15 s 3G, CI-14. **Done when:**
  all three green in CI.

## Track G — WP5 self-hosted tiles & style (Dec 2026–Feb 2027; off the beta path per A5)

- [ ] **G1 — Protomaps build → exploded z/x/y tree on R2.** Spec: ADR-001 A1.1.
  Max z14 Europe/Balkans. **Done when:** app renders from R2 tiles only.
- [ ] **G2 — Glyphs incl. Greek + Latin-Extended.** Spec: ADR-001 A1.1 as amended
  by A17. **Done when:** border-area Greek labels render (no tofu) in a visual
  check.
- [ ] **G3 — Custom outdoor style light/dark + Terrarium hillshade.** Spec:
  ADR-001. Needs: G1.
- [ ] **G4 — EFFIS overlay proxy productionized.** Spec: ADR-001 A1.2 + A17
  content sanity. Needs: C4. **Done when:** a 200-with-error-image fixture does
  not poison the cache.
- [ ] **G5 — `credits.ts` + CI-13.** Spec: ADR-001 A1.4; A18 attribution table.
  **Done when:** removing a credit line fails CI.
- [ ] **G6 — ArcGIS imagery toggle + metering + degrade.** Spec: ADR-001 A1.3 +
  A17. Needs: E4. **Done when:** simulated quota exhaustion hides the toggle via
  client-config.

## Track H — WP6 alert stack (Jan–Feb 2027 engine; Mar–Apr 2027 channels + live shadow)

- [ ] **H1 — Outbox + provenance + priority.** Spec: ADR-004 D1 as amended by
  A16. Needs: B4, D9.
- [ ] **H2 — Notification gateway (sole sender) + lint.** Spec: ADR-004 D2.
  Needs: H1. Dependency-cruiser rule + never-send lint. **Done when:** a seeded
  direct-send in app code fails CI.
- [ ] **H3 — Per-(zone,event) state machine + zone-creation seeding.** Spec:
  ADR-004 D3 as amended by A16 (14 H4). Needs: H1. UNIQUE key, suppression,
  seeding pre-existing events as `notified_new`. **Done when:** S13 passes
  end-to-end (zero sends for pre-existing events).
- [ ] **H4 — Gating config + budgets + breaker + kill switch.** Spec: ADR-004
  D4/D5 as amended by A16. Needs: H1, D9. B=500/T-approve, G=2,000/10 min,
  ingest-side breaker leg, deterministic cutoff + deferred metric. **Done
  when:** budget/breaker fixtures green; kill switch rehearsed in staging.
- [ ] **H5 — Channel adapters + token buckets.** Spec: ADR-004 D6. Needs: H2.
  Web push (TTL 1800 s), Telegram 25/s, email 12/s; queue expiry 6 h;
  dispatch-time liveness re-check (14 M3). **Done when:** physical-device push
  test done (L-5).
- [ ] **H6 — Templates + CI-10/CI-11 wording lints.** Spec: A12 contract. Needs:
  A12, F5. Product-authored lint fixtures (good-must-pass / bad-must-fail); DST
  fixture S14. **Done when:** lints green with the fixture corpus; S14 green.
- [ ] **H7 — Explainability surfaces.** Spec: 07 §5.5; IP WP6. Needs: H3.
  "Why this alert?" / "Why no alert?".
- [ ] **H8 — Shadow-diff machinery as code.** Spec: A8. Needs: H1–H4.
  `events_shadow`/`alerts_shadow`, nightly diff report, fixture-refresh policy,
  "what you would have received" beta UI hook. **Done when:** one nightly report
  generated in staging.
- [ ] **H9 — Live shadow (Mar–Apr) + staged enablement.** Spec: L-1; A5 WP6
  split. Needs: H1–H8, I-track zones. ≥2 weeks, every diff explained; the 25 Oct
  2026-style DST check applies to the spring-forward night (28 Mar 2027).
  **Done when:** shadow gate signed off in GATES.

## Track I — WP7 zones, accounts, GDPR (starts earlier than Feb 2027 per A8)

- [ ] **I1 — Accounts + auth.** Spec: 05 §5.4 C1–C4 via A8. Needs: B4.
- [ ] **I2 — Watch zones.** Spec: ADR-004 D8 as amended by A16. Needs: I1.
  ~1 km coarsening ON, app-layer encryption, coarse grid index, min radius ≥2 km
  UI rule. **Done when:** stored zones verifiably coarsened + encrypted.
- [ ] **I3 — Double opt-in + Telegram minimization.** Spec: ADR-004 D8. Needs: I1.
- [ ] **I4 — Erasure pipeline.** Spec: ADR-004 D8 + A16 (14 M3). Needs: I1, H1.
  ≤30 d incl. backups; deletion cancels pending outbox in-transaction.
  **Done when:** the erasure drill (I7) passes incl. the outbox case.
- [ ] **I5 — Privacy pages + disclaimers.** Spec: A8; 09. Needs: I1. ЗЗП/LANCE
  layered disclaimers, Esri/AWS recipients disclosed.
- [ ] **I6 — Legal artifact set.** Spec: A8. Needs: I1–I5. DPIA (C-184/20
  position), RoPA, DPAs, LIA, breach runbook with КЗЛД-72h templates, self-serve
  export. **Done when:** the 09 launch checklist is green.
- [ ] **I7 — Erasure drill in staging.** Spec: IP WP7 DoD. Needs: I4.

## Track J — WP8 ops & monitoring (continuous; hardening Feb–Apr 2027)

- [ ] **J1 — Meta-alerts + canaries + queue-age paging (L-8).** Spec: A22. Needs:
  C5, H1.
- [ ] **J2 — Backup/restore + RTO drill.** Spec: A22. Needs: C6. Simulated VM
  loss recovered within documented RTO; erasure-aware retention. **Done when:**
  drill recorded.
- [ ] **J3 — Runbooks top-5 incident classes.** Spec: A22; R2 mitigation. Needs:
  season experience from C-track.
- [ ] **J4 — Deploy gates + season regime (L-12).** Spec: A3. Needs: B3.
  8-checkbox deploy gate wired into CI/CD.
- [ ] **J5 — Status page + DMARC p=reject + defensive domains.** Spec: A22; 13
  §3.6(27). Off-infra status page live before launch.

## Track K — WP9 beta & launch (Mar–May 2027)

- [ ] **K1 — Beta cohort + CP2 instrumentation.** Spec: IP WP9; A9 north-star
  metric. Needs: H9, I-track. ≥500 alert-armed users measurable.
- [ ] **K2 — 50× load test (L-3).** Spec: A3 baseline definition. Needs: E-track,
  G-track.
- [ ] **K3 — Launch checklist.** Spec: GATES §3 incl. L-10/L-11/L-12 (A3). Needs:
  everything. Fire drill executed; legal gate green; Galileo confirmed.
- [ ] **K4 — Public launch (May 2027, pre-season, never during a mega-fire).**
  Spec: L-9. Needs: K1–K3.

---

## Coverage note

Every item of review 13 §3.1–3.6 and every H/M/minor of review 14 maps to at
least one task above (A-track for the paper change, B–K for the code that makes
it real). Out-of-scope-for-season-1 items (IP final section) are deliberately
not tasks. If a new review lands, extend this file — one task per amendment,
same contract.
