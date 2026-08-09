# Satellite & Auxiliary Data Sources Catalog

*Date: 2026-07-30. Status: reference catalog (pre-code). All facts verified against
primary sources in July 2026 unless marked UNVERIFIED. Companion to ADR-001 (A1:
imagery/attribution constraints), ADR-002 (per-source clustering parameters),
ANALYSIS.md §3, and `reviews/09-legal.md` (licensing).*

Scope: every satellite-derived (and directly supporting) data source Fire Watch could
consume — active fire, imagery, burned area, fire danger, weather, smoke, lightning,
cloud, precipitation, soil moisture, plus static layers (fuel, terrain, population).
Each entry: what it is, resolution/cadence/latency **for Bulgaria/Balkans**, access
path, quota, format, licence, cost, operational status as of July 2026, and fit notes.

---

## Part A — Active fire detection (the core pipeline)

### A1. NASA FIRMS — VIIRS active fire (the season-1 backbone)

| Fact | Value |
|---|---|
| Instruments | VIIRS 375 m I-band on **S-NPP, NOAA-20, NOAA-21** (3 satellites) |
| Coverage BG | ~4–6 usable overpasses/day combined (day + night) |
| Latency | Europe = NRT processing, typically **1–3 h** from overpass to API availability |
| Access | `https://firms.modaps.eosdis.nasa.gov/api/area/` — **Area API** (bbox query). The country API was flagged unavailable in July 2026 — do not build on it |
| Auth / quota | Free MAP_KEY; **5,000 transactions / 10 min** per key |
| Format | CSV / JSON / KML; fields incl. lat/lon, FRP, confidence class, day/night, scan/track |
| Licence | CC0/open (NASA); **must replicate the LANCE "not for tactical decision-making" disclaimer** (09 §2) |
| Cost | Free |
| Status 7/2026 | Operational. **S-NPP anticipated EOL late 2026** — NOAA-20/21 are the long-term backbone |

Fit: primary detection feed; drives Detection ingest (ADR-002, ε = 1.0–1.5 km).
Poll the Area API on a fixed cycle (e.g. every 10–15 min) with the versioned polling
bbox (**§A9** — never an inline literal); the transaction quota is far above our needs.

#### A1.1 Known ingestion pitfalls (each has bitten a real pipeline)

Restored verbatim in substance from `reviews/03-geodata.md` §5.1.1. These are the bugs
WP1 would otherwise rediscover in production during the one recordable season — the
season cannot be re-run, so each row is a build-time requirement, not a lesson to learn
later. C1/C2 implement them; the golden-replay fixtures assert them.

| # | Pitfall | Consequence if ignored | Handling |
|---|---|---|---|
| 1 | **`acq_time` is `HHMM` with no leading-zero guarantee** (`"142"` = 01:42 UTC) | Wrong timestamps for every pre-10:00 UTC pass — including the night overpasses that carry the highest E-weight | `acq_ts = acq_date + lpad(acq_time,4,'0')::time` interpreted as UTC; store `timestamptz` only |
| 2 | **`day_range` counts UTC *calendar* days (1–5), not a rolling window** | Detections silently dropped around 00:00 UTC — a nightly hole in the archive | Always poll `day_range=2` (never 1) and rely on dedup for the overlap |
| 3 | **The same detection is returned by many consecutive polls** (2-day window at 10–15 min cadence) | Duplicate rows, inflated detection counts, unstable aggregates | Deterministic `detection_uid` + idempotent upsert (`ON CONFLICT DO NOTHING`); re-polled rows are an intentional no-op (ADR-002 D1) |
| 4 | **MODIS and VIIRS CSV schemas differ**: MODIS `brightness`/`bright_t31`, numeric `confidence` 0–100, version `6.1NRT`; VIIRS `bright_ti4`/`bright_ti5`, categorical `confidence` ∈ {`l`,`n`,`h`}, version `2.0NRT` | Parser breakage; apples-to-oranges confidence | One parser per source family; normalize confidence (below) but always keep `confidence_raw`. Live path is VIIRS-only (§A2), but the MODIS parser must survive for backfill/fixtures |
| 5 | **`satellite` codes are inconsistent across products and vintages** (`Terra`/`Aqua`/`T`/`A`; `N`/`1`/`N20`/`N21`) | Broken source attribution, wrong per-satellite E-weights, unusable provenance | Derive the platform from the *queried source name* against the canonical source-id registry — never from the CSV column; keep the raw column for audit |
| 6 | **NRT→SP reprocessing (~5-month lag)**: coordinates shift, confidence changes, rows appear and disappear; there is no stable NASA row id | History mutates under the clustering tuner; "update in place" corrupts identity | `product_tier` is part of identity: never row-match NRT↔SP. SP for month M lands in staging, is sanity-checked, the month partition is swapped, and only that month is re-clustered (ADR-002 D7) |
| 7 | **VIIRS `low` confidence ≈ possible sun glint / South-Atlantic-anomaly artifacts**, mostly daytime | False-positive alerts from pixels that were never fire | `low` never triggers alerts on default zones; map-visible only behind an explicit "show low-confidence" toggle |
| 8 | **`scan`/`track` (pixel footprint, km) ignored** | Overconfident point rendering; wrong clustering ε at swath edge (MODIS pixels reach ~4.8×2 km) | Store both at ingest (schema reserves the footprint fields, ADR-002 D1); use footprint-aware per-detection ε (ADR-002 D2) |
| 9 | **FRP is occasionally null or zero** | NaN propagation through FRP trends, score features and the GEO detection-floor rule | Nullable column; trend and score code skip nulls explicitly |
| 10 | **Silence is ambiguous** — "no fires" and "no data" look identical | An undetected upstream outage during an active fire day; frozen map, no alerts | The poller compares against `https://firms.modaps.eosdis.nasa.gov/api/data_availability/csv/[MAP_KEY]/[SOURCE]` and raises the staleness alarm when a source is stale > 6 h in season; the freshness budget owns the paging leg |

Confidence normalization: VIIRS `l`/`n`/`h` → `low`/`nominal`/`high`; MODIS numeric →
`<30` low, `30–79` nominal, `≥80` high (the FIRMS convention). Keep the raw value; the
normalized enum exists for UX and alert gating only.

### A2. MODIS — archive/backfill only (end of life)

| Fact | Value |
|---|---|
| Instruments | MODIS 1 km on Terra + Aqua, via FIRMS (MCD14) |
| Status 7/2026 | **Aqua instrument shutdown ~26 Aug 2026; Terra science ends ~Feb 2027.** MODIS is no longer a live-pipeline source |
| Role for us | Historical archive for golden-replay fixtures and pre-2026 backfill only (ADR-002 keeps the MODIS ε formula for fixture replay) |
| Licence | Same as FIRMS (CC0/open + disclaimer) |

Do not add MODIS to any live ingest path; season 1 starts after Aqua's shutdown.

### A3. Sentinel-3 SLSTR FRP (`SL_2_FRP___`)

| Fact | Value |
|---|---|
| Instruments | SLSTR 1 km thermal (F1/F2 fire channels) on S3A + S3B |
| Coverage BG | ~daily day + night passes |
| Latency | **NRT < 3 h** via EUMETSAT Data Store; NTC archive on CDSE STAC (`sentinel-3-sl-2-frp-ntc`) |
| Access | EUMETSAT Data Store REST API / `eumdac` client (free account) |
| Format | netCDF (SAFE-style granules) |
| Licence | Copernicus free/full/open — commercial OK, attribution |
| Cost | Free |
| Status 7/2026 | Operational |

Fit: independent third polar source (different overpass times than VIIRS), FRP values
for the score/E-accumulator (ADR-002 weight 0.75, ε ≈ 1.5 km).

### A4. LSA SAF geostationary FRP — MSG SEVIRI (operational) + MTG FCI (demonstration)

| Product | Facts |
|---|---|
| **FRP-PIXEL LSA-502 (MSG SEVIRI)** | **Operational.** 15-min repeat; ~4 km pixel over Bulgaria; ~30 min product latency; HDF5; CC BY 4.0; free. Access: `datalsasaf.lsasvcs.ipma.pt` + EUMETSAT channels |
| **FRP-PIXEL LSA-509 (MTG FCI)** | **Demonstration maturity** (not operational). 10-min repeat; ~1.5 km-class resolution; netCDF; on EUMETCast since 7 May 2026. Better cadence/resolution than LSA-502 — pair the two, never trust 509 alone |
| **FRP-GRID LSA-503 (MSG)** | **Suspended** — do not plan on it |

Fit: the geostationary cadence layer — sub-hourly persistence signal between polar
overpasses. Per ADR-002: GEO detections are **attach-only** (never create or merge
events, E-weight 0.05/slot) and **never alert alone** (ADR-004 Decision 4).
Product page: `lsa-saf.eumetsat.int/en/data/products/fire-products/`.

### A5. EUMETSAT MSG Active Fire Monitoring (FIR / FIRC)

| Fact | Value |
|---|---|
| Product | `EO:EUM:DAT:MSG:FIRC` — **CAP (Common Alerting Protocol) alert format, emitted only when a fire is detected** (no FRP values) |
| Cadence | Follows the SEVIRI repeat cycle; effectively a push-style trigger |
| Access | EUMETSAT Data Store (free account) |
| Licence / cost | EUMETSAT free-data terms, attribution / free |

Fit: cheap "something is burning in cell X" tripwire that can trigger an immediate
FIRMS/LSA-SAF re-poll; not a detection source in the clustering sense.

### A6. FireSat (Earth Fire Alliance) — the season-2 watch item

| Fact | Value |
|---|---|
| Status 7/2026 | **3 operational satellites launched 7 Jul 2026**; commissioning ~3 months; 2×/day data to Early Adopters expected Q4 2026 |
| Plan | Free licences planned for 2027 — **but the free tier is non-commercial**; a paid Fire Watch tier would need a commercial arrangement (flag for monetization planning, 09) |
| Action now | Register Early Adopter interest at `earthfirealliance.org` |

Fit: at full constellation, 5 m-class fire detection with ~20 min global revisit —
a potential step change for season 2 (2028). Nothing to build against yet.

### A7. OroraTech (commercial benchmark)

| Fact | Value |
|---|---|
| Offer | Wildfire intelligence service; REST API `https://app.ororatech.com/v1/` (apikey header, webhooks) |
| Coverage | FOREST-16..19 launched May 2026 for the Greek national system — high Balkan coverage |
| Cost | Subscription-only (enterprise pricing, no public list) |

Fit: not for season 1's budget; the benchmark of what a paid detection feed looks
like, and a possible v2 upgrade if revenue exists. API docs: `app.ororatech.com/docs/api/`.

### A8. Excluded active-fire sources

- **GOES (ABI FDC), Himawari** — Bulgaria is out of view. Excluded.
- **SDGSAT-1, SatVu, constellr, Hydrosat** — no practical NRT fire feed for our AOI
  (access, cadence, or product maturity fails). Excluded for now.
- **DIY FCI L1c processing** (own hotspot detection from Level-1) — technically
  possible via EUMETSAT Data Store, roadmap-only; LSA-509 covers the need first.

### A9. The polling area is config-as-data: `polling_bbox_v1`

The query area was previously described only as "a Balkans bbox" and pinned nowhere
(14 M2). It is now a **named, versioned config object**, used by every ingest path:
the FIRMS Area API query, EUMETSAT/SLSTR search extents, the crop applied to full-disk
GEO products, and the EFFIS WFS/WMS request extents.

| Fact | Value |
|---|---|
| Config name | `polling_bbox_v1` — in git beside `clustering_params_v1`, loaded at startup |
| Value (v1) | `west 20.0, south 39.0, east 31.0, north 46.0` (WGS84 decimal degrees). FIRMS Area API argument order is `west,south,east,north` |
| Versioning | Same regime as ADR-002 D5: a change is a PR with shadow-mode diff evidence, never a live tweak; the config version id is recorded on every poll run; ids are never reused |
| **Rule** | **bbox ⊇ the alertable area, buffered by at least `2×ε_max + max watch-zone radius`** |
| Arithmetic today | Alertable area = Bulgaria + 100 km (ANALYSIS.md; endorsed as domain-correct by 12). ε_max = 6 km (GEO, ADR-002 D2) → 2×ε_max = 12 km. Max watch-zone radius = 30 km (07 §5.5.1 slider 2–30 km). **Minimum buffer = 42 km.** |
| Margin in v1 | Every edge of `polling_bbox_v1` sits ≥ ~95 km outside the alertable area — more than twice the minimum, so an ε retune or a zone-radius change does not immediately force a bbox version bump |

**Why the rule exists.** A fire straddling the *query* edge returns only the detections
that fall inside the box. Three failures follow, in increasing severity: the hull,
centroid and FRP aggregates are wrong; the miss-evidence accumulator counts overpasses
that "should have seen" pixels which were never queried, so E accrues on absent data
and the event can be declared `no_longer_detected` while it burns; and if fine
detections land on both sides, one fire can acquire two identities. The buffer must be
at least **2×ε_max** so no cluster can be bisected by the query edge (two detections of
the same fire are always within one ε of a chain member), **plus the largest zone
radius** so no alertable zone can reach past the polled area. S1 (Slavyanka) tests the
*country* border; the *query* border is a different edge and needs its own fixture.

Rules of engagement:

- **Widening is safe** — the new band simply starts recording from that poll onward.
  **Narrowing is a data-loss event**: rows already recorded stay, but the archive becomes
  spatially non-uniform and every backfill metric computed across the change is biased.
  A narrowing requires an explicit note in the config-change PR and a dated entry in the
  archive layout notes.
- **Polled ≠ alertable.** The band between the alertable area and the bbox edge is
  polled and clustered so that geometry and lifecycle are correct at the edge; it is
  outside the alertable area by definition.
- **Fixture S16** (14 §5) places a fire on the bbox edge and asserts the buffer absorbs
  it: one event, correct geometry, no truncated hull, no E accrual from unqueried
  ground.
- Multi-country expansion (01 R13) turns this single object into one row per AOI; the
  rule then applies **per AOI**, not to their union.

---

## Part B — Imagery: confirmation, smoke, before/after

### B1. Sentinel-2 MSI (post-fire confirmation, dNBR)

| Fact | Value |
|---|---|
| Resolution | 10 m (VIS/NIR), 20 m (SWIR B11/B12 — the fire bands) |
| Constellation 7/2026 | **Three satellites**: S2B + S2C, plus S2A in extended ops (extension may lapse — monitor) |
| Revisit BG | effectively **~2–3 days** at 42–43°N in the 3-sat config |
| Latency | L2A ≤ 24 h from sensing (typically less), cloud permitting |
| Access | CDSE (all APIs, §C1); AWS `s3://sentinel-cogs` COG mirror (free, no auth); Earth Search STAC |
| Licence | Copernicus free/full/open — **commercial OK**, attribution "Contains modified Copernicus Sentinel data [year]" |
| Cost | Free |

Fire rendering: SWIR false colour **B12/B11/B8A** (burn scars dark red-brown, active
burning glows), NBR/dNBR for severity, L2A SCL band for cloud masking. Two access
strategies: (a) CDSE Sentinel Hub Process API evalscripts — on-demand crops, zero
storage, ~1–2 PU per 512×512 render inside the free 10k PU/month; (b) COG range-reads
of just B8A/B11/B12 from `sentinel-cogs` — quota-independent, own GDAL processing.
Use (a) for the UI's before/after slider, (b) for batch dNBR perimeter jobs.

### B2. NASA GIBS / Worldview (daily smoke visualisation — the cheapest win)

| Fact | Value |
|---|---|
| Provides | Daily VIIRS 375 m / MODIS 250 m corrected-reflectance true & false colour, 1000+ layers |
| Endpoint | WMTS REST, e.g. `https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/{layer}/default/{YYYY-MM-DD}/{TMS}/{z}/{y}/{x}.jpg` |
| Key layers | `VIIRS_SNPP_CorrectedReflectance_TrueColor` (smoke), M11-I2-I1 false colour (burn scars through light smoke) |
| Latency | typically **4–5 h** after observation |
| Auth / quota | **None. No key, no documented limits.** Best-effort service, no SLA |
| Licence | NASA open — commercial OK; GIBS acknowledgment line in credits; no implied endorsement |
| Cost | Free |

Fit: a MapLibre raster source with a date dimension = same-day-afternoon satellite
view of the whole Balkans, zero processing. Ship first. Proxy/cache per the ADR-001
A1.2 pattern if we want origin privacy, though GIBS is keyless so client-direct is
also acceptable — decide at implementation.

### B3. Sentinel-3 OLCI / SLSTR imagery (regional daily smoke + thermal)

300 m OLCI true colour (plumes at regional scale) + 500 m/1 km SLSTR thermal, ~daily,
**NRT ≤ 3 h**; rendered via the same CDSE Sentinel Hub integration as B1 (same PU
quota). Copernicus licence, free. The best free "what is burning right now,
regionally" view after GIBS — and 1–2 h fresher.

### B4. Landsat 8/9 (gap-filler for before/after)

30 m multispectral incl. SWIR, 8-day combined revisit; RT tier < 12 h (typically
4–6 h) for L1. **US public domain — the cleanest licence in the catalog** (courtesy
line "Landsat imagery courtesy of USGS"). Access: Earth Search STAC
(`landsat-c2-l2`, free) or USGS M2M API (manual MACHINE-role approval); the USGS AWS
bucket is **requester-pays** — budget or avoid direct asset egress. Medium priority:
fills S2 revisit gaps for before/after pairs.

### B5. Sentinel-1 SAR (smoke/cloud-proof burn scars — v1.5 experiment)

| Fact | Value |
|---|---|
| Constellation 7/2026 | **S1C + S1D** (S1A retired 29 Jun 2026; revisit pattern shifted 1 day vs the old A/B timeline) |
| Revisit BG | ~3-day repeat over Europe (asc + desc) |
| Products | IW GRD ~10 m pixel spacing; burn scars via backscatter drop + coherence change |
| Processing paths | CDSE CARD-BS on-demand (25 products/month free) or **ASF HyP3 RTC** (free, zero own infrastructure) — avoid running SNAP on the VM |
| Licence / cost | Copernicus free/full/open / free |

Fit: the only sensor that sees through smoke and cloud, but real processing burden —
keep as a v1.5 experiment, not a launch dependency.

### B6. Burned-area products (context/validation only — all too slow for operations)

| Product | Res / cadence | Coverage | Verdict |
|---|---|---|---|
| **EFFIS RDA perimeters** | MODIS 250 m + VIIRS + Sentinel-2 20 m refinements; **up to 2×/day in season** | EU, live | **The in-season perimeter feed** — see §D1 |
| MODIS MCD64A1 C6.1 | 500 m, monthly, ~1–3 months lag | 2000 → 2025 | EOL with MODIS — historical only |
| **VIIRS VNP64A1 v2** | 500 m, monthly | 2012 → present | The go-forward monthly BA standard; validation + statistics |
| ESA FireCCI51 | 250 m, monthly | 2001–2020 (closed) | Historical baseline only |
| C3S FireCCIS311 | 300 m, monthly | 2019–2024 | Climate record; CDS access |

Live perimeters for the product = EFFIS + own Sentinel-2 dNBR; monthly products serve
validation (ADR-004 CER metric) and seasonal statistics.

---

## Part C — Access platforms (how we actually fetch)

### C1. Copernicus Data Space Ecosystem (CDSE) — the backbone platform

| Fact | Value |
|---|---|
| Provides | Full archive + NRT of Sentinel-1/2/3/5P/6, S1/S2 mosaics, on-demand processing |
| Auth | Free registration; OAuth2 tokens (10-min TTL); per-account S3 keys |
| APIs | OData, **STAC**, OpenSearch, **Sentinel Hub** (Process/Catalog/OGC), openEO, S3 (`eodata.dataspace.copernicus.eu`) |
| Free quotas (verified 7/2026) | Sentinel Hub: **10,000 requests + 10,000 PU/month**, 300/min. OData/STAC: 50,000 req/month. S3: **12 TB per rolling 30 days**, 4 concurrent connections. openEO: 10,000 credits/month |
| Licence | Copernicus — free, full, open, **commercial use allowed**, attribution |
| Status 7/2026 | Operational (May 2026 datacentre fire briefly hit S2 production; no data lost) |

Fit: primary platform for everything Sentinel. The free PU quota covers thousands of
rendered fire-scene crops per month. Quota diversification: Earth Search + AWS COGs
(§C3) keep S2 workflows alive if CDSE quota or availability fails.

### C2. EUMETSAT Data Store

Free account; REST Browse/Download APIs + `eumdac` Python client; throttling **30
req/s, 10 parallel connections, 5 TB/day** — generous. Carries: MTG LI lightning
(§E1), FCI/SEVIRI cloud masks (§E2), SLSTR FRP NRT (§A3), MSG FIR/FIRC (§A5),
future MetOp-SG products. EUMETSAT data policy: free with mandatory attribution
(licence accepted once per account). EUMETCast (satellite dish pub/sub) exists but a
dish is out of scope — poll the Data Store instead.

### C3. NASA Earthdata / LANCE + Earth Search + AWS Open Data

- **Earthdata Login** (free): GES DISC (IMERG §F1), LP DAAC (VNP64A1), LANCE NRT.
- **Element84 Earth Search** `https://earth-search.aws.element84.com/v1/` — STAC, no
  auth, no key: `sentinel-2-l2a` COGs, `landsat-c2-l2`, `sentinel-1-grd`,
  `cop-dem-glo-30`. Community-funded, no SLA — primary *search index* with CDSE as
  fallback.
- **AWS `s3://sentinel-cogs`** — free-egress S2 L2A COGs (mirror lag behind CDSE:
  hours). HTTP range reads = extract single SWIR bands without whole-scene downloads.

### C4. Platforms rejected

- **Google Earth Engine** — commercial use requires ~$500+/month plans; the
  noncommercial tier does not fit a commercial entity's operational service.
  Prototyping-only under a noncommercial account; **nothing production may depend on
  it** (the "GEE trap" from 09, now verified).
- **Microsoft Planetary Computer** — open STAC/Data API still free (anonymous SAS),
  useful for Sentinel-1 RTC; but Microsoft's focus moved to the paid "Pro" product
  (GA June 2026) — convenience, not foundation.
- **Copernicus SciHub** — retired October 2023; CDSE replaces it entirely.

---

## Part D — Fire danger, weather, atmosphere

### D1. EFFIS — fire danger + burnt areas (the canonical EU service)

| Fact | Value |
|---|---|
| Fire danger | FWI + sub-indices (FFMC/DMC/DC/ISI/BUI), 6 danger classes; ~8 km (ECMWF-driven); daily, forecast to ~9–10 days |
| Burnt areas | RDA perimeters up to 2×/day in season; ≥~30 ha via MODIS, smaller via Sentinel-2 since 2018 (~95% of EU burnt area) |
| Access | **WMS/WFS, no registration**: `https://maps.effis.emergency.copernicus.eu/effis` (layers e.g. `ecmwf007.fwi`, `EFFIS:BurntAreas7Days`); WFS → Shapefile/SpatiaLite of the live BA database |
| Licence | CC BY 4.0 (EU reuse policy) — commercial OK; attribution + "Contains modified Copernicus Service information" |
| Cost | Free |

Fit: **two of our core layers from one no-auth service** — the daily fire-danger
raster (proxied per ADR-001 A1.2: `/overlays/effis/…`, 10–15 min TTL,
serve-stale-on-error) and the in-season burnt-area perimeters (WFS → PostGIS cron).
This is the only free *real-time daily* FWI feed — the CDS/EWDS datasets are not NRT.
Caveats: BA start/update dates ≠ ignition/extinction; no wildfire-vs-agri-burn flag.

### D2. ECMWF Open Data — **the weather source of record from wave 2**

0.25° IFS/AIFS real-time forecasts, 4 runs/day, GRIB2; 2 m temp/dewpoint (→RH),
wind + gusts, precip, CAPE, total cloud cover. **Free, no registration** —
`ecmwf-opendata` client, direct HTTPS, or the AWS `ecmwf-forecasts` mirror.
**CC BY 4.0 — commercial OK, with no service-tier condition attached**: the licence
does not change when the product starts charging, so nothing has to be re-decided at
monetization.

Fit: this is **the** source for every weather input we compute ourselves — wind-driven
spread context, own FWI computation, ECMWF total precipitation as the corroboration
leg for IMERG (§E3), and `tcc` as the licence-clean model-cloud stopgap (§E2). GRIB
parsing is the price: heavier than a JSON API, but it is founder time paid once, not a
monthly line item (§D6 records why that trade was taken).

### D3. Open-Meteo — **dev-only convenience layer, not a source of record**

Plain-HTTPS JSON weather API (multi-model incl. ICON-EU ~7 km), free tier 10,000
calls/day. Data licence CC BY 4.0 with attribution; **the free *service* tier is
non-commercial**, and under the commercial-in-trajectory doctrine (09 §2.2.I) a
freemium product with paid tiers is commercial use *even during its free stage* — so
"season 1 is free, therefore we qualify" does not hold. The $29/month Standard plan
was considered and **is not budgeted**: it alone exceeds the entire infrastructure
line (€6–21/mo) and breaks the ≤ €25/mo fixed-cost ceiling (RISKS R3), while §D2
covers the same needs at zero recurring cost.

Permitted uses: local development and prototyping; recorded `open-meteo/*.json`
fixtures (ADR-002 acceptance criteria §1); and the shadow-season `cloud_cover` proxy
for E-accumulator gating **through CP1 only** (§E2, §D6). Not permitted: any public
or beta surface, and any post-beta alert path. Reversing this needs a PR against this
section, not a config change.

### D4. CEMS fire-danger datasets on EWDS (climatology only)

`cems-fire-historical-v1` (ERA5-driven FWI reanalysis 1940→present, ~0.25°, ~5-day
append delay) on `ewds.climate.copernicus.eu`; async request queue (minutes–hours).
Use offline to build FWI percentile climatology ("how anomalous is today"), never in
the live path. Free, Copernicus licence.

### D5. Smoke & air quality — CAMS + Sentinel-5P

| Source | Facts |
|---|---|
| **CAMS European AQ forecast** | PM2.5/PM10 etc., **0.1° (~10 km), hourly, 4-day forecast**, daily ~06:45/08:30 UTC release; ADS API (ECMWF account + queue); GRIB/NetCDF; CC BY; free. The preferred "smoke over settlement X" feed |
| CAMS global forecast | 0.4°, 50+ species incl. BC/OM AOD; superseded by the European product for our AOI |
| CAMS GFAS emissions | v1.2 on ADS **discontinued 3 Dec 2025**; successor v1.4.2 ticket-gated on the ECMWF Data Portal — awkward access, low added value for us. Skip |
| **Sentinel-5P TROPOMI** | UV Aerosol Index + CO columns, ~5.5×3.5 km, 1 overpass/day, **NRTI ≈ 3 h**; CDSE access; free, Copernicus licence. Operating beyond design life; successor Sentinel-5 (MetOp-SG-A1, launched Aug 2025) commissioning — plan migration season 2+ |

Fit: smoke features are season-1.5 — CAMS European AQ for forecasts, S5P AI/CO for
"was there smoke today" confirmation.

### D6. Sources of record — weather and cloud (exactly one per use)

One source is authoritative per use, so WP1, the E-accumulator's cloud gating
(ADR-002 D6) and the risk register cannot disagree about what is load-bearing when.
Anything not listed here is corroboration, fallback or fixture material.

| Use | Source of record | From when | Note |
|---|---|---|---|
| Published fire-danger layer (FWI, danger classes) | **EFFIS** (§D1) | wave 1 | The canonical daily service; we display it, we do not recompute it |
| Our own weather inputs (wind, RH, temperature, precipitation for scoring and context) | **ECMWF Open Data** (§D2) | wave 2 | CC BY 4.0 with no service-tier condition; own-FWI computation also runs off this |
| Cloud gating of the miss-evidence accumulator (ADR-002 D6) | **Open-Meteo hourly `cloud_cover`** (§D3) | shadow season → **CP1 inclusive** | Explicitly declared *sufficient for CP1* (11 §5.7): a model proxy is good enough to calibrate the accumulator against a recorded season. Dev/shadow-only usage, so the §D3 licence fence holds |
| Cloud gating of the miss-evidence accumulator | **FCI/SEVIRI CLM observability sidecar** (§E2) | **pre-season 2027**, before the beta | Observed cloud at overpass time; ECMWF `tcc` (§D2) is the fallback if the sidecar slips, never Open-Meteo |
| "Did it rain on the fire" (reignition-window resets) | **GPM IMERG Early** (§E3) | wave 3 | ECMWF total precip (§D2) is the corroboration leg over Balkan terrain, not a second source of record |
| FWI climatology / percentile anomaly | **CEMS on EWDS** (§D4) | offline, any time | Never in the live path |

The cloud handover is deliberately *not* a swap of an unrecorded field: WP1 records
raw CLM from the shadow season onward (§E2), so the pre-season-2027 cutover is a
backfillable join, and both the proxy and the observed value stay on the row
afterwards — that is what keeps FER comparable across the switch instead of resetting
the metric.

---

## Part E — Ignition & detection-support signals

### E1. MTG Lightning Imager (ignition candidates)

| Fact | Value |
|---|---|
| Product | L2 Flashes/Groups (10-s chunks) + Accumulated products (30-s grid); total lightning (IC+CG, no discrimination), ~4.5 km effective pixel |
| Status | **Fully operational since 31 Oct 2024** (MTG-I1/Meteosat-12) |
| Latency | NRT chunks via Data Store; order ≤1–2 min end-to-end (exact figure UNVERIFIED) |
| Access | EUMETSAT Data Store (§C2), netCDF-4; poll every 1–5 min is realistic on one VM |
| Licence / cost | EUMETSAT free-data terms, attribution / free |

Fit: "storm passed over cell X → watch for hotspots for 24–72 h" flags feeding the
score's ignition context. Ground networks rejected: Blitzortung (non-commercial-only
licence — avoid as dependency), ATDnet/EUCLID (closed/paid); MTG LI covers the need.

### E2. Cloud mask — the "was the sky actually clear?" check

| Source | Facts |
|---|---|
| **MTG FCI L2 CLM** | 10-min repeat, ~2 km; operational-release validation passed (2025); EUMETSAT Data Store, netCDF |
| MSG SEVIRI CLM | 15-min repeat, ~3–5 km over BG; running in parallel with MTG |
| Model proxy | ECMWF `tcc` (§D2) — model cloud, not observed; the licence-clean stopgap. Open-Meteo hourly `cloud_cover` is the same class of signal but is fenced to dev/shadow use (§D3) |

Fit — **which cloud source is load-bearing when** (§D6 is the index; this is the
reasoning):

- **Shadow season → CP1 inclusive: Open-Meteo hourly `cloud_cover`.** ADR-002 D6's
  gate is coarse by construction (>80% → no evidence, 50–80% → half, <50% → full), and
  calibrating E against one recorded season does not need sub-pixel truth. 11 §5.7
  declares the model proxy **sufficient for CP1** — so CP1 is not blocked on the
  sidecar, and nothing in WP1 is allowed to claim it is.
- **From pre-season 2027 (i.e. before the beta): FCI/SEVIRI CLM is the source of
  record.** Observed cloud at overpass time is what the honesty logic actually
  promises the user, the 10–15 min CLM cadence brackets any polar overpass, and by
  then the product is public and the Open-Meteo fence bites anyway.
- **WP1's obligation in season 1 is to *record*, not to join.** Raw CLM is archived
  from the shadow season onward so the 2027 cutover is a backfillable job rather than
  a new data dependency discovered in-season — the season cannot be re-run (§A1.1).
- **Both fields stay on the row after the cutover** (proxy value and observed value),
  which is what makes FER comparable across the switch.
- If the sidecar slips past pre-season 2027, the fallback is ECMWF `tcc`, **not**
  Open-Meteo — see the RISKS watchlist row "Cloud-observability handover".

### E3. Precipitation — GPM IMERG ("did it rain on the fire")

0.1°, half-hourly; **Early run ≈ 4 h latency**; NASA GES DISC via Earthdata login;
HDF5/NetCDF/GeoTIFF; NASA open licence, free. Answers "has rain reached this fire in
the last N h" for reignition-window resets (ADR-002). Satellite QPE is noisy over
Balkan terrain — corroborate with ECMWF total precip (§D2).

### E4. Soil moisture — fuel dryness context

- **CLMS SWI/SSM 1 km** (Sentinel-1-derived, daily NRT, Europe; S1C ingested Feb 2026,
  S1D validated Apr 2026): the practical "how dry is the fuel bed" layer scaling
  reignition windows. Free registration (land.copernicus.eu / WEkEO), Copernicus
  licence. S1 revisit ≈ 2–4 days per orbit direction — slowly-varying background.
- **ESA CCI / C3S SM** 0.25° daily (1978→present, ~10-day delay): climatological
  anomaly context only.

---

## Part F — Static layers (one-time ingests into PostGIS)

| Layer | Source | Licence | Notes |
|---|---|---|---|
| **Fuel classes** | ESA WorldCover 10 m (2021) — public S3 `s3://esa-worldcover`, no auth; or CLC+ Backbone 2023 10 m (CLMS) | CC BY 4.0 / Copernicus | Grass/shrub/forest classes drive ADR-002's 7/14/21–30-day reignition windows |
| **Agri-burn mask** | CORINE CLC 2018 (44 classes, 25 ha MMU) | Copernicus | Agriculture subtypes → the agri-burn masking the fire-domain review requires |
| Forest detail | CLMS High-Resolution Layers (tree-cover density, forest type, 10 m) | Copernicus | Refines forest vs shrub |
| **Terrain** | Copernicus DEM GLO-30 (30 m; CDSE or AWS `copernicus-dem-30m` COGs, no auth) | Free incl. commercial, **mandatory fixed attribution sentence** | Slope/aspect for fire-behaviour context; a few GB for BG+buffer |
| Hillshade tiles | AWS Terrarium terrain tiles (no auth) | Free; tilezen/joerd attribution | Map display only (already in ADR-001) |
| **Population** | GHSL GHS-POP/GHS-BUILT (100 m / 1 km) | CC BY 4.0, no registration | "Fire near settlement" sizing |
| **Settlements** | GeoNames `BG.zip` dump (not the rate-limited API) | CC BY 4.0 | Nearest-place naming |
| Place names (alt) | OSM-derived | **ODbL** — share-alike; keep OSM data in a separable store; **never store OSM element IDs inside fire-event records** (09) | Attribution "© OpenStreetMap contributors" |

---

## Part G — Basemap imagery & commercial awareness

### G1. Imagery basemap options (decided in ADR-001 A1.3; facts re-verified)

| Option | Licence | Verdict |
|---|---|---|
| EOX Sentinel-2 cloudless **2018+** (incl. 2024) | **CC BY-NC-SA 4.0 — non-commercial** | **Dropped** (ADR-001 A1.3). 2016 layer is CC BY but 10 years stale |
| **CDSE Sentinel-2 quarterly mosaics** | Copernicus — commercial OK | **Best licence-clean option**: render + self-cache the Balkans extent once per quarter (one-off PU spend, then zero). Recommended when an imagery toggle ships |
| Esri World Imagery via ArcGIS Location Platform | Esri terms; free tier **2M tiles/month** | Optional "HD imagery" toggle only, per ADR-001 A1.3 hard terms: never proxied, never SW-cached, metering alarmed |

### G2. Commercial / tasking (v2 awareness only)

| Provider | Offer | Blocker |
|---|---|---|
| Planet | Disaster Data Program (per-event releases); E&R tier 3,000 km²/mo | E&R is **non-commercial**; commercial = $10k+/yr class (UNVERIFIED) |
| Maxar (Vantor) Open Data | 30–50 cm pre/post-event ARD per major disaster | **CC BY-NC 4.0**; activation-dependent |
| Airbus | Pléiades Neo reactive tasking; "Wildfire Sentinel" product (May 2026) | Thousands of EUR/scene class |
| ICEYE | SAR Wildfire Insights (insurance/gov) | Enterprise contracts |
| Satellogic | ~1 m optical, Aleph tasking | Mixed licensing; verify per feed |

---

## Season-1 integration plan (consolidated ranking)

**Wave 1 — the pipeline cannot exist without these:**
1. **FIRMS VIIRS ×3 Area API** (A1) — detection backbone.
2. **LSA SAF LSA-502 SEVIRI FRP** (A4) — operational geo cadence; **LSA-509 FCI**
   paired as demonstration-grade enhancement.
3. **EFFIS** (D1) — FWI danger layer + in-season burnt-area perimeters.
4. **MTG/MSG cloud mask** (E2) — **recorded** from the shadow season (raw CLM archive;
   the season cannot be re-run). It becomes the *source of record* for E-accumulator
   cloud gating pre-season 2027; through CP1 the gate runs on the Open-Meteo
   `cloud_cover` proxy, which §D6 declares sufficient for CP1.
5. **Static ingests** (F) — fuel, agri mask, DEM, population, settlements.

**Wave 2 — visual confirmation & context:**
6. **NASA GIBS WMTS** (B2) — same-day smoke view, zero cost/auth. Trivial; can even
   ship in wave 1.
7. **CDSE Sentinel Hub S2 renders** (B1) — before/after slider, dNBR confirmation.
8. **SLSTR FRP NRT** (A3) + **S3 OLCI/SLSTR imagery** (B3) — third polar source +
   regional smoke.
9. **ECMWF Open Data** (D2) — **the weather source of record** (wind/RH/precip, own
   FWI, `tcc` stopgap). Open-Meteo (D3) is dev/fixture-only and never ships on a
   public surface; no paid weather tier is budgeted (§D6).
10. **MTG LI lightning** (E1) — ignition-candidate flags.

**Wave 3 — enrichment (season 1.5+):**
11. IMERG Early rain-on-fire (E3); CLMS SWI fuel dryness (E4); CAMS European AQ smoke
    forecasts (D5); Sentinel-5P smoke confirmation (D5); Landsat gap-filler (B4);
    Sentinel-1 SAR burn scars (B5); FWI climatology from EWDS (D4).

**Watchlist (dated):**
- **MODIS Aqua off ~Aug 2026, Terra ~Feb 2027** — already excluded from live path.
- **S-NPP EOL late 2026** — FIRMS backbone becomes NOAA-20/21; capacity drop ~⅓.
- **S2A extension** may lapse — revisit drops from ~2–3 d back toward 5 d.
- **LSA-509** Demonstration → Operational promotion — re-rank geo sources when it happens.
- **FireSat Early Adopter** data Q4 2026, free (non-commercial) licences 2027 —
  register interest now; commercial terms needed before any paid tier uses it.
- **Sentinel-5P** beyond design life — plan MetOp-SG Sentinel-5 migration season 2+.
- **Cloud-observability handover — pre-season 2027 (before the beta):** stand up the
  FCI/SEVIRI CLM sidecar and cut E-accumulator gating over from the Open-Meteo
  `cloud_cover` proxy (§D6/§E2). Prerequisite — raw CLM recorded from the shadow
  season, so the cutover is a backfill, not a new dependency.
- **Blitzortung/Open-Meteo/GEE/EOX-2018+/Planet-E&R/Maxar-OD** all carry
  non-commercial clauses — the recurring licence trap; every new source gets a licence
  check against 09 before integration [GATE-MVP: attribution registry `credits.ts`].
  (Open-Meteo is already resolved: dev-only by decision, §D3 — no paid tier budgeted.)

---

## Attribution strings — verbatim (source of truth for `credits.ts` / CI-13)

Attribution is the licence fee (09 §2.3). This table is **normative for wording**: each
string is reproduced exactly as its provider publishes it, in the provider's own
language and punctuation, including hyphenation and year placeholders. Do not
paraphrase, translate, reflow or "tidy" them. `credits.ts` (ADR-001 A1.4) is built from
this table; **WP5's CI-13 asserts the rendered attribution block contains each string
marked *render***, so this table — not the UI code, not a review — is what CI compares
against. `[YEAR]` is substituted at render time with the year of publication or
distribution of the data actually used. At integration each adapter also pins the full
licence text plus its retrieval date into `docs/licenses/` (09 §2.3.5).

| # | Source / layer | Surface | Verbatim string | Authority |
|---|---|---|---|---|
| 1 | OpenStreetMap (basemap, place names) | map corner + `/credits`, **render** | `© OpenStreetMap contributors` — hyperlinked to `https://www.openstreetmap.org/copyright`; may collapse behind an "(i)" control only if the licence info stays reachable | OSMF Attribution Guidelines (09 §2.2.F) |
| 2 | OpenFreeMap / OpenMapTiles (beta tiles) | map corner, **render** while used | `OpenFreeMap © OpenMapTiles Data from OpenStreetMap` (the "OpenFreeMap" part is optional; the rest is not) | openfreemap.org (09 §2.2.G) |
| 3 | Protomaps self-hosted build | map corner, **render** while used | Row 1 remains mandatory (the tileset is an ODbL *produced work*); `Protomaps` credit is requested, not required | Protomaps LICENSE_DATA (09 §2.2.G) |
| 4 | NASA FIRMS / LANCE — acknowledgement | `/credits` + About, **render** | `We acknowledge the use of data and/or imagery from NASA's Fire Information for Resource Management System (FIRMS), part of NASA's Land, Atmosphere Near real-time Capability for Earth observations (LANCE) and NASA's Earth Science Data and Information System (ESDIS).` | FIRMS official citation (09 §2.2.A) |
| 5 | NASA LANCE — redistribution disclaimer | `/credits`, linked from alert footers, **render** | `Due to the spatial resolution and other characteristics of these data, their use for tactical decision-making or informing about conditions at a local scale are not advised.` — paired with the "as is" clause: data `are provided "as is" and users bear all responsibility and liability for their use` | LANCE disclaimer, replication requested (09 §2.2.A) |
| 6 | NASA GIBS / Worldview imagery | `/credits`, **render** while the layer ships | `We acknowledge the use of imagery provided by services from NASA's Global Imagery Browse Services (GIBS), part of NASA's Earth Science Data and Information System (ESDIS).` | GIBS citation guidance (verified 8/2026) |
| 7 | EUMETSAT data (Meteosat/MTG products) | `/credits`, **render** | Policy pattern (Art. 6.3, verbatim): `[Contains modified] EUMETSAT [Meteosat/Metop] [data/product] [Year of publication or distribution]`. Our instantiation: `Contains modified EUMETSAT Meteosat data [YEAR]` | EUMETSAT Data Policy Art. 6.3 (09 §2.2.B) |
| 8 | LSA SAF FRP-PIXEL (LSA-502 / LSA-509) | map corner short form + `/credits` long form, **render** | Map corner: `EUMETSAT LSA SAF`. Text/`/credits`: `Data source: EUMETSAT LSA SAF, FRP-PIXEL (LSA-502 / LSA-509)`. Figure form: `EUMETSAT LSA SAF [Product Acronym, Product Identifier]` | LSA SAF data-access pages (09 §2.2.C) |
| 9 | Copernicus Sentinel data — modified (our normal case) | `/credits`, **render** | `Contains modified Copernicus Sentinel data [YEAR]` | Sentinel Data Legal Notice (09 §2.2.D) |
| 10 | Copernicus Sentinel data — unmodified renders | `/credits` when applicable | `Copernicus Sentinel data [YEAR]` | Sentinel Data Legal Notice (09 §2.2.D) |
| 11 | Copernicus **Service** outputs (EFFIS, CAMS, CLMS) | map corner + `/credits`, **render** | `Contains modified Copernicus Service information [YEAR]` | Copernicus legal notice (09 §2.2.D/E) |
| 12 | EFFIS (fire danger, burnt areas) | `/credits`, **render** | `© European Union, [YEAR], European Forest Fire Information System (EFFIS)` — **our chosen form**: EFFIS publishes no canonical string, CC BY only requires "appropriate credit". Pair with row 11 | EFFIS data-licence page (09 §2.2.E) |
| 13 | GWIS (if ever used) | `/credits` | Same pattern as row 12 with `Global Wildfire Information System (GWIS)` | GWIS data-licence page (09 §2.2.E) |
| 14 | **Copernicus DEM GLO-30 — distribution/communication** | `/credits`, **render** | `© DLR e.V. 2010-2014 and © Airbus Defence and Space GmbH 2014-2018 provided under COPERNICUS by the European Union and ESA; all rights reserved.` | COP-DEM-GLO-30-F licence, Art. 6(a) (verified 8/2026) |
| 15 | **Copernicus DEM GLO-30 — adapted/modified** (our case: slope, aspect, hillshade derivatives) | `/credits`, **render** | `produced using Copernicus WorldDEM-30 © DLR e.V. 2010-2014 and © Airbus Defence and Space GmbH 2014-2018 provided under COPERNICUS by the European Union and ESA; all rights reserved` | COP-DEM-GLO-30-F licence, Art. 6(b) (verified 8/2026) |
| 16 | **Copernicus DEM GLO-30 — liability sentence** (required in the notice covering distribution or communication to the public, modified or not) | `/credits`, **render** | `The organisations in charge of the Copernicus programme by law or by delegation do not incur any liability for any use of the Copernicus WorldDEM-30` | COP-DEM-GLO-30-F licence, Art. 6(c) (verified 8/2026) |
| 17 | Terrarium terrain tiles (Tilezen/Mapzen composite) | map corner short form + `/credits` full list, **render** while used | Map corner: `Terrain: Mapzen/Tilezen & sources`. `/credits` must carry the EU-DEM sentence verbatim: `Produced using Copernicus data and information funded by the European Union - EU-DEM layers`, plus `courtesy of the U.S. Geological Survey` and the NOAA ETOPO1 credit | tilezen/joerd `attribution.md` (09 §2.2.G) |
| 18 | Landsat 8/9 | `/credits` when used | `Landsat imagery courtesy of USGS` | USGS courtesy line (§B4) |
| 19 | Esri World Imagery (optional toggle) | injected by the ArcGIS MapLibre plugin — **never hand-coded** | `Powered by Esri` + the plugin's live data-provider list (currently `© Esri, Maxar, Earthstar Geographics, and the GIS User Community`; 09 records it as `© Esri, Vantor, Earthstar Geographics, and the GIS User Community` after the provider rename). CI-13 asserts the plugin's attribution element is present when the toggle is on, not our copy of the wording | Esri Master Agreement + ArcGIS attribution docs (09 §2.2.H) |
| 20 | **Derivation sentence** (satisfies CC BY "indicate changes" for every row above, and keeps our output from reading as an official product) | `/credits` + About, **render** | `Fire events shown on this map are derived by [Product] from the sources above (clustering, filtering, enrichment). Errors and omissions are ours, not the data providers'.` | 09 §2.4; ADR-001 A1.4 |
| 21 | EOX Sentinel-2 cloudless 2018+ | **not rendered — layer not shipped** (dropped, ADR-001 A1.3) | Recorded only so the layer cannot be re-added without the paid contract: `EOxCloudless https://cloudless.eox.at by EOX IT Services GmbH (Contains modified Copernicus Sentinel data [year])` | EOX licence page (09 §2.2.I) |

Assembled map-corner line (09 §2.4, unchanged in substance; the DEM sentences live on
`/credits` because they do not fit a map corner):

```
© OpenStreetMap contributors | © OpenMapTiles | Fire data: NASA FIRMS · EUMETSAT LSA SAF |
Contains modified Copernicus Sentinel data & Service information [YEAR] | Terrain: Tilezen/Mapzen
```

**Strings still to be pinned at integration** — CC BY sources whose exact wording is not
yet verified against the provider, so they are *not* in CI-13's assertion set until the
adapter lands and `docs/licenses/` is populated: ESA WorldCover, CLC+/CORINE, GHSL
GHS-POP/GHS-BUILT, GeoNames, CLMS SWI/SSM, GPM IMERG, CAMS. UNVERIFIED — each must be
copied verbatim from the provider at integration time and added to this table in the
same PR as the adapter.

## Licence quick reference

| Bucket | Sources | Terms |
|---|---|---|
| Public domain / CC0 | Landsat, FIRMS | Free incl. commercial; FIRMS requires LANCE disclaimer replication |
| NASA open | GIBS, IMERG, VNP64A1 | Free incl. commercial; acknowledgment lines; no implied endorsement |
| Copernicus open | All Sentinels, CDSE mosaics, CLMS, DEM GLO-30, CAMS, CEMS/EFFIS | Free incl. commercial; mandatory attribution (+ "modified Copernicus" formulas; DEM has a fixed attribution sentence) |
| CC BY 4.0 | EFFIS, LSA SAF, ECMWF Open Data, GHSL, GeoNames, WorldCover, Open-Meteo *data* | Free incl. commercial with attribution |
| EUMETSAT open | Data Store products (LI, CLM, FRP, FIRC) | Free with attribution; licence accepted at registration — confirm per-product text |
| ODbL | OSM-derived | Share-alike on derived databases; keep separable; no OSM IDs in event records |
| **Non-commercial traps** | EOX 2018+, Blitzortung, Open-Meteo *service* free tier **(decided: dev-only, §D3/§D6)**, GEE noncommercial, Planet E&R, Maxar Open Data, FireSat free tier (planned) | Unusable or conditional for a commercial entity — each needs an explicit decision before any paid tier launches |
