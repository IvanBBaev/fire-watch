# Review 07 — Product & UX

*Reviewer role: senior product designer, crisis-information UX.*
*Inputs reviewed: `docs/ANALYSIS.md` (2026-07-21), `docs/decisions/001-map-stack.md` (ADR-001),
`docs/reviews/00-summary.md`, `05-security.md`, `06-qa.md`; external benchmark research (Watch
Duty, Genasys Protect/Zonehaven, NASA FIRMS map, EFFIS viewer, Copernicus EMS — sources in §7).*
*Date: 2026-07-22. Project status: pre-code.*

---

## 1. Summary verdict

**Conditional GO.** The product thesis — aggregation, localization, honest alerting UX on top of
free satellite data — is the right one, and the engineering reviews have already locked in the
two decisions that matter most to UX: **freshness as first-class data** and **FireEvent (not the
raw hotspot) as the core entity**. Those two decisions make an honest product *possible*. This
review is about making it *legible*: the entire product lives or dies on whether a non-expert
Bulgarian user, five kilometers from smoke, can correctly understand in ten seconds what a
15-minute-to-3-hour-old satellite detection does and does not tell them.

The condition on the GO: **the "honest clock" design system (§5.2) is not a styling layer — it
is the product.** Watch Duty's benchmark cannot be copied here, because Watch Duty's core asset
is human reporters delivering minutes-fresh curated fact; ours is satellite physics with a
built-in delay. A product that imitates Watch Duty's surface (map + incidents + push) without
redesigning the *time semantics* of every element will either feel useless ("this is 3 hours
old") or, far worse, falsely reassuring ("nothing on the map = no fire"). Every screen must
answer three questions before any other: *when was this last observed, when will we know more,
and what can this data not see.* If that framing is executed, the latency handicap converts into
the product's trust moat — no competitor communicates uncertainty honestly, including the
official tools.

Second condition: **never borrow authority vocabulary.** No evacuation statuses, no
"contained", no "out", no "safe". The moment the product's language implies operational
authority it inherits liability and loses the one defensible position it has: the honest
aggregator that always tells you how it knows what it knows.

---

## 2. Strengths (what the current plan already gets right for UX)

1. **"Honest freshness UX: never imply live" is stated in ANALYSIS §4 as an MVP feature, not a
   footnote.** Almost no data product starts with this. It is the single best product decision
   in the corpus and every recommendation below builds on it.
2. **FireEvent as the core entity** solves, by construction, the worst UX failure of the FIRMS
   public map: raw pixels that make the whole country look ablaze at low zoom and make one
   pixel look like a burning village at high zoom (§5.1.3). Clustered, named, permalinked
   events are the correct consumer unit of meaning.
3. **ADR-001's "fire layers own red/orange exclusively" on a muted outdoor basemap** is the
   correct visual-salience contract for a crisis map, and QA has already turned it into a CI
   lint. Very few teams protect their alarm color with tooling.
4. **Map fails open, alerts fail closed** (security review) is also the correct *UX* asymmetry:
   a stale map with a banner preserves user agency; a wrong push destroys trust permanently.
5. **Alerts deferred to v1 after a shadow period** is product discipline most startups lack.
   The map-first free season builds the trust that makes alerts believable later — Watch
   Duty's history confirms trust precedes monetization.
6. **"Never all clear" + "not a life-safety system"** are already invariants across all
   reviews. This review's job is to make them *usable* rather than paralyzing (§5.6.3).
7. **Dark mode and Cyrillic-first labels are in ADR-001 as requirements**, not afterthoughts —
   night use and local language are exactly the two things EFFIS/FIRMS fail at for this
   audience.
8. **The security review's crowdsourced-reports ladder ("evidence, never triggers")** is
   simultaneously the right abuse control and the right information design: it forces visual
   subordination of unverified ground reports to satellite data (§5.7).
9. **CDN-snapshot-first transport** (T2 in the summary) means the map UX can be designed around
   a single, cacheable, timestamped artifact — which makes the offline/stale states (§5.8.4)
   coherent instead of accidental.

---

## 3. UX risks & gaps (severity-ranked)

Severity: **Critical** = defeats the product promise or causes harm through misreading;
**High** = will visibly damage trust/adoption; **Medium** = rework or slow erosion; **Low** =
note and move on.

### Critical

- **U1 — False reassurance by absence.** An empty map region, or an event that has visually
  faded, will be read as "no fire / fire is out". With 4–6 polar passes/day plus cloud gaps,
  absence of detections is weak evidence. This is the most dangerous misread the product can
  produce and it happens *by default* unless designed against. → §5.2.4 (decay language,
  "no longer detected", last-checked timestamps on empty space), §5.2.6 (stale banners).
- **U2 — Freshness theater.** Any "updated 2 minutes ago" label that refers to *our poll time*
  rather than *satellite observation time* is a lie the user cannot detect. All timestamps
  user-facing must be observation-anchored; "updated" vocabulary must be reserved and audited.
  This needs to be a copy-level invariant with a checklist, like "never all clear". → §5.2.2.
- **U3 — Latency shock against Watch-Duty-shaped expectations.** The first viral moment will
  produce the comparison: "the fire was in the village Facebook group two hours before your
  app." If expectation-setting is not built into onboarding, event cards, and the About page,
  the product gets one news cycle and dies as "the app that is always late". The counter is not
  speed (we cannot buy it) but *reframing*: we are the only source that tells you what
  satellites saw, when, with what confidence — including at 03:00 when no one is posting.
  → §5.1.1, §5.6, §5.9.1.

### High

- **U4 — Panic amplification through raw rendering.** FIRMS-style pixel dumps over-alarm;
  agricultural burns rendered as fires next to villages will trigger real phone calls to 112.
  The clustering + hot-source mask (summary T5) is necessary but not sufficient: the *visual
  grammar* (cluster caps, footprint softness, confidence tiers, "likely agricultural burn"
  labeling) must be designed for calm. → §5.3.2, §5.2.3.
- **U5 — Alert fatigue and duplicate semantics.** Covered technically by QA (DAR metric,
  suppression windows) and security (budgets); the UX contribution — tiered severity, digests,
  quiet hours, per-zone sensitivity in *user* language — is currently unspecified. One noisy
  week in August unsubscribes a user for the season. → §5.5.
- **U6 — No self-serve alert explainability.** "Why did/didn't I get an alert?" will be the #1
  support question and the #1 trust question after any missed fire (INT-2 in security review).
  Without an explainability surface, every such question becomes a public accusation.
  → §5.5.6.
- **U7 — Vocabulary drift into authority.** The temptation to say "fire out", "under control",
  "contained", "safe to return" will be constant (users will ask for exactly these). Any such
  phrase creates Genasys/官-style authority semantics without an authority behind them.
  Needs a written copy style guide with banned phrases, enforced by templated-only alerts
  (security §5.2.1) and review checklist. → §5.6.3.

### Medium

- **U8 — Confidence display misread.** Raw FIRMS confidence (numeric for MODIS, l/n/h for
  VIIRS) leaking into consumer UI would be noise; but a single opaque "confidence: 73%" is
  worse (false precision). Needs the 3-tier consumer mapping with defined words and glyphs,
  and the formula owned (already an escalated open question in 00-summary). → §5.2.3.
- **U9 — FWI danger layer color collision.** EFFIS FWI classes are conventionally
  yellow→red; overlaying them under fire markers violates the "fire owns red" contract and
  drowns detections. Needs a mode-based solution, not a stackable overlay. → §5.4.3.
- **U10 — Night/low-vision legibility unverified.** Dark mode is planned, but panic use at
  night on a cheap Android at 20% brightness with 200% font scale is a scenario, not a theme.
  QA's visual matrix covers regression; the *design targets* (type scale, contrast floors,
  glyph sizes) need stating first. → §5.8.
- **U11 — Seasonality churn.** A PWA nobody opens from October to May quietly loses
  installs, notification permissions (browsers revoke), and mindshare. Without an off-season
  value proposition and a season-start ritual, each June starts from zero. → §5.9.
- **U12 — Cross-border place blindness.** Events in the +100 km buffer (Greece, Serbia,
  Turkey, North Macedonia) need place names users recognize; naive reverse geocoding will
  produce Greek-alphabet names in a BG UI. Localization of *place context*, not just chrome,
  is in scope. → §5.4.6.

### Low

- **U13 — Share-card absence.** Every major fire will be screenshotted into Facebook groups.
  Without designed share cards (event permalink + OG image with freshness stamp), screenshots
  circulate without timestamps — stale data with our brand on it. Cheap to fix, do it at MVP.
- **U14 — B2B analyst surface prematurely leaking into consumer UI.** FRP charts and source
  tables belong behind progressive disclosure; resisting "just add a toggle" keeps the
  10-second panel honest. → §5.3.4.

---

## 4. Detailed recommendations

Tagged [MVP] (map-only free launch), [v1] (accounts + alerts), [v2] (B2B/API). Each maps to
risks and to the deep-dive section that specifies it.

**Time & uncertainty (the product core)**

- **P1 [MVP] (U2):** Adopt the **observation-anchored time invariant**: every user-visible
  timestamp is satellite observation time; the words "updated/refreshed" may only describe
  data availability and never appear without an observation time next to them. Add to the copy
  style guide and QA's release checklist. (§5.2.2)
- **P2 [MVP] (U1, U3):** Ship the **freshness chip** on the map (global) and on every event
  (per-event): "Observed HH:MM (N min ago) · next update expected ~HH:MM–HH:MM", driven by the
  pass predictor (summary T6) *plus* typical NRT/FCI lag — the promise is when the *user* will
  know more, not when the satellite flies over. (§5.2.2)
- **P3 [MVP] (U1):** Implement **"No longer detected"** as the only terminal-ish visual state:
  desaturated gray marker, copy "No heat detected in the last N satellite passes — may be out,
  smoldering below detection limits, or hidden by cloud." Never the word "out" in UI. Decay is
  frozen while sources are stale (already an SRE requirement — surface it). (§5.2.4)
- **P4 [MVP] (U1, U2):** **Stale-source banner** hierarchy: one global banner ("Satellite data
  delayed — showing last data from HH:MM"), per-event stale styling after missed expected
  passes, and an offline PWA state that shows the cached snapshot with its timestamp writ
  large. Map always fails open *with its age visible*. (§5.2.6)
- **P5 [MVP] (U8):** Consumer **confidence tiers**: exactly three — `Confirmed` (multi-pass or
  multi-source), `Likely` (single strong detection), `Unverified` (single low-confidence) —
  encoded by label + glyph + opacity, never by hue (fire owns red; CVD rule). Numeric
  confidence appears only in the analyst disclosure layer and the API. (§5.2.3)

**Map & information hierarchy**

- **P6 [MVP] (U4):** Implement the **zoom ladder**: cluster dot (z≤7, capped symbol size) →
  event footprint hull with soft dashed edge labeled "detection area — not a fire perimeter"
  (z8–11) → individual detection footprints ~375 m with per-detection times (z≥12). (§5.3.2)
- **P7 [MVP] (U3):** Design the **10-second panel**: place-anchored event name ("Fire near
  Harmanli"), distance + bearing from user/zone, intensity word + trend, freshness chip, wind
  now, and a persistent "In danger? Call 112" affordance. Everything else is below the fold.
  (§5.3.1, §5.3.3)
- **P8 [MVP] (U10):** Treat **night use as a first-class scenario**: auto dark map after local
  sunset (with manual override), calibrated fire palette for dark background, minimum body
  16 px, distance figures in display size, test at 200% font scale and minimum brightness.
  (§5.3.5, §5.8)
- **P9 [MVP] (U9):** Make FWI a **"Danger forecast" mode**, not a stackable overlay: entering
  it dims live events to outline-only and shows the EFFIS ramp with its own legend; exiting
  restores the fire-owns-red world. One meaning of red per view. (§5.4.3)
- **P10 [MVP] (accessibility + panic):** Ship a **list view** ("Fires near me", sorted by
  distance, text-first) alongside the map. It is simultaneously the screen-reader strategy
  (QA §5.4), the weak-device fallback, and the fastest panic surface. (§5.8.2)

**Screens & trust**

- **P11 [MVP]:** Screen inventory per §5.4 — map, event panel/page with **stable permalinks**
  (this is a UX requirement on ADR-002 event identity), About/Methodology, "How fresh is this
  data?" explainer, legal/privacy. Everything else is explicitly out (§5.4.7).
- **P12 [MVP] (U3, U7):** Publish the **methodology page and per-event source attribution**
  from day one ("Detections: VIIRS (NASA FIRMS), Meteosat (EUMETSAT/LSA SAF)…"). Attribution
  is a license obligation anyway — design it as a credibility feature. (§5.6.1)
- **P13 [MVP] (U7):** **Disclaimer as layered capability statement** (§5.6.3): one-time
  first-launch card (logged), one compact line in the event panel footer, full version on
  About, footer in every future alert. No repeating modals; phrase as "what this is / isn't",
  always ending in "Emergency? Call 112".
- **P14 [MVP] (U13):** OG/share cards per event permalink with baked-in observation timestamp
  and confidence tier, so screenshots and shares carry their own freshness. (§5.4.5)

**Alerts (v1)**

- **P15 [v1] (U5):** Watch-zone creation flow per §5.5.1: map-first pin + radius (default
  10 km, min 2 km), **privacy coarsening "store approximate center (~1 km)" default ON**
  (security B1 made it an option; product should make it the default — alert semantics lose
  nothing at radius ≥ 2 km), auto-suggested place-based zone name, sensitivity in user words,
  double opt-in per channel.
- **P16 [v1] (U5):** **Alert taxonomy**: `new_fire` (overrides quiet hours by default,
  user-changeable), `escalation` (reignition/major growth; respects quiet hours unless zone
  marked "always wake me"), `daily digest` (never overrides). Digest collapse for multi-event
  days is default-on (also security §5.5.3). (§5.5.3–5.5.4)
- **P17 [v1] (U6):** Build the **explainability surface**: "Why this alert?" link in every
  notification (zone + event + rule version + triggering detections) and a self-serve "Why no
  alert?" checker on the zone page (nearby recent events + which gate applied: confidence
  floor, suppression, quiet hours, delivery failure, source outage). (§5.5.6)
- **P18 [v1] (U5):** Alert content is **templated-only** (security A3) and follows the anatomy
  in §5.5.5 — observation time in the body, place-name location (never raw coordinates in
  email), no spread prediction, disclaimer footer.

**Reports, off-season, growth**

- **P19 [v1] (U4):** Crowdsourced report UX per §5.7: submission sets expectations ("reports
  are evidence — they never trigger alerts"), rendering uses a non-red glyph (style-lint
  compliant) visually subordinate to satellite events, reporter gets status feedback
  (received → corroborated → verified/declined).
- **P20 [v1→v2] (U11):** Off-season product: **burned-area explorer** (EFFIS finals + dNBR
  severity + per-municipality season stats), season recap share content, and a single
  season-start push ritual ("Fire season begins — check your zones"). (§5.9.2)
- **P21 [v2] (U14):** Analyst mode (FRP trend, per-source detection table, exports, polygon
  intersections) as a separate disclosure tier / org account surface — never in the default
  panel. (§5.3.4)

---

## 5. UX deep dive

### 5.1 Benchmark teardown

#### 5.1.1 Watch Duty — what they got right, and what does not transfer

Watch Duty is the reference for a reason: ~20M users, Apple Design Award 2025 (Social Impact),
the #1 free app on iOS during the January 2025 LA fires, run as a nonprofit with 48 staff and
~250 trained volunteers monitoring radio scanners, official traffic, cameras and satellites
around the clock.

**What they got right (transferable):**

1. **Incident-centric information architecture.** The unit of meaning is a *named incident*
   with a reverse-chronological, timestamped, human-written update feed — not a layer of
   symbols. Every update is small, factual, and attributed. → Our FireEvent pages should
   borrow the shape: named event, timeline of *detections and data milestones* (instead of
   human reports at MVP), permalink.
2. **Calm, factual, no-speculation tone.** Updates state what is known, from whom, at what
   time. No adjectives, no drama, no prediction. During LA 2025 this earned them primacy over
   official channels. → Directly adoptable as our copy style guide's foundation; it costs
   nothing and differentiates from both media hysteria and agency silence.
3. **Free, no signup, ad-free core.** Zero friction between a frightened person and the map.
   → Already our Phase-1 plan; protect it permanently (also the security review's stance on
   never degrading the free map).
4. **Evacuation zone integration** (via Genasys) gives users an *actionable* layer: what to do,
   not just what is burning.
5. **Trust through error ownership**: public corrections and postmortems during disasters.
   → Mirrors security INT-1/INT-2 playbooks; make postmortems a public product surface
   (§5.6.4).

**What does NOT transfer — and must not be imitated:**

| Watch Duty asset | Why it doesn't transfer | Our substitute |
|---|---|---|
| Minutes-fresh human reports from radio scanners | BG has no open scanner culture/legal frame; solo team; our floor is 15–30 min (FCI) to ~3 h (NRT) | Honest clock UX (§5.2); FCI "early signal" layer in v1; editorial log only for major fires, clearly best-effort |
| "Containment %", acreage from incident command | No such official feed in BG; we must not fabricate operational status | Detection-derived facts only: intensity trend, detected area, last-observed |
| Evacuation zones & statuses (Genasys) | No Bulgarian zone authority or data source exists; inventing statuses = impersonating authority | Link out to 112/BG-ALERT/ГДПБЗН; never render evacuation semantics of our own |
| 250-person volunteer curation network | Solo founder + maybe one volunteer (security open Q1) | Automation-first; curation reserved for a handful of major incidents, labeled and timestamped |
| Push within minutes of ignition | Physics: no sub-15-min source exists for Europe | Set expectations everywhere; the alert promise is "as soon as satellites + processing allow, and we show you the clock" |

The strategic reading: Watch Duty won by being *faster and calmer than official channels*.
Fire Watch can only win by being *more honest and more local than any alternative* — the
speed axis is closed, the honesty axis is wide open (nobody in the EU ecosystem occupies it).

#### 5.1.2 Genasys Protect / Zonehaven — the addressing lesson

Genasys' consumer surface (protect.genasys.com, free, no login) is built on one idea:
**pre-named zones** ("know your zone") with statuses (Normal / Advisory / Warning / Order /
Shelter-in-place) set by authorities. Two lessons transfer, one anti-lesson:

- *Transfer 1 — stable, shareable identity.* People coordinate around names ("zone HAR-E012"),
  not coordinates. Our equivalents: place-anchored event names ("Fire near Harmanli", with
  "#2" suffixing on collision) and stable event permalinks (ADR-002's permanent IDs are a UX
  requirement, not just an engineering one).
- *Transfer 2 — the "look up my place" entry point.* Genasys' single search bar ("enter your
  address") is the lowest-literacy entry path. Our v1 mirror: "add your village" → watch zone.
- *Anti-lesson — status vocabulary requires an authority.* Genasys statuses are lawful orders
  issued by agencies. Any imitation of that ladder by an aggregator is authority
  impersonation. We render *observations*, they render *instructions*; the UI must keep the
  boundary visible (§5.6.2).

#### 5.1.3 NASA FIRMS map — the cautionary tale

FIRMS' public map is our raw-data anti-pattern, documented even in NASA's own communications:
at global zoom the symbol density makes Earth look ablaze; zoomed in, one 375 m/1 km pixel
renders as a burning neighborhood; hotspots include glint, industry and hot terrain; the
distinction "thermal anomaly ≠ fire" lives in a FAQ nobody reads. Time is shown as an
acquisition attribute in a popup, in UTC, with no notion of "next pass". Confidence is a raw
column. There is no event concept at all — the same fire is a shifting cloud of dots across
days.

Every one of these is a named design decision for us, inverted: clustering into events,
capped cluster symbols, footprints labeled as detection areas, local-time observation stamps
with next-update prediction, 3-tier confidence, hot-source masking. FIRMS is the control
group for our whole §5.2/§5.3.

#### 5.1.4 EFFIS viewer — expert GIS, not a consumer product

EFFIS' Current Situation Viewer (recently made faster and mobile-friendly) remains an
expert instrument: layer-tree UI, WMS stacking, FWI jargon and legends presupposing fire
science literacy, no per-fire permalinks, no alerting, English-only. Its data is excellent —
which is exactly the gap statement: **the JRC serves analysts and agencies; nobody serves the
person on the ground in their language.** Design conclusion: EFFIS layers enter our product
only through curated modes with rewritten legends ("Fire danger tomorrow: Extreme" instead of
"FWI > 50"), never as raw layer trees.

#### 5.1.5 Copernicus EMS Rapid Mapping — post-event, not real-time

CEMS Rapid Mapping produces authoritative delineation/grading products per *activation*,
typically available days after an event, aimed at civil protection. Zero relevance to the
NRT UX; high relevance to the off-season/history surface (§5.9.2): burned-perimeter and
severity products (alongside EFFIS finals and our own dNBR from Sentinel-2) power the
"what burned near you this season" explorer — attribution-friendly, free, and credible.

### 5.2 The central UX problem: the honest clock

The product's core tension: **data latency of 15 min–3 h in a domain where users expect
liveness.** The design goal is not to hide the latency and not to apologize for it, but to
make the *sensing rhythm* itself legible — turn "this app is slow" into "now I understand how
fire detection actually works, and this app is the only one that shows me."

#### 5.2.1 Principles

1. **Every piece of fire data carries its observation time, visibly.** Not in a tooltip.
2. **The future is part of freshness.** "Next update expected ~16:10–16:40" transforms
   staleness from a defect into a schedule. Users wait calmly for a train with a countdown;
   they rage at one without.
3. **Detection ≠ fire; area ≠ perimeter; absence ≠ safety.** Three inequalities the visual
   grammar must encode continuously (see §5.2.3–5.2.5).
4. **Uncertainty is stated in words users own**, not statistics: "confirmed / likely /
   unverified", "no heat detected in the last 2 passes", "hidden by cloud possible".
5. **One clock, one truth.** All surfaces (map chip, event panel, alerts, share cards, API)
   derive from the same `last_observed_at` / pass-predictor fields — freshness is already
   first-class data in the architecture; the UI must never compute its own version.

#### 5.2.2 The freshness chip (anatomy)

```
┌───────────────────────────────────────────────┐
│ 🛰  Observed 14:32 (47 min ago)               │
│     Next update expected ~16:10–16:40    [?]  │
└───────────────────────────────────────────────┘
     │             │                        │
     │             │                        └─ opens "How fresh is this data?" (§5.4.4)
     │             └─ live-updating relative age; amber when age > expected
     │                cadence; gray + "STALE" when a pass was missed
     └─ ALWAYS satellite observation time — never poll/processing time (P1)
```

Rules:

- The **range**, not a point ("~16:10–16:40"), because the promise is *data availability to
  the user* = next expected overpass + typical source lag (NRT lag measured by the
  validation-plan step 1; FCI ~15–30 min). Overpromising a minute is how honesty dies.
- Global chip (bottom of map) shows the *worst relevant source state*; per-event chips show
  that event's own observation history. When a source is stale, the chip is where the banner
  logic anchors (§5.2.6).
- Both absolute local time and relative age, always. Rural users reason in clock time
  ("обед", "по тъмно"); relative-only labels ("47 min ago") fail screenshots and shares.
- The `[?]` affordance is mandatory on every chip — it is the single most-travelled path to
  the methodology content, i.e. to trust.

#### 5.2.3 Confidence display

Consumer tier mapping (P5), presented as words + glyph + opacity (never hue):

| Tier | Label (EN / BG concept) | Backing rule (owned by the confidence-formula owner) | Rendering |
|---|---|---|---|
| Confirmed | "Confirmed by satellite" | ≥2 passes or ≥2 sources or EFFIS BA overlap | Full-opacity marker, solid ring |
| Likely | "Likely fire" | Single high/nominal-confidence detection, fire-compatible land cover | Full marker, no ring |
| Unverified | "Unverified detection" | Single low-confidence or ag-burn-suspect | 60% opacity, dotted ring, excluded from default alerts |

Additions:

- **Suspected agricultural burn** and **known industrial source** are *labels on top of
  tiers*, not tiers ("Likely fire · possibly agricultural burning" / masked entirely for the
  static hot-source list per summary T5). Labeling suspected ag burns instead of hiding them
  preserves honesty while preventing panic (U4).
- Numeric confidence, per-source values and FRP appear only in the analyst disclosure
  (§5.3.4) and the v2 API. Raw FIRMS l/n/h or 0–100 never reach consumer UI.
- The escalated open question from 00-summary stands: the formula needs an owner; UX consumes
  the tiers, it must not define them ad hoc.

#### 5.2.4 Decay and "no longer detected" — never "out"

Lifecycle rendering (aligned with the architect's decay-gated-by-expected-passes rule):

| State | Trigger | Visual | Copy |
|---|---|---|---|
| New | Event created < ~6 h, recent obs | Largest marker, pulsing halo (reduced-motion-aware) | "New — first detected HH:MM" |
| Active | Re-observed on latest pass | Standard red/orange, size by FRP class | "Active — last observed HH:MM" |
| Cooling | Missed 1–2 expected passes OR FRP declining | Smaller, desaturating toward ember-brown | "Cooling — last observed HH:MM (N passes ago)" |
| **No longer detected** | ≥N missed expected passes (N from QA S7 tuning), sources healthy | Gray, hollow, small; leaves red space entirely | "No heat detected in the last N satellite passes. This can mean the fire is out, smoldering below what satellites can see, or hidden by cloud." |
| (frozen) | Source stale | State frozen at last value + stale styling | "Satellite data delayed since HH:MM — status not current" |

Rules:

- The word **"out"** never appears in UI or alerts (the event's internal `out` state is an
  engineering lifecycle, not a user-facing claim). The user-facing terminal state is
  epistemic: *we no longer see it*.
- "No longer detected" events remain findable (permalink, history, 7-day reignition window
  per ADR-002 direction) but drop from the default map after a tunable window (open question
  Q5) — clutter vs. reassurance-by-absence needs a deliberate call.
- Cloud cover deserves explicit mention when known (FCI cloud mask in v1): "Cloud cover over
  this area — satellites may not see surface heat" is a massively trust-building sentence.

#### 5.2.5 Detection vs FireEvent in the UI

Vocabulary contract (BG terms to be finalized with a native copywriter, concepts fixed):

- **FireEvent** → "fire" in consumer copy, always place-anchored: "Fire near Harmanli".
  Subtitle always "satellite-detected".
- **Detection** → "satellite detection" — only visible at high zoom and in the event's
  history timeline ("14:32 — VIIRS pass: 12 detections, intensity rising").
- **Footprint hull** → "detection area", drawn soft/dashed, legend text: "area where
  satellites detected heat — not a fire perimeter". The word "perimeter" is reserved for
  official/EFFIS burned-area products, attributed as such.

#### 5.2.6 Stale-source banners — the map fails open, visibly

Three-level degradation, one design system:

```
Level 1 — SOURCE DELAYED (e.g. FIRMS stale > 2× cadence, FCI alive):
┌─────────────────────────────────────────────────┐
│ ⚠ Some satellite data delayed — detailed        │
│   (VIIRS) data last received 12:05. Fast        │
│   (Meteosat) updates continue.        Details → │
└─────────────────────────────────────────────────┘

Level 2 — ALL SOURCES DELAYED:
│ ⚠ Satellite data delayed — showing last data    │
│   from 12:05. Fire status may have changed.     │

Level 3 — OFFLINE / ORIGIN DOWN (PWA cache or R2 static snapshot):
│ ⚠ You are offline / service degraded — map      │
│   shows data from 12:05.  Emergency? Call 112.  │
```

Rules: banner colors are *not* red/orange (style-lint); the banner never covers the map's
primary interaction zone; each level names the timestamp of the last good data (the snapshot
artifact carries `generated_at` + per-source `last_observed_at` — render from those); event
decay freezes under Level 1–2 (T6) and the frozen state is stated on event cards. "Details"
links to the public status page (off-infrastructure, security D5).

### 5.3 Information hierarchy on the map

#### 5.3.1 The 10-second contract (panicked user, 5 km from smoke)

In order, the panicked user needs: **(1)** is the thing I can smell/see known — is there a
marker near me; **(2)** how far and which direction from *me*; **(3)** how big/intense;
**(4)** which way is the wind; **(5)** how current is this; **(6)** what do I do → 112.
Nothing else belongs on the first screen. Concretely:

- Geolocate affordance is a primary, thumb-reachable button; on permission grant the map
  shows a distance line to the nearest active event ("4.2 km NE of you") — computed
  client-side, no location leaves the device (privacy stance worth stating in UI).
- Marker salience order = recency × intensity (already the age/intensity encoding), capped so
  that ten small events don't out-shout one large one.
- The freshness chip is persistently visible without interaction (P2).
- "In danger? Call 112" is inside the event panel, styled as guidance, not a scare header.

Mobile default screen (360×640; production default BG, EN shown for review readability):

```
┌─────────────────────────────────────┐
│  FireWatch          [BG|EN]   [≡]  │ ← 1 thin bar, no menus-first UX
│┌───────────────────────────────────┐│
││ (stale banner slot — usually empty)││
│└───────────────────────────────────┘│
│                                     │
│      ●3           ◉ ←new, pulsing   │
│   (muted outdoor        halo        │
│    basemap,                         │
│    fire = only red)    ○ ←cooling   │
│                                     │
│                          [◎ locate] │
│                          [▤ layers] │
│                          [☰ list]   │
│┌───────────────────────────────────┐│
││ 🛰 Data observed up to 14:32       ││
││   next update ~16:10–16:40    [?] ││ ← global freshness chip
│└───────────────────────────────────┘│
└─────────────────────────────────────┘
```

#### 5.3.2 Zoom-dependent rendering ladder (P6)

```
z ≤ 7   "country view"    ● 4     capped cluster dots + count,
                                  sized by aggregate class (never raw sum)
z 8–11  "valley view"     ⬠~~~   event footprint: concave hull of
                                  detections, soft dashed edge,
                                  label = event name + age;
                                  legend: "detection area, not a perimeter"
z ≥ 12  "slope view"      ▢ ▢    individual detection footprints (~375 m,
                          ▢       ~2 km for Meteosat, drawn true-size),
                                  tap → per-detection time/source/intensity
```

Rules learned from the FIRMS teardown: cluster symbols have a **max size** and a **max count
badge** ("9+") so a bad day never renders as apocalypse; footprints render *under* the
marker so the dot stays scannable; Meteosat's coarse 2 km pixels (v1) are drawn as their
honest large squares with distinct labeling ("early signal — approximate location") rather
than resampled to look precise; cooled events shrink and leave the red hue family entirely.

#### 5.3.3 Event detail panel (bottom sheet mobile / side panel desktop)

```
┌─────────────────────────────────────┐
│ ▔▔▔                                 │
│ Fire near Harmanli        [↗ share] │
│ SATELLITE-DETECTED · CONFIRMED      │
│                                     │
│ 🛰 Observed 14:32 (47 min ago)      │
│    Next update ~16:10–16:40     [?] │
│ 📍 4.2 km NE of Harmanli            │
│ 🔥 Intensity: high — rising         │
│ 💨 Wind now: 18 km/h from NW        │
│                                     │
│ [ In danger? Call 112 · BG-ALERT ]  │
│ ─────────────────────────────────── │
│ ▸ Detection history (12 detections, │
│    3 passes — VIIRS ×2, Meteosat)   │
│ ▸ About this data / sources         │
│ Satellite data may be 15 min–3 h    │
│ old and can miss fires. Not an      │
│ official warning system.            │
└─────────────────────────────────────┘
```

Above the fold: the 10-second set only. Disclosure sections: detection timeline (each row =
pass time, source, detections, intensity class), data provenance, permalink. Wind is *context*
("wind now: from NW"), never prediction — no spread arrows, no projected polygons
(non-goal in ANALYSIS; also a liability line we must not cross).

#### 5.3.4 The B2B analyst's first 10 seconds (contrast, v2)

The analyst monitoring a PV park polygon needs: which monitored polygon, distance from asset
boundary (not centroid), FRP trend chart, per-source detection table with raw confidence,
export (CSV/GeoJSON), audit log of alerts sent. All of this lives in an org-account surface
(v2) or behind a "Data" disclosure tab — never in the consumer panel (U14). The consumer
panel's restraint *is* the product; the analyst gets density, the resident gets clarity.

#### 5.3.5 Night use / dark mode as a first-class scenario

Fires are checked at 23:00 on balconies and at 03:00 in evacuations. Requirements:

- **Auto-dark by local sunset** (with manual override + follow-system option); ADR-001's dark
  variant is thus a launch feature, not a preference.
- Fire palette calibrated separately for dark: the same reds at full saturation on
  near-black halo/bloom; verify the CVD ΔE00 checks (QA §5.4) run against *both* themes.
- No large white surfaces (panels are dark-translucent); marker halos, not screen flashes,
  carry the "new event" signal; `prefers-reduced-motion` disables pulsing.
- Dark map on OLED is also the battery-saver posture (§5.8.5) — one design, two wins.

### 5.4 MVP screen inventory

#### 5.4.1 Map (default route `/`)

As specified in §5.3. Includes: layers sheet (base layers: light/dark/auto; overlays: burned
areas (EFFIS), danger mode entry point), locate, list toggle, language switch, global
freshness chip, stale banner slot. **No login, no signup prompt, ever, on this route.**

#### 5.4.2 Event detail: panel + page + permalink

The panel (§5.3.3) expands to a full page at `/event/{id}` — same content plus full detection
timeline and a small static map. The permalink is a hard product requirement on ADR-002:
event IDs survive merges (aliases/tombstones redirect old URLs to the surviving event). A
shared link that 404s during a fire is a trust incident. Share action produces the OG card
(P14) with name, freshness stamp, confidence tier — never a bare screenshot.

#### 5.4.3 Danger forecast mode (FWI) — a mode, not an overlay (P9)

Entering "Danger forecast" (from layers sheet): live events reduce to outlined markers, the
EFFIS FWI WMS renders with its conventional ramp (consistency with official communications
matters more than palette purity *inside a dedicated mode*), legend switches to plain-language
classes ("Tomorrow: Extreme danger in Sakar"), a date stepper covers today +1..+6. Exiting
restores the live view. Rationale: stacking a red-ramp raster under red fire markers breaks
both the salience contract (U9) and the QA style-lint's spirit; a mode keeps "red = one
meaning" per view. The WMS is consumed via the SRE-mandated cached proxy, never browser-direct.

#### 5.4.4 About / Methodology + "How fresh is this data?"

Two pages, one trust system:

- **About/Methodology**: who runs this and why; how detection works (satellite → FIRMS/LSA
  SAF → our clustering) with one honest diagram; what we can and cannot see (small fires,
  cloud, latency); relationship to official channels (§5.6.2); full attribution; link to
  postmortems/status.
- **"How fresh is this data?"** — the `[?]` target from every freshness chip: the satellite
  cadence explained in one screen (polar passes ~4–6×/day + ~3 h processing; Meteosat every
  10 min + 15–30 min processing, from v1), with a live "today's passes" strip. This page will
  be the most-linked page in arguments on Facebook — write it for that context.

#### 5.4.5 Supporting surfaces

Legal/privacy page (required from day one — server logs; security B6), off-infrastructure
status page (security D5) linked from stale banners, and the share-card renderer (P14).

#### 5.4.6 Language & place localization

BG default, EN toggle, `lang` persisted; all times Europe/Sofia with explicit tz handling (QA
G7). Place context is localized too (U12): nearest-settlement names from a BG-label-bearing
source (OSM `name:bg` where present), transliteration fallback for cross-border places
("Serres (Сяр)"), distances in km always. Event names are generated per-language from the
same anchor place.

#### 5.4.7 Explicitly OUT of MVP

Accounts and anything requiring them; watch zones/alerts (v1, after shadow period);
crowdsourced reports (v1+, gated on moderation); curated incident log (v1, major fires only);
smoke/air-quality layer; satellite imagery toggle; Telegram/Viber bots; SMS; offline map
packs beyond PWA shell+snapshot caching; history scrubber/time slider (v1); analyst mode and
exports (v2); embeddable media map (v2, has its own security scope); any push notification
of any kind; onboarding tours beyond the 3-card first launch (§5.9.1).

### 5.5 Alert UX (v1)

Alerts ship in v1 only, after the QA shadow period and behind the security review's gateway/
budget architecture. UX must make three promises true: *relevant* (my places), *rare*
(tiered, suppressed, digested), *explainable* (why/why not).

#### 5.5.1 Watch-zone creation flow (P15)

```
[1] Entry: "Add a place to watch" → map centered on geolocation or search
    ("village, town, or landmark" — the Genasys-style single search bar)
[2] Pin + radius: circle drawn live; slider 2–30 km, default 10 km.
    Copy: "We'll alert you about fires detected inside this circle."
[3] Privacy (default ON): "Store approximate location (~1 km) — alerts work
    the same."  [?] → explains the security design in one paragraph
[4] Name: auto-suggest "Home — Harmanli" (place-based; editable)
[5] Sensitivity: (•) Confirmed fires — recommended
                 ( ) Confirmed + likely — earlier but noisier
    (maps to confidence floor + persistence; engine params never exposed)
[6] Channel + double opt-in: push (enable on this device) / email
    (verification mail; zone shows "pending" until confirmed)
[7] Zone card: shows radius on map, sensitivity, quiet-hours setting,
    [Send test alert] button, alert history link
```

Notes: min radius 2 km when coarsening is on (coarsening error ≪ radius, so the default-ON
privacy choice costs nothing — this is why product should harden security's "option" into the
default, P15); radius semantics (distance to event centroid vs footprint edge) must match
the engine and be stated in the copy — currently undefined, escalated as open question Q4;
free tier zone count (e.g. 2 zones free, more with membership) is a business call — Q3.

#### 5.5.2 The shadow-period UI

During the 2-week shadow (QA gate), users can create zones but see: "Alerts are in
calibration — you'll start receiving them on ~D. Here's what you *would* have received this
week" (their zone's shadow log). This converts the QA process into a transparency feature and
seeds the explainability surface with real data before the first real push.

#### 5.5.3 Alert taxonomy and tiers (P16)

| Type | Trigger | Default urgency | Quiet hours |
|---|---|---|---|
| `new_fire` | First alertable event in zone (per sensitivity) | High — sound | **Overrides by default**; user can restrict to "confirmed only" or turn override off |
| `escalation` | Reignition after "no longer detected", or major intensity/area jump (merge inherits notified state — never re-fires as new) | Medium | Respects quiet hours unless zone marked "always wake me" |
| `digest` | Daily 09:00 summary while ≥1 event active in any zone ("Fire near Harmanli still active — last observed 06:14") | Low — silent | Never overrides |

Copy rule inherited from the no-all-clear invariant: there is **no "resolved" notification
type**. The digest naturally stops when nothing is active; the zone page states per event
"no longer detected" with the §5.2.4 copy. Users will ask for an "it's over" push — the
answer is the digest's absence plus the honest event state, never a push that says safe.

#### 5.5.4 Quiet hours vs urgency

Default quiet hours 22:00–07:00 apply to medium/low tiers. The `new_fire` override default-ON
is a deliberate stance: a person who saved a zone around their house has expressed exactly one
intent — wake me. But the settings copy must be honest about the medium: "Push delivery is
best-effort and depends on your phone's settings — do not rely on it as your only warning"
(the not-a-life-safety disclaimer, made concrete at the exact point of expectation-setting).

#### 5.5.5 Alert content anatomy (templated-only, P18)

```
┌──────────────────────────────────────────────┐
│ FireWatch                                    │
│ New fire detected 6 km from "Home —          │
│ Harmanli"                                    │
│ Satellite observation 14:32 · confirmed ·    │
│ 4.2 km NE of Harmanli · intensity high ·     │
│ wind now 18 km/h from NW                     │
│ → firewatch.bg/e/ev_8fk2 (map & updates)     │
│ ──────────────────────────────────────────── │
│ Satellite-based; may be delayed or           │
│ incomplete. Emergency? Call 112.             │
│ Official warnings: BG-ALERT.                 │
└──────────────────────────────────────────────┘
```

Rules: observation time in the body (never only "now"); place names, never raw coordinates
(also security B1 for email bodies); wind is context, not prediction; deep link to the
permalink (which carries the live state — the push is a pointer, not the product); footer
disclaimer in every alert (security G1); all strings from the reviewed template catalogue —
free-text sends don't exist below the two-person T-approve tier.

#### 5.5.6 Explainability: "why did/didn't I get an alert" (P17)

- **Why-this-alert page** (linked from every notification): zone, matched event, sensitivity
  setting, rule/config version (already logged per QA §5.7), the triggering detections on a
  mini-map, and dispatch/delivery timestamps. One screen, no jargon, shareable.
- **Why-no-alert checker** (on the zone page): lists recent events within 2× the zone radius
  and, per event, which gate applied — below sensitivity tier, outside radius (with actual
  distance), suppression window active, quiet hours held it (with the digest reference),
  delivery failed (with channel status), or source outage window (with the stale period).
  This is the INT-2 (missed fire) playbook turned into self-service, and it is the strongest
  trust artifact the product can own: nobody in this market can answer "why didn't you tell
  me" with a screen instead of a shrug.
- Alert history per account (also the GDPR export artifact, security §5.3.7).

### 5.6 Trust & credibility design

#### 5.6.1 Methodology transparency and attribution (P12)

Attribution (NASA FIRMS, Copernicus/EFFIS, EUMETSAT/LSA SAF, OSM) is a license duty —
design it as a credential: per-event provenance line ("VIIRS · NOAA-20 · NASA FIRMS"),
the About-page pipeline diagram, and the freshness explainer together say *we didn't invent
this data; here is exactly where it comes from and how old it is*. That posture is
unfalsifiable in a way "trust our algorithm" never is.

#### 5.6.2 Relationship to official channels: complement, never replace

- Every event panel and every alert carries the 112 / BG-ALERT line. Position: "Fire Watch
  shows what satellites see. Emergency decisions belong to official services."
- Never render evacuation semantics, never re-broadcast BG-ALERT content as our own, never
  editorialize against an official statement. If officials declare a fire extinguished while
  we still see heat, both facts can coexist on the event page — each with its source and
  timestamp ("ГДПБЗН, 16:00: extinguished" as a *curated log entry* in v1 · "last satellite
  heat detection 15:47") — stated, not argued. The product's voice states observations;
  sources own claims.
- Seek contact with ГДПБЗН/municipal civil protection early — not for data (none is
  machine-readable yet) but so the first time they hear of the product isn't a journalist's
  question during an incident. (Open question Q9.)

#### 5.6.3 The disclaimer that doesn't paralyze (P13)

The legal review (security §5.7.1) requires layered presence; the UX craft is tone and
placement so it reads as *capability statement*, not fear-of-lawyers boilerplate:

- **First launch (once, logged):** 3 cards — (1) "Satellite fire map for Bulgaria & the
  Balkans"; (2) "Data arrives 15 min–3 h after the satellite passes — we always show you
  when"; (3) "Not an official warning system. It can miss fires. In an emergency, call 112."
  Buttons: "Show the map". No account, no email ask.
- **Persistent:** one compact line in the event panel footer and the About page's full
  version. Not a recurring modal, not an interstitial — repetition breeds banner blindness,
  which is the *opposite* of the legal intent.
- **Every alert:** footer per §5.5.5 (this is where legal presence matters most — alert
  recipients may never visit the site).
- Phrasing pattern: capability → limitation → action. "Shows satellite detections, usually
  15 min–3 h after observation" → "can miss small, short or cloud-hidden fires" → "emergency:
  112". Banned framings: anything starting with "WARNING: do not rely…" (paralyzing), and any
  softener that implies completeness ("comprehensive", "real-time" unqualified, "monitors all
  fires").

#### 5.6.4 Owning errors in public

Adopt Watch Duty's deepest trust practice, mandated anyway by security INT-1/INT-2: public,
plain-language postmortems within 72 h, linked from About ("Incidents & corrections"). The
first honest "we alerted 40 minutes late and here is the timeline from the append-only log"
will do more for credibility than any marketing. The append-only architecture makes the
receipts possible; the product should promise their publication in advance (that promise
itself is a differentiator no official channel makes).

### 5.7 Crowdsourced reports UX (v1/v2, gated on moderation capacity)

Constraint inherited whole from security §5.2.5: **reports are evidence, never triggers** —
they never notify, never create public events alone, and surface publicly only at Tier 1+
(corroborated) or Tier 2 (verified).

- **Submission flow:** from the event panel ("I can see this fire") or map long-press ("Report
  smoke/fire here") → map-picked location (draggable pin; device GPS only pre-fills), category
  (smoke / flames / smell of smoke), optional photo (EXIF stripped server-side, B8), optional
  one-line note; account with verified email required. Expectation copy at submit: "Thank you.
  Reports help verify satellite data. They do not trigger alerts and appear publicly only
  after corroboration."
- **Rendering:** Tier-1 reports draw as a small **blue-gray eye/binocular glyph** — outside
  the fire hue range (style-lint compliant by construction), smaller than any event marker,
  beneath events in z-order, labeled "Unverified ground report" on tap. Tier-2 verified
  reports appear as entries in the event's timeline ("16:05 — ground report verified:
  smoke visible from Topolovgrad road"), attributed as reports, never restyled as detections.
  Reports never join detection clusters, never affect footprints, never change event state
  visually.
- **Reporter feedback loop:** the reporter sees their report's status (received → visible
  (corroborated) → verified / not confirmed) in their profile — closing the loop is what
  sustains the volunteer behavior and feeds the trust ledger without exposing scores publicly.
- **Anti-abuse UX:** the security ladder's freeze tool ("mass-false-report polygon") needs a
  user-side face: in a frozen area, submission remains possible but shows "reports in this
  area are under review" — abuse containment without telling abusers they're contained.

### 5.8 Accessibility & inclusivity

#### 5.8.1 CVD-safe encoding (coordination with QA §5.4)

The QA review already specifies the mechanism (hue-never-alone; size + symbol + halo
redundancy; ΔE00 ≥ 15 under deuteranopia/protanopia/tritanopia simulation, or the redundant
channel asserts). Design-side commitments: the legend teaches the *shapes* ("pulsing halo =
new; filled = active; hollow = cooling; gray = no longer detected"), the event panel always
states class in words, and confidence uses opacity + ring style (never a second hue family
that would collide with the age encoding). Both themes run the check.

#### 5.8.2 Older rural users and low digital literacy

The primary at-risk user is a 60-year-old in a Sakar village on a mid-range Android:

- **List view (P10)** as a peer surface to the map: "Fires near you" — distance-sorted rows
  of "Fire near X — 12 km — active — observed 14:32". This is also the `aria-live`/screen-
  reader strategy (map canvas is exempt; the DOM list is the accessible twin) and the
  fastest surface on weak devices.
- Plain-language BG throughout: no FRP, NRT, VIIRS, FWI in consumer strings — "сила",
  "сателитно наблюдение", "опасност от пожари". Jargon lives behind the `[?]` layers.
- Type floor 16 px body / 20 px key facts / distance figures display-size; system font stack;
  touch targets ≥ 44 px (QA matrix); test at OS font scale 200% — panels must reflow, not
  truncate the freshness line (the one line that must never be clipped).
- One-hand reach: primary actions bottom-anchored (locate, list, event sheet).

#### 5.8.3 Panic ergonomics

Under stress, working memory collapses: max 5 facts above the fold (§5.3.3), one action verb
per element, no confirmation dialogs on read paths, the 112 affordance always in the same
place. Never animate anything the user must read.

#### 5.8.4 Offline / weak signal (PWA)

- App shell + last snapshot + visited-area tiles cached by the service worker; offline
  launch shows the map with the Level-3 banner (§5.2.6) — data age writ large, never a blank
  "you are offline" dead end.
- Weak-signal mode (Save-Data header or manual toggle): skip hillshade/DEM rasters and WMS,
  snapshot polling only (no SSE), no photos. Rural 3G is a first-class network profile (ADR-
  001 already budgets map-interactive ≤ 10 s on Fast 3G — hold the line).
- Copy honesty: cached data states its age; the app never renders a cached snapshot without
  the timestamp adjacent.

#### 5.8.5 Battery saver

During an evacuation a phone's battery is a survival resource: honor OS battery-saver by
disabling pulsing halos and SSE (fall back to slow snapshot polling), dark map default at
night (OLED), no continuous GPS (locate is on-demand), and no wake locks. State it in About —
"designed to sip battery during emergencies" is a feature users tell each other about.

### 5.9 Onboarding & seasonality

#### 5.9.1 Onboarding: three cards, then the map

Specified in §5.6.3. Nothing else — no permission walls (geolocation requested only when the
user taps locate; notification permission requested only when creating a zone in v1, never on
first launch: browsers punish premature prompts and users rightly distrust them).

#### 5.9.2 The February problem (U11)

A fire map in February shows nothing — by design. Off-season value, in priority order:

1. **Burned-area explorer** [v1 off-season, P20]: EFFIS final perimeters + our Sentinel-2
   dNBR severity + per-municipality stats ("your municipality: 1,240 ha burned in 2026, 3rd
   worst year"). This is also the B2B demo surface and the journalists' magnet — media
   citations off-season are the cheapest install channel for next June.
2. **Season report** (shareable, annual, November): the year's fires, biggest events with
   permalinks, data honesty stats (our detection latency distribution, published — the
   receipts culture again).
3. **Season-start ritual** (May): the single permitted off-season push — "Fire season begins.
   Check your watch zones; here's what changed." Also the moment to re-verify notification
   permissions that browsers may have quietly revoked.
4. **Danger mode gains prominence off-season shoulder** (April/May grass-burning, October):
   the FWI forecast has genuine shoulder-season value while detections are sparse.
5. What we do *not* do: engagement mechanics, streaks, newsletters beyond consented ones,
   "come back" nags. A crisis utility's retention is *being remembered as trustworthy*, not
   DAU. Measure success as: season-start returning users, zone retention rate, and
   permission survival rate — not off-season MAU.

#### 5.9.3 Growth motion (season one)

The free map + share cards + burned-area explorer are the growth loop: every major fire
produces shareable, timestamped, place-named permalinks that outperform screenshots of FIRMS
in every Facebook group thread — exactly where the audience already is (ANALYSIS validation
plan step 2 targets those groups). Media outreach kit: embeddable static share images per
event (full embeddable live map is v2, per security Q6).

---

## 6. Open questions for the product owner

1. **Event naming & permalink contract:** place-anchored auto-names ("Fire near Harmanli",
   collision-suffixed) — acceptable? And is permalink stability across merges formally part
   of ADR-002's acceptance criteria (this review assumes yes)?
2. **Confidence tier ownership:** who writes the Confirmed/Likely/Unverified mapping spec
   (formula → tiers → words), given 00-summary already flags the formula as unowned? UX is
   blocked on the tier boundaries, not the formula internals.
3. **Free-tier shape for v1:** how many free watch zones (proposal: 2) and which alert
   channels are free vs membership (€15–25/yr) — this decides several settings screens.
4. **Radius semantics:** does "fire within my zone" mean event centroid, any detection, or
   footprint intersection inside the circle? The engine and the zone-creation copy must
   match; propose *any detection* (most protective, simplest to explain).
5. **"No longer detected" display window:** how long do gray events stay on the default map
   (proposal: 48 h on map, 7 days via permalink/history, matching the reignition window)?
   Balances clutter against reassurance-by-absence.
6. **FCI early-signal rendering (v1):** separate "early signal" layer with coarse honest
   pixels, or fused into events with a "fast source" badge? (Interacts with QA open Q8 on
   cross-source dedup — the UX answer depends on the fusion design.)
7. **List view in MVP:** this review argues it's cheap and triple-duty (a11y, panic, weak
   devices) — confirm it's in MVP scope rather than v1.
8. **Curated incident log capacity (v1):** who writes BG editorial updates for major fires,
   under what SLA, and does the two-role security model (editor ≠ alert-operator) have the
   named people? (Echoes security open Q1 and QA open Q5.)
9. **Official relationship:** do we proactively brief ГДПБЗН/BG-ALERT stakeholders before
   launch (recommended), and do we ever *display* official evacuation info as curated log
   entries with attribution, or strictly link out in v1?
10. **Brand & domain:** name/domain decision gates the phishing-defense work (defensive
    registrations, DMARC — security T17) and all copy; "not officially affiliated" needs to
    be visually unambiguous from the logo up (no state symbolism, no "national").

---

## 7. Sources

Benchmarks and research consulted for this review (in addition to the project corpus):

- Watch Duty — Wikipedia (model, volunteers, scale, editorial policy): https://en.wikipedia.org/wiki/Watch_Duty
- Watch Duty — App Store listing (positioning: "real people, not robots"): https://apps.apple.com/us/app/watch-duty-wildfire-floods/id1574452924
- Apple Design Awards 2025 — Watch Duty, Social Impact winner: https://www.apple.com/newsroom/2025/06/apple-unveils-winners-and-finalists-of-the-2025-apple-design-awards/
- TechCrunch — Watch Duty #1 free app during LA fires (Jan 2025): https://techcrunch.com/2025/01/09/watch-duty-surpasses-chatgpt-as-top-free-app-on-app-store-as-california-fires-spread
- KPBS — how Watch Duty curation works: https://www.kpbs.org/news/public-safety/2025/09/26/watch-duty-app-is-revolutionizing-how-residents-firefighters-stay-updated-on-wildfires
- UXmatters — UX Design for Crisis Situations: Lessons from the LA Wildfires: https://www.uxmatters.com/mt/archives/2025/03/ux-design-for-crisis-situations-lessons-from-the-los-angeles-wildfires.php
- Genasys Protect — communication zones ("know your zone"): https://genasys.com/genasys-protect/communication-zones/
- Genasys Protect — finding your zone & statuses: https://help.genasys.com/articles/finding-your-evacuation-zone-information
- Shasta County — Genasys zone statuses (Order/Warning/Advisory): https://www.shastacounty.gov/information-technology/page/evacuation-zones-and-statuses-genasys-protect
- Genasys Protect public map: https://protect.genasys.com/alerts
- NASA FIRMS Fire Map: https://firms.modaps.eosdis.nasa.gov/map/
- NASA Earthdata — FIRMS data tool in focus (hotspot misinterpretation at scale): https://www.earthdata.nasa.gov/news/feature-articles/data-tool-focus-fire-information-resource-management-system
- Bellingcat toolkit — FIRMS caveats (hotspots ≠ fires; industrial/glint false positives): https://bellingcat.gitbook.io/toolkit/more/all-tools/nasa-firms
- Mapscaping — VIIRS hotspot map interpretation pitfalls: https://mapscaping.com/map-real-time-fire-detection/
- EFFIS Current Situation Viewer: https://forest-fire.emergency.copernicus.eu/apps/effis.csv/
- EFFIS — About: https://forest-fire.emergency.copernicus.eu/about-effis
- Copernicus EMS Rapid Mapping portfolio (delineation/grading, activation-based): https://mapping.emergency.copernicus.eu/about/rapid-mapping-portfolio/
- Sutton et al. 2025 — Opting Out: Over-alerting and Warning Fatigue in the era of Wireless Emergency Alerts (Journal of Contingencies and Crisis Management): https://onlinelibrary.wiley.com/doi/10.1111/1468-5973.70076
- Behavioral response to mobile phone evacuation alerts (arXiv, 2025 — diminishing response to repeated alerts): https://arxiv.org/html/2503.21497

---

*End of review. This document is the product/UX baseline for Fire Watch. Revisit after the
FIRMS latency ground-truth experiment (validation plan step 1 — it calibrates every number in
the freshness chip), after ADR-002 fixes event identity (permalink contract), and before any
alert copy is written (§5.5.5 templates + §5.6.3 disclaimer set are the first copy
deliverables).*
