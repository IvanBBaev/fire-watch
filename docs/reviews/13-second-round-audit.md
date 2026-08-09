# Review 13 — Second-round audit of the distilled layer

*Status: complete. Date: 2026-07-30. Method: 8 independent senior-role auditors, read-only, identical output contract.*

## 0. What this audit is

Round 1 (reviews 01–12) audited the **analysis**. This round audits the **distillation**:
the five ADRs plus the consolidated docs (README, GLOSSARY, GATES, RISKS,
IMPLEMENTATION-PLAN, DATA-SOURCES, EXTERNAL-ACCOUNTS) — the layer the project will
actually be built from. Reviews are non-normative by the repo's own precedence rules,
so anything that only survives in a review is, operationally, **lost**.

Each auditor answered the same four questions:

1. **Contradictions** — where do the distilled documents contradict each other?
2. **Losses** — which round-1 normative items were dropped in distillation, and where
   should they now live?
3. **Stability** — which gaps destabilize WP0/WP1 (Aug–Sep 2026), the unrecoverable window?
4. **Realism** — are the gates and the calendar actually executable as written?

Output contract per role: VERDICT (GO / GO-WITH-CONDITIONS / NO-GO for starting WP0
in Aug 2026) · FINDINGS (max 10, BLOCKER/MAJOR/MINOR, each with doc+section and a
concrete fix) · LOST-IN-DISTILLATION (citing the round-1 §) · ROLE-WATCH (top 3
things this role watches during WP0–WP2).

## 1. Overall verdict

**GO-WITH-CONDITIONS — unanimous, 8 of 8 roles.** No role found a reason not to start
WP0 in August 2026; every role found conditions that must be fixed **on paper before
September**, because the errors they protect against become unfixable once the shadow
season starts recording.

| Role | Verdict | Blockers | Majors | Minors |
|---|---|---|---|---|
| Architect | GO-WITH-CONDITIONS | 1 | 7 | 2 |
| SRE / Platform | GO-WITH-CONDITIONS | 1 | 7 | 2 |
| Data Science (remote sensing) | GO-WITH-CONDITIONS | 0 | 5 | 5 |
| Security & Privacy | GO-WITH-CONDITIONS | 0 | 7 | 3 |
| QA / Test Architecture | GO-WITH-CONDITIONS | 1 | 7 | 2 |
| Legal / Licensing | GO-WITH-CONDITIONS | 0 | 5 | 5 |
| Delivery / EM | GO-WITH-CONDITIONS | 1 | 7 | 2 |
| Product / UX | GO-WITH-CONDITIONS | 0 | 7 | 3 |

The four blocker findings collapse into **three distinct blockers**:

| # | Blocker | Found by | One-line fix |
|---|---|---|---|
| B1 | **CP1 is unevaluable as written** — PCR is defined over alerts/subscribed zones that will not exist until WP6/WP7 (2027); PLB includes dispatch stages that won't exist; no WP builds the metrics harness; the go/pause business checkpoint of Oct 2026 cannot be computed | Architect, QA (blocker); Data Science, Delivery (major) | Write a one-page **CP1 evaluation protocol** in September: shadow-PCR = event-based (06 §5.1.2's original definition — FireEvent covering the EFFIS ≥50 ha perimeter buffered 2 km) on a synthetic zone grid; shadow-PLB = `available_at → event-visible` p95; minimum-n rule with 2024–25 backfill-replay fallback; named news-log curator; dated report artifact as the CP1 record |
| B2 | **The Sep–Oct 2026 shadow season runs unprotected** — WP1 goes live unattended with no pager, no off-VM backup, zero observability accounts in EXTERNAL-ACCOUNTS; hardening is WP8 (Feb 2027). The plan's own #1-priority data is one `rm -rf` / disk failure away from a one-year loss | SRE (blocker); QA, Architect (role-watch) | WP1 DoD gains: healthchecks.io ping per scheduled job, UptimeRobot probe on the freshness health endpoint, nightly age-encrypted `pg_dump` to R2 with post-upload ping, one verified restore in September; monitoring SaaS added to EXTERNAL-ACCOUNTS Wave 0/1 |
| B3 | **The capacity math does not close** — bottom-up the plan is ~620–880 h against ~300–500 h net founder capacity; August alone books ~110–155 h against ~45–65 h; the winter "parallel tracks" are fiction for one person; no scope-cut order exists | Delivery (blocker) | Tier WP1's DoD (FIRMS raw capture by early Sep is the **only unrecoverable deadline**; everything else slides), publish the single-threaded sequence keyed to the 1 Mar 2027 spring-burn shadow, pre-commit an ordered cut list, add recovery blocks as plan lines |

## 2. Convergent findings

Where independent roles hit the same defect, confidence is highest. Beyond the three
blockers above:

- **C1 — CI-1 contradicts WP1 (4 roles: Architect, Data Science, QA, Delivery).**
  "Fixtures S1–S6 pass before the first *ingest* code merges" is violated on day one:
  ingest merges in August, fixtures are WP2 (Sep–Oct), and the fixtures assert
  clustering/lifecycle/alert outcomes that raw capture doesn't produce. Fix: reword
  CI-1 to gate the **clustering/identity engine**; WP1 raw capture is gated only by
  schema/dedup/provenance tests; the fixture-harness *skeleton* becomes a WP1 deliverable.
- **C2 — Whole normative families are stranded in non-authoritative reviews (all 8 roles).**
  The single biggest structural defect of the distillation. Per family: ops
  quantitative layer (freshness budgets, SLOs, RTO/RPO, backup tiers, runbooks — 04),
  security/GDPR gate family (DPIA, RoPA, DPAs, IR playbooks, [GATE-v1] — 05/09),
  staged legal gates + attribution registry (09), metric formulas + deploy-gate
  checklist (06), BG copy + trust surfaces (07/12), server module boundaries + API
  conventions (01/02). Fix: a new **ops ADR-006 (or docs/OPERATIONS.md)** plus targeted
  amendments listed in §3; the full register is in §5.
- **C3 — GATES.md violates its own charter (5 roles).** It claims "every gate in one
  place… so that nothing is forgotten", yet has no legal, security/privacy, calibration,
  load-battery-owner, restore-drill, pre-season fire-drill, or season-deploy-regime
  gates; CP2's consequence covers only "miss all" (and disagrees 3-vs-4 with review 10);
  CP3 leaves the most likely outcome (exactly 2 of 4) undefined; L-2 is assigned to no WP.
- **C4 — Solo-founder single-human contradictions (4 roles).** The two-person
  T-approve rule has no second person (fails closed in exactly the mega-fire where it
  matters); the CER news log has no owner and contradicts R2's "zero manual-curation"
  claim; 3 AM degradation is manual-only after the auto-demotion thresholds were
  dropped; the R2 "recovery block" mitigation exists in RISKS but not in the calendar.
- **C5 — Erasure/retention contradictions (SRE, Security).** ADR-004's erasure ≤30 d
  vs the 56-day backup retention design; outbox 5-year retention vs 05's normative
  24-months-then-anonymize (an open lawyer question in 09); "pseudonymized" conflated
  with erasure. One decision, recorded as an ADR-004 D8 amendment, asserted by the
  WP7 erasure drill.
- **C6 — The wording contract contradicts itself (QA, Product).** GLOSSARY §3 has BG
  placeholders for 3 of 6 states (the full strings exist in 12 §4.3); the mandated
  `no_longer_detected` copy contains the banned token "out"/"изгасен", so CI-10/CI-11
  as specified fail their own required strings; README line 3 says "Real-time" — the
  exact banned framing; README invariant 2 is literally contradicted by mandated copy.
- **C7 — Identity/schema contracts must freeze before the first production write
  (Architect, Data Science, QA).** No canonical source-id registry exists while the
  source string is baked into `detection_uid` forever; dedup semantics (no-op vs
  refinement) silently changed from 02 without adjudication; ADR-002 D7's NRT→SP
  "uid alignment" check is impossible by construction; migration 001 must include
  the outbox/alert-state skeletons WP2's `migrateAlertState` needs.

## 3. Consolidated amendment plan (time-ordered)

Reviews are advisory; this list is what should actually change, ordered by when it
must land. Each item names its target document.

### 3.1 Now — before WP0 starts (Aug 2026)

1. **GATES.md §1**: reword CI-1 to scope the clustering/identity engine (C1); add S10
   to the pre-season fixture list (DS#10).
2. **GATES.md §4**: replace CP1's criteria with the shadow definitions (B1) and add
   the one-page CP1 evaluation-protocol requirement (dated report artifact); restore
   the "≥ 50 ha" qualifier; fix CP2 "all three/four" discrepancy; define partial-miss
   consequences for CP2/CP3 and the evidence artifact per criterion.
3. **IMPLEMENTATION-PLAN.md**: tier WP1's DoD (FIRMS raw capture early Sep = hard;
   LSA SAF/CLM/EFFIS by end Sep); re-baseline at a stated hours/week; publish the
   single-threaded winter sequence and the WP6 split (engine by end Feb, channels
   during the Mar–Apr shadow); move WP5 self-hosted tiles off the beta path (beta on
   OpenFreeMap, self-hosted before public launch); add the ordered scope-cut list +
   never-cut list (B3); add recovery blocks as plan lines (late-Dec ≥2 w, post-CP1
   1 w, Oct–Nov 2027).
4. **EXTERNAL-ACCOUNTS.md**: add monitoring SaaS (healthchecks.io, UptimeRobot,
   Grafana Cloud/Sentry, Twilio-later) to Wave 0/1 (B2); move Project Galileo to
   Wave 0/1 and add Mapbox community application; add Wave-2 rows for ЕООД formation,
   Bulgarian lawyer engagement, EUTM filing (the three longest legal lead times);
   standing rule: hardware-key 2FA on all root-of-trust accounts; "DPA accepted?" column.
5. **GLOSSARY.md §1**: freeze the closed v1 source-id registry (canonical source
   strings entering `detection_uid`; platform derived from the queried source name,
   never the CSV column) (C7).
6. **README.md line 3 + ANALYSIS.md line 3**: drop "Real-time" → "Near-real-time
   (15 min–3 h)…" (C6); reword invariant 2 ("never in our own assertive voice; the
   exact §3 negation strings excepted").
7. **GLOSSARY.md intro**: "CI-10/CI-12" → "CI-10/CI-11" (3 roles caught it).
8. **Founder calendar**: Eurostars skip/go decision by 1 Sep (write the formal skip);
   schedule the 3–5 volunteer-formation duty-officer interviews for Q4 2026, before
   WP6 design freezes.

### 3.2 During WP0 (Aug 2026)

9. **New ops ADR-006 (or docs/OPERATIONS.md)** — the single largest restoration:
   freshness budget table (FIRMS 20/45 min, FCI 30/60, EFFIS 26/50 h, snapshot 5/15
   min) + three-leg meta-alerting + health-endpoint 500-on-stale semantics; SLOs
   (99.9/99.5/99%) + solo-dev error-budget policy; RTO 2–4 h / RPO 24 h→≤15 min;
   backup tiers + quarterly restore drill; upgrade-trigger table; secrets inventory
   + handling model; VM class + host tuning as `infra/cloud-init.yaml`; status page;
   canonical freshness endpoint path (resolves `/api/health/freshness` vs
   `/api/v1/meta/freshness`).
10. **WP0 CI list**: secret scanning + push protection, npm audit gate, SHA-pinned
    Actions, Renovate cool-down; CSP/security headers from first deploy; the
    server-side import matrix + single-writer rule added to CI-9's definition
    (from 01 §6.1); Testcontainers-PostGIS incl. migration up/down + append-only-grants
    test.
11. **Migration 001**: detections, fire_events, source_status, watch_zones,
    alert-state, alert_outbox skeletons — one schema owner, review DDLs marked
    non-normative, kysely-codegen types the only import path (C7).
12. **Determinism machinery as WP0 artifact**: virtual-clock port, fixed batch
    ordering, config-as-data versioning, fixture-harness skeleton.
13. **GATES.md §3 additions**: L-10 legal/security launch gate (privacy policy,
    layered ЗЗП/LANCE disclaimers, DPIA, RoPA, ЕООД before first stored watch zone,
    admin 2FA); L-11 pre-season fire drill (restore + k6/chaos battery + quota/key/
    VAPID checks + 3 AM wake-up test); L-12 season deploy regime (freeze rules +
    8-checkbox deploy-gate from 06 §5.7); calibration row (ECE ≤ 0.07, per-bucket
    precision) for v1; 2027-constellation replay gate (NOAA-20/21+SLSTR-only re-run
    must pass the same §2 gates); L-2 assigned to the WP3→WP8 boundary; 50× baseline
    defined.

### 3.3 Before WP1 goes live (early Sep 2026)

14. **WP1 DoD**: the B2 monitoring/backup items; E1-grade FIRMS CSV validation +
    quarantine (raw bytes retained) + ingest-anomaly breaker leg; sandboxed netCDF
    worker (E3) for LSA SAF; FIRMS ingestion-parity monitor (week-one check against
    the FIRMS map); `available_at` capture + real NRT-lag histograms; licence text +
    date pinned into `docs/licenses/` per adapter (09 §2.3.5); pino redaction covering
    MAP_KEY as URL path segment.
15. **ADR-002 amendments**: D7 rewritten to the staging→sanity→partition-swap→
    re-cluster procedure (uid row-alignment is impossible); D1 sentence adjudicating
    dedup as intentional no-op (02 §5.3/§5.11 superseded); supersession note for the
    GEO-only fixture conflict with 11 §9.4; ODbL rule (no OSM element IDs in
    fire-event records) into D1's schema rules; display-window rule (48 h map / 7 d
    permalink) recorded in D6.
16. **Weather source of record**: reclassify Open-Meteo free tier as dev-only
    (commercial-in-trajectory doctrine); ECMWF Open Data becomes the wave-2 source
    of record or budget $29/mo from beta (Legal#3); declare the Open-Meteo
    `cloud_cover` proxy sufficient for CP1 and schedule the FCI/SEVIRI CLM sidecar
    for pre-season 2027 (DS#4) — reconciling WP1/E2/ADR-002 D6.

### 3.4 Before WP2 starts clustering (mid-Sep 2026)

17. **WP2 scope**: QA metrics harness + weekly report job (B1); pure alert-decision
    function (ADR-004 D4 gating) pulled forward so fixtures can assert alerts;
    PassPredictor port + static pass-time table v0 (ADR-002 D6 is uncomputable
    without it); named fixture-sourcing item (verify historical EFFIS BA archive
    access, pin S1–S6 fire dates, build availability.json from measured NRT lag);
    static hot-source mask + solar seed, land-cover prep, cloud-cover join; FER
    backfill replay; minimal CP1 backfill subset assigned, the rest (weight fitting,
    calibration, dNBR spot-check, p_det, major-fire thresholds) explicitly deferred
    to Nov 2026–Apr 2027.
18. **GATES.md §2 scope sentences**: hard-negative pairwise precision (≤20 km, ≤7 d),
    EFFIS-labeled population caveat + size stratification, per-source metrics next
    to the split rule, eps_geo exemption (2025-only data vs touch-once test season),
    citation fix (11 §9.1 not §8).
19. **GLOSSARY §8**: restore the 06 §5.1.2 formulas (PCR event-based, CER, ZAP,
    DAR = **Duplicate** Alert Rate with its formula, FLR, PLB stage budgets); one
    canonical FER row (False Extinguish Rate, not "resurrection"); "alertable event"
    definition.
20. **News log**: named curator (founder, ~30 min/week, timeboxed), starts with WP1;
    R2's wording reconciled ("no manual-curation dependency *in the product*; the QA
    truth log is an accepted exception").

### 3.5 Nov 2026 – Feb 2027 (before WP4 / WP6 / WP7 build on the contracts)

21. **GLOSSARY §3/§3b/§5**: the three BG lifecycle strings restored verbatim from
    12 §4.3 (fixed templates, not quoting); new §3b degraded/empty-state copy table
    (H6 stale banner, frozen-state label, empty-state) in CI-11 scope; CI-10 specified
    as banned-vocabulary minus explicit allowlist of the §3 negation strings, with
    word-boundary + own-voice/quote context + BG morphology; BG synonyms added to
    the banned list; H2 safety copy, agri-burn context tag, and the дка+ha both-units
    rule as lintable contract entries; defer-always list (road closures, cause
    attribution).
22. **ADR-004 amendments**: trigger_type regains `manual`/incident + actor_id/
    approver_id (the T-approve act must be representable); priority ordering in the
    outbox schema (not FIFO); retention decision (24 mo vs 5 y) + precise
    "pseudonymized" field list (C5); T-approver named or solo fallback (delayed
    approval + cool-off) recorded; ingest-side breaker leg (D5 sibling); reignition
    alert-type decision (new_fire vs escalation for `possible_reignition`); zone-default
    sensitivity reconciliation (Confirmed-only default vs ≥0.45 gate) + quiet-hours
    default 22:00–07:00.
23. **WP4 scope/DoD**: About/Methodology + "How fresh?" pages, 3-card onboarding with
    logged disclaimer, OG/share cards (CP3's "media embeds" needs an artifact),
    education pack, list view as a11y/low-bandwidth peer surface, a11y criteria
    (200% reflow, 44 px targets, 16 px floor), visual-regression suite, place-name
    localization.
24. **WP6/WP7 scope**: minimal curation tooling for officially_* states (otherwise
    dead copy); shadow-diff machinery as code (events_shadow/alerts_shadow, nightly
    diff report, fixture-refresh policy); staging environment provisioned (three DoDs
    depend on one that doesn't exist); WP7 DoD enumerates DPIA (incl. C-184/20
    position), RoPA, DPAs, LIA, breach runbook with КЗЛД-72h templates, self-serve
    export, auth design cited from 05 §5.4 (C1–C4) — start WP7 earlier than Feb 2027.
25. **ADR-003 amendments**: auto T0→T1 demotion thresholds (event-loop lag p99
    >200 ms 5 min etc.) as L-2 pass criteria; T2 flip normative path = client-side
    supervisor with second R2 hostname (never a free-tier Worker route); RFC 7807 +
    `/api/v1` + rate-limit/CORS conventions (from 02 §5.6).
26. **GTM plan lines** (IMPLEMENTATION-PLAN business column or WP10): review-10 §4
    outreach table (WWF, НАДРБ, Meteo Balkans, regional outlets), §5.6 funding
    calendar (CASSINI Q1 2027), §7.3 seeding targets, north-star instrumentation
    ("alert-armed weekly users") in WP7/WP8, B2B demo decks from 2024–25 replays,
    press kit; moderator recruitment in WP9 DoD.

### 3.6 Before public launch (Apr–May 2027)

27. L-10 legal/security gate green (incl. ЕООД, ToS lawyer pass, privacy policy with
    Esri/AWS recipients disclosed); L-11 fire drill executed; L-12 season regime
    active; DMARC p=reject + defensive domains + off-infra status page live;
    attribution-string table (verbatim, incl. the Cop-DEM sentence) landed in
    DATA-SOURCES **before** WP5 builds CI-13; erasure-vs-backup mechanism asserted
    by the WP7 drill; CP3 paid-tier rider (consumer-law scaffolding + VAT/MoR
    decision) recorded in GATES §4.

## 4. Per-role verdicts (one paragraph each)

Full per-role reports (10 findings each, with fixes) were produced under the output
contract; their substance is consolidated in §2–§3 and §5. Summary:

- **Architect** — GO-WITH-CONDITIONS. The identity/read/alert architecture is coherent;
  the danger is contract drift at the ingest layer: no source-id registry, silently
  changed dedup semantics, an impossible D7 check, missing migration-001 contents,
  missing PassPredictor, and server boundaries with no normative home. Freeze the
  identity contract before the first production write.
- **SRE** — GO-WITH-CONDITIONS. ADR-003/004 are operationally sound, but the entire
  quantitative ops layer lives in review 04 (non-normative) and the shadow season
  runs without paging or backups. Ops ADR-006 + WP1 protection items.
- **Data Science** — GO-WITH-CONDITIONS. CP1 protocol, CI-1 rescope, and the
  2027-constellation replay must be written before September; the CLM "hard
  dependency" contradicts 11 §5.7's deliberate proxy; calibration and metric scope
  qualifications must return to GATES.
- **Security & Privacy** — GO-WITH-CONDITIONS. Verified by grep: DPIA, RoPA, 2FA,
  breach, CSP, DMARC, ЕООД appear **nowhere** in the distilled layer. The [GATE-v1]
  family must be re-attached (L-10), WP0 CI hardened, provenance fields restored to
  the outbox, retention contradiction resolved.
- **QA** — GO-WITH-CONDITIONS. CP1 is unevaluable (the distillation silently swapped
  the event-based PCR for an alert-based one); DAR lost its formula in a rename;
  fixture sourcing is unplanned; the wording contract fails its own strings; the
  load/chaos harness is nobody's work item.
- **Legal** — GO-WITH-CONDITIONS. All wave-1 sources genuinely open; but the staged
  legal gates are stranded, the attribution registry CI-13 will test is unspecified,
  Open-Meteo's NC tier contradicts the corpus's own doctrine, and the three longest
  lead-time items (ЕООД, lawyer, EUTM) are absent from EXTERNAL-ACCOUNTS.
- **Delivery/EM** — GO-WITH-CONDITIONS. Starting is correct and urgent, but the plan
  overbooks the founder ~1.5–2×, breaks first in August, has no cut order, no
  recovery blocks, and CP2's business legs have no plan lines. Tier WP1, re-baseline,
  pre-commit cuts.
- **Product/UX** — GO-WITH-CONDITIONS. The wording contract and WP4 scope carry
  seven gaps that would ship dishonest or stranded copy: BG placeholders, the
  "Real-time" over-promise in README line 3, missing trust surfaces, unreachable
  MVP GO conditions from 12, no curation input path for officially_* states.

## 5. Lost-in-distillation register (consolidated, by destination)

Items round 1 marked normative that currently live only in reviews. Destination =
where the item must land to become authoritative again.

| Destination | Items (source) |
|---|---|
| **New ops ADR-006 / OPERATIONS.md** | Freshness budget table + three-leg meta-alerting + 3 AM path (04 §5.3.3); SLOs + error-budget policy (04 §5.4); RTO/RPO + backup tiers + quarterly restore drill (04 §5.5); upgrade-trigger table (04 §5.4); secrets inventory + handling (04 §5.6); deploy freeze + last_good rollback (04 §5.6); VM class + host tuning (04); status page, Sentry, CF abuse posture (04) |
| **ADR-002 amendments** | NRT→SP partition-swap procedure (03 §5.3); dedup adjudication (02 §5.3/§5.11); Jaccard ≥0.5 ID-preserving promotion (03 §5.2.5); PassPredictor (01 rec 10); GEO-only supersession note (11 §9.4); ODbL no-OSM-IDs rule (09/DATA-SOURCES); display-window rule (00-summary T8); defer-always schema note — no cause fields (12 §3.3) |
| **ADR-003 amendments** | Auto-demotion thresholds + hysteresis (04 §5.2.3); T2 client-supervisor as normative path (04); RFC 7807 + /api/v1 + rate-limit/CORS + attribution field (02 §5.6) |
| **ADR-004 amendments** | manual/incident trigger types + actor/approver IDs (05 §5.2.1/A7); priority dispatch ordering (04 §5.7); 24-mo retention + pseudonymization field list (05 §5.3.3, 09 §10 Q5); ingest-anomaly breaker leg (05 §5.2.3/E1, 01 §6.1.3); T-approver or solo fallback (05 §6 Q1); magic-link caps + bounce processing (05 §5.5.3); zone-default sensitivity + quiet hours (07 §5.5.1/5.5.4); reignition alert type (07 vs ADR-002 D2) |
| **GATES.md** | L-10 legal/security launch gates ([GATE-MVP]/[GATE-v1] families, 05/09); L-11 pre-season fire drill (04 App B); L-12 season deploy regime (06 §5.7, 04 §5.6); calibration row — ECE ≤0.07, bucket precision re-derivation, drift alarm (11 §3.8–3.9); 2027-constellation replay (11 §4.6 implication); metric scope sentences (11 §4.1–4.2); split caveats (11 §9.1); dNBR third truth leg (11 §9.2); CP3 paid-tier consumer/VAT rider (09 §4.7/§6.3); crowdsourcing conditional gate (09 §8); alert-copy sign-off checkbox (06 Q9) |
| **GLOSSARY.md** | Metric formulas incl. Duplicate-Alert-Rate + "alertable event" (06 §5.1.2); FER canonical row (11 §5.8); BG lifecycle strings (12 §4.3); §3b degraded/empty-state copy (12 §7, 07 §5.2.2–5.2.4); H2 no-travel copy + centroid rule (12 §7); дка+ha rule (12 §7 H8); BG banned-synonym list (12); source-id registry (03 §5.1.1) |
| **IMPLEMENTATION-PLAN.md** | Migration-001 contents incl. outbox (00-summary action 3, 02 rec 7); backfill six-deliverable work order staged (00-summary action 8); test pyramid items (06 §5.3); production monitors (06 §5.5); shadow-diff machinery (06 §5.7); visual-regression suite (06 §5.4); trust surfaces + onboarding + share cards + education pack (07 P11–P14, 12 §6); a11y targets + list view (07 §5.8); place names (07 §5.4.6); curation tooling for officially_* (12/07); GTM column — outreach table, funding calendar incl. Eurostars 1 Sep decision, seeding targets, north-star instrumentation, B2B decks, press kit (10 §4/§5.6/§7/§9); recovery blocks (10 §8.1); duty-officer interviews (00-summary action 9); staging environment (06 Q7); p_det estimation task (11 §5.3); major-fire thresholds (11 §8.3); shadow-period user UI (07 §5.5.2); postmortem 72 h SLA + corrections page (07 §5.6.4) |
| **EXTERNAL-ACCOUNTS.md** | Monitoring SaaS wave-0/1 rows (04); hardware-key 2FA standing rule (05 F1); ЕООД + lawyer + EUTM rows (09 §6.1/§10.1/§7); Galileo to wave 0/1 + Mapbox row (10 §9.5); DMARC p=reject + defensive domains + status page (05 §5.2.4/T17); DPA column (05 B5); name-clearance ЗМГО/ТЗ rule (09 §7.2) |
| **DATA-SOURCES.md** | Canonical attribution-string table incl. verbatim Cop-DEM sentence (09 §2.4 + catalog delta); FIRMS pitfall table (03 §5.1.1); Open-Meteo reclassification (09 §2.2.I doctrine); EUMETSAT Recommended-tier caveat + policy pin (09 §2.2.B); corrected provenance citations (Legal#7); licences pinned to docs/licenses/ (09 §2.3.5); EFFIS B2B written-position note (09 §2.2.E) |
| **WP0 CI skeleton** | Secret scanning, npm audit, SHA-pinned Actions, Renovate cool-down (05 F2/F3); CSP/headers (05 F4); server import matrix + single-writer in CI-9 (01 §6.1, 02 §5.1–5.2); packages/contracts inventory (02 §5.1) |
| **WP1 DoD** | E1 CSV validation + quarantine (05 E1); sandboxed netCDF worker (05 E3); ingestion-parity monitor (06 §5.5); MAP_KEY path-segment redaction (02); licence snapshots (09 §2.3.5) |
| **RISKS.md** | R4 reworded — disclaimers cannot shield under ЗЗП; conduct + logs are the defence (09 §3.4/§3.6); R2 reconciled with the news-log exception (06 Q5); solo on-call honesty (04 Q2, 06 Q10); constellation-transfer row (11); unowned open questions Q2/Q4/Q5/Q6 from 04 answered or explicitly deferred |
| **ANALYSIS.md** | Stale §5 text (Neon/Supabase rec, old SSE diagram) → one-line pointers to ADR-003/004; "Real-time" in line 3; crowdsourced reports moved to out-of-scope with the 09 §8 conditional |

## 6. What the audit did *not* find

- **No role challenged any of the five ADR decisions themselves.** Self-hosted tiles,
  the Detections→Clusters→FireEvents identity model, the T0/T1/T2 read path, the
  outbox + gateway + budgets alerting spine, and Preact+signals all survived scrutiny
  intact. The defects are in *completeness and consistency of the distillation*, not
  in the decisions.
- **No new external dependency, cost, or data-source problem** beyond the Open-Meteo
  tier reclassification — the DATA-SOURCES catalog held up.
- **No role argued for delaying WP0.** The unanimous view: start on time, fix the
  paper first — the most dangerous failure mode is entering September with CP1
  undefined, the archive contract unfrozen, and the shadow season unprotected.

## 7. Sequencing note

The amendment plan in §3 is itself work (~3–5 focused sessions). Priority order if
time is short: **§3.1 items 1–5** (they gate everything), then **item 9** (ops ADR),
then **items 14–16** (WP1 protection + ADR-002 amendments). Everything in §3.5 can
land incrementally through the autumn without risk, provided the contracts (§3.1–3.4)
are frozen first.
