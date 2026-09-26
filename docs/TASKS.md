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

**Pending founder decisions (review 20 §7 Q3 — one line each: decision → who asked,
when deferred → due; struck through or moved to the WORKLOG when taken):**

- ADR-002 A2.3(3)'s FER exclusion contradicts itself: removing the 14-day
  unobservability closures from the numerator **only**, while leaving them in the
  denominator, *lowers* FER — the flattery the same sentence forbids. Implemented as the
  intent (the class leaves the whole population, excluded ids enumerated); the literal
  reading is one version bump away behind `fer.excludeUnobservableClosures` → D8,
  2026-09-03 → before the CP1 protocol, which grades FER.
- Whether review 11 §3.5's worked-examples table is corrected in place or left standing
  under its errata blockquote — four arithmetic defects across the five rows, none of
  which touch the formula and none of which move a bucket. Correcting a review's own
  table is a founder's edit → D12, 2026-09-03 → before D7's refit, which would otherwise
  be checked against a table that does not reproduce.
- User-data cap for `infra/cloud-init.yaml` (slim the contract vs pre-signed
  `#include`) → 21 E1/Q1, 2026-09-02 → this week; nothing deploys until then.
- The integration series — the founder's "commit" under rule 4 — and branch
  protection on `main` → 22 E1/Q1, 21 E5, 2026-09-02 → this week.
- D-track pause until the host records (every unrecorded day is a row in
  23 E5's table) → 21 Q6, 2026-09-02 → this week.
- Retention rule with a named owner (OPERATIONS §6.2 rule 11 says "no owner")
  → 04 §6 Q6 (July 2026), 23 E3/Q1 (2026-09-02) → September 2026.
- §0 rule 8 "integrated means committed and green", and where the code-review
  standard lives → 22 E2/Q2, 2026-09-02 → September 2026.
- CP1 protocol and its home `docs/reports/` → GATES §4; 20 Q2, 2026-09-02 →
  September 2026, before the season it grades.
- Stopping-rule amendment for the review corpus ("grows only on a founder request
  that names the ownerless decision") → 20 Q1, 2026-09-02 → September 2026.
- Cloud-proxy wording: A19 and DATA-SOURCES §D6 say Open-Meteo `cloud_cover`, the
  code records ECMWF `tcc` → 23 E4/Q3 (with the 11 author), 2026-09-02 → before the
  CP1 protocol is written.
- `COVERED_AREA` stays Bulgaria + 100 km (published promise; not widened when the
  default frame moved) → WORKLOG 2026-08-26 (07, 08, ADR-005) → decided by default;
  reopen only with a product reason.
- The second person (curation sweep, August inbox cover, continuity file; L-11
  quietly assumes one) → 16 §6 Q4, 18 §6 Q1, 2026-08-25 → before the 2027 season.
- WCAG 2.1 or 2.2 → 19 §6 Q1 vs 09 §4.3, 2026-08-25 → L-16 requires the target
  declared.
- Crowdsourced reports in the 2027 season at all → 16 §5.9, 18 §5.6.4, 2026-08-25 →
  before the work package that would ship them is dispatched.
- Archive licence and deposit (publication is not backup) → 18 §6 Q2 (2026-08-25),
  23 E9/Q5 (2026-09-02) → v1, before the archive is large enough to make it expensive.
- Turkish alert locale → 19 §6 Q2, 2026-08-25 → CP2, with reach data.
- Eurostars skip/go → 13 §3.1(8), due 1 Sep 2026 — **past due; the outcome is not
  recorded in this file or the WORKLOG.**

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
them), and `packages/contracts/src/credits.ts` implements the DATA-SOURCES attribution table
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
- [x] **B4 — Migration 001 (one schema owner).** Spec: 13 §3.2(11), C7; ADR-002 D1.
  Needs: B2, A10 (registry frozen first). dbmate SQL-first: `detections`,
  `fire_events`, `source_status`, `watch_zones`, alert-state, `alert_outbox`
  skeletons; append-only grants; kysely-codegen as the only type import path;
  Testcontainers-PostGIS migration up/down test. **Done when:** migrate
  up/down/up green in CI; review DDLs marked non-normative.
  *Closing note: up/down/up test green in CI since the schema wave; review DDLs
  carry non-normative markers; `src/db/types.generated.ts` + `db:codegen` script
  + CI drift gate make kysely-codegen the only type import path. The generated
  file was hand-authored to match kysely-codegen@0.20 output (no local Docker) —
  the drift gate's first CI run is the byte-for-byte proof; if it diffs, the
  gate's error message contains the one-command fix.*
  *Follow-up owned here (raised by the C1 audit): `detections` stores
  `ingest_config_version` but has no `ingest_config_digest` column, while
  `clustering_runs` carries both. A version string alone cannot prove which
  values produced a row if a config is ever edited under an unchanged version,
  so a later migration should add the column and the ingest writer should fill
  it. Not a blocker for recording detections — a blocker for explaining one of
  them in three years.*
  *2026-09-26 (wave F) — the Testcontainers image is overridable: `FIRE_WATCH_PG_IMAGE`
  (e.g. the arm64 `imresamu/postgis:16-3.4` on Apple Silicon, where the amd64-only
  `postgis/postgis:16-3.4` misses its health check under emulation) is substituted for
  every suite's pinned literal by one plugin in `vitest.config.ts`; unset, CI's image is
  unchanged. README "Running the integration suite" documents the colima invocation. The
  CI `integration` job now also fails on any skipped or todo test (JSON report check), so
  a suite that forgets to read `FIRE_WATCH_REQUIRE_DOCKER` cannot pass silently. Run on
  colima `fwtest` with the override: 23 files, 231 tests, 0 skipped; 230 passed, 1
  failed in the then-new `app/pipeline.integration.test.ts` (lifecycle tick closed 0
  events — not investigated here).*
- [x] **B5 — Determinism machinery.** Spec: 13 §3.2(12). Needs: B2.
  Virtual-clock port, fixed batch ordering `(available_at, source, lat, lon)`,
  config-as-data versioning, fixture-harness skeleton (manifest format + replay
  runner stub). **Done when:** a trivial double-run byte-diffs identical in CI.
  *Closing note: all four legs were audited as already in place (clock port,
  `(available_at, source, lat, lon)` batch ordering, `defineConfig` + FNV-1a
  digests with versions in per-row provenance, replay harness skeleton), and the
  double-run byte-identity test runs in CI.*
- [x] **B6 — Spike F-6 (feature-state on public ids).** Spec: IP WP0; ADR-005 D4.
  Needs: B2. MapLibre `promoteId` + feature-state on `fw-<year>-<base32>` ids
  (not UUIDs — 13 finding); plan B = numeric alias map. **Done when:** written
  outcome doc in `docs/spikes/`.
  *Outcome: `docs/spikes/b6-feature-state-ids.md` — decision YES; `promoteId:
  'id'` keys feature-state on public ids, UUID never leaves the store; plan B
  documented and confined to `web/src/map/**`.*
- [x] **B7 — Spike F-4 (`transformStyle` idempotence).** Spec: IP WP0; ADR-005 D4.
  Needs: B2. `LayerRegistry.apply()` idempotence across style reloads.
  **Done when:** written outcome doc in `docs/spikes/`.
  *Outcome: `docs/spikes/b7-layer-registry-idempotence.md` — both defenses
  combined: `transformStyle` merge on theme swaps + idempotent
  `applyFireLayers` on every `style.load` (which also re-pushes source data and
  re-applies feature-state).*
- [ ] **B8 — FIRMS 2020–2025 SP backfill kickoff.** Spec: IP WP0 week-1. Needs: B1. Register entry: DS-1 in `docs/data/DATASETS.md` — the manifest sha256 and the first `--check` date are filled in there, not here.
  Start the download (long lead time); resumable script + integrity manifest;
  archive layout documented. **Done when:** download running unattended with
  progress logging; feeds D7.
  *Status: the machinery is in and green — plan `firms_sp_backfill_2020_2025_v1`
  (3 SP sources × 2020–2025, 666 ≤10-day chunks), resumable runner with atomic
  `.partial` writes, sha256 manifest persisted after every chunk, offline
  `--check` re-verification, CLI (`pnpm -F @fire-watch/server backfill`), and
  OPERATIONS §6.4 documents layout + start command. The download itself cannot
  start without a real FIRMS MAP_KEY and a host with the archive volume
  (EXTERNAL-ACCOUNTS) — that is all that separates this from done.*
- [ ] **B9 — `infra/cloud-init.yaml` + VM provisioning script.** Spec: A22
  (OPERATIONS). Needs: B1, A22. VM class, host tuning, Postgres+PostGIS install,
  restore path stub. **Done when:** a fresh VM reaches "migrations applied" from
  one command.
  *Status: `infra/provision.sh` + `infra/README.md` are in (render → size
  preflight → create → cloud-init wait → migration verify; `--dry-run`,
  `--verify-only`, `--force-new`, restore stub deferring to C6). Blocked on a
  hard fact the preflight now catches: Hetzner caps user_data at 32,768 bytes
  and `cloud-init.yaml` renders to ~49.4 KB even minified. Needs an OPERATIONS
  §9-level decision (move embedded payloads to deploy-time delivery, or
  `#include` a pre-signed URL) plus a real Hetzner account/token for the
  end-to-end run.*

## Track C — WP1 ingestion in shadow mode (Aug–Sep 2026) — THE PRIORITY

- [ ] **C1 — FIRMS Area API poller (hard deadline: recording by early Sep).** The first recorded day is DS-2's "first recorded day" in `docs/data/DATASETS.md`.
  Spec: DATA-SOURCES wave 1; ADR-002 D1; A18 pitfall table. Needs: B4, B5.
  Poller with the versioned bbox config, canonical source ids (A10), full
  provenance + reserved footprint fields, `available_at` capture. **Done when:**
  live rows landing continuously; double-poll idempotent (uid no-op).
  *Status: audited against DATA-SOURCES wave 1, ADR-002 D1 and the A18 pitfall
  table, then completed. The live path is in and green — `polling_bbox_v1` (area
  `20,39,31,46`, version and now digest pinned by test), the frozen §1a source
  ids with the retired MODIS never polled live, `day_range=2` on every cycle,
  per-row provenance (`source_registry_version`, `ingest_config_version`,
  `scan_km`/`track_km`, `collection_version`, `confidence_raw`), `available_at`
  stamped by the adapter when the body completes and flagged — never clamped —
  when it precedes `acq_ts`. Double-poll idempotence is now proven twice over: a
  cycle test that runs `runIngestCycle` twice against a uid-keyed store, and an
  integration test that genuinely re-polls the same window against Postgres and
  lands zero rows. Pitfall 10 was the one real gap and is closed —
  `core/ingest/firms-availability.ts` plus an optional `fetchDataAvailability`
  on the FIRMS port compare every poll against the provider's own
  `data_availability` response, so a successful-but-empty poll during an
  upstream outage is reported as `upstream: stale` on the cycle line instead of
  reading as a quiet afternoon; the paging leg stays with C5. Two things are
  deliberately not done here: the per-row provenance* digest *needs a
  `detections.ingest_config_digest` column and migrations are B4's (only the
  version string is stored today), and pitfall 7's "VIIRS `low` never alerts on
  default zones" is D9's decision function, not ingest — `low` is normalized,
  stored and never dropped. Remaining for "live rows landing continuously": the
  FIRMS MAP_KEY and the deployed VM. Nothing in the code.*
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
  *2026-09-25 — the decoder for the second blocker exists (C3a, `createH5wasmDecoder`) but is not wired into the worker; it waits on a real granule to confirm the layout, and on bzip2 unpacking.*
- [ ] **C3a — Spike: granule decode implementation.** Spec: 02 R-9; 05 §5.6.2 E3.
  Needs: C3 boundary (landed). h5wasm in-process vs a Python sidecar behind the
  existing `GranuleDecoder` port: LSA-502 HDF5 and LSA-509 netCDF-4, decode time
  per slot, image size, and what each does to the E3 containment argument.
  **Done when:** written outcome doc in `docs/spikes/`, and one real LSA-502
  granule decodes to a `fire-watch.granule.v1` payload.
  *2026-09-25 — outcome doc `docs/spikes/c3a-granule-decode.md`: h5wasm 0.10.3 (pinned; NIST + HDF5 BSD licence) inside the existing child-process wall under the Node permission model (fs-read allowlist, no writes/child processes/eval, 512 MiB wasm + 256 MiB heap caps); Python sidecar is Plan B behind the same port. `createH5wasmDecoder` (`server/src/adapters/sandbox/`) reads the LSA-502 list product into `fire-watch.granule.v1`; 35 tests on synthetic granules (payload passes `parseGranulePayload`; ~0.2 s per slot end to end; a 3712² full-disk gzip grid reads in 0.3–0.5 s under the caps; sandbox escapes refused). Done-when NOT met: no real LSA-502 granule decoded (no LSA SAF credentials); dataset names/scaling/time attribute unverified and fail as refusals. Open: bzip2 unpacking, per-pixel time (slot time used), provisional 0.8/0.5 confidence thresholds, libhdf5 2.0.0 advisories, HDF5-DIAG stderr can truncate the child's reason, image size, network denial must be in the container, no software-licence register.*
  *2026-09-25 (wave C) — bzip2 and stderr open points closed (code only; done-when still NOT met, no real granule). `.bz2` is unpacked inside the sandboxed child before h5wasm by an in-repo bounded bunzip2 (`server/src/adapters/sandbox/bunzip2.ts`, no new dependency; seek-bzip accepts a stream missing its end-of-stream marker, bz2 cannot stop a bomb part-way, compressjs is GPL, @foxglove/wasm-bz2 needs its output size up front). Caps: `FW_DECODE_MAX_UNPACKED_BYTES` 128 MiB absolute, `FW_DECODE_MAX_UNPACK_RATIO` 1000x above a 32 MiB floor; a bomb exits 65 with the cap as the reason. Block and stream CRCs checked, every truncation refused, multistream decodes like `bzip2 -d` against one cap, trailing garbage refused; round-trip tested against system bzip2 1.0.8. The child reports its reason as a `fw-decoder-reason:` stderr line that the wall puts ahead of HDF5-DIAG noise (tested with a real DIAG stack). Remaining: real-granule layout, acquisition time, confidence thresholds, libhdf5 2.0 advisories, image pruning, network, licence register.*
- [ ] **C4 — EFFIS + weather adapters.** Spec: DATA-SOURCES; ADR-001 A1.2; A19.
  Needs: C1 pattern. FWI + BA perimeters via our proxy (serve-stale + content
  sanity); weather per the A19 source-of-record decision. **Done when:**
  recording with freshness tracked.
  *Status: the full recording code path is in and green — versioned configs
  `effis_layers_v1` (FWI WMS + BA-7-days WFS) and `weather_context_v1` (ECMWF
  Open Data per A19; Open-Meteo nowhere, per the §D3 licence fence), the A2.2
  content-sanity gate, serve-stale as a store-layout property (only sanity-good
  bodies atomically replace `overlays/effis/<id>/current.<ext>`; poison kept as
  dated evidence — proven by 200+ServiceException / blank-image fixtures),
  ECMWF `.index` byte-range fetch with GRIB2 sanity and idempotent re-runs,
  fs-backed feed-status store merged into the health endpoint, worker cycles
  (EFFIS 6 h, weather 1 h) inside C5 budgets. Remaining for done-when: deployed
  VM with `FIRE_WATCH_STATE_DIR` + live endpoints, the G4 serving route +
  edge-cache TTL, and the healthchecks.io `effis-refresh` slug.*
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
  *2026-09-25 — Grafana leg built, unticked: pure exposition core (`core/observability/prometheus-text.ts`, `metric-catalog.ts`), registry in `adapters/metrics/`, `/metrics` on a separate internal Fastify listener (`adapters/http/metrics-server.ts`) — off unless `FIRE_WATCH_METRICS_PORT` is set, loopback by default, bearer token file required on any other bind; a test proves the public server 404s it, and `/api/health/meta` stays unregistered. Exported: API freshness verdict (same inputs as `/api/health/freshness`); worker heartbeats, loop run/finish/duration, ingest per-source counters, meta-alert readings (L-8 queue age, approval pending); backup CLI node-exporter textfile. `infra/metrics/` holds the Alloy config (secrets by file/env) and Mimir rules mirroring the OPERATIONS paging table; `metrics-rules.test.ts` pins every rule metric to the catalogue and every threshold to its code constant. Blocked on: host, Grafana Cloud stack/token, compose wiring, rule loading. Not exported yet: degradation tier, SSE rejects, event-loop lag, WAL lag, alert deferral/drop counters, dispatch/R2-mirror loop metrics (heartbeats are).*
  *2026-09-25 (wave C) — remaining exports done: API `fw_degradation_tier` (0 SSE / 1 poll; T2 is unobservable server-side), `fw_sse_connections`, `fw_sse_rejected_total{reason=not_offered|not_ready|capacity|client_cap}` via a stream-route `onRefused` hook; both processes `fw_event_loop_lag_p99_seconds` (own sampler on the metrics listener, separate from demotion's); worker loops `dispatch`, `r2_mirror_push`, `r2_mirror_age` emit `fw_loop_*`; `fw_alert_sends_dropped_total{reason="ttl_expired"}` produced from gateway `closed` events. Mimir rule `AlertSendsDropped` (`increase(...[15m]) > 0`, pages) in `queue.yaml`, pinned to `alertDeferralPages`. Still open: `fw_alert_sends_deferred_total` (no producer — B unarmed, manual broadcast unwired), `dropped{reason="expired_unapproved"}` (no deadline sweeper), WAL archive lag (no WAL archiving), no rules for tier/SSE/lag (no thresholds; the §3 `tier == 2` page cannot fire from the server). OPERATIONS U-2 now names `fw_event_loop_lag_p99_seconds`.*
  *2026-09-26 (wave E) — `fw_alert_sends_deferred_total{reason=over_budget_b|manual_approval}` produced: every outbox write goes through `core/alerts/outbox-enqueue.ts`, which enqueues `awaiting_approval` drafts in one call per reason and counts only newly inserted rows (A1.12 "rows entering"; an A1.11 redelivery is not counted; a decision-log `defer` writes no outbox row and is not a deferral). The evaluation cycle reports `deferred`; the worker wires the loop through `observeAlertEvaluation` (series at zero from the first cycle), guarded by a source test in `metrics-wiring.test.ts`. It reads 0 until D5's budget B or the manual broadcast is armed (founder decisions, unchanged). No Mimir rule — A1.12 pages on the deadline and on drops, not on a deferral. Still open: `dropped{reason="expired_unapproved"}` — needs the deadline sweeper (UPDATE past `queueExpirySeconds` in `adapters/db`; the predicate exists in `dispatch-decision.ts`), listed as a founder decision; WAL archive lag — needs WAL archiving itself (wal-g → R2, OPERATIONS §5 / U-8), a `pg_stat_archiver` read in `adapters/db` feeding the existing `wal-archive` freshness row (15 / 60 min) or a gauge, and a founder call on paging.*
- [ ] **C6 — Backups + paging (shadow season protection, B2 blocker).** Spec: A22;
  13 B2. Needs: B9. Nightly encrypted pg_dump to R2, restore script tested once,
  uptime paging. **Done when:** a restore onto a scratch VM succeeds; the season
  archive is no longer single-copy.
  *2026-09-24 — built, uncommitted, not ticked (no host). Core `server/src/core/backup/`:
  dated keys (`fw-main/{daily,weekly}/…`, `fw-personal/daily/…`), retention (main 14 daily +
  56 days weekly, personal 28 daily), checked fail-closed against `ERASURE_HORIZON`; a two-set
  dump plan from one exported snapshot; `backup-run`/`restore-run` (a personal artifact at or
  past retention is refused; a main-only restore leaves personal tables empty). Adapters
  `adapters/backup/` (process runner defaulting to `docker compose exec -T postgres`,
  pg_dump/psql/age, SigV4 R2 store with a write-only token, local-fs store, healthchecks
  pinger); `app/backup-cli.ts`, `app/restore-cli.ts` (exit 0/1/2, secret-free
  `backup_summary`/`restore_summary`), restore reads with a separate
  `FIRE_WATCH_RESTORE_R2_*` credential; `server` scripts `backup`/`restore`;
  `infra/backup/` service + timer (02:20 UTC ±15 min, `OnFailure=` pages). Runbook 02 now
  describes the real restore. 123 unit tests; the Docker integration test skips. Done-when
  needs: a restore onto a scratch VM, cloud-init switched from the rclone job (the file is at
  its size cap), `age` on the host, the VM dist location, the restore credential,
  `schema_migrations` in `table_backup_class` (migration 013), per-table gauges at dump time,
  and a second copy of the season archive. Open: monthly tier, credential/age-identity
  holder, bucket/EU, backup hour, R2 versioning, the `alert_outbox` projection, ledger
  backup class, sign-off on the manual promotion rename.*
  *2026-09-25 — remainder built, still unticked (no host): migration **013** classifies `schema_migrations` as `main` in `table_backup_class`. The nightly backup counts exact rows + `pg_total_relation_size` per table inside the dump snapshot, emits `fw_backup_table_rows`/`fw_backup_table_bytes` (`relation`, `set`) as a `table_gauges` line and a `table_shrinkage` line against the last good night (ledger `<staging>/table-gauges.json`); gauge/ledger failures never fail the backup. Integration assertions written, unrun (no Docker). Open: gauges as an R2 sidecar per artifact, classification read inside the snapshot, shrinkage paging thresholds, partition churn as `vanished`, no exporter yet.*
- [ ] **C7 — NRT→SP partition-swap machinery (stub).** Every run, swap or dry-run, is a dated history line under DS-1 and DS-2 in `docs/data/DATASETS.md`. Spec: ADR-002 D7 as amended
  by A13. Needs: B4. Staging load + sanity counts + swap + month-scoped
  re-cluster hook (no-op until D-track exists). **Done when:** dry-run on a
  backfill month passes sanity checks.
  *Status: machinery is in and green — `core/promotion/**` (month windows,
  fail-closed sanity gate `sp_swap_sanity_v1`, staging load via the real CSV
  parser, orchestrator with dry-run driving the identical path minus the swap),
  ports for archive reader / staging store / re-cluster hook (no-op until
  D-track), pg adapter doing DETACH → rename → rename → ATTACH in one
  transaction with the retired NRT partition kept, and a
  `sp-promotion-cli.ts` (`--month=YYYY-MM [--dry-run] [--confirm]`). 84 unit
  tests + a synthetic-month testcontainers integration test exercise the full
  path incl. dry-run sanity checks (CI-only). Remaining for done-when: a
  dry-run on a REAL backfill month — blocked until the B8 download runs (FIRMS
  key + host). Numeric sanity bands are deliberately unfitted (band=null →
  `--confirm` required) until the first two real swaps; re-cluster steps 4–6 of
  D7 are D-track by design. 2026-08-31: the follow-up is closed —
  `server/package.json` now carries `promote` (`dist/app/sp-promotion-cli.js`)
  and `replay` (`dist/adapters/fixtures/replay-cli.js`), so neither CLI is
  reachable only by typing a `dist/` path from memory.*
- [ ] **C8 — Licence pinning + log redaction.** Spec: A23. Needs: C1–C4.
  `docs/licenses/` per adapter with text + date; pino redact covering MAP_KEY as
  URL path segment. **Done when:** grep for the key in logs finds nothing.
  *Status: the redaction leg is done and executably proven; the licence leg has
  one source whose terms could not be established from repo documents, so the
  task stays open. Redaction lives at `core/observability/redact.ts`
  (dependency-free) behind a single process sink, `app/logging.ts` — every
  entrypoint (`worker`, `api`, `ingest-cli`, `backfill-cli`,
  `sp-promotion-cli`) now writes through it and no longer touches
  `process.std*.write`, so the reporters are covered without being edited and a
  new call site cannot forget. Two legs: exact values read from the environment
  (longest first, so a DSN does not survive as a shell), and credential-shaped
  path segments inside URL-like substrings — which is what catches the MAP_KEY
  in `…/api/area/csv/<key>/VIIRS_SNPP_NRT/…`, including a key this process
  never held. Replacement is always the full `<32 characters>`, never a prefix.
  The done-when is a test, not a claim: it assembles a log from seven realistic
  failure paths (config dump, a `ConfigError` quoting the bad value, `fetch
  failed` with the URL in `cause`, a stack, a cycle report, a heartbeat error,
  a DSN inside a driver error) and greps — no key, no password, not even their
  first eight characters. pino was evaluated and declined for now: its `redact`
  works on field paths and cannot express "credential-shaped segment inside an
  arbitrary string", so this module would still be needed as its censor.
  Leaks found in files outside this task's edit scope, all currently non-live
  but each one step from live: `core/ingest/firms-poller.ts:138,153` and
  `core/backfill/backfill-run.ts:216` log `error.message` verbatim and are safe
  only because `firms-http-client.ts:75` redacts what it throws — anything
  thrown outside that adapter (an injected client, a retry wrapper, an
  `AbortError` from a supplied `fetch`) arrives raw, and the sink is now the
  second line of defence. That same redaction at `:75` is substring-exact and
  would miss a percent-encoded key — correct today only because `assertMapKey`
  restricts the charset. 2026-08-31: the last hole is closed —
  `adapters/fixtures/replay-cli.ts` now goes through `processLog()`. Its stderr
  diagnostics (fixture failures, gate problems, blocked-scenario notes) became
  canonical-JSON records, greppable by field instead of by prose; its stdout
  report keeps its exact bytes and only passes `log.line`'s redactor, which
  cannot disturb it because the shape leg looks only inside URL-like substrings
  — the property that keeps it from eating `detection_uid`s. A bad `--gate=`
  value or an unreadable fixture used to escape as an uncaught throw, printing a
  stack straight to stderr: the one write the sink could not redact. It is now
  `log.fatal` with exit 1. Re-verified after the change: the CI-2 double run
  under `TZ=UTC/LC_ALL=C` and `TZ=Pacific/Kiritimati/LC_ALL=tr_TR.UTF-8` is
  still byte-identical. Licences: seven sources pinned,
  each with verbatim terms and a retrieval date, and `docs/licenses/README.md`
  carries the rule that no new adapter lands without a file there. ECMWF Open
  Data was initially recorded as unestablished, then verified upstream on
  2026-08-15 against the dataset page and the ECMWF Terms of Use — CC BY 4.0
  **plus** the Terms, which apply in addition, and our case is the *service*
  form: five components that travel together (`This service is based on data and
  products of the European Centre for Medium-Range Weather Forecasts (ECMWF)`,
  `Source www.ecmwf.int`, the CC BY 4.0 statement, ECMWF's liability
  disclaimer, and a modification indication that is **mandatory for us** since
  everything we publish from that feed is resampled or derived). The obligation
  is prominent (not behind a collapsed expander), complete, and revocable —
  "Users must remove attribution if requested by ECMWF". Recorded as row 22 of
  the verbatim attribution table in DATA-SOURCES. 2026-09-03: the
  `packages/contracts/src/credits.ts` half landed — the five components are five entries
  (`ecmwf-service`, `ecmwf-source`, `ecmwf-licence`, `ecmwf-liability`,
  `ecmwf-modified`) sharing a new `derived:ecmwf` condition and the
  `credits-page` surface, plus `ecmwfComponents()`, which returns them as one
  unit in Terms order and **throws** if any is missing, because a partial ECMWF
  attribution is a licence breach rather than a rendering degradation. The split
  into five rows is a registry constraint, not a licence one — the registry
  holds one string per entry and the obligation is five strings that travel
  together, so the unit lives in the function. Only the first four are ECMWF's
  wording; `ecmwf-modified` is ours and is the one line a reviewer may re-word.
  The tests assert those four verbatim, that all five are owed together or not
  at all, their order, and that they are owed on the credits page only — the map
  corner cannot carry a four-sentence disclaimer, and the Terms' "prominently"
  is not satisfied by shrinking the wording to fit one. What code still cannot
  enforce, now written down as a review obligation in
  `docs/licenses/ecmwf-open-data.md`: *prominent* display — the registry can
  name the surface, not vouch that the surface renders it above the fold. Still
  open, and correctly so: **EFFIS**
  publishes no mandatory string, so ours is a construction, and redistributing
  the raw danger raster is not cleared (ECMWF/Météo-France inputs, GATE-v2);
  the **EUMETSAT** per-product text needs a Data Store registration to
  transcribe; and three ECMWF readings are ours rather than the provider's (the
  service-agreement clause's scope, the wording of the modification indication,
  and the absence of an ECMWF section in review 09). Nothing was invented —
  every unestablished term is an Open item rather than a guess.*
  *2026-09-26 (wave D) — redaction leg extended to personal data (gap found 2026-09-25: an arbitrary error string such as a pg `Key (email)=(…)` echo reached the log verbatim). New `core/observability/free-text.ts`, run by `redact.ts` `text()` after the secret and URL legs, so it covers messages, cause chains, stacks, nested values and `log.line`: e-mail addresses (incl. `%40`) → `<email address>`; Telegram chat ids only behind a `chat_id` label, plus a `*chat_id` field-name leg in `value()` → `<chat id>`; `Bearer`/`Basic` credentials, JWTs and Telegram bot tokens → `<N characters>`. Rejected with reasons in the module: bare integers, lat/lon pairs (public detections share the shape; 05 §5.3.2 is enforced at source by logging zone ids), IPs (LIA-1), phone/name/address. Negatives pinned: ISO timestamps, UUIDs, metric names, SQL states, paths, digests, detection coordinates, pnpm `pkg@x.y.z`. Fixed a pre-existing quadratic rescan in `URL_LIKE` (200 000 letters ≈ 1 min → ms); 13 adversarial 200 kB inputs are time-bounded in tests. `SECRET_ENV_VARS` gained the Telegram bot token, VAPID private key, ArcGIS key, R2 mirror pair and metrics token file path. End-to-end test through a real `createProcessLog` sink. `telegram-channel.ts` no longer prints the migrated chat id (the error says "migrated to a supergroup").*
- [ ] **C9 — Ingestion-parity + lag monitors.** Spec: A23. Needs: C1.
  Week-one parity check vs the FIRMS map; NRT-lag histograms feeding
  `availability.json` (D-track fixture input). **Done when:** parity report
  produced; histograms persisted.
  *2026-09-23 — code done, uncommitted, not ticked. Pure NRT-lag histogram
  (`core/ingest/lag-histogram.ts`, edges `nrt_lag_histogram_v0`, per UTC day of
  arrival) + recorder, persisted by migration **008** `nrt_lag_histograms` (a changed
  digest under the same version is refused, not overwritten); hourly worker loop
  `lag_histograms`; `lag-histogram-cli export` writes `availability-profile@0`. Parity
  comparator + read-only `parity-cli` (exit 0 parity / 1 deficit / 2 misconfigured).
  101 unit tests; 16 integration tests skip without Docker. Blocked on host + FIRMS
  key for the week-one parity run and real histograms. Founder decisions: edges v0,
  near-match tolerances (null = off), and what `availability.json` means — 06-qa
  §5.2.2 vs DS-2/review 23 E5 disagree; profile@0 is the lag distribution only.*

## Track D — WP2 clustering & identity engine (Sep–Oct 2026, critical path)

- [ ] **D1 — Incremental clustering core.** Spec: ADR-002 D2/D3 + A14 tie-break
  appendix. Needs: B5, C1. Per-batch algorithm, eps per source, T_LINK, GEO
  attach-only with pinned tie-break. **Done when:** S1/S4/S5 fixtures pass;
  double-run byte-identical (CI-2).
  *Status: the engine is in and green — `core/clustering/**`, 10 pure modules
  plus a `ClusteringStore` port, 9 test files / 123 tests, no SQL and no clock
  in core. `clusterBatch` builds the assigned-uid index **before** eviction (so
  an overlapping poll cannot re-mint an event for a row whose cluster just aged
  out), orders the batch by `(available_at, source, lat, lon)` and asserts that
  order is total rather than assuming it, then per row resolves ε from source
  and footprint and links single-link — any member within ε, not the centroid.
  Coarse sources attach only and never merge; fine sources merge with the D3
  survivor rule, and assignments already emitted earlier in the same batch are
  rewritten onto the survivor so the rest of the batch sees one consistent
  working set. Every A14 Appendix-A rule has a test that fails if the rule is
  weakened: rule 1's equidistant-GEO tie is run twice with creation order
  inverted and asserted to be a genuine tie, so "lowest public id",
  "northernmost" and "geography" each fail one orientation; rule 2's tie pair
  was found by search because symmetric 5-dp offsets come out bit-identical and
  would not have proved the 1 mm quantisation is load-bearing — the chosen pair
  differs by 0.19 mm raw, ties quantised, and the raw-nearer one is the wrong
  answer, so removing the quantisation flips two tests. Byte-identity (CI-2) is
  **done** and reuses `core/replay/double-run.ts` rather than adding a second
  harness: repeat-from-scratch, 16 seeded permutations of an 8-row batch that
  reaches every branch, one-batch-vs-two equality, fixed-point replay, and a
  guard that no float escapes into the artifact. What keeps this unticked is
  the fixture half of the done-when, which is D5's: there is no fixture
  directory, no loader wiring and no `expected.json` yet. The clustering-side
  behaviour of all three scenarios is covered in `scenarios.test.ts` with the
  boundary stated in its header — S1 is fully D1's and passes (one
  cross-border fire, two country-scoped downloads, one event with a stable id
  in either polling order, with a transient in-batch split repaired by the
  merge before it escapes); S4's hard override is D6's scoring and S5's status
  and alerting are D4/ADR-004, so those `expected.json` files cannot assert
  what GATES §1.1 says they assert until those tracks land. One deliberate
  deviation to review: `temporalGapMs` returns 0 when an acquisition falls
  inside a cluster's existing `[started_at, last_detection_at]` span, which is
  more permissive than a literal reading of "`last_detection_at` within
  T_LINK". It only admits rows the strict reading would reject as too old while
  the cluster demonstrably already covers that instant; the case is tested.*
  *2026-09-23 — live identity pipeline implemented and wired into the worker
  (`app/identity-wiring.ts`, 60 s, ≤24 batches/cycle, own pool of 2): clusters newly
  ingested batches into registry events, applies merges/tombstones/reignition links
  and aggregates in one transaction per batch, one `clustering_batches` ledger row per
  batch (migration **005**), then a lifecycle tick. The live cycle reproduces the
  replay registry through a fake store; replay stays byte-identical. Not ticked: the
  Postgres integration tests (005 + `pg-clustering-store`) have never run — they need
  CI with `FIRE_WATCH_REQUIRE_DOCKER=1`. 19 open decisions shipped unarmed/null are
  listed in WORKLOG 2026-09-23 (cadence, late batches below the cursor, quarantined
  rows never clustered, D7 promotion on config change, …).*
- [x] **D2 — Merge semantics + `migrateAlertState`.** Spec: ADR-002 D4, I2/I3.
  Needs: D1, B4 (alert-state tables exist). Survivor rule, tombstones + path
  compression, same-transaction alert-state migration, 20 km hull →
  `needs_review`. **Done when:** S2 passes; I2/I3 property tests green.
  *2026-08-26: the core landed — `clustering/hull.ts`, `registry/alias-registry.ts`
  (I2, with a fast-check model against naive union-find), `registry/alert-state.ts`
  (`foldAlertStates`, I3 / CI-5) and `registry/merge-plan.ts` (`buildMergePlan`, one
  value an adapter cannot half-apply). Left unticked only because S2 had no harness.*
  *2026-09-18: ticked. Both halves of the done-when have been true since 2026-08-30
  and nobody closed the loop: `server/fixtures/S2/` is green under
  `--gate=pre-merge` (survivor minted from the older cluster's seed, the absorbed id
  a tombstone resolving to it), and the I2/I3 property suites are in the unit run
  (`registry/`: 7 files, 116 tests). The one line of GATES S2 this does **not**
  cover is the HTTP half — "permalink resolves 200 + `mergedInto`" — which the
  fixture's own `asserts` hands to the WP3 read path (E-track) and which is ADR-002
  D3 item 5, not D2's scope. The reignition leg of `migrateAlertState` is D3's and
  closed with it.*
- [x] **D3 — Reignition linking.** Spec: ADR-002 D5 + A14 defaults. Needs: D1.
  Within/past-T_LINK paths, fuel windows incl. unclassified default, parent
  tie-break, `possible_reignition` + `related_event_id`. **Done when:** S6
  passes.
  *2026-08-27: the rule is implemented and tested — `ports/reignition-reader.ts`
  (the candidate read) and `registry/reignition-plan.ts` (`buildReignitionPlan`:
  eligibility, parent tie-break, one `related_event_id` per event, and the
  ADR-004 A1.6 alert inheritance). Unticked because the S6 half needs D5's
  fixture harness, which does not exist; the S6 stand-in in
  `reignition-plan.test.ts` drives the engine over a cooled megafire instead.
  Two notes for review: the fuel band is `null` for every event today —
  `fire_events` has no land-cover column and the classifier is unbuilt, so
  Appendix A rule 5's 14 d middle band applies everywhere, which is the rule's
  own answer rather than a stub; and a batch that both merges and reignites the
  same pair writes no relation, because the merge is stronger evidence.*
  *2026-09-02: ticked. `server/fixtures/S6/` now exists and is green under
  `--gate=pre-merge`: a 180 MW fire cools for 60 h and the detection that
  returns is past `T_LINK`, so it seeds a second event carrying
  `possible_reignition` back to the first — the fuel-window path driven over a
  fixture's clock rather than through a unit-test stand-in. The parent is still
  `signal_weakening` at the end, which is the "no false `no_longer_detected`"
  half of the scenario: E reaches 3.5, past the ordinary 3.0 bar and short of
  the large-event 5.0 one. Verified by counterfactual — the same fixture with
  the seed detection at 50 MW instead of 180 MW closes the parent, so the
  large-event threshold is what holds it open rather than the arithmetic
  happening to land low. FER is not asserted: nothing in the replay report
  carries it, and inventing the field would be the plausible-constant mistake
  the register exists to prevent.*
- [ ] **D4 — Lifecycle E-accumulator + PassPredictor.** Spec: ADR-002 D6 as
  amended by A14; A6. Needs: D1, C3 (cloud mask), C9 (lag data).
  PassPredictor port + static pass-time table v0 validated against WP1 data;
  per-source weights, cloud gating, per-source freeze, retired-source exclusion,
  14-day fallback, officially_* re-detection transition. **Done when:** S7, S8,
  S11, S12 pass.
  *2026-09-01: every rule in the line above is implemented and tested —
  `ports/pass-predictor.ts` (the port), `lifecycle/static-pass-predictor.ts`
  (`pass_table_v0`), `config/lifecycle-params.ts` (`lifecycle_params_v1`),
  `lifecycle/e-accumulator.ts` (per-source weights, cloud bands, GEO slot rule,
  per-source freeze) and `lifecycle/lifecycle-state.ts` (the three non-tradeable
  transition conditions, large-event thresholds, A2.3(3)'s 14-day fallback,
  A2.2's re-detection, A1.3's display window). 181 tests.*

  *2026-09-02: the done-when is met — S7, S8, S11 and S12 are authored and green
  under `--gate=pre-season`, each built so its claim is visible in the final
  report rather than in an intermediate tick nothing asserts. S7 (cloudy gap):
  two days of 90 % cloud accrue nothing and a third at 60 % accrues half weight,
  E = 2.25, weakened and never closed. S8 (transient outage): the three VIIRS
  feeds are out for 44 h, SLSTR alone only weakens the event, the first poll
  after recovery closes it, and the fixture ends 44 h past that close so the
  tier is still `map` — a broken freeze would close a day earlier and leave it
  at `feed`. S11 (retired source): the only feed that ever saw the fire is
  MODIS, retired the next morning; the surviving VIIRS and SLSTR overpasses
  still weigh misses, so it closes on schedule and ages to `feed`. S12
  (re-detection after `officially_extinguished`): a declaration at 18:00 stands
  at the next poll, and the detection 35 h later returns the *same* event to
  `active` with both uids, rather than minting a new fire.*

  *Still unticked for the one reason outside the rules: the "validated against
  WP1 data" half cannot be done. WP1 has produced no measured arrival times, so
  the table's local solar hours and delivery lags are a stated fit to be
  refitted, flagged as such in the file.*

  *Three notes for review. (1) `expectedOverpassSources()` in contracts takes no
  instant and therefore cannot express A2.3(2) at all; the predictor derives
  retirement-as-of-an-instant from `SOURCE_REGISTRY` + `statusEffectiveFrom`
  itself rather than change frozen contracts, so the same answer now exists in
  two places if another caller ever needs it. (2) `EventObservationSnapshot`
  gained `inactiveSinceMs` and `geoWeightSpent`: A1.3 measures the display window
  from the transition, not from the last detection, and the GEO daily cap is a
  ceiling on a UTC day rather than on a tick — without the carried balance a job
  running four times a day lets a stationary sensor contribute four times what
  the parameter allows. Both are state D6's tick job must persist alongside
  `accumulatedE`. (3) Fade-and-persist is implemented only as far as D6 states it
  — large events leave the map at 48 h like everything else and stay listed. The
  stronger reading on the table (keep the burnt perimeter for the season) is
  still an unresolved product decision in 00-summary's open questions, and the
  state machine deliberately does not pre-empt it.*
  *2026-09-23 — the lifecycle tick now runs live after every identity cycle (see
  D1). With cloud evidence empty and outages unarmed, live transitions do not fire
  yet: the tick advances its watermark and emits nothing. `fuelBand` null, `score` 0.*
  *2026-09-26 (wave F) — correction: the live tick could never fire the 14-day fallback
  either. `trailingUnobservableDays` counted whole UTC days inside one tick window, and a
  per-poll window holds none, so the count was always 0 and a silent event stayed
  `active` on the map forever. Fixed by carrying the start of the blind run between
  ticks (`blindSinceMs` in `EventObservationSnapshot`/`MissEvidence`, split-invariant by
  construction) and persisting it in migration 016 (`fire_events.lifecycle_blind_since`).
  With no cloud feed every pass is still `cloud_blocked`, so the fallback is now the one
  live closure: `server/src/app/pipeline.integration.test.ts` drives 30 days of hourly
  ticks and every event closes `no_longer_detected/unobservable` 14–16 days after its
  last acquisition, leaves the map 48 h later and archives at 7 days. Goldens unchanged.
  Still unticked for the WP1 validation reason above.*
- [ ] **D5 — Golden fixture suite S1–S6.** Spec: GATES CI-1 (as re-scoped by A1);
  A6 fixture-sourcing. Needs: B5. Pin fire dates from EFFIS BA archive, build
  `availability.json`, author manifests + expected outputs. **Done when:** CI-1
  wired: clustering merges blocked unless S1–S6 green.
  *2026-08-30: the gate is wired and three fixtures are green, but the done-when
  says S1–S6 and only S1, S2 and half of S5 are authorable today — read this
  entry as "the machinery is finished, the corpus is not". What landed:
  `core/replay/identity-engine.ts` replays a fixture through the real path
  (`clusterBatch` → `buildMergePlan` → `buildReignitionPlan`) instead of the
  placeholder, keeping evicted clusters in an `archived` map because eviction is
  not deletion, and emitting a tombstone per alias with `mergedInto` resolved
  through the alias chain (I1, I2, I3). Manifests now declare `engine`
  (`identity` | `smoke`) rather than the runner inferring it, so `harness-smoke`
  keeps failing when the *harness* breaks. `core/replay/register.ts` is GATES
  §1.1 as data — all sixteen rows, cumulative stages, and a `blockedBy` string
  per row naming the task that owes the fixture; `registerProblems` fails a
  demanded-but-absent scenario and an `S<n>` directory the register does not
  define, while leaving non-`S` names alone. `replay-cli.js --gate=pre-merge` is
  now what CI runs (`.github/workflows/ci.yml`), and its output goes to stderr so
  the CI-2 byte diff is untouched; verified locally, both runs exit 0 and the two
  reports are byte-identical under `TZ=UTC/LC_ALL=C` and
  `TZ=Pacific/Kiritimati/LC_ALL=tr_TR.UTF-8`.
  The three fixtures assert things that are true today and were checked by hand
  rather than accepted from the engine: S1's four pixels are 1.139 km apart
  adjacent and 3.342 km end to end, so the single event exists only because of
  single-link chaining, and the border row re-delivered by the second
  country-scoped poll adds no fifth uid; S2's survivor id was reproduced offline
  through `mintPublicId` to confirm it is minted from the **older** cluster's
  seed, i.e. `compareSurvivor` actually fired rather than the answer happening to
  look right. S5 is deliberately partial and says so in its own `asserts`: the
  "stays Unverified" half needs a score nothing computes.
  What keeps this unticked, beyond the missing scenarios: S3/S4 need D10's masks
  and the ADR-002 D6 score, S6 needs D4's lifecycle, and the A6 half of the task
  — pinning real fire dates from the EFFIS BA archive and building
  `availability.json` — is untouched. The current fixtures are constructed
  geometry with real detection-uid digests, not replayed history, which is enough
  for the invariants and not enough for D7's parameter fit.
  2026-08-31: the engine itself now has a unit suite —
  `core/replay/identity-engine.test.ts`, 13 tests. It exists because the three
  fixtures assert *outcomes* and would still pass if the engine reached them by
  accident; these tests fail if `archived` is dropped, if the reignition
  candidate snapshot moves to after `clusterBatch`, or if the tombstone loop is
  removed. Four properties are pinned by construction, with the geometry worked
  out in the file's own header rather than read off a run: the pinned-version
  guard rejects a missing `clustering_params`, a `_v2` pin and a `sources`
  mismatch, and accepts a fixture pinned to a config actually passed in — proof
  the `config` option is wired rather than hardcoded; eviction is not deletion
  (123 h between polls evicts, and the 120 h-later detection 0.415 km away still
  attaches as `possible_reignition` rather than starting a stranger); a merge
  loser is a tombstone with `detectionUids: []` and **two** events, not three,
  because `clusterBatch` structurally unions the survivor; and no implemented
  decision assigns a `status`, `bucket` or `label`.
  `availability.json` is deliberately still absent rather than stubbed: it models
  per-row NRT lag sampled from a *measured* distribution, its input is C9/WP1
  live data that does not exist, and a nominal profile invented here would land
  as an orphan module asserting a latency nobody measured.
  2026-09-02: S6 is authored and green (see D3), so four of CI-1's six are real
  fixtures. What still keeps this unticked is unchanged: S3/S4 need D10's masks
  and the ADR-002 D6 score, and the A6 half — pinning real fire dates from the
  EFFIS BA archive and building `availability.json` — is untouched.*
- [ ] **D6 — Fixture suite S7–S16.** Spec: A4 register. Needs: D5 harness.
  S7–S10 (per GATES) + S11 (retired source), S12 (officially_* re-detection),
  S16 (bbox-edge fire); S13–S15 stubs handed to their owner tracks. **Done
  when:** all pre-season fixtures green or explicitly stubbed with owner noted.
  *2026-08-31: partially advanced — the two scenarios in this range that are not
  blocked on unwritten code are authored and green. S9 (UTC/DST ingest boundary)
  is a Strandzha fire crossing the 25 October EEST→EET fold: eight pixels over
  three polls, adjacent hops ≤ 0.923 km against ε = 1.25 km and 6.365 km end to
  end, and the two overpasses that read the *same* local wall clock 03:30 are an
  hour apart in UTC and stay in that order; the pixel re-delivered after the fold
  adds no ninth uid. S16 (bbox edge) puts six pixels at 41.90 N stepping east
  across the alertable east edge at 29.8849° E, three on each side, 0.830 km
  apart: one event holding all six, because the polled box reaches ~90 km further
  east than that edge, far more than `MIN_BBOX_BUFFER_KM` = 42 km.
  Both were verified the way the D5 fixtures were — distances computed by hand
  from `clustering_params_v1` before the engine was asked, then the CI-2 double
  run under two zones and locales byte-diffed.
  Two things the authoring turned up and did not paper over. GATES §1.1 S14 said
  "02:30 local" for both 2026-10-25 and 2027-03-28; that is the Central European
  fold, not Bulgaria's. `Europe/Sofia` goes 04:00 EEST → 03:00 EET in October and
  03:00 EET → 04:00 EEST in March, so **03:30** is the reading that happens twice
  and then not at all, while 02:30 is unambiguous on both dates. GATES is
  corrected, with the reasoning kept next to the table so it cannot be
  "simplified" back. And S16's fire is necessarily at sea: the alertable east
  edge is a constant meridian, and at Thracian latitudes it lies in the western
  Black Sea. The scenario is about the geometry of the boundary, not about a
  plausible fire, but a future author wanting terrain has to move to ~45.05 N
  (Danube delta) or ~41.12 N (Şile), not nudge the longitude.
  Note also that two earth models meet in S16 — `polling-bbox.ts` places the edge
  with 111.32 km/°lat and a cosine longitude scale, while `clustering_params_v1`
  measures identity with 111.085 and a linear one. The ~0.2 % disagreement is far
  below both margins here (0.41 km and 2.08 km), but it matters if anyone ever
  tightens the buffer toward `MIN_BBOX_BUFFER_KM`.
  2026-09-02: S7, S8, S11 and S12 are authored and green — the lifecycle
  scenarios in this range, driven over the fixture clock now that
  `identity-engine.ts` ticks D4 once per poll (see D4 for what each asserts and
  the counterfactual that pins it). Their five `blockedBy` flags cleared in
  `core/replay/register.ts` in the same change, because the gate demands the
  directory the moment a flag becomes `null`; the constant that named the
  lifecycle blocker is gone with them.
  One constraint shaped all four and is worth writing down: `expected.json`
  records only the *final* report, so a scenario whose claim is visible only in
  an intermediate poll would stay green through a regression. Each fixture is
  therefore built so the claim lands in the last tick's `status` or
  `displayTier` — S8's is the clearest, where the assertion is carried by `map`
  rather than `feed`.
  What keeps this unticked: S10 needs D10's day-only repeat quarantine rule, and
  S13–S15 are owned by WP6/WP3 and are not stubbed yet. The `--gate=pre-season`
  run exits 0 with those three still carrying a `blockedBy` — that is the
  register doing its job, not the suite being finished.
  2026-09-03: S13 is authored and green against the real `decideAlert` (see D9),
  so of this range only S10, S14 and S15 still carry a `blockedBy`. It is
  `required: 'suite'`, so it is in no set CI-1 demands — though it runs, and is
  diffed, on every replay invocation — and this done-when is unmoved.
  2026-09-07: S14's `blockedBy` cleared too — see D9 for `produceDigest` landing
  — so of this range only S10 and S15 still carry one.*
  *2026-09-23 — S15 is proven elsewhere, not by a fixture: `register.ts` gained
  `provenBy` (S15 → `web/src/core/feed/cursor-client.property.test.ts`, plus
  `snapshot-route.s15.property.test.ts` server-side); `replay-cli --gate` fails if that
  file is missing and prints `replay_gate_elsewhere`; `registerProblems` flags a fixture
  that duplicates an elsewhere-proven scenario.*
- [ ] **D7 — Parameter fit.** Spec: GATES §2; ADR-002 D2. Inputs by register id: DS-1 (detections), DS-3 (labels), DS-4 (eps_geo only) in `docs/data/DATASETS.md`; does not start until DS-1 and DS-3 carry a `--check` date (23 E1). Needs: B8 (backfill),
  D1. Grid search (~600 configs) vs EFFIS BA labels; plateau rule; fitted params
  land as versioned config-as-data. **Done when:** GATES §2 acceptance thresholds
  met and the chosen config committed with its fit report.
- [ ] **D8 — QA metrics harness + weekly report.** Spec: A2 (shadow definitions);
  A11 formulas. Needs: D1. Shadow-PCR/PLB + FER/FLR/DAR computed from the shadow
  pipeline; weekly job. **Done when:** one real weekly report generated.
  *2026-09-03, landed (the pure half): `server/src/core/qa/` — `qa-metrics-params.ts`
  (`qa_metrics_v1`, digest `43e53e7c`), `rate.ts`, `quantile.ts`, `grid-zones.ts`
  (the CP1 synthetic 10 km lattice, 74×62, pinned as literal degrees rather than
  derived through `Math.cos`, which ECMAScript does not require to be correctly
  rounded), `shadow-pcr.ts`, `shadow-plb.ts`, `fer.ts`, `flr.ts`, `dar.ts`. 161
  tests; the five metrics' JSON output is byte-identical under
  `TZ=Pacific/Kiritimati LC_ALL=tr_TR.UTF-8`. Every function returns the numerator
  and the denominator alongside the rate, and `rate` is `null` rather than 0 when
  the denominator is — a metric with no population is not a passing metric.*

  *Two things the write-up assumed and the documents disproved: **FLR and DAR are
  both defined**, in GLOSSARY §8 (FLR "≥ 3 lifecycle direction reversals within 48 h
  ÷ active events", flag + review with no numeric gate; DAR "Duplicate Alert Rate",
  ≤ 5% shadow → ≤ 1% steady). No definition had to be invented. **CER and ZAP** are
  in the same register and are **not** in D8's list, so they are not implemented —
  stated here so the omission is deliberate rather than discovered later.*

  *One document defect found, not silently worked around: **ADR-002 A2.3(3)
  contradicts itself.** It says the 14-day-unobservability closures are "excluded
  from the FER numerator … so the fallback can never be used to flatter the FER
  metric" — but removing them from the numerator only, while leaving them in the
  denominator, **lowers** FER, which is exactly the flattery the sentence forbids.
  The intent was taken as normative (the class leaves the whole population, and the
  excluded ids are enumerated in the result), and the literal reading is one version
  bump away behind the config key `fer.excludeUnobservableClosures`. A founder's
  ruling is owed on which text is wrong.*

  *Done-when unchanged and still unmet: a real weekly report needs a live season.
  What remains is wiring, and each input the shadow pipeline must produce — down to
  `available_at` being the poll time of the first poll that returned the row, **not**
  `acq_ts` — is typed at the module boundary.*

  *2026-09-23 — impure half code-complete, uncommitted: migration 011
  (`qa_weekly_reports`, PK week + metrics version + report version, a different digest
  under the same versions is refused), `pg-qa-report-store.ts`, pure builder
  `core/qa/weekly-report.ts` (byte-stable canonical JSON + Markdown, TZ/locale-proof),
  CLI `pnpm --filter server qa-report` (`--week=YYYY-Www` | `--from/--to`), and an hourly
  worker loop `qa_weekly_report` that builds the last closed ISO week once. DAR and
  Shadow-PLB (first two stages) are measured; Shadow-PCR, FER and FLR ship as
  `unavailable` with a reason (no EFFIS perimeter store, no lifecycle transition log).
  Open: week boundary (ISO/UTC assumed, unratified), DAR instant (`decided_at`), season
  bounds. The 11-test integration suite has not run (no Docker).*
- [x] **D9 — Pure alert-decision function (pulled forward).** Spec: ADR-004 D4
  gating as amended by A16. Needs: D1. Side-effect-free decision fn over
  (event, zone, config) so fixtures can assert alerts years before channels
  exist. **Done when:** S13 stub asserts decisions (no sends).
  *2026-08-29: implemented as `config/alert-gating.ts` (`alert_gating_v1` — the
  thresholds, the A1.11 ladder and the A1.2 priorities as versioned
  config-as-data, so a stored `rule_version` can be read back years later) and
  `alerts/alert-decision.ts` (`decideAlert`, plus `escalationStep`,
  `isInQuietHours` and the A1.12 `chooseNotifyingZone`). The signature is the
  union of the two the docs give — 06 §R3's `(event, zone, alertHistory)` and
  this line's `(event, zone, config)` — because A1.6's parent chain, A1.11's
  watermark and D3's suppression window all need prior state; the state arrives
  already folded by `foldAlertStates`, so the function never learns what a merge
  is. Outcomes are `send | defer | seed | suppress`: there is no all-clear in the
  type, and a lifecycle or score downgrade returns `suppress`. Unticked because
  the S13 half needs D5's fixture harness, which still does not exist; the
  stand-in in `alert-decision.test.ts` drives a zone created mid-scenario over
  three pre-existing fires (three seeds, zero sends) and one that starts
  afterwards. Three things for review: the digest floor **defers** rather than
  drops, since D3 says overflow folds into the 09:00 digest, which makes it the
  tighter-named half of the same window rather than a separate gate; the ladder
  step is the **highest** holding rung rather than a count, which is what bounds
  an event at three escalations per zone for its whole life; and rung 3 excludes
  `archived` on purpose — past T_LINK that path mints a new event with a
  reignition link (D3), and firing both would escalate one fire twice. Two
  numbers a decision needs are not in the schema yet: the previously notified
  score bucket and burned area, which the ladder measures growth against, arrive
  as `LastNotifiedContent` read from the last outbox row's `template_params`
  because the ladder measures what the user was actually told.*
  *2026-09-03: the replay seam now exists. `core/replay/alert-engine.ts` — engine
  name `alert`, registered in `adapters/fixtures/replay-cli.ts` — wraps the
  identity engine and calls the real `decideAlert` and `chooseNotifyingZone` once
  per (zone, event) per poll, so this line's "fixtures can assert alerts years
  before channels exist" is now cashed rather than promised. The S13 half of the
  done-when is met: `server/fixtures/S13/` is authored — a zone drawn over fires
  that are already burning, asserting eight alert rows (a seed per zone for each
  pre-existing fire, one `send`/`first_alert`/`new_fire` for the fire that starts
  after the zone exists, `suppress`/`no_new_ladder_step` for the rest) — and it is
  green everywhere it runs. `--gate=` scopes the register obligation, never
  the run loop, so S13 is already asserted inside CI-1's `--gate=pre-merge` double
  run; its own `--gate=suite` exits 0, and the two-process CI-2 run (`TZ=UTC` vs
  `TZ=Pacific/Chatham`, Turkish locale) is byte-identical.
  Two limits of the seam, stated in `alert-engine.ts`'s header and in
  `server/fixtures/README.md` so a green run is not over-read: scores are fixture
  **inputs** (the `scores` observation array), never computed, because nothing in
  the repo scores an event yet; and the missing outbox pins `lastNotified` to
  `NOTHING_NOTIFIED`, so ladder rungs 1 (score upgrade) and 2 (area doubling) can
  never hold in a fixture — only rung 3, lifecycle worsening, is reachable.*
  *2026-09-07: the second half of D9's D3 obligation is met too. `produceDigest`
  (`core/alerts/digest.ts`), configured by `digest-params.ts`'s `digest_params_v1`,
  runs as a second pass in `alert-engine.ts` once per account per poll, after
  every event that poll has been decided, and folds the deferrals a window
  collects into one digest row per account per window start. That producer was
  S14's only `blockedBy`, so the register entry now reads `null` and the fixture
  is authored and green: fourteen polls, nine events, 154 alert rows, two zones on
  two accounts, and four digests keyed 25 hours apart across the fall-back day and
  23 apart across the spring-forward one. S13 grew from eight alert
  rows to eleven: the three pre-existing fires it seeds now also return in the
  next 09:00 digest, per its updated `asserts` text. Verified end to end: the suite
  runs thirteen fixtures and exits 0, `--gate=pre-merge` and `--gate=pre-season` too,
  and the CI-2 pair (`TZ=UTC LC_ALL=C` vs `TZ=Pacific/Kiritimati LC_ALL=tr_TR.UTF-8`)
  is byte-identical; `pnpm run verify` exits 0 at 140 test files / 2238 tests.*
- [ ] **D10 — Data prep: masks + land cover + cloud join.** Spec: A6. Needs: B8.
  Static hot-source mask (backfill + curated seed), WorldCover/CORINE prep,
  hourly cloud-cover join. **Done when:** S3/S4 use real mask data.
- [ ] **D11 — CP1 evaluation run.** Spec: A2 protocol. Needs: D7, D8. Execute the
  protocol, produce the dated report artifact, record go/pause. **Done when:**
  the CP1 report exists and is linked from GATES §4.
- [x] **D12 — Confidence score v0 (the score half of ADR-002 D6).** Spec: 11 §3
  (§3.2 pseudo-probability table, §3.4 feature catalog, §3.5 the hand-set v0
  logistic, §3.6 hard overrides); ADR-002 D6 for the bucket contract. Needs: D1.
  `score_params_v0` as versioned config-as-data; the ten features x1–x10 over an
  event snapshot; the logistic, the buckets (Confirmed ≥ 0.75 / Likely
  0.45–0.75 / Unverified < 0.45) and the static-source override (score 0 +
  `invalidated`), applied outside the formula. **Done when:** the five worked
  examples of 11 §3.5 are asserted as tests, and S5's second half — "stays
  Unverified" — is expressible.
  *2026-09-03: **added because it was missing.** The register carried eleven
  D-track tasks and none of them owned the score: D4 is titled for ADR-002 D6 but
  implements only that decision's *lifecycle* half, so the *score* half — a
  normative decision of the same ADR — had no owner, no wave and no done-when.
  The gap was invisible from `TASKS.md` alone and visible from
  `core/replay/register.ts`, which has been holding three scenarios back
  against a blocker — "nothing in the repo computes a score, so no event has a
  bucket" — that cited an ADR decision because there was no task id to cite. The
  blocker string now reads `D12 — …`, so the register and this file point at
  each other. That is the register working as designed: a
  suite that only knows the fixtures someone wrote can never notice the one
  nobody wrote, and the same is true of a task list. Cost of the omission: S5 has
  been shipping as a deliberately partial fixture, and S3 and S4 are blocked on
  **two** absences (masks and score) where the task list showed only one, D10.*

  *Scope boundary, so this does not silently become D7: the weights here are 11
  §3.5's hand-set v0 and are **not** fitted. Refitting them on the backfill is
  §3.7's work and belongs to D7, which cannot start until DS-1 and DS-3 carry a
  `--check` date. The logistic shape is chosen precisely so the fit replaces the
  weights without changing the score's meaning for its consumers.*

  *Known incompleteness at the input boundary, stated rather than defaulted: x7
  (`x_fwi`) needs EFFIS FWI and x8 (`x_agri`) needs the land cover D10 owes, so
  neither can be computed from anything the repo holds. They are explicit inputs
  to the scoring function, on the precedent already set by cloud cover in the
  lifecycle tick and by `scores` in the alert engine — a fixture states them as
  observations. This means a green score fixture does not demonstrate the agri
  penalty firing on real data, and S3 stays blocked on D10 for exactly that
  reason even after this task lands.*

  *2026-09-03, landed (first half): `server/src/core/scoring/` — `score-params.ts`
  (`score_params_v0`, digest `e920a2f5`: the intercept, the ten weights, the §3.2
  `c_i` table, the bucket floors, and the reading rules the documents leave to the
  implementer — how a polar "overpass" is identified when the archive carries no
  pass id, the GEO 3 h overpass-equivalent bucket, the coherence radius, the edge
  multiple, the score quantum), `features.ts` (x1–x10 over `(detections, context,
  params)`; `ScoringDetection` is deliberately **wider** than `ClusteringDetection`,
  because the score reads confidence and FRP that identity refuses on purpose), and
  `score.ts` (`linearPredictor`, `logistic`, `bucketOf`, `scoreEvent`, and
  `scoreChangeMayNotify`, which compares **buckets** not scores so a score that
  drifts inside a bucket cannot notify). 98 tests. The §3.5 worked examples are
  asserted twice — verbatim from the table, and again with the features as §3.4
  defines them — because the table has four arithmetic defects; they are recorded
  as an errata block in 11 §3.5 and were **not** absorbed by adjusting a parameter.
  The bucket is unchanged in all five rows.*

  *2026-09-03, landed (second half) — **ticked**. `core/replay/identity-engine.ts`
  now calls `scoreEvent` for every reported cluster, so `ReplayEvent.bucket` is an
  answer rather than a `null` placeholder, and `assertPinnedVersions` demands
  `score_params` for the same reason it demands the pass table: a bucket recorded
  under one set of weights asserts nothing under another. Both halves of the
  done-when are met — the five §3.5 examples are asserted, and S5's "stays
  Unverified" is now expressible and expressed. The order was fixture-first, which
  is the discipline `register.ts` exists to enforce: all fourteen buckets across the
  eleven identity/alert fixtures were computed **by hand** from §3.2's `c_i` table and
  §3.4's feature definitions before the engine was run, the engine then reproduced
  all fourteen, and only then did S5's `SCORE` blocker come down. The arithmetic is
  written into `server/fixtures/README.md` under "Score buckets" rather than left in
  a terminal. Two boundary rows to know about: S9 at 0.763809 and S16 at 0.759289
  clear the Confirmed floor by about 0.015.*

  *What the wiring does **not** buy, stated so a green suite is not over-read.
  Three of the ten features are structurally zero in every fixture, and only one of
  the three fails safe: `x_fwi` withholds credit (safe), `x_edge` is unreachable
  because poll rows carry no `scan`/`track` footprint (safe — every pixel resolves to
  its nadir size), and `x_agri` withholds a **penalty**, so a replayed agri-burn
  scores higher than it should. `staticSourceMaskHit` is likewise `false` rather than
  unknown, so §3.6's override cannot fire. That is why S3 and S4 stay blocked, and
  their blocker string was rewritten to say so: the score is no longer the missing
  piece, its mask-derived inputs are. The remaining gap for D7 to close is that
  nothing outside the replay path scores anything — the ingest cycle and the
  detection store still do not persist a score or a bucket.*

  *2026-09-26 (wave G) — the score is written live. Until now the identity pipeline never
  wrote `fire_events.score`, so every live event sat at 001's default 0 and alert
  evaluation saw every one as `below_threshold`. `core/identity/event-scores.ts` scores
  exactly the events whose member set a batch changed (seeds, attaches, merge survivors —
  11 §3.4) with `scoreEvent` under `score_params_v0`, reading the scorer's rows back from
  `detections` inside the batch transaction; `pg-clustering-store.ts` writes the score in
  the same UPDATE as the aggregates. Migration **017** adds
  `fire_events.score_params_version` (D5: a score is a claim only together with its
  weights; NULL = never scored, no backfill; bookkeeping, never bumps `seq`). The
  `live_event_score_unwritten` gap is removed from `ALERT_EVALUATION_GAPS`.
  `pipeline.integration.test.ts` asserts the persisted score, version and on-wire bucket.*

## Track E — WP3 read path (Nov–Dec 2026)

- [ ] **E1 — Snapshot endpoint + seq discipline.** Spec: ADR-003 D1 (T1 row) as
  amended by A15 (A1.4/A1.5). Needs: D1. `/snapshot.json` ETag-from-maxSeq,
  `?updated_after_seq` cursor, the set-membership seq invariant enforced in the
  status layer. **Done when:** removal test — an event leaving the set always
  changes the ETag.
  *2026-09-18, not ticked — the code and the removal test are written; the test is an
  integration suite this machine cannot run (no Docker), so the tick waits for a green
  CI run. Landed: migration `004_event_display_tier_seq_discipline.sql` (`display_tier`
  and `inactive_since` as persisted columns, a BEFORE UPDATE trigger that bumps `seq`
  whenever a projected column changes and the writer left `seq` alone, refuses a `seq`
  that moves backwards, and stays quiet on bookkeeping writes; a partial index on the
  active-set predicate ordered by `seq`); `adapters/db/pg-event-status-store.ts` (the
  one transition statement — status, reason, instant, tier, anchor and `nextval` in one
  row) behind `core/ports/event-status-store.ts`; `adapters/db/pg-snapshot-reader.ts`
  behind `core/ports/snapshot-reader.ts` (rows and the global mark from one statement,
  mark over the whole registry incl. tombstones); `core/snapshot/snapshot-builder.ts`
  (the GeoJSON wire shape the web parser guards, `schema_version` folded into the ETag,
  score bucketed never raw, `attribution` from the credits registry — moved to
  `packages/contracts/src/credits.ts` so both ends read one list); `adapters/http/
  problem.ts` (the single RFC 7807 handler: `about:blank`, fixed titles, literal
  `detail`, `instance` = route pattern, `correlation_id` shared with the log line) and
  `adapters/http/snapshot-route.ts` (GET/HEAD, `Cache-Control: public, max-age=0,
  s-maxage=30, stale-while-revalidate=60`, weak `If-None-Match` → 304 before the
  sources query, cursor validated to one non-negative integer and any other query
  parameter refused so the cacheable URL set is path × one integer, CORS `*` GET only,
  no per-IP throttle but an in-flight cap of 8 → 503 + `Retry-After: 1`, a failed read
  → 503 + `Retry-After: 5` with the driver error redacted into the log only). The route
  is served by the API process next to the probes on its own pool (4 connections, 2 s
  statement timeout) so a cold-cache burst cannot starve `/readyz`. The R1 suite in
  `pg-snapshot-reader.integration.test.ts` covers the transition, the merge tombstone
  and the operator invalidation with the writer forgetting `seq`, the display window
  closing, the return, and the bookkeeping write that must *not* move the mark.
  **Known limits:** `seq` is a sequence, not a commit order — a transaction that drew
  100 can commit after 101 was read; harmless while the lifecycle job is the only
  writer and runs serially, and a second writer needs the mark bounded by
  `pg_current_snapshot()` (noted in the reader header, not built). The feature carries
  the public id twice (`id` and `uuid`) because the web parser still keys its store on
  `uuid`; dropping the duplicate is a web-side follow-up. `area_ha` and
  `next_pass_window` are `null` until their producers exist. Not part of E1: nothing
  calls `EventStatusStore` outside its tests yet — the scheduled lifecycle transitions
  (D-track) own that, and until they run every inserted event stays on the map tier
  the column defaults to.*
  *2026-09-23 — "nothing calls EventStatusStore" is resolved in code: live
  lifecycle transitions go through `createPgEventStatusStore`, so `seq` moves from a
  running process (D1/D4). Practically inert until D4's evidence is armed.*
  *2026-09-26 (wave E) — the duplicate id is gone: `properties.uuid` is no longer emitted
  and the web store keys on the public id (`id`). The parser requires the GeoJSON feature
  `id` and its `properties.id` twin and rejects a feature missing either or where they
  disagree; `resolveEvent` reads the store directly instead of building a side index.
  Dropping a field a v1 parser required is a wire break, so `SNAPSHOT_SCHEMA_VERSION` is
  now 2 and the ETag reads `"v2-<max_seq>"` (the e2e origin derives its tag from the
  body's `schema_version` the same way). Fixture `web/public/fixtures/snapshot.json`
  moved to v2 with no `uuid`; the SSE `upsert` frames share `eventFeature`, so they
  dropped it too.*
- [x] **E2 — SSE tier (T0).** Spec: ADR-003 D1 (T0 row) + D3 (the 10-min safety
  snapshot). Needs: E1. Ring buffer, 5,000 cap + 503/Retry-After, drain
  semantics, 10-min safety snapshot. **Done when:** replay/gap/reset property
  tests green.
  *2026-09-19 — ticked on the unit suite, which is where the done-when lives: the
  fast-check suite in `core/stream/stream-replay.property.test.ts` drives a D3 client
  through any sequence of registry changes, ring evictions, dropped frames and
  reconnects and checks that it ends on the registry's active set or with
  `needsSnapshot` raised — never silently wrong — plus replay idempotence, seq
  monotonicity, exact ring floor/latest/size, and "every cursor is replay iff within
  `[floor, latest]`, `too_old` below, `unknown` above". Landed: `core/stream/frames.ts`
  (the wire contract — `id:` on event frames only, so `Last-Event-ID` always names a
  `seq`; control frames `freshness|reset|degrade` carry none; `retry:` and the `: hb`
  keepalive); `frame-ring.ts` (1,000-frame ring keyed by `seq`, floor rises on
  eviction, a cursor inside a seq hole means "missed nothing since"); `change-projector.ts`
  (rows → `created|updated|status_changed|merged` against the set the stream last told
  the client; an event leaving the map emits nothing and is forgotten — D3 rule 5);
  `stream-hub.ts` (admission with the 5,000 hard cap → `capacity` and a per-client cap
  → `client_cap`, broadcast, drain with a deterministic `retry:` spread); `stream-pump.ts`
  (the cursor over `fire_events.seq`: seeds from the active set — that read gives the
  cursor, the known set and the ring floor — then reads change pages, projects,
  pushes through the ring and broadcasts; `freshness` on every move and at least every
  30 s, cached for connects; a failed tick leaves the cursor where it was; never
  overlaps); `core/ports/change-reader.ts` + `adapters/db/pg-change-reader.ts` (rows
  past a cursor *whether or not active*, survivor's public id via a self-join on
  `merged_into`, mark and rows from one MVCC snapshot); `adapters/http/stream-route.ts`
  (`GET /api/v1/stream`: 503/`Retry-After: 5` before the seed, 503/60 at capacity,
  429/60 per client, then `retry: 5000`, replay-or-`reset`, cached `freshness`;
  `text/event-stream`, `no-cache, no-transform`, `X-Accel-Buffering: no`, CORS `*`;
  cursor from `Last-Event-ID`, else `?last_event_id=` for the first connection a
  browser `EventSource` cannot set a header on; an unparseable or absent cursor is a
  `reset` — never a 400, which an `EventSource` would retry forever; a client that
  stops reading is cut at 256 KiB unsent; a closed socket releases its hub slot,
  verified under `inject()` and over a real socket); `adapters/http/client-key.ts`
  (one client key for the limiter and the hub); `app/health-wiring.ts` (fourth pool of
  one connection for the serial pump, 2 s tick, 25 s keepalive, first tick not awaited
  so the process comes up with the database down, shutdown = clear timers → drain with
  `retry:` spread 1–10 s → `app.close()` → end pools). The stream is exempt from the
  probe limiter and `no-store` like the snapshot.
  **Where the rest of the row lives:** the 10-min safety snapshot and the 30-min
  hysteresis are the client supervisor's rules (E5); the A1.1 demotion triggers that
  would send `degrade` are E4's; the frame type exists, nothing sends it yet.
  **Notes for E5:** `seq` is global and has holes by design — an event leaving the map
  bumps its `seq` but emits no frame — so under D3 rule 3 every hole costs one cursor
  snapshot; the web `reconciler.ts` assumes contiguous seqs today and must apply
  replayed frames one at a time and treat `freshness.max_seq > client.maxSeq` as
  `needsSnapshot`. A first connection without a cursor gets a `reset` on purpose: the
  client's correct first move is a snapshot, and the stream should not replay the
  world. **Known limits:** the pump polls every 2 s — LISTEN/NOTIFY would cut the
  delivery latency and the idle reads, noted, not built; `SELECT_CHANGES` has a unit
  test against a fake driver but no integration suite yet (the `merged_into` self-join
  and the `seq` ordering deserve one, CI-only here); no per-IP throttle on the stream
  beyond the per-client connection cap; no `degrade` sender until E4.*

  *2026-09-26 (wave G) — open issue found by `app/api.integration.test.ts` (API process
  against real PostGIS). The snapshot reads the database directly; the stream knows only
  what the pump has read (`STREAM_TICK_MS`, 2 s). A client that connects with the
  snapshot's `max_seq` as its cursor within one pump tick of a write is ahead of the
  buffer and gets `reset` reason `unknown` (`frame-ring.ts` describes `unknown` as "made up
  or the database went backwards", which misses this case), refetches, and can be reset
  again until the pump catches up. Candidate fix: a cursor ahead of the buffer triggers one
  shared catch-up read before the answer. ADR-003 design call, not made; the test waits for
  the pump (`streamCaughtUpTo`) and keeps its `not.toContain('event: reset')`.*
- [ ] **E3 — R2 static mirror (T2) + age monitor.** Spec: ADR-003 D1 (T2 row) as
  amended by A15 (A1.2 — the flip is client-side, never a Worker route);
  14 E-minor. Needs: E1. Upload job, second hostname, object-age monitor.
  **Done when:** killing origin in staging leaves T2 serving fresh-enough data
  with the age alarm quiet.

  *2026-09-23 — code complete to staging, uncommitted, not deployed. The worker pushes the
  exact API snapshot bytes to R2 every 60 s as one signed atomic PUT (`public, max-age=0,
  s-maxage=30`, `x-amz-meta-generated-at`) via a hand-written SigV4 signer
  (`adapters/storage/s3-sigv4.ts`, AWS vectors + properties, no new deps); the age monitor
  HEADs the public T2 URL every 60 s and takes age only from job-written metadata or
  Last-Modified (the F4 lesson). Wired in the worker, off with a logged reason unless the
  `FIRE_WATCH_R2_*` group is set. Open: bucket-bound hostname and its header echo, bucket
  and EU jurisdiction, token, budgets (300/900 s), no T2 copy of the freshness report,
  and a live push hiding a frozen ingest (the F4 open point).*
- [ ] **E4 — `/api/client-config` fleet control.** Spec: ADR-003 D1 (server-side
  transport control) as amended by A15 (A1.1 demotion triggers; A1.3 renames the
  route `/api/v1/client-config`). Needs: E1. Poll intervals, tier demotion flags,
  Esri-toggle kill. **Done when:** changing config moves the test fleet without
  deploy.
  *2026-09-19 — code landed, deliberately unticked: the done-when is a fleet
  observation and there is no host, so no test fleet (tick after the first staging
  flip is watched, alongside E6). What is proven locally, in `app/health-wiring.test.ts`
  over a real `createStreamHub` and a real controller on a `VirtualClock`: a full hub
  or five sustained minutes of lag/CPU flips the document to `poll`, every open stream
  hears exactly one `degrade` frame (`capacity` | `load`) and is closed, `/api/v1/stream`
  answers `503` + `Retry-After: 60` until re-offered, and the re-offer after 30 clear
  minutes is one log line with nothing pushed. Landed: `packages/contracts/src/
  client-config.ts` (the three-field wire document and the poll-interval bounds the
  web client already enforces — rebuild `dist`); `core/transport/demotion.ts` (pure
  step function: trigger 1 reads *at* the cap because the hub refuses admission there
  — the count never exceeds it; sustained windows run from the first over-threshold
  sample, a `null` reading is "no evidence"; 30-min re-offer window resets on any
  excursion; `sseEnabled: false` pins `poll` and announces nothing); `adapters/system/
  event-loop-lag.ts` (`monitorEventLoopDelay` p99 per window, resolution subtracted)
  and `host-cpu.ts` (host busy fraction from `os.cpus()` deltas — host, not process:
  one VM shared with Postgres and the worker); `adapters/http/client-config-route.ts`
  (`Cache-Control: public, max-age=30`, no SWR — it would let the edge serve the
  pre-flip document past L-2's one-TTL bound — no ETag, CORS `*`, any query string
  → 400 so `?_=` cannot bust the edge); `stream-route.ts` gains `offered()`;
  `health-wiring.ts` runs the 5-s sampler and `createTransportWatch`. Env:
  `FIRE_WATCH_SSE_ENABLED` (operator kill = env change + restart, no live toggle
  surface), `FIRE_WATCH_CLIENT_POLL_INTERVAL_MS` (default 45 000),
  `FIRE_WATCH_STATIC_SNAPSHOT_URL`. Not in this slice: the Esri-toggle / imagery
  block (ADR-001 A1.3) — it is G6's, and the document is additive.*
  *2026-09-26 (wave F) — `event-loop-lag.test.ts` read `null` at load avg ~150: it
  assumed the libuv timer behind `monitorEventLoopDelay` fires inside fixed 30–60 ms
  windows (and the first firing only sets a baseline). The sampler now takes an
  injectable histogram factory; the arithmetic (resolution subtracted, reset per
  reading, clamp at 0, null when stopped/empty) is pinned against a scripted histogram,
  and the one real-histogram test waits on the histogram's own count instead of a fixed
  window.*
- [x] **E5 — Client reconciler + transport supervisor.** Spec: ADR-003 D3 as
  amended by A15 (A1.5/A1.6); CI-7/CI-8; 14 M1/S15. Needs: E1. Framework-free
  core, five rules, 30-min hysteresis, server-time offset, cursor-mode
  full-snapshot cadence; fast-check suites incl. S15 (cursor-only removal
  convergence). **Done when:** CI-7/CI-8 + S15 green.
  *2026-09-19 — code landed, deliberately unticked: CI-8 and S15 are green on the
  unit suite; CI-7 ("the full e2e suite passes with SSE disabled") has no suite to
  run yet — that is E6's polling-only e2e, so E5 ticks with E6's first green run
  with `sseEnabled: false`. Landed under `web/src/core/` (framework-free, cruised):
  `store/reconciler.ts` (the five D3 rules as pure reducers over `ReconcilerState`
  — snapshot is set authority, `seq` is version authority; a full snapshot removes
  an absent event iff `snapshot.maxSeq > stored.seq`, else notes the absence and
  removes on the second consecutive one; deltas/partials upsert iff `seq` is
  strictly newer and never delete; a stale-create floor `settledSeq` refuses an
  unknown id — or an un-tombstoning copy — at or below the last settled seq, so a
  late frame cannot resurrect what a snapshot proved gone; `mergedInto` tombstones
  sit outside set reconciliation and age out on the *server* clock after 24 h; a
  skipped seq raises `needsSnapshot`, no buffering); `store/store.ts` (the one
  `dispatch`, listeners fire only on exposed change); `feed/server-time.ts` (A1.6
  offset from `Date` headers, the only clock `generated_at` is compared against);
  `feed/polling-feed.ts` (T1: ETag/304, cursor `?updated_after_seq=` partials, full
  snapshot every 10 min; T2 static copy); `feed/sse-feed.ts` + `stream-frames.ts`
  (T0, one event per frame, `?last_event_id=`); `feed/supervisor.ts` (pure reducer
  `BOOT → POLLING → SSE_CONNECTING → SSE_LIVE`, silent drop back to polling with a
  30-min re-offer hold, A1.2 flip to `STATIC_FALLBACK` on three unusable origin
  answers spanning two intervals or one stale snapshot, 30-min continuous-healthy
  recovery, `wake`/`online` force a full refetch); `feed/feed-coordinator.ts`
  (carries the effects out); `feed/client-config.ts` (E4's contract). CI-8 is
  `store/reconciler.property.test.ts` (17 properties: no `seq`/floor/anchor
  regression, snapshot and delta idempotence, batch order-insensitivity, stream-
  vs-batch equivalence, gap detection exactly on a skip, no zombies at or below the
  set evidence, no flicker-delete, tombstone age-out) and
  `feed/supervisor.property.test.ts`; S15 is `feed/cursor-client.property.test.ts`
  (a removal is invisible to cursor polls, lands on the next full fetch, never
  resurrects). One real bug the suite found: the un-tombstone branch of the
  stale-create guard classified against the in-batch draft, so a batch carrying
  `a@2 tombstone` and `a@3 active` under floor 3 landed differently by array order;
  it now classifies against the pre-message state (pinned as an example test).
  Facts to keep: `seq` has holes by design (a removal bumps it and emits no frame),
  so each hole costs one cursor snapshot; the web defines its own wire types and
  never imports `server/`.*
  *2026-09-22 — ticked. CI-7 now exists and is green: `web/e2e/polling-only.e2e.ts`
  drives the built bundle (`web/dist`) in a real headless Chrome against a scripted
  loopback origin whose `/api/v1/client-config` says `transport: "poll"`, so the whole
  run is T1 and nothing else. Six scenarios, all green on four consecutive runs
  (~65 s each): the boot handshake (client-config, then one unconditional full
  snapshot); the cadence (cursor `?updated_after_seq=` polls one interval apart,
  unconditional first, `304` on the tag, the full and cursor ETag slots never crossed);
  change propagation (a status flip, an arrival and a removal — with the S15 rule
  visible at the wire: the cursor answer that omits the removed event does not remove
  it, the next full fetch does); permalinks (a row click lands on `/event/<id>`, and
  the merged tombstone `fw-2026-z7c3f` resolves to its survivor with the URL
  replaced); the honest clock (a stopped pipeline banners with the instant it stopped
  and keeps bannering across `304` revalidations, a fresh origin banners nothing); and
  A1.2 (a `503` streak flips the client to the static T2 copy with the list intact and
  no error surface). Every scenario also asserts `/api/v1/stream` was never requested
  and that `EventSource` was never constructed, at the network log and at the browser
  API. What CI-7 covers is therefore every feature that exists today — the suite must
  grow with each F-track surface; visual regression (08 §5.7.4) is not in it.*
- [ ] **E6 — Polling-only e2e + T2 failover demo.** Spec: IP WP3 DoD. Needs:
  E1–E5. **Done when:** both demonstrated in staging and recorded.
  *2026-09-22 — first half landed, deliberately unticked: the polling-only e2e suite
  is green (see E5's note and CI-7), but the done-when is "both demonstrated in
  staging and recorded" and there is no host. `web/e2e/` holds the harness
  (`browser.ts` — browser resolution: `FIRE_WATCH_E2E_BROWSER`, then the build
  `puppeteer-core` pins, then any browser in the puppeteer cache, then a system
  Chrome; `origin.ts` — the scripted loopback origin serving `web/dist` plus the five
  runtime routes; `fixture.ts` — the shipped fixture time-shifted and mutated;
  `page.ts` — one browser context per scenario, every off-origin request aborted, the
  `EventSource` constructor counted, deadline-bound condition waits) and the spec.
  Wiring: vitest project `e2e`, root script `test:e2e` (builds the web app first),
  root tsconfig reference, the wall-clock-ban exemption for `web/e2e/**`, and a CI
  job `e2e` that installs the pinned `chrome-headless-shell` into a keyed cache and
  falls back to the runner's Chrome with a warning. `puppeteer-core` ships no binary
  and the install is `--ignore-scripts`, so no job that never opens a browser pays for
  one. The T2 failover demo is the remaining half.*
  *2026-09-25 — T2 failover demo automated: `web/e2e/t2-failover.e2e.ts` (origin → 503 mid-session; stand-in R2 mirror `web/e2e/harness/mirror.ts` serving E3's object byte-exact; ADR-003 flip streak/span, preflight + 304 revalidation, honest-clock banner on the mirror `generated_at` without 304 re-anchoring, return to T1 only after hysteresis; shared world clock, no sleeps). Bucket CORS prerequisite: AllowedHeaders `If-None-Match`, ExposeHeaders `ETag`, `Date`. Done-when still needs the staging origin + real R2 recording. Findings: frozen ingest with a live push job looks fresh on T2; full host outage (no assets) not covered.*
  *2026-09-25 — load flake fixed: every deadline in `web/e2e/t2-failover.e2e.ts` is its client-derived bound × `LOAD_MARGIN` (default 4, env `FIRE_WATCH_E2E_LOAD_MARGIN`); no assertion weakened; added a load-independent timeliness check (failed polls before the first mirror read ≤ `STATIC_FLIP_STREAK + 1`); the e2e project runs files serially. Full `pnpm run test:e2e` green twice at load avg ≈ 9–12 (137 s, 155 s; previously flaked and took 920 s).*
  *2026-09-25 (wave C) — revalidation hangs traced: (1) product — a fetch or body that never settled held the polling loop forever (status stayed live, no T2 flip); `polling-feed.ts` now has `REQUEST_TIMEOUT_MS` = 60 s per request including the body, refetchNow/stop abort in-flight requests, 304/error bodies are drained (the CDP "ERR_ABORTED" on every cursor 304 was an unread body, not an abort). (2) harness — `until()` bounds every probe and reports probes/longest gap/CPU/major faults; `launchBrowser` raises `protocolTimeout` above the longest `waitForSelector`. (3) host — one failure showed a 268 s gap between synchronous probes (the Node process not scheduled; swap 9.0/10.2 GB).*


## Track F — WP4 map frontend (Nov 2026–Jan 2027)

- [x] **F1 — Preact shell + signals (`ui/`).** Spec: ADR-005. Needs: E5.
  *2026-09-22 — ticked. The shell is live, not scaffolded: `web/src/ui/app.tsx`
  is the single `LocationProvider` + `Router` over five routes (`/`,
  `/event/:id`, `/settings`, `/about`, `/credits`, default → home), and
  `web/src/boot.ts` wires store ↔ feeds ↔ supervisor ↔ UI and calls
  `coordinator.start()`, so the shell renders from the E5 reconciler rather than
  from a fixture. Signals carry the four cross-cutting states that would
  otherwise be prop-drilled through the map pane — `ui/age-window.ts`,
  `ui/map-camera.ts`, `ui/map-pane.tsx`, `ui/theme.ts` — while everything
  decidable stays in `ui/logic/` as pure functions with unit tests
  (`layout`, `theme`, `time`, `place`, `onboarding`, `credits`,
  `event-resolution`). The CI-7 e2e suite drives this shell end to end, which is
  what makes the tick evidence rather than inspection.*
- [x] **F2 — MapLibre controller + LayerRegistry (`map/`).** Spec: ADR-005 D4;
  B6/B7 outcomes. Needs: F1.
  *2026-09-22 — audited: the code exists and both B-track outcomes are honoured,
  but the tick is held. `map/layer-registry.ts` is the declarative registry with
  its own unit test; `map/geojson.ts` sets `promoteId` so feature state survives
  a source refresh (B6) and the registry is idempotent under a style reload
  (B7), which is what `map-controller.ts` relies on when it re-applies fire
  images, fire layers, the current snapshot and the selected feature state on
  every `style.load` — including the one a theme switch causes, where
  `setStyle(..., { transformStyle: preserveFireStyle })` keeps the fire layers
  across the swap. Held because CI-7 surfaced two robustness defects in the
  controller itself: `setSelected`/`setFeatureState` run with no
  `isStyleLoaded()` guard (the e2e suite currently has to expect "Style is not
  done loading." as known page noise), and a denied WebGL2 context makes every
  `readViewport()` throw inside the library, once per store push, instead of
  degrading to a list-only page. Neither is a registry bug; both are the
  imperative shell missing a guard. Tick when they are fixed and the e2e suite
  no longer allowlists the error.*

  *2026-09-22 — ticked; both defects are fixed and the condition above is met
  literally: `EXPECTED_PAGE_ERRORS` in `web/e2e/polling-only.e2e.ts` is now the
  empty array, so every scenario demands a silent console rather than tolerating
  a named error.

  The fix is one idea applied twice, and it is not an `isStyleLoaded()` guard.
  Both defects were the same category error — asking the map a question it has
  no frame to answer. A MapLibre `Map` that was refused WebGL2 returns early in
  its own constructor, so `style` is never created and the transform is never
  built; every `getBounds()` against it throws from inside the library. So the
  controller stopped assuming a frame exists: `readViewport()` returns
  `MapViewport | null`, latches `frameUnavailable` on the first throw, and marks
  `fw:map-unavailable` once. Every caller now branches on that null instead of
  on a state flag, and the branch is chosen per caller rather than blanket-early-
  returning: `pushDetections` returns **without clearing the sources**, because an
  empty collection is a claim about a frame nobody measured; `pushFireEvents`
  pushes unconditionally, because the event set does not depend on the viewport;
  `onViewportChange` and the hash `replaceState` are skipped, because there is no
  viewport to publish; `flyTo`/`flyToEvent` are no-ops. Selection uses
  `map.getSource(...) === undefined` as its guard — `getSource` is null-safe in
  6.1.0 while `setFeatureState`/`removeFeatureState` are not, so the source's
  presence, not the style's load flag, is the precise precondition.

  No `map.on('error')` handler was added. `Evented.fire` console-errors an
  unlistened `error` event, and MapLibre *fires* `GPUInitializationError` rather
  than throwing it, so a listener would silence the one console line that tells a
  reader's browser why the map is missing — the e2e scenario asserts that line is
  still printed, as the single allowed message on that path.

  One more defect surfaced while proving this, in `ui/map-pane.tsx`: the lazy
  import ended in a trailing `.catch(() => {})`, which covers the fulfilment
  handler as well as the import, so every fault in map setup was being filed as a
  slow network and left no trace. The handler moved into `then`'s second
  argument, where it sees only the import rejecting. That is why the defect was
  invisible on the cold-permalink path and only appeared on a row click.

  Proof is a seventh CI-7 scenario, "serves a browser that refuses the map a
  WebGL context": the harness overrides `HTMLCanvasElement.prototype.getContext`
  before any script runs, the scenario asserts the premise
  (`getContext('webgl2') === null`), then that the list renders, that
  `fw:map-unavailable` is marked exactly once, and that a row click still reaches
  the detail page. The `--enable-unsafe-swiftshader` launch flag stays: it is the
  baseline a real reader's browser has, and removing it would quietly move all
  seven scenarios onto the degraded path. `pnpm run test:e2e` — 7 passed (7).*
- [x] **F3 — Event list/detail + permalinks.** Spec: IP WP4; ADR-002 D4.
  Needs: F1. `/event/:id`, `mergedInto` `replaceState` redirect, URL-hash
  viewport, list view as peer surface (A7). **Done when:** merged-id permalink
  test green.
  *2026-09-22 — ticked; the done-when is met twice over, at two different
  levels. Unit: `web/src/ui/logic/event-resolution.test.ts:20` — "redirects a
  merged tombstone to the survivor path" — pins the pure decision
  (`redirectTargetFor` returns `null` for self-resolution and for an unknown id,
  a path only for a genuine merge, so a tombstone never bounces and an unknown
  id renders not-found instead of redirecting). End-to-end: the CI-7 scenario
  "opens the detail page from a row, and resolves a merged permalink to its
  survivor" drives a real browser from the list row to the detail page and then
  loads the tombstone id directly. `pages/event.tsx:88` performs the redirect as
  `route(redirectTarget + window.location.hash, true)` — replace, not push, so
  Back leaves the survivor page instead of ping-ponging, and the map hash
  survives the hop. Viewport state round-trips through `map/hash.ts`
  (`parseMapHash` on boot, `formatMapHash` on `moveend` via `replaceState`), and
  the list is a peer surface, not a map overlay: `ui/event-list.tsx` renders from
  the same store on `/` and `isMapRoute` decides only whether the map pane
  mounts.*
- [ ] **F4 — Honest-clock staleness UX + degraded banner.** Spec: ADR-005; A12
  §3b copy. Needs: F1, E5. Single-slot banner, freshness chip + "[?]" target,
  frozen-state label. **Done when:** copy strings come from the GLOSSARY tables
  (CI-11 lintable), not hardcoded.
  *2026-09-22 — audited: the surfaces are built and the done-when is all but
  met. `ui/status/` has the single banner slot (`banner-slot.tsx` +
  `pick-banner.ts` with its unit test, so at most one banner is ever chosen and
  the choice is a pure function), and `freshness-chip.tsx` carries the "[?]"
  target as `href="/about#data-freshness"`. Copy is not hardcoded: it comes from
  the typed catalogs, and `core/i18n/glossary-sync.test.ts` renders every frozen
  template with sentinel substitutions and asserts each literal fragment appears
  byte-exact in `docs/GLOSSARY.md` (§2, §3, §3b, §5.2) — that is the CI-11
  lintability the done-when asks for. Not ticked because of one honesty gap
  found while building CI-7: the snapshot-age staleness trigger is unreachable
  as long as the origin keeps answering 304, so the banner that should announce
  a frozen pipeline can stay silent while the data quietly ages. Whether that is
  dead code, already covered by `/api/health/freshness`, or a genuine bug is
  under investigation; the tick waits on the verdict.*

  *2026-09-22 — verdict: **a genuine bug, and a narrower one than the note
  feared.** The worry splits in two, and the halves have different answers.

  On **T1** the trigger is indeed unreachable, but 304 is not why:
  `server/src/adapters/http/snapshot-route.ts:119` builds every 200 with
  `generatedAt: deps.clock.now()`, so a frozen pipeline answering from the
  origin still stamps `generated_at` as "now". Nothing a live origin can send
  ages. That half is **covered by `/api/health/freshness`** — the report's own
  rows age, `pick-banner.ts` `staleSince()` reads them, and CI-7's "banners a
  stopped pipeline with the instant it stopped" drives exactly that path
  (`web/e2e/harness/origin.ts` says so in its own docstring). Same reasoning
  retires ADR-003 A1.2's second flip condition ("one fetched snapshot older than
  the T2 freshness bound") on T1: `supervisor.ts` `isStale()` is live code, but
  only a T2 body can trip it.

  On **T2** the snapshot can honestly age — the static copy is whatever the
  `snapshot-push` job last wrote, and a dead push job behind a live CDN freezes
  it — and there the trigger was genuinely disabled.
  `web/src/core/feed/polling-feed.ts` `settle()` computed `const full =
  request.slot !== 'cursor'`, which is true for the `'static'` slot too, so
  every static `304` emitted `snapshot-confirmed` with the response `Date` and
  `reconciler.ts` `applyConfirmation` re-anchored `lastSnapshotAt` to "now" on
  every poll. That is the dangerous case and not the safe one: the client is on
  T2 *because* the origin is unreachable, so the freshness side-poll throws and
  is swallowed, the last report received stays authoritative (`store.ts` dedupes
  by `generatedAt`), and `feedStatus` reads `live` because T2 status follows the
  static fetch alone. All three signals silent while the map shows yesterday.
  Fixed by emitting `snapshot-confirmed` only for `request.slot === 'full'` —
  the origin's answer — which is precisely what
  `packages/contracts/src/freshness.ts:89` says the trigger exists for. Origin
  confirmations are kept: without them a quiet night on a healthy origin would
  banner falsely, which is the opposite failure and is now its own test.

  Reachability is pinned by `web/src/ui/status/pick-banner.reachability.test.ts`
  — real store + polling feed + supervisor + coordinator, scripted `fetch`,
  origin goes dark, the supervisor flips to T2 on its own, the CDN answers 304
  for a quarter of an hour, and the assertion is the banner `pickBanner` picks.
  Its sibling case holds thirty minutes of a quiet healthy origin at no banner.
  Adapter-level: "a static 304 confirms nothing: a cache hit is not a live
  pipeline" in `polling-feed.test.ts`.

  Still not ticked — two staleness-honesty gaps surfaced by this investigation
  are founder decisions, not code:
  (1) nothing ages a freshness **report**. `staleSince()` trusts whatever report
  is in the store however old it is, and `store.ts` drops a repeat by
  `generatedAt`, so a frozen cheerful report stays authoritative indefinitely.
  Contracts define no budget for report age, and inventing one is a threshold
  decision.
  (2) `snapshot.sources[].lastObservedAt` is parsed (`parse-snapshot.ts`) and
  carried on `stream-freshness`, then discarded: `store.ts` drops
  `message.sources`, `applySnapshot` ignores `snapshot.sources`, and `StoreState`
  has no `sources` field. The per-source "last seen" the wire already delivers
  reaches no surface, and giving it one needs both a threshold (VIIRS overpass
  cadence) and copy.*
  *2026-09-25 — gap (2) plumbed: `snapshot.sources[].lastObservedAt` and the stream `freshness` frame's rows reach `StoreState.sources` (newer-wins per source, so a CDN-cached snapshot cannot pull recency backwards; `null` never overwrites; an omitted source is kept; a no-op message stays a no-op). `core/store/source-staleness.ts` adds pure `staleSources()` over server time with `SOURCE_STALENESS_THRESHOLDS_MS` all `null` (unarmed); nothing renders it. Arming = one threshold + copy, both founder decisions (VIIRS threshold first; chip row vs banner slot). Gap (1), the report-age budget, unchanged.*
- [x] **F5 — i18n `bg`/`en` typed messages.** Spec: ADR-005; A12. Needs: F1.
  Incl. place-name localization scope. **Done when:** CI-10/CI-11 lint runs over
  message catalogs.
  *2026-09-22 — audited: the catalogs are done, the gate is half-built. Both
  `core/i18n/bg.ts` and `en.ts` implement one `Messages` type, the locale is
  resolved in `core/i18n/locale.ts`, and place-name scope is decided in
  `ui/logic/place.ts` with tests. CI-11 is effectively covered by
  `glossary-sync.test.ts` (see F4). **CI-10 is not:** the never-send lint lives
  in `server/src/core/alerts/never-send.ts`, and `web` may not import `server`
  (CI-9 forbids it), so the banned-vocabulary and quote-only rules run over
  alert text only — while GATES CI-10 says "Rendered alert/**UI** templates".
  The fix was a move, not a rewrite.*

  *2026-09-22 — ticked; both gates now run over the catalogs, and the CI-10 half
  found real defects on its first run. The lint moved to
  `packages/contracts/src/never-send.ts` byte-identical apart from a header
  paragraph (it was pure and importless, so nothing else had to change), is
  re-exported from the package barrel, and `server/src/app/alert-wiring.ts` —
  its one real importer — now takes it from `@fire-watch/contracts`. No
  compatibility shim: nothing is published, so there is one home and one import
  path. Two dependency-cruiser rules were **tightened**, not loosened, to
  re-assert what the module lost by leaving `server/src/core`: a new
  `contracts-is-platform-neutral` (node builtins banned outside the deliberate
  `node.ts` subpath) and `no-dev-deps-in-shipped-code`, whose glob was
  `^(server|web|packages)/src/` and so matched `packages/src/` — a path that does
  not exist, meaning no package source was ever under it.

  The gate itself is `web/src/core/i18n/never-send-catalog.test.ts` over
  `catalog-render.ts`. Coverage is a guarantee rather than a habit: the walker
  **throws** on a template function whose arguments are not registered and on a
  leaf shape it cannot render, so a message added tomorrow is either linted or a
  red build; a further test asserts the walk reached every top-level key, and
  another that both catalogs render to the same set of paths, so copy present in
  `bg` and missing from `en` fails. All 84 paths, both languages, branch-y
  messages once per branch. `FROZEN_HONEST_COPY` needed **zero** additions.

  CI-11 is satisfied as GATES defines it — `glossary-sync.test.ts` freezes the
  §3 ladder (6 `lifecycle.*` + 7 `status.*`) plus §2/§3b/§5.2 copy. The other 63
  paths (`nav.*`, `settings.*`, `mapControls.*`, …) carry no frozen-wording
  assertion because they appear in no glossary section; that is unfrozen copy,
  not an unenforced gate.

  **The gate's output is 14 findings, all `own-voice-extinguished`, all real —
  no lint bug, no allowlist gap. They are held in `KNOWN_FINDINGS` as a defect
  register asserted by equality, so the suite fails both when new copy trips the
  rule and when one of the fourteen is resolved without the register being
  updated. Neither is a copy fix and both are founder calls — see F4 and the
  contract note below.***
- [x] **F6 — Trust surfaces.** Spec: A7. Needs: F1. About/Methodology, "How
  fresh?", 3-card onboarding + logged disclaimer, OG/share cards, education
  pack. **Done when:** share card renders with observation timestamp baked in.
  *2026-09-22 — audited: three of the five surfaces exist, the one the done-when
  names does not. Built: `ui/pages/about.tsx` (Methodology, and the
  `#data-freshness` anchor the freshness chip's "[?]" links to),
  `ui/pages/credits.tsx` over the shared credits registry, and the 3-card
  onboarding (`ui/onboarding.tsx` + `ui/logic/onboarding.ts`, whose acceptance
  the CI-7 suite seeds through storage). Missing: **the share card** — there is
  no `og:image`, no `twitter:card`, and nothing that bakes an observation
  timestamp into an image, so a shared link cannot carry the one fact that keeps
  it honest once it outlives the data. The education pack is also outstanding.
  Tick only on the done-when: a rendered card with the timestamp in it.*
  *2026-09-23 — **ticked on the done-when.** Share card built in `ui/share/`:
  `share-card.ts` decides every word and stamp (observation time baked into the
  1200×630 SVG), `share-image.ts` rasterizes it with the browser's own pipeline (no
  dependency, CI-12 entry 36 632 B of 85 KiB), `share-meta.ts`/`document-meta.ts` set
  `og:*`/`twitter:*` on the event page, `index.html` carries `og:begin`/`og:end`
  defaults. CI-7 scenario 8 clicks Share and asserts the platform sheet receives a
  1200×630 PNG. Still open, not in the done-when: the education pack; an `og:image`
  raster endpoint (edge function + resvg-wasm) and edge meta injection (08 §5.1.6) so
  crawlers see the card; copy keys `shareCard.share`/`observedAt`/`madeAt` sit in the
  new `PENDING_FOUNDER_REVIEW` register.*
- [x] **F7 — A11y pass.** Spec: A7. Needs: F1–F6. 200% reflow, 44 px targets,
  16 px floor, list view reachable without the map. **Done when:** the named
  checks are CI or a documented manual protocol.
  *2026-09-22: done on the done-when, which asks for CI **or** a documented
  manual protocol, and both halves now exist. Gate **CI-18** (`web/e2e/a11y.e2e.ts`)
  sweeps four viewport legs — 320 CSS px (WCAG 1.4.10), the 360×640 budget Android
  of review 06 §5.4, that same phone at a 200 % root font (WCAG 1.4.4), and a
  1280×800 two-column desktop — over eleven surfaces each: six route surfaces plus
  the freshness line, the location status line, the degradation banner, first-launch
  onboarding, and the no-WebGL browser CI-7 already proves the product serves. It
  asserts four named floors (`reflow`, `target-size`, `text-floor`, `clipping`) in
  one expectation with four keys rather than four assertions, because four would
  stop at the first floor that gave way and cost three runs to fix. Targets are
  checked as a box **and** as an `elementFromPoint` hit test at the centre, so a
  control that is large but covered still fails; the only exemptions are
  `[aria-modal="true"]` and `.side-panel.open`. The list-without-the-map check is
  CI-7 plus CI-18's keyboard leg, which reaches the first list row by Tab alone.
  The three legs a headless browser cannot assert honestly are a written protocol
  in `docs/GATES.md` §1.2 — M-1 Android OS font scale (Chrome exposes no
  OS-font-scale emulation, and faking it would be a green check standing in for an
  untested claim), M-2 assistive technology, M-3 full keyboard order.*
  *Falsified before being believed: with `TARGET_FLOOR_PX` temporarily at 400 all
  four legs went red with 69 findings on the wide leg and **zero** `maplibre`
  entries — which is what proves the sweep reads the app's own chrome and not the
  map canvas.*
  *The one structural code change was `.shell { min-height: 100vh }` in
  `web/src/styles.css`, and it turned CI-7 red: a taller pane makes MapLibre's
  resize tracking fire `moveend`, which publishes the default camera's frame, which
  scopes the list, which drops the two cross-border fixtures. Fixed by clamping the
  growth rule to the narrow layout. **That regression exposed a real coupling, now
  registered in `docs/GATES.md` rather than patched: CI-7 derives its expected rows
  from the age window alone while the product scopes the list to the map's frame
  once one exists.** Teaching CI-7 viewport scoping, or declaring it valid only
  while the map publishes no frame, is a founder call on CI-7's model.*
  *Why the open F6 dependency defers none of these floors: F6's remaining pieces are
  `og:image`/`twitter:card` metadata, which no reader can focus or tap, and the
  education pack, which is a document route. The route list is now data
  (`web/src/ui/logic/routes.ts`), and `app.tsx`, `logic/layout.ts` and CI-18 all
  resolve it through a `Record<RouteId, …>`, so that route cannot reach the build
  without naming its component, its map/panel surface **and** the selector CI-18
  waits for. The gate therefore already covers the surface F6 has not written —
  verified by adding a throwaway `education` row, which failed the typecheck in
  exactly those three places. Two findings stay open: `web/src/ui/status/status.css`
  hardcodes light-only hex while the shell is tokenised, and a skip-to-list link
  would need new bg+en copy, which the frozen GLOSSARY makes a founder decision.*
- [ ] **F8 — Budgets + Lighthouse + fire-owns-red.** Spec: IP WP4 DoD. Needs:
  F1–F7. CI-12 real budgets, map-ready ≤6 s 4G / ≤15 s 3G, CI-14. **Done when:**
  all three green in CI.
  *2026-09-25 — timing half built: `pnpm run test:timing` (vitest project `timing`, `web/e2e/map-ready.timing.ts`) measures `fw:map-ready` (first MapLibre idle after a non-empty snapshot reached the fire source; `map-controller.ts`) under CDP throttling — DevTools Fast 4G / Fast 3G, 412×823 @1.75 DPR, CPU throttle calibrated per run to 4× an idle fast host — median of 5 runs vs 6 s / 15 s; all numbers are data in `web/e2e/timing/map-ready-budget.ts`; basemap is a local stand-in (24 KiB raster tiles) until G1. The gate found two product defects, both fixed: (1) the production build never shipped MapLibre's worker (404 → map never ready) — fixed with `?worker&url` + `setWorkerUrl` on the lazy map chunk, and CI-12 now charges emitted workers to the chunk that names them; (2) `fire-dot` / `selected-ring` nested a zoom interpolate inside `*`, which MapLibre rejects, so fire dots never drew — restructured with the zoom interpolate top-level (same radius at every zoom), guarded by `web/src/map/layer-registry.style-spec.test.ts` (style-spec validator over every registry layer). `fw:map-ready` now coincides with painted dots (screenshot check). Timing: Fast 4G median 3129 ms / 6000, Fast 3G median 11698 ms / 15000, both pass (load ≈ 6). CI-12 bytes now over: map 363.46 KiB / 290, critical path 403.81 KiB / 350 (the worker carries a second copy of MapLibre's shared module), recorded in `KNOWN_OVER_BUDGET` pending a founder decision. Not ticked: the byte overage decision, `test:timing` not yet a CI step, stand-in basemap until G1.*
  *2026-09-25 (wave C) — the timing gate proves the paint: with the opt-in `__fireWatchE2eMapReadyProbe`, `fw:map-ready` carries a probe (`web/src/map/map-ready-probe.ts`, same-frame `queryRenderedFeatures` on `fire-dot`) and `map-ready.timing.ts` fails any run where an in-view event was not rendered. Mutation check: a `fire-dot` filter matching nothing turns both budgets red ("rendered 0 of 6 in-view events"); reverted. Passes at load ≈ 9; fails at load ≈ 150 (calibration does not cover a saturated host). Still unticked: byte overage decision, `test:timing` not a CI step, stand-in basemap until G1.*

## Track G — WP5 self-hosted tiles & style (Dec 2026–Feb 2027; off the beta path per A5)

- [ ] **G1 — Protomaps build → exploded z/x/y tree on R2.** Spec: ADR-001 A1.1.
  Max z14 Europe/Balkans. **Done when:** app renders from R2 tiles only.
- [ ] **G2 — Glyphs incl. Greek + Latin-Extended.** Spec: ADR-001 A1.1 as amended
  by A17. **Done when:** border-area Greek labels render (no tofu) in a visual
  check.
- [ ] **G3 — Custom outdoor style light/dark + Terrarium hillshade.** Spec:
  ADR-001. Needs: G1.
  *2026-09-24 — G1–G3 tooling built, uncommitted, none ticked. `infra/tiles/`: pure tile
  plan (bbox/zoom → tile list and count, R2 key layout; Europe z0–8 + Balkans z0–14 ≈ 532k
  tiles), a PMTiles v3 reader and explode step, glyph plan (A17 floor + Greek 0370–03FF,
  Latin Extended-A/B) with a byte-level no-tofu verifier, `cli.ts`, `build.sh` (dry run
  unless `--apply`), README with the S1 border visual check; 31 tests. Web:
  `map/outdoor-palette.ts`, `map/outdoor-style.ts` (Protomaps v4 layers, `name:bg` →
  `name`, Noto Sans, Terrarium hillshade only when `demTilesUrl` is set);
  `resolveBasemapStyle` falls back to the current basemap when `outdoorBasemap` is unset, so
  nothing changes today; CI-14 now walks both outdoor styles. Needs: G1 a real extract +
  upload (bucket, host, key); G2 the Noto TTFs, `build_pbf_glyphs`, the visual check; G3 a
  DEM mirror, the config URLs, and `credits.ts` keyed on the active style (it still credits
  OpenFreeMap). Open: fonts, tile host, tier bboxes/zooms, palette, label fields,
  Protomaps/OSM/DEM attribution wording.*
- [x] **G4 — EFFIS overlay proxy productionized.** Spec: ADR-001 A1.2 + A17
  content sanity. Needs: C4. **Done when:** a 200-with-error-image fixture does
  not poison the cache.

  *2026-09-23 — done-when met. `core/effis/content-sanity.ts` classifies with ten named
  rules (HTTP status, content type, error document body, PNG signature/structure/CRC,
  IHDR size vs the requested WMS size, fully transparent, uniform, near-blank — the last
  unarmed); reject and suspect never move `current`. `adapters/http/effis-overlay-route.ts`
  serves `/overlays/effis/:file` with Last-Modified = `available_at`, `max-age=600`, no
  ETag/304, and a sha256 check against the sidecar; registered in the API only when a
  state dir exists. `effis-overlay-route.test.ts` pushes 200+XML, 200+HTML, wrong-size and
  blank PNG fixtures through the real client, classifier, stores and route and the last
  good copy survives byte-identical. Open: `EXCEPTIONS=XML` config bump (an in-image error
  drawn at the requested size is undetectable), near-blank calibration, `stale-if-error`,
  the reject metric.*
  *2026-09-26 (wave F) — `effis-refresh.test.ts` timed out (10 s) at load avg 130–200:
  not a clock issue (it already runs on `VirtualClock`) but `toEqual` over 386 KB
  `Uint8Array` rasters, ~1.5 s per comparison at load; the blank-image test did two.
  Payload assertions now use a byte-exact loop helper (`expectSameBytes`); 3.6 s → 60 ms.*
- [ ] **G5 — `credits.ts` + CI-13.** Spec: ADR-001 A1.4; A18 attribution table.
  **Done when:** removing a credit line fails CI.
  *2026-09-23 — CI-13 landed, deliberately unticked. The done-when is met for every
  surface that exists: dropping a credit from `/credits`, About, the map corner or the
  snapshot's `attribution` member fails `pnpm run test` naming the surface, context and
  credit id (see CI-13 in GATES.md for what is and is not enforced). It is not ticked
  because the gate's register is not empty and every entry is a founder decision, not a
  code fix — the credit wording is a licence condition and the corner line is frozen
  copy: (1) the corner line merges the Copernicus Sentinel and Service credits into one
  sentence, which drops the `copernicus-service` wording; (2) the corner carries no
  link to the OSM copyright page the `osm` credit names; (3) on the OpenFreeMap basemap
  the registry owes "OpenFreeMap © OpenMapTiles Data from OpenStreetMap" (only
  "OpenFreeMap" optional) and the corner says "© OpenStreetMap contributors |
  © OpenMapTiles" — either the corner or the registry's form must change, or the
  external style's own attribution must be accepted as discharging it;
  (4) no alert footer exists until H6 supplies a renderer, so `lance-tactical-disclaimer`
  and `lance-as-is` are unmet there (D7's footer lint checks a disclaimer marker, not
  these strings). Also for the founder, outside the register: the corner's
  "Terrain: Tilezen/Mapzen" does not contain the registry's `terrarium-short`
  ("Terrain: Mapzen/Tilezen & sources"), which goes red the day the terrain layer
  (G3) becomes reachable.*
  *2026-09-25 — credits keyed on the drawn style: `web/src/core/basemap.ts` `activeBasemap` is the single basemap decision for both `resolveBasemapStyle` and `activeCreditConditions` (outdoor → `basemap:protomaps`, DEM → `layer:terrain`, imagery → `toggle:esri`). CI-13 web walks all 12 basemap × terrain × imagery combinations and checks credits against what the controller drew; server checks all 16 style subsets (register empty). New recorded finding `map-corner outdoor+terrain/* terrarium-short text`. No code gap left; the tick waits on founder copy decisions only (copernicus-service, OSM link, OpenFreeMap form, terrarium-short; corner credits undrawn OpenMapTiles/terrain on the outdoor style; optional Protomaps credit).*
- [ ] **G6 — ArcGIS imagery toggle + metering + degrade.** Spec: ADR-001 A1.3 +
  A17. Needs: E4. **Done when:** simulated quota exhaustion hides the toggle via
  client-config.
  *2026-09-24 — built, uncommitted, not ticked. Client-config gained an optional `imagery`
  block (`tile_url_template`, `api_key`; old clients stay valid, the route rebuilds it field
  by field). Server: pure meter `core/imagery/imagery-meter.ts` + fs store under
  `$FIRE_WATCH_STATE_DIR/imagery/` (`kill-switch`, `override-YYYY-MM`, write-once
  `tripped-YYYY-MM`, `usage.json`), re-checked every 30 s in `health-wiring.ts`; env
  `FIRE_WATCH_ARCGIS_API_KEY`, `FIRE_WATCH_ARCGIS_IMAGERY_TILE_URL`,
  `FIRE_WATCH_ARCGIS_TILE_CEILING`. It trips at the ceiling and latches for the rest of the
  UTC-month period; a usage dip never re-enables it, only the next period's reading or an
  override does; it fails closed on no key, no ceiling, no current reading, a store error or
  the kill switch. Web: `core/imagery/*` refetches client-config on start, wake and
  reconnect; `map/imagery-layer.ts` (one raster layer under the lowest fire layer, Esri text
  from the credits registry); `ui/imagery-toggle.tsx`. The done-when (a simulated exhaustion
  via `usage.json` hides the toggle) is proven by unit, route, wiring and web tests, not in
  a fleet. Cannot turn on anywhere yet: the `mapControls.imagery` catalog key is missing (the
  toggle has no label and does not render), the ceiling is a founder decision (unarmed), and
  nothing writes `usage.json`. Also open: the tile endpoint URL, the period anchor, a staleness
  bound, paging a trip via J1, the Esri attribution mechanism, label placement, and moving
  the three env vars into `loadConfig`. CI-13's `toggle:esri` is now reachable, so
  `activeCreditConditions` needs updating.*
  *2026-09-24 (later) — follow-ups done: catalog key `mapControls.imagery` (pending founder
  review) labels the toggle; `activeCreditConditions` adds `toggle:esri` while imagery is on,
  and CI-13 checks the Esri credit on the map corner in each locale; the three ARCGIS env
  vars moved into `loadConfig`/`describeConfig` (key shown only as configured / not
  configured) and are listed in the README env table. Still blocks the tick: nothing writes
  `usage.json`, no tile endpoint or key, plus the founder decisions above.*

## Track H — WP6 alert stack (Jan–Feb 2027 engine; Mar–Apr 2027 channels + live shadow)

- [x] **H1 — Outbox + provenance + priority.** Spec: ADR-004 D1 as amended by
  A16. Needs: B4, D9.
  *2026-09-09: migration 003 lands the three A1.1 columns that 001 never carried —
  `trigger_type` (four values), `actor_id`, `budget_override` — plus a CHECK that an
  automatic row's trigger equals its `alert_type`, only `manual` being allowed to
  differ. `trigger_type` is a second column and not a widened `alert_type` because
  `alert_type` is the third field of the A1.11 unique key: folding `manual` into it
  would make an operator-continued escalation a different alert from the one it
  continues. A1.1's refusal rule is deliberately **not** a CHECK — a manual row is
  written `awaiting_approval` precisely so a second human can fill `approver_id` in
  later, and a CHECK would reject it at creation and leave nothing to approve; it lives
  in `isDeliverable()` instead. Port `core/ports/alert-outbox-store.ts`, pure builders
  `core/alerts/outbox.ts` (`outboxRowFor`, `digestOutboxRows`, `manualOutboxRow`,
  `isDeliverable`), adapter `adapters/db/pg-alert-outbox-store.ts` (one `unnest`
  statement, twenty parameters whatever the batch size, `ON CONFLICT … DO NOTHING` on
  the A1.11 key). The one-row-one-channel limit the key implies is written down in the
  port rather than resolved silently — it is H2's question. **Done when:** a redelivered
  decision inserts nothing and is reported as `alreadyDecided`; asserted in the unit
  suite and, against a real Postgres, in `pg-alert-outbox-store.integration.test.ts`
  (which also proves the runtime role may UPDATE but never DELETE).*
- [x] **H2 — Notification gateway (sole sender) + lint.** Spec: ADR-004 D2.
  Needs: H1.
  *2026-09-09: the `only-the-gateway-sends` rule was unsatisfiable as written — it
  exempted the whole of `app/`, so the very thing the "Done when" describes would have
  passed. The exemption is now one path, `server/src/app/alert-wiring.ts`: wiring a
  provider into the gateway is legitimate and wiring is all that is.
  `gateway/boundary.test.ts` seeds a direct send under `app/`, cruises that one file and
  asserts the failure names the rule — the gate is proven by a test, not by inspection.
  The gateway itself (`adapters/alerts/gateway/notification-gateway.ts`) decides nothing:
  it sequences claim → A1.9 liveness re-check → `dispatchVerdict` → render → never-send
  lint → channel → settle, and every branch is a pure function or a port. Ports added:
  `alert-channel`, `alert-dispatch-queue` (the read half is separate from H1's write-only
  store — claiming is a state transition, so no "list pending" exists),
  `recipient-resolver` (A1.9's re-check and the endpoint read are deliberately one
  lookup) and `alert-renderer` (the outbox stores `template_id` + params and never prose,
  because A1.3 must be able to drop the zone-derived parameters). D6's numbers live in
  the versioned `core/config/delivery-params.ts` so a replayed September expires what
  September expired. D7 is the never-send module (written as `core/alerts/never-send.ts`;
  moved to `packages/contracts/src/never-send.ts` on 2026-09-22 so the web catalogs could
  be linted by the same list): 9 never-send rules + 3 footer
  obligations, Bulgarian and English, CI-10 §5.5 exemptions, and whole-string
  allowlisting for the product's own honest copy — a per-word allowlist is how a policy
  dies. `dispatched_at` is stamped **before** the provider call, being the number the p95
  SLO is measured against. A missing adapter releases rather than fails: it is a deploy
  mistake, the row is still deliverable, and D6's 600 s queue-age alarm is the escalation.
  **Done when:** a seeded direct-send in app code fails CI — `boundary.test.ts`, 2 tests.*
- [x] **H3 — Per-(zone,event) state machine + zone-creation seeding.** Spec:
  ADR-004 D3 as amended by A16 (14 H4). Needs: H1.
  *2026-09-10: the ladder D3 describes now has a table behind it. Port
  `core/ports/alert-state-store.ts` splits the read half (`loadStates`,
  `loadStatesForEvents`, `lastNotifiedByZone`) from the write half, so a merge can read
  every zone following an event without being able to write one. The adapter
  `adapters/db/pg-alert-state-store.ts` is five `unnest` statements and opens no
  transaction of its own — D1 requires the state change and the outbox row to be atomic,
  which only holds if the caller can hand both stores the same client after a `BEGIN`.
  The upsert writes whole rows rather than merging, because a replayed decision must
  reproduce the row it describes including the columns it *cleared*; an unknown
  `public_id` fails the statement whole through a `LEFT JOIN` into a `NOT NULL` column
  instead of silently dropping one pair. A1.8's seeding is a pure plan,
  `core/registry/zone-seed-plan.ts`: every candidate runs through the real `decideAlert`
  with `zoneCreation: true` so the seed cannot drift from the gate, and any outcome that
  is not `seed` or `suppress` throws rather than being written. The cross-event
  suppression instant is `max(last_notified_at)`, so a seeded pair — which sent nothing —
  is simply absent from the map rather than opening a window it never earned. **Done
  when:** S13 is green end-to-end through the `alert` replay engine (zero pushes at zone
  creation; the seeded fires returning only in the next 09:00 digest), and the database
  half is asserted against a real Postgres in `pg-alert-state-store.integration.test.ts`
  — including that `alert_states` cascades with its zone, which is the only thing making
  "a zone deleted and re-created re-seeds from scratch" true, and that the runtime role
  may DELETE here, which it may not in the outbox. That integration file is unexecuted on
  this machine (no Docker daemon); CI runs it under `FIRE_WATCH_REQUIRE_DOCKER=1`, which
  turns the skip into a failure.*

  *2026-09-23 — live evaluation loop implemented: `core/alerts/evaluation-cycle.ts` over
  the shared per-account decision `core/alerts/account-decision.ts` (the replay engine now
  calls it too; CI-1/CI-2 replay output byte-identical to the pre-refactor baseline under
  two TZ/locale pairs), `core/alerts/zone-match.ts`, migration 009 (cursor + evaluated
  events), `pg-alert-evaluation-store.ts` (one transaction per batch, FOR SHARE fence on
  `clustering_runs`), and `pg-zone-seed-candidate-reader.ts`. Wired in the worker but
  disabled at runtime by three blockers: zone keyring unset, routing unarmed (H2/D7),
  cadence unratified. Gaps: `fire_events.score` is never written live so every event is
  below threshold; digest pass unwired; the seed reader is not yet passed to
  `pg-zone-creation`. Integration test unexecuted (no Docker).*

  *2026-09-26 (wave G) — digest pass, core half. `core/alerts/digest-pass.ts` collects the
  `defer`/`seed` debts per account through the pure `produceDigest` (send / hold for quiet
  hours / suppress over a quiet map), one transaction per account, with ports
  `core/ports/alert-digest-routing.ts` and `alert-digest-store.ts`. Migration **018**
  `alert_digest_log` is both the decision record and the watermark (last spent window =
  newest `send`/`suppress` over the account's zones, written in the same transaction as the
  outbox rows; `UNIQUE (zone, window, outcome)` means a conflicting `send` writes no outbox
  row). Personal, zone-keyed, cascade-erased: registered in the erasure plan
  (`erasure_plan_v5`), account export, erasure drill seed and schema test; deliberately
  **not** a purge target yet — a naive cutoff would reset the watermark and re-owe a window,
  so its retention is an open founder item. Still **not** wired: no Postgres adapter for
  the store, not in the worker, so `digest_pass_unwired` stays in `ALERT_EVALUATION_GAPS`.
  `docs/legal/ropa.md` and `breach-runbook.md` omit both 014 and 018 (legal docs, left for
  the founder).*
  *2026-09-26 (wave G, continued) — the live digest pass is built and wired, disabled like
  the evaluation loop. Migration **018** `alert_digest_log` and `core/alerts/digest-pass.ts`
  (`runAlertDigestCycle`, one transaction per account, watermark derived from the log) had
  landed without a test, an adapter or a caller. Added: `digest-pass.test.ts` (25 tests:
  send/hold/suppress/none, the held window re-sent under its own subkey, undeliverable and
  copy-less groups spending nothing, the lost-race guard, A1.12's nearest-zone fold, A1.8's
  seed-after-window rule, per-account rollback, id-free report; six mutations of the core
  each fail a test); `adapters/db/pg-alert-digest-store.ts` (account `FOR SHARE` against
  erasure, watermark = newest spent window over all zones incl. soft-deleted, dated by its
  **earliest** `decided_at`; digestible pairs = state ≠ `none`, not merged, not superseded,
  not invalidated, `active`/`signal_weakening`; newest evaluation `defer` from 014) with a
  unit suite and an integration suite run **as `fire_watch_app`** against PostGIS 16-3.4 —
  7/7 green here, and four SQL mutations (min→max, invalidated kept, no `FOR SHARE`,
  deleted zones dropped from the watermark) each fail it; `app/alert-digest-wiring.ts` +
  reporter + `observeAlertDigest` (loop metrics + the A1.12 deferral counter). The worker
  reports `alert_digest_disabled` with `zone_keyring_unset`, `digest_routing_unarmed`,
  `cadence_unratified` (`ALERT_DIGEST_CADENCE` is null: tick interval and account page size
  are founder numbers). The evaluation gap is now `digest_pass_disabled`, reported only
  while the digest loop is not running beside it. **Known limit:** decision-log rows stay on
  the event they were taken on, so after a merge/reignition fold the survivor's pair is
  owed as `active` rather than `deferred` — still listed, only the kind label is lost, and
  the replay loses it the same way (its debts do not follow a fold). Still open: digest routing/template (H2/D7), the cadence, and the 018
  retention (the watermark-keeping purge landed in 019, see I4).*
- [ ] **H4 — Gating config + budgets + breaker + kill switch.** Spec: ADR-004
  D4/D5 as amended by A16. Needs: H1, D9. B=500/T-approve, G=2,000/10 min,
  ingest-side breaker leg, deterministic cutoff + deferred metric. **Done
  when:** budget/breaker fixtures green; kill switch rehearsed in staging.
  *2026-09-10, not ticked — the code is written, the acceptance is not met. Landed:
  `core/config/alert-budgets.ts` (B, G, the G window, the breaker's ratio, A1.4's
  self-approval caps and A1.12's paging deadline, with `clampToShipped` folding a
  caller's parameters towards the stricter of theirs and git's, field by field — which is
  what makes "no runtime knob can raise them" structural rather than documentary);
  `core/alerts/budget-cutoff.ts` (A1.12's deterministic cut, ranked by
  `(priority, decided_at, id)` with the id compared numerically for bigints and
  lexicographically for uuids, continuing an event's `budget_seq` across decision
  transactions rather than restarting it); `core/alerts/dispatch-breaker.ts` (kill switch,
  G, and the anomaly breaker as one verdict over claiming, with the halt order fixed:
  kill switch, then the latch, then an unmeasurable rate, then G, then the breaker);
  `core/observability/alert-metrics.ts` (A1.12's three series and its two pages, as
  declarations and arithmetic, with no registry client in `core`). The ingest-side leg
  was already `core/ingest/anomaly-breaker.ts`. **Two things block the tick, and neither
  is code.** (1) No document in this repo gives the breaker's absolute floor a value — D5
  writes `max(5x seasonal baseline, floor)`, A1.5 says "an absolute floor" and 05 §5.2.3
  says the same — so `breaker.floorSendsPerWindow` ships `null`, `dispatchAllowance`
  reports the breaker `unarmed`, and G is the only enforced ceiling on a runaway. With no
  floor the ratio leg alone would halt dispatch at the first real fire of a quiet spring
  (five times a baseline of two is ten), which is the exact failure the floor exists to
  prevent. Pinning it is a founder/security call under 05 A2 and a version bump of
  `alert_budgets_v1`. (2) "Budget/breaker fixtures green" has no scenario in the GATES
  §1.1 register to be green, and "kill switch rehearsed in staging" has no staging host.
  Also unconsumed: `selfApprovalCaps` (A1.4's "one per event, <= 2 per rolling 24 h") is
  declared but enforced nowhere — the count is not decidable from a single row, so it
  belongs to the approval surface, which is not built.*
  *2026-09-23 — dispatch loop built and wired (`app/dispatch-wiring.ts`, 10 s,
  batch 100, own pool; SKIP LOCKED claim, abandoned/orphaned-claim recovery; kill
  switch in `FIRE_WATCH_STATE_DIR`). Off by default: `FIRE_WATCH_ALERT_DISPATCH_ENABLED`
  must be `true`, and it must stay off — `REVIEWED_TEMPLATES` is empty (H6), so
  rendering fails closed. Breaker floor/baseline null (unarmed); G counts dispatched
  rows only; no `claimed_at` lease column yet.*
  *2026-09-25 — claim lease: migration **015** adds `alert_outbox.claimed_at` (CHECK: a claimed row has one; partial index). The start-up "release every claimed row" step is gone; each dispatch cycle first returns claims older than `CLAIM_LEASE_MS` (120 s) to `pending` (`releaseExpiredClaims`, report `expiredLeases`) — safe with several dispatchers. No send starts with less than `CLAIM_SEND_WINDOW_MS` (30 s) of lease left (`claim_lease_exhausted`); a unit test fails if the slowest provider timeout + rate-limit wait exceeds the window. Every settle is fenced on `claimed_at`, so a dispatcher that outlived its lease cannot overwrite the newer claim. Integration tests written, unrun; migration 015 never run on Postgres.*
- [ ] **H5 — Channel adapters + token buckets.** Spec: ADR-004 D6. Needs: H2.
  Web push (TTL 1800 s), Telegram 25/s, email 12/s; queue expiry 6 h;
  dispatch-time liveness re-check (14 M3). **Done when:** physical-device push
  test done (L-5).
  *2026-09-18, not ticked — the code is written, the acceptance is not met. Landed under
  `adapters/alerts/channels/`: `token-bucket.ts` (D6's per-channel pacing) and
  `rate-limited-channel.ts` (the decorator that waits for a token, at most 2 s — the
  gateway is sequential, so a longer wait would stall every other channel — and reports
  `transient` past that); `channel-rates.ts` (push 300/s, Telegram 25/s, email 12/s);
  `provider-http.ts` (one timed, redirect-refusing, secret-redacting request helper the
  three adapters share); `web-push/` (RFC 8292 VAPID and RFC 8291 `aes128gcm` in
  `node:crypto`, the Appendix A vector byte for byte, 404/410 → `reprompt`, 401/403 →
  transient because the failure is ours, 429 pauses the push-service host); `telegram/`
  (Bot API `sendMessage`, 403 and "chat not found" → `prune`, `migrate_to_chat_id` →
  `prune`, `retry_after` pauses the whole channel); `email/` (SES v2 `SendEmail` with a
  hand-rolled SigV4 that passes the AWS documentation vectors; throttles and quota
  errors pause the channel, credential errors stay transient, never `prune`). Config
  reads each provider as a group or not at all (`FIRE_WATCH_VAPID_*`,
  `FIRE_WATCH_TELEGRAM_BOT_TOKEN`, `FIRE_WATCH_SES_*`), naming missing variables and
  never values; `app/alert-wiring.ts` `createLiveChannels` builds each configured
  adapter behind its bucket and turns a shape error into a `ConfigError` that names the
  variable group. Queue expiry and the liveness re-check were already H2. **Not done, by
  design or by circumstance:** the physical-device push test (L-5) needs a VAPID pair
  and a device this machine has neither of; nothing dispatches through the live
  channels yet — the worker's dispatch loop is not built, and `createLiveChannels` has
  one consumer, its test; SES bounces and complaints arrive asynchronously over SNS, so
  the email adapter never returns `prune` and a bounce handler is its own task;
  Telegram's per-chat 1 msg/s is not enforced (one alert per chat per event makes it
  moot until digests exist); the service-worker-side localisation 08 §5.4.3 mentions
  needs a template key on the outbound message, which is H6's call.*
  *2026-09-23 — channels are driven by the live dispatch loop (see H4). Gaps: no
  locale column (everyone gets `bg`), no double-opt-in/reprompt columns (I3), a
  row/subscription channel mismatch is unchecked.*
  *2026-09-25 — channel agreement + locale: migration **015** adds `alert_outbox.locale` (NOT NULL DEFAULT 'bg', CHECK bg/en), threaded row → renderer → `OutboundMessage.locale`; dispatch stays fail-closed while `REVIEWED_TEMPLATES` is empty. The recipient resolver returns the subscription's channel; a row whose channel differs closes `failed` / `channel_mismatch: …`, never sent, counted as `channelMismatches`. Erasure plan **v4** keeps `claimed_at` and `locale` through pseudonymization; the account export includes both. Open: where the locale comes from (no account/subscription language yet), a dedicated mismatch status, SES `Content-Language`.*
  *2026-09-25 (wave C) — the SES channel sends `Content-Language: <OutboundMessage.locale>` via SES v2 `Content.Simple.Headers`, with tests. Locale source still open.*
- [x] **H6 — Templates + CI-10/CI-11 wording lints.** Spec: A12 contract. Needs:
  A12, F5. Product-authored lint fixtures (good-must-pass / bad-must-fail); DST
  fixture S14. **Done when:** lints green with the fixture corpus; S14 green.
  *2026-09-24 — done-when met, uncommitted. `core/alerts/templates/`: EN/BG copy catalogue
  (frozen entries verbatim from GLOSSARY, own-voice entries in a pending register, LANCE
  clauses taken from `CREDITS`), pure `renderAlertTemplate` for `new_fire.v1`,
  `escalation.v1`, `digest.v1` over push (480 chars) / Telegram (3000) / email in bg and
  en, a good-must-pass / bad-must-fail lint corpus with pinned rule ids; CI-10 over the full
  rendered matrix; CI-11 `glossary-sync.test.ts` against `docs/GLOSSARY.md`; S14 renders
  every send across 25 Oct 2026 and 28 Mar 2027 in Europe/Sofia. The gateway registers only
  templates whose copy is reviewed — none today — so nothing is armed until the 25 own-voice
  keys are approved. `alert-footer` attribution findings closed. Open: `alert-wiring.ts`
  does not use `lintContextFor` yet; BG footer carries LANCE in English; brand in the push
  title; locale default; the ambiguous 03:30 on 25 Oct; GLOSSARY §3b EN/BG mismatch; wind
  copy + ECMWF licence; BG-ALERT pointer; deep-link base URL; template parameter privacy
  for the erasure plan; `placeName` source; "3 200" vs "3200".*
  *2026-09-25 — follow-up: `app/alert-wiring.ts` builds its never-send lint context with `lintContextFor(templateId, templateParams)`.*
- [ ] **H7 — Explainability surfaces.** Spec: 07 §5.5; IP WP6. Needs: H3.
  "Why this alert?" / "Why no alert?".
  *2026-09-23 — core only, uncommitted: `core/alerts/explain.ts`
  (`explainDecision`, `explainPersisted`, 16 codes in `EXPLANATION_BRANCHES`, 41
  tests). No route: 07 §5.5.6 gives no shape, and "Why no alert?" is IP descope item 6
  yet specified in 07 — founder call. Defer/suppress reasons are not persisted (needs a
  decision-log migration); `alert_states` has no `rule_version`; outside-radius,
  delivery-failed and source-outage are not produced by `decideAlert`.*
  *2026-09-25 — decision log built, still unticked: migration **014** `alert_decision_log` (append-only for `fire_watch_app`, zone ON DELETE CASCADE, backup class personal, unique per zone/event/trigger seq/pass, code + reason + `rule_version`, no score or copy), written in the evaluation loop's D1 transaction; `explainPersisted` rebuilds all 13 defer/suppress branches from it. Erasure plan v3, account export and an unarmed purge (`purge_alert_decision_log`) cover it. Not yet: HTTP route (founder), seed-pass logging, retention, migration 014 on Postgres.*
  *2026-09-25 — seed-pass logging done: `createWatchZone` writes one `alert_decision_log` row per seed candidate (seed/suppress, reason, rule version, `fire_event_id`, seq, `pass='zone_creation'`) in the zone-creation transaction; nothing is logged if the upsert fails; entries carry no coordinate or distance.*
- [ ] **H8 — Shadow-diff machinery as code.** Spec: A8. Needs: H1–H4.
  `events_shadow`/`alerts_shadow`, nightly diff report, fixture-refresh policy,
  "what you would have received" beta UI hook. **Done when:** one nightly report
  generated in staging.
  *2026-09-23 — machinery built, uncommitted: migration **006**
  `events_shadow`/`alerts_shadow`, pure `core/shadow/` (event matching minJaccard 0.5,
  12 diff kinds, explanations), pg reader/store, `shadow-diff` CLI; fixture-refresh
  policy in `server/fixtures/README.md`. 113 unit tests; 11 integration tests skip
  without Docker. Done-when (a nightly report in staging) needs a host. Open:
  `decided_at` tolerance (null), UTC vs Sofia day, explanations file location, zone
  ids in reports (personal data), beta route shape/auth, who drives the candidate
  writer, the nightly schedule.*
- [ ] **H9 — Live shadow (Mar–Apr) + staged enablement.** Spec: L-1; A5 WP6
  split. Needs: H1–H8, I-track zones. ≥2 weeks, every diff explained; the 25 Oct
  2026-style DST check applies to the spring-forward night (28 Mar 2027).
  **Done when:** shadow gate signed off in GATES.

## Track I — WP7 zones, accounts, GDPR (starts earlier than Feb 2027 per A8)

- [ ] **I1 — Accounts + auth.** Spec: 05 §5.4 C1–C4 via A8. Needs: B4.
  *2026-09-23 — server side to C1–C2 (magic link) built, uncommitted: migration
  **007** (`accounts.email`, `auth_link_requests`, `account_sessions`; token hashes
  only), `core/auth/` policy + flows (15 min single-use links, 3/address/hour under an
  advisory lock, UA-family binding, explicit POST "Continue"), `__Host-fw_session`
  cookie with 30-day sliding expiry, Origin checks, routes `POST /api/v1/auth/
  {link,continue,logout}`. **Not registered in the API**: no `AuthMailer`
  implementation until the founder picks the auth-mail sender/subdomain and landing
  URL; allowed-origins env var and per-IP limits undecided. Not built: OAuth (C2),
  staff plane (C3), draft→publish audit (C4).*
  *2026-09-25 — sign-in built and wired, off by default: `adapters/mail/ses-auth-mailer.ts` (SES v2 over the email channel's transport only — sigv4 + provider-http, depcruise rule `auth-mailer-reuses-transport-only`; EU region enforced; token in the link fragment; token, link, recipient and keys redacted; errors carry status + SES error type only). Copy `core/auth/sign-in-mail-copy.ts` is bg+en, own-voice, never-send-linted, pending founder review. `app/auth-wiring.ts` registers the auth routes only when `FIRE_WATCH_AUTH_ENABLED=true`; `loadConfig` refuses the flag without the full mailer config (sender, mail domain, https landing URL, exact allowed origins, SES EU region + keys; no defaults; README rows). Tests: off → 404; incomplete config refused; an SES failure echoing the request leaves no token, link or address in the log. Not ticked: no verified SES identity/keys, account migrations never run on Postgres, copy unreviewed, no web landing reads `#token`.*
  *2026-09-25 (wave C) — `GET /api/v1/account` added (`signed_in`, `session_expires_at` only; no email or id); every account route shares the `PgSignInFlows.authenticate` guard behind `FIRE_WATCH_AUTH_ENABLED` (off → 404 for all, tested; a real `createProcessLog` sink shows no address, zone name, coordinates, tokens or account id in logs). Web: `/sign-in` form (neutral sent state, 429 + Retry-After, invalid address) and `/sign-in/continue` landing — `boot()` strips `#token` before the first await, the token is exchanged only on Continue (mail scanners prefetch links), refusal states expired/used/invalid/replaced/other-browser; signed-in indicator + sign-out in Settings; auth off = absent. Lazy page chunk 1.45 kB gz (CI-12 lazy role `page`, no budget); 27 `signIn.*` strings pending founder review; 29 unit + 8 e2e token-hygiene tests; both routes in the CI-18 table. Follow-ups: machine-readable problem `code` (web maps refusals by English title), mailer landing `/sign-in/continue#token=…`, `__Host-` cookie over local http.*
  *2026-09-26 (wave D) — wave C follow-ups closed (code only, unticked). Every problem document on the account surface (auth, account, export, zones, channels) and both problem-handler fallbacks carries a stable `code` extension member from `@fire-watch/contracts` `PROBLEM_CODES` (24 codes, one per meaning; titles unchanged); data routes (snapshot, stream, client-config, EFFIS) stay status-only apart from the fallbacks' `request_refused`/`internal_error`. `server/src/adapters/http/problem-codes.test.ts` proves the emitted set equals the union. The web (`sign-in.ts` `SIGN_IN_READING_BY_CODE`, total over `ProblemCode`) reads only `code` (title fallback dropped — no older server exists); a missing/unknown code reads as "invalid" for `continue`, "failed" otherwise. `sign-in.e2e.ts` uses the shared `web/e2e/harness/load-margin.ts` (`within()`, also used by t2-failover). README documents the landing URL as `https://<host>/sign-in/continue` (path not validated — the web moves a token from any path). Still open: `__Host-` cookie over local http, SES identity, migrations on Postgres.*
- [ ] **I2 — Watch zones.** Spec: ADR-004 D8 as amended by A16. Needs: I1.
  ~1 km coarsening ON, app-layer encryption, coarse grid index, min radius ≥2 km
  UI rule. **Done when:** stored zones verifiably coarsened + encrypted.
  *2026-09-23 — server side built, uncommitted, not ticked: ~1 km coarsening
  (`core/zones/zone-geometry.ts`), radius 2–30 km (default 10), coarse grid key,
  centre sealed with AES-256-GCM behind `ZoneCentreCipher` (key id per ciphertext,
  active + retired keys from `FIRE_WATCH_ZONE_KEY_ID`/`_KEY`/`_KEYS_RETIRED`); creation
  is one transaction wired to the A1.8 seed plan. Tests prove the stored centre is
  coarsened and ciphertext and that no plaintext coordinate reaches SQL parameters,
  responses or logs — the done-when, but only against the fake driver; the Postgres
  run is outstanding. Routes `GET/POST /api/v1/zones`, `DELETE /api/v1/zones/:id` are
  not registered (they authenticate through I1). Open: seed-candidate reader, live
  zone matcher, key re-encryption job, polygon zones, zone edit.*
  *2026-09-25 — seed reader wired by default into zone creation; SQL gets only integer index-cell ranges (±1 cell, never the envelope floats whose midpoint is the centre). Seed pass logged to `alert_decision_log` (see H7). Zone-centre key rotation: `core/zones/rotate-zone-centre-keys.ts` + `adapters/db/pg-zone-centre-rekey-store.ts` + `app/zone-key-rotation-cli.ts` (`pnpm --filter server zone-key-rotation [--batch-size] [--max-batches] [--dry-run]`): idempotent, resumable per-batch transactions, FOR UPDATE + CAS, verify-before-write, report of key ids and counts only; exit 0/1/2/3. No migration (007 columns suffice). Live matcher already exists (`zone-match.ts`). No-plaintext property tests; integration tests unrun. Zone routes still unregistered pending I1 going live.*
  *2026-09-25 (wave C) — zone routes (`GET|POST /api/v1/zones`, `DELETE /api/v1/zones/:id`) registered by `app/auth-wiring.ts` only when `FIRE_WATCH_ZONE_KEY_ID`/`FIRE_WATCH_ZONE_KEY` are set (api.ts loads the keyring, logs key ids only); without a keyring they are 404. Docker-gated `app/auth-wiring.integration.test.ts` (create → list → export, isolated between accounts) written, not run.*
- [ ] **I3 — Double opt-in + Telegram minimization.** Spec: ADR-004 D8. Needs: I1.
  *2026-09-24 — landed, uncommitted, not ticked. Migration 012:
  `channel_subscriptions.confirmed_at`, the Telegram endpoint CHECKed to a bare chat id, and
  a new `channel_confirmations` table (32-byte hashed single-use tokens, one ending per row,
  backup class `personal`). Core `core/channels/*`: a confirmation state machine and policy
  (email 48 h and 3 mails per address per day per 05 §5.5.3; Telegram and push unarmed), a
  pure `/start` parser that keeps the chat id only (private chats only), and the flows.
  Ports `TelegramBotApi`/`ChannelConfirmationMailer` have no implementation. The pg adapter
  runs each flow in one transaction (advisory lock 7012; a failed mail rolls back and costs
  no quota; the bot ack is sent after commit). The recipient resolver refuses unconfirmed
  channels, and the erasure plan is bumped to `erasure_plan_v2`. `channel-opt-in-route.ts`
  (confirm/link/webhook/unlink) is written and tested but not registered. Open: 012 never
  run on Postgres; no mailer or bot; founder decisions on bot identity, Telegram TTL/re-send
  limit, push confirmation, mail sender/landing URL, webhook vs polling and its secret, group
  chats, and retention of ended confirmations. Subscriptions from before 012 are not
  backfilled, so they stay pending (undispatchable) until confirmed.*
  *2026-09-25 (wave C) — channel routes registered **unarmed**: request email / Telegram link → 503 before any row is written; webhook 404 (no secret); confirm (token-only, no session, by design) and unlink live. `ChannelConfirmationMailer` and `TelegramBotApi` remain explicitly unwired ports.*
- [ ] **I4 — Erasure pipeline.** Spec: ADR-004 D8 + A16 (14 M3). Needs: I1, H1.
  ≤30 d incl. backups; deletion cancels pending outbox in-transaction.
  **Done when:** the erasure drill (I7) passes incl. the outbox case.

  *2026-09-23 — code complete, uncommitted, not ticked: migration 010 (erasure ledger with
  only a hashed account id, final tombstones, triggers refusing inserts under an erased
  account, pseudonymized outbox rows that can never be requeued), `core/erasure/*` (plan,
  30-day horizon incl. backup tiers, purge planner), `pg-account-erasure.ts` (one
  transaction: account → zones → outbox locks; pending and claimed rows become
  `cancelled_erasure`), `DELETE /api/v1/account` in `account-route.ts` (not registered,
  waits with the auth routes on a mailer), and a daily purge loop in the worker whose
  retentions are all unarmed. The 12-test drill including the outbox case is written but
  has not run (no Docker). Follow-ups: the dispatcher does not hold the row lock across
  the provider call, so a committed claim can still send; zone soft-delete does not
  cancel pending outbox. Open: retentions, ledger backup class, retained template params,
  grace period, separate erasure login, restore runbook.*
  *2026-09-25 (wave C) — `DELETE /api/v1/account` wired to the production `createPgAccountEraser` on its own account pool (Origin + session, 204, cookie cleared); Docker-gated integration test (tombstone, `erasure_requests` row, dead cookie) written, not run. Erasure is immediate (no grace period).*
  *2026-09-26 (wave G, continued) — `alert_digest_log` is now a purge target, unarmed like
  the rest. Migration **019** `purge_alert_digest_log(cutoff, max_rows)` (SECURITY DEFINER,
  014's guards) deletes a row only when it is past the cutoff **and** its window is older
  than its account's newest `send`/`suppress` window (soft-deleted zones included), so the
  digest watermark — window and earliest `decided_at` — reads back unchanged and yesterday's
  window is never re-owed. `PURGE_TARGETS`/`PURGE_RETENTION` gain `alert_digest_log: null`
  (floor 0: the function protects what the pass reads). Integration-tested as
  `fire_watch_app` (watermark identical before/after, holds and never-spent accounts kept,
  per-account isolation, a watermark held only by a soft-deleted zone, row cap, future
  cutoff refused, no direct DELETE); three SQL mutations each fail it. Note:
  `purge_alert_decision_log` (014) still has no integration test.*
- [ ] **I5 — Privacy pages + disclaimers.** Spec: A8; 09. Needs: I1. ЗЗП/LANCE
  layered disclaimers, Esri/AWS recipients disclosed.
  *2026-09-24 — built, uncommitted, not ticked (legal review pending). `/privacy` is in the
  route table, so CI-18 sweeps it. Layer order: draft notice, short summary, full notice
  (controller, data, legal bases, recipients incl. Cloudflare CDN/R2, OpenFreeMap, Esri,
  AWS as the planned alert-email provider, mail provider TBD; sources NASA
  LANCE/EUMETSAT/Copernicus; transfers, retention, rights), then a `#disclaimer` layer (not
  an official warning, not a replacement for 112/BG-ALERT, the LANCE disclaimer rendered
  verbatim from the credits registry). Short-layer links at first run, event footer, list,
  About and Settings alerts. All 29 new keys are in `PENDING_FOUNDER_REVIEW` under a new
  `legal-notice` posture, and the draft notice stays on the page while any is pending
  (`privacy-page.test.tsx`, 16 tests). The BG legal text is an implementer draft. Never-send
  findings unchanged at 14. Open: legal review EN+BG, controller entity, retention, mail
  provider, DPF/SCC per provider (incl. Esri), the account-creation acknowledgement (05
  §5.7.1), nav vs footer placement.*
- [ ] **I6 — Legal artifact set.** Spec: A8. Needs: I1–I5. DPIA (C-184/20
  position), RoPA, DPAs, LIA, breach runbook with КЗЛД-72h templates, self-serve
  export. **Done when:** the 09 launch checklist is green.
  *2026-09-24 — drafts + export built, uncommitted, not ticked (the checklist is not green).
  `docs/legal/`: README, DPIA (C-184/20 no-inference position, Art. 9(2)(a) fallback),
  RoPA (ten personal tables column by column, cited to migrations 001–012), DPA inventory
  D1–D10 with transfers, LIA-1…5, breach runbook with КЗЛД Art. 33 and Art. 34 templates
  (EN + BG skeletons), launch checklist mapped from 09 — all DRAFT pending legal review.
  Export: `core/account-export/` (`account_export_v1`), `pg-account-export.ts` (its table
  set is tested against the erasure plan's), `GET /api/v1/account/export` written but not
  registered (auth, mailer, rate limit); 36 unit tests, 4 integration tests skip. Open:
  controller entity and contact, DB host/region, mail provider, DPF/SCC for Esri,
  OpenFreeMap and Mozilla autopush, signed DPAs, purge periods not yet built, arming the
  retention jobs, erasure grace period, push endpoints unencrypted at rest, no zone-key
  re-seal tool, DPO, export positions E1–E6.*
  *2026-09-25 (wave C) — `GET /api/v1/account/export` registered (keyring required) with C1's Origin hook and a per-account limit of 3/hour (`ACCOUNT_EXPORT_RATE_LIMIT`, not a design number).*
- [ ] **I7 — Erasure drill in staging.** Spec: IP WP7 DoD. Needs: I4.
  *2026-09-25 — tooling built, unticked: `pnpm --filter server run erasure-drill -- --environment=<env> [--audit-backups]` seeds a synthetic `@example.invalid` account across all plan-v3 tables, erases through the production eraser as `fire_watch_app`, verifies zero rows, tombstone, ledger deadline, pseudonymized outbox, plan ⊇ `table_backup_class`, refused writes, optional `fw-personal/` expiry, and writes `docs/drills/records/<ts>-erasure-<env>.md`. Production guard by host/db/bucket markers. Tick when a staging record is committed; blocked on staging (U-10) and migrations 005–014 on Postgres.*
  *2026-09-26 (wave F) — local rehearsal, still unticked. Environment: PostGIS 16-3.4 with migrations 001–015, representative seed, real age 1.2.1, local store. `erasure-drill --audit-backups` passed 18/18 (every seed leg, the write probe, and the audit of two personal artifacts). A restore after the erasure keeps the tombstone final as `fire_watch_app` (23503/23514). Fixed in `pg-erasure-drill.ts`: the seed's `claimed` outbox row had no `claimed_at`, so it failed migration 015's `alert_outbox_claim_has_lease` and the drill could not seed at 015; and the write probe accepted any error, where it now accepts only the trigger's 23503. `server/src/app/drills.integration.test.ts` now runs the drill cores against Postgres (4 tests); see docs/drills/README.md "Local rehearsal". Still needs real staging: a staging database at 015, `DATABASE_URL`, and the R2 bucket for the audit (R2/SigV4 and lifecycle expiry are not exercised locally). Tick when a staging record is committed.*

## Track J — WP8 ops & monitoring (continuous; hardening Feb–Apr 2027)

- [ ] **J1 — Meta-alerts + canaries + queue-age paging (L-8).** Spec: A22. Needs:
  C5, H1.

  *2026-09-23 — partial, uncommitted: pure monitors in `core/monitoring/` (outbox queue
  age/depth/claimed/awaiting approval, identity lag via the `clustering_batches` cursor),
  a hysteresis evaluator (2-in-a-row page and clear), a healthchecks `meta-alerts` pager
  (success or `/fail` every cycle, so a dead loop also pages), and a `monitors` worker
  loop every 60 s. Only queue age is armed (600 s, L-8); every other threshold is unarmed.
  The canary is a pure core + port only — it needs an operator channel, and
  `alert_outbox` accepts only user channels. `/api/health/meta` not registered (it reveals
  queue depth). Hysteresis state is in memory; no migration.*
- [ ] **J2 — Backup/restore + RTO drill.** Spec: A22. Needs: C6. Simulated VM
  loss recovered within documented RTO; erasure-aware retention. **Done when:**
  drill recorded.
  *2026-09-25 — tooling built, unticked: `pnpm --filter server run restore-drill -- --environment=<env> --manual-step=<id>:<min> … [--main-only | --restore-only]` takes a real backup (no ping, no ledger), restores into a scratch database, verifies migrations, set placement and per-table counts against the snapshot gauges, evaluates RTO vs OPERATIONS §5 (met ≤ 240 min) and writes a drill record. Tick when a full and a `--main-only` run are committed with RTO met; blocked on staging, bucket, age key.*
  *2026-09-26 (wave F) — local rehearsal, still unticked. Environment: the same container, a local store standing in for R2, real age 1.2.1, Postgres tools via `FIRE_WATCH_BACKUP_PG_EXEC="docker exec -i …"`. The full run passed: 8/8, 78 main and 13 personal rows, RTO met. The minutes were invented, so this proves nothing about RTO. The `--main-only` run gave 8/8 with 0 personal rows. The restored scratch database keeps the erasure tombstone, the `erasure_requests` ledger and the triggers and grants. No defects found in the backup/restore path. Covered in `server/src/app/drills.integration.test.ts`. Still needs real staging: the R2 store (https endpoint, SigV4, lifecycle), the host `age` and the age key custody, the `docker compose exec -T` prefix on the VM, an actual VM rebuild timed per runbook 02, and the two committed records.*
- [ ] **J3 — Runbooks top-5 incident classes.** Spec: A22; R2 mitigation. Needs:
  season experience from C-track.
  *2026-09-24 — drafted, uncommitted, not ticked: `docs/runbooks/` (README index + five
  pre-season drafts: 01 pipeline stale, 02 VM loss/restore, 03 alert dispatch misfire, 04
  upstream overlay/quota/licence, 05 traffic surge). The classes come from review 04
  RB-1…RB-4, RISKS R1/R2/R4/R5 and review 14. Every step cites a log line, env var or file
  that exists; every missing capability is marked NOT YET BUILT with its task (J5 status
  page, C5 legs, J1 canary and `/api/health/meta`, C6 restore, G6 Esri degrade, B9/J4
  deploy, H5/H6). The one-line pointer from `docs/OPERATIONS.md` is still missing. Cannot be
  ticked: no season experience; revise after season 1 and at each pre-season drill.*
- [ ] **J4 — Deploy gates + season regime (L-12).** Spec: A3. Needs: B3.
  8-checkbox deploy gate wired into CI/CD.
  *2026-09-23 — gate built, uncommitted: `infra/deploy-gate/` (register, season,
  checklist, replay evidence; 28 tests), `.github/workflows/deploy.yml`
  (workflow_dispatch → ci via workflow_call → deploy-gate → a deploy step marked
  `DEPLOY_STEP_IS_STUB`), `pnpm run deploy-gate`, GATES L-12 row. A live run today is
  DENIED because S3/S4/S10 are blocked — intended. Open: evening hours unarmed,
  season bounds (Jun 1 – Oct 15 Sofia, inclusive?), box-2 second person for a solo
  founder, severe-event threshold, box 6 wording, boxes 7/8 post-deploy, off-season
  auto-deploy, hotfixes and box 1; no production environment or secrets.*
- [ ] **J5 — Status page + DMARC p=reject + defensive domains.** Spec: A22; 13
  §3.6(27). Off-infra status page live before launch.
  *2026-09-25 — tooling built, unticked: `infra/status/` (`pnpm run status`). `probe`: off-infra static status page (BG + EN, UTC, self-stale banner after 45 min) from /healthz, snapshot age, T2 mirror HEAD and freshness, catalog pending founder review and never-send-linted; example cron→Pages workflow at `infra/status/github-workflow.example.yml` (not installed). `email-auth`: SPF/DKIM/DMARC checker asserting `p=reject`, sp, pct=100, SPF -all + lookup limit, alignment. `defensive-domains`: look-alike checklist, registers nothing. 166 tests. Open: product domain, status host (Pages vs OPERATIONS §10.1 R2), repo, second channel, ESP selectors/rua, domains to buy, copy; see `infra/status/README.md`.*

## Track K — WP9 beta & launch (Mar–May 2027)

- [ ] **K1 — Beta cohort + CP2 instrumentation.** Spec: IP WP9; A9 north-star
  metric. Needs: H9, I-track. ≥500 alert-armed users measurable.
- [ ] **K2 — 50× load test (L-3).** Spec: A3 baseline definition. Needs: E-track,
  G-track.
  *2026-09-24 — harness built, uncommitted, not ticked (needs staging). `loadtest/`:
  pure A3 baseline ×50 scenario (3,333 req/s snapshot polling, 166.7 req/s client-config,
  25,000 SSE attempts against the 5,000 cap, T2 only in an origin-kill phase), L-3
  thresholds as data with spec sources, verdicts pass / fail / not_measured /
  not_applicable, shardable JSON + Markdown reports, a fetch-based driver and CLI (exit 0
  pass, 1 fail, 2 usage, 3 invalid/incomplete); an in-process smoke against the real health
  server routes, hub cap and demotion controller; 67 tests. Root script `pnpm run loadtest`.
  Needs: staging behind Cloudflare with R2, a measured season-1 baseline (planning-baseline
  runs are rehearsals), generator hosts (per-client stream cap 6 → >833 source IPs or a
  staging-only raise). Open: mean session length (10 min), what "kill the origin" means, T2
  age budget (300 s vs 900 s), generator location, `REVALIDATED` classification, stream
  503s vs 5xx, origin req/s source.*
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
