# Review 31 — Frontend, UX & accessibility (as built)

*Reviewer role: Senior frontend architect, product UX designer and accessibility lead (one seat, three lenses). Date: 2026-10-30. Status: complete.*

*Inputs reviewed: `web/` at main `ccd541a` (2026-10-29): `web/src/**` (boot, `ui/`, `map/`, `core/feed/`, `core/i18n/`), `web/budgets/`, `web/e2e/a11y.e2e.ts`, `web/e2e/map-ready.timing.ts`, `web/index.html`, `web/dist/` (stale build of 2026-10-24); `docs/decisions/005-frontend-stack.md`; `docs/accessibility/README.md`; `GATES.md` (CI-7, CI-11..CI-14, CI-18, L-16); `TASKS.md`; `docs/V3-WORKPLAN.md`; prior reviews 07 (product UX), 08 (frontend), 16 (editorial, UX parts), 19 (accessibility & inclusion). Nothing was built or run for this review (no `pnpm verify`, builds or e2e, per the brief).*

---

## 1. Summary verdict

**CONDITIONAL GO for a May 2027 public launch of the web app.** The frontend is the most disciplined part of the product: the framework-free core, byte budgets enforced in CI, a never-say-out vocabulary that holds across the en catalog, and layout and contrast gates that most commercial maps never get. What blocks an unconditional GO is not code quality. It is honesty and reach at the edges: a replay that can show the past with no visible marker, a first render that waits on an untimed fetch, no offline shell or push even though review 08 put both at MVP, and a copy catalog that is 83% unreviewed by the only person who can sign it off.

1. **The honest clock leaks in playback (High).** `playbackActive` (`web/src/ui/playback.ts:69`) stays true after the panel is closed. No control, badge or banner then says "this is the past", and fire outlines, which are "as of now", are drawn over replayed dots (`web/src/ui/map-pane.tsx:96-114`). Review 07's core rule ("the honest clock is the product") is broken on the one surface built to show other times.
2. **First paint waits on an untimed fetch (High).** `boot.ts:59-80` awaits `fetchClientConfig` with no timeout or AbortSignal (`core/feed/client-config.ts:78-92`). A hanging origin, which is exactly the case T2 static failover exists for, gives a blank page instead of a map that fails open.
3. **No PWA, offline shell, manifest or web push (High).** `index.html` has no manifest, theme-color, icons or noscript, and `web/src` has no `serviceWorker` or `PushManager`. Review 08 E-4 and ADR-005 Decision 4 treat the PWA cache tiers and the iOS Home-Screen push flow as baseline. No TASKS row owns them; V3-C3 is blocked on a PWA nobody has scheduled (`docs/V3-WORKPLAN.md:72`).
4. **Copy sign-off is the launch bottleneck (High).** 416 of about 503 catalog paths sit in `PENDING_FOUNDER_REVIEW` (`web/src/core/i18n/catalog-governance.ts:925-1353`). About 334 of them are public-facing, and the privacy text in BG is marked "IMPLEMENTER DRAFT" (`bg.ts:467`). At 1–2 minutes a key plus BG proofreading, this is 15–25 founder-hours that no automated gate can replace.
5. **The CVD and state-colour problems are recorded, not resolved (Medium).** CI-14 lists 13 known findings (`web/src/map/fire-owns-red.test.ts:267-297`). Confirmed `#d7301f` and likely `#f16913` collapse for deuteranopia (ΔE 11.3) and tritanopia (10.0), and only the dot radius separates "unverified". "No longer detected" `#8b9198` and the attributed official status `#7d93ab` are about ΔE 7.5 apart even for normal vision.
6. **Feature density has outrun review 07's MVP (Medium).** There are five text buttons over the map, a Layers panel with six overlays, a day picker, two static-source options, credits, satellite passes and MeteoAlarm, and a filter bar with five controls. The "danger around me" question (FWI, MeteoAlarm) sits off by default inside that panel, and list rows show no size or distance.
7. **Accessibility automation is strong but has blind spots (Medium).** The CI-18/axe sweep never opens the Layers or Playback panels, which are the two densest surfaces. The WCAG target (2.1 vs 2.2) is undecided (L-16 is blocked-owner), there is no skip link and no `<h1>`, and canvas/DOM parity is untested.
8. **Bytes are close to budget and the timing gate is optimistic (Medium).** criticalPath is 360,767 B against 358,400 B (0.66% over, listed in `KNOWN_OVER_BUDGET`). Map-ready 6 s / 15 s is measured on a 24 KiB raster stand-in, not the real vector tiles and glyphs, and not on a real mid-range Android.

**Conditions for GO:** R-1, R-2 and R-4 closed (E-1, E-2, E-7); R-3 either built at its minimal shell (E-9) or explicitly deferred by the founder with a launch-copy line saying so; WCAG target decided and the Layers and Playback panels inside the axe sweep (E-4, Q1); criticalPath back under budget (E-3).

## 2. Strengths (sound as built)

- **The architecture held.** ADR-005's framework-free `core/` and `map/` are enforced by dependency-cruiser. The map subscribes to the store directly, not through Preact renders. Swapping the UI framework would still touch only `ui/`. Nothing in two years of feature waves eroded that.
- **Budgets are real gates, not aspirations.** `web/budgets/bundle-budgets.ts:48-53` enforces 85/290/350/20 KiB gzip-9. The single exception is named, sized and has three written candidate fixes in `ci-12.budget.ts`. The MapLibre worker split (`maplibreSharedModule`) brought the map chunk from over budget to 137.5 KB.
- **Lazy loading is used with judgement.** About 18 lazy chunks: the replay scrubber, measure, before/after, staff curation, sign-in and every event section (V3-P2 registry via `import.meta.glob`). The 620 KB land-cover and 608 KB Natura JSON load only on demand.
- **The vocabulary rule holds on the hard surfaces.** In `en.ts`, "officially contained/extinguished" appears only as an attributed statement and is followed by "does not mean the fire is out" (lines 58, 70, 74, 80). Outlines say "Not an official perimeter or a forecast"; before/after names cloud and smoke and says "Not a burned-area map"; playback says it "does not predict". Review 07's never-send rule is met in copy.
- **Catalog governance is unusual and good.** Every path has a posture (18 frozen, 4 mandated-claim, 481 own-voice), the never-send lint runs over the catalogs, and CI-11 checks the glossary against code. A founder can see precisely which strings they have not approved.
- **Layout and keyboard gates exist.** CI-18 checks four legs (320 BG, 360 EN, 360 BG at 200% text, 1280 BG) over a route table that is data, plus a keyboard walk that reaches the first event row at stop 16 of an allowed 20. CI-14 enforces fire-owns-red and records CVD distances. Review 19 asked for this; it is built.
- **Locate is on demand.** `ui/map-controls.tsx:38-57` asks for position only after a press and answers every outcome (moved, outside coverage, denied, unavailable) in a live region that always exists.
- **Bulgarian is fluent where sampled.** "Възпроизвеждане", "Приблизителни очертания", "Към текущото" read as native copy, not translation. CI-18 runs the narrow legs in BG, which is the longer language.

## 3. Risks & gaps (severity-ranked)

| # | Severity | Risk | Where |
|---|---|---|---|
| R-1 | High | Replay stays active with the panel closed. No toggle state (`aria-pressed`), badge or banner shows it; the live banner and list keep saying "now"; current outlines are drawn over past dots. Opening Layers closes the playback panel without stopping playback. | `web/src/ui/playback.ts:69`; `ui/playback-panel.tsx` (PlaybackToggle); `ui/map-pane.tsx:96-114`; `ui/layers-panel.tsx:62-80` |
| R-2 | High | First render awaits client config with no timeout. A slow or hanging origin gives a blank page, which contradicts "map fails open" and the T2 failover. No e2e covers a hanging config. | `web/src/boot.ts:59-80`; `core/feed/client-config.ts:78-92` |
| R-3 | High | No service worker, web manifest, icons, theme-color or noscript; no offline shell; no web push. Review 08 E-4 and ADR-005 D4 treat them as baseline. No TASKS row; V3-C3 depends on it. | `web/index.html`; `web/src` (no `serviceWorker`/`PushManager`); `docs/V3-WORKPLAN.md:72` |
| R-4 | High | 416 of ~503 copy paths (~334 public) await founder review, including legal-adjacent privacy text in BG marked as an implementer draft. | `web/src/core/i18n/catalog-governance.ts:925-1353`; `bg.ts:467` |
| R-5 | Medium | CVD: confirmed and likely collapse for deuteranopia and tritanopia across five layers; "no longer detected" and official status grey are nearly identical; FWI legend uses colours from the reserved fire band; the detection dot is red-orange without the `fire-` prefix. | `web/src/map/fire-owns-red.test.ts:267-297` (13 KNOWN_FINDINGS) |
| R-6 | Medium | criticalPath 360,767 B against 358,400 B; the Layers panel is eagerly imported and on the critical path. | `web/budgets/ci-12.budget.ts` (`KNOWN_OVER_BUDGET`); `ui/map-controls.tsx:23` |
| R-7 | Medium | The timing gate uses a raster stand-in (24 KiB PNG tiles). Vector parse, glyph PBFs and real 3G latency are not measured; no real-device run exists. `web/dist` is from 2026-10-24, so current sizes are unverified. | `web/e2e/map-ready.timing.ts`; `web/e2e/timing/map-ready-budget.ts`; `web/dist/` |
| R-8 | Medium | The axe/CI-18 sweep opens the measure panel and before/after, never Layers or Playback. | `web/e2e/a11y.e2e.ts` |
| R-9 | Medium | Event sections render all-or-nothing: one failed lazy import drops every section, including detections and "where". "Where" (near me) is last of nine. | `web/src/ui/event/event-details.tsx:75-106`; `ui/event/sections/900-where.section.tsx` |
| R-10 | Medium | The "danger around me" question is buried: FWI and MeteoAlarm sit in the Layers panel, off by default; list rows show place, badge and time but no size or distance. | `web/src/ui/layers.ts` (`chosenOverlays` defaults to `[]`); `ui/layers-panel.tsx:255-339`; `ui/event-list.tsx:38-58` |
| R-11 | Medium | Feature density on a 360 px phone: five map buttons, a dense panel, a five-control filter bar; the bottom sheet takes 70% of the height. No launch-default or feature-flag plan. | `ui/map-controls.tsx:60-98`; `styles.css:300-330`, `762-785` |
| R-12 | Low | No skip link (the catalog itself says the first row is about 15 steps away, `en.ts:584`); no `<h1>` on home (axe advisory `page-has-heading-one`). | `docs/accessibility/README.md`; `web/src/ui/pages/home.tsx` |
| R-13 | Low | `prefers-reduced-motion` removes all animation, so the "new detection" pulse, which carries information, disappears with no static substitute (review 19 R-9, still open). | `web/src/styles.css:163` |
| R-14 | Low | WCAG 2.1 vs 2.2 undecided; manual AT pass M-1..M-3 not run (records/ holds only the template); canvas/DOM parity gate (proposed CI-16) not built and its number collides. | `TASKS.md:115`, `:208`; `docs/accessibility/README.md`; `GATES.md:211` |
| R-15 | Low | Code health: 63 module-level signals across 16 files act as global singletons; catalog files near 900 lines each and governance at 1,444 lines; `map-controller.ts` at 798 lines. Workable now, costly at the next 10 features. | `web/src/**` (wc counts in Appendix B) |

## 4. Detailed recommendations

**E-1 [MVP] Make an active replay impossible to miss (R-1).** While `playbackActive` is true: give PlaybackToggle `aria-pressed="true"` and a visible "Replaying <time>" state; show a persistent strip over the map with "Back to live" that stays when the panel closes; suppress or visibly time-stamp fire outlines (simplest: hide them, as swaths and lightning already are); mark the list and banner as "past". Add a unit test on `map-pane` and one e2e step: start replay, close panel, assert the strip. Owner: frontend agent. Effort: 3 Opus 5.5 h.

**E-2 [MVP] Bound the client-config wait (R-2).** Add a 1.5 s AbortSignal timeout; on timeout or error, render with the built-in defaults already used when the fetch fails, and log once. Add an e2e that stalls `/api/v1/client-config` and asserts the map renders. Owner: frontend agent. Effort: 1 h.

**E-3 [MVP] Clear criticalPath (R-6).** Split LayersPanel into an eager toggle and a lazy body (the panel is closed on first paint), and move CREDITS provenance fields out of the entry, as `ci-12.budget.ts` already proposes. Remove `criticalPath` from `KNOWN_OVER_BUDGET`. Owner: frontend agent. Effort: 3 h.

**E-4 [MVP] Scan the dense panels (R-8).** Extend the a11y sweep to open Layers (all overlays on, legends visible) and Playback (window loaded, scrubber focused) on all four CI-18 legs; fix what it finds. Owner: frontend agent. Effort: 2 h plus fixes.

**E-5 [MVP] Isolate event sections and move "where" up (R-9, R-10).** Load sections with `Promise.allSettled` and render each that succeeded; move "where" directly after the timeline (renumber slot, for example 050). Test: one section import rejects, the others render. Owner: frontend agent. Effort: 2 h.

**E-6 [MVP] Set launch defaults and hide v2 tools behind a flag (R-10, R-11).** Proposed: keep Home, Locate, Layers on the map; move Replay and Measure to a "More" menu or behind a launch flag; at launch hide swaths, lightning, land cover, data export and measure; show MeteoAlarm warnings on by default where they exist; add distance from the last located position to list rows when a fix exists. Owner: founder decides the list, then frontend agent. Effort: 4 h plus 1 founder-hour.

**E-7 [MVP] Run a founder copy-review batch (R-4).** Export the ~334 public pending keys as an EN/BG two-column sheet, grouped by surface and ordered by launch visibility (eventDetail, layers, filters, playback, privacy first; staffCuration last since it is internal). Reviewed keys leave `PENDING_FOUNDER_REVIEW`. Legal-adjacent privacy text needs counsel (cross-reference review 32). Owner: founder. Effort: 15–25 founder-hours; 1 h agent prep.

**E-8 [MVP] Add a redundant channel for CVD-collapsed states (R-5).** Confirmed versus likely: add a shape or ring (for example a white ring on confirmed) so colour is not the only carrier; separate "no longer detected" from official status with a hatch or outline, not a grey shift. Move FWI legend colours out of the reserved band. Each fix removes its KNOWN_FINDINGS entry. Owner: founder approves the visual language, then frontend agent. Effort: 4 h plus 1 founder-hour.

**E-9 [v1, MVP minimum] Ship the PWA shell, then push (R-3).** MVP minimum: manifest, icons, theme-color, noscript, and a service worker that caches the app shell and the last snapshot with a visible "offline, data as of <time>" state (honest-clock compliant). v1: web push with the iOS Home-Screen flow from review 08 §5.4.4. Open a TASKS row so V3-C3 has a real dependency. Owner: frontend agent. Effort: 12 h shell; push separately sized in v1.

**E-10 [MVP] Add a skip link and an `<h1>` (R-12).** A "Skip to fire list" link as first focus stop and a visually hidden `<h1>` on home; both need two new copy keys each in EN and BG. Keyboard walk bound tightens from 20 to about 5. Owner: frontend agent, copy by founder. Effort: 1 h.

**E-11 [v1] Make the timing gate real (R-7).** Replace the raster stand-in with a fixture of the real vector tiles and glyphs already built locally; add a slow-3G profile (400 kbit/s, 400 ms RTT) as an advisory leg; do one recorded pass on a real mid-range Android (for example a Galaxy A15 class device) on throttled network. Owner: frontend agent plus founder device. Effort: 4 h, blocked-external on the device.

**E-12 [v1] Give reduced motion a static "new" marker (R-13).** Under `prefers-reduced-motion`, replace the pulse with a static ring or label. Owner: frontend agent. Effort: 1 h.

**E-13 [v2+] Tame global signals (R-15).** Group the 63 module-level signals into a few per-feature store modules with one reset seam each; split `map-controller.ts` by layer group. Do it only when a feature next touches these files. Owner: frontend agent. Effort: 6 h, opportunistic.

## 5. Frontend, UX & accessibility deep dive

### 5.1 The three questions on a mid-range Android on 3G

The questions are "where is the fire", "how big / which way / is it still detected" and "is there danger around me".

**Where.** It is answered well. The list and map share the store, `inViewOnly` defaults to true, and Locate is one press away. Critical path: entry 51.4 KB + map 137.5 KB + maplibre-gl-shared 133.6 KB + worker 5.9 KB + shared 14.4 KB + BG catalog 17.1 KB + CSS 4.2 KB ≈ 360 KB gzip. On real 3G (about 400 kbit/s effective) that is about 7–8 s of transfer before tiles, glyphs and the snapshot. CPU parse of 270 KB of MapLibre on a mid-range phone adds 1–2 s. Measured on Fast 3G with a raster stand-in, the gate passes at 15 s; real tiles plus glyphs could push it past, and nobody has looked (R-7). The list can render before the map is ready, which is the right fail-open shape, but only if client config does not hang (R-2).

**How big / which way / still detected.** The event page carries the timeline, detections, outline and before/after, but the list row carries none of size or recency of detection beyond the time stamp. "Which way" exists only as the wind overlay (off by default) and the outline. That is consistent with the never-forecast rule and should stay so; but the row should say "still detected / not detected since <time>" plainly, which the status badge partly does.

**Danger around me.** This is the weakest answer. FWI and MeteoAlarm are inside a panel the user must find, both off by default, and the "where" section is the last of nine on an event page. E-5 and E-6 fix the order and defaults without adding features.

### 5.2 Feature density and the bottom sheet

Review 07 scoped an MVP of map, list, event page, alerts and the honest clock. The build now has about 30 user-visible features: six overlays, two static-source sets, basemap choice, satellite passes, MeteoAlarm, playback, measure, before/after, CEMS badge, land cover, lightning, outlines, data export, share card, sign-in, zones, staff curation and more. Each is individually well-made and lazily loaded, so bytes are not the problem; attention is. On a 360 px phone the five control buttons wrap, the panel scrolls inside a sheet that already takes 70% of the height, and at 200% text the control column becomes its own scroll area (`styles.css:300-330`).

Recommendation (E-6): launch with three visible map controls and a "More" sheet, and keep everything beyond the three questions behind a launch flag that the founder can lift per feature after launch. Defaults matter more than hiding: everything currently defaults to off, which is safe for bytes but means the first-visit map answers only "where".

### 5.3 Honest clock and never-say-out on every surface

| Surface | Copy compliant | Clock compliant | Note |
|---|---|---|---|
| Live map, list, banner | Yes | Yes | Server-corrected time; relative ages with absolute stamps. |
| Event page timeline | Yes | Yes | First/last detected with `<time>` and Sofia stamp. |
| Official status | Yes | Yes | Attributed only, with "does not mean the fire is out". |
| Outlines | Yes | No during replay | "As of now" outlines drawn over past dots (R-1). |
| Playback | Yes | No when panel closed | No persistent indicator (R-1). |
| Before/after | Yes | Yes | Names cloud and smoke; "Not a burned-area map". |
| Offline | n/a | n/a | No offline mode exists; when built it must show "data as of" (E-9). |

The copy rule is in better shape than in review 07. The clock rule fails only where two times share one map, which is the case review 07 warned about.

### 5.4 i18n: pending keys, Bulgarian risk and fragments

The catalog grew from 81 paths (CI-11 in September) to about 503. 416 are pending, by namespace: staffCuration 82 (internal), eventDetail 64, layers 48, filters 29, signIn 27, privacy 21, playback 21, passes 21, accessibility 18, measure 17, beforeAfter 16, meteoalarm 13, newSignals 8, dataExport 8, search 7, disclaimer 6, ageWindow 4, shareCard 3, ogImage, mapControls and eventUnavailable 1 each. E-6 shrinks the review: hiding measure, export and passes at launch defers about 46 keys.

Bulgarian risk is not fluency but authority: the privacy and disclaimer texts are legal-adjacent and drafted by an implementer, and a BG speaker reads official-sounding phrasing as a claim. Long BG labels already strain the control row at 320 px, which CI-18 catches.

The V3-P1 fragment system exists only for before/after (`fragments/before-after.{en,bg}.ts`). It is the right shape to move feature strings out of the eager BG catalog (17.1 KB gzip, the second-largest critical-path item after MapLibre), and it is also the cheapest second fix for criticalPath after E-3.

### 5.5 Accessibility: target, CVD, map, and what axe cannot catch

Since review 19 the automated layer has been built: CI-18 layout floors, the axe sweep (zero serious or critical on 2026-10-22), the keyboard walk and CI-14. What remains is what automation cannot see.

- **Target.** WCAG 2.2 AA is the right target: the EU Accessibility Act refers to EN 301 549, which is moving to 2.2. The build already meets the 2.2 additions that matter (24 px targets via `--tap-target`, focus not obscured is partly covered by CI-18). Decide it now (Q1) so the statement can be finalised.
- **CVD.** Recorded in R-5. The fix is a second channel, not new colours: fire red stays reserved.
- **Map for keyboard and screen readers.** The list is the accessible twin of the map, which is the correct design. But nothing asserts that what the canvas shows equals what the list says (the proposed CI-16). During replay the two diverge by design, which is one more reason the replay state must be announced (E-1).
- **What axe cannot catch.** Whether a screen reader hears "past" during replay, whether live-region announcements on SSE updates are too chatty, whether BG speech synthesis reads the abbreviations (FWI, FRP, CEMS) sensibly, and whether a low-vision user at 200% can still reach "Back to live". Only the M-1..M-3 manual pass answers these, and it has not been run.

### 5.6 Offline, PWA and push

Nothing exists. For a wildfire product this is the gap users will feel first: connectivity is worst near a fire, and a page that loads once and then shows the last snapshot with an honest "as of" stamp is worth more than any v2 overlay. The minimal shell (E-9) is about 12 h and fits the existing transport tiers: the service worker becomes a fourth tier below T2. Push is the larger question. Email and Telegram alerts exist in the backend, so web push is a v1 convenience, not an MVP need, provided the launch copy does not promise it.

### 5.7 Code health

| File (non-test) | Lines |
|---|---|
| `core/i18n/catalog-governance.ts` | 1,444 |
| `styles.css` | 1,356 |
| `core/i18n/messages.ts` | 897 |
| `core/i18n/bg.ts` / `en.ts` | 875 / 862 |
| `map/map-controller.ts` | 798 |
| `core/feed/polling-feed.ts` | 715 |
| `ui/layers.ts` | 644 |
| `map/layer-registry.ts` | 528 |
| `ui/pages/staff-curation.tsx` | 502 |

`web/src` holds 32,357 lines with 155 test files: test density is good. The large files are data (catalogs, governance) or one controller, which is acceptable. The 63 module-level signals with `reset…ForTest` helpers are the real debt: they make every feature implicitly global and every test order-dependent unless it remembers the reset. E-13 is opportunistic, not a launch item.

## 6. Open questions for the founder

1. **WCAG 2.1 AA or 2.2 AA?** Recommended: 2.2 AA. The build already meets most of the additions, and EN 301 549 is moving to it.
2. **Which features are visible at launch?** Recommended: map, list, event page, Layers (basemap, FWI, outlines, MeteoAlarm, static sources), playback behind "More"; measure, export, swaths, lightning, passes and land cover behind a flag until after the first season.
3. **Is an offline shell an MVP item?** Recommended: yes for the minimal shell (E-9, about 12 h); web push to v1, with no launch copy that promises browser notifications.
4. **When will you review the ~334 public copy keys, and who checks the privacy text?** Recommended: three 2-hour sessions grouped by surface before the end of January 2027; privacy and disclaimer through counsel.
5. **Which second channel for confirmed versus likely?** Recommended: a white ring on confirmed detections and a hatch for "no longer detected", keeping fire red reserved.
6. **During replay, should current outlines be hidden or labelled?** Recommended: hidden, as swaths and lightning already are; one time per map.
7. **Which real device is the reference for the 3G target?** Recommended: one Android in the €150–200 class bought for the purpose, used for E-11 and the manual AT pass.

## Appendix A — Proposed rows for the shared documents

### (a) TASKS rows

- [ ] **R5-UX-1 — Persistent replay indicator and one time per map.** Spec: review 31 E-1. Writes: `web/src/ui/playback-panel.tsx`, `web/src/ui/map-pane.tsx`, `web/src/ui/layers-panel.tsx`, catalogs, `web/e2e/playback.e2e.ts`. Done when: with a replay loaded and the panel closed, a "Replaying" strip and `aria-pressed="true"` are present, outlines are hidden, and an e2e asserts both. Est: 3 h. Status: open.
- [ ] **R5-UX-2 — Bound the client-config wait.** Spec: review 31 E-2. Writes: `web/src/core/feed/client-config.ts`, `web/src/boot.ts`, one e2e. Done when: an e2e that stalls `/api/v1/client-config` sees the map render within the normal map-ready budget. Est: 1 h. Status: open.
- [ ] **R5-UX-3 — criticalPath back under budget.** Spec: review 31 E-3. Writes: `web/src/ui/layers-panel.tsx` (split), credits module, `web/budgets/ci-12.budget.ts`. Done when: `KNOWN_OVER_BUDGET` is empty and CI-12 passes. Est: 3 h. Status: open.
- [ ] **R5-UX-4 — Axe and CI-18 sweep over the open Layers and Playback panels.** Spec: review 31 E-4. Writes: `web/e2e/a11y.e2e.ts`, fixes in `web/src/ui/`. Done when: both panels are opened on all four legs with zero serious or critical findings. Est: 2 h. Status: open.
- [ ] **R5-UX-5 — Event sections isolated per chunk, "where" after the timeline.** Spec: review 31 E-5. Writes: `web/src/ui/event/event-details.tsx`, `web/src/ui/event/sections/registry.ts`, the where section's slot. Done when: a test with one rejecting section import still renders the others, and "where" is the first section. Est: 2 h. Status: open.
- [ ] **R5-UX-6 — Launch defaults and a launch flag for v2 tools.** Spec: review 31 E-6. Writes: `web/src/ui/map-controls.tsx`, `web/src/ui/layers.ts`, client config. Done when: the founder's launch list is encoded and an e2e shows only the listed controls on a first visit. Est: 4 h. Status: blocked-owner.
- [ ] **R5-UX-7 — Founder review of the public pending copy keys.** Spec: review 31 E-7. Writes: `web/src/core/i18n/catalog-governance.ts`, `en.ts`, `bg.ts`. Done when: `PENDING_FOUNDER_REVIEW` holds no public-facing key in a launch-visible namespace. Est: 1 h agent + 15–25 founder-hours. Status: blocked-owner.
- [ ] **R5-UX-8 — Redundant channel for CVD-collapsed states.** Spec: review 31 E-8. Writes: `web/src/map/style-colors.ts`, `web/src/map/layer-registry.ts`, `web/src/map/fire-owns-red.test.ts`. Done when: the confirmed/likely, no-longer-detected/official and FWI-legend entries are gone from KNOWN_FINDINGS. Est: 4 h. Status: blocked-owner.
- [ ] **R5-UX-9 — PWA minimal shell: manifest, icons, service worker, offline snapshot.** Spec: review 31 E-9. Writes: `web/index.html`, `web/public/manifest.webmanifest`, `web/src/sw/`, `web/e2e/offline.e2e.ts`. Done when: an e2e loads once, goes offline, reloads and sees the last snapshot with an "as of" stamp. Est: 12 h. Status: open.
- [ ] **R5-UX-10 — Skip link and `<h1>`.** Spec: review 31 E-10. Writes: `web/src/ui/app.tsx`, `web/src/ui/pages/home.tsx`, catalogs, `web/e2e/a11y.e2e.ts`. Done when: the keyboard walk reaches the first row within 5 stops and axe reports no `page-has-heading-one`. Est: 1 h. Status: blocked-owner.
- [ ] **R5-UX-11 — Timing gate on real tiles, slow 3G, one real device.** Spec: review 31 E-11. Writes: `web/e2e/map-ready.timing.ts`, `web/e2e/timing/`, `docs/accessibility/records/`. Done when: the gate runs on the real tile fixture with a slow-3G advisory leg and one real-device record is filed. Est: 4 h. Status: blocked-external.
- [ ] **R5-UX-12 — Static "new" marker under reduced motion.** Spec: review 31 E-12. Writes: `web/src/styles.css`, map layer paint. Done when: with `prefers-reduced-motion`, new detections show a static marker, asserted in e2e. Est: 1 h. Status: open.

### (b) RISKS §2 and GATES rows

- **RISKS §2:** *Two times on one map.* A replay can stay active with no visible marker, and current outlines are drawn over past detections; a user can read a past fire as a present one. Likelihood medium, impact high (honest-clock breach). Mitigation: R5-UX-1. Owner: frontend.
- **RISKS §2:** *Copy sign-off bottleneck.* 416 of ~503 copy paths are unreviewed by the founder; launch slips or ships unreviewed copy. Likelihood high, impact medium. Mitigation: R5-UX-6 shrinks the set, R5-UX-7 batches it. Owner: founder.
- **RISKS §2:** *No offline shell.* Connectivity fails near fires and the app has nothing to show. Likelihood high in season, impact medium. Mitigation: R5-UX-9. Owner: frontend.
- **GATES:** *CI-12b — boot fails open.* An e2e stalls `/api/v1/client-config` and the map must reach ready within the CI-12 timing budget. Blocks merge.
- **GATES:** *CI-18 amendment.* The sweep must open every disclosure panel reachable from the map controls (today: Layers, Playback, Measure) on all four legs.

### (c) Synthesis paragraph for 00-summary

The frontend is architecturally sound and well gated: the framework-free core held, byte budgets are enforced (criticalPath 0.66% over, with a known fix), and the never-say-out vocabulary is met in copy on every surface. The honest clock breaks where two times share one map: a replay can run invisibly with "now" outlines over past detections, and that must close before launch. The real launch risks are reach and sign-off rather than code: first paint waits on an untimed fetch, there is no offline shell or push despite review 08, and 416 of ~503 copy keys await the founder. Accessibility automation is strong, but the densest panels are unscanned, the WCAG target is undecided and the manual pass has not run.

## Appendix B — What was verified, and how

| Claim | How verified |
|---|---|
| Replay can be active with panel closed; no indicator | Read `ui/playback.ts` (`playbackActive` from `collectionFor`, separate `playbackPanelOpen`), `ui/playback-panel.tsx`, `ui/map-pane.tsx:96-114`, `ui/layers-panel.tsx:62-80` |
| Client config has no timeout and blocks first render | Read `boot.ts:59-80` and `core/feed/client-config.ts:78-92`; grep for `AbortSignal`/`timeout` in `core/feed/` |
| No PWA, manifest or push | Read `web/index.html`; grep `serviceWorker`, `PushManager`, `manifest` in `web/src` and `web/public`; grep TASKS for PWA (only V3-C3) |
| 416 pending keys, posture counts | Counted entries in `PENDING_FOUNDER_REVIEW` and posture maps in `catalog-governance.ts` with a node one-liner; grouped by namespace prefix |
| criticalPath figure | Read `web/budgets/ci-12.budget.ts` comment and `bundle-budgets.ts:48-53`; summed gzip sizes of `web/dist` assets (stale build, 2026-10-24) |
| Timing gate uses raster stand-in | Read `web/e2e/map-ready.timing.ts` and `web/e2e/timing/map-ready-budget.ts` |
| Sweep skips Layers and Playback | Grep in `web/e2e/a11y.e2e.ts` for panel openers; only measure and before/after found |
| Section loading is all-or-nothing | Read `ui/event/event-details.tsx:75-106`; listed `ui/event/sections/` |
| Overlays default to off | Read `ui/layers.ts` (`chosenOverlays` from `fw:layers`, else `[]`) |
| CVD findings | Read `map/fire-owns-red.test.ts:267-297` |
| Reduced motion, bottom sheet, control column | Read `styles.css:163`, `300-330`, `762-785` |
| Never-say-out compliance | Grep `en.ts` for contained/extinguished/out/safe/forecast; read outline, before/after and playback copy |
| Accessibility status | Read `docs/accessibility/README.md`, `docs/accessibility/records/`, `TASKS.md:115`, `:208`, `GATES.md:25-34`, `:211` |
| File sizes and signal count | `wc -l` over `web/src`; grep for exported `signal(`/`computed(` at module level |
| Not verified | Current bundle sizes at `ccd541a` (no build run); real-device and real-network timing; screen-reader behaviour; BG quality beyond spot samples |
