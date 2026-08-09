# Implementation plan — work packages WP0–WP10

*Status: normative sequencing; details owned by the ADRs and reviews cited per WP.*
Calendar aligned with the 12-month plan in `reviews/10-business-gtm.md` §9.1 and the
checkpoints CP1–CP3 ([`GATES.md`](GATES.md) §4). Re-baselined against the capacity
blocker B3 in `reviews/13-second-round-audit.md` §1.

**The one scheduling fact that dominates everything: CP1 (end of October 2026) must
be evaluated against real fires, and the 2026 fire season ends around October.
Shadow ingestion (WP1) recording live-season data by early September 2026 is
therefore the #1 priority; every week of delay is validation data lost for a year.**

## Capacity baseline

Bottom-up, WP0–WP9 as originally written cost ~620–880 h against ~300–500 h of net
founder capacity; August alone booked ~110–155 h against ~45–65 h (13 §1 B3). This
section closes that gap instead of hiding it.

- **Baseline: 12 h/week (~50 h/month) of founder time**, of which ~10 h/week is net
  build time after ops, news-log curation (~30 min/week from WP1), correspondence
  and grant admin — ~300–500 h net across Aug 2026 – Apr 2027. Every date below is
  costed at this rate, not at a full-time rate.
- Weeks above ~20 h are borrowed, not sustained, and are repaid by the recovery
  blocks below.
- **Exactly one deadline is unrecoverable:** FIRMS raw capture recording by early
  September 2026. Every other date in this file slides before that one does.
- **One developer cannot run two tracks.** The single-threaded winter sequence below
  replaces the previous "WP4/WP5 in parallel with WP6/WP7" reading.

### Recovery blocks (plan lines, not slack)

| # | When | Length | Rule |
|---|---|---|---|
| RB-1 | immediately after CP1 (early Nov 2026) | 1 week | no plan work; only the CP1 report if it is unfinished |
| RB-2 | late December 2026 | ≥ 2 weeks | no plan work; the winter sequence is costed with this hole already in it |
| RB-3 | Oct–Nov 2027, after season 1 | ~4 weeks | founder recovery (10 §8.1, R2); only the CP3 retrospective is allowed inside it |

## Calendar overview

| Period | Build focus | Business / GTM (WP10) | Checkpoint |
|---|---|---|---|
| Aug 2026 | WP0 scaffolding + spikes; WP1 ingest begins | Eurostars S11 skip/go by 10 Sep (default: skip); Galileo + Mapbox applications | — |
| Aug–Sep 2026 | WP1 shadow ingestion live; FIRMS 2020–2025 backfill from week 1 | news log starts (~30 min/week); WWF + Meteo Balkans outreach drafted | **FIRMS raw capture by early Sep (hard)**; rest of wave 1 by end Sep |
| Sep–Oct 2026 | WP2 clustering engine + fixtures + minimal CP1 backfill subset | duty-officer interviews scheduled for Q4 | **CP1 (end Oct)** |
| early Nov 2026 | **RB-1 — 1 week, no plan work** | — | — |
| Nov 2026 | WP3 read path + staging environment | partnership meetings (WWF, НАДРБ, Meteo Balkans) | — |
| Nov–Dec 2026 | WP7 first slice (accounts, zones, opt-in) | press-kit build; B2B demo decks from 2024–25 replays | — |
| late Dec 2026 | **RB-2 — ≥ 2 weeks, no plan work** | — | — |
| Dec 2026–Jan 2027 | WP4 map frontend (on OpenFreeMap tiles) | CASSINI Accelerator B8 + Challenges 2027 applications | — |
| Jan–Feb 2027 | WP6 alert **engine** (no channel adapters) | НИФ session watch | alert engine complete end Feb |
| Mar–Apr 2027 | WP6 channel adapters + live shadow; WP7 remainder; WP9 beta | volunteer onboarding; first regional embeds; CASSINI Hackathon #12 | **CP2 (end Apr)** |
| Apr–early May 2027 | WP5 self-hosted tiles & style | press contacts warmed | — |
| May 2027 | WP9 launch: 50× load test, Galileo, pre-season public launch | press push; Viber channel live; supporter tier soft launch | launch |
| Jun–Sep 2027 | season ops (WP8 regime) | first-viral-fire playbook; B2B pilots/LOIs; seeding targets | — |
| Oct 2027 | retrospective, go/no-go on paid tiers | ГДПБЗН working-level meeting | **CP3 (end Oct)** |
| Oct–Nov 2027 | **RB-3 — founder recovery before season 2** | — | — |

Dependency spine: WP0 → WP1 → WP2 → {WP3, WP6}; WP3 → WP4 → WP5; WP7 → WP6 live
shadow; WP8 is continuous; WP10 runs alongside at GTM cost; WP9 gates on all of
them. With one developer the spine is executed **strictly in series** — see the
winter sequence.

## Single-threaded winter sequence (Nov 2026 – Feb 2027)

One item at a time, in this order. Each step is "good enough to unblock the next",
not "finished"; polish returns in Mar–Apr where the beta supplies feedback.

1. **WP3 read path** (Nov) — snapshot, cursor, reconciler, plus the staging
   environment everything later rehearses in.
2. **WP7 first slice** (Nov–Dec) — accounts, watch zones, double opt-in. Pulled
   ahead of WP6 because the Mar–Apr live shadow needs real zones and consented
   recipients; a shadow over synthetic zones tests the engine, not the product.
3. **RB-2** (late Dec) — ≥ 2 weeks off.
4. **WP4 map frontend** (Dec–Jan) — on OpenFreeMap tiles (ADR-001 phase 1); the
   visible surface the beta cohort needs.
5. **WP6 alert engine** (Jan–Feb) — outbox, gateway, state machine, gating config,
   budgets, breaker, kill switch, curation tooling, shadow-diff machinery.
   **Complete by end February 2027.** No channel adapters in this window.
6. **WP6 channel adapters + WP7 remainder** (Mar–Apr) — built *during* the live
   shadow, which by definition sends nothing (L-1); adapters are exercised against
   the shadow's own decisions and closed out by the L-5 device test.
7. **WP5 self-hosted tiles** (Apr – early May) — off the beta critical path, on the
   launch critical path.

## Scope-cut order (pre-committed)

When time is lost, cut from the top of this list. The list is not renegotiated under
pressure — each line is a decision already taken.

1. **Esri/ArcGIS imagery toggle** (ADR-001 A1.3) — an optional layer carrying a
   metering liability.
2. **SSE tier T0** — ADR-003 makes T1 polling feature-complete by construction
   (CI-7); launch on polling, add SSE post-season.
3. **Email channel** — ship web push + Telegram first (L-6's SES quota gate then does
   not apply this season).
4. **Visual-regression suite** → a documented manual pre-release screenshot checklist.
5. **Style polish** — one theme instead of light/dark; hillshade last.
6. **"Why no alert?"** surface (keep "Why this alert?").
7. **Education pack and B2B demo decks** — GTM material, not product.
8. **Place-name localization** reduced to transliteration plus BG names for the top
   ~200 settlements.

## Never-cut list

1. FIRMS raw capture by early September **and** the paging/backup protecting it —
   the 2026 season cannot be re-run (13 B2).
2. Determinism machinery + golden fixtures gating the clustering engine (CI-1/CI-2).
3. Identity contracts frozen before the first production write — source-id registry,
   `detection_uid` canonicalization, migration 001.
4. Fail-closed alerting: budgets, anomaly breaker, kill switch, never-send and
   wording lints (CI-3/CI-10/CI-11).
5. Honest-clock staleness UX and the permanent disclaimer — the ЗЗП liability
   architecture (10 §5.5, R4), not a nicety.
6. GDPR minimum: zone coarsening + app-layer encryption, double opt-in, erasure
   ≤ 30 d, privacy pages.
7. Self-hosted tiles + the attribution registry (CI-13) before **public launch** —
   ADR-001 accepts the no-SLA third party pre-launch only.
8. L-1 live shadow ≥ 2 weeks before the first real send.

---

## WP0 — Scaffolding & week-1 obligations (Aug 2026, weeks 1–2)

- `git init` — before the first commit, add local working files (`WORKLOG.md` and
  similar session notes) to `.git/info/exclude`.
- pnpm workspace: `packages/contracts` (TypeBox schemas, shared verbatim per
  ADR-005 D3), `server/`, `web/`; TS `strict` + `noUncheckedIndexedAccess` +
  `exactOptionalPropertyTypes` + `verbatimModuleSyntax`; Vite 8 pinned exact.
- CI skeleton: typecheck, lint, test, dependency-cruiser boundaries (CI-9), bundle
  budgets placeholder (CI-12).
- **Week-1 obligations that cannot slip** (00-summary):
  - start the **FIRMS 2020–2025 SP backfill download** (long lead time; feeds the
    WP2 parameter fit);
  - frontend spikes **F-6** (MapLibre `promoteId` + feature-state on UUID ids;
    plan B = numeric alias map) and **F-4** (`transformStyle` idempotence with
    `LayerRegistry.apply()`) — ADR-005 D4;
  - external registrations wave 1 ([`EXTERNAL-ACCOUNTS.md`](EXTERNAL-ACCOUNTS.md)),
    including the time-sensitive FireSat Early Adopter registration.
- **DoD:** CI green on an empty-but-wired monorepo; backfill downloading; both
  spikes concluded with a written outcome.

## WP1 — Ingestion in shadow mode (Aug–Sep 2026) — THE PRIORITY

Sources per [`DATA-SOURCES.md`](DATA-SOURCES.md) wave 1:

- FIRMS **Area API** poller (MAP_KEY, 5,000 transactions/10 min; the country API is
  unreliable), VIIRS backbone; `detections` schema with the reserved footprint
  fields and full provenance (ADR-002 D1).
- LSA SAF **LSA-502** SEVIRI FRP; **FCI/SEVIRI cloud mask (CLM)** — a **recording
  obligation, not a gate** on the decay logic (DATA-SOURCES §D6/§E2):
  - **Record, do not join.** Raw CLM is archived from the shadow season onward so the
    pre-season-2027 cutover to observed cloud is a backfillable join rather than a new
    in-season dependency discovered mid-season — the season cannot be re-run.
  - **Cloud state is recorded alongside every miss**, so a miss under cloud can be told
    apart from a miss under clear sky when the E-accumulator is computed and when FER
    is attributed afterwards. Both the proxy value and the observed value stay on the
    row after the cutover — that is what keeps FER comparable across it.
  - **The gate itself runs on the Open-Meteo hourly `cloud_cover` proxy through CP1**,
    declared sufficient there (11 §5.7) — CP1 is not blocked on the CLM sidecar and
    nothing in WP1 may claim it is. If the sidecar slips past pre-season 2027 the
    fallback is ECMWF `tcc`, never Open-Meteo on a public surface (RISKS watchlist).
  - **When cloud data is unavailable the decay logic still runs, degraded and
    documented:** the miss is recorded with cloud state unknown, the cloud-mask
    freshness budget pages (04) because the ladder to `no_longer_detected` is no longer
    honestly gated, and ADR-002's A2.3 unobservability fallback (≥ 14 d with zero
    detections *and* zero accumulable overpasses → `no_longer_detected`,
    `reason = unobservable`) still bounds the event.
- **EFFIS** FWI + burnt-area perimeters via our proxy (ADR-001 A1.2); weather via
  ECMWF Open Data / Open-Meteo (NC tripwire noted in RISKS).
- Per-source freshness budgets + `/api/health/freshness` meta-alerting hooks (04).
- NRT→SP monthly partition-swap machinery (ADR-002 D7) at least stubbed.

**Protection of the recording (must be live *before* the poller is, 13 B2).** The
2026 season is unrepeatable and is currently a single copy on one VM:

- healthchecks.io ping per scheduled job; UptimeRobot probe on the freshness
  endpoint; paging that reaches a phone.
- Nightly **age-encrypted `pg_dump` to R2** with a post-upload ping; at least one
  verified restore onto a scratch VM during September.

**Ingest hardening (13 §3.3 item 14):**

- **E1-grade FIRMS CSV validation + quarantine** — malformed/out-of-range rows are
  quarantined with the **raw bytes retained**, never dropped, never coerced silently;
  plus an **ingest-anomaly breaker leg** (batch size > N× baseline → quarantine the
  batch and suppress downstream alerting).
- **Sandboxed netCDF worker** for LSA SAF (05 E3) — a poisoned product file must not
  be able to crash or escape the ingest process.
- **FIRMS ingestion-parity monitor in week one** — an automated comparison of our
  recorded detections against the public FIRMS map for the same bbox/window, so a
  systematic capture error is caught while the season can still be re-captured.
- **`available_at` capture on every row** + real **NRT-lag histograms** per source
  (they become `availability.json` for the WP2 fixtures and the shadow-PLB baseline).
- **Licence text + retrieval date pinned into `docs/licenses/` per adapter**
  (09 §2.3.5) — one file per source, snapshotted at first use, not linked.
- **pino redaction covering `MAP_KEY` as a URL path segment** — FIRMS puts the key
  in the path, which the default redact rules do not match; a grep for the key over
  the logs must find nothing.

**DoD, tiered — only tier 1 is a hard date:**

- **Tier 1 (hard, unrecoverable — early September 2026):** the FIRMS Area API poller
  is recording continuously to the production schema on the VM, with the protection
  items and the seven hardening items above already live; local archive growing from
  day 1 (R5).
- **Tier 2 (by end September 2026):** LSA SAF LSA-502 + CLM, EFFIS FWI/BA and the
  weather source recording; freshness dashboards live; the parity report produced.
- **Tier 3 (slides freely):** partition-swap machinery beyond a stub, dashboard
  polish, per-source budget tuning.
- No clustering required at any tier — raw capture is the value.

## WP2 — Clustering & identity engine (Sep–Oct 2026, critical path)

- The incremental algorithm, merge semantics with tombstones and
  `migrateAlertState`, reignition linking, lifecycle with the E-accumulator —
  ADR-002 in full.
- Parameter fit: grid search (~600 configs) on the backfill vs EFFIS BA labels;
  acceptance thresholds and plateau rule per GATES §2.
- Golden-replay fixtures **S1–S6 before the first ingest code merges to main**;
  S7–S9 before season. Determinism double-run in CI (CI-1/CI-2).
- **QA metrics harness + weekly report job** — shadow-PCR/shadow-PLB plus FER, FLR
  and DAR computed from the shadow pipeline on a schedule. Without it CP1 is not
  computable at all (13 B1).
- **Pure alert-decision function, pulled forward from WP6** — a side-effect-free
  function over `(event, zone, config)` implementing the ADR-004 D4 gating, so
  fixtures can assert *alert decisions* in 2026, years before any channel exists.
- **PassPredictor port + static per-satellite pass-time table v0**, validated
  against the WP1 recorded data. ADR-002 D6's lifecycle is uncomputable without
  expected-overpass prediction — "no detection" only means something relative to a
  pass that was expected.
- **Fixture sourcing (a named work item, not an assumption)** — verify historical
  EFFIS burnt-area archive access, pin the S1–S6 fire dates against it, and build
  `availability.json` from the WP1-measured NRT lag rather than nominal figures.
- **Data prep:** static hot-source mask (backfill-derived + curated solar/industrial
  seed), land-cover preparation (WorldCover/CORINE), hourly cloud-cover join.
- **FER backfill replay** — false-extinguish rate measured on the backfill before
  the lifecycle runs against live data.
- **CP1 scope discipline:** only the **minimal backfill subset** needed to evaluate
  CP1 is in this WP. Explicitly deferred to Nov 2026 – Apr 2027: per-source weight
  fitting, calibration (ECE/per-bucket precision), dNBR spot-check, p_det
  estimation, major-fire thresholds.
- **DoD:** CP1 evaluated against the GATES §4 criteria — the shadow pipeline
  produces events from live-season data meeting PCR ≥ 95% and PLB ≤ 15 min p95 on
  the QA harness, and the harness emits the dated CP1 evaluation report as the
  checkpoint record.

## WP3 — Read path (Nov 2026)

- `/snapshot.json` with `ETag`/304 + `?updated_after_seq` cursor; R2 static mirror
  (T2); SSE endpoint with ring buffer, caps, drain semantics (T0);
  `/api/v1/client-config` fleet control — ADR-003 D1 (prefix per A1.3).
- Client reconciler + transport supervisor in the framework-free core, fast-check
  property suites (CI-7/CI-8).
- **Staging environment provisioned** — an explicit deliverable of this WP, not an
  assumption. Three later DoDs rehearse in it (this WP's T2 failover, WP6's
  kill-switch rehearsal, WP7's erasure drill) and no other work package creates it.
- **DoD:** polling-only e2e green; reconciler properties green; T2 failover
  demonstrated by killing the origin in staging; staging reachable and reproducible
  from the provisioning script.

## WP4 — Map frontend (Dec 2026–Jan 2027; trust/a11y tail in Mar–Apr 2027)

- Preact shell + signals (`ui/` only), MapLibre controller + layer registry
  (`map/`), event list/detail panels, honest-clock staleness UX, single-slot
  degraded banner, i18n `bg`/`en` typed messages — ADR-005, 08.
- Event pages: `/event/:id` with `mergedInto` `replaceState` redirect; URL-hash
  viewport.
- Runs on **OpenFreeMap tiles** through the beta (ADR-001 phase 1); WP5 swaps the
  basemap before public launch without touching this WP's contracts.
- **Trust surfaces (07 P11–P14, 12 §6):**
  - **About / Methodology** page and a **"How fresh is this data?"** page explaining
    NRT latency, pixel size, and what the map cannot see;
  - **3-card onboarding** with a **logged first-launch disclaimer** acknowledgement
    (the acknowledgement is recorded, so "the user was told" is evidence, not a claim);
  - **OG / share cards** per event with the **observation timestamp baked into the
    image** — a screenshot that travels without its timestamp is the standard way
    this class of product produces a false alarm. These are also the artifact that
    CP3's "≥ 3 media embeds" criterion counts;
  - **education pack** — the reusable explainer material behind the press kit (WP10).
- **List view as a peer surface** — the full event list reachable and usable
  *without* loading the map, for accessibility and low-bandwidth users; not a
  fallback view, a first-class one.
- **Accessibility criteria (testable):** 200% font-scale reflow with no horizontal
  scrolling; 44 px minimum touch targets; 16 px body-text floor.
- **Visual-regression suite** over the map shell, panels, banners and share cards.
- **Place-name localization** — Bulgarian place names and transliteration rules
  (`name:bg` → transliteration → `name` chain). This is broader than translating UI
  messages and is scoped separately from i18n (07 §5.4.6).
- **DoD:** bundle budgets green (CI-12); map-ready ≤ 6 s on 4G / ≤ 15 s on 3G in
  Lighthouse CI; fire-owns-red lint green (CI-14); About/Methodology and "How fresh
  is this data?" published; onboarding disclaimer logged; a share card renders with
  its observation timestamp; the list view is reachable with the map disabled; the
  three a11y criteria pass; the visual-regression suite is green; place names render
  in Bulgarian.

## WP5 — Self-hosted tiles & style (Apr–early May 2027, off the beta path)

- Protomaps build → exploded z/x/y tree on R2 (max z14, Europe/Balkans), Noto Sans
  PBF glyphs incl. Cyrillic; custom outdoor style, light/dark; hillshade from
  Terrarium; EFFIS overlay proxy productionized — ADR-001 A1.
- Attribution registry `credits.ts` + CI presence test (CI-13); ArcGIS imagery
  toggle with metering alarm (A1.3).
- **Sequencing:** the beta (Mar–Apr 2027) runs on the OpenFreeMap public instance —
  acceptable pre-launch per ADR-001 — so this WP is not on the beta critical path.
  It **is** on the public-launch critical path: self-hosted tiles land before the
  May 2027 launch.
- **DoD:** before public launch the app runs with zero third-party runtime
  tile/glyph dependencies; OpenFreeMap documented as dev/emergency fallback only.

## WP6 — Alert stack (Jan–Feb 2027 engine; Mar–Apr 2027 channels + live shadow)

**Engine — complete by end February 2027:**

- Outbox with provenance, notification gateway (sole sender, lint-enforced),
  per-(zone, event) state machine, gating config, budgets B=500/G=2,000, anomaly
  breaker, kill switch — ADR-004 in full.
- Templates + never-send/wording lints (CI-10/CI-11); "Why this alert?" / "Why no
  alert?" explainability surfaces (07 §5.5).
- **Minimal curation tooling** — a single-operator admin form (with an audit row per
  action) that can actually set `officially_contained` / `officially_extinguished`
  from an official statement. Without an input path the mandated GLOSSARY copy for
  those states is dead code.
- **Shadow-diff machinery as code**, not as a habit: `events_shadow` and
  `alerts_shadow` tables, a **nightly diff report** job, and a written
  **fixture-refresh policy** (every explained diff either becomes a fixture or is
  recorded as accepted, with a reason).

**Channels — built during the Mar–Apr shadow:**

- Channel adapters (web push, Telegram, email) with token buckets — ADR-004 D6. The
  live shadow sends nothing by definition (L-1), so the adapters can be written
  against its recorded decisions and closed out by the L-5 device test.
- **≥ 2-week live shadow during the spring burn season (Mar–Apr)** — nightly diff
  review, staged enablement (L-1). Rehearsals run in the WP3 staging environment.
- **DoD:** the engine is feature-complete and fixture-green by end Feb 2027; the
  curation form can set both officially_* states; one nightly diff report generated
  before the shadow starts; shadow gate passed with every diff explained;
  kill-switch rehearsal done (L-4); physical-device push test done (L-5).

## WP7 — Zones, accounts, GDPR surface (Nov 2026–Mar 2027 — starts before WP6)

**Why it moves earlier:** WP6's live shadow needs real watch zones and consented
recipients to be worth running, and the legal artifacts have external lead times
(lawyer, ЕООД). WP7's first slice therefore precedes the WP6 engine in the winter
sequence rather than following it.

- Accounts, watch zones (~1 km coarsening ON, app-layer encryption, coarse grid
  index), double opt-in per channel, Telegram data minimization, erasure ≤ 30 d
  incl. backups, privacy pages and the ЗЗП/LANCE disclaimers — ADR-004 D8, 05, 09.
- **Auth design per 05 §5.4 (C1–C4):** cookie sessions (HttpOnly/Secure/SameSite,
  server-side records, instant revocation) — not JWTs; magic link primary + OAuth
  (Google, Apple), no passwords; separate admin plane with its own session namespace
  and mandatory 2FA; draft→publish workflow with an append-only staff audit trail.
- **North-star instrumentation** — the "alert-armed weekly users" event stream
  (account with ≥ 1 saved zone, alerts enabled, active in the last 7 days) is
  emitted here; WP8 aggregates and reports it (WP10).
- **DoD** — the 09 legal checklist for launch is green, the erasure drill is executed
  in staging, and the following artifacts exist by name:
  - **DPIA**, including a **stated position on CJEU C-184/20** (precise-location data
    as potentially special-category by inference) and what we do about it;
  - **RoPA** (record of processing activities);
  - **DPAs** signed/accepted with every processor (mirrors the "DPA accepted?" column
    in EXTERNAL-ACCOUNTS);
  - **LIA** (legitimate-interest assessment) for each legitimate-interest basis relied on;
  - **breach runbook with КЗЛД 72-hour notification templates** — pre-written, not
    improvised at hour 60;
  - **self-serve data export** for the user's own data;
  - the auth design above, implemented and documented.

## WP8 — Ops & monitoring (continuous; hardening Feb–Apr 2027)

- Freshness meta-alerts, alert canaries, queue-age paging (L-8), backups with
  erasure-aware retention, deploy gates + fire-season release regime (06 §5.7),
  runbooks (R2 mitigation — the system must run without daily founder attention).
- **North-star + KPI reporting job** — weekly aggregation of alert-armed weekly
  users plus the 10 §7.4 KPI set, from the WP7 instrumentation; the CP2/CP3 numbers
  are read from this job, not counted by hand.
- **DoD:** a simulated VM loss is recovered from backup + R2 within the documented
  RTO; runbooks exist for the top 5 incident classes; one real weekly north-star
  report generated before CP2.

## WP9 — Beta & launch (Mar–May 2027)

- Beta during the spring burn season (CP2: ≥ 500 alert-armed users, partnership,
  funding application), running on OpenFreeMap tiles per WP5's sequencing.
- 50× load test (L-3), Project Galileo confirmed, launch-timing rule (L-9): public
  launch May 2027, pre-season, never during a mega-fire.
- **Moderator recruitment** — 1–2 volunteer moderators recruited from the НАДРБ
  cohort during the beta (10 §8 R2: the solo-operator mitigation only exists if
  someone else is trained before the season, not after it).
- **DoD:** all GATES §3 launch gates green; CP2 evaluated and recorded; ≥ 1 moderator
  onboarded with documented duties before the public launch.

## WP10 — Business, GTM & funding (continuous, Aug 2026 – Oct 2027)

The GTM work is given its own work package rather than a column of loose notes,
because CP2 and CP3 are scored on it and it competes for the same 12 h/week as the
code. Source: `reviews/10-business-gtm.md` §4, §5.6, §7.2–§7.4.

**Outreach (10 §4) — infrastructure before credibility, credibility before reach,
reach before the state:**

| # | Partner | When | The ask | Success = |
|---|---|---|---|---|
| 1 | Cloudflare Project Galileo + Mapbox community | Q4 2026 | sponsored infrastructure | approved before public launch |
| 2 | WWF Bulgaria | Q4 2026 – Q1 2027 | endorsement + co-launch + data for their 2027 analysis | joint announcement at the May 2027 launch |
| 3 | НАДРБ + volunteer formations | Q1 2027 | beta cohort, alert-workflow feedback | 100+ volunteer accounts by Apr 2027 |
| 4 | Meteo Balkans | Q1 2027 | co-branded live layer / embed | embed live before the summer season |
| 5 | Regional outlets (Haskovo, Svilengrad, Burgas, Blagoevgrad) | Apr–May 2027 | free widget with attribution | ≥ 3 embeds by Jun 2027 |
| 6 | ГДПБЗН | Q4 2027 | working-level meeting with the season-1 retrospective in hand | a named contact; no formal ask yet |

**Funding calendar (10 §5.6) — the §5.3 whitelist rule applies: single-applicant,
cash or high-advance, ≤ 40 h of application effort:**

| Window | Action | Default |
|---|---|---|
| by 10 Sep 2026 | Eurostars-3 S11 — only if a foreign SME partner already exists | **skip** (write the formal skip decision by 1 Sep) |
| Q4 2026 | EUSPA Space Academy; Project Galileo + Mapbox applications; subscribe to НИФ announcements | do all three (< 10 h) |
| **Q1 2027** | **CASSINI Accelerator Batch 8 + CASSINI Challenges 2027** | do — the highest-fit instruments on the board |
| Q2 2027 | CASSINI Hackathon #12; НИФ session if opened | hackathon yes; НИФ if confirmed |
| Q3–Q4 2027 | EEA/Norway "Green Business"; ПКИП check; Vitosha Ventures II conversation | gate on CP3 |

Anything outside this table (Horizon consortia, Interreg, LIFE, EIC) is deferred to
v2 regardless of how attractive an individual call looks.

**Seeding targets (10 §7.3) — so "community" stays measurable:** 100+ volunteer
accounts by Apr 2027; Viber channel ≥ 1,000 subscribers by Jun 2027; ≥ 3 media
embeds by Jun 2027; ≥ 2,000 alert-armed users by Sep 2027 (feeds CP3). Seeding
order: volunteer formations → WWF base → hiking/hunting/rural groups + Viber →
regional-media embeds. Paid acquisition: none.

**North-star instrumentation (10 §7.4):** *alert-armed weekly-returning users* —
accounts with ≥ 1 saved zone, alerts enabled, active in the last 7 days. Emitted by
**WP7**, aggregated and reported weekly by **WP8**. Raw MAU is reported but never
targeted.

**B2B demo decks (Nov 2026 – Feb 2027):** built from 2024–25 fire **replays**
(Ilindentsi, Sakar) — the backfill pipeline already produces the material, so the
deck costs presentation time, not engineering time. Feeds the CP3 "≥ 2 B2B
pilots/LOIs" criterion.

**Press kit (10 §7.2), prepared before launch, not during the first fire:** the
pre-written Bulgarian explainer ("what 3-hour latency means; what this map is and is
not"), screenshot/GIF templates, the per-fire share page (WP4's OG cards), the
embeddable widget with one-line iframe instructions, a contact list warmed before
the season, and the standing interview rule — fire-watch **complements** ГДПБЗН and
BG-ALERT and never claims official-warning status.

**DoD:** the outreach table has a dated outcome per row by CP2; the Eurostars skip/go
decision is written by 1 Sep 2026 and the Q1 2027 CASSINI applications are submitted;
the seeding targets are measured by the WP8 report, not estimated; the press kit is
complete and rehearsed before the May 2027 launch.

---

## Out of scope for season 1 (recorded so scope creep hits a document)

Automatic event splits (curated only, ADR-002 D4); FCI/GEO event creation
(attach-only until GATE-v2); B2B API + webhooks (v2); OpenAPI publication (v2);
expansion tiles beyond BG+100 km buffer; paid tiers (CP3 decision); native apps.
