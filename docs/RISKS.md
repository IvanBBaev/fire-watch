# Risk register

*Status: consolidated index.* Business risks R1–R10 are owned in full detail by
[`reviews/10-business-gtm.md`](reviews/10-business-gtm.md) §8; the engineering/data
watchlist distills [`DATA-SOURCES.md`](DATA-SOURCES.md) and the reviews. Re-check
the watchlist dates quarterly and before each season.

## 1. Business risks (R1–R10)

| ID | Risk | Likelihood × Impact | Core mitigations |
|---|---|---|---|
| R1 | **Success-disaster**: a viral fire lands 100–1000× traffic on €6–21/mo infrastructure | High × Critical | own tiles + snapshot-first read path (spike survival is a CDN property); Cloudflare Project Galileo application pre-launch; R2 static fallback; 50× load test before May 2027 |
| R2 | **Key-person + seasonality**: solo founder; the season that pays is the season that burns them out | High × High | fail-closed automation; zero manual-curation dependency in the MVP; runbooks; 1–2 volunteer moderators (НАДРБ) by v1; Oct–Nov founder recovery block |
| R3 | **Seasonal cash flow**: revenue concentrated in summer | High × Medium | annual-only supporter billing renewing in May; fixed costs ≤ €25/mo |
| R4 | **Reputational miss during a deadly fire** — the kill scenario | Medium × Critical | published expectations; alerts fail closed; public retrospectives; the disclaimer doubles as the ЗЗП liability shield |
| R5 | **Free-data dependency** (FIRMS/EFFIS/EUMETSAT policy change) | Low-Med × High | multi-source redundancy; archive everything locally from day 1 |
| R6 | **Cheap-entrant preemption** | Medium × High | speed to the spring-2027 beta; lock the Meteo Balkans partnership early |
| R7 | **FireSat/Google commoditization** of detection in 2027–28 | Medium × High | the moat is local depth (BG language, official sources, zones, honesty), not detection itself |
| R8 | **iOS PWA push platform risk** | Medium × Medium | PWA-first but Telegram is an equal-rank channel; Viber fallback |
| R9 | **Grant-time trap**: applications eating the build | Medium × High | any application > 40 h requires a written go decision |
| R10 | **B2G tender capture** | Low-Med × Medium | positioned as citizen/SMB complement, never tender-dependent |

Three structural readings (10 §8): **R2 × R3 compound into the structural risk** of
the whole venture; **R4 is the kill scenario** — one bad miss with 50k users can end
the product; **R1 is the paradox to plan for** — success and disaster are the same
event, on the same day.

## 2. Engineering & data watchlist

| Item | What can happen | Trigger / monitor | Response |
|---|---|---|---|
| **MODIS end of life** | Aqua off ~Aug 2026, Terra ~Feb 2027 → MODIS becomes archive-only | already factual | MODIS is backfill/fitting material only; no NRT dependency exists |
| **S-NPP EOL late 2026** | one VIIRS satellite fewer, wider pass gaps | NASA LANCE announcements | NOAA-20/21 carry the constellation; E-accumulator weights already per-satellite |
| **Sentinel-2A extension lapse** | reduced imagery revisit | ESA announcements | imagery is inspection-only, never on the detection path |
| **LSA-509 (FCI FRP) stays "Demonstration"** | GEO corroboration quality uncertain | EUMETSAT product status page | GEO is attach-only by design (ADR-002); operational LSA-502 (SEVIRI) remains the GEO baseline |
| **S5P beyond design life** | smoke/CO layer loss | mission status bulletins | CAMS European AQ continues; S5P is enhancement-only |
| **CDSE quota exhaustion** (10k PU/mo, 12 TB/30 d) | imagery pipeline stalls mid-season | quota dashboard; alarm at 80% | pre-rendered GIBS layers; AWS `sentinel-cogs` COG range-reads as the second access path |
| **GIBS / EFFIS have no SLA** | overlay outage exactly mid-season | per-source freshness budgets + meta-alerting (04) | proxy with 10–15 min edge cache and serve-stale-on-error (ADR-001 A1.2); single degraded banner (08 §5.6) |
| **EFFIS circularity** | BA perimeters partially derive from the same MODIS/VIIRS detections | methodological, permanent | treat EFFIS BA as semi-independent in validation; news-log corroboration is the independent CER leg |
| **NC-licence traps** | EOX 2018+, GEE, Open-Meteo free tier, Planet E&R, Maxar OD, Blitzortung, FireSat free tier are all non-commercial — and under the commercial-in-trajectory doctrine (09 §2.2.I) the free stage of a freemium product already counts as commercial use | licence review before integrating any new source (09) | the DATA-SOURCES licence table is the pre-flight checklist; **Open-Meteo is resolved, not pending**: fenced to dev, fixtures and shadow-season use, with ECMWF Open Data (CC BY 4.0, no tier condition) as the weather source of record from wave 2 — **no paid weather tier is budgeted**, since $29/mo alone would exceed the whole infra line and breach R3's ≤ €25/mo ceiling (DATA-SOURCES §D3/§D6) |
| **Cloud-observability handover** | the FCI/SEVIRI CLM sidecar slips past pre-season 2027 → the public beta gates ADR-002 D6's E-accumulator on a *model* cloud proxy, and if that proxy is Open-Meteo it is also out of licence on a public surface | the sidecar is a named pre-season-2027 item (DATA-SOURCES watchlist); FER compared across the proxy→observed switch | WP1 **records** raw CLM from the shadow season, so the cutover is a backfillable join rather than a new in-season dependency; the proxy is declared sufficient only **through CP1** (11 §5.7); if the sidecar slips, the fallback is ECMWF `tcc`, never Open-Meteo |
| **Season-window dependency** | CP1 needs live-fire data that stops existing ~Oct 2026 | the calendar | WP1 shadow ingest recording by early Sep 2026 — the #1 implementation priority |
| **ArcGIS free-tier cliff** | imagery toggle exceeds 2M tiles/mo during a viral event | usage metering alarm (A1.3) | toggle degrades to off; never proxied or pre-cached server-side (licence term) |
| **iOS push regression** | WebKit/Home-Screen push behavior changes | WebKit release notes; physical-device test (L-5) | Telegram equal-rank channel absorbs; in-app remains authoritative |

## 3. Standing risk-review practice

- Any new data source or dependency passes the 09 licence review **before** code.
- Any parameter change ships as a PR with shadow-mode diff evidence (ADR-002 D5).
- Post-incident: public retrospective (R4 mitigation) + watchlist update here.
