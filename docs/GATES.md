# Gates — every enforcement point in one place

*Status: normative index.* Each gate's full definition lives in the cited ADR or
review; this file exists so that nothing is forgotten, CI setup (WP0) has a
checklist, and the launch decision is mechanical rather than a mood.

Three families:

- **CI-x** — permanent per-PR gates, enforced by the pipeline from the day the
  relevant code exists.
- **L-x** — operational launch/season gates, checked before beta, launch, and each
  fire season.
- **CP1–CP3** — business checkpoints with predefined consequences (review 10 §9.2).

## 1. CI gates

| # | Gate | Definition | Source |
|---|---|---|---|
| CI-1 | Golden replay | Scoped to the **clustering/identity engine**: S1–S6 green before any change to clustering, identity, lifecycle, or alert-decision code merges to main; S7–S10 green before season. **Raw-capture ingest (WP1) is not gated by S1–S10** — it is gated by schema, provenance, uid-idempotence and determinism-neutral checks only, because the fixtures assert outcomes raw capture does not produce. Outcome-asserting fixtures (`expected.json`), not internals; scenarios in §1.1. | ADR-002 acceptance, 13 C1 |
| CI-2 | Determinism double-run | The whole replay runs twice in CI; the event registry must be byte-identical (invariant I5: virtual clock, fixed batch ordering, no RNG). | ADR-002 D7/I5 |
| CI-3 | Zero single-low-confidence alerts | Across all fixtures, no alert originates from a single low-confidence detection; GEO-only never alerts. | ADR-002/004 shared invariant |
| CI-4 | Permalink properties | I1/I2: every `public_id` ever issued resolves; merged ids return **200 + `mergedInto`**; alias chains acyclic, path-compressed. | ADR-002 D3, ADR-003 D4 |
| CI-5 | Merge-alert property | I3: a merge can never produce a second "new fire" for a zone already notified about any parent (`migrateAlertState` in the merge transaction). | ADR-002 I3, ADR-004 D3 |
| CI-6 | Replay silence | Reprocessing/backfill emits zero alerts; revival requires `--allow-revive` (I4). | ADR-002 D7/I4 |
| CI-7 | Polling-only e2e | The full e2e suite passes with SSE disabled — every feature must be T1-complete. | ADR-003 D1 |
| CI-8 | Reconciler properties | fast-check: convergence under any snapshot/delta interleaving, no `seq` regression, no zombie events, delta idempotence, no flicker-delete. | ADR-003 D3 |
| CI-9 | Dependency boundaries | dependency-cruiser: `core` imports no framework/map libs; `map` never imports `preact`; provider adapters importable **only** by the notification gateway. | ADR-005 D1, ADR-004 D2 |
| CI-10 | Never-send template lint | Rendered alert/UI templates checked against the banned vocabulary and quote-only rules (GLOSSARY §4–§5). A tripping template fails CI, not runtime. | ADR-004 D7 |
| CI-11 | Wording-ladder lint | Lifecycle copy matches the exact GLOSSARY §3 strings (parameterized). | ADR-004 D7, 12 §4.3 |
| CI-12 | Bundle budgets | Lighthouse CI per PR: entry ≤ 85, map chunk ≤ 290, critical path ≤ 350, CSS ≤ 20 KB gz; UI fonts = system stack. | ADR-005 D3 |
| CI-13 | Attribution presence | The credits registry (`credits.ts`) is rendered in the map control, `/credits`, and alert footers — a styling refactor cannot drop a licence obligation. [GATE-MVP] | ADR-001 A1.4 |
| CI-14 | Fire-owns-red + CVD | Style lint: red/orange reserved exclusively for fire layers; color-vision-deficiency checks. | 06 §5.4, ADR-005 D4 |
| CI-15 | Config-as-data versioning | Clustering/gating parameter changes are PRs to versioned config objects; the version is recorded on every event and alert row. | ADR-002 D5, 06 §5.7 |

### 1.1 Fixture register

| # | Scenario | Asserts | Required | Owner |
|---|---|---|---|---|
| S1 | Slavyanka border-crossing | one cross-border cluster = one event | pre-merge (CI-1) | WP2 |
| S2 | Sakar/Harmanli merge | survivor id rules; the merged id's permalink resolves 200 + `mergedInto` | pre-merge (CI-1) | WP2 |
| S3 | Agri-burn false positive | labeled `likely_agri_burn`, never Confirmed, no alert | pre-merge (CI-1) | WP2 |
| S4 | Industrial static source | never becomes an event (hard override, score 0) | pre-merge (CI-1) | WP2 |
| S5 | Single-detection noise | stays Unverified, no alert | pre-merge (CI-1) | WP2 |
| S6 | Megafire cooling + reignition | fuel-window relation on the same id; no false `no_longer_detected`; FER not charged | pre-merge (CI-1) | WP2 |
| S7 | Cloudy gap | E does not accrue on obscured opportunities; never reaches `no_longer_detected` | pre-season (CI-1) | WP2 |
| S8 | Transient source outage | E freezes for that source; lifecycle resumes on recovery | pre-season (CI-1) | WP2 |
| S9 | UTC/DST ingest boundary | acq-time handling stable across the transition | pre-season (CI-1) | WP2 |
| S10 | Solar-farm onset (day-only repeats) | quarantined after ≥ 3 day-only repeat detections; no alert ever | pre-season (CI-1) | WP2 |
| S11 | Source retired mid-replay | E still accumulates from the remaining sources; lifecycle progresses | pre-season (CI-1) | WP2 |
| S12 | Re-detection within T_LINK after `officially_extinguished` | returns to `active`, dual-fact copy, escalation — never `new_fire` | pre-season (CI-1) | WP2 |
| S13 | Zone created over an active event | zero sends for pre-existing events; normal alerts afterwards | before the WP6 alert stack ships | WP6 (asserted against WP2's decision function while stubbed) |
| S14 | Alert decisions at 02:30 local, 25 Oct 2026 / 28 Mar 2027 | quiet-hours classification stable across both transitions; exactly one 09:00 digest | before the WP6 alert stack ships | WP6 |
| S15 | Cursor-only polling client + event removal | convergence after ≤ 1 full-snapshot cycle (fast-check) | before the WP3 read path ships | WP3 client suite |
| S16 | Fire straddling the polling-bbox edge | the bbox buffer absorbs it: one event, correct geometry | pre-season (CI-1) | WP2 |

Sources: S1–S9 ADR-002 acceptance; S10 11 §6.2/§9.4; S11–S16 14 §5. S11, S12 and S16
join the pre-season CI-1 set as soon as their WP2 code paths exist; S13–S15 are gated
by their owner suites, never by CI-1.

## 2. Data-science acceptance (fit-time gates)

Clustering parameter fit on the 2020–2025 FIRMS SP backfill labeled against EFFIS
burnt-area perimeters (ADR-002 D5, review 11 §4):

- pairwise **recall ≥ 0.95**; pairwise **precision ≥ 0.98** computed over **hard
  negatives only** — candidate pairs from different labeled fires lying within
  **20 km and 7 days** of each other; distant pairs are trivially separated and would
  inflate the number (11 §4.2);
- over-split ratio mean **≤ 1.15**, p95 **≤ 2**; chimera rate **≤ 3%**;
- timeline agreement ±12 h **≥ 90%**;
- selection by the **plateau rule** (center of the widest acceptable region, never
  argmax); season splits: fit 2020–23, calibrate 2024, test 2025 touch-once
  (11 §9.1 — ADR-002 D5's pointer to "11 §8" is a citation typo); re-tuned annually
  pre-season. **Per-source metrics are reported next to every pooled number**, for
  every split: the source mix is nonstationary (NOAA-21 from 2024, MTG FRP-PIXEL from
  2025), so a pooled score can hide a source-specific regression (11 §9.1);
- **eps_geo exemption:** GEO attach parameters can only be fitted on 2025 data (LSA
  SAF back-processing starts Jan 2025) — the touch-once test season. The exemption is
  recorded, not hidden: eps_geo is fitted on 2025, its metrics are reported separately
  from the test-season report, they carry no touch-once guarantee, and eps_geo is
  re-fitted on the first full post-2025 season. Every other parameter keeps the split
  rule intact (11 §4.3, §9.1).

**Metric population and stratification.** All fit-time metrics are computed over the
**EFFIS-labeled population only**: detections matching exactly one perimeter are
labeled, detections matching ≥ 2 perimeters are `ambiguous` (excluded from pairwise
metrics, kept for event counts), detections matching none are `unlabeled` and are
**never treated as negatives**. EFFIS rapid mapping is reliable only from ~30 ha, so
the small-fire tail is unmeasured by construction. Every metric is therefore reported
**stratified by size class** (10–50 ha / 50–500 ha / ≥ 500 ha) as well as pooled; a
pooled pass with a failing bottom stratum is a fail (11 §4.1).

Live lifecycle guardrail: **FER** (False Extinguish Rate — re-attach within 72 h after
`no_longer_detected`) **≤ 5%**, **≤ 10%** for large events — measured continuously.

Validation caveat (00-summary): EFFIS NRT perimeters partially derive from the same
MODIS/VIIRS detections — treat EFFIS BA as *semi*-independent; the news-log leg of
CER is the second, independent check.

## 3. Launch & season gates

| # | Gate | When | Source |
|---|---|---|---|
| L-1 | **Live shadow ≥ 2 weeks**: alert decisions written, nothing sent, nightly diff reviewed, every diff explained before promotion; staged enablement team → beta → all. | before the first real push | ADR-004 D9 |
| L-2 | **Load battery**: 5,000-connection SSE soak, reconnect storm, p95 broadcast ≤ 2 s, 200 req/s REST with p95 ≤ 300 ms. | before SSE ships (T1+T2 first) — owned at the **WP3→WP8 boundary**: WP3 builds the endpoints, WP8 runs and signs the battery | ADR-003, 06 §5.6 |
| L-3 | **50× load test** of the full read path. **1× baseline** = the busiest in-season hour actually measured in the preceding season, recorded as three numbers: concurrent map sessions, `/snapshot.json` requests/min at the edge, concurrent SSE connections. Until season 1 measures it, the planning baseline is 2,000 sessions / 4,000 req/min / 500 SSE. **Pass** at 50× (100,000 sessions / 200,000 req/min): edge hit ratio ≥ 95%, origin ≤ 5 req/s (cache-miss refills only), p95 snapshot fetch ≤ 300 ms at the edge, SSE clamped at the 5,000 cap with clean T0→T1 demotion and no 5xx to map clients, and killing the origin leaves T2 serving inside its object-age budget. | before the May 2027 launch | R1, 10 §8, 04 §5.2 |
| L-4 | **Kill-switch rehearsal** (one command stops all dispatch; outbox keeps accumulating). | before each season | ADR-004 D5, 06 §5.7 |
| L-5 | **Physical-device push test** (incl. iOS Home-Screen PWA) for any alert-path change during season. | season release regime | ADR-004 D9, 08 §5.4.4 |
| L-6 | **SES production-quota raise** filed and confirmed. | before June each year | ADR-004 D6 |
| L-7 | **Correctness metrics** hold: PCR ≥ 95% (≥50 ha) / ≥ 85% (≥10 ha), CER ≥ 80%, ZAP ≥ 85%, DAR ≤ 5% shadow → ≤ 1% steady, FLR flags reviewed, PLB ≤ 15 min p95 (controllable portion). | continuous once live; launch-blocking | ADR-004 D9, 06 §5.1 |
| L-8 | **Dispatch SLO**: decision→provider-ack p95 ≤ 60 s push / ≤ 5 min email; `fw_notification_queue_oldest_seconds` pages at 600 s. | continuous | ADR-004 D6 |
| L-9 | **Launch timing rule**: public launch pre-season (May), never during a mega-fire. | May 2027 | 10 §9.1 |
| L-10 | **Legal/security launch gate**: published privacy policy (Esri/AWS recipients disclosed), layered ЗЗП/LANCE disclaimers on map and alerts, DPIA (incl. the C-184/20 position), RoPA, **ЕООД formed before the first stored watch zone**, hardware-key 2FA on every admin and root-of-trust account. **Pass:** every artifact exists, is dated, and is lawyer-passed where 09 requires it. The ЕООД leg blocks WP7 storage, not merely launch. | ЕООД before the first stored zone (WP7); the rest before beta and before public launch | 05, 09; 13 §3.2(13) |
| L-11 | **Pre-season fire drill**, one full pass: restore the latest backup to scratch and record restore time; k6 battery (5k VUs on `/snapshot.json` + 1k SSE) with edge hit ratio ≥ 95% and T0→T1 demotion confirmed; chaos leg (kill worker mid-cycle, kill API) with paging and T2 fallback confirmed; quota and key checks (SES quota raised, FIRMS MAP_KEY, EUMETSAT credentials, Telegram token, VAPID backup present); a literal 3 AM wake-up test with a synthetic critical alert. **Pass:** all five legs executed and dated in the drill record; any red leg blocks season start. | every April/May, before each season | 04 App B |
| L-12 | **Season deploy regime** (≈ Jun 1 – Oct 15): no deploys Friday/weekend/evening except hotfixes; no alert-logic change outside the flag + shadow process; every deploy clears the **8-checkbox gate** — (1) golden replay green incl. the full pre-season set (§1.1), (2) no active severe event in the AOI, (3) expand-contract migration, (4) alert-logic diff none or flagged to old behavior, (5) rollback rehearsed (one command, < 5 min), (6) kill switches verified in staging, (7) 30-min post-deploy watch + manual canary, (8) one real push received on a physical device. **Pass:** the gate is enforced in CI/CD, not by memory — a deploy with an unchecked box fails. | active for each season | 06 §5.7, 04 §5.6 |
| L-13 | **Score calibration (v1)**: reliability diagram over score deciles on the touch-once test season, **ECE ≤ 0.07**; Platt recalibration fitted on the 2024 calibration season (isotonic not before v2); slice reliability for land cover, day-only vs any-night, and size terciles; bucket thresholds re-derived so **Confirmed ≥ 0.90** observed precision and **Likely ≥ 0.60**; production drift alarm when the Confirmed bucket's rolling 4-week corroboration rate < 0.85. **Pass:** all four hold on the test season and the fitted calibration is committed as versioned config-as-data. | before the v1 confidence score ships; re-checked pre-season | 11 §3.8–3.9 |
| L-14 | **2027-constellation replay**: re-run fit and acceptance on a detection stream restricted to the 2027 live constellation — NOAA-20/21 VIIRS + Sentinel-3 SLSTR, with MODIS (Terra/Aqua) and S-NPP rows dropped; GEO attach-only sources unchanged. **Pass:** the §2 thresholds hold on the reduced stream with per-source metrics reported; a miss forces a constellation-specific re-fit **before** the season opens, not after. | before the 2027 season, and after any constellation change | 11 §4.6; DATA-SOURCES A1/A2; 14 H1 |

## 4. Business checkpoints (10 §9.2)

Every checkpoint is decided on its date from **dated artifacts, not impressions**: a
criterion without its evidence artifact counts as missed.

### CP1 — 31 October 2026 (shadow pipeline)

Graded against the **CP1 evaluation protocol**: a one-page dated document written in
**September 2026** — before the season it grades — and not edited afterwards. The
protocol pins the metric definitions below, the synthetic-zone-grid config version,
the minimum-n rule, and the named news-log curator; its checklist also carries the
25–26 Oct 2026 shadow-diff review for time-window anomalies (the DST fallback night,
14 M6). The checkpoint record is a dated report artifact in `docs/reports/`, linked
from this section once it exists.

Both criteria are computable from **WP1 + WP2 outputs alone** — no alert stack (WP6)
and no user zones (WP7) exist in October 2026:

| Criterion | Definition | Threshold | Evidence artifact |
|---|---|---|---|
| **shadow-PCR** | Event-based, 06 §5.1.2's original definition: of EFFIS-confirmed perimeters **≥ 50 ha** intersecting the AOI in the 2026 season, the fraction for which (a) a FireEvent exists whose detections intersect the perimeter buffered 2 km with `started_at` ≤ perimeter end date, **and** (b) the side-effect-free alert-decision function returns an alert for the **synthetic grid zone** containing the perimeter centroid — default-sensitivity zones on a fixed 10 km lattice over the AOI, pinned as versioned config-as-data in place of subscribed zones. | **≥ 95%** (the ≥ 10 ha population reported at ≥ 85%: informative, non-gating) | per-perimeter table + grid config version, in the CP1 report |
| **shadow-PLB** | p95 of `available_at` → **event visible in the registry** (`event_updated_at`) — the ingest and clustering stages only. Decision, dispatch and provider-ack stages enter the metric at **L-7**, when they exist. | **≤ 15 min p95**, no stage red > 1 day | latency histogram from recorded stage timestamps |

**Minimum n.** Fewer than **20** qualifying (≥ 50 ha) perimeters in the 2026 season
makes the live number under-powered: the primary read becomes a 2024–25
backfill-replay under the same protocol, with the live-season figures reported
alongside it and both recorded.

**Consequence.** Any criterion missed — or the report absent on the date —
**pauses the business**: engineering may continue, no marketing, no spend beyond
infrastructure. A pass unblocks the CP2 track.

### CP2 — 30 April 2027 (beta + business legs)

One **delivery** criterion and **three business legs**. This resolves the
three-vs-four discrepancy: *beta live* is the delivery precondition and is never one
of the three business legs review 10 §9.2 counts.

| # | Criterion | Threshold | Evidence artifact |
|---|---|---|---|
| D | Beta live | public beta serving real users, L-1 shadow signed off | dated release tag + the L-1 shadow sign-off record |
| 1 | Signed partnership | ≥ 1 (WWF or Meteo Balkans) | countersigned agreement/MoU, dated |
| 2 | Funding application | ≥ 1 submitted | submission receipt / reference number |
| 3 | Alert-armed users | ≥ 500 | dated export of the alert-armed-weekly-users series |

**Consequences.**

- **3 of 3** → launch per L-9; paid-tier design may start.
- **2 of 3** → launch; paid-tier work limited to design and legal scaffolding, no build.
- **1 of 3** → launch; all paid-tier work frozen until CP3; the two missing legs get
  named target dates in the plan.
- **0 of 3** → launch anyway; all paid-tier work frozen until CP3.
- **Beta not live** → the May 2027 window is forfeited (launching without the L-1
  shadow is not an option); re-target the next pre-season window and apply the
  IMPLEMENTATION-PLAN cut list.

### CP3 — 31 October 2027 (M12)

Four equally weighted criteria.

| # | Criterion | Threshold | Evidence artifact |
|---|---|---|---|
| 1 | Alert-armed weekly users, in season | ≥ 2,000 | north-star dashboard export, weekly series |
| 2 | Media embeds | ≥ 3 | embed registry: URL, outlet, first-seen date |
| 3 | B2B pilots / LOIs | ≥ 2 | signed LOIs or pilot contracts |
| 4 | Funding result | ≥ 1 won or pending decision | decision letter / portal status export |

**Consequences.**

- **≥ 3 of 4** → build v1 paid tiers.
- **exactly 2 of 4** → **hold**: no paid-tier build, continue civic operation at the
  current cost base for one more season, re-run this checkpoint on the same criteria
  at the end of the 2028 season.
- **≤ 1 of 4** → convert to a donation-funded civic project or sunset gracefully,
  data archived and published.
- **Rider, regardless of count:** no paid tier is built without ≥ 1 B2B pilot LOI
  **and** ≥ 1 submitted non-consortium funding application (10 C3) — the count alone
  can be met by criteria that establish no willingness to pay.

The critical dependency behind CP1: it can only be evaluated against **real fires**,
and the 2026 season ends around October — which is why shadow ingestion (WP1) is the
single highest implementation priority in
[`IMPLEMENTATION-PLAN.md`](IMPLEMENTATION-PLAN.md).
