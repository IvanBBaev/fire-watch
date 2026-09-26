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
| CI-6 | Replay silence | An offline replay (reprocessing/backfill) may decide `seed` and `suppress` — neither writes an outbox row — but any `send` or `defer` fails the run: `defer` is not silence, it parks a row for the 09:00 digest. Revival requires `--allow-revive` (I4). | ADR-002 D7/I4 |
| CI-7 | Polling-only e2e | The full e2e suite passes with SSE disabled — every feature must be T1-complete. | ADR-003 D1 |
| CI-8 | Reconciler properties | fast-check: convergence under any snapshot/delta interleaving, no `seq` regression, no zombie events, delta idempotence, no flicker-delete. | ADR-003 D3 |
| CI-9 | Dependency boundaries | dependency-cruiser: `core` imports no framework/map libs; `map` never imports `preact`; provider adapters importable **only** by the notification gateway. | ADR-005 D1, ADR-004 D2 |
| CI-10 | Never-send template lint | Rendered alert/UI templates checked against the banned vocabulary and quote-only rules (GLOSSARY §4–§5). A tripping template fails CI, not runtime. | ADR-004 D7 |
| CI-11 | Wording-ladder lint | Lifecycle copy matches the exact GLOSSARY §3 strings (parameterized). **The set of checked paths is not a list anyone maintains:** `web/src/core/i18n/catalog-governance.ts` classifies *every* catalog path as `frozen` (transcribes a glossary row — section + template id), `mandated-claim` (§2) or `own-voice` (with a reason from a closed union), as `as const satisfies Record<CatalogPath, Governance>`, where `CatalogPath` is derived from `Messages`. A new message is a missing-property error and a deleted one an excess-property error, both on the same literal; `classifyCatalog` throws at runtime for anything that slips past the types. The glossary assertions are keyed by `GlossaryGovernedPath`, read back off that record, so freezing a path without asserting it — or asserting one nobody froze — does not compile. `glossary-sync.test.ts` also sweeps the other direction, walking the glossary rows of the sections the classification names and comparing the **unclaimed** set against an exact record (`UNCLAIMED_ROWS`), because totality over the catalog's paths says nothing about a glossary row the catalog never implemented. Two §5.2 rows are in that state today and are recorded there, not waived. | ADR-004 D7, 12 §4.3 |
| CI-12 | Bundle budgets | Spec: entry ≤ 85, map chunk ≤ 290, critical path ≤ 350, CSS ≤ 20 KB gz; UI fonts = system stack; map-ready ≤ 6 s on 4G / ≤ 15 s on 3G (08 §5.5). **Enforced — the byte half:** `pnpm run test:budgets` (CI: the `e2e` job, before the browser suites) builds the web app and weighs `web/dist` at gzip -9, 1 KB = 1024 B (`web/budgets/`). Every category is derived from the build's own manifest (`build.manifest`), not from file names: **entry** = the HTML entry chunk + its static imports + the heaviest locale catalog (08 §5.5.1 puts the active locale in the entry; boot awaits it before first render); **map** = the lazy map root's static closure minus what the entry already fetched; **critical path** = entry ∪ map, JavaScript only (08 §1.5); **CSS** = every emitted stylesheet. The one hand-written input is `LAZY_ROLES` (which dynamic-import root is the map and which are catalogs), and it fails closed: a lazy chunk no rule claims, a second entry point, a chunk reachable from nothing, a file in `dist` that neither the manifest nor `web/public` explains, or an `index.html` reference outside the entry is red. **Fonts:** any webfont file (`woff`/`woff2`/`ttf`/`otf`/`eot`) in `dist`, any `@font-face`, or any `@import` the build did not inline is red. Overages are recorded, never absorbed: `KNOWN_OVER_BUDGET` in `ci-12.budget.ts` is compared exactly, so a new overage and a silent fix both fail; since 2026-09-25 it holds `map` and `criticalPath`: shipping MapLibre's worker (charged to the chunk that names it) put the map path at 372,186 B and the critical path at 413,502 B, over 290 / 350 KiB, pending a founder decision (entry 41,316 B, CSS 2,316 B are within). Not part of `pnpm run verify`, which never builds; the classifier's unit tests are. **Timing half (F8) — built, not yet a CI step.** `pnpm run test:timing` builds `web/dist` and runs vitest project `timing` (`web/e2e/map-ready.timing.ts`). Metric: the `fw:map-ready` performance mark (first MapLibre `idle` after a non-empty snapshot is on the fire source; basemap tiles in + fire layer painted, 08 §5.5.2), read as `startTime` from navigation start, cold context per run. Profiles: DevTools "Fast 4G" (budget 6 000 ms) and "Fast 3G" (budget 15 000 ms), reference device 412×823 @1.75 DPR mobile with the CPU throttle calibrated per run to 4× an idle fast host. Verdict: median of 5 representative runs ≤ budget per profile; fewer than 5 representative runs in 12 attempts fails as inconclusive; a map that reports `fw:map-unavailable` or never marks ready within 4× the budget fails at once with failed requests and console/page errors. The basemap is a local stand-in (raster tiles padded to 24 KiB) until G1. All thresholds are data in `web/e2e/timing/map-ready-budget.ts`. 2026-09-25: green locally (4G median 3129 ms, 3G 11698 ms). Lighthouse CI itself is not used: the byte budgets are measured without a browser or a server, which is what makes them deterministic. | ADR-005 D3 |
| CI-13 | Attribution presence | Spec: the credits registry (`packages/contracts/src/credits.ts`) is rendered in the map control, `/credits`, and alert footers — a styling refactor cannot drop a licence obligation. [GATE-MVP] **Enforced (unit, inside `pnpm run test`):** the registry says which package produces each surface (`CREDIT_SURFACE_OWNER`, `as const satisfies Record<CreditSurface, …>`), and each package's gate types its probe table as `satisfies Record<CreditSurfacesOf<'web' | 'server'>, …>` and its context table as `satisfies Record<CreditCondition, …>` — a new surface or condition does not compile until it is probed or given a reason. For every surface × reachable context (× locale on the web) the real output is produced and `attributionGaps` asks the registry what it owes: every credit that is required, verified and not plugin-injected must appear with its asserted wording (`verbatim ?? text`) and, where it has one, its licence link. `web/src/ui/attribution-presence.test.tsx`: `/credits` and About are server-rendered (preact-iso `prerender`) inside the real `AppContext`; the map corner is the `customAttribution` of the control `createMapController` actually adds, fed by `mapCornerAttribution` (the map pane's call), with `maplibre-gl` recorded. Contexts are reached through configuration (`activeCreditConditions`) — `always`, `basemap:openfreemap` (the shipped default), `basemap:protomaps`; the layer/imagery/ECMWF/Esri conditions are declared unreachable and the test fails once a configuration reaches one. `server/src/app/attribution-presence.test.ts`: `api` is the `attribution` member of `GET /snapshot.json`, full and cursor, through the whole HTTP server; `alert-footer` is declared absent (no production `AlertRenderer` until H6), so everything it owes is a finding. Gaps are an exact register (`KNOWN_FINDINGS`, `toStrictEqual`) — a new gap and a silently closed one both fail. Recorded 2026-09-23, not waived: the map corner lacks the Copernicus service credit's wording (3 contexts), the OSM licence link (3) and the OpenFreeMap credit (1); the alert footer lacks both LANCE clauses. **Not enforced:** visibility (the corner control is `compact`; CSS is not read), credits the external basemap style or the Esri plugin inject at runtime, conditional credits no shipped configuration reaches yet, and the stream frames, `/api/v1/client-config` and health routes (no `attribution` member; not the registry's `api` surface). | ADR-001 A1.4, ADR-003 A1.3 |
| CI-14 | Fire-owns-red + CVD | Style lint: red/orange reserved exclusively for fire layers; color-vision-deficiency checks. Runs as `web/src/map/fire-owns-red.test.ts` inside `pnpm run test`. **The colour sources are walked, not listed:** every `.css` file under `web/` (a CSS file imported from source but not walked fails the gate), every quoted hex / colour-function literal in `.ts`/`.tsx`/`.js`/`.html`, every JSON file that parses as a style (version 8 + `layers`), and the layers and pattern images `applyFireLayers` actually registers (captured through fake hosts, so data-driven outputs of `match`/`case`/`interpolate`/`step`/`coalesce` are all read). An unparseable colour anywhere throws with file and line. **Hue rule (06 §5.4, literally):** OKLCH hue in [20°, 55°] ∪ [350°, 360°] with chroma > 0.09 is fire-owned; a layer owns it only if its id starts with `fire-`/`alert-`, a CSS declaration only if it is a `--fire-*`/`--color-fire-*` custom property (reading `var(--fire-*)` elsewhere is a violation); a source literal is judged through the layer that paints it, otherwise as UI chrome. The [0°, 20°) gap in the spec's bands is pinned by a test, not closed. **CVD rule (06 §5.4, 07 §5.8.1):** Machado 2009 (severity 1.0) protanopia / deuteranopia / tritanopia over every lifecycle state × score bucket; any two classes painted in different colours by a data-driven colour or pattern property need simulated ΔE00 ≥ 15 or a size channel (radius / width / icon size) differing by ≥ 1.2×. Current violations are an exact register (`KNOWN_FINDINGS`, `toStrictEqual`) — a new violation and a silently fixed one both fail; 11 are recorded (the unprefixed `detection-dot` layer's orange, and the red/orange and gray/gray-blue class pairs across four fire layers), not waived. The external basemap style is not linted until it is vendored (WP5). | 06 §5.4, ADR-005 D4 |
| CI-15 | Config-as-data versioning | Clustering/gating parameter changes are PRs to versioned config objects; the version is recorded on every event and alert row. | ADR-002 D5, 06 §5.7 |
| CI-18 | Layout accessibility floors | `web/e2e/a11y.e2e.ts` measures WP4's three layout criteria in a real browser on every in-scope surface, at four viewports — 320 × 512 (WCAG 1.4.10, Bulgarian), 360 × 640 (06 §5.4's budget Android, English), 360 × 640 at a 32 px root font (WCAG 1.4.4 at 200 %, Bulgarian) and 1280 × 800 (the two-column layout above `@media (min-width: 48rem)`, where the panel is a column beside the map rather than a sheet over it — a different layout, and the one the rest of the e2e suite runs in). **Pass:** no horizontal document scrolling and no interactive control outside the viewport; every in-scope target ≥ 44 × 44 CSS px **and** not covered at its centre by another element; no body text below 16 px (32 px on the 200 % leg); no text box clipping its own content. Every number is read back from the rendered layout, never from the stylesheet. `.map-pane` is exempt (§1.2 scope, 19 App. A). The same file asserts that the list view is reached by **Tab alone** with a visible focus ring in a browser with no WebGL — the keyboard half of what CI-7 already proves with a pointer. | WP4; 19 §5.8.1, App. A/B; TASKS F7 |

**Numbering.** CI-18 follows CI-15 because CI-16 and CI-17 are claimed by open
proposals that have not landed — CI-16 by both canvas/DOM parity (19 §5.4.3) and
override-expiry (21 E4), CI-17 by doc-pinned numbers (22 E6), all three "open, no
deadline" in 00-summary §11. A shipped gate does not take a number a proposal is
still holding, and it does not resolve that collision by picking one.

**CI-7 reads the list through the map frame.** CI-7 derives the rows it expects from the
age window alone (`web/e2e/polling-only.e2e.ts:220`), but the product scopes the list to
the map's published frame as soon as one exists
(`web/src/ui/event-list.tsx:88`, `:99-101`). In the e2e browser the basemap host is
blocked, so `load` never fires and no frame is ever published — unless the map pane
changes size after the map is constructed, which makes MapLibre's own resize tracking fire
`moveend` and publish the default camera's frame (`web/src/map/map-controller.ts:347`).
Two fixture events sit west of that frame, so the list drops them and CI-7 reads the drop
as a polling failure. F7 hit exactly that while changing the shell's height rule, and
fixed it in the layout (`web/src/styles.css`, the `height: 100%` clamp inside
`@media (min-width: 48rem)`). The gate still models only the age window: a later change
that resizes the map pane after boot will fail CI-7 for a reason that is not polling.
Registered here rather than fixed — the fix belongs to CI-7's model, not to a stylesheet.

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
| S13 | Zone created over an active event | zero pushes for pre-existing events at zone creation; the seeded fires return in the next 09:00 digest, not before it; normal alerts afterwards | suite (WP6) — implemented; runs and is diffed on every replay invocation | WP6 (asserted against the real `decideAlert` through the `alert` replay engine) |
| S14 | Alert decisions at 03:30 local, 25 Oct 2026 / 28 Mar 2027 | quiet-hours classification is taken from the instant through the tz database on both transitions — the repeated 03:30 is inside them on both passes and the skipped hour needs no special case — and the deferrals a window collects fold into one digest per account under that window start, across a 25-hour window and a 23-hour one | suite (WP6) — implemented; runs and is diffed on every replay invocation | WP6 (asserted against the real `decideAlert` and `produceDigest` through the `alert` replay engine) |
| S15 | Cursor-only polling client + event removal | convergence after ≤ 1 full-snapshot cycle (fast-check) | before the WP3 read path ships | WP3 client suite — proven elsewhere, not by a fixture: `register.ts` `provenBy` → `web/src/core/feed/cursor-client.property.test.ts` (+ server `snapshot-route.s15.property.test.ts`); `replay-cli --gate` fails if that file is missing |
| S16 | Fire straddling the polling-bbox edge | the bbox buffer absorbs it: one event, correct geometry | pre-season (CI-1) | WP2 |

Sources: S1–S9 ADR-002 acceptance; S10 11 §6.2/§9.4; S11–S16 14 §5. S14 says 03:30 and
not 02:30 because the ambiguous hour is Bulgaria's, not Central Europe's: `Europe/Sofia`
folds 04:00 EEST → 03:00 EET on 25 Oct 2026 and springs 03:00 EET → 04:00 EEST on
28 Mar 2027, so 03:30 is the local reading that happens twice and then not at all,
while 02:30 is unambiguous on both dates. S11, S12 and S16
join the pre-season CI-1 set as soon as their WP2 code paths exist; S13–S15 are gated
by their owner suites, never by CI-1 — a statement about which fixtures a stage
*demands*, not about which ones run: the replay CLI runs every fixture present on every
invocation, so S13 is already diffed inside CI-1's `--gate=pre-merge` double run. S14 is
implemented: `server/src/core/alerts/digest.ts` (`produceDigest`, configured by
`digest-params.ts`'s `digest_params_v1`) now folds the deferrals `decideAlert` produces into
one digest per account per window, wired into the `alert` replay engine as a second pass that
runs once per account per poll, after every event has been decided. The fixture pins two
things nothing else in the register does: the `2026-10-25T04:00:00Z` and
`2027-03-28T04:00:00Z` polls are trap instants no fixed UTC offset can classify correctly
together — a hard-coded +03 would read the first as 07:00 local and send, a hard-coded +02
would read the second as 06:00 local and defer, and the real answer is the opposite in both
cases — and its four digests land 25 hours apart across the fall-back day and 23 hours apart
across the spring-forward one, so a producer computing `windowStart + 24 h` gets both
subkeys wrong, in opposite directions.

### 1.2 Manual accessibility protocol

CI-18 automates the three layout floors, but only as a desktop headless browser can
state them. Three legs of WP4's accessibility commitment cannot be asserted there
without the assertion being a lie; they are run by hand, dated, and their findings are
what L-16 reads. Each run records device, OS version and build under test.

**Scope, shared with CI-18.** Everything inside `.map-pane` is exempt-with-alternative
(19 App. A): the WebGL canvas and MapLibre's own attribution chrome are third-party DOM
this repository does not author, and their obligation is information parity with the DOM
twin, not a 44 px hit box. Every control this repository renders sits outside `.map-pane`
and is in scope.

**M-1 — Android OS font scale and display size.** *Why not automated:* Chrome exposes no
OS-font-scale emulation. What CI-18's third leg injects is a root `font-size`, which is
exactly a changed **browser** default font size (WCAG 1.4.4) and nothing more. An Android
OEM skin scales past 200 % **and** changes display density, which re-runs the whole layout
in different CSS pixels; and `@media (min-width: 48rem)` resolves `rem` against the initial
font size under the injected form but against the reader's setting under the real one.
Review 19 §5.8.1 states it plainly: OS font scale is not browser zoom. *Protocol:* on a
budget Android handset (06 §5.4), set Display → Font size and Display size to maximum, then
visit `/`, an event page, `/settings`, `/about`, `/credits`; open the bottom sheet; press
"My location"; and force the degradation banner (airplane mode until it appears). **Pass:**
no horizontal scrolling on any surface, no clipped or truncated text, both map controls
fully on screen and activatable where they appear, the freshness line readable in full.
Record one screenshot per surface.

**M-2 — Assistive-technology pass** (19 App. B step 8). *Why not automated:* an
accessibility-tree snapshot is not speech. What a screen reader actually says, in what
order, and how often it repeats itself is a property of the AT, not of the DOM, and the
three engines disagree. *Protocol:* TalkBack (Android), VoiceOver (iOS), NVDA + Firefox
(Windows). **Pass:** the list is announced as a list with a count; each row announces the
fact before the time; the freshness chip's change is announced once, politely, not on every
poll; the degradation banner is announced when it appears; the map announces its label and
its facts are reachable from the DOM twin without it.

**M-3 — Full keyboard order.** *Why only half automated:* CI-18 asserts a **bound** — the
first list row is reached within 20 Tab stops, and it prints the walk when it is not. That
is a number. Whether the order *agrees with the visual order*, whether a stop is a trap,
and whether the focus ring stays visible rather than sliding under the sticky sheet handle
(WCAG 2.4.11) are judgements about a rendered page that no assertion in this suite can
make honestly. *Protocol:* keyboard only, on every surface: Tab to the end and back with
Shift+Tab; Escape dismisses the first-launch dialog; every stop shows a focus ring; no stop
is reached that cannot be left. **Pass:** all four hold. *Known at the time of writing:* the
first list row is stop 15 in a browser with no WebGL, two of which are MapLibre's canvas and
its attribution `<summary>` inside the exempt pane. A skip link would shorten that walk but
needs new user-facing copy in both locales, which is a GLOSSARY change and a founder call.

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

**Inputs by register id.** The fit cites DS-1 (detections), DS-3 (labels) and DS-4
(eps_geo only) from `docs/data/DATASETS.md`; a fit report names the entry, never "the
backfill", and a new entry is the refit trigger (23 E1).

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
| L-12 | **Season deploy regime** (≈ Jun 1 – Oct 15): no deploys Friday/weekend/evening except hotfixes; no alert-logic change outside the flag + shadow process; every deploy clears the **8-checkbox gate** — (1) golden replay green incl. the full pre-season set (§1.1), (2) no active severe event in the AOI, (3) expand-contract migration, (4) alert-logic diff none or flagged to old behavior, (5) rollback rehearsed (one command, < 5 min), (6) kill switches verified in staging, (7) 30-min post-deploy watch + manual canary, (8) one real push received on a physical device. **Pass:** the gate is enforced in CI/CD, not by memory — a deploy with an unchecked box fails. **Enforced (J4):** `.github/workflows/deploy.yml` runs ci.yml, then the `deploy-gate` job (`infra/deploy-gate`, `pnpm run deploy-gate`): box (1) is decided from the `--gate=pre-season` replay, where a blocked scenario counts as not green; boxes (2)–(8) and the OPERATIONS §9.3 rule 4 freeze boxes are dispatch attestations, and an unticked box fails. Open: the evening hours are **unarmed** (no spec value), the season bounds are taken as Jun 1 – Oct 15 inclusive in Europe/Sofia, and the deploy job is a stub until a host exists (E2). | active for each season | 06 §5.7, 04 §5.6 |
| L-13 | **Score calibration (v1)**: reliability diagram over score deciles on the touch-once test season, **ECE ≤ 0.07**; Platt recalibration fitted on the 2024 calibration season (isotonic not before v2); slice reliability for land cover, day-only vs any-night, and size terciles; bucket thresholds re-derived so **Confirmed ≥ 0.90** observed precision and **Likely ≥ 0.60**; production drift alarm when the Confirmed bucket's rolling 4-week corroboration rate < 0.85. **Pass:** all four hold on the test season and the fitted calibration is committed as versioned config-as-data. | before the v1 confidence score ships; re-checked pre-season | 11 §3.8–3.9 |
| L-14 | **2027-constellation replay**: re-run fit and acceptance on a detection stream restricted to the 2027 live constellation — NOAA-20/21 VIIRS + Sentinel-3 SLSTR, with MODIS (Terra/Aqua) and S-NPP rows dropped; GEO attach-only sources unchanged. **Pass:** the §2 thresholds hold on the reduced stream with per-source metrics reported; a miss forces a constellation-specific re-fit **before** the season opens, not after. | before the 2027 season, and after any constellation change | 11 §4.6; DATA-SOURCES A1/A2; 14 H1 |
| L-15 | **Editorial standard published and the correction path rehearsed**: the four-tier source ladder, the two-source rule with its three named exceptions, the never-publishable list and the attribution rules are written down and public; the WP6 admin form enforces the required-field set (tier, source URL, capture, curator, second source, justification) and refuses to save a T4 source or a statement without a capture; the `curated_correction` state exists and one correction has been rehearsed end to end on staging. **Pass:** all four hold; the news-log curator is named and is not the sole reviewer of the public curated voice. | before the first curated statement ships | 16 §5.2–§5.5, §5.10 |
| L-16 | **Accessibility target declared and verified**: a named conformance target (WCAG 2.2 AA) with a published scope statement in three classes — in scope, exempt-with-alternative, out of scope. **Pass:** WP4's three layout criteria pass (CI-18 asserts them per PR; the OS-font-scale, assistive-technology and keyboard-order legs it cannot assert are §1.2's M-1 to M-3, dated); canvas/DOM information parity is asserted in CI; axe-core reports zero serious/critical on in-scope DOM surfaces; the seasonal manual assistive-technology pass has been executed and dated with findings triaged; the accessibility statement is published with the legal position stated; and the alert-path items (push title carries the fact, real plain-text email alternative, coalesced polite announcements, a non-drag path to arming) are implemented. Any red item blocks season start. | before the public beta serves real users; re-run pre-season | 19 §5.2–§5.4, §5.9; 09 §4.3 |
| L-17 | **One deploy path, restore-proven**: `deploy.yml` is the only route to the host and `last_good` is written by it; a restore drill from the R2 nightly to a scratch VM has passed at least once with the RTO recorded in OPERATIONS §5; the L-12 (6) and L-15 "staging" wording is replaced by the rehearsal profile (21 E8, pending the 06 author). **Pass:** the second deploy and the first restore drill are both recorded in WORKLOG with dates, before the poller is left unattended. | before the poller runs unattended (Sep 2026) | 21 §5.2, §5.5, §5.6 |

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
