# Review 11 — Data Science / Spatiotemporal Statistics

*Role: senior data scientist, remote sensing & spatiotemporal statistics (active-fire products).*
*Inputs reviewed: `docs/ANALYSIS.md`, `docs/reviews/00-summary.md`, `docs/reviews/03-geodata.md`
(closest prior work — extended, not duplicated), `docs/reviews/06-qa.md` (metrics & golden
scenarios — all evaluation designs below are compatible with it).*
*Date: 2026-07-22. Project status: pre-code; ADR-002 (clustering identity) in progress;
2020–2025 FIRMS backfill scheduled for week 1.*

*Mandate: this review owns the three questions escalated from the prior round —
(a) the confidence score formula, (b) statistical grounding for clustering parameters,
(c) the semantics of "no longer detected".*

---

## 1. Summary verdict

**GO, with the statistical layer specified below adopted as the normative design.** The prior
round built the right skeleton (append-only detections, event-centric core, incremental
clustering, backfill in week 1) and correctly identified that the statistical layer — what the
numbers *mean* — was unowned. This review closes that gap with three concrete deliverables:

1. **Confidence score (§3):** a bounded logistic score `P(real vegetation fire | evidence)`
   with an explicit v0 formula (hand-set weights, worked examples), a v1 fitting recipe
   (regularized logistic regression on backfill snapshots labeled by EFFIS/dNBR/news
   corroboration), a calibration protocol (reliability diagrams, Platt scaling), and a
   3-bucket UX mapping (**Confirmed ≥ 0.75 / Likely 0.45–0.75 / Unverified < 0.45**). The
   additive score sketched in 03-geodata §5.2.3 is **superseded** (rationale in §3.11). The
   score is explicitly *not* severity, spread risk, or safety.
2. **Clustering tuning (§4):** a labeled evaluation set built by matching backfill detections
   to EFFIS burnt-area perimeters, pairwise precision/recall + over-merge/over-split metrics,
   a ~600-configuration grid search per source, plateau-based parameter selection, and
   pixel-geometry-derived expected ranges (ε VIIRS 1.0–1.5 km, MODIS adaptive 3–5 km,
   GEO 5–6 km; T_LINK 36–72 h — pick the empirical p99 of intra-fire detection gaps).
   The 48 h / 7-day numbers in ADR-002 are plausible priors; the backfill turns them into
   fitted values with confidence intervals before any live alert depends on them.
3. **"No longer detected" (§5):** formalized as survival analysis over *clear-sky observation
   opportunities*. A cloudy pass is zero evidence; a clear-sky miss is strong evidence.
   Concrete rule: weighted miss-evidence **E ≥ 3.0** (night VIIRS miss = 1.25, day VIIRS = 1.0,
   MODIS = 0.5, GEO conditional) **AND ≥ 24 h elapsed AND misses spanning both diurnal
   phases** → "no longer detected"; **E ≥ 5.0** for large/smoldering-prone events. Estimated
   false-"out" probability ≤ 3–7% by event class, bounded by the 7-day reignition-reopen.
   The user-facing claim is exactly what the statistics license: *"N unobstructed satellite
   opportunities since last detection — no fire seen"*, never "extinguished", never "safe".

The main risks this review adds to the register: **EFFIS circularity** (EFFIS NRT perimeters
are themselves MODIS/VIIRS-derived — naive validation validates the inputs against
themselves; mitigations in §9.2), **solar-PV mask drift** (Bulgaria's PV boom post-dates most
of the backfill — the ≥8-distinct-months mask will miss 2024–2026 solar farms; §6.2), and
**persistence-label leakage** in confidence fitting (§3.7). All three have concrete
mitigations below. On data volume (§10): with ~2–5k events, logistic regression and Platt
scaling are the honest ceiling; anything deeper is numerology.

---

## 2. Strengths of the current design (from a statistics seat)

Keep all of these — they are what makes the statistical program below *possible*:

1. **Append-only detections + replayable clustering runs** (03-geodata §5.2.5, QA §5.2). Every
   method in this review is an offline experiment over immutable history. This is the single
   most valuable property of the design.
2. **Backfill in week 1** (T5). All tuning, calibration, mask derivation, and threshold
   selection below run on it. Nothing here requires waiting for a live season.
3. **Event-level scoring, detection-level storage.** The confidence score is an event
   property recomputed from raw detections — it can be re-derived under any future formula
   without data loss.
4. **The QA metric framework (PCR/CER/ZAP/DAR)** is exactly the right shape; this review
   plugs into it rather than inventing a parallel one, and adds two metrics (FER §5.8,
   calibration error §3.8).
5. **Honest-freshness UX as first-class data** — the "no longer detected" statistics of §5
   are only communicable because staleness is already a rendered concept.
6. **Per-source ε and the pass-predictor idea** (T6) were both correctly anticipated; this
   review supplies the numbers and the estimation method.

---

## 3. The FireEvent confidence score (the centerpiece)

### 3.1 What the score means — and what it does not

**Definition:** `confidence_score ∈ [0,1]` is the calibrated probability that the FireEvent
corresponds to a **real, currently-or-recently-burning vegetation fire** (wildland or
agricultural), given all detections attached to the event so far and its geographic context.

Explicitly **not** encoded in the score — say this in the docs, the API reference, and the UI
tooltip, because every consumer will otherwise misread it:

- **Not severity.** A stubble burn can score 0.95 (it is confidently a real fire) while a
  potentially dangerous single night detection in forest scores 0.55. Severity/intensity is
  communicated by FRP and hull area (§8), separately.
- **Not spread risk.** Wind, fuel, and topography are out of scope (explicit non-goal in
  ANALYSIS §4).
- **Not a safety statement in either direction.** A low score must never be rendered as
  reassurance ("probably nothing") — per the "never falsely reassure" principle, the low
  bucket's wording is "Unverified", not "likely false alarm" (§3.9).
- **Not the per-detection FIRMS confidence.** FIRMS confidence is a per-pixel algorithm
  artifact (see §3.2); our score is an event-level fusion of many signals.

### 3.2 Per-detection evidence normalization (the common scale)

The sources speak three different confidence dialects:

- **VIIRS 375 m** (VNP14IMG/VJ114IMG): categorical `l/n/h`. Per Schroeder et al. (2014),
  nominal-confidence detections showed ~1.2% commission error in formal validation;
  `low` is assigned where the algorithm suspects daytime artifacts (sun glint, bright
  surfaces). Note: low-confidence *nighttime* VIIRS detections are effectively absent from
  the product (documented filtering — arXiv:2510.26816), so night detections are structurally
  n/h.
- **MODIS C6.x** (MOD14/MYD14): numeric 0–100, computed as a *geometric mean of heuristic
  sub-confidences* (Giglio et al. 2016). It is **not a probability**; FIRMS's own convention
  bins it `<30` low, `30–79` nominal, `≥80` high — adopt that binning (03-geodata already
  does).
- **GEO (LSA SAF FRP-PIXEL) and SLSTR FRP:** per-pixel quality flags, no l/n/h.

Map every detection to a **pseudo-probability** `c_i` = P(this single detection alone is a
real vegetation fire), from the table below. These are deliberately conservative priors — the
published commission errors (1.2%) come from validation campaigns that did not include the FP
classes that dominate a consumer product's error budget (solar farms, industry, glint;
Hantson et al. 2013 found "very high" commission in urban areas). The values are **refit on
the backfill at v1** (§3.7); the table is the v0 prior:

| Detection class | Day | Night | Rationale |
|---|---|---|---|
| VIIRS high | 0.90 | 0.95 | Strong thermal anomaly; night has no solar FP channels |
| VIIRS nominal | 0.65 | 0.80 | The workhorse class; daytime carries glint/PV risk |
| VIIRS low | 0.25 | 0.40 | Documented sun-glint/artifact class (night `l` rare) |
| MODIS ≥ 80 | 0.85 | 0.90 | Coarse pixel but strong signal |
| MODIS 30–79 | 0.55 | 0.70 | |
| MODIS < 30 | 0.25 | 0.35 | |
| GEO FRP-PIXEL (quality ok) | 0.55 | 0.65 | 3–4.5 km effective pixel over BG; FP-prone alone |
| SLSTR FRP | 0.60 | 0.70 | Verify against product QC flags at build time |

### 3.3 Why not noisy-OR: the correlation structure of detections

The tempting fusion `1 − Π(1 − c_i)` (noisy-OR) is wrong here, for a reason worth writing
down: **detections within one overpass are highly correlated** — they share the same
atmosphere, view geometry, solar condition, and algorithm state. Eight pixels from one pass
over a solar farm are one mistake, not eight independent confirmations; noisy-OR would score
them 0.9998. The independent unit of evidence is the **overpass** (and, more weakly, the
**platform**). Hence the feature design below: best single-detection evidence + counts of
*distinct overpasses* and *distinct platforms*, not raw detection counts.

### 3.4 Feature catalog

All features computed per event, recomputed on every attach/merge, each bounded [0,1] or
binary:

| # | Feature | Definition | Direction |
|---|---|---|---|
| x1 | `x_best` | max over detections of `c_i` (table §3.2) | + |
| x2 | `x_persist` | `min(n_distinct_overpasses − 1, 3) / 3` (an "overpass" = one platform × one pass; GEO counts as max 1 overpass-equivalent per 3 h) | + |
| x3 | `x_multisrc` | 1 if ≥ 2 distinct platforms (any of SNPP/N20/N21/Terra/Aqua/S3/MTG) contributed | + |
| x4 | `x_night` | 1 if any night (`day_night='N'`) detection | + |
| x5 | `x_coherence` | 1 if ≥ 3 detections mutually within 750 m within a single overpass (fires are spatially contiguous; noise and point FPs are isolated pixels) | + |
| x6 | `x_frp` | `min( ln(1 + FRP_max_MW) / ln(101), 1 )` — saturates at 100 MW | + |
| x7 | `x_fwi` | 1 if EFFIS FWI class ≥ "high" at centroid on first-detection day | + |
| x8 | `x_agri` | 1 if majority land cover under hull is arable (CORINE 211–213 / WorldCover 40) | − |
| x9 | `x_edge` | 1 if **all** detections come from pixels with area > 2× nadir area (`scan·track` vs nominal) — far-swath-only evidence is both FP-prone and poorly located | − |
| x10 | `x_glint` | 1 if **all** detections are daytime **and** low confidence | − |

Proximity to the static hot-source mask and the water/glint guard are **hard overrides**
(§3.6), not features — a weight can be outvoted; a power plant must not be.

### 3.5 The MVP formula (v0 — hand-set logistic)

```
z = −2.0
    + 1.8 · x_best
    + 1.0 · x_persist
    + 0.8 · x_multisrc
    + 0.7 · x_night
    + 0.6 · x_coherence
    + 0.5 · x_frp
    + 0.3 · x_fwi
    − 1.0 · x_agri
    − 0.6 · x_edge
    − 0.8 · x_glint

confidence_score = 1 / (1 + exp(−z))
```

The logistic form is chosen deliberately: bounded, monotone in each feature, directly
calibratable (§3.8), and v1 replaces the hand-set weights with fitted ones **without changing
the shape** — the score's consumers (alert gating, UX buckets, API) never see a
discontinuity in semantics.

**Worked examples (sanity checks — these become golden-fixture assertions, §9.4):**

| Case | Feature values | z | score | Bucket |
|---|---|---|---|---|
| Single daytime low-conf VIIRS pixel, cropland, swath edge | x_best=.25, x_agri=1, x_edge=1, x_glint=1 | ≈ −3.9 | **0.02** | Unverified (invisible-by-default tier) |
| Single daytime nominal VIIRS, forest, FWI high | x_best=.65, x_fwi=1 | ≈ −0.5 | **0.38** | Unverified |
| First night pass of a real fire: 5 high-conf VIIRS pixels, coherent, FRP 25 MW | x_best=.95, x_night=1, x_coherence=1, x_frp=.32, x_fwi=1 | ≈ +1.6 | **0.83** | Confirmed on first pass |
| Two overpasses, two satellites, night detection, FRP 40 MW, coherent | x_best=.95, x_persist=.33, x_multisrc=1, x_night=1, x_coherence=1, x_frp=.37 | ≈ +2.8 | **0.94** | Confirmed |
| GEO-only cluster, 4 consecutive 10-min slots, daytime | x_best=.55, x_persist=.33 (capped), | ≈ −0.7 | **0.33** | Unverified (matches 03-geodata's `unconfirmed` GEO rule) |

The night-high single-pass case scoring "Confirmed" is intentional and consistent with
03-geodata §5.2.3's alert rule ("1 detection if night + high"): night high-confidence VIIRS
is the cleanest signal in the entire stack (no solar FP channels; Schroeder et al. 2014).

### 3.6 Hard overrides (outside the formula)

1. **Static hot-source mask hit** → detection tagged `static_source`, never clustered into
   public events (03-geodata §5.2.4). If an *event* ends up overlapping the mask (mask was
   updated), `confidence_score := 0` and status `invalidated`.
2. **Water/glint guard** → daytime low-confidence detections over/adjacent WorldCover water
   are dropped pre-clustering (03-geodata rule; keep).
3. **Score is monotone non-decreasing under new corroborating evidence** within an event's
   life, except when a *negative* feature newly activates via merge — merges recompute from
   scratch and may lower the score; that is correct behavior, but never push a notification
   on a score decrease (§3.10).

### 3.7 v1 — fitting the weights on the backfill

**Training set construction (snapshot discipline).** The score matters at *decision time*,
not at end-of-life. Build examples as **event-state snapshots**: for every backfill event
(offline clustering output), snapshot features at (a) the moment the event first becomes
alertable under current rules, (b) +6 h, (c) +24 h. Features use only detections with
`acq_ts ≤ snapshot time`. This yields ~3× n_events ≈ 6–15k rows from ~2–5k events (but only
~2–5k independent units — treat CV grouping accordingly).

**Labels (composite corroboration, strictly after snapshot time):**
- Positive: event's detections intersect an EFFIS burnt-area perimeter (buffered 2 km, date
  window matched — same rule as QA's PCR), **or** Sentinel-2 dNBR confirmation (§9.2), **or**
  a curated news/ГДПБЗН record within 5 km / ±1 day.
- Negative: none of the above within 14 days **and** the event's location/land-cover class
  makes EFFIS omission unlikely (see censoring caveat below).

**Two leakage traps, named:**
1. **Persistence-label leakage.** If the label may be earned by "≥2 additional detections in
   later overpasses" (the QA CER clause), then a *future-self* signal defines truth. This is
   temporally clean (features are pre-snapshot, label evidence post-snapshot — a forecasting
   setup), but it shifts the score's meaning toward "will be corroborated," which
   under-labels real fires extinguished before the next pass. Accept the shift, but audit
   the short-fire stratum with dNBR/news labels specifically (§9.2).
2. **EFFIS circularity.** EFFIS NRT perimeters are MODIS/VIIRS-derived — the same
   instruments we ingest. Full treatment in §9.2; for fitting, prefer EFFIS *final*
   (Sentinel-2-refined, available since 2018) perimeters over NRT ones.

**Label censoring caveat:** EFFIS reliably maps only fires ≳ 30 ha from its rapid (MODIS
250 m) pipeline (smaller ones only via Sentinel-2 refinement since 2018, and EFFIS itself
estimates ~95% coverage of total *burned area*, not fire *count*). "Uncorroborated"
therefore ≠ "false" for small events. Consequences: (a) fitted precision is a lower bound;
(b) report metrics stratified by event size; (c) the dNBR spot-check subsample (§9.2) is the
unbiased estimator for the small-fire stratum.

**Fitting:** L2-regularized logistic regression, regularization strength chosen by
grouped CV (groups = fire seasons, §9.1). **Sign constraints as a sanity harness:** if a
fitted weight flips sign versus the table in §3.5 (e.g., `x_night` comes out negative),
treat it as a label-leakage alarm, not a discovery. With ~10 features and ≥ 600–1500
positives (§10), this is comfortably identified.

### 3.8 Calibration methodology

A score that says 0.8 must be right ~80% of the time, or the buckets are theater.

1. **Reliability diagram** on the held-out season (§9.1): bin snapshots into score deciles;
   plot mean score vs. observed corroboration rate; compute Expected Calibration Error
   (ECE = Σ_bins (n_b/N)·|acc_b − conf_b|). Target **ECE ≤ 0.07** on the test season.
2. **Recalibration:** Platt scaling (a 2-parameter logistic on the score) fitted on the
   validation season. **Not isotonic regression at v1** — isotonic needs ≳ 1000+ positives
   to avoid staircase overfitting; revisit at v2 with 2+ live seasons of labels (§10).
3. **Slice checks:** reliability computed separately for (a) forest vs. arable land cover,
   (b) day-only vs. any-night events, (c) event size terciles. A score well-calibrated in
   aggregate but wrong on daytime-cropland events would silently poison the agri labeling
   (§7).
4. **Drift monitor in production:** weekly score-distribution histogram + rolling
   corroboration-rate-by-bucket on the QA dashboard (§9.3). Alarm if the Confirmed bucket's
   rolling 4-week corroboration rate drops below 0.85.

### 3.9 UX mapping — three buckets, wording chosen against false reassurance

| Bucket | Score | UI wording (EN; BG copy at build time) | Rendering |
|---|---|---|---|
| **Confirmed** | ≥ 0.75 | "Confirmed fire activity — corroborated by multiple satellite observations" | Full-intensity fire styling |
| **Likely** | 0.45 – 0.75 | "Likely fire — satellite detection awaiting corroboration" | Standard styling |
| **Unverified** | < 0.45 | "Unverified detection — a single or low-quality satellite signal. **May still be a real fire.**" | Dimmed/outline styling; visible behind a default-on "show unverified" toggle |

Rules that operationalize "never falsely reassure":

- The Unverified wording **always** carries "may still be a real fire". Never "probably
  false alarm", never a green/grey checkmark, never any safety-adjacent icon.
- Bucket **upgrades** may notify (subject to alert gating); bucket **downgrades never
  notify** and are rendered without animation — a score dropping is not news of safety.
- Thresholds 0.45/0.75 are provisional: after calibration (§3.8), re-derive them so that the
  Confirmed bucket has ≥ 0.9 observed precision and the Likely bucket ≥ 0.6 on the test
  season. Thresholds are config-as-data (QA §5.7 versioning) — changing them is a
  shadow-mode change, not a hotfix.

### 3.10 Interaction with alert gating

The score does not replace the persistence rule; they compose:

- Default-sensitivity zones: alert when `score ≥ 0.45` **and** (≥ 2 detections **or** 1
  night+high detection) — the existing rule, now with a scored floor.
- High-sensitivity (opt-in) zones: alert at `score ≥ 0.30` with a single detection;
  GEO-only events per 03-geodata's `unconfirmed` policy (map-only at v1 — my concurrence
  recorded in §12).
- QA invariant unchanged: zero alerts from a single low-confidence detection at default
  sensitivity — now enforced twice (rule + the fact that such an event scores ≈ 0.02–0.25).

### 3.11 Supersession note — 03-geodata §5.2.3 additive score

The prior sketch (`base 0.3 + 0.2·sats + 0.2·night + … , ×0.5 if agri, cap 1.0`) had the
right features and is honored above. It is superseded because: (a) an additive-capped score
has no probabilistic reading — 0.7 means nothing measurable, so calibration and the QA
precision gates cannot bind it; (b) the multiplicative agri penalty conflates *class*
("this is an agri burn") with *confidence* ("this is not real") — in the logistic design
agri is one negative weight, and agri-*class* labeling is a separate output (§7); (c) the
cap at 1.0 makes the top of the scale non-informative exactly where Confirmed-bucket
precision matters. The forced-0 for static sources is retained as a hard override (§3.6).

---

## 4. Clustering parameter tuning on the backfill

ADR-002's ε ≈ 1.5/3/5 km and 48 h / 7-day windows are sensible priors. Here is how the
week-1 backfill turns them into defended values.

### 4.1 Building the labeled evaluation set

**Ground truth:** EFFIS burnt-area perimeters (final, Sentinel-2-refined where available)
for BG + 100 km buffer, 2020–2025, with start/end dates. Expect on the order of
600–2000 usable perimeters ≥ 10 ha (2024–2025 dominate; verify count at download).

**Detection→fire matching rule:**
```
detection d matches fire F iff
    d.geom ∈ buffer(F.perimeter, max(eps_source(d), 1 km))
AND d.acq_ts ∈ [F.start_date − 1 d, F.end_date + 3 d]
```
- Detections matching exactly one fire → labeled `fire_id = F`.
- Detections matching ≥ 2 fires (overlapping buffers — adjacent burns) → labeled
  `ambiguous`, excluded from pairwise metrics but kept for event-count metrics.
- Detections matching no fire → `unlabeled` (small real fires below EFFIS's ~30 ha rapid
  mapping floor, agri burns, or FPs — not usable as clustering truth; they feed §6 instead).

This yields a partial labeling: complete over the fires that matter most (the ≥ 10 ha
population that PCR gates on), silent on the small-fire tail — acceptable, because
clustering errors on sub-perimeter fires are invisible to users at MVP alert settings.

### 4.2 Metrics (exact definitions)

Over labeled detections only, per clustering configuration:

| Metric | Definition | Target |
|---|---|---|
| **Pairwise recall** (anti-over-split) | Of all pairs (d_i, d_j) with the same `fire_id`, fraction assigned to the same event | ≥ 0.95 |
| **Pairwise precision** (anti-over-merge) | Of all pairs with *different* `fire_id`s that are mutually within 20 km and 7 days (hard negatives — distant pairs are trivially separated and would inflate the metric), fraction assigned to different events | ≥ 0.98 |
| **Over-split index** | Per true fire: number of predicted events containing ≥ 10% of its labeled detections; report mean and p95 | mean ≤ 1.15, p95 ≤ 2 |
| **Over-merge (chimera) rate** | Fraction of predicted events whose detections span ≥ 2 true fires with ≥ 10% share each | ≤ 3% |
| **Timeline fidelity** | Predicted event `started_at` within ±12 h of first labeled in-perimeter detection | ≥ 90% |
| **ARI** | Adjusted Rand Index over labeled detections (single-number summary for the grid heat-map) | maximize on plateau |
| **Event-count stability** | Relative change in total predicted event count under ±1 grid step in each parameter | ≤ 10% (§4.6) |

Pairwise precision/recall is the primary pair (it is assignment-level, insensitive to event
count, and maps directly onto user harm: over-split = duplicate alerts, over-merge = one
alert hiding two fires). The QA gates (PCR ≥ 95%, duplicate-alert ≤ 5%) are downstream
consumers of these.

### 4.3 Grid-search protocol

```
eps_viirs  ∈ {750, 1000, 1250, 1500, 2000, 2500} m
eps_modis  ∈ {2000, 3000, 4000, 5000} m          (plus the adaptive variant, below)
eps_geo    ∈ {3000, 4000, 5000, 6000, 8000} m    (2025-only — LSA SAF back-processing starts Jan 2025)
T_LINK     ∈ {24, 36, 48, 72, 120} h
```

- **Stage 1 — per-source:** run single-source clusterings (VIIRS-only sweep of
  eps_viirs × T_LINK, etc.) via offline `ST_ClusterDBSCAN` + temporal linking. This
  isolates each ε from cross-source interactions. ~120 configs.
- **Stage 2 — joint:** fix each per-source ε to its stage-1 plateau, sweep T_LINK and the
  cross-source attach rule jointly (~25 configs). The full grid is ~600 runs; at 150–400k
  rows each run is minutes in PostGIS — a day of unattended compute, embarrassingly
  parallel by season.
- Score every run with §4.2; persist per-run metrics in `clustering_runs.params` +
  a metrics jsonb — the existing schema already supports this.

### 4.4 Expected ranges from pixel geometry (the across-scan argument)

The ε priors are defensible from sensor geometry before any data arrives — the tuning
confirms rather than discovers:

- **VIIRS 375 m:** I-band pixels are ~375 m at nadir and — thanks to the three on-board
  aggregation zones (3×1 to ±31.7°, 2×1 to 44.9°, 1×1 to 56.3°) and bow-tie deletion —
  only grow to ~0.80 × 0.86 km at swath edge (2–4× nadir *area*, not the ~10× of
  unaggregated scanners). Adjacent-pixel centers of one burning front are therefore
  ≤ ~800 m apart even in the worst geometry; add ~½-pixel geolocation error and up to
  ~1 km of front advance between the bunched passes → **ε_VIIRS ∈ [1.0, 1.5] km**. Below
  1.0 km, expect over-split at swath edge; above 2 km, adjacent agri burns start
  chimera-merging.
- **MODIS 1 km:** no aggregation — the pixel grows to ~4.8 × 2 km at scan edge (the classic
  across-scan growth curve). A fixed 3 km ε under-links edge-of-swath detections of one
  fire; a fixed 5 km over-merges at nadir. Recommendation: the **adaptive form
  ε(d) = max(3 km, 1.5 · √(scan·track) km)** already sketched in 03-geodata — the grid
  search evaluates it as a fifth "config" against the fixed values; expect it to win.
- **GEO (FCI over BG):** 2 km IR sampling at nadir, view zenith 55–60° over Bulgaria →
  effective pixel 3–4.5 km; neighboring fire pixels of one event can be ~4–5 km apart →
  **ε_GEO ∈ [5, 6] km**. Note ε_GEO trades against the chimera rate directly: two distinct
  fires < 6 km apart *cannot* be separated in the GEO stream — accept that GEO-only events
  are coarse, and rely on polar detections to split identity (the incremental algorithm
  attaches polar detections at polar ε, which naturally refines).

### 4.5 Time windows from gap statistics (T_LINK, T_REIGNITE)

Both windows are quantiles of empirical gap distributions — compute them, don't debate them:

- **T_LINK:** for every labeled fire, compute all gaps between consecutive attached
  detections. Plot the survival function of gaps. **Choose T_LINK ≥ the p99 intra-fire
  gap.** Expectation: 36–60 h (one overcast day + the diurnal blind window ≈ 40 h), which
  is why 24 h (original ANALYSIS) splits real fires and 48 h (ADR-002) is probably right —
  but the quantile turns "probably" into a number with a CI (bootstrap over fires).
- **T_REIGNITE:** for every labeled fire, the gap between the last detection of one active
  episode and the first detection of a later episode *inside the same final perimeter*
  (episodes separated by > T_LINK). Choose the p95. GlobFire's global fire-event database
  uses a 5-day temporal cut for MODIS burned-area clustering (Artés et al. 2019) — the
  7-day prior in ADR-002 is consistent with that precedent for a smoldering-prone
  Mediterranean-climate AOI; expect the empirical p95 to land at 4–8 days.

### 4.6 Sensitivity analysis and the plateau rule

Never pick the argmax of a metric surface — pick the **interior of a plateau**: the
selected configuration must satisfy all §4.2 targets *and* have every ±1-step neighbor
within 10% on event count and within 1 point on pairwise F1. A parameter set on a cliff
edge means the metric is exploiting one season's geometry and will betray you next July.
Additionally: re-run the chosen config per season (6 separate runs) and report the spread —
if 2024's optimum differs materially from 2021's, that is itself a finding (fire-regime
nonstationarity) to surface in ADR-002 rather than average away.

### 4.7 Re-tune cadence

- **Pre-season, annually** (April–May): re-run the grid on all data through the previous
  season; promote via the QA shadow-mode process (§5.7 of 06-qa) with Jaccard identity
  matching (03-geodata §5.2.5).
- **Event-triggered:** on adding a source (SLSTR, FCI), on an NRT→SP partition swap of a
  season used for tuning, and on any FIRMS algorithm/collection version bump.
- **Never mid-season** except under the QA hotfix path.

---

## 5. "No longer detected" — survival analysis over observation opportunities

### 5.1 What absence of detections actually licenses us to say

The only statistically honest claim is:

> "The satellites had **k unobstructed opportunities** to observe this location since the
> last detection, and detected no fire."

Absence is informative **only conditional on opportunity**. Three conditions gate each
opportunity: (1) an overpass actually covered the location (pass predictor), (2) the sky
was clear enough for the detection algorithm to attempt the pixel (cloud/observability),
(3) the sensor could plausibly have seen a fire of this event's character (detection floor —
a 2 km GEO pixel not seeing a 0.5 ha smolder is zero evidence). A cloudy pass is **zero
evidence of extinction** — QA scenario S7 already asserts this; here is the model behind it.

### 5.2 Formal model

Let `t` = time since last detection. Two independent ingredients:

1. **Prior survival** `S(t)` = P(fire still active at `t` | it was active at last
   detection), estimated from the backfill: Kaplan–Meier over labeled fires' activity
   durations, **stratified by event class** (size tercile × land cover × max-FRP tercile).
   Expectation for BG: most grass/arable fires die within 24 h; large forest fires have
   heavy tails.
2. **Detection likelihood per clear opportunity:** `p_det(s, class, geometry)` = P(source
   `s` detects the fire | still active, clear sky) — §5.3.

After `k` clear-sky missed opportunities at times `t_1 … t_k` from sources `s_1 … s_k`:

```
P(active | k clear misses) =
      S(t_k) · Π_i (1 − p_det(s_i))
  ─────────────────────────────────────────────
  S(t_k) · Π_i (1 − p_det(s_i))  +  (1 − S(t_k))
```

Cloudy opportunities simply do not enter the product (likelihood 1 — no evidence). This is
a standard censored-observation survival setup; nothing exotic is needed.

### 5.3 Estimating p_det (per source, from the backfill)

For every labeled fire and every predicted overpass during its EFFIS-active window
(pass predictor × cloud proxy = expected clear observation), record hit/miss. Then:

- `p_det(VIIRS | active, clear)` overall — expect **0.75–0.95** for fires ≥ 10 ha
  (fire must occupy only ~0.01% of pixel area at ≥ 800 K to trigger detection — ~15 m² for
  a 375 m pixel per the VNP14 user guide — so an actively flaming front is nearly always
  seen; misses come from smoldering phases, terrain shadowing, and swath-edge geometry).
- Stratify by: day/night, flaming vs. late-phase (proxy: FRP trend of prior detections),
  pixel-area class. Expect the smoldering-tail p_det to drop to **0.3–0.6** — this is the
  number that drives the conservative thresholds below.
- `p_det(MODIS)`: lower (1 km pixel; ~100 m² minimum fire area) — expect 0.5–0.8.
- `p_det(GEO)`: **conditional on fire strength.** SEVIRI's FRP-PIXEL heritage shows a
  per-pixel detection floor of roughly ~50 MW at its 3 km sub-satellite pixel (low-FRP
  truncation documented in the LSA SAF product line; Wooster et al. 2015); FCI improves
  substantially (≈ 5× more fire pixels than SEVIRI, small-fire FRP retrieval — Xu et al.
  2026), but over BG's 55–60° view zenith assume a floor of **~10–30 MW** until the LSA SAF
  MTG validation report says otherwise. Rule: GEO misses count **only** for events whose
  last-observed FRP ≥ 1.5× the assumed GEO floor.

### 5.4 The concrete rule (state machine thresholds)

Maintain per event a **miss-evidence accumulator E**, reset to 0 on any attached detection:

```
On each predicted overpass opportunity for the event's location:
  if source stale (T6 freeze)      → skip (no evidence, no accrual)
  if cloud proxy says obscured     → skip (no evidence)             ← cloudy ≠ out
  if clear and no detection        → E += w(source, context)

w(source, context):
  VIIRS night miss        1.25     (highest contrast, no solar artifacts)
  VIIRS day miss          1.0
  MODIS miss              0.5      (coarser pixel, lower p_det)
  SLSTR miss              0.75
  GEO miss                0.05 per 10-min slot, capped at 1.0/day,
                          counted only if last FRP ≥ 1.5× GEO floor

Transition to "no longer detected" (public wording; internal status `cooling→out`) when ALL:
  (a) E ≥ E_min          — 3.0 standard; 5.0 for large/smoldering-prone events
                           (hull ≥ 100 ha OR max_frp ≥ 100 MW OR land cover peat/landfill)
  (b) elapsed ≥ 24 h since last detection
  (c) misses span both diurnal phases (≥ 1 missed night cluster AND ≥ 1 missed day cluster)
```

Condition (b)+(c) exist because passes are **bunched** (~01:30 and ~13:30 local for VIIRS):
three clear misses can accrue within ~2 h inside one pass cluster — E alone would let a
fire smoldering through the afternoon be declared gone by 15:00. Requiring both diurnal
phases forces at least one night look, which is also the most sensitive look.

**Archival:** `out` events remain reopenable for **T_REIGNITE (7 d, pending §4.5 fit)** —
a matching detection reopens the *same* event ID (no duplicate), which is the safety net
that bounds the cost of any false "out".

### 5.5 False-"out" probability (worked examples)

Using §5.2 with backfill-prior guesses (to be replaced by fitted values):

| Event class | S(24 h) | p_det per VIIRS clear miss | Misses to threshold | P(still active at declaration) |
|---|---|---|---|---|
| Typical grass/arable fire, flaming history | 0.30 | 0.80 | E=3.0 ≈ 3 VIIRS misses | 0.3·(0.2)³ / (0.3·0.008 + 0.7) ≈ **0.3%** |
| Mid-size forest fire, mixed phases | 0.50 | 0.70 | 3 misses | 0.5·(0.3)³ / (0.5·0.027 + 0.5) ≈ **2.6%** |
| Large fire, smoldering tail | 0.80 | 0.50 | E=5.0 ≈ 4–5 misses incl. night | 0.8·(0.5)⁴ / (0.8·0.0625 + 0.2) ≈ **20% → 11% at 5, 6% at 6** |

Reading: the standard threshold yields sub-3% false-"out" for the common classes; the large
class is genuinely hard — even E=5.0 leaves ~10% — which is why (i) the wording is "no
longer detected", never "extinguished", (ii) reignition reopens silently, and (iii) for
large events the UI keeps showing the burnt-area perimeter and "last detected" timestamp
rather than removing the event. **Do not chase a lower false-"out" for large fires by
raising E further** — a 100 ha fire's `out` at E=8 would take ~4 days, during which the map
shows a "burning" fire that every ground observer knows is over: that is its own credibility
failure. 5–10% false-"out" on large events, silently self-correcting via reignition-reopen,
is the right trade.

### 5.6 Edge cases

- **Detectable-by-VIIRS-only fires:** an event whose entire history is sub-20 MW FRP is
  invisible to GEO by construction — GEO slots contribute nothing to E (already encoded in
  the w rule). Conversely, a GEO-visible fire (≥ ~30 MW) that GEO stops seeing while VIIRS
  gaps is real evidence — the cap (1.0/day) keeps 144 daily slots from swamping polar
  evidence.
- **Day/night asymmetry:** daytime misses are weaker evidence (lower contrast, more masking)
  — hence 1.25 vs 1.0. Also: a fire "seen only at night, missed in the day" is a known
  smoldering signature, not an extinction signal — condition (c) handles the converse, and
  the per-phase p_det stratification (§5.3) will quantify it.
- **Smoldering/peat/landfill:** long-duration low-FRP burns (Bulgaria's landfill fires are
  the local instance) get the E=5.0 class by land-cover rule; they are also *real* events
  that should not be suppressed as FPs (§6.1).
- **Freeze on source staleness (T6):** any source with a stale watermark contributes no
  opportunities; if *all* polar sources are stale, E cannot accrue at all — a FIRMS outage
  must never mass-extinguish the map (this review formally endorses the T6 design).

### 5.7 Observability (cloud) at MVP — an honest proxy

The proper input is a cloud mask (FCI L2 CLM at v1). At MVP, use **Open-Meteo hourly
`cloud_cover` at the event centroid, at predicted overpass time**: `cloud_cover > 80%` ⇒
opportunity is `obscured` (skip); 50–80% ⇒ count at half weight; < 50% ⇒ clear. This is a
model, not an observation — it will occasionally miscount an opportunity — but it is
directionally sound, costs one field in the existing weather join (03-geodata §5.6), and
avoids the worst failure (declaring "out" through an overcast week). The UI already needs
"area may have been cloud-obscured at last pass" copy — this proxy powers it. Replace with
the FCI cloud mask when the sidecar lands; keep both fields so the v1 upgrade is measurable.

### 5.8 The metric: False Extinguish Rate (FER)

Add to the QA metric set: **FER = fraction of events declared "no longer detected" that
re-attach a detection within 72 h** (i.e., were declared prematurely). Computable on the
backfill (replay the rule over history) and continuously in production. **Target: ≤ 5%
overall, ≤ 10% for the large-event class.** Tune E_min / weights on the backfill to hit
FER targets — this closes the loop: the thresholds in §5.4 are initializations, FER on
2020–2025 is the fitting objective, and the QA dashboard watches it live.

---

## 6. False-positive model beyond the static mask

### 6.1 Expected FP classes for Bulgaria — signatures

Literature base rates: MODIS-era hotspot analysis found < 2% of detections not associated
with real burned patches overall, but with *very high commission errors concentrated in
urban/industrial contexts* (Hantson et al. 2013); VIIRS daytime false alarms are
documented for solar panels, bright/metallic rooftops, and sun glint (NOAA/CIRA VIIRS AF
guidance). The consumer-product error budget is dominated by a handful of nameable classes:

| FP class | BG instances | Seasonal signature | Diurnal signature | Spectral/context tells | Primary counter |
|---|---|---|---|---|---|
| **Solar PV farms** | Karlovo, Pazardzhik, Sliven, Harmanli clusters; rapid 2023–2026 build-out | Apr–Sep (high sun elevation) | **Day only**, midday peak; never at night | Low/nominal conf, low or absent FRP, exact-coordinate repetition across days, WorldCover built-up/grass | OSM `power=plant; plant:source=solar` polygons + day-only-repeat rule (§6.2) |
| **Industrial (TPP, metallurgy, cement)** | Maritsa Iztok complex, Neftochim Burgas, Devnya, Pirdop | Year-round | Day **and** night, stable | Fixed location, hot in ≥ 8 distinct months | Static mask (already MVP) |
| **Gas flares** | Neftochim flare; scattered small | Year-round | Day and night, constant FRP | Point-stable, small FRP | Static mask + OSM `man_made=flare` |
| **Sun glint on water** | Danube, Black Sea coast, large dams (Iskar, Kardzhali, Ogosta) | Summer | Day only, near-specular geometry | Low conf over/adjacent water | Water/glint guard (already MVP) |
| **Hot bare/urban surfaces in heatwaves** | Large rooftops, asphalt, fresh burn scars, quarries | Jul–Aug heatwaves (35 °C+) | Day only, afternoon | Low conf, no night persistence, built-up/bare class | v1 heuristic: day-only + low conf + built-up/bare ⇒ down-score (x_glint/x_edge already partially cover) |
| **Agricultural burns** | Dobrudzha, Thrace arable belts | Mar–Apr, Jul–Oct | Day, late morning–afternoon | Arable class, small, short | **Not an FP** — real fire, separate class (§7) |
| **Landfill/waste fires** | Periodic BG landfill incidents | Any | Smoldering, multi-day | Persistent low FRP at waste sites | **Not an FP** — real; label class, E=5.0 decay tier |

The last two rows are the important taxonomic point: the FP model must distinguish
**"not a fire"** (suppress) from **"a fire, but not a wildfire"** (show, label, different
alert policy). Collapsing these erodes either precision or trust.

### 6.2 Solar PV — the mask-drift problem (new risk)

The static mask is derived from cells hot in ≥ 8 distinct months of **2020–2025** history.
Bulgaria's PV capacity roughly tripled in 2023–2026 (multi-GW build-out); a farm energized
in 2025 has at most a few hot months in the backfill and **will not make the mask** — yet
it will glint all of summer 2026. Mitigations, all cheap:
1. Seed the mask's *solar* layer from **OSM/Overpass `power=plant` + `plant:source=solar`
   polygons** (plus `landuse=solar_farm` variants), refreshed **quarterly** — infrastructure
   FPs are born faster than an annual mask re-derivation.
2. v1 heuristic backstop: ≥ 3 daytime-only detections at the same ~pixel coordinates across
   ≥ 2 distinct days with zero night detections ever ⇒ auto-quarantine as
   `suspected_static_source` pending review (this catches *any* new persistent daytime
   artifact, not just PV).
3. The cold-canary tripwire (QA §5.5) should include one geofence over a major PV cluster.

### 6.3 Classifier evolution — honest staging

- **MVP:** static hot-source mask + CORINE/WorldCover agri rule + water/glint guard + OSM
  solar layer. All deterministic, all auditable, all already designed. Expected residual FP
  rate in alerts: low single-digit % (the QA ZAP ≥ 85% gate has ample headroom if these
  four are in).
- **v1:** per-class heuristics as **named, versioned rules** (`fp_rule.solar_v1`,
  `fp_rule.urban_heat_v1`, …), each emitting a *label* and a score adjustment, each with a
  per-rule precision counter on the dashboard. Rules are feature-flagged and
  shadow-promoted like clustering params.
- **v2 (conditional):** a learned FP classifier **only if** the labeled corpus justifies
  it. Honest arithmetic: ~2–5k events × maybe 10–20% non-wildfire ⇒ **300–800 labeled
  negatives** across *all* classes — enough for one logistic model with ≤ 8 features,
  nowhere near enough for gradient boosting over dozens of features, and laughably short of
  anything deep (§10). If v1's per-rule precision counters show a rule below ~80%, fix the
  rule; don't reach for a model.

---

## 7. Agricultural burns — detection, product policy, and the quiet B2B angle

### 7.1 Detector specification

Stubble burning is illegal in Bulgaria (Agricultural Land Protection Act prohibition on
burning stubble and plant residues; CAP GAEC conditionality) and remains common. It is also
the single largest "real fire, wrong product class" population in the AOI — Eastern European
croplands are among the densest agricultural-fire landscapes VIIRS sees, and VIIRS I-band
is sensitive enough to catch fires down to ≤ 1 MW FRP, which is exactly this class.

**`likely_agri_burn` classifier (deterministic, v1):** flag an event when **all** of:

| Criterion | Rule | Rationale |
|---|---|---|
| Land cover | ≥ 70% of hull on CORINE 211/212/213 (arable) or WorldCover 40; upgrade to LPIS parcels if obtainable | Where stubble is |
| Season | Jul 1 – Oct 31 (post-harvest) or Mar 1 – Apr 30 (spring clearing) | BG agronomic calendar |
| Duration | Active window ≤ 24 h (≤ 2 polar overpass clusters) | Burns are lit, burn out same day |
| Intensity | max FRP < 10 MW **and** hull < ~50 ha | Small, cool |
| Diurnal | All detections daytime | Burns are lit in working hours; night activity suggests escape |
| Isolation | No detection within 500 m of forest/shrub edge (WorldCover 10/20) | Adjacency = escape risk, treat as wildfire |

**Escape rule (safety-critical):** the label is *revoked* — and the event promoted to
standard wildfire handling with an escalation alert — the moment any criterion breaks:
a night detection appears, FRP exceeds threshold, the hull touches forest edge, or duration
exceeds 24 h. Escaped field burns becoming wildfires is a documented ignition pathway; the
detector must be a one-way valve toward caution.

**Expected precision:** in-season, on-arable, small/short detections in Eastern Europe are
overwhelmingly genuine agricultural burning; with the six-criteria AND I expect **85–90%
precision** for the label. Validate on the backfill: stratified sample of ~100 flagged
events, Sentinel-2 visual + dNBR spot-check (burn scars on field polygons are unmistakable
at 10 m); measure, then print the measured number in the UI methodology page rather than
this estimate.

### 7.2 Product decision: show-but-label (recommendation, closing 03-geodata OQ2)

**Show, label, downweight alerts — never suppress.** Reasons ranked: (a) escapes: a
suppressed burn that becomes a wildfire is the worst possible failure narrative for a fire
map; (b) smoke: agri burns produce the air-quality complaints that drive real user
questions ("what is burning near X?") — a map that shows nothing there loses trust; (c) the
label is honest ("Likely agricultural burn — small, short-lived fire on cropland"), and the
confidence score stays what it is (often high — it *is* a fire). Alert policy: default
zones do not alert on `likely_agri_burn` events unless the escape rule fires; a per-zone
"include agricultural burns" toggle serves rural users who *do* want them.

### 7.3 The regulator/B2B data product (note for the business track)

A season-end dataset of "likely agricultural burn detections by municipality × week" is a
data product with plausible buyers/users: environmental inspectorates (РИОСВ), the
agricultural agency's conditionality checks, air-quality researchers, and insurers.
Two cautions: (1) **never publish parcel-level attribution** of an illegal act from 375 m
pixels — geolocation error alone makes per-parcel claims indefensible; aggregate to
municipality/land-cover statistics; (2) this is a *legal-review-required* product (naming
enforcement targets from satellite data has GDPR-adjacent and defamation-adjacent risk) —
park it in v2, but the detector (§7.1) that MVP builds anyway is 90% of the work, so the
option is nearly free.

---

## 8. FRP interpretation and derived analytics

### 8.1 What FRP legitimately supports — and does not

FRP (MW) is the instantaneous radiative output of the burning fraction of the pixel;
time-integrated (FRE), it is proportional to biomass consumed (~0.368 kg/MJ — Wooster's
combustion-rate relationship). For this product:

**Supported:** relative intensity ranking of concurrent events; growth/decay *trend* within
one source's time series (the map's trend arrow); "major fire" flagging (§8.3); rough
emissions/smoke context (v2, with CAMS).

**Not supported — refuse these derivations in UI and API docs:** burned **area** (FRP is
radiative power, not extent; a small intense fire outranks a large smoldering one);
**containment** or firefighting status (FRP decline ≠ control — fuel exhaustion, diurnal
lull, and suppression are indistinguishable); flame height/severity per location; any
absolute cross-source comparison (below).

### 8.2 Trend-arrow discipline (diurnal + cross-source pitfalls)

Two artifacts will fabricate trends if naively computed:

1. **Diurnal cycle:** vegetation-fire FRP peaks early-to-mid afternoon and bottoms out at
   night (established from geostationary observation of full diurnal cycles — Roberts &
   Wooster's SEVIRI record over Africa; the same shape holds for Mediterranean fire
   weather). Polar sampling sits at fixed phases: VIIRS ~13:30 (near diurnal max) and
   ~01:30 (near min); MODIS Terra mid-morning. **A 01:30 reading below the previous 13:30
   reading is the diurnal cycle, not decay.** Rule: the trend arrow compares only
   like-phase observations (day-vs-day, night-vs-night for polar) **or** uses the GEO
   10-min series where available — GEO is the only source that sees the actual diurnal
   curve, which is its second product value after early detection.
2. **Cross-source mixing:** GEO under-detects the low-FRP component (detection floor,
   §5.3), so a GEO event-sum is biased low versus a VIIRS sum of the same fire; VIIRS and
   MODIS themselves differ systematically with scan angle (documented in VIIRS-vs-MODIS
   FRP comparisons, e.g. Li et al. 2018). Rule: **never compute a trend across sources**;
   the event stores per-source FRP series and the arrow logic picks the best single series
   (GEO if the fire is above the GEO floor, else like-phase VIIRS).

Trend arrow spec: on the chosen series, arrow = sign of the robust slope (Theil–Sen over
the last 3–5 observations), shown only when ≥ 3 points and the change exceeds ±30% —
below that, render "steady" rather than jitter.

### 8.3 "Major fire" threshold for the BG context

Proposal: label an event **major** when *either* single-overpass summed VIIRS FRP
≥ 300 MW, *or* summed FRP ≥ 150 MW sustained across ≥ 2 consecutive overpasses, *or* hull
≥ 200 ha. Justification path rather than justification: most BG events are small (median
event max-FRP will likely land < 20 MW — verify); "major" should select roughly the top
3–5% of historical events. **Week-1 task: compute the event max-FRP and per-overpass-sum
distributions on the backfill, set the thresholds at p95–p97, and sanity-check that the
named 2024–2025 fires (Slavyanka border fire, the Sakar/Harmanli complex, the 2025 top
events) all clear them by a wide margin.** Thresholds are config-as-data, revisited
pre-season with the same shadow discipline as everything else.

---

## 9. Evaluation harness on the week-1 backfill

### 9.1 Dataset splits — by fire season, never random

Random row splits leak catastrophically here (the same fire lands in train and test).
Split by **season** (the natural exchangeability unit):

- **Fit:** seasons 2020–2023 (+ 2024 for models needing more positives).
- **Calibrate (Platt, thresholds):** season 2024.
- **Test (report-only, touched once):** season 2025.
- For weight-stability analysis: leave-one-season-out CV across all six; report the spread
  of fitted weights — a weight that swings sign across folds is not a real effect at this n.

2024 and 2025 are both extreme years and deliberately sit in calibrate/test: the product
must be calibrated for bad seasons, and an easy test year would flatter every metric.
Caveat to record: NOAA-21 data begins 2024, MTG FRP-PIXEL begins 2025 — source mix is
nonstationary across splits; report per-source metrics alongside pooled ones.

### 9.2 Leakage traps — the EFFIS circularity warning

**EFFIS NRT burnt-area perimeters are mapped from MODIS/VIIRS imagery — the same sensors
whose detections we cluster and score.** Using them naively as truth means: our recall
against EFFIS partially measures "does FIRMS see what FIRMS sees" (inflated), and any
systematic FIRMS blindness (e.g., a fuel type both miss) is invisible to the whole harness.
This does *not* invalidate EFFIS as a truth proxy — perimeters are human-reviewed, spatially
integrated objects, far better than raw hotspots — but it must be handled:

1. **Prefer EFFIS final/refined perimeters** (Sentinel-2-based refinement, available since
   2018) over NRT ones for all labeling — S2 is an independent sensor at 10 m.
2. **Sentinel-2 dNBR spot-check protocol (the independent anchor):** stratified random
   sample of **150–200 backfill events** (strata: score bucket × land cover × size), for
   each compute dNBR from the nearest cloud-free S2 pair bracketing the event (CDSE
   openEO/Sentinel Hub free tier; a half-day of scripting). Confirmation = dNBR > 0.1 over
   ≥ 1 ha within the buffered hull. This yields an unbiased precision estimate per stratum,
   including the small-fire stratum EFFIS censors. Budget: one evening of compute + ~2 h of
   visual review.
3. **News/ГДПБЗН curated log** (QA already commits to it): treat as high-precision,
   low-recall labels — usable for precision auditing of alerted events, never for recall.
4. **Report every metric per truth source** (EFFIS / dNBR / news) — divergence between
   them is itself the circularity alarm.

### 9.3 Metrics dashboard spec (extends QA §5.5's weekly report)

One page, computed weekly in season, monthly off-season:

| Panel | Content | Source section |
|---|---|---|
| Alert quality | PCR, CER, ZAP, DAR (existing) | 06-qa §5.1 |
| Calibration | Reliability diagram (10 bins), ECE, per-bucket observed precision, score histogram vs. last 4 weeks | §3.8 |
| Clustering health | Over-split index, chimera rate on the rolling window vs. EFFIS actives; event-count vs. seasonal baseline | §4.2 |
| Decay honesty | FER (overall + large-class), distribution of E at "out" declaration, count of cloud-frozen events | §5.8 |
| FP classes | Per-class flagged counts + per-rule precision counters; new `suspected_static_source` quarantine list | §6.3 |
| Agri | `likely_agri_burn` counts by municipality, escape-rule promotions | §7 |

### 9.4 Feeding the QA golden scenarios

The harness and the golden fixtures share one replay engine (QA §5.2). Additions this
review contributes to `expected.json` per scenario:

- **S3 (agri burn):** assert `likely_agri_burn = true`, score in Likely-or-higher bucket,
  *no* default alert, and label revocation if the fixture is extended with a night
  detection (escape rule).
- **S4 (industrial):** assert score = 0 via hard override, never bucketed.
- **S5 (single low-conf noise):** assert score ≤ 0.25 at all times (worked example 1).
- **S6 (megafire + reignition):** assert E-accumulator resets on reignition, same event ID,
  FER not charged.
- **S7 (cloudy gap):** assert E does not accrue during obscured opportunities and status
  never reaches `out` — this scenario is the §5 model's regression test.
- **New scenario S10 — solar farm onset:** synthetic fixture of a new PV plant producing
  day-only repeats; assert quarantine after ≥ 3 day-only repeat detections (§6.2 rule),
  no alert ever.

---

## 10. Data-volume reality check (killing ML-maximalism explicitly)

The numbers: ~150–400k detections, but detections are *not* the statistical unit for
anything that matters — events are. **~2–5k events over six seasons; ~600–2000
EFFIS-labelable positives; 300–800 identifiable non-wildfire events.** Consequences,
stated as vetoes:

| Method | Verdict | Why |
|---|---|---|
| Logistic regression, ≤ 10–12 features | **Yes** | ~50–150 positives per parameter; stable under season-grouped CV |
| Platt scaling | **Yes** | 2 parameters; works at hundreds of positives |
| Kaplan–Meier / stratified survival curves | **Yes** | Nonparametric, unit = fire, honest at n ≈ hundreds per stratum |
| Quantile-based threshold setting (T_LINK, major-fire MW) | **Yes** | Order statistics with bootstrap CIs — the workhorse of this whole review |
| Isotonic calibration | **v2 only** | Staircase overfits below ~1000 positives; Platt until 2+ live seasons of labels accrue |
| Gradient boosting (small, regularized) | **v2, skeptically** | Only if v1 logistic shows demonstrable miscalibration a monotone model can't fix; nested season-CV mandatory; expect ~zero real gain at this n |
| Deep learning of any kind (CNNs on pixels, sequence models on events, embeddings) | **No** | Two orders of magnitude short on labeled events; would memorize the six seasons; unexplainable to the QA gates; a maintenance liability for a solo operator |
| Per-pixel custom detection algorithms | **No** | We consume Level-2 products; competing with NASA/EUMETSAT ATBDs is the explicitly rejected thesis of the whole project |

Also worth vetoing in advance because they will be tempting: online learning of weights
during the season (no — weights change only via the shadow process); per-user personalized
scoring (no — one public score, or trust dies); Bayesian hierarchical models over
municipalities (beautiful, unnecessary — revisit at multi-country scale, if ever).

The honest summary: **this is a quantiles-logistic-and-survival-curves project, and that is
a strength.** Every number in the system remains explainable in one sentence to a journalist
during a fire.

---

## 11. Ranked recommendations

**[MVP] — before alerting ships:**
1. Ship the v0 confidence formula (§3.5) with hard overrides (§3.6) and the 3-bucket UX
   (§3.9); wire thresholds as config-as-data.
2. Run the clustering grid search (§4.1–4.3) on the week-1 backfill; adopt plateau
   parameters into ADR-002 with the metric table attached; set T_LINK/T_REIGNITE from gap
   quantiles (§4.5).
3. Implement the miss-evidence decay rule (§5.4) with the Open-Meteo cloud proxy (§5.7);
   compute FER on the backfill and tune E_min to FER ≤ 5% before launch.
4. Extend the static mask with the OSM solar layer + the day-only-repeat quarantine rule
   (§6.2); add golden scenario S10.
5. Compute backfill FRP distributions; set major-fire thresholds at p95–p97 (§8.3).
6. Run the dNBR spot-check protocol on 150–200 backfill events (§9.2) — this is the
   independent truth anchor for everything else, and it is one evening of compute.

**[v1] — with accounts/alerts maturity:**
7. Refit confidence weights by season-grouped regularized logistic (§3.7); Platt-calibrate
   on 2024; report reliability on 2025; re-derive bucket thresholds from observed precision.
8. Per-class FP heuristic rules with per-rule precision counters (§6.3); agri-burn detector
   with escape rule (§7.1) and the show-but-label policy (§7.2).
9. Replace the cloud proxy with the FCI cloud mask when the GEO sidecar lands; add the GEO
   FRP series as the preferred trend-arrow source (§8.2).
10. Stand up the dashboard panels of §9.3; adopt FER and ECE into the QA gate set.

**[v2] — conditional:**
11. Isotonic recalibration once 2+ live seasons of labels exist (§3.8).
12. Learned FP classifier *only* if per-rule precision counters prove heuristics
    insufficient and the labeled-negative corpus clears ~1k (§6.3).
13. Municipal agri-burn seasonal reports as a B2B/regulator product, after legal review
    (§7.3).
14. Annual pre-season re-tune ritual: grid re-run, weight refit, threshold re-derivation,
    all through shadow mode (§4.7) — put it in the calendar as a fixed April task.

---

## 12. Open questions

**Resolvable with data (owner: this role, on the backfill):**
1. Empirical p_det per source/phase (§5.3) — the single most load-bearing unknown in the
   decay rule; the priors here span 0.5–0.95 and the backfill will pin them.
2. Does FWI class actually predict corroboration odds in BG (i.e., does x_fwi earn its
   weight), or is it redundant given season? Fit will tell; drop it if the CI covers zero.
3. Actual EFFIS perimeter count/quality for BG 2020–2025 (my 600–2000 estimate brackets
   it; if the lower end, widen labeling to the +100 km buffer's Greek fires for fitting
   power — at the cost of fire-regime transfer assumptions worth checking explicitly).
4. NRT-vs-SP label stability: do fitted weights move when the SP partitions swap in?
   (Cheap experiment; if yes, always fit on SP tiers only.)

**Needing a domain expert, not statistics:**
5. **Fire-behavior expert (forestry/ГДПБЗН):** realistic smoldering durations by BG fuel
   type (coniferous plantations vs. broadleaf vs. maquis) — this sets the large-event
   survival prior S(t) better than six seasons of censored satellite data can; also
   whether the 500 m forest-adjacency rule in §7.1 matches ground experience of stubble
   escapes.
6. **Agronomist:** exact BG burn-calendar windows by region (Dobrudzha vs. Thrace differ),
   to tighten §7.1's season criterion.
7. **Legal:** the agri-burn regulator product (§7.3) and any public wording that implies
   illegality of a specific detection.
8. **EUMETSAT/LSA SAF liaison:** the MTG FRP-PIXEL validation report's stated minimum FRP
   at 55–60° view zenith — replaces my ~10–30 MW placeholder for the GEO floor (§5.3).
9. **Product owner decision (with QA):** is "no longer detected" an end-state the UI ever
   converts to removal, or do events fade but persist with their burnt-perimeter for the
   season? (§5.5 argues for fade-and-persist for large events; needs a design decision.)
10. **Meteorologist (nice-to-have):** validity of Open-Meteo cloud_cover as an overpass
    observability proxy in mountain terrain (§5.7) — a quick comparison against FCI CLM
    once the sidecar exists would settle it.

---

## Sources

*Active-fire algorithms and validation:*
- Schroeder, W., Oliva, P., Giglio, L., Csiszar, I. (2014). The New VIIRS 375 m active fire
  detection data product. *Remote Sensing of Environment* 143, 85–96.
  https://www.sciencedirect.com/science/article/abs/pii/S0034425713004483
- VIIRS 375 m Active Fire Product User Guide (VNP14IMG, v1.3) — detection physics, pixel
  geometry, confidence classes. https://lpdaac.usgs.gov/documents/132/VNP14_User_Guide_v1.3.pdf
- Giglio, L., Schroeder, W., Justice, C.O. (2016). The Collection 6 MODIS active fire
  detection algorithm and fire products. *Remote Sensing of Environment* 178, 31–41.
  https://www.sciencedirect.com/science/article/pii/S0034425716300827
- Hantson, S., Padilla, M., Corti, D., Chuvieco, E. (2013). Strengths and weaknesses of
  MODIS hotspots to characterize global fire occurrence. *Remote Sensing of Environment*
  131, 152–159. https://www.sciencedirect.com/science/article/abs/pii/S0034425712004610
- NOAA/CIRA VIIRS Active Fire Quick Guide — documented daytime false-alarm sources incl.
  solar panels and glint.
  https://rammb2.cira.colostate.edu/wp-content/uploads/2020/01/VIIRS_Active_Fire_Quick_Guide_v1-2022.pdf
- On systematic filtering of low-confidence nighttime VIIRS detections: arXiv:2510.26816.
  https://arxiv.org/abs/2510.26816

*Geostationary FRP:*
- Wooster, M.J. et al. (2015). LSA SAF Meteosat FRP products — Part 1: Algorithms, product
  contents, and analysis. *Atmos. Chem. Phys.* 15.
  https://eprints.soton.ac.uk/379917/
- Roberts, G. et al. (2015). LSA SAF Meteosat FRP products — Part 2: Evaluation and
  demonstration for use in CAMS. *Atmos. Chem. Phys.* 15, 13241–13267.
  https://acp.copernicus.org/articles/15/13241/2015/
- Xu, W. et al. (2026). Major improvements in spaceborne early fire detection and
  small-fire FRP retrieval with the MTG Flexible Combined Imager. *Science of Remote
  Sensing*. https://www.sciencedirect.com/science/article/pii/S2666017226000040
- LSA SAF Fire Products (FRP-PIXEL, MTFRPPIXEL LSA-509).
  https://lsa-saf.eumetsat.int/en/data/products/fire-products/

*Fire events, diurnal cycles, FRP comparisons:*
- Artés, T. et al. (2019). A global wildfire dataset for the analysis of fire regimes and
  fire behaviour (GlobFire). *Scientific Data* 6, 296.
  https://www.nature.com/articles/s41597-019-0312-2
- Roberts, G. & Wooster, M.J. (2008). Fire detection and fire characterization over Africa
  using Meteosat SEVIRI. *IEEE TGRS* 46(4).
- Annual and diurnal African biomass burning temporal dynamics. *Biogeosciences* 6,
  849–866 (2009). https://bg.copernicus.org/articles/6/849/2009/
- Li, F. et al. (2018). Comparison of fire radiative power estimates from VIIRS and MODIS
  observations. *JGR Atmospheres* 123.
  https://agupubs.onlinelibrary.wiley.com/doi/full/10.1029/2017jd027823
- Zhang, T. et al. (2020). Trends in eastern China agricultural fire emissions derived from
  a combination of geostationary (Himawari) and polar (VIIRS) orbiter FRP products.
  *Atmos. Chem. Phys.* 20, 10687. https://acp.copernicus.org/articles/20/10687/2020/

*Ground truth:*
- EFFIS Rapid Damage Assessment — MODIS 250 m mapping of fires ≥ ~30 ha; Sentinel-2
  refinement since 2018; ~95% burned-area coverage claim.
  https://forest-fire.emergency.copernicus.eu/about-effis/technical-background/rapid-damage-assessment
- NASA FIRMS FAQ (latency tiers, confidence conventions).
  https://www.earthdata.nasa.gov/data/tools/firms/faq

*Where a figure could not be verified against a current validation report (GEO detection
floor over BG at high view zenith; SLSTR quality-flag mapping), it is marked as a
placeholder in the text with the verification path named in §12.*

---

*End of review. This document is the normative statistical design for Fire Watch's
confidence score, clustering tuning, and detection-decay semantics; it supersedes
03-geodata §5.2.3 (confidence sketch) and answers open questions (a), (b), (c) of
00-summary. Revisit after the week-1 backfill delivers the fitted quantities flagged
in §12 items 1–4.*
