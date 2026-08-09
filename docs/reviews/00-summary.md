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

## Where the corpus stands

Twelve reviews, one synthesis, zero code — by design. The skeleton survived twelve
different senior lenses with no fatal finding; every unresolved item is either an ADR
away (002–005), a backfill experiment away (week 1), or a founder decision with a named
deadline. The pre-code phase has done its job when ADR-002 and ADR-005 are written and
the ANALYSIS.md amendments land — after that, the honest next step is code.
