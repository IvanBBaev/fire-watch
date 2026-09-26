# Review 03 — Geospatial Data Engineering

*Role: senior data engineer, geospatial/EO pipelines. Scope: data sources, ingestion, storage,
clustering, enrichment — as proposed in `docs/ANALYSIS.md` and `docs/decisions/001-map-stack.md`.*
*Date: 2026-07-21. Status of reviewed project: pre-code.*

---

## 1. Summary verdict

**Sound thesis, credible architecture, but the data layer is one level of detail away from being
buildable — and two source-table claims are wrong.** The core strategic calls are correct:
aggregate-don't-detect, event-centric domain model, PostGIS from day one, append-only raw
detections, poll-don't-stream at MVP, honest-freshness UX. What is missing is the unglamorous
middle: a normalized detection identity that survives FIRMS NRT→SP reprocessing, a clustering
algorithm that keeps stable event IDs (plain DBSCAN re-runs do not), a concrete false-positive
mask (Bulgaria has a very large static heat source — the Maritsa Iztok complex — that will
otherwise be the site's most persistent "fire"), and a realistic plan for the MTG FCI adapter,
which is currently both underestimated in effort and pointed at the wrong product (FIR gives a
fire *class*, not FRP; LSA SAF's MTG FRP-PIXEL is the better stream). Fact-check corrections:
FIRMS URT latency is "within 5 minutes", not 25–50 seconds; FIRMS RT is North-America-only in
practice; EFFIS NRT burnt-area perimeters are MODIS/VIIRS-derived, not Sentinel-2-based; the
`day_range` parameter has UTC-calendar-day semantics that will silently drop detections if
polled naively. All fixable pre-code — this review supplies the concrete designs.

**Verdict: GO, conditional on adopting the detection-identity, clustering-identity and
static-source-mask designs below before the first line of ingestion code.**

---

## 2. Strengths

1. **"Compete on aggregation, not detection" is the right thesis** and it correctly shapes the
   data architecture: source-agnostic normalized `Detection`, `FireEvent` as the core entity,
   raw detections kept append-only for re-clustering. This is exactly how you build a system
   whose inputs (FireSat, MTG, future sensors) improve underneath it.
2. **Poll-don't-stream at MVP is correct.** A Balkan bbox from FIRMS is a few KB of CSV; the
   5,000 transactions / 10 min MAP_KEY budget (confirmed against current API docs) exceeds any
   sane polling schedule by ~3 orders of magnitude. EUMETCast hardware/complexity is rightly
   deferred.
3. **PostGIS from day one is the right call** — geofence alerting (`ST_DWithin`), clustering
   support (`ST_ClusterDBSCAN` exists as a window function for offline runs), hulls, and
   GeoJSON emission are all native. SQLite/SpatiaLite would be re-platformed within months.
4. **Honest-freshness UX as first-class data** (`last_observed_at`, next expected pass, never
   imply live) is both ethically right and, for a fire product, the trust moat. Few competitors
   do this; FIRMS itself does not surface it well.
5. **The validation plan is genuinely good** — especially item 1 (measure real
   observation→availability lag for a BG bbox for a week before building). That experiment will
   confirm most of what this review says about latency, for free.
6. **ADR-001 is sound from the data side.** MapLibre + vector tiles + EFFIS as a plain WMS
   raster source is the right weight of solution; the flat-cost tile strategy matches the
   spike-load reality of fire products. (One CORS/CRS caveat below, §5.5.)
7. **The two-stream fusion framing** (geostationary = fast/coarse, polar = slow/precise) is the
   correct mental model and is where the product's data-engineering value actually lives.

---

## 3. Risks & gaps (severity-ranked)

### R1 — HIGH: Detection identity across FIRMS reprocessing is unspecified
NRT detections are *replaced* by standard/science-quality (SP) data with a ~5-month lag, with
shifted coordinates (geolocation refinement; up to 12 h of degraded positioning after Aqua
manoeuvres per the FIRMS FAQ), changed confidence values, and rows added/removed. There is no
stable row ID from NASA. Without a deliberate identity + tier strategy, the historical dataset
silently mutates under the clustering tuner, and "same detection seen in multiple polls" becomes
duplicate map points. Design in §5.1.

### R2 — HIGH: The MTG FCI plan points at the wrong product and underestimates effort
- **FCI L2 FIR** (EUMETSAT Data Store collection `EO:EUM:DAT:0682`, netCDF on the geostationary
  grid) is a per-pixel fire *classification* — it carries **no FRP**. The analysis treats it as
  the real-time analogue of FIRMS rows; it is not.
- **LSA SAF MTG FRP-PIXEL (MTFRPPIXEL, LSA-509)** — released Oct 2025 as a demonstration
  product with back-processing from Jan 2025 — is a *list-of-fire-pixels* product **with FRP**,
  from FCI's IR3.8 at 1 km sampling (HRFI) vs SEVIRI's 3 km. It is the natural geostationary
  feed for this platform and far easier to consume than a full-disk gridded classification.
- End-to-end latency via Data Store polling is realistically **15–30 min** (10-min repeat cycle
  + L2 processing + publication + poll interval), not "~min". Still transformative vs 3 h NRT,
  but the table's claim needs correcting.
- The integration is a **Python sidecar** (eumdac + satpy/netCDF4 + pyresample) in an otherwise
  TypeScript stack — a real polyglot cost. "One evening" is a decode smoke test; the adapter is
  1–2 weeks of part-time work. Details in §5.4.

### R3 — MEDIUM-HIGH: No concrete false-positive mask, and Bulgaria's biggest one is predictable
The **Maritsa Iztok** lignite complex (TPPs near Galabovo/Radnevo, plus the open-pit mines),
the Lukoil Neftochim Burgas flare, cement and metallurgical plants will produce persistent
thermal anomalies year-round. Watch-zone alerting without a static-source mask will page users
about power plants. The analysis names the mitigation (land-cover masking) but specifies no
data, no algorithm, no schema. Design in §5.2.4. This must ship *before* alerting, not after.

### R4 — MEDIUM-HIGH: DBSCAN "~2 km / 24 h" is a slogan, not an algorithm
Naive re-runs of DBSCAN over a sliding window produce **unstable event IDs** (alerts re-fire,
permalinks break, history rewrites), can't handle merge/split, and one ε for 375 m VIIRS pixels,
1 km MODIS pixels (≈4 km at swath edge) and ~3–4.5 km effective FCI pixels over Bulgaria is
wrong for at least two of the three. The 24 h linking window will split slow/smouldering fires
that gap over a cloudy day. Concrete incremental algorithm + parameters in §5.2.

### R5 — MEDIUM: Source-table factual errors and oversimplifications
Corrections (details in §5.0): URT latency ("within 5 minutes", not 25–50 s); RT coverage
(US/Canada/parts of Mexico — for Bulgaria only NRT exists, full stop); EFFIS NRT burnt areas
are MODIS/VIIRS-derived (Sentinel-2 enters refined/final mapping, not the NRT perimeters);
current EFFIS WMS fire-danger layers are `mf010.*` (the `ecmwf007.*` names circulating in older
docs/blogs have been superseded — verify at integration time); FIRMS area-API `day_range`
accepts 1–5 per current docs and counts *UTC calendar days*, not trailing 24-h windows;
"4–6 usable overpasses/day" understates the pass count (3 VIIRS + 2 MODIS platforms → ~8–12
observation opportunities/day) but misses the real issue — passes are **bunched** near
~01:30/13:30 local (VIIRS) and ~10:30/22:30 (MODIS), leaving multi-hour diurnal blind windows,
which matters more for the alerting promise than the raw count.

### R6 — MEDIUM: MODIS sunset risk is unmentioned
Terra and Aqua are past end-of-design-life, drifting in equator-crossing time, and slated for
decommissioning; MODIS NRT availability during this product's lifetime is not guaranteed
(verify current NASA status — this has been in flux through 2025–2026). The architecture is
source-agnostic (good), but the roadmap should treat MODIS as a bonus, VIIRS ×3 as the polar
backbone, and should add **Sentinel-3 SLSTR FRP NRT** (morning orbit ≈10:00 local — it fills
the VIIRS mid-morning blind window) as a planned adapter rather than a footnote.

### R7 — MEDIUM: EFFIS WMS consumption details unverified (CORS, CRS, TIME)
MapLibre fetches raster tiles via `fetch()` → **CORS applies** to the EFFIS WMS. Most EFFIS
layers declare a `TIME` dimension that must be sent explicitly. Advertised CRS support varies
by layer (burnt-area layers advertise EPSG:900913/3857; the capabilities extraction for the
`mf010.*` danger layers showed EPSG:4326 — if any needed layer lacks 3857, MapLibre cannot
consume it directly). A thin caching proxy solves all three at once. Design in §5.5.

### R8 — LOW-MEDIUM: Enrichment and ops gaps
- Open-Meteo's free tier is **non-commercial**; the Phase-2/3 business model requires their
  paid API (budget item, small). Caching/joining strategy unspecified — design in §5.6.
- No plan for distinguishing "no fires" from "pipeline broken / no data published" — FIRMS has
  a `/api/data_availability/` endpoint; poller health must alarm on staleness during season.
- Cloud cover is unaddressed: no detections under cloud ≠ no fire. At minimum, the honest-UX
  layer should be able to say "area was cloud-obscured at last pass" (FCI cloud mask, later).
- Neon free tier scale-to-zero conflicts with a 5-min poller + SSE (constant cold starts);
  expect to land on a small paid tier — consistent with the €10–30/mo estimate, just name it.

---

## 4. Detailed recommendations

1. **Adopt the normalized Detection schema and deterministic `detection_uid`** (§5.1) before
   writing the poller. Keep NRT and SP as separate product tiers; never attempt row-level
   NRT↔SP matching — swap whole month-partitions when SP arrives.
2. **Poll FIRMS with `day_range=2` always** (UTC-day semantics), per-source, every 5–10 min in
   season; idempotent upsert on `detection_uid`. Track per-source watermarks and alarm on
   staleness vs `/api/data_availability/`.
3. **Replace "DBSCAN" with the incremental assignment algorithm** of §5.2: per-source ε,
   48 h linking, merge-with-tombstones, no automatic splits, stable ULID event IDs, offline
   `ST_ClusterDBSCAN` only for parameter tuning against the 2020–2025 backfill, with
   Jaccard-overlap ID matching between clustering runs.
4. **Build the static hot-source mask in week 1** from the backfill itself (cells hot in ≥8
   distinct months across years) cross-checked with CORINE industrial classes and OSM
   `landuse=industrial` / `man_made=flare|works`; seed it manually with Maritsa Iztok and
   Neftochim. Gate all alerting on it.
5. **Land the PostGIS DDL of §5.3**: SRID 4326 storage, `geography` casts for metric distance,
   monthly range partitions on `detections`, GiST everywhere geometry is filtered, one
   materialized view feeding the map API.
6. **Re-target the geostationary adapter** at LSA SAF MTG FRP-PIXEL (with FCI L2 FIR as
   fallback), as a small Python sidecar emitting normalized detections into the same pipe.
   Keep the "one evening" spike but scope it as: authenticate, download one granule for a known
   2025 BG fire, decode, extract BG-bbox fire pixels — success = printed lat/lon/FRP list.
7. **Proxy EFFIS WMS** through your own origin with a per-(layer, time, tile) cache — daily TTL
   for `mf010.*` danger layers, 15–60 min in-season for hotspot/BA layers. Resolve layer names
   from live GetCapabilities at deploy time, not hardcoded docs.
8. **Do the backfill first, not last** (§5.7): country yearly CSVs for BG + neighbors,
   2020–2025, load into the real schema, and use it to (a) tune clustering against EFFIS
   burnt-area perimeters as ground truth, (b) derive the static-source mask, (c) power the
   demo/landing page with real 2024–2025 fire replays — strongest possible validation asset.
9. **Add Sentinel-3 SLSTR FRP NRT (CDSE)** to the v1 adapter list for the morning gap; treat
   MODIS as expendable.
10. **Write the attribution/redistribution page early**: NASA FIRMS citation (with the standard
    "no NASA endorsement" wording), Copernicus/EFFIS attribution, EUMETSAT Data Store terms —
    and explicitly re-verify EUMETSAT terms before exposing FCI-derived pixels via your own API
    (the analysis already flags this; keep it).

---

## 5. Data deep dive

### 5.0 Fact-check of the source table (ANALYSIS §3.1–3.6)

| Claim in ANALYSIS | Verdict | Correction / note |
|---|---|---|
| FIRMS NRT ≤3 h, global | ✅ Correct | FAQ wording is "within 3 hours … on a best effort basis" — surface "best effort" in internal SLOs. |
| RT ~30 min, "regions with direct-readout ground stations" | ⚠️ Oversimplified | Mechanism true, but in practice **US, Canada, parts of Mexico**. For Bulgaria there is no RT tier. |
| URT 25–50 s, US/Canada only | ❌ Wrong number | FIRMS FAQ: available **"within 5 minutes"**; conterminous US / southern Canada / northern Mexico. (The tens-of-seconds figure was the ground-segment processing time in the launch announcement, not end-to-end availability.) Coverage conclusion — irrelevant for Europe — stands. |
| API sources `VIIRS_SNPP_NRT`, `VIIRS_NOAA20_NRT`, `VIIRS_NOAA21_NRT`, `MODIS_NRT` + `_SP` | ✅ Mostly | Current docs list SP variants for SNPP, NOAA20, MODIS; **NOAA-21 SP not yet listed** (NOAA-21 record starts 2024-01). `LANDSAT_NRT` is US/Canada-only, correctly excluded. |
| 5,000 requests / 10 min | ✅ Correct | Per MAP_KEY, counted in *transactions* — a large query can consume several. Irrelevant at this polling scale. |
| `day_range` (implied trailing window) | ⚠️ Trap | Docs: "from TODAY to TODAY-(DAY_RANGE-1)" — **UTC calendar days**, accepted range 1–5. `day_range=1` polled at 00:30 UTC returns ~nothing. Always poll 2. |
| 4–6 usable overpasses/day for BG | ⚠️ Misleading | ~8–12 observation opportunities across 5 platforms, but **bunched** (~01:30/13:30 VIIRS; ~10:30/22:30 MODIS, drifting). The product truth: multi-hour diurnal blind windows, esp. late afternoon/evening — exactly peak fire growth hours. This is the strongest argument for the geostationary layer; state it that way. |
| MTG FCI FIR: 10-min full disk, ~1–2 km IR, minutes latency, via Data Store + EUMETCast, also LSA SAF | ⚠️ Several nits | 10-min repeat cycle ✅. Resolution: 2 km sampling for FDHSI IR at nadir (1 km for HRFI IR3.8); over Bulgaria (view zenith ~55–60°) effective pixel ≈ **3–4.5 km**. Latency via Data Store polling realistically **15–30 min** end-to-end. **FIR carries no FRP** — fire class + quality only; FRP comes from LSA SAF FRP-PIXEL. "Detects fires of a few hundred m²" is the *best case* from the FCI early-detection literature, not typical performance over rugged terrain. |
| MSG SEVIRI FIR as fallback | ⚠️ Aging | True today, but the MSG 0° service is being wound down as MTG takes over; do not build new code against SEVIRI at 0° in 2026. LSA SAF SEVIRI FRP-PIXEL remains for historical cross-checks. |
| EFFIS fire-danger forecast: FWI, 6 classes, ~8 km, 1–10 d, ECMWF, via WMS | ⚠️ Partially stale | Concept ✅. Current WMS GetCapabilities exposes **`mf010.fwi`** (+ `ffmc`, `dmc`, `dc`, `isi`, `bui`, `anomaly`, `ranking`) — a 0.1° grid; the `ecmwf007.*` naming found in older references appears superseded. Resolve names from live capabilities; don't hardcode from docs. All danger layers require a `TIME` parameter. |
| EFFIS burnt areas "Sentinel-2 based", ~daily in season | ❌ Wrong basis | The **NRT** perimeters (`effis.nrt.ba.poly`) are mapped from MODIS/VIIRS imagery (that's why the layer title reads `viirs.ba.poly`); Sentinel-2 supports refined/final mapping, not the rapid daily product. Expect NRT perimeters to lag reality and miss small fires (<~30 ha historically). |
| CDSE free tier for S2/S3/S5P | ✅ Correct | Add: **Sentinel-3 SLSTR FRP NRT** is the useful *active-fire* item there (morning orbit), not just S2 dNBR. |
| FireSat: 3 operational sats Jul 2026, ≥2×/day, access TBD | ✅ Fair | Correctly framed as "plan for, don't depend on". |
| Missing entirely | ➕ | Terra/Aqua decommissioning risk (R6); cloud-cover honesty (R8); FIRMS `/api/data_availability/`; detection pixel footprint (`scan`/`track`) as data, needed for honest uncertainty display and per-detection ε. |

### 5.1 FIRMS ingestion — pitfalls and normalized Detection schema

#### 5.1.1 Known pitfalls (each has bitten a real pipeline)

| # | Pitfall | Consequence if ignored | Handling |
|---|---|---|---|
| 1 | **`acq_time` is `HHMM` with no leading-zero guarantee** (`"142"` = 01:42 UTC) | Wrong timestamps for pre-10:00 UTC passes | `acq_ts = acq_date + lpad(acq_time,4,'0')::time` in UTC; store `timestamptz` only |
| 2 | **`day_range` = UTC calendar days (1–5)** | Detections silently dropped around 00:00 UTC | Always poll `day_range=2`; dedupe on `detection_uid` |
| 3 | **Same detection returned by many consecutive polls** (2-day window, 5-min cadence) | Duplicate rows | Deterministic `detection_uid` + idempotent upsert (`ON CONFLICT DO NOTHING`) |
| 4 | **MODIS vs VIIRS CSV schemas differ**: MODIS `brightness`/`bright_t31`, numeric `confidence` 0–100, version `6.1NRT`; VIIRS `bright_ti4`/`bright_ti5`, categorical `confidence` ∈ {`l`,`n`,`h`}, version `2.0NRT` | Parser breakage, apples-to-oranges confidence | One parser per source family; normalize confidence (below) but keep `confidence_raw` |
| 5 | **`satellite` codes are inconsistent across products/vintages** (`Terra`/`Aqua`/`T`/`A`; `N`/`1`/`N20`/`N21`) | Broken source attribution | Derive platform from the *queried source name*, never from the CSV column; keep the raw column for audit |
| 6 | **NRT→SP reprocessing (~5-month lag)**: coordinates shift, confidence changes, rows appear/disappear; no stable NASA row ID | History mutates under the clustering tuner; naive "update in place" corrupts identity | Treat `product_tier` as part of identity. Never row-match NRT↔SP. When SP for month M lands: load into staging, **swap the month partition** (or mark NRT rows `superseded=true`), re-run offline clustering for M only |
| 7 | **VIIRS low confidence ≈ possible sun glint / South Atlantic anomaly artifacts**, mostly daytime | False-positive alerts | `low` never triggers alerts on default zones; shown on map only behind a "show low-confidence" toggle |
| 8 | **`scan`/`track` (pixel size, km) ignored** | Overconfident point display; wrong clustering ε at swath edge (MODIS pixel up to ~4×2 km) | Store both; render optional footprint ellipse; use per-detection ε (§5.2) |
| 9 | **FRP occasionally null/zero** | NaN propagation in FRP trends | Nullable column; trend code skips nulls |
| 10 | **Silence is ambiguous** (no fires vs no data) | Undetected outage during a fire | Poller compares against `/api/data_availability/[MAP_KEY]/[SOURCE]`; alarm if source stale > 6 h in season |

Confidence normalization: VIIRS `l/n/h` → `low/nominal/high`; MODIS numeric → `<30` low,
`30–79` nominal, `≥80` high (the FIRMS convention). Keep the raw value; the normalized enum is
for UX/alert gating only.

#### 5.1.2 Normalized Detection (domain type)

```ts
interface Detection {
  detectionUid: string;        // sha256(source|acq_ts_iso|lat_5dp|lon_5dp) → hex; deterministic, idempotent
  source: 'VIIRS_SNPP' | 'VIIRS_NOAA20' | 'VIIRS_NOAA21' | 'MODIS_TERRA' | 'MODIS_AQUA'
        | 'FCI_FIR' | 'LSASAF_FRP' | 'SLSTR_FRP';   // extensible registry, not a closed enum in DB
  productTier: 'NRT' | 'SP' | 'GEO';
  acqTs: string;               // ISO-8601 UTC, from acq_date + lpad(acq_time,4,'0')
  lat: number; lon: number;    // WGS84
  scanKm?: number; trackKm?: number;   // pixel footprint; null for GEO list products if absent
  frpMw?: number;              // null-able; FIR product has none
  brightnessK?: number;        // MODIS `brightness` | VIIRS `bright_ti4`
  brightnessBgK?: number;      // MODIS `bright_t31`  | VIIRS `bright_ti5`
  confidenceRaw: string;       // '83' | 'n' | product-specific quality flag
  confidence: 'low' | 'nominal' | 'high';
  dayNight: 'D' | 'N';
  version: string;             // '6.1NRT', '2.0NRT', product version for GEO
  ingestedAt: string;
}
```

Notes on `detectionUid`: 5-decimal rounding (~1.1 m) makes the hash stable against float
formatting, not against reprocessing — which is exactly why SP is a *different tier*, not an
update of the same row. Do not include `version` or `confidence` in the hash (both mutate
across reruns of the same tier).

### 5.2 Space-time clustering: Detection[] → FireEvent

#### 5.2.1 Why not plain DBSCAN on a sliding window

- **ID instability**: every re-run relabels clusters; alerts re-fire, event URLs break.
- **Single ε is wrong** for a mix of 375 m, 1 km (→4 km at swath edge) and 3–4.5 km pixels.
- **Border effects**: a fire active for 5 days exits any fixed window and gets a second ID.
- DBSCAN treats time as absent or as a fake third dimension; ST-DBSCAN fixes the semantics but
  not the identity problem.

DBSCAN/ST-DBSCAN is the right tool **offline** (parameter tuning, backfill) — PostGIS's
`ST_ClusterDBSCAN` window function does it in SQL. **Online**, use incremental assignment:

#### 5.2.2 Online algorithm (incremental event assignment)

For each ingest batch (one poll), detections sorted by `acqTs`:

1. Skip if `detection` falls inside a **static hot-source** polygon → tag `static_source`,
   store, never cluster into public events (§5.2.4).
2. Candidate events: `status IN ('new','active','cooling')` AND
   `ST_DWithin(event.hull::geography, det.geog, eps(det))` AND
   `det.acqTs - event.last_detection_at <= T_LINK`.
3. **0 candidates** → create event (ULID id), hull = buffered point.
4. **1 candidate** → attach; update `last_detection_at`, `detection_count`, `max_frp`,
   `source_mix`, hull = `ST_ConcaveHull(points ∪ new, 0.8)` buffered by ~500 m, centroid =
   FRP-weighted mean.
5. **≥2 candidates** → **merge**: oldest event survives, others get `status='merged'`,
   `merged_into=survivor` (tombstone kept — permalinks redirect); detections re-linked to the
   survivor; one merge audit row.
6. Geostationary detections (`GEO` tier): same flow with `eps_geo`, but a **GEO-only** event is
   `status='unconfirmed'` until (a) ≥3 consecutive 10-min slots re-detect it, or (b) any polar
   detection joins. Unconfirmed events are visible (marked) but alert only high-sensitivity
   zones that opted in.
7. Lifecycle sweep (cron, 10 min): `new→active` after 2nd detection or 6 h; `active→cooling`
   when `now - last_detection_at > 24 h`; `cooling→out` at 48 h; `out` events archived at 72 h.
   FRP-weighted "reignition": a detection within `T_REIGNITE=96 h` and `eps` of an `out` event
   **reopens it** (same ID) rather than creating a twin.

**No automatic splits.** A split is editorially ambiguous; instead, when an event hull exceeds
`SPLIT_REVIEW_DIAM = 20 km`, flag for manual/curated review (v1 editorial layer). This matches
the Watch Duty model: humans arbitrate identity of mega-fires.

#### 5.2.3 Parameters (initial values — tune on backfill, §5.7)

| Parameter | Initial value | Rationale |
|---|---|---|
| `eps` VIIRS | **1,500 m** | 375 m pixel; 2×–4× pixel covers geolocation error + front spread between passes |
| `eps` MODIS | **3,000 m** | 1 km pixel, up to ~4 km at swath edge; use `max(3000, 1.5·√(scan·track)·1000)` |
| `eps` GEO (FCI/LSA SAF) | **5,000 m** | Effective pixel 3–4.5 km over BG at 55–60° view zenith |
| `T_LINK` | **48 h** | 24 h (proposed in ANALYSIS) splits fires that gap over one cloudy day + the diurnal blind window; EFFIS/GlobFire-style event datasets use multi-day linking |
| `T_REIGNITE` | 96 h | Smouldering/reignition without new event spam |
| min detections for default-zone alert | **2**, or **1** if `night` + `high` | Night high-confidence VIIRS is the cleanest signal there is |
| cooling / out / archive | 24 h / 48 h / 72 h | Matches pass cadence; revisit when GEO stream (10-min cadence) is live |
| hull | concave hull (0.8) ⊕ 500 m buffer | Point sets are sparse; convex hull overstates elongated fires less than raw points understate them |

Event **confidence score** (0–1, for UX tiers and alert gating):
`base 0.3` + `0.2·(distinct satellites − 1, cap 2)` + `0.2 if any night detection` +
`0.2 if detections span ≥2 passes` + `0.1 if max FRP > 20 MW`, capped at 1.0; multiplied by
0.5 if dominant land cover is agricultural (§5.2.4), forced to 0 for static-source events.

#### 5.2.4 False-positive filtering (concrete)

Three layers, all precomputable:

1. **Static hot-source mask** (table `static_hot_sources`, polygons + type):
   - *Derived*: from the 2020–2025 backfill, grid at 0.01° and flag cells with detections in
     **≥ 8 distinct months** across years (fires are seasonal; flares/TPPs are not).
   - *Curated seed*: Maritsa Iztok TPP + mines (Galabovo/Radnevo), Lukoil Neftochim Burgas,
     Devnya cement cluster, Sofia/Pernik metallurgy — ~1–2 dozen polygons hand-drawn once.
   - *Cross-check*: OSM `landuse=industrial|quarry`, `man_made=works|flare|chimney`; CORINE
     classes 121/131/132 (industrial, mineral extraction, dump).
2. **Land-cover context** (not a hard filter): one-time raster→vector prep of **ESA WorldCover
   10 m** (classes: 10 tree, 30 grass, 40 cropland, 50 built-up) for BG+buffer into a lookup
   (or `ST_Value` on an in-DB raster). Each event gets `land_cover_class` by majority under its
   hull. Cropland ⇒ label "likely agricultural burn" (spring/autumn), halve confidence,
   default zones don't alert; tree/shrub ⇒ full weight. CORINE is the fallback/cross-check
   (100 m, coarser but stable classes).
3. **Water/glint guard**: `low`-confidence daytime VIIRS detections over/adjacent to water
   (WorldCover class 80) are suppressed from events entirely.

#### 5.2.5 Re-clustering with stable identity

Offline re-runs (parameter tuning, SP-tier swaps) write to `clustering_runs` +
`event_detections.clustering_run_id` — never overwrite the live assignment. Promoting a run to
live: match new clusters to old events by **detection-set Jaccard overlap ≥ 0.5** (keep old
`event_id`), unmatched new clusters get fresh IDs, unmatched old events are tombstoned. This
makes clustering-parameter evolution an offline, reviewable operation instead of a live schema
migration.

### 5.3 PostGIS schema (DDL)

> **Non-normative** (review 13 §3.2(11), TASKS B4). The schema owner is
> `server/db/migrations/001_initial_schema.sql`;
> this block is a column inventory that predates ADR-002 and is superseded wherever the
> two differ. Known differences, all deliberate: `fire_events` here uses a ULID primary
> key and lists an `out` status, neither of which exists (D6 fixes the state list, and
> the word "out" appears nowhere in the schema, API or UI); the per-row `superseded`
> flag on `detections` is forbidden by A1.4, which swaps whole months instead of
> aligning NRT and SP row by row; and `event_detections` is keyed on the run rather than
> carrying it as an attribute. The SRID rule below is normative and is implemented.

SRID decision: **store everything in 4326** (geometry), cast to `geography` for metric
predicates (`ST_DWithin` in meters, correct at BG latitudes); 3857 exists only in tile/URL
space — never in the database. Rationale: 4326 is the interchange format of every source and of
GeoJSON output; geography casts on GiST-indexed columns are fast at this data volume.

```sql
CREATE EXTENSION IF NOT EXISTS postgis;

-- ── source registry ────────────────────────────────────────────────
CREATE TABLE sources (
  source_id   text PRIMARY KEY,          -- 'VIIRS_SNPP', 'FCI_FIR', ...
  family      text NOT NULL,             -- 'polar' | 'geo'
  description text NOT NULL
);

-- ── raw detections: append-only, monthly partitions ────────────────
CREATE TABLE detections (
  detection_uid  text        NOT NULL,
  source_id      text        NOT NULL REFERENCES sources(source_id),
  product_tier   text        NOT NULL CHECK (product_tier IN ('NRT','SP','GEO')),
  acq_ts         timestamptz NOT NULL,
  geom           geometry(Point, 4326) NOT NULL,
  scan_km        real,
  track_km       real,
  frp_mw         real,
  brightness_k   real,
  brightness_bg_k real,
  confidence_raw text        NOT NULL,
  confidence     text        NOT NULL CHECK (confidence IN ('low','nominal','high')),
  day_night      char(1)     NOT NULL CHECK (day_night IN ('D','N')),
  version        text        NOT NULL,
  is_static_source boolean   NOT NULL DEFAULT false,
  superseded     boolean     NOT NULL DEFAULT false,   -- set when SP tier replaces this NRT row's month
  ingested_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (acq_ts, detection_uid)                  -- partition key must be in PK
) PARTITION BY RANGE (acq_ts);

-- one partition per month, created by a maintenance job, e.g.:
CREATE TABLE detections_2026_07 PARTITION OF detections
  FOR VALUES FROM ('2026-07-01') TO ('2026-08-01');

CREATE INDEX detections_geom_gist ON detections USING gist (geom);
CREATE INDEX detections_src_ts    ON detections (source_id, acq_ts DESC);
CREATE INDEX detections_uid       ON detections (detection_uid);   -- upsert path

-- ── fire events: the product entity ────────────────────────────────
CREATE TABLE fire_events (
  event_id          text PRIMARY KEY,                  -- ULID
  status            text NOT NULL CHECK (status IN
                     ('unconfirmed','new','active','cooling','out','merged','invalidated')),
  started_at        timestamptz NOT NULL,
  last_detection_at timestamptz NOT NULL,
  ended_at          timestamptz,
  centroid          geometry(Point, 4326) NOT NULL,
  hull              geometry(MultiPolygon, 4326) NOT NULL,
  detection_count   integer NOT NULL DEFAULT 0,
  max_frp_mw        real,
  sum_frp_mw        real,
  confidence_score  real NOT NULL DEFAULT 0,
  source_mix        jsonb NOT NULL DEFAULT '{}',        -- {"VIIRS_SNPP": 12, "FCI_FIR": 40}
  land_cover_class  text,                               -- majority WorldCover class under hull
  likely_agri_burn  boolean NOT NULL DEFAULT false,
  nearest_place     jsonb,                              -- {name, name_bg, dist_m, population}
  merged_into       text REFERENCES fire_events(event_id),
  updated_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX fire_events_hull_gist  ON fire_events USING gist (hull);
CREATE INDEX fire_events_status_ts  ON fire_events (status, last_detection_at DESC);

-- ── event ↔ detection link (supports offline re-clustering runs) ──
CREATE TABLE clustering_runs (
  run_id      text PRIMARY KEY,           -- 'live' + ULIDs for offline runs
  params      jsonb NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  promoted_at timestamptz
);

CREATE TABLE event_detections (
  run_id        text NOT NULL REFERENCES clustering_runs(run_id),
  event_id      text NOT NULL REFERENCES fire_events(event_id),
  detection_uid text NOT NULL,
  acq_ts        timestamptz NOT NULL,
  PRIMARY KEY (run_id, event_id, detection_uid)
);
CREATE INDEX event_detections_by_det ON event_detections (run_id, detection_uid);

-- ── static hot sources (false-positive mask) ───────────────────────
CREATE TABLE static_hot_sources (
  source_key  text PRIMARY KEY,           -- 'maritsa-iztok-2', ...
  kind        text NOT NULL,              -- 'tpp' | 'flare' | 'cement' | 'derived'
  geom        geometry(MultiPolygon, 4326) NOT NULL,
  note        text
);
CREATE INDEX static_hot_sources_gist ON static_hot_sources USING gist (geom);

-- ── watch zones + alerting ─────────────────────────────────────────
CREATE TABLE watch_zones (
  zone_id        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id        uuid NOT NULL,
  name           text NOT NULL,
  geog           geography(Geometry, 4326) NOT NULL,   -- Point (with radius_m) or Polygon
  radius_m       integer,                              -- NULL for polygon zones
  min_confidence text NOT NULL DEFAULT 'nominal',
  include_unconfirmed_geo boolean NOT NULL DEFAULT false,
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX watch_zones_gist ON watch_zones USING gist (geog);

-- alert matching (runs on event create/upgrade transitions, not per raw detection):
--   SELECT z.* FROM watch_zones z
--   WHERE ST_DWithin(z.geog, ST_Centroid(:hull)::geography, COALESCE(z.radius_m, 0) + :margin_m)
--     AND :confidence_score >= conf_threshold(z.min_confidence);

-- ── map API feed ───────────────────────────────────────────────────
CREATE MATERIALIZED VIEW map_events AS
SELECT event_id, status, started_at, last_detection_at,
       detection_count, max_frp_mw, confidence_score, source_mix,
       land_cover_class, likely_agri_burn, nearest_place,
       ST_AsGeoJSON(centroid)::jsonb AS centroid_geojson,
       ST_AsGeoJSON(ST_SimplifyPreserveTopology(hull, 0.0005))::jsonb AS hull_geojson
FROM fire_events
WHERE status IN ('unconfirmed','new','active','cooling');
CREATE UNIQUE INDEX map_events_pk ON map_events (event_id);
-- REFRESH MATERIALIZED VIEW CONCURRENTLY map_events;  -- after each ingest batch (~every poll)
```

Partitioning/retention notes:
- Volume is small (§5.7) — partitioning is not for size but for **operational atomicity**: the
  NRT→SP swap is "load SP month into staging → verify counts → detach/drop NRT-heavy partition
  → attach SP partition → re-run offline clustering for that month". Retention: keep everything;
  6 years of BG+buffer detections is well under 5 GB with indexes.
- The raw-hotspot map layer for "last 24 h" is a plain query on the current partition
  (`acq_ts > now()-'24h'` + GiST bbox), no materialization needed at these volumes.

### 5.4 MTG FCI reality check

**What FIR actually is:** FCI L2 "Active Fire Monitoring", Data Store collection
`EO:EUM:DAT:0682`, netCDF on the fixed geostationary grid (0° longitude), driven by the IR3.8
channel; output is a per-pixel fire classification with quality levels — **no FRP, no
sub-pixel location**. Full-disk repeat cycle 10 min. Dissemination: Data Store REST (poll,
OAuth2 via the `eumdac` client) or EUMETCast push (DVB-S2 dish or terrestrial — hardware and
ops you don't want at MVP).

**Integration shape (recommended):** a small **Python sidecar** (this will not be TypeScript —
accept the polyglot cost, keep it tiny):
1. Poll Data Store for new FIR (or LSA SAF FRP-PIXEL) granules every 5 min (`eumdac`).
2. Open netCDF (satpy has an `fci_l2_nc` reader; plain `netCDF4` + a precomputed lat/lon grid
   for the Balkan pixel window also works — compute the geostationary-grid index window for
   [40.5°N–45.0°N, 21.5°E–29.0°E] **once**, then slice).
3. Emit fire pixels as normalized detections (`source='FCI_FIR'`, `tier='GEO'`,
   `confidence` mapped from the product's quality classes) via HTTP POST to the main API's
   internal ingest endpoint. No shared DB writes from Python.

**Effort estimate:** 1–2 weeks part-time for a production-ready adapter (auth token refresh,
granule bookkeeping, gap handling, bbox subsetting, unit tests on a stored granule) — versus
"one evening" in the validation plan, which is the right scope only for the *decode spike*.
Reprojection is **not needed** for ingestion (you extract pixel lat/lon, not imagery);
reprojection only enters if you ever render FCI rasters as a map layer (don't at MVP).

**The better product — LSA SAF MTG FRP-PIXEL (LSA-509):** released as a demonstration product
in Oct 2025, back-processed from Jan 2025; FTA algorithm heritage from the operational SEVIRI
FRP-PIXEL; FCI IR3.8 at 1 km sampling at nadir. It is a **list of fire pixels with FRP** —
i.e., exactly your normalized Detection shape — which removes most of the netCDF-grid work and
adds the FRP trend for GEO events. Recommendation: build the sidecar against FRP-PIXEL first,
keep FIR as the fallback if LSA SAF's demonstration status or timeliness disappoints. Verify
current operational status and Data Store/LSA SAF dissemination path at build time; also
re-verify EUMETSAT redistribution terms before exposing FCI-derived data through your public
API (already flagged in ANALYSIS §6.4 — keep that flag).

**Expectation management for the fused product:** over Bulgaria the effective FCI pixel is
3–4.5 km; small early fires will *not* appear in the GEO stream. Its honest value: (a) first
detection of medium+ fires in minutes-to-tens-of-minutes instead of hours, (b) 10-min FRP
cadence on already-known events (growth/decay trend between polar passes). Market it as that.

### 5.5 EFFIS WMS consumption

**Proxy, don't consume directly.** Three independent reasons:
1. **CORS**: MapLibre raster sources fetch tiles via `fetch()`; EFFIS WMS CORS headers are not
   guaranteed. A same-origin proxy removes the question.
2. **CRS**: MapLibre speaks EPSG:3857 only. Burnt-area layers advertise 900913/3857; the
   `mf010.*` danger layers' capabilities extraction showed EPSG:4326 — if that holds, the proxy
   must reproject (a `mapproxy` instance, or request 4326 and warp) for those layers.
3. **Availability & load**: JRC's server is not your SLA. Cache per `(layer, TIME, z/x/y)`:
   danger layers are daily products → cache until next daily update (TTL 6–24 h); hotspot/BA
   layers TTL 15–60 min in season. This also makes you a polite client during Europe-wide fire
   emergencies, when everyone hammers EFFIS at once.

**Layers worth using** (from live GetCapabilities, 2026-07; resolve at deploy time):
- `mf010.fwi` — FWI danger forecast (the headline overlay); components `mf010.ffmc/dmc/dc/isi/bui`
  and `mf010.anomaly`, `mf010.ranking` for a power-user toggle. `TIME=YYYY-MM-DD` required.
- `effis.nrt.ba.poly` — NRT burnt-area perimeters (MODIS/VIIRS-based; see §5.0 caveat).
- `modis.ba.poly` — historical burnt areas for the history layer.
- `viirs.hs` / `modis.hs` / `all.hs` — EFFIS's own hotspot render; **skip** — you render your
  own detections with better UX; keep only as a debugging cross-check.

**Alternatives/backups:** GWIS WMS (same JRC stack, global scope) if EFFIS endpoints move;
**NASA GIBS WMTS** for context imagery (VIIRS true-color of smoke plumes is genuinely useful to
users and is a proper tiled WMTS — no proxy needed, generous CORS); Sentinel-2 cloudless only
as the ADR-001 satellite toggle.

### 5.6 Wind/weather enrichment (Open-Meteo)

**API shape:** `GET https://api.open-meteo.com/v1/forecast?latitude=..&longitude=..&hourly=`
`wind_speed_10m,wind_direction_10m,wind_gusts_10m,temperature_2m,relative_humidity_2m,`
`precipitation&past_days=1&forecast_days=2&timezone=UTC&cell_selection=land&wind_speed_unit=ms`.
Supports **batched coordinates** (comma-separated lat/lon lists) — one call can cover every
active event. Model `best_match` resolves to ICON-EU/ECMWF over Bulgaria (~7–25 km grids).

**Join strategy:**
- Quantize event centroid to a **0.1° grid** (~11 km ≈ model resolution) → cache key
  `(lat_q, lon_q)`. Two events on the same ridge share one forecast — correct and cheap.
- Fetch on event creation + refresh hourly for `new/active` events (batched); TTL 1 h.
- Persist snapshots in `event_weather(event_id, valid_hour timestamptz, wind_ms real,`
  `wind_dir_deg smallint, gust_ms real, temp_c real, rh_pct smallint, model text,`
  `fetched_at timestamptz, PRIMARY KEY(event_id, valid_hour))` — history is needed for alert
  copy ("wind turning NE 14 m/s"), the detail-panel 12-h strip, and post-season analysis.
- Volumes: even a bad day (50 active events → ~5 quantized cells) is a handful of calls/hour —
  free-tier scale. **Licensing:** free tier is non-commercial; Phase 2/3 monetization requires
  their commercial API (small budget line, ~tens of €/mo — verify current terms).
- Display honesty: wind is a *spread-direction hint* from a mesoscale model, not fire behavior
  modeling — keep the ANALYSIS non-goal explicit in UX copy.

### 5.7 Historical backfill (Bulgaria 2020–2025)

**Where:**
1. **Country yearly summary CSVs** — `firms.modaps.eosdis.nasa.gov/country/` — per country ×
   sensor × year, immediate download, NRT replaced by science-quality with ~5-month lag. This
   covers Bulgaria and every neighbor with zero friction. Primary path.
2. **Archive Download tool** — `firms.modaps.eosdis.nasa.gov/download/` — custom bbox/date
   range (use for the +100 km buffer as one polygon), async with email link.
3. **EFFIS burnt-area perimeters** (shapefile via the data request form / `modis.ba.poly`) —
   not detections, but the **ground truth for clustering validation**: a tuned clusterer's
   events should correspond ≈1:1 with EFFIS perimeters for fires >30 ha.

**Expected volumes (order of magnitude — verify on first download):**

| Slice | Rows (est.) |
|---|---|
| Bulgaria, VIIRS (3 sats where available), typical year | ~10–30 k |
| Bulgaria, VIIRS, extreme year (2024, 2025) | ~40–100 k |
| Bulgaria, MODIS, per year | ~1–5 k |
| **Bulgaria total 2020–2025, all sensors** | **~150–400 k rows, < 100 MB CSV** |
| +100 km buffer (GR/TR/RS/MK/RO edges; Greek mega-fire years dominate) | ×4–6 → ~1–2 M rows |

Trivially laptop-scale; the whole 6-year backfill loads into the §5.3 schema in minutes and the
entire pipeline is testable offline.

**What the backfill buys (do it in week 1, before the live poller):**
1. **Clustering tuning**: sweep (`eps`, `T_LINK`) offline via `ST_ClusterDBSCAN` runs scored
   against EFFIS perimeters (over/under-segmentation rates) — turns §5.2.3 from guesses into
   fitted values.
2. **Static hot-source mask derivation** (§5.2.4) — impossible without history.
3. **The demo**: replay the 2024–2025 BG seasons through the real pipeline for the landing
   page ("this is what Fire Watch would have shown on 2024-07-XX") — the strongest validation
   asset for both the audience probe and B2B conversations.
4. **Pass-cadence ground truth** per lat/lon (validates the honest-UX copy about blind windows).

### 5.8 Ingestion pipeline (target shape)

```
FIRMS poll (5 min, day_range=2, per source)     LSA SAF / FCI sidecar (Python, 5 min poll)
        │ CSV → parse → normalize                        │ netCDF/list → normalize
        └──────────────┬──────────────────────────────────┘
                       ▼
        idempotent upsert (detection_uid)  ──►  detections (partitioned, append-only)
                       │  new rows only
                       ▼
        static-source gate ─► land/water guard ─► incremental event assignment (§5.2.2)
                       │                                  │
                       ▼                                  ▼
        fire_events upsert + event_detections     lifecycle sweep (10 min cron)
                       │
        ┌──────────────┼──────────────────────┐
        ▼              ▼                      ▼
  weather enrich   alert engine          REFRESH map_events (concurrently)
  (batched, 1 h)   (event transitions     ─► API GeoJSON + SSE tick
                    × watch_zones)
```

Every stage idempotent; poller watermarks + `/api/data_availability/` staleness alarms; the
only non-TypeScript box is the EUMETSAT sidecar.

---

## 6. Open questions for the team

1. **Alert semantics for GEO-only detections:** is an unconfirmed FCI-only cluster (3–4.5 km
   pixel, no polar confirmation yet) ever worth a push notification for an opted-in
   high-sensitivity zone — or map-only until polar confirmation? (Trust vs earliness; my
   default: map-only in v1.)
2. **Agricultural burns UX:** suppress, or show-with-label? They are legally gray, extremely
   common in BG in Mar–Apr/Sep–Oct, and occasionally *become* wildfires. Label-and-downweight
   (my proposal) needs a product decision on wording.
3. **NRT→SP swap visibility:** when science-quality data replaces NRT months later and an
   event's detection history shifts slightly, do public event pages silently update, or keep
   the as-alerted NRT view for auditability? (B2B/SLA angle suggests keeping both — the
   `clustering_runs` design supports it.)
4. **Who owns the Python sidecar competence?** A one-person TS project taking on
   eumdac/netCDF/satpy — is that acceptable ongoing surface, or should the GEO stream wait for
   LSA SAF FRP-PIXEL to be consumable in a simpler form? (Affects v1 scheduling.)
5. **EUMETSAT redistribution terms** for exposing FCI/LSA-SAF-derived detections via the public
   v2 API — legal check before the B2B API ships, not after.
6. **Cloud-cover honesty:** is "area cloud-obscured at last pass" in scope for v1 honest-UX
   (requires a cloud-mask ingest), or a documented limitation until then?
7. **Cross-border event ownership:** a fire straddling the BG/GR border sits in both countries'
   future instances — one global event table with country tags (my recommendation), or
   per-country partitions? Decide before the Greece expansion, it's painful to retrofit.
8. **Neon/Supabase free tier vs 5-min poller:** accept cold-start pauses off-season, or budget
   the small paid tier year-round from day one?

---

*Sources consulted for fact-checking: FIRMS area API docs (firms.modaps.eosdis.nasa.gov/api/area/),
FIRMS FAQ (earthdata.nasa.gov/data/tools/firms/faq), FIRMS country/archive download pages,
EUMETSAT Data Store catalogue `EO:EUM:DAT:0682` + MTG FCI L2 FIR ATBD, LSA SAF fire products
pages (lsa-saf.eumetsat.int) incl. MTFRPPIXEL LSA-509 release note, EFFIS WMS GetCapabilities
(maps.effis.emergency.copernicus.eu, live 2026-07), FCI early-fire-detection study
(S2666017226000040). Where a claim could not be re-verified live (SPA pages), it is marked
"verify at build time".*
