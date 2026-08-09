# Fire Watch — Project Analysis

*Near-real-time (15 min–3 h) wildfire monitoring platform. Initial deep analysis: data sources, architecture, business model.*
*Date: 2026-07-21. Status: pre-code, discovery phase. Amended 2026-07-30: normative
use-case statement added (§4), lifecycle vocabulary and frontend framework aligned with
ADR-002/ADR-005 (§5).*

---

## 1. Executive summary

**The idea:** a website (later PWA/mobile) that shows active wildfires in a chosen territory in
near-real-time, sends alerts, and layers risk context (fire danger forecast, wind, burned-area
history) on top of raw satellite detections.

**Why now / why here:**

- 2025 was the EU's most destructive wildfire year on record (>1.08M ha burned). Bulgaria was
  **#3 in the EU by burned area in 2025** and **#1 in July 2024** — the problem is acutely local.
- All primary data needed for an MVP is **free** (NASA FIRMS, Copernicus EFFIS/GWIS, EUMETSAT,
  Copernicus Data Space Ecosystem). The barrier to entry is engineering, not data licensing.
- The proven consumer model exists: **Watch Duty** (US nonprofit, $5.6M revenue in 2025,
  ~135k paying members) — but **nothing comparable exists for the Balkans/SE Europe**, the
  fastest-worsening fire region in the EU.
- New sensing capacity is coming online (MTG FCI geostationary over Europe, FireSat
  constellation) that will improve detection latency/resolution over the next 2–3 years —
  a platform that aggregates sources benefits automatically.

**Core thesis:** don't compete on *detection* (satellites and agencies do that); compete on
**aggregation, localization, UX and alerting** — turning raw hotspot pixels into "is my
village/forest/asset threatened, right now?"

---

## 2. Market context

| Fact | Detail |
|---|---|
| EU 2025 season | >1.08M ha burned — worst on record; ~300k ha by July (2× the Jan–Jul 2024 pace) |
| Bulgaria 2025 | #3 in EU by burned area (after Cyprus, Romania relative to territory) |
| Bulgaria 2024 | Most fire-affected EU country by July 2024; worst season in recorded history until 2025 |
| Cross-border | 2025 fires spread Bulgaria↔Serbia and Bulgaria↔Greece — a regional (Balkan) product scope is natural |
| EU 2026 (to Jul 15) | 167,326 ha / 1,083 fires — fire *count* more than double the norm for the date |

Existing options for a Bulgarian user today: NASA FIRMS map (global, English, raw hotspots, no
alerting UX), EFFIS viewer (expert-oriented GIS), news media (hours late), 112/BG-ALERT (reactive,
evacuation-stage only). **Gap: a localized, consumer-grade, near-real-time map + alert service.**

---

## 3. Data sources (the core research)

> **Errata 2026-07-21:** factual corrections applied after the specialist review round —
> see `docs/reviews/03-geodata.md` for details and sources.

### 3.1 Active fire detections — polar-orbiting (the backbone)

**NASA FIRMS** (Fire Information for Resource Management System) — the single most important
source. Free, global, well-documented REST API.

- **Sensors:** MODIS (Terra/Aqua, 1 km — both near end of mission; treat the three VIIRS
  satellites as the backbone), VIIRS (Suomi-NPP, NOAA-20, NOAA-21, 375 m), Landsat NRT
  (US-focused, 30 m).
- **Latency tiers:**
  - **NRT** (near-real-time): available within **~3 h** of observation — global, incl.
    Bulgaria. **This is the only tier available for Europe.**
  - **RT**: within **~30 min** — **North America only** (direct-readout stations).
  - **URT** (ultra-real-time): within **~5 min** of observation (detection itself 25–50 s
    after observation) — **US/Canada only** (SSEC direct broadcast). Do not design around it.
- **API:** `GET /api/area/csv/[MAP_KEY]/[SOURCE]/[west,south,east,north]/[day_range]` and a
  `/api/country/` variant. Sources: `VIIRS_SNPP_NRT`, `VIIRS_NOAA20_NRT`, `VIIRS_NOAA21_NRT`,
  `MODIS_NRT`, plus `_SP` (standard/archive) variants. Free MAP_KEY, **5,000 requests /
  10 min** — far above what polling a Balkan bbox needs. `day_range` counts **UTC calendar
  days** — always poll with `day_range=2` or detections around midnight UTC are missed.
  NRT rows are later reprocessed into SP (standard) products with shifted coordinates and
  confidence and no stable row ID (~months of lag) — the ingestion design must reconcile this.
- **Fields:** lat/lon, brightness, FRP (fire radiative power), confidence, acq_date/time,
  satellite, day/night. This is a **hotspot pixel**, not a "fire event" — clustering into
  events is *our* job (see architecture).
- **Practical revisit for Bulgaria:** 4 VIIRS/MODIS-carrying satellites → roughly 4–6 usable
  overpasses/day. Combined with 3 h NRT latency, expect **fresh polar data every few hours**,
  not continuously. This defines the honest MVP promise.

### 3.2 Active fire detections — geostationary (the sub-hour layer for Europe)

- **Meteosat Third Generation (MTG-I) FCI** — EUMETSAT's new imager over Europe/Africa.
  Full-disk every **10 min**; IR3.8 channel with extended dynamic range designed for fire
  detection; ~1–2 km IR resolution. **Target product: LSA SAF MTG FRP-PIXEL (LSA-509)** — a
  list of fire pixels with FRP, far easier to consume than the **L2 FIR** Active Fire
  Monitoring product (a per-pixel classification without FRP) originally considered. Realistic
  end-to-end latency is **~15–30 min** (not "minutes"), which still beats polar NRT by an
  order of magnitude. Integration is a Python-sidecar-sized job (1–2 weeks), not an evening.
- **MSG SEVIRI** (legacy, 15 min, FIR product) — still operational; useful fallback.
- **GOES-R ABI FDC** (Americas, 5–10 min) and **Himawari** (Asia-Pacific) — same pattern; only
  relevant if/when the product goes beyond Europe. Note GOES FDC is in Google Earth Engine and
  on AWS Open Data with minute-level delivery.

**Design implication:** two complementary streams — geostationary = fast but coarse ("something
is burning near X, 10-min cadence"), polar = slower but precise (375 m, FRP). Fusing them is the
main data-engineering value-add.

### 3.3 Fire danger, burned area, context — Copernicus

- **EFFIS** (European Forest Fire Information System, Copernicus Emergency Management Service):
  near-real-time burnt-area perimeters (MODIS/VIIRS-based rapid mapping; Sentinel-2 refines
  final perimeters), active-fire situation, and the
  **fire-danger forecast (FWI-based, 6 classes, ~8 km, 1–10 days ahead, ECMWF)**. Free via
  standard **WMS** layers; extracts via data-request form. This gives us the *predictive* layer
  ("extreme danger tomorrow in Sakar") without running our own meteorology.
- **GWIS** — the global twin of EFFIS (danger forecast, active fires, emissions; 8 daily
  updates). Use for anything outside the EFFIS window.
- **Copernicus Data Space Ecosystem (CDSE):** free-tier **STAC / openEO / Sentinel Hub APIs**
  for Sentinel-2 (10 m — post-fire burned-area mapping, dNBR), Sentinel-3 SLSTR (active fire /
  FRP), Sentinel-5P (CO / smoke plumes). Quotas apply; commercial tiers exist for scale.

### 3.4 Coming soon — plan for it, don't depend on it

- **FireSat** (Earth Fire Alliance + Muon Space + Google Research): purpose-built wildfire
  constellation. Protoflight launched Mar 2025; **first 3 operational satellites launched
  Jul 2026** (≥2×/day global revisit already); target **50+ satellites → 20-min global revisit
  (9 min in fire-prone regions)**, detecting fires down to ~5×5 m. EFA positions the data as a
  public good — access model still forming. **Strategic bet:** an aggregation platform is the
  natural consumer of FireSat data the moment it opens up; being source-agnostic is the moat
  against any single source commoditizing.

### 3.5 Supplementary layers (enrichment, differentiation)

| Layer | Source | Use |
|---|---|---|
| Weather (wind!, temp, RH) | Open-Meteo (free API, ECMWF/ICON models) | Spread direction hint, alert context |
| Lightning | EUCLID/Blitzortung (community) | Ignition-cause context |
| Land cover / fuel | CORINE, ESA WorldCover (free) | Filter false positives (industry, agri burns), severity context |
| Population / assets | GHSL, OSM | "Threatened settlements" logic, alert prioritization |
| Air quality / smoke | CAMS (Copernicus Atmosphere) | Smoke advisories — reaches far more users than flames |
| Official Bulgarian info | ГДПБЗН-МВР bulletins, BG-ALERT, media | Human-curated incident status (the Watch Duty secret sauce is *humans*, not satellites) |
| User reports | In-app crowdsourcing (photo + geolocation) | Ground truth, engagement; needs moderation |

### 3.6 Source comparison table

| Source | Coverage | Resolution | Cadence / latency (for BG) | Cost |
|---|---|---|---|---|
| FIRMS VIIRS NRT | Global | 375 m | ~4–6 passes/day, +≤3 h | Free |
| FIRMS MODIS NRT | Global | 1 km | ~4 passes/day, +≤3 h | Free |
| MTG FCI via LSA SAF FRP-PIXEL | Europe/Africa | ~2 km IR | **10 min** full disk, latency ~15–30 min | Free (registration) |
| EFFIS danger forecast | Europe+ | ~8 km | Daily, 1–10 d ahead | Free (WMS) |
| EFFIS burnt areas | Europe+ | MODIS/VIIRS NRT | ~Daily updates in season | Free |
| Sentinel-2 (CDSE) | Global | 10 m | 2–5 d revisit | Free tier + quotas |
| OroraTech | Global | varies | ~30 min revisit (own + 3rd party) | Commercial |
| FireSat (2027+) | Global | ~5 m detection | 20 min target | TBD — likely open-ish |

---

## 4. Product definition

**Positioning:** "Watch Duty for the Balkans" — trusted near-real-time (15 min–3 h) fire map +
alerts, in local languages, fused from every free satellite source plus curated official
information.

**What this product honestly is** (normative statement, from the fire-domain review —
`reviews/12-fire-domain.md`; all product copy and scope decisions must stay consistent
with it):

> Fire Watch is a **situational-awareness and tracking service for developing and
> ongoing fires**, built on satellite data that is minutes-to-hours behind reality. It
> will usually not be the first to know a fire has started — people on the ground and
> 112 are. It exists to answer: *"the fire I heard about — where is it, how big, which
> way has it grown, is it still being detected, and what is the danger level around me
> today?"* It is not a life-safety alarm, it never declares a fire out, and in an
> emergency 112 and official evacuation orders always come first.

### MVP (v0.1, ~4–6 weeks of evenings)
- Map (MapLibre GL + OSM/vector tiles) of Bulgaria (+100 km buffer — fires cross borders).
- FIRMS VIIRS+MODIS hotspots, polled every 5–10 min, clustered into **fire events** with
  age/intensity visual encoding (new <6 h, active, cooling >24 h).
- EFFIS fire-danger WMS overlay + burnt-area perimeters.
- Detail panel per event: detection history, FRP trend, nearest settlement, wind now/next 12 h.
- Honest freshness UX: every event shows "last satellite pass HH:MM"; **never imply live**.

### v1 — the retention features
- Accounts + **geofence alerts** ("watch zones"): push/email when a new detection appears within
  N km of saved locations. This is the feature people pay for.
- MTG FCI geostationary stream → sub-hour first detection for larger fires.
- Curated incident log for major fires (manual at first — editorial layer, BG + EN).
- PWA with push notifications; Telegram/Viber bot (high penetration in BG).

### v2 — the B2B surface
- Public REST API + webhooks (fire events near polygon).
- Org accounts: multi-polygon monitoring (forestry units, PV/wind parks, power-line corridors),
  audit log, SLA-backed alerting, seasonal reports (burned area per municipality, dNBR severity).
- Expansion: Greece, North Macedonia, Serbia, Romania (data is already there; it's i18n + tiles).

**Explicit non-goals:** fire *prediction* modeling (only relay EFFIS forecasts), dispatch/
operations tooling for firefighters (different sales cycle), own sensors/cameras.

---

## 5. Architecture

Style: **ports & adapters** (hexagonal), TypeScript/Node — consistent with kiko's proven shape:
ingestion adapters → domain core → delivery adapters.

```
        ┌────────────────────────────── ingestion (adapters, one per source) ─┐
        │ firms-poller (5 min)  effis-wms  fci-datastore  open-meteo  manual  │
        └───────────────┬──────────────────────────────────────────────────────┘
                        ▼  normalize → Detection {source, geom, time, frp, confidence}
        ┌── domain core ────────────────────────────────────────────────────┐
        │ dedup (same pixel re-seen)                                        │
        │ space-time clustering: Detection[] → FireEvent (DBSCAN, ~2 km /   │
        │   24 h window; events merge/split; lifecycle: active→signal-      │
        │   weakening→no-longer-detected→archived (ADR-002); confidence     │
        │   score from source mix + persistence)                            │
        │ enrichment: land cover filter, nearest settlement, wind vector    │
        │ alert engine: geofence match → notification outbox                │
        └───────┬───────────────────────────────┬───────────────────────────┘
                ▼                               ▼
        PostgreSQL + PostGIS            notification adapters
        (detections, events,            (web push, email, Telegram)
         zones, users)
                │
                ▼
        API layer: Fastify — REST (GeoJSON) + SSE for live map updates
        tiles: pre-generated vector tiles (tippecanoe) for history;
               live events as plain GeoJSON (volume is small: ~10²–10³/day)
                │
                ▼
        Frontend: Preact/Vite + MapLibre GL, PWA (see ADR-005)
```

**Key design decisions:**

1. **Poll, don't stream, at MVP.** FIRMS NRT for a Balkan bbox is a tiny CSV every few minutes;
   a cron-style poller with etag/dedup is enough. EUMETCast push comes later with FCI.
2. **FireEvent is the product's core entity** — not the raw hotspot. All UX, alerting, history
   and the API hang off events. Raw detections are kept append-only for reprocessing (clustering
   params will be tuned; must be able to re-run over history).
3. **SQLite→PostGIS decision point:** unlike kiko, geospatial queries (ST_DWithin for geofences,
   clustering) argue for **PostGIS from day one**. Managed Postgres (e.g. Neon/Supabase free
   tier) keeps ops near zero.
4. **Freshness as first-class data:** every event carries `last_observed_at` and `next_expected
   pass`; the UI renders staleness explicitly. This is both ethics and defensibility.
5. **Cost at MVP scale:** one small VM (a **persistent process is required** — resident
   pollers + SSE rule out serverless; unanimous reviewer finding) with PostGIS local at MVP
   (free tiers of managed Postgres don't survive a 24/7 poller — see `reviews/04-sre.md`),
   free data sources ≈ **€10–30/month**. Map tiles self-hosted (OpenFreeMap/Protomaps) to
   avoid per-request fees.

**Main technical risks:**
- *False positives* (sun glint, industrial heat, agricultural burns) → mitigate with land-cover
  masking, persistence rules (≥2 detections before alerting default-sensitivity zones),
  confidence tiers in UX.
- *Missed small/short fires* between passes → mitigate with FCI layer + honest messaging;
  never market as a life-safety system.
- *EUMETSAT FCI integration complexity* (netCDF, Data Store auth, EUMETCast) — the hardest
  adapter; schedule it after MVP proves demand.

---

## 6. Business model

### 6.1 Model options

| Model | Benchmark | Fit |
|---|---|---|
| **B2C freemium + membership** | Watch Duty: free core, $25/yr membership, 135k+ payers, $5.6M/yr | Proven, but needs large audience; BG+Balkans population supports maybe 5–20k payers at maturity |
| **B2B monitoring SaaS** | OroraTech (€37M raised, forestry/energy/insurance customers) | Highest revenue per account; realistic locally: forestry enterprises, PV/wind parks, ЕРП grid operators, agri holdings, insurers |
| **B2G** | Pano AI (fire agencies) | Slow procurement, but EU resilience/Interreg funding exists for exactly this in SEE |
| **API-as-product** | — | Cheap to expose once v2 exists; media licensing of the live map embed |
| **Nonprofit + grants** | Watch Duty (501c3), Google.org $2M grant | Realistic EU angle: Horizon Europe, EUSPA/CASSINI (Copernicus-based services!), climate foundations |

### 6.2 Recommended: staged hybrid

1. **Phase 1 (season 2026–27): free product, build trust.** A fire map is a trust business —
   Watch Duty's growth came from being *right* during disasters. Costs are negligible; revenue
   would only slow adoption. Instrument everything; collect watch-zone signups.
2. **Phase 2: B2C membership** (~€15–25/yr): more zones, SMS alerts, family sharing, seasonal
   reports. Keep core map + basic alerts free forever (public-safety ethics + growth engine).
3. **Phase 3: B2B tier** (~€50–500/mo by monitored area): polygon monitoring, webhooks/API, SLA,
   reports. Target list in BG: ЮЗДП/ЮЦДП state forestry, PV park operators (Karlovo/Pazardzhik
   clusters), ЕРП-та, vineyards/orchards, municipal civil-protection units.
4. **Parallel: EU funding.** The product is literally a "downstream Copernicus service" —
   CASSINI/EUSPA prize competitions and Horizon calls fund these; also derisk via Interreg
   (Balkan cross-border resilience) — the cross-border fire narrative (BG–GR–RS) is a strong
   application story.

### 6.3 Competitive moat (and its limits)

- Data itself is a commodity (free for all). The moat is **local**: language, place names,
  official-source curation, media relationships, being *the* name people check in fire season
  in SEE — network effects of trust. FireSat will *improve* the product (better input), not
  displace it, as long as the value is aggregation + alerting UX, not detection.
- Threats: EFFIS building a consumer UX (unlikely — JRC serves agencies), Watch Duty expanding
  to Europe (possible in ES/PT/GR first; a strong local incumbent is the defense), a
  well-funded local clone (speed + trust is the defense).

### 6.4 Liability & legal (must-do before launch)

- Prominent disclaimer: informational service, not an official warning system; satellite data
  has inherent latency/gaps; in emergency call 112. Follow official BG-ALERT/ГДПБЗН guidance.
- Never send "all clear" messaging. Alert copy reviewed for panic-minimization.
- GDPR: watch-zone locations are personal data (home locations) — minimize, encrypt, allow
  deletion; push tokens likewise.
- Data licensing: NASA FIRMS (cite, free), Copernicus (free with attribution), EUMETSAT Data
  Store terms (free tier, attribution) — all compatible with commercial use with attribution;
  re-verify EUMETSAT redistribution terms before exposing raw FCI data via our API.

---

## 7. Validation plan (before writing much code)

1. **Latency ground-truth (1 week, script-only):** poll FIRMS for BG bbox during active fire
   days; measure actual observation→availability lag and passes/day. Validates the honest-UX
   claims and the FCI necessity.
2. **Audience probe:** landing page ("satellite fire map for Bulgaria — join the waitlist") +
   a few posts in relevant FB groups (rural municipalities, beekeepers, forestry) during the
   current season. Target: 300+ signups = build v1.
3. **B2B discovery:** 5 conversations (forestry unit, PV operator, insurer, municipality,
   agri holding) — would they pay for polygon monitoring + SLA alerts, and how much?
4. **FCI spike:** one evening — register at EUMETSAT Data Store, pull one FIR granule for a
   known 2025 BG fire date, confirm decode effort.

---

## 8. Sources

- FIRMS URT announcement — https://www.earthdata.nasa.gov/news/feature-articles/firms-adds-ultra-real-time-data-from-modis-viirs
- FIRMS API (area) — https://firms.modaps.eosdis.nasa.gov/api/area/
- FIRMS FAQ (latency tiers) — https://www.earthdata.nasa.gov/data/tools/firms/faq
- GOES-R Fire/Hot Spot product — https://www.goes-r.gov/products/baseline-fire-hot-spot.html
- MTG FCI L2 FIR data guide — https://user.eumetsat.int/resources/user-guides/mtg-fci-l2-fir-data-guide
- MTG FCI early-fire-detection study — https://www.sciencedirect.com/science/article/pii/S2666017226000040
- EUMETSAT Data Store — https://data.eumetsat.int/
- EFFIS data & services (WMS) — https://forest-fire.emergency.copernicus.eu/applications/data-and-services
- GWIS — https://earthobservations.org/groups/global-wildfire-information-system
- Copernicus Data Space Ecosystem APIs — https://dataspace.copernicus.eu/analyse/apis
- FireSat (Google Research) — https://sites.research.google/gr/wildfires/firesat/
- FireSat 3 operational sats (Jul 2026) — https://www.globenewswire.com/news-release/2026/07/07/3323511/0/en/Muon-Space-Deploys-First-Three-Operational-FireSat-Satellites-for-Earth-Fire-Alliance.html
- Watch Duty 2025 annual report — https://www.watchduty.org/blog/2025-annual-report
- Watch Duty membership — https://www.prnewswire.com/news-releases/watch-duty-expands-wildfire-tracking-services-with-membership-program-301872287.html
- OroraTech / Pano AI / Dryad landscape — https://www.omdena.com/blog/top-ai-wildfires-detection-startups
- EU 2025 season, Bulgaria #3 — https://www.novinite.com/articles/233645/EU+Wildfires+Double+in+2025:+Bulgaria+Among+the+Hardest+Hit
- Copernicus ESOTC 2025 wildfires — https://climate.copernicus.eu/esotc/2025/wildfires
