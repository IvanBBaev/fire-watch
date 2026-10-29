# Review 30 — Fire domain & data science (as built)

*Reviewer role: senior remote-sensing / fire-domain data scientist (active-fire products, burned-area validation, detection clustering, calibration). Date: 2026-10-30. Status: complete.*

*Inputs reviewed: README; docs/GATES.md (§2 fit gates, L-7, L-13, L-14, CP1); docs/TASKS.md (D1–D11, F9, F16, Track V2/V3); docs/data/DATASETS.md (DS-1 … DS-8); docs/DATA-SOURCES.md (§A2, §A4, cloud sidecar); docs/EXTERNAL-ACCOUNTS.md; docs/V3-FEATURES.md and docs/V3-WORKPLAN.md; reviews 03, 11, 12 (headers and the sections cited), 21 (format), 23 (in full), 00-summary round 4; code: `server/src/core/scoring/score-params.ts`, `server/src/core/clustering/clustering-params.ts`, `server/src/core/config/lifecycle-params.ts`, `server/src/core/config/fire-outline.ts`, `server/src/core/fit/fit-params.ts`, `server/src/core/fit/fit-report.ts`, `server/src/adapters/firesat/firesat-format.ts`, `server/src/adapters/firms/firms-keyless-client.ts`, `packages/contracts/src/sources.ts`; `git log` to `ccd541a`.*

---

## 1. Summary verdict

**CONDITIONAL GO for May 2027.** The machinery to fit, calibrate and replay is good, and it is honest about being unfitted. Not one parameter that decides what a user sees has met a single labelled fire. The 2026 season is over and nothing was recorded. The winter is the last window in which the numbers can be fitted before they go live.

1. **Every decision-bearing number is still a hand-set prior.** This covers about 35 numbers in `score_params_v0`, the ε / T_LINK / reignition windows in `clustering_params_v1` (ADR midpoints), the whole of `lifecycle_params_v1`, `fire_outline_params_v1`, `pass_table_v0`, `nrt_lag_histogram_v0` and `firesat_confidence_v0`. The headers say so, which is to the project's credit. The D7 fit has machinery but no run.
2. **CP1 (tomorrow, 31 Oct 2026) will be missed by its own rule.** There is no protocol document and no `docs/reports/`. shadow-PLB cannot be measured for 2026 at all, because there is no live `available_at`. The shadow-PCR fallback (a 2024–25 backfill replay) needs DS-1 and DS-3, and neither has been fetched. GATES: "a criterion without its evidence artifact counts as missed".
3. **DS-1 is blocked on a free, instant e-mail key, not on a host.** The FIRMS SP archive for one AOI and six seasons fits on a laptop. This one unblocks D7, L-13, L-14 and the CP1 fallback. It is the highest-leverage hour in the project.
4. **The fit design can return "no candidate" for structural reasons.** The gated bottom stratum is 10–50 ha (`fit-params.ts:115`). EFFIS burned-area perimeters are reliable only from about 30 ha (to verify against EFFIS documentation), so that stratum is underpowered and biased toward the larger, easier fires. Separately, 120 of the 150 grid cells sweep MODIS ε, and MODIS is retired from the live path.
5. **The derived products are honest in wording but unvalidated in substance.** "Estimated outlines" (V2-A4, built) are a morphological closing of pixel footprints that has never been compared to an EFFIS perimeter. V3-B1 (growth direction) and V3-A6 (agreement) are not yet built, and both can be built honestly. FireSat confidence is borrowed from MODIS cut points, and the adapter's comment says D7 "did" a fit that did not happen.
6. **False-positive suppression for the Balkans is half-ready.** The DS-5 mask is 97 % solar (6154 of 6366 sources). Agricultural burning, the dominant spring and autumn FP class in BG/RO/GR/MK, has no classifier: DS-7 found no cropland candidate reaching 70 %, and the F16 override-vs-annotate policy is still undecided.
7. **The source strategy is right.** It uses the VIIRS backbone, retires MODIS in the registry (Aqua is gone, Terra ends ~Feb 2027), keeps GEO attach-only, and reserves FireSat. One correction is needed: FireSat is reserved with `attachOnly: false`, and it must not seed events in its first season.

**Conditions for GO:**
- (a) MAP_KEY obtained, and DS-1 plus a DS-3 plan fetched and `--check`ed by 2026-11-20.
- (b) A dated CP1 report records the miss, and CP1′ is re-specified on backfill replay.
- (c) D7 has run, with a plateau and a v2 candidate or a documented "no candidate", by 2027-01-31.
- (d) L-13 calibration (Platt on 2024, ECE on 2025 touch-once) has been committed by 2027-03-31.
- (e) FireSat is attach-only until a validation season has passed.

## 2. Strengths (sound as built)

- **Config-as-data with digests everywhere.** Every number named in this review lives in a `defineConfig(name, version, values)` record with an FNV-1a digest. A fitted value can therefore replace a prior without touching code, and every recorded row can name the parameters it was produced under. This is the precondition for an honest fit, and it is already met.
- **Unfitted status is written down at the source.** `score-params.ts:6` says "none of these weights is fitted". `clustering-params.ts` calls the VIIRS ε "ADR range 1.0–1.5, midpoint taken". `FIRESAT_FORMAT_VERSION = '0-provisional'` (`firesat-format.ts:68`). Reviews 03 and 11 asked for this, and it is done.
- **The fit protocol is pre-registered and strict.** `fit-report.ts` `FIT_DECISIONS` fixes 18 choices before the data arrives. These include the label-join window [FIREDATE−1 d, FINALDATE+3 d], the buffer max(ε, 1 km), half-open strata, "unmeasured fails", a joint grid with a plateau rule, calibration that never re-selects, a ledger for the touch-once test season, and ε_geo assessed on 2025 only. The splits are fit 2020–23, calibrate 2024, test 2025 (`fit-params.ts:116`). That is textbook temporal hold-out, and better than most operational systems publish.
- **Gates are precision-first and stratified.** GATES §2: recall ≥ 0.95, precision ≥ 0.98 over hard negatives (20 km / 7 d), and over-split mean ≤ 1.15. "A pooled pass with a failing bottom stratum is a fail", and unlabelled clusters are never negatives. The last rule is the correct treatment of EFFIS incompleteness below the mapping floor.
- **The registry encodes the constellation in time.** `packages/contracts/src/sources.ts`: `firms:modis` is `retired` with `productTier: null` from 2026-08-02. `LiveSourceId` excludes reserved ids, so a source going live is forced by the type check to supply score and ε entries. `statusEffectiveFrom` makes replays reproduce the constellation as it was. L-14 (`constellation_2027_v1`) already exists as machinery.
- **The never-say-out stance holds in the model.** `lifecycle_params_v1` needs both diurnal phases (`requireBothDiurnalPhases: true`), a cloud gate (block above 80 %), an E-threshold of 3.0 (5.0 for large events) and `unobservableDays: 14`. It also enforces an FER ceiling (`ferMaxRate: 0.05`). The product says "no longer detected", never "out" (README invariants; review 12 §4).
- **GEO stays attach-only.** `lsasaf:seviri:frp-pixel` and `lsasaf:fci:frp-pixel` are `attachOnly: true`. Their pass-miss weights are `null` in the lifecycle (`lifecycle-params.ts`), so a 4 km SEVIRI pixel cannot create, merge or keep alive an event on its own. This is the right call for LSA-509 at demonstration maturity.
- **V3 keeps prediction out of scope.** V3-FEATURES lists "Fire spread or arrival-time forecast" as a non-goal, and V3-B1 is defined as "observed over the last N hours".

**What changed since reviews 03, 11, 12 and 23:**
- Review 03's R3 (FP mask) became DS-5 with a live policy, `static_source_policy_v2`.
- Review 03's R6 (MODIS sunset) became the registry retirement.
- Review 11's §3.7 and §4 (fit and tuning) became `pnpm fit`, `FIT_DECISIONS` and L-14 machinery.
- Review 23's E1 (dataset record) landed as DATASETS.

The part none of these reviews could produce is the data. It has not moved.

## 3. Risks & gaps (severity-ranked)

| # | Severity | Risk | Where |
|---|---|---|---|
| R-1 | Critical | Nothing that decides what a user sees has been fitted: score v0 (~35 numbers), clustering v1 (ADR midpoints), lifecycle v1, outline v1, pass table v0, lag histogram v0. If the winter fit slips, season 1 alerts and "no longer detected" run on priors. | `score-params.ts:6,16`; `clustering-params.ts:143-167`; `lifecycle-params.ts:161`; TASKS D7 |
| R-2 | Critical | DS-1 (FIRMS SP 2020–25) and DS-3 (EFFIS BA labels) are not fetched, so every `--check` field is blank. DS-1 waits only on a free instant MAP_KEY, and the plan's "needs a host" is not true for this size. DS-3 has no plan in code. | `docs/data/DATASETS.md` DS-1, DS-3 (line 91); `docs/EXTERNAL-ACCOUNTS.md` row 4 |
| R-3 | High | CP1 on 31 Oct 2026 has no protocol document and no `docs/reports/`. shadow-PLB cannot be measured for 2026, and the PCR fallback needs R-2. By GATES' own rule ("a criterion without its evidence artifact counts as missed"), CP1 is missed, which triggers the business pause. | `docs/GATES.md:219-244`; TASKS D11 (`blocked-external`) |
| R-4 | High | The 2026 season was not recorded. Lost for good: `available_at` and NRT latency, NRT-as-delivered positions and confidence, `data_availability` answers, live alert decisions, and possibly NOAA-21 NRT rows (no SP product exists). This permanently weakens D4, C9, shadow-PLB and the L-1 rehearsal. | DATASETS DS-2 ("First recorded day: —"); review 23 §5.5 |
| R-5 | High | The fit may return no candidate for structural reasons. The gated bottom stratum `10_50_ha` sits where EFFIS BA mapping is incomplete (reliable from ~30 ha, to verify), so the recall is underpowered and biased. Small fires (< 10 ha), the majority of Balkan ignitions, are never validated. | `fit-params.ts:115`; GATES §2 strata |
| R-6 | High | No agricultural-burn classifier exists for the Balkans. The DS-5 mask is 97 % solar. DS-7 WorldCover found no cropland threshold candidate reaching 70 %. `agri` weight −1.0 in score v0 has no fitted input behind it. The F16 override-vs-annotate policy and the S10 quarantine are founder calls that remain open. | DATASETS DS-5, DS-7; `score-params.ts` weights; TASKS F16, D6 |
| R-7 | Medium | 120 of the 150 D7 grid cells sweep MODIS ε, which is irrelevant to the 2027 live set. The live-relevant search is VIIRS ε × T_LINK (30 cells). That leaves the grid coarse where it matters and spends 80 % of the compute elsewhere. | `clustering_fit_grid_v1`; TASKS D7 lines 1168–1206 |
| R-8 | Medium | FireSat is `reserved` with `attachOnly: false`. Once flipped live, an unvalidated ~80 m sensor with borrowed confidence cut points (`nominalFrom: 0.3, highFrom: 0.8`, from MODIS 0–100) could seed events. The comment says the replacement will come "as D7 did for the other params", but D7 has fitted nothing. | `sources.ts:141-149`; `firesat-format.ts:84,89` |
| R-9 | Medium | Estimated outlines (V2-A4, built) use `closingKm: 0.375` and `cellKm: 0.05` and have never been scored against an EFFIS perimeter. The area bands shown to users have no measured bias. VIIRS pixel-union area overstates burned area at the swath edge, and the bias is expected to be large but unquantified. | `fire-outline.ts` (`fire_outline_params_v1`); V3-WORKPLAN (A4 built, unticked) |
| R-10 | Medium | L-14 can at best return `pass_unproven` on NOAA-20 alone. There are no NOAA-21 SP rows and no SLSTR archive entry in DS-1. Whether NOAA-20 may stand in for NOAA-21 is an undecided founder call. | `docs/GATES.md:209` |
| R-11 | Medium | LSA-509 (FCI) is at demonstration maturity and is `active`. It is attach-only (correct), but it has no 2025 back-archive (DS-4 has no plan), so ε_geo on 2025 cannot be assessed for FCI. | DATA-SOURCES §A4; DATASETS DS-4; `FIT_DECISIONS` (ε_geo on 2025) |
| R-12 | Low | The keyless client still maps `firms:modis` to `MODIS_C6_1_Europe_24h.csv`. The registry marks it retired, but whether the keyless path filters on `activeSources()` was not verified. Rows from a retired source would also enter E. | `firms-keyless-client.ts:59`; `sources.ts:104-114` |
| R-13 | Low | DS-2 identity drift. DATASETS still names `effis_layers_v2 023fa090` and `source_registry_v1`, while code is `effis_layers_v3` (V2-B1, commit `031b18e`) and `source_registry_v2`. Only the registry bump has a history line. Nothing has been recorded under either, so there is no data harm, but the record is stale. | `docs/data/DATASETS.md:67,80` |
| R-14 | Low | The count cited in memory and TASKS ("20 FIT_DECISIONS") does not match the code, which has 18 entries. This is minor, but it is the kind of drift a founder review of the decisions will trip over. | `server/src/core/fit/fit-report.ts` |

## 4. Detailed recommendations

- **E-1 [MVP] Get the MAP_KEY and fetch DS-1 on a laptop this week (R-2).**
  - Request the FIRMS MAP_KEY. It is free and arrives by e-mail.
  - Run `firms_sp_backfill_2020_2025_v1` (666 chunks) locally, with no host, then run `--check`.
  - Fill the DS-1 fields: row counts per source and season, the hash, and the fetch date.
  - Also pull the NOAA-21 NRT archive download for 2023–2026 if FIRMS serves it (to verify). It is the only route to NOAA-21 rows for L-14.
  - Owner: founder (key, 0.25 founder-h) and agent (fetch and check, 3 h).
- **E-2 [MVP] Write a DS-3 plan in code: an EFFIS BA perimeter fetch for 2020–2026 (R-2, R-4).**
  - The layers `modis.ba.poly.2016…2025` were verified accessible on 2026-10-10. Add 2026 once EFFIS publishes it (to verify).
  - Use a versioned plan with a digest and `--check`, the same shape as DS-1.
  - Record EFFIS's own mapping floor in the dataset record. The fit needs it (E-5).
  - Owner: agent, 6 h.
- **E-3 [MVP] Close CP1 honestly with a dated report today, then re-specify it as CP1′ (R-3).**
  - Create `docs/reports/cp1-2026-10-31.md`. State the protocol status, each criterion, its evidence (none), and the verdict "missed, per GATES rule".
  - Record which criteria are unmeasurable forever (shadow-PLB 2026).
  - Propose CP1′ for 2027-01-15: shadow-PCR measured on the 2024–25 backfill replay against DS-3. PLB is deferred to the first live month.
  - Whether the business-pause consequence applies is a founder decision (Q1).
  - Owner: agent, 2 h, plus founder 0.5 h.
- **E-4 [MVP] Re-cut the D7 grid for the 2027 constellation (R-7).**
  - Hold MODIS ε at its rule value. MODIS matters only for 2020–23 history, and a fixed footprint rule is enough.
  - Spend the grid on VIIRS ε ∈ {0.75, 0.875, 1.0, 1.125, 1.25, 1.375, 1.5} × T_LINK ∈ {24, 36, 48, 60, 72} h × activeWindow {48, 72, 96} h. That makes 105 cells against a plateau that can actually be resolved.
  - Bump `clustering_fit_grid_v1` → `v2` and add a FIT_DECISIONS entry for the change.
  - Owner: agent, 3 h.
- **E-5 [MVP] Make the bottom stratum measurable, or report its power (R-5).**
  - Before the run, compute n per stratum per season from DS-3 and the Wilson 95 % interval on recall at the expected n.
  - If the 10–50 ha upper bound cannot exclude 0.95, either move the gated bottom stratum to 30–100 ha or keep 10–50 ha as "reported, non-gating", with a founder decision before the data is seen.
  - Add the < 10 ha population as a descriptive metric, never gated.
  - Owner: agent, 4 h, plus founder 0.5 h.
- **E-6 [MVP] Run D7 and fit score v1 (R-1).** Order:
  1. `pnpm fit` on fit 2020–23 → plateau → `clustering_params_v2` candidate (`active: false`).
  2. On the same clusters, fit score v1 as an L2-regularised logistic. Positive = intersects an EFFIS perimeter (buffer max(ε, 1 km)). Negative = hard negatives only. Unlabelled stays out of training.
  3. Fit per-source p_det (pass-miss weights) from observed detection given an overpass, using `pass_table` swaths.
  4. Replay FER (the "no longer detected" false rate) on 2020–23 against `lifecycle_params_v1`, and adjust the E-thresholds.

  Owner: agent, 24 h (fit 8, score 8, p_det 4, FER 4).
- **E-7 [MVP] Calibrate and test, which is L-13 (R-1).**
  - Fit Platt on 2024. Run reliability, ECE ≤ 0.07, slices and bucket re-derivation on 2025, touched once and logged in the ledger.
  - Commit `score_params_v1` with a digest, and record the calibration in DATASETS as a consumer of DS-1 and DS-3.
  - Owner: agent, 8 h.
- **E-8 [MVP] Validate the estimated outlines against EFFIS (R-9).**
  - For every DS-3 perimeter ≥ 50 ha in 2024, compare the A4 outline built from SP rows: IoU, area ratio (outline / EFFIS) and its distribution by size and by VIIRS scan angle.
  - Publish the area-band bias in the outline's own help text ("tends to over-state by ~x %").
  - Tune `closingKm` only on 2020–23.
  - Owner: agent, 8 h.
- **E-9 [MVP] FireSat stays attach-only until validated (R-8).**
  - Flip `efa:firesat` to `attachOnly: true` in the reserved row now (`source_registry_v3`). It is a registry bump, so it is cheapest before any FireSat row exists.
  - Replace the "as D7 did" comment with "as D7 will".
  - The `_v1` confidence cut points come from a season of FireSat × VIIRS match-ups (≥ 500 matched pixels, to be set in FIT_DECISIONS).
  - Owner: agent, 1.5 h.
- **E-10 [v1] Agricultural-burn labelling (R-6).**
  - Stay with "show but label" (review 11 §7). Build a v1 classifier from features that already exist: CORINE/WorldCover arable class at 100 m, day-only, low FRP (< 10 MW), short persistence (≤ 1 overpass), and season (Mar–Apr, Aug–Oct).
  - Fit on 2020–23 using hard negatives in arable cells as positives for "agri". Measure precision of the label on 2024.
  - Never suppress; label only, until the founder decides F16.
  - Owner: agent, 12 h, plus founder 1 h (F16, S10).
- **E-11 [v1] Refresh the hot-source mask and cover the Balkan industrial gaps (R-6).**
  - Re-run DS-5 from OSM. Add a persistence-derived mask: VIIRS SP pixels detected on ≥ N distinct days in ≥ 3 of the 6 seasons outside the fire season, within 375 m. This is the standard static-source method (to verify against literature).
  - Compare it with the OSM mask and list the persistent hot spots OSM misses, such as cement, steel and landfills.
  - Owner: agent, 6 h.
- **E-12 [v1] Settle the L-14 stand-in and the GEO pairing (R-10, R-11).**
  - Founder call: NOAA-20 stands in for NOAA-21. Both are JPSS VIIRS with the same I-band, so the stand-in is defensible. Mark it as an assumption in the L-14 report.
  - Fetch a 2025 LSA-502 sample (DS-4 plan) for ε_geo.
  - LSA-509 must never seed or extend an event without a matching 502 or LEO detection within the GEO ε.
  - Owner: agent, 5 h.
- **E-13 [v1] Fix the record drift and verify the keyless MODIS path (R-12, R-13, R-14).**
  - Add the `effis_layers_v3` history line to DS-2 and correct the identity row.
  - Assert in a test that the keyless client never fetches a retired source.
  - Correct "20" to "18" FIT_DECISIONS wherever it is cited.
  - Owner: agent, 1.5 h.
- **E-14 [v2+] Recover what 2026 still offers.**
  - **2026 SP:** a re-run of DS-1 for 2026 once FIRMS publishes SP, typically months after the season (to verify).
  - **ERA5 for 2026:** fetch it in place of the ECMWF open fields at overpass. This needs a CDS account (EXTERNAL-ACCOUNTS).
  - **EUMETSAT CLM archive for 2026** (to verify availability).
  - With these, 2026 becomes a fifth fit season or a second test season.
  - Owner: agent, 8 h, plus founder 0.5 h (CDS account).

## 5. Fire domain & data science deep dive

### 5.1 Inventory of unfitted parameters and the evidence each needs

| Config | Numbers (as built) | Evidence that fits it | Dataset |
|---|---|---|---|
| `score_params_v0` | intercept −2.0; 10 weights (best 1.8 … glint −0.8); 16 confidence priors; floors 0.75 / 0.45; 6 shape constants | Logistic on hard-negative-labelled clusters, Platt on 2024, L-13 on 2025 | DS-1 + DS-3 |
| `clustering_params_v1` | VIIRS ε 1.25 km; SLSTR 1.5; GEO 5.5; T_LINK 48 h; active 72 h; reignition 7/14/21 d; review hull 20 km | D7 joint grid + plateau; reignition from EFFIS re-burn within a season | DS-1 + DS-3 |
| `lifecycle_params_v1` | pass-miss weights (VIIRS 1.0/1.25, SLSTR 0.75); E 3.0/5.0; cloud gate 80/50 %; unobservable 14 d | Per-source p_det given overpass; FER replay ≤ 5 % | DS-1 + pass table + cloud proxy (ERA5 `tcc`) |
| `fire_outline_params_v1` | closing 0.375 km; cell 0.05 km; VIIRS default footprint 0.375 km | IoU / area ratio against EFFIS ≥ 50 ha | DS-1 + DS-3 |
| `pass_table_v0` | static overpass predictor | Observed SP acquisition times vs predicted | DS-1 |
| `nrt_lag_histogram_v0` | latency prior | Live `available_at` only: **no archive can fit it** | DS-2 (2027) |
| `firesat_confidence_v0` | 0.3 / 0.8 from MODIS | FireSat × VIIRS match-ups | none yet (V3-Q5) |
| `static_source_policy_v2` | OSM mask, radius, quarantine-after-3 | Persistence mask from 6 SP seasons | DS-1 + DS-5 |
| `lightning_filter_v1`, `cloud_cover_v1` | thresholds | Synthetic only (lightning); ERA5 `tcc` vs CLM | ERA5, CLM archive |

Two of these cannot be fitted from any archive: `nrt_lag_histogram_v0` and the shadow-PLB clock. Season 1 will run them on priors in any case, so the product copy must not imply measured latency until July 2027 at the earliest.

### 5.2 What the unrecorded 2026 season costs, and what is recoverable

**Recoverable (archive exists or will exist):**
- FIRMS SP for S-NPP, NOAA-20 and MODIS for 2026, once published (lag to verify).
- EFFIS 2026 perimeters (`modis.ba.poly.2026`, to verify).
- ERA5 reanalysis for the weather context, which is not the same as the ECMWF open fields at overpass but is fit for training.
- EUMETSAT CLM and LSA SAF reprocessing (to verify).
- Possibly NOAA-21 NRT through the FIRMS archive download (to verify).

**Lost forever:**
- `available_at` per row, so the true latency, the shadow-PLB and the D4 / C9 lag validation for 2026.
- NRT-as-delivered values, before SP reprocessing (positions, confidence flags, missing granules).
- `data_availability` responses and outages as experienced.
- The alert decisions the system would have made, so there is no L-1 rehearsal and no shadow diff for 2026.
- NOAA-21 rows, if FIRMS does not archive NRT. In that case L-14 for the real 2027 primary sensor rests on NOAA-20 as a proxy.

**Consequence by gate:**
- **CP1:** missed (R-3). CP1′ on replay measures PCR only.
- **L-13:** unaffected in design, because it uses 2024 and 2025, but it is fully blocked on DS-1 and DS-3.
- **D7:** unaffected in design, and blocked on the same.
- **Shadow period:** collapses to the pre-season weeks of 2027 (April–May). That is too few fires (≤ 20 perimeters ≥ 50 ha, likely far fewer) to grade anything. Treat the first live month as the shadow period, with alerts labelled beta.

### 5.3 Scientific honesty of the derived products

- **Estimated outlines (A4, built).**
  - The word "estimated" is right. The area band is not yet earned.
  - A union of VIIRS pixel footprints with closing measures where fire was *detected at overpass*, not what burned. It overstates area at the swath edge and understates it for fast grass fires between overpasses.
  - Until E-8 publishes a measured bias, show area as a coarse band ("about 50–200 ha") with "from satellite hot-spots, not a mapped perimeter".
  - Never show it beside EFFIS without saying which one is which.
- **Growth direction (V3-B1, not built).** This is honest only if all of the following hold:
  - it requires ≥ 3 outlines from ≥ 2 distinct overpass times;
  - it suppresses the arrow when the centroid drift is below one VIIRS pixel at the scan angle (≈ 0.4–0.8 km) or below the outline's own uncertainty;
  - it labels the time window and sensor mix.

  Centroid drift between a night NOAA-20 pass and a day S-NPP pass is often a sampling artefact, not growth. The arrow must never extrapolate, and a length that scales with speed reads as a forecast. Keep the length fixed and show only bearing and window. V3-Q1 should answer "show, with these guards".
- **Cross-source agreement (V3-A6, not built).** "Seen by 3 sources in 40 min" is descriptive and safe. The guards:
  - S-NPP, NOAA-20 and NOAA-21 are one sensor design on one orbit plane, offset by roughly 50 min, so they are not independent evidence.
  - Count *instrument families* (VIIRS, SLSTR, GEO, FireSat), not satellites.
  - Never merge the count into the score without fitting it. The score already has `multisrc` 0.8, so this would double-count it.
- **FireSat confidence.** MODIS 0–100 cut points carry no meaning on an 80 m detector with a different noise model.
  - Display FireSat detections as "unvalidated source" for one season.
  - Keep them attach-only (E-9).
  - Never let them affect "no longer detected". A higher-resolution sensor seeing nothing is not an absence of fire at 375 m scale, and its pass-miss weight must stay `null` until fitted.
- **Never say "out".** The lifecycle is sound. The remaining risk is copy, not model: the 14-day `unobservableDays` and the cloud gate must reach the UI as "not observable (clouds)" rather than silence (review 12 §4.4).

### 5.4 False-positive suppression readiness for the Balkans

- **Industrial and solar.**
  - The DS-5 OSM mask covers solar well (6154 sources), but solar is a minor FP class for VIIRS at night.
  - The classes that matter are thermal power (172), steel and cement plants, refineries and gas flares (7), and landfill fires.
  - The persistence mask (E-11) is the established method and costs nothing beyond DS-1.
- **Agricultural burns** are the dominant FP-by-intent class: stubble burning in BG, RO, MK and northern GR, mostly March–April and August–October.
  - They are real fires, so "suppression" is the wrong frame. Label them (E-10) and let the user's sensitivity setting decide.
  - DS-7's failure to find a 70 % cropland candidate means the class cannot be a hard rule. It must be a fitted feature.
  - CORINE (D10, open) would be a better arable layer for the EU members than WorldCover.
- **Readiness.** The mask is there and the policy is versioned, but the agricultural signal is unfitted and there are three open founder calls (F16, S10, D10). The precision gate (≥ 0.98 over hard negatives) is set before any of this is fitted, which is correct. A miss on the Balkan strata is the expected outcome if E-10 and E-11 slip.

### 5.5 Source strategy for 2027

- **VIIRS backbone (NOAA-20, NOAA-21, S-NPP while it lasts).** This is right, and the L-14 constellation is correct to drop S-NPP from the gate.
  - The S-NPP end-of-life date is to verify. It is old and could be lost mid-season, so the live system must not depend on it for pass coverage.
  - The `pass_table` must handle a missing satellite without inflating E: a retired source leaves `expectedOverpassSources()`, which is already in the design.
- **MODIS.** Its retirement is correct. Keep it as fit history for 2020–23 only, and stop fitting its ε (E-4).
- **SLSTR.** NRT < 3 h, night-capable, ~1 km. It is useful as a second family, but DS-1 has no SLSTR archive rows, so its ε and p_det are unfitted. Hold it to attach-only plus E contribution until a season of match-ups exists. This would change `attachOnly` for `eumetsat:slstr:frp` and is a founder call (Q5).
- **GEO through LSA SAF.**
  - LSA-502 (SEVIRI, ~4 km, ~30 min) is operational. Its value is *timing*: the first sign of an afternoon ignition between LEO passes.
  - LSA-509 (FCI, ~1.5 km class, on EUMETCast since 7 May 2026) is demonstration maturity, so pair it with 502 (E-12).
  - The FCI/SEVIRI CLM cloud sidecar is planned pre-season 2027 with a `tcc` fallback. Never use Open-Meteo for it (DATA-SOURCES).
- **FireSat.** Timing, format, terms and access are all unknown (V3-Q5). Plan season 1 without it, and treat any 2027 data as a validation season (E-9).

### 5.6 Winter plan, November 2026 to April 2027

| Month | Work | Exit artifact |
|---|---|---|
| Nov (by 20th) | MAP_KEY. DS-1 fetched on a laptop and `--check`ed. NOAA-21 NRT archive probe. DS-3 plan written and fetched. CP1 report (miss) and CP1′ spec. DS-2 identity fix. FireSat attach-only. | DATASETS DS-1 and DS-3 filled; `docs/reports/cp1-2026-10-31.md` |
| Dec | Founder review of FIT_DECISIONS (18) plus the E-4 grid and E-5 stratum power. Then the D7 run on 2020–23, plateau, `clustering_params_v2` candidate. | Fit report; candidate or a documented "no candidate" |
| Jan | Score v1 logistic. Per-source p_det. FER replay and lifecycle E re-fit. CP1′ (PCR on 2024–25 replay) by 15 Jan. Outline validation (E-8). | `score_params_v1` candidate; CP1′ report; outline bias table |
| Feb | Platt on 2024. L-13 on 2025, touched once. Bucket re-derivation. | L-13 report; ledger entry |
| Mar | L-14 replay (NOAA-20 for NOAA-21). Pass-table fit from SP acquisition times. Persistence mask (E-11). Agricultural label v1 (E-10). | L-14 report; DS-5 refresh |
| Apr | Freeze. All v1 configs active, with digests in DS-2 identity. Pre-season re-check. Live recording starts (needs a host) on 1 April at the latest, so the 2027 season is not lost too. | DS-2 "First recorded day" filled |

Total agent effort is about 92 h (Appendix A). That fits the winter only if DS-1 lands in November. Each week of slip on the key takes a week from the calibration month, which is the step that cannot be compressed.

## 6. Open questions for the founder

1. **Does the CP1 miss trigger the business pause?** *Recommended:* yes, as written. The pause costs nothing before launch. Record the miss and grade CP1′ on 15 Jan 2027 against the backfill replay.
2. **May an agent fetch DS-1 on this laptop instead of waiting for a host?** *Recommended:* yes. The archive is small, the plan is versioned, and the digest proves identity wherever it was fetched.
3. **Which bottom stratum is gated: 10–50 ha or 30–100 ha?** *Recommended:* decide after E-5's power table and before the fit sees labels. If 10–50 ha cannot reach the power, gate 30–100 ha and report 10–50 ha as non-gating.
4. **May NOAA-20 stand in for NOAA-21 in L-14?** *Recommended:* yes, as a recorded assumption, re-checked on the first live month of NOAA-21 rows.
5. **Should SLSTR and FireSat be attach-only until a season of match-ups exists?** *Recommended:* yes for both. Seeding stays VIIRS-only in season 1.
6. **Agricultural burns: suppress, annotate or label (F16 / S10)?** *Recommended:* label and never suppress. Let the sensitivity setting filter labelled agricultural events. Default sensitivity shows them as "likely agricultural burning".
7. **V3-B1 growth direction: show it at all?** *Recommended:* show it, with the §5.3 guards: bearing only, fixed length, window and sensor mix in the label, and suppressed below one-pixel drift.
8. **Start live recording on 1 April 2027 even if the product is not ready?** *Recommended:* yes. A second unrecorded season would leave latency and PLB unmeasurable through 2027 as well.

## Appendix A — Proposed rows for the shared documents

### (a) TASKS rows

- [ ] **R5-DATA-1 — FIRMS MAP_KEY and DS-1 fetched on a laptop.** Spec: review 30 E-1. Writes: `docs/data/DATASETS.md` (DS-1 fields), `docs/EXTERNAL-ACCOUNTS.md` (row 4 status). Done when: `firms_sp_backfill_2020_2025_v1 --check` passes and the DS-1 row counts per source and season plus the hash are recorded. Est: 3 h. Status: blocked-owner.
- [ ] **R5-DATA-2 — DS-3 EFFIS burned-area plan in code and fetched.** Spec: review 30 E-2. Writes: `server/src/core/fit/` (plan config), `docs/data/DATASETS.md` (DS-3). Done when: a versioned plan with a digest fetches 2020–2025 perimeters and `--check` passes, with the EFFIS mapping floor recorded. Est: 6 h. Status: open.
- [ ] **R5-DATA-3 — CP1 report recording the miss, and the CP1′ spec.** Spec: review 30 E-3. Writes: `docs/reports/cp1-2026-10-31.md`, `docs/GATES.md` (CP1′ row). Done when: the report lists every CP1 criterion with evidence or "missed", and CP1′ has a date, a metric and a dataset. Est: 2 h. Status: open.
- [ ] **R5-DATA-4 — D7 grid re-cut for the 2027 constellation.** Spec: review 30 E-4. Writes: `server/src/core/fit/fit-params.ts`, `server/src/core/fit/fit-report.ts`. Done when: `clustering_fit_grid_v2` sweeps VIIRS ε × T_LINK × active window with MODIS ε fixed, and a FIT_DECISIONS entry records the change. Est: 3 h. Status: open.
- [ ] **R5-DATA-5 — Bottom-stratum power analysis before the fit.** Spec: review 30 E-5. Writes: `server/src/core/fit/` (power report), `docs/GATES.md` §2. Done when: n per stratum per season and the Wilson bound are reported from DS-3, and the founder has chosen the gated stratum before any recall is computed. Est: 4 h. Status: blocked-external.
- [ ] **R5-DATA-6 — D7 run, score v1 fit, p_det and FER replay.** Spec: review 30 E-6. Writes: `server/src/core/clustering/clustering-params.ts`, `server/src/core/scoring/score-params.ts`, `server/src/core/config/lifecycle-params.ts` (candidates, `active: false`). Done when: the fit report shows a plateau or "no candidate", and `score_params_v1` and `lifecycle_params_v2` candidates exist with digests. Est: 24 h. Status: blocked-external.
- [ ] **R5-DATA-7 — L-13 calibration on 2024 and test on 2025.** Spec: review 30 E-7. Writes: `server/src/core/scoring/score-params.ts`, `docs/data/DATASETS.md`. Done when: ECE ≤ 0.07, Confirmed ≥ 0.90 and Likely ≥ 0.60 on the 2025 test season, logged once in the ledger. Est: 8 h. Status: blocked-external.
- [ ] **R5-DATA-8 — Estimated-outline validation against EFFIS.** Spec: review 30 E-8. Writes: `server/src/core/outlines/` (validation CLI), `server/src/core/config/fire-outline.ts`. Done when: the IoU and area-ratio distribution by size and scan angle for 2024 ≥ 50 ha is published, and the help text cites the measured bias. Est: 8 h. Status: blocked-external.
- [ ] **R5-DATA-9 — FireSat attach-only, and the comment corrected.** Spec: review 30 E-9. Writes: `packages/contracts/src/sources.ts`, `server/src/adapters/firesat/firesat-format.ts`. Done when: `efa:firesat.attachOnly === true` under `source_registry_v3`, the tests are green, and "as D7 did" is corrected. Est: 1.5 h. Status: open.
- [ ] **R5-DATA-10 — Agricultural-burn label v1.** Spec: review 30 E-10. Writes: `server/src/core/scoring/` (agri feature), its config. Done when: label precision measured on 2024 is reported per country (BG/RO/GR/MK), with label-only behaviour. Est: 12 h. Status: blocked-external.
- [ ] **R5-DATA-11 — Persistence hot-source mask from SP seasons.** Spec: review 30 E-11. Writes: `server/src/core/config/static-source-policy.ts`, `docs/data/DATASETS.md` (DS-5). Done when: the mask is derived from DS-1 and a diff against OSM lists the persistent sources OSM misses. Est: 6 h. Status: blocked-external.
- [ ] **R5-DATA-12 — L-14 stand-in recorded, plus the DS-4 LSA-502 2025 sample.** Spec: review 30 E-12. Writes: `docs/GATES.md` (L-14), `docs/data/DATASETS.md` (DS-4). Done when: the L-14 report states the NOAA-20 assumption, and a 2025 LSA-502 sample is `--check`ed. Est: 5 h. Status: blocked-owner.
- [ ] **R5-DATA-13 — Record drift fixes and the keyless retired-source test.** Spec: review 30 E-13. Writes: `docs/data/DATASETS.md`, `server/src/adapters/firms/firms-keyless-client.test.ts`. Done when: the DS-2 identity names `effis_layers_v3` and `source_registry_v2`, and a test proves no retired source is fetched. Est: 1.5 h. Status: open.
- [ ] **R5-DATA-14 — 2026 recovery: SP, ERA5 and the CLM archive.** Spec: review 30 E-14. Writes: `docs/data/DATASETS.md` (DS-1 2026 extension, new ERA5 row). Done when: the 2026 SP rows and ERA5 overpass fields are fetched and `--check`ed. Est: 8 h. Status: blocked-external.

### (b) RISKS §2 / GATES rows

- **RISKS:** *The winter fit window is the last chance to fit before launch.* If DS-1 is not fetched by 2026-11-20, L-13 cannot complete by March, and season 1 runs on priors. Owner: founder (key). Mitigation: R5-DATA-1 this week.
- **RISKS:** *2026 is unrecorded, and so latency and PLB are unmeasured until mid-2027.* Mitigation: live recording from 1 April 2027 at the latest (Q8); no latency claims in product copy before then.
- **GATES:** **CP1′ — 15 January 2027.** shadow-PCR ≥ 95 % (≥ 50 ha) on the 2024–25 backfill replay against DS-3, using the synthetic grid zones as specified for CP1. PLB is deferred to the first live month. The consequence is the same as CP1.
- **GATES §2 addendum:** the gated bottom stratum must be chosen from a pre-fit power table (R5-DATA-5). A stratum whose Wilson upper bound cannot exclude the threshold at the available n is reported, not gated.

### (c) 00-summary synthesis paragraph

Review 30 finds the fit, calibration and replay machinery sound and candid about being unfitted. Every number that decides what a user sees, however, is still a prior, and no labelled fire has passed through it. CP1 is missed by its own evidence rule, and the 2026 season's latency and live-decision record are lost. Most of the training signal is recoverable, though: DS-1 needs only a free instant FIRMS key and a laptop. The verdict is a conditional GO, provided DS-1 and DS-3 land by 20 November and D7 by January. L-13 must be committed by March, and FireSat stays attach-only until validated.

## Appendix B — What was verified, and how

- **Parameter values** were read directly from code:
  - `score-params.ts` (header line 6, values);
  - `clustering-params.ts:135–190` (ε 1.25 at lines 143–145, `tLinkHours: 48` at line 167);
  - `lifecycle-params.ts` (the `defineConfig` block, `eThreshold` at line 161);
  - `fire-outline.ts` (the `defineConfig` block);
  - `fit-params.ts:115–118`;
  - `firesat-format.ts:68,84,89`;
  - `packages/contracts/src/sources.ts` (whole file).
- **FIT_DECISIONS count (18)** was counted with awk over `fit-report.ts`.
- **D7 grid composition** (150 configs; 120 cells varying MODIS ε) comes from TASKS D7 and the grid config description. The cell arithmetic was not re-run through `pnpm fit`, which was not executed per the brief.
- **Dataset state** was read from `docs/data/DATASETS.md`:
  - DS-1 not fetched;
  - DS-2 identity at line 67, history at line 80;
  - DS-3 has no plan (line 91);
  - DS-5 counts and DS-7 result as stated there.
- **MAP_KEY status** was read from `docs/EXTERNAL-ACCOUNTS.md` row 4.
- **CP1 rule and date** were read from `docs/GATES.md:219–244`. `docs/reports/` was confirmed absent with `ls`.
- **V3 build status** comes from `docs/V3-WORKPLAN.md:60–66`: A1 done, A6 and B1 todo, A4 built and unticked per V3-FEATURES line 34.
- **Keyless MODIS mapping** is at `firms-keyless-client.ts:59`. Whether the poll loop filters retired sources was **not verified** (R-12).
- **`effis_layers_v3` bump** was taken from `git log` (commit `031b18e`).
- **Not verified, to verify externally (no web access):**
  - EFFIS BA reliability floor (~30 ha);
  - FIRMS SP publication lag for 2026;
  - whether FIRMS archives NOAA-21 NRT;
  - EFFIS 2026 layer availability;
  - EUMETSAT CLM and LSA SAF reprocessing archives;
  - S-NPP end of life;
  - the Terra end date (~Feb 2027, per DATA-SOURCES §A2).
- **Not run:** `pnpm verify`, `pnpm fit`, any test suite or build, per the brief.
