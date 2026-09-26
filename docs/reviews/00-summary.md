# Review round 1 synthesis — six senior role reviews

*Date: 2026-07-21. Inputs: `01-architect.md`, `02-backend.md`, `03-geodata.md`, `04-sre.md`,
`05-security.md`, `06-qa.md`, each reviewing `docs/ANALYSIS.md` + `docs/decisions/001-map-stack.md`.*

## Verdicts

All six reviews returned **conditional GO**: the skeleton (ports & adapters, append-only
detections, FireEvent as core entity, PostGIS day one, aggregation-not-detection thesis,
flat-cost tiles) held up under every lens. The conditions cluster into six convergent themes —
independently raised by multiple roles, which is the strongest signal this round produced.

## Convergent themes (what multiple roles found independently)

### T1. FireEvent identity under merge/split is THE unsolved design problem
*Raised by: architect (critical), backend (high), geodata (top-3), QA (open question).*
Alerts, URLs and SSE clients all hang off an event ID, while naive re-runs of batch DBSCAN
produce unstable IDs (re-fired alerts, broken links). Convergent solution across reviews:
**incremental assignment on the hot path** (attach/create/merge, permanent IDs, merge
tombstones + aliases, no automatic splits at MVP), with offline `ST_ClusterDBSCAN` demoted to
a tuning/audit role. Per-source ε (≈1.5/3/5 km for VIIRS/MODIS/GEO), ~48 h linking window,
reignition window ~7 days. **Action: write ADR-002 from 01-architect §deep-dive +
02-backend §clustering + 03-geodata §clustering before any ingestion code.**

### T2. Read path must be CDN-snapshot-first; SSE demoted to enhancement
*Raised by: architect (high), SRE (top finding), security (DDoS), QA (load test target).*
With a 5–10 min data cadence, per-request DB + SSE-first is the most fragile design exactly
during the spike that defines this product. Convergent solution: edge-cached
`active-events.geojson` snapshot (30–60 s TTL) as the default transport (~1–3 origin req/s at
100k users), SSE as optional layer with a connection cap, third tier = static snapshot on R2
that survives total origin death. "Map fails open, alerts fail closed."

### T3. The alert pipeline needs reliability AND safety engineering it currently lacks
*Raised by: architect (critical), backend (outbox in MVP schema), security (top finding),
SRE (mass-alert math), QA (alert state machine).*
Convergent design: **transactional outbox** written in the same commit as event transitions;
alert state machine per (zone, event) with idempotency keys and merge-aware suppression;
**Notification Gateway** as the single component allowed to send, with blast-radius budgets,
templated-only content, two-person rule for manual broadcasts, upstream-anomaly circuit
breaker (map keeps rendering, alerts pause), kill switch, append-only send audit; per-channel
token buckets (Telegram ~30 msg/s → 50k alerts = 28 min unless prioritized by distance).

### T4. "Or serverless" must be deleted from the analysis
*Raised by: backend, SRE, QA (and implied by architect).* Resident 5-min pollers + SSE require
a persistent process. Single VM, two composition roots (`server.ts`/`worker.ts`) from day 1.
Corollary from SRE: managed-Postgres free tiers don't survive a 24/7 poller (Neon CU-hours,
Supabase pause/500MB) — **PostGIS local on the VM at MVP**, managed PG is the first paid
upgrade at v1. *(Applied to ANALYSIS.md §5.)*

### T5. False-positive suppression is MVP-critical, not "later"
*Raised by: geodata (top finding), architect (medium), QA (golden scenarios S3/S4).*
Static hot-source mask (Maritsa Iztok TPPs, Neftochim, cement plants — derived from 2020–2025
backfill: cells hot in ≥8 distinct months, cross-checked vs CORINE/OSM) is **mandatory before
alerting ships**. Agricultural-burn filtering belongs in MVP. The historical backfill
(~150–400k rows for BG, trivial volume) moves to **week 1** — it feeds the mask, the
clustering tuning, the QA golden datasets, and the demo at once.

### T6. Silence must be suspicious: freshness observability + meta-alerting
*Raised by: SRE (top finding), architect (high — decay gating), QA (canary design).*
Per-source freshness is SLI #1. Event decay must be driven by *missed expected overpasses*
(pass predictor), frozen while a source is stale — otherwise a FIRMS outage mass-"extinguishes"
every fire on the map. Three independent alerting legs (Grafana Cloud + healthchecks.io per
job + external probe on a `/api/health/freshness` endpoint that 500s when stale); canary
zones; "0 detections >36 h during high FWI" pages as a bug, not peace.

## Factual corrections to ANALYSIS.md (from 03-geodata — applied)

1. FIRMS URT is "within ~5 min" (detection 25–50 s), US/Canada only; **RT is North America
   only** — for Bulgaria only NRT exists.
2. MTG FCI: target **LSA SAF FRP-PIXEL (LSA-509)**, not L2 FIR (classification, no FRP);
   realistic latency **15–30 min**, not "minutes"; integration ≈ 1–2 weeks (Python sidecar).
3. EFFIS NRT burnt areas are **MODIS/VIIRS-based** (Sentinel-2 only refines finals).
4. FIRMS `day_range` counts UTC calendar days — always poll with `day_range=2`.
5. Terra/Aqua (MODIS) near end of mission — VIIRS ×3 is the backbone; Sentinel-3 SLSTR FRP
   fills the pre-noon blind window.
6. Serverless removed; managed-PG free-tier assumption removed (see T4).

## Notable single-role findings (no cross-confirmation, still important)

- **Backend:** FIRMS dedup key (`source|satellite|observed_at|lat4|lon4`, `ON CONFLICT DO
  UPDATE` refinement-only); only *inserted* rows trigger clustering/SSE. Official
  `@fastify/sse` now exists (built-in Last-Event-ID replay). Stack: TypeBox, Kysely + dbmate,
  croner (BullMQ/Redis rejected), PostGIS-only geo math. NRT→SP reconciliation via monthly
  partition swap.
- **Security:** watch zones are a registry of home coordinates — app-layer encryption with
  coarse grid-cell index for matching, precision-reduction option, ≤30-day deletion incl.
  backups, DPIA before v1; crowdsourced reports are "evidence, never triggers" (verification
  ladder, no auto-notification); cookie sessions + magic link, WebAuthn for staff; HMAC-signed
  webhooks; IR playbooks for false-alert / missed-fire / breach.
- **SRE:** tile-plan trap — PMTiles behind a free-tier Cloudflare Worker dies at 100k req/day
  (~1000 sessions); serve exploded z/x/y from R2 or pay $5/mo Workers in season. EFFIS WMS is
  never hit from browsers (10–15 min cached proxy). Cost model lands at €6–21/mo. VAPID
  private key is a tier-0 secret. ADR-001's "Phase 2" (own tiles) should be Phase 1 —
  launch IS the spike for this product.
- **QA:** launch gates — PCR ≥95% (≥50 ha fires, vs EFFIS perimeters), zone-alert precision
  ≥85%, duplicate-alert rate ≤5%, controllable-latency p95 ≤15 min; 2-week shadow period
  before public alerts; 9 named golden replay scenarios with a virtual clock modeling NRT
  latency; style-lint that fails CI if a non-fire layer uses red/orange; CVD-safe encoding;
  fire-season release gate + shadow-mode rollout of clustering changes.
- **Architect:** full port nomenclature (14 named interfaces), migration-001 sketch,
  quarantine guard for anomalous batches, config-driven AOI for multi-country from day 1.

## Consolidated pre-code action list

1. **ADR-002: FireEvent identity & incremental clustering** (T1) — blocks all ingestion code.
2. **ADR-003: read-path tiers** (snapshot-first / SSE / static fallback) (T2).
3. **ADR-004: alert pipeline** (outbox + state machine + Notification Gateway + circuit
   breaker) (T3) — outbox tables land in migration 001 even though channels ship in v1.
4. Amend ADR-001: own tiles (R2, exploded z/x/y) become Phase 1; EFFIS WMS proxy noted (SRE).
5. Week-1 task: FIRMS 2020–2025 backfill for BG bbox → hot-source mask + tuning + QA fixtures
   + demo dataset (T5). Start recording live FIRMS fixtures **this fire season** (backend/QA).
6. Adopt the QA launch gates and the security [GATE-v1] list as the definition of "alerting
   may ship".

## Open questions escalated to the product owner

- Confidence score formula and its UX meaning (all roles touch it, nobody owns it).
- "Out" semantics: when do we dare say a fire is over (QA/architect — never "all clear"
  messaging vs. event lifecycle needing an end state).
- Solo-operator on-call reality during fire season (SRE/QA) — what does "paging" mean for a
  one-person team, and what degrades gracefully when nobody answers.
- Moderation capacity as a launch precondition for crowdsourced reports (security).

---

# Round 2 synthesis — six more senior reviews (07–12)

*Date: 2026-07-22. Inputs: `07-product-ux.md`, `08-frontend.md`, `09-legal-licensing.md`,
`10-business-gtm.md`, `11-data-science.md`, `12-fire-domain.md` — the dimensions round 1 did
not cover (product/UX, frontend/PWA, legal & licensing, business/GTM, data science, fire
domain). Round-1 engineering conclusions were taken as fixed inputs, not re-litigated.*

## Verdicts

Six for six again: **08 (frontend) and 11 (data science) are unconditional GO**; 07, 09, 10
and 12 are **conditional GO**. No review found a reason to stop; every condition is a
definition of "done honestly" rather than a redesign. Two of round 1's open questions —
the confidence score and the "out" semantics — now have owners and concrete normative
designs (T8/T9 below).

## Convergent themes (found independently by multiple roles)

### T7. The product is a fire-*situation* service, not a fire-*detection* service
*Raised by: fire-domain (the verdict itself), product-UX (honest-clock as "the product"),
business (trust as the moat), data-science (what the numbers can honestly claim).*
The modal Bulgarian fire (<10 ha, hours) is over before the first satellite pixel exists;
the product's real subjects are campaign fires (~90% of burned area), smoke, danger
forecasts, and the diaspora. Consequences: the honest use-case statement (12 §verdict) goes
into ANALYSIS.md and UI copy verbatim; no marketing language may imply first-alarm
detection; every screen answers *when observed, when next, what this cannot see* (07 §5.2).
Executed well, the latency handicap becomes the trust moat — no competitor communicates
uncertainty honestly, including official tools.

### T8. "No longer detected" is now solved — statistically, verbally, and visually
*Owned by: data-science (the rule), fire-domain (the words), product-UX (the display).*
The rule (11 §5): survival analysis over *clear-sky observation opportunities* — a cloudy
pass is zero evidence; transition at weighted miss-evidence **E ≥ 3.0** (night VIIRS 1.25,
day VIIRS 1.0, MODIS 0.5, GEO conditional) **and** ≥24 h **and** misses in both diurnal
phases; E ≥ 5.0 for large/smoldering events; estimated false-"out" ≤3–7%, bounded by
reignition-reopen. The words (12 §4): "Active detection (last HH:MM)" → "Weakening signal"
→ "Not detected by satellites since <t>. This does not mean the fire is out" → official
"локализиран/ликвидиран" only quoted with ГДПБЗН attribution. Reignition windows are
fuel-specific: 7 d grass/stubble, 14 d shrub, 21–30 d large conifer. The display (07):
gray events stay 48 h on the map, 7 d via permalink. The internal `→out` state in the
architecture diagram is renamed `→no-longer-detected`/`→archived`. New QA metric: **FER
(false-extinguished rate) ≤5%**. This closes round 1's second open question and feeds
directly into ADR-002's lifecycle section.

### T9. The confidence score has an owner and a formula
*Owned by: data-science; UX mapping by product-UX.*
Bounded logistic score `P(real vegetation fire | evidence)` over 10 features — the key
insight being that **distinct overpasses, not detection counts**, carry the evidence
(within-pass detections are correlated; noisy-OR explicitly rejected). v0 hand-set weights
with worked examples; v1 regularized logistic regression fitted on backfill snapshots
labeled by EFFIS/dNBR/news corroboration, Platt-calibrated. UX: three buckets —
**Confirmed ≥0.75 / Likely 0.45–0.75 / Unverified <0.45** — rendered by label + glyph +
opacity, never hue (red/orange stays reserved for fire salience). "Unverified" always
carries "may still be a real fire". The additive sketch in 03-geodata §5.2.3 is
superseded. The score is explicitly *not* severity, spread risk, or safety. Remaining
handoff: 07 needs the tier-boundary spec frozen before settings/zone screens are designed.

### T10. False reassurance is the #1 harm across every lens
*Raised by: product-UX (top critical risk U1), fire-domain (the single biggest harm risk),
data-science (absence-of-evidence formalism), frontend (staleness banner as one shared
mechanism), security round 1 ("map fails open").*
An empty or faded map read as "no fire / fire is out" is the most dangerous misread the
product can produce — Voden 2024 is the case study of the official-channel gap costing
houses. Freshness banners are a domain-safety requirement, not a UX nicety; when a source
is down the lifecycle freezes (T6) and there is no "safe" state anywhere in the product;
"no detections ≠ no fire" copy appears wherever absence could be read as assurance.

### T11. Never borrow authority — vocabulary, symbols, or message types
*Raised by: product-UX (second GO condition), fire-domain (terminology as credibility
gate + never-send list), legal (liability follows conduct; name clearance), business (no
state symbolism in brand).* No "contained", "out", "safe", "all clear", no evacuation
statuses of our own; official operational states only quoted with attribution and link;
the never-send message list (12 §3.4) becomes hard policy enforced in Notification Gateway
templates (extends T3); no routes/navigation toward fires, centroid + uncertainty zone
instead of a precise pin, "do not travel to the fire area" on every event page (12); brand
name avoids "национален/държавен/агенция" and state symbols — both a registration-refusal
ground (ЗМГО чл. 11) and a liability amplifier (09, 10).

### T12. The business is a civic asset with hybrid revenue — and season 1 is free
*Raised by: business (the re-framed thesis, conditions C1–C4), product-UX (trust precedes
monetization), legal (paid tier gated on entity/ToS/VAT scaffolding), fire-domain
(tolerance earned by accuracy).* Honest B2C math: €500–5k/yr symbolic supporter revenue
(9% streaming-subscription rate, ~1–2% conversion ceiling); the money is B2B — beachheads
are (1) energy/PV parks & grid, (2) the six state forestry enterprises + ИАГ, both under
the ЗОП direct-award ceiling (€25,565). Funding line: CASSINI Challenges 2027 (€100k,
accepts individuals, wildfire winner precedent; **no ESA BIC Bulgaria exists**) + НИФ +
EEA/Norway Green Business 2027; no consortium instruments in year 1. Conditions: season 1
free/ad-free/registration-optional; don't quit primary income; B2B LOI + one funding
application before any paid tier; the freemium boundary ("safety information never
paywalled") published as a permanent principle. Legal staging matches: [GATE-MVP]
attribution + name + disclaimers; [GATE-v1] ЕООД + consumer ToS + VAT posture + withdrawal
mechanics; [GATE-v2] B2B contracts + Data Act check.

## Extensions and corrections to round-1 themes

- **T5 extended (masks):** the ≥8-distinct-months hot-source mask will miss Bulgaria's
  2023–2026 solar-PV boom (post-dates the backfill) — add an OSM solar-farm layer and a
  quarantine rule for day-only recurrences (11 §6.2). Agri-burn context tagging ships
  *with* the map, not after it (12, GO condition 4): a March map of red dots over Danubian
  cropland destroys professional credibility; muted "possible agricultural burn" tag with
  suppressed default alerts, upgraded to a normal event on ≥2-pass persistence.
- **T1/ADR-002 gets numbers:** pixel-geometry-derived ε ranges (VIIRS 1.0–1.5 km, MODIS
  adaptive 3–5 km, GEO 5–6 km), T_LINK from the empirical p99 of intra-fire gaps (36–72 h
  bracket); grid search ~600 configurations on EFFIS-labeled backfill, plateau-based
  selection, chimera-rate metric. Round-1's 48 h / 7 d become fitted values with CIs
  before any live alert depends on them (11 §4).
- **QA validation caveat (new risk):** **EFFIS circularity** — EFFIS NRT perimeters are
  themselves MODIS/VIIRS-derived, so the round-1 PCR ≥95% gate partially validates the
  inputs against themselves. Mitigate with final S2-refined perimeters, dNBR spot-checks
  on 150–200 events, and news/ГДПБЗН corroboration (11 §9.2).
- **T2/T6 in the client:** the reconciler is the frontend's crown jewel — five rules
  (snapshot owns the *set*, seq owns the *version*; deltas never delete, snapshots never
  create; double-confirmed absence before removal) with property-based tests before any
  UI (08 §5.2). One source-health model drives one banner slot; users never see
  "connection error", only an honest timestamp.

## Notable single-role findings

- **Frontend (08):** Preact + @preact/signals (~6 KB gz) over the "React" placeholder,
  behind a framework-free TypeScript core (event store, feed adapters, map controller) —
  needs a short ADR-005. **iOS EU Web Push verified against Apple's own DMA page: it
  works** — 2026 posts claiming otherwise recycle the reversed Feb-2024 plan; but push
  requires Home-Screen install → install-first flow + Telegram as an equal channel.
  Budgets: ≤350 KB gz critical path (MapLibre v6 = 251 KB of it), map-ready ≤6 s on a
  €150 Android/4G, Lighthouse CI from commit 1. PWA: injectManifest SW, three cache
  tiers, ~80 MB tile LRU; push permission asked only at zone creation.
- **Legal (09):** the licensing thesis holds — every core fire source permits commercial
  derived FireEvents with attribution only (FIRMS CC0; EUMETSAT/LSA SAF CC BY 4.0 with
  redistribution; Copernicus/EFFIS/GWIS open). The only genuine copyright trap:
  **EOX Sentinel-2 cloudless 2018+ is CC BY-NC-SA** (drop or license); Esri imagery only
  via an ArcGIS Location Platform account, never the bare endpoint, no SW caching. The
  ready-to-paste attribution block is in 09 §2.4. No licensing regime exists for private
  fire-information services in BG (verified negative); НК чл. 326 (false alarms) is the
  criminal-law boundary → verify user reports, label unconfirmed, never present as
  official. 12 questions for a real lawyer collected in 09 §10.
- **Business (10):** the consumer niche is verifiably empty (no BG fire app; EU Fires has
  no Bulgarian; Google wildfire boundaries exclude BG). Sharpest near-term threat: the
  indie EU Fires app adding Bulgarian (a week of work); long-term: FireSat data through
  Google 2027–28 commoditizing raw detection — defence is local depth. Biggest risk:
  seasonality × solo founder (demand, press, alert load and the only vacation window all
  in the same 10 weeks). Go/no-go checkpoints CP1 (Oct 2026), CP2 (Apr 2027), CP3
  (Oct 2027). VAT: 2026 threshold is €51,130 with the new EU SME scheme to €100k EU-wide;
  Paddle (MoR) supports BG sellers and kills OSS admin for a €8–13/yr supporter tier.
- **Data science (11):** the single most load-bearing unknown is **p_det for the
  smoldering phase** (priors span 0.5–0.95) — backfill priority #1; persistence-label
  leakage is a named trap when fitting confidence weights; with ~2–5k events, logistic
  regression + Platt scaling is the honest ceiling ("anything deeper is numerology").
- **Fire domain (12):** Bulgaria has **no public scanner traffic** (TETRA encrypted) —
  the Watch Duty curation model must stand on ГДПБЗН bulletins, municipal Facebook pages
  and БТА instead; дка/ха confusion in media requires both units everywhere in BG UI;
  fire regime is bimodal (March–April agri window, July–September main season) with two
  fuel worlds (fast SE grass–shrub vs. long SW conifer campaigns) needing different
  product behavior; ГДПБЗН will be indifferent-to-suspicious — the goal is tolerance
  earned by accuracy, not endorsement.

## Consolidated new actions (adds to the round-1 list)

1. **ADR-002 inputs are now complete:** lifecycle wording ladder (12 §4), decay rule
   (11 §5), fitted-parameter methodology (11 §4), permalink/merge stability as acceptance
   criteria (07). Write it next — it still blocks all ingestion code.
2. **ADR-005: frontend framework & core boundary** (Preact + framework-free core, 08 §5.1).
3. **Amend ANALYSIS.md:** insert the honest use-case statement (12), rename the `→out`
   state, replace the "React" placeholder with a pointer to ADR-005.
4. **Ship-with-map items:** attribution block (09 §2.4), agri-burn context tag (12/T5),
   freshness banner + "no detections ≠ no fire" copy (T10), list view in MVP (07).
5. **Imagery decision:** drop EOX 2018+ (or use 2016/2017 layers); Esri only via ALP
   keys if at all [GATE-MVP].
6. **Never-send list → Notification Gateway templates** (12 §3.4, extends T3/ADR-004).
7. **Name/brand clearance** before any brand investment: ЗМГО чл. 11 screen + EUTM search;
   no official-sounding names or symbols (09 §7, 10).
8. **Backfill work order grows:** hot-source mask + OSM solar layer + clustering grid
   search + confidence-weight fitting + p_det estimation + FER measurement — same week-1
   dataset serves all six.
9. **Founder/legal one-offs:** entity form & timing decision (ЕООД vs hybrid — 1-hour
   accountant consult on чл. 194 ЗКПО closes the open tax question); CASSINI 2027 calendar
   watch; 3–5 interviews with volunteer formations before v1 alert routing (10).

## Open questions escalated across reviews

- **Confidence tier boundaries** (07 ↔ 11): the formula has an owner; the frozen
  tier-spec handoff to UX does not yet — small, but blocks zone/settings screens.
- **Fade-and-persist vs. removal** for "no longer detected" events (11 Q9 ↔ 07 Q5):
  proposal on the table (48 h map / 7 d permalink; large events keep burnt perimeter for
  the season) — needs a product decision.
- **Evacuation-order relay** (12 Q2 → legal): is verbatim push relay of official orders
  safe (a 40-min-late relay is a new harm vector), or in-app curated items only in v1?
- **Solo curation capacity in season** (12 Q1, echoes round-1 SRE/QA): what does the
  product show when curation lags during a Sakar-type week — and is the answer designed,
  not improvised?
- **Identity decision** (10 Q1): civic institution vs. company — deferrable to ~CP3, but
  branding, legal form and partnerships will force it; the Watch Duty evidence favours
  the civic frame with a commercial B2B arm.

# Round 3 synthesis — the four seats nobody filled (16–19)

*Date: 2026-08-25. Inputs: `15-role-gap-analysis.md`, which asked which senior seats the
first two rounds never staffed, then `16-editorial.md`, `17-hardware-rf.md`,
`18-support-continuity.md`, `19-accessibility-inclusion.md`. Unlike rounds 1 and 2, these
reviewed the corpus **as it stood in August 2026** — including `GATES.md`, `RISKS.md`,
`OPERATIONS.md`, `IMPLEMENTATION-PLAN.md` and `DATA-SOURCES-EXTENDED.md`, all written after
round 2 closed.*

## Why a third round

Round 15's method was two tests: **T-A**, does a decision in the corpus have an owner; and
**T-B**, does an artifact have an author. A role that fails T-A but passes T-B is the most
dangerous shape — the documents exist, so the gap is invisible. Four seats failed T-A, and
the meta-finding was the reason to fill them: **a finding with no seat behind it is a
finding that will be rediscovered at cost.** Nine candidate roles were considered and five
rejected with the owning section cited (15 §5) — privacy/DPO into 05, database reliability
into 03/04, meteorology into 11/12 — so the question does not have to be reopened.

## Verdicts

All four returned **conditional GO**, with one partial hold: hardware (17) is CONDITIONAL GO
on the €100–400 receive dish and **HOLD on everything else** until the licence answer, a
paying customer or grant, and a named maintenance owner exist.

## Convergent themes (found independently by all four new roles)

### T13. Every new seat found the same shape: a decision already taken, an owner missing
The public curated voice is a product the corpus ships without an editorial standard (16);
a satellite receive station is a purchase the source survey already scheduled as wave 2
without deciding what owning hardware means (17); "1–2 volunteer moderators" is a headcount
appearing in a risk mitigation and a DoD with no pipeline behind it (18); and accessibility
is a set of good fragments with no target, owner or gate (19). In all four cases the work
was *planned* and unowned — which is exactly the T-A failure round 15 predicted.

### T14. The solo operator is now the binding constraint, and the load has never been summed
Editorial found that "moderation and curation are the same hours" (16 §5.9). Support summed
the whole corpus at **~15–35 h/week at peak, on top of a day job** (18 §5.9.2). Hardware
found that maintenance capacity, not budget, caps any field fleet (17 §5.8.5). Accessibility
found its own work scheduled into March–April 2027, the most contended month in the plan
(19 §5.9.4). Four unrelated lenses converged on two windows — **August peak** and
**March–April pre-season** — and on the same conclusion: the levers are all already in the
corpus, but they are a budget that must balance, not independent options.

### T15. Honesty has to be perceivable, not merely true
Round 1's T6 was "silence must be suspicious" for data freshness. Round 3 generalised it
four ways: a screen-reader user gets no degradation banner if it is drawn on the canvas, so
invariant 3 is *false* for that user (19 §5.4.4); a user cannot distinguish "no official
statement exists" from "nobody swept today", so curation needs its own visible clock
(16 §5.6); a field sensor that stops reporting looks identical to a forest that stopped
burning, so every field asset must heartbeat independently of its measurement (17 §5.8.4);
and an unanswered person does not degrade gracefully to a T2 fallback (18 §5.1).

### T16. Anything without a gate drifts; each new review converted a preference into an artifact
L-15 and L-16 now exist. So do the four-question hardware ownership rule (17 §5.1), the
four-tier source ladder and the admin form that refuses to save without a capture
(16 §5.2, §5.10), the continuity file (18 App. B), the seasonal manual accessibility pass
(19 App. B), and a proposed canvas/DOM parity check. The corpus's own history is the
evidence: everything with a gate has held, everything with only a recommendation has drifted.

## Extensions and corrections to earlier themes

- **T3 (alert reliability *and* safety) gains a third axis: perceivability.** The alert is
  the one surface with no accessible fallback — if the push is unreadable, there is no
  second surface (19 §5.3).
- **T10 (false reassurance is the #1 harm) now has a second source.** Round 2 traced
  reassurance to the *absence* of a detection; 16 traces it to our own curated voice, which
  is worse because it is affirmative. Hence the never-publishable list and the two-source
  rule with three named exceptions.
- **T11 (never borrow authority) extends to language.** 16 §5.7: never publish a
  translated operational state — an official Bulgarian statement stays in Bulgarian, quoted
  verbatim, with the translated frame around it. 19 §5.7.4 reached the same rule
  independently from the accessibility side.
- **T12 / R3's cost ceiling is corrected upward in scope.** A €100–400 dish amortises with
  its tail to roughly €10–25/month — comparable to the *entire* infra line (17 §5.4). The
  ≤ €25/mo ceiling is a total, and hardware competes inside it.
- **04's July open question is answered.** "What does owning hardware mean for a solo
  operator?" now has a testable answer: unplugged-safe, a named servicer within reach, a
  three-year cost inside R3, and a defined outcome if the project stops (17 §5.1).
- **CP3's sunset branch is now executable.** "Data archived and published" had one verb
  doing all the work; 18 §5.5.4 and 17 §5.10 together specify it.

## Notable single-role findings

- **Editorial (16):** a measurement-independence defect invisible from inside either
  document — `RISKS.md` §2 makes news-log corroboration "the independent CER leg" while
  `GATES.md` §4 makes the same named curator responsible for the public curated voice. The
  product's accuracy metric would be scored by the judgement it measures. Fix: source-first
  sweep, blinding, one-way flow.
- **Hardware (17):** the normative rule that keeps the purchase safe — *the EUMETCast
  station is an optional accelerator; no code path may depend on the station's presence.*
  Also the liability line the project should never cross casually: a lithium battery in a
  solar enclosure in dry forest, owned by a wildfire-safety product, would be **our** fire.
- **Support (18):** someone will write "има пожар над село X, какво да правим", possibly at
  02:40. An automatic first-line-112 auto-reply is a mail-filter rule that removes the worst
  failure mode in the corpus for approximately zero cost. Separately: invariant 5 is the
  only promise in the project with an unbounded horizon and no continuity mechanism.
- **Accessibility (19):** the argument the legal review missed — CP3 counts media embeds and
  the GTM plan targets municipalities, which are public-sector bodies with their own Web
  Accessibility Directive obligations. An inaccessible embed is a distribution problem
  wearing an accessibility costume. Also the reduced-motion trap: the pulsing halo *is* the
  "new event" fact, and `prefers-reduced-motion` deletes it.

## Consolidated new actions (adds to the round-1 and round-2 lists)

1. **`GATES.md` §3 gains L-15 and L-16** — editorial standard published with the correction
   path rehearsed; accessibility target declared and verified. Both **landed**.
2. **`RISKS.md` §2 gains three watchlist rows** — hardware-commitment creep (17 R-1),
   curated-statement error (16 R-1), single-operator archive survival (18 R-2). **Landed.**
3. **Before the beta serves real users:** one support inbox with a published, deliberately
   weak undertaking; the life-safety auto-reply; the standing reply set; and a routed clock
   for privacy/legal contact (18 §5.3–§5.4).
4. **The continuity file and the archive continuity plan** — custodian, licence, one annual
   deposit outside our infrastructure, domain runway, published degradation path (18 §5.5).
5. **Into WP6's admin form:** the required-field set (tier, source URL, capture, curator,
   second source, justification), refusing T4 sources and refusing to save without a
   capture; the `curated_correction` state; a "last curation sweep" timestamp (16 §5.5–§5.10).
6. **Into WP4's spec, decided in December rather than March:** the parity fact list, the
   alert-path requirements, and a non-drag path to arming an alert (19 §5.3–§5.4).
7. **The four-question ownership rule** becomes the standing pre-purchase test for any
   physical asset (17 §5.1); wave 6 (X-band) stays sequenced licence → customer → maintenance
   owner → capital.
8. **Resolve the WCAG version disagreement into one documented target** (19 §6 Q1) — two
   live accessibility targets is worse than either one.

## Open questions escalated across reviews

- **Who is the second person?** 16 §6 asks for someone who can do a curation sweep; 18 §6
  asks for someone who can answer an inbox for two weeks in August and hold the continuity
  file. Same person, plausibly the same recruit — the strongest cross-review convergence of
  round 3.
- **Does crowdsourced reporting ship in the 2027 season at all?** 16 §5.9 says no on
  capacity grounds; 18 §5.6.4 says no independently, because volunteer availability is
  anti-correlated with need. If both are accepted, the moderator line re-scopes from
  "moderator for reports" to "second reader and cover" — a much easier recruit.
- **WCAG 2.1 or 2.2, and who decides?** An open disagreement with 09 §4.3, stated rather
  than silently applied (19 §6 Q1).
- **What licence does the archive carry, and where is the second copy deposited?** (18 §6 Q2.)
- **Does the Turkish alert locale ship?** Decide at CP2 with reach data; the binding
  constraint is a safety-translation reviewer, not engineering (19 §5.7.6).
- **Does an embed pull us into a public body's accessibility perimeter?** → 09 (19 §5.1.4).
- **Is the October recovery block real,** given CP1's report is due 31 October inside it
  (18 §5.9.3)?

# Round 4 synthesis — the seats the implementation opened (20–23)

Round 4 differs from the three before it in one way that matters: it reviews a *build*, not a
design. Rounds 1–3 read documents; round 4 read the working tree, the CI workflow, the
provisioning contract, the repository's settings through the API, and the WORKLOG that
recorded eighteen sessions of agent-dispatched implementation. The seats it filled were
opened by that implementation, not by anything a design review missed.

## Why a fourth round

Review 15's stopping rule said a new review is commissioned only when a document written after
the corpus closed creates a decision nobody owns. Review 20 re-ran 15's two tests (decision
ownership T-A, artifact ownership T-B) over fourteen post-corpus artifacts and found three
seats missing — all three of the shape 15 called dangerous, where an artifact exists and the
decision it embodies has no owner: the provisioning contract with a cap decision deferred to
"§9-level policy"; a ~35,000-line uncommitted codebase with no rule for when it is integrated;
an archive with a versioned plan and no dataset identity, lineage rule or retention owner.
Eleven candidate roles were tested and rejected in 20 §5, including a re-test of fire
meteorology (still rejected; the trigger is now sharpened to "the day `DATA-SOURCES.md` §D6's
own-FWI line becomes code") and a re-affirmation that database reliability stays with 03.

## Verdicts

All three returned **conditional GO**, and all three conditions are dated:

- **21 (platform & release):** GO conditional on the user-data cap decision this week and on
  the seven-day ordered path to a host being started before further D-track work.
- **22 (engineering practice):** GO conditional on the founder asking for the integration series
  this week — a founder act under TASKS §0 rule 4 — and on rule 8 being adopted or refused.
- **23 (data engineering & stewardship):** GO conditional on a dataset record before D7 starts,
  a retention owner this month, and field-level retention floors before the poller runs
  unattended.

Review 20 itself concludes that none of the three gaps is fatal and that all three are cheap
to close now and expensive to rediscover later.

## Convergent themes (found independently by all three new roles)

1. **The three clocks are one clock.** No host (21 R-1), no integration (22 R-1), no recording
   (23 R-4/R-9) are the same finding seen from three seats: every day without a provisioned,
   deployed, recording VM is a day of unbackfillable shadow-season data (DATA-SOURCES §E2),
   and the plan's own hard date for it — "early September 2026" — has passed. 21 §5.7 gives
   the sequence; 21 §6 Q6 asks the D-track to pause for it; 23 E5 lists what each unrecorded
   day costs.
2. **Artifacts whose owner was assumed.** The deploy pipeline is assumed by OPERATIONS §9.3,
   review 04 §5.6 and `infra/README.md` and exists in none (21 §5.2). Integration is assumed
   by every gate and has no cadence rule (22 §5.1). Retention is assumed by the backup schedule
   and OPERATIONS §6.2 rule 11 says in writing it has no owner (23 §5.3). This is review 15
   §7.3's dangerous shape three times over, and it is why round 4 exists.
3. **Doc-to-code drift, found three ways.** L-12 and L-15 require a staging environment review
   04 §6 Q7 ruled out (21 §5.6); GATES said 02:30 where a passing test said 03:30 (22 §5.5);
   TASKS A19 declares the Open-Meteo cloud proxy for CP1 where the code records ECMWF `tcc`
   and fences Open-Meteo out (23 §5.4). Parameter drift is impossible in this codebase because
   every tunable has a digest; prose drift has no mechanism. 22 E6 proposes one.
4. **The project's own candour made the round possible.** `infra/README.md`'s "Honest status"
   block, WORKLOG entries that record wrong assertions and dead agents, OPERATIONS rule 11's
   "no owner", the `fuelBand: null` comment that says "not a stand-in". All three reviews cite
   the project's record of itself more than they cite their own inspection.
5. **Almost nothing new in the gates.** One launch gate added (L-17, one deploy path and a
   passed restore drill); two CI gates proposed and escalated, not added (override expiry,
   doc-pinned numbers); two existing gates asked to be reworded (L-12, L-15). Round 4 is
   decisions and code, not more gates — which is what 15's stopping rule predicted.

## Extensions and corrections to earlier themes

- **15 §7.1 (data stewardship folded into 18):** condition met in substance — the archive now
  owes a named corpus to the fit, a lineage rule to the permalinks, a retention rule to itself
  and NOAA-21 rows to L-14. 18 §5.5 keeps survival unchanged; 23 takes the rest and says it
  closes when its records are absorbed (23 §5.8).
- **13 B2 (protection before the poller):** asserted, not built — the restore half is two
  stubs that exit 64 and the R2 backup token is write-only by design, so a restore credential
  does not exist. 21 E6 and §5.7 make the ordering executable.
- **04 §6 Q6 (retention):** answered by proposal in 23 E3 with an owner and a date.
- **04 §6 Q7 (no staging) vs L-12 checkbox 6 and L-15:** both documents are right and the
  gate text is wrong; 21 E8 proposes "rehearsal profile" wording, escalated as a disagreement.
- **05 §5.6.1 (branch protection, environments):** asked in June, still unset; API-verified
  (21 §5.3). SHA-pinned Actions and Renovate *were* done.
- **06 §5.2 ("outcomes, not internals"):** challenged for identity fixtures, where the
  transitions are the outcome; 22 E4 proposes an optional `trace` block and escalates (22 Q7).
- **06 §5.7 (shadow rollout):** cannot start this season without a deployed baseline; 22 Q5
  asks GATES to say the first season's D-track changes are pre-baseline.
- **ADR-002 A1.4 (promotion):** correct and honest in the code; 23 E2 asks the ADR for the
  three sentences about what a permalink shows after the swap, escalated (23 Q2).

## Notable single-role findings

- **21:** the rendered provisioning payload is 49,431 bytes against a 32,768-byte provider cap,
  the script correctly refuses to submit it, and the choice between slimming the contract and a
  pre-signed `#include` has been deferred since the file was written. Recommendation: slim.
- **22:** measured, not assumed — six commits all on 2026-08-09; 208 untracked source files,
  34,968 lines; 86 of 130 test files untracked; `main` unprotected; CI last ran on the last
  commit. The harness inside the tree caught two wrong hand-derived traces in one session; the
  process that produced them is unchanged.
- **23:** FIRMS serves NOAA-21 as NRT only, so the SP corpus cannot contain it and L-14's
  2027-constellation replay depends entirely on live rows the poller records this season and
  keeps. A 56-day window applied by habit deletes a launch gate's input.

## Consolidated new actions (adds to the round-1, round-2 and round-3 lists)

1. **`GATES.md` §3 gains L-17** — one deploy path, restore-proven. **Landed.** Two CI gates
   (override expiry, 21 E4; doc-pinned numbers, 22 E6) are proposed, not added.
2. **`RISKS.md` §2 gains three rows** — no delivery path to a host (21 R-1), unintegrated
   single-copy codebase (22 R-1), archive without dataset identity or retention owner (23 R-1).
   **Landed.**
3. **This week, founder:** decide the cap (21 E1, option 1 recommended); ask for the
   integration series (22 E1) and protect `main` (21 E5); start 21 §5.7 day 0 (accounts,
   secrets, `production` environment).
4. **Before the poller runs unattended:** RB-2 written, restore credential minted off-VM,
   drill passed on a scratch VM (21 E6); the record-now table with retention floors (23 E5);
   the cloud-proxy discrepancy resolved (23 E4).
5. **This month, founder:** retention with an owner (23 E3); the CP1 protocol and
   `docs/reports/` (20 §7 Q2); TASKS §0 rule 8 adopted or refused (22 E2); the `[~]` progress
   marker and the pending-decisions block (22 E5). **Block landed** in TASKS §0 (fifteen
   decisions, one line each, dated and due); the `[~]` marker waits for the 06 author.
6. **Before D7 starts:** the dataset record (23 E1) — **opened** as `docs/data/DATASETS.md`
   with DS-1 (SP archive), DS-2 (season-1 live record), DS-3 (EFFIS labels) and DS-4 (GEO
   2025), every one unfetched and dated blank; engine-derived, human-reviewed traces
   (22 E4 rules 1 and 3).
7. **Not in this season:** publication and deposit (23 E9), static-data provenance (23 E7),
   drift detection as a job (21 E9), the dispatch model written down (22 E7).

## Open questions escalated across reviews

Those with a decider and a date first:

- **Founder, this week:** the cap (21 Q1); the integration ask (22 Q1); does the D-track
  pause (21 Q6).
- **Founder, this month:** retention (23 Q1); where rule 8 and the review standard live
  (22 Q2); the stopping-rule amendment (20 Q1); the pending-decisions block (20 Q3).
- **Gate owners:** L-12/L-15 "staging" wording (21 Q2, with the 06 author); 06 §5.2 versus
  an optional trace block (22 Q7); shadow rollout pre-baseline (22 Q5).
- **ADR-002 owners:** the permalink-after-swap sentences (23 Q2).
- **11 author:** is ECMWF `tcc` an honest enough cloud proxy for CP1 (23 Q3).
- **Open, no deadline:** CI-16/CI-17 (21 Q3, 22 Q3); the restore credential's holder
  (21 Q4); who reviews the harness (22 Q6); output licence memo (23 Q5); whether 23 persists
  as a seat (23 Q7); what the corpus is now called (20 Q6).

## Where the corpus stands

Nineteen role reviews across four rounds, two audits, two role-gap analyses, four syntheses.
Rounds 1 and 2 tested the *skeleton* and found no fatal flaw. Round 3 tested the *seats* and
found four decisions with no owner. Round 4 tested the *build* and found three more — none
fatal, all three of the dangerous shape, all three now carrying a dated condition, a risk row
and a named decider instead of an assumption.

The stopping rule stands as review 15 wrote it, with review 20 §7 Q1's amendment proposed and
not yet adopted: **after round 4 the corpus grows only on a founder request that names the
ownerless decision.** The practice seats were the last structural gap a review could fill.
What remains is not review. It is the founder decisions with dates on them — the cap, the
integration ask, retention, the CP1 protocol — the gates that now exist and must be met, and a
host running code that has been committed.
