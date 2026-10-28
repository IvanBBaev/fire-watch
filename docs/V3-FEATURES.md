# Fire Watch v3.0 — software-only feature analysis

Status: proposal, 2026-10-28. Nothing here is committed scope until the founder ticks it into
`TASKS.md`. v3.0 follows [V2-FEATURES.md](V2-FEATURES.md) and assumes its waves 1–4 are built or
consciously dropped (§2).

## 1. Scope rule

The rule is the same as in v2.0. v3.0 contains only features that can be **built entirely in code**
in this repository. These are excluded:

- hardware (cameras, sensor nodes, receive stations)
- human operations (verified incident status, a moderation desk, official evacuation zones)
- legal or editorial prerequisites that block *building* the feature

An account, API key or data-sharing agreement that a feature needs **to go live** does not exclude
it. That need is recorded in the "go-live" column. The code is built and tested against fixtures
first.

The non-goals in `ANALYSIS.md` §4 still apply:

- No fire prediction model. Everything about the future is relayed and attributed.
- No dispatch or firefighter ops tooling.
- No own sensors.

v3.0 adds one more rule. **Everything descriptive stays descriptive.** A feature may describe what
the detections *did* (growth, direction, area over time). It may never say what a fire *will* do.
Every such feature carries the label pattern already used for A4 ("estimated outline").

## 2. Baseline v3 builds on

v2.0 on `main` today (`V2-FEATURES.md` §7):

- **Built, unticked:** A1 playback, A2 sensitivity filter, A4 estimated outlines, B1 FWI forecast,
  B3 MeteoAlarm, C5 preference sync, D1 export, D3 measure, D4 og:image, E2 before/after, E3 CEMS
  badge, F1 Natura 2000, F4 land cover, G2 signed webhooks.
- **Not built:** A3, A5, A6, B2, B4–B6, C1–C4, C6–C8, D2, E1, F2, F3, G1, G3–G6, H1, H2.
- **v1 prerequisites still open:** the PWA / service worker, I2 polygon zones and zone editing, the
  alert sign-up UI, K1–K4 (beta, load test, launch checklist, launch).
- **Open founder calls:** V2-Q1…Q5, the CI-12 `criticalPath` overage, and the copy keys listed per
  item in V2 §7.

**v3.0 is not a reason to skip these.** The cut in §5 puts the v1 prerequisites and the unbuilt v2
waves first ("wave 0"). A v3 feature that depends on one says so in its "builds on" column.

Building blocks that v2 adds and v3 reuses:

| Block | v3 leverage |
|---|---|
| A4 outlines (migration 032) + A1 playback history | Observed growth, direction and area-over-time are queries over data we already store. |
| G2 webhook channel (035) + DNS-pinned poster | Org integrations, GIS push feeds and partner relays are one more subscriber type. |
| E2 GIBS overlay + DS-7 COG reader | Recovery monitoring and the E1 dNBR job share one raster path. |
| C5 versioned preferences document (034) | Trip mode, embed settings and per-device modes need no new storage pattern. |
| D1 export + credits registry | Every new outward surface (OGC API, SDK, embed, MCP) inherits attribution. |
| H7 decision log + J1 meta-alerts + QA report | Public transparency metrics are a read-only projection of them. |
| Staff curation + two-person approval (L15) | Any editorial text that v3 generates has a review path already. |

## 3. Features by theme

Effort is engineering hours for code, tests and fixtures. It excludes founder copy review.

### A. Next-generation detection sources

The strategic bet in `ANALYSIS.md` is FireSat. Its first three operational satellites reached orbit
on 2026-07-07. Early-adopter data is expected from Q4 2026, wider access through 2027 and global
access around 2028. These dates are EFA statements and press reports, not contracts. Everything in
this theme is an **adapter behind the existing detection port**, tested on fixtures, and switched on
per source.

| ID | Feature | Data / licence | Builds on | Effort | Go-live |
|---|---|---|---|---|---|
| V3-A1 | **FireSat ingest adapter.** Map FireSat detections into the detection model with their own source ID, confidence mapping and pass footprint. The F15 pass predictor gains FireSat TLEs. | Earth Fire Alliance; terms not public yet | detection port, source_ids (F12), F15 SGP4 | 24 h | EFA access + redistribution terms |
| V3-A2 | **Sentinel-3 SLSTR FRP.** Night-time 1 km FRP as a fourth polar source; it fills the gap between VIIRS passes. | Copernicus Data Space (free account), Copernicus licence | detection port, NetCDF decoding | 20 h | CDSE account; confirm NRT latency on CDSE |
| V3-A3 | **Landsat 8/9 active fire (30 m)** as a confirmation layer on existing events, not a primary trigger (revisit ~8 days). | USGS / FIRMS LANDSAT_NRT (US/CA only today — check EU coverage) | attach-only pattern (ADR-002) | 10 h | Confirm Balkan coverage |
| V3-A4 | **Commercial constellation adapter** (OroraTech or similar), behind a feature flag, for a paid B2B tier only. | Commercial licence | V3-A1 adapter shape | 16 h | Contract (paid) |
| V3-A5 | **GEO-created events, gated.** Allow FCI FRP to *create* an event when the GATE-v2 evidence holds, with its own confidence label. | EUMETSAT LSA SAF | V2-A3, ADR-002 revisit | 24 h | GATE-v2 evidence + ADR amendment |
| V3-A6 | **Cross-source agreement score.** Show on each event how many independent sources saw it and when ("seen by 3 sources in 40 min"). | Own data | score v0, source_ids | 10 h | none |

### B. Observed fire behaviour (descriptive, never predictive)

| ID | Feature | Data / licence | Builds on | Effort | Go-live |
|---|---|---|---|---|---|
| V3-B1 | **Observed growth direction.** An arrow from the centroid drift of successive outlines, labelled "observed over the last N hours". | Own data | A4 outlines, A1 history | 16 h | Founder label (V3-Q1) |
| V3-B2 | **Area-over-time chart** per event from successive outlines, beside the F10 FRP sparkline. | Own data | A4, F10 | 8 h | none |
| V3-B3 | **"Quiet since" indicator.** Time since the last detection over an event, with the pass schedule so users see whether a satellite has looked since. Never "fire out". | Own data + F15 passes | lifecycle, F15 | 8 h | Copy keys |
| V3-B4 | **Event brief.** A templated, deterministic paragraph per event (where, since when, sources, growth, context layers). An optional LLM rewrite is a founder liability decision, not the default. | Own data | all detail fields, i18n | 16 h (templated) | V3-Q2 |

### C. Personal product

| ID | Feature | Data / licence | Builds on | Effort | Go-live |
|---|---|---|---|---|---|
| V3-C1 | **Trip mode.** A temporary route or corridor zone with an expiry date (holiday drive, hike). Alerts stop and the geometry is erased when it expires. | — | I2 polygons, alert engine, erasure | 20 h | v1 polygon zones |
| V3-C2 | **"Near me now", privacy-first.** One-shot device geolocation, evaluated in the browser against the snapshot; the location is never sent or stored. | — | snapshot, grid index (client port) | 10 h | none |
| V3-C3 | **Offline and low-bandwidth mode.** The PWA caches the last snapshot and a coarse basemap; a text-only event list for 2G/roaming. The stale banner already exists. | — | PWA (v1), F4 staleness banner | 24 h | v1 PWA |
| V3-C4 | **Accessible alert formats.** Plain-language and large-text variants of alert bodies, screen-reader-tested; a text-only event page. | — | L16 a11y protocol, catalogs | 12 h | Founder copy |
| V3-C5 | **Household readiness profile.** Optional flags (mobility, livestock, beehives) that only change wording and digest emphasis, never alert priority. Stored like C5 preferences, erased with the account. | — | C5 document, erasure | 10 h | Founder content; DPIA note |

### D. Developer and GIS surface

| ID | Feature | Data / licence | Builds on | Effort | Go-live |
|---|---|---|---|---|---|
| V3-D1 | **OGC API – Features** endpoint for events, detections and outlines, so QGIS and ArcGIS read Fire Watch natively. | Own data, per-source terms | V2-G1 public API | 20 h | V2-Q4 terms |
| V3-D2 | **TypeScript SDK** generated from the OpenAPI document, published to npm, with a typed SSE client. | — | V2-G1, contracts | 12 h | npm org |
| V3-D3 | **Fire Watch MCP server.** Read-only tools (events near a point, event detail, context layers) for AI assistants, with attribution in every result. | Own data | V2-G1, credits registry | 16 h | V2-Q4 terms |
| V3-D4 | **Embeddable map widget** for media and municipalities: iframe + script tag, attribution locked on, per-domain keys. A licensing line in `ANALYSIS.md`'s revenue model. | Own data | web app, API keys (G1) | 24 h | V2-Q3 pricing |
| V3-D5 | **Changelog and status feed** for API consumers (deprecations, incidents), RSS + JSON. | — | J5 status page | 6 h | none |

### E. Post-fire and recovery

| ID | Feature | Data / licence | Builds on | Effort | Go-live |
|---|---|---|---|---|---|
| V3-E1 | **Recovery monitoring.** Monthly NDVI over closed perimeters for 24 months, as a chart and a "recovering / not yet" note. | Sentinel-2 L2A COGs (keyless) | V2-E1 dNBR job, DS-7 COG reader | 24 h | V2-E1 |
| V3-E2 | **Post-fire hazard context.** Burned slope above settlements and roads, as context for erosion and flood risk after rain. Descriptive overlay, no model. | Own perimeters, Copernicus DEM (G3) | G3 local DEM, settlements | 16 h | Founder wording |
| V3-E3 | **Repeat-burn history.** "This area also burned in 2017 and 2021", from the EFFIS archive and our own outlines. | EFFIS BA (keyless) | V2-A5 history | 8 h | V2-A5 |

### F. Drought and long-range context (relayed)

| ID | Feature | Data / licence | Builds on | Effort | Go-live |
|---|---|---|---|---|---|
| V3-F1 | **EDO Combined Drought Indicator layer** (Watch / Warning / Alert), updated three times a month, plus a zone-card line. | JRC EDO WMS/WCS; confirm licence | overlay route, `LayerRegistry` | 10 h | Licence confirmation |
| V3-F2 | **Season-start digest.** One pre-season message per zone: drought level, seasonal outlook (V2-B5) and the C7 checklist. | EDO, CEMS seasonal | digest pass | 8 h | V2-B5, V2-C7 |

### G. Organisations and public sector

| ID | Feature | Data / licence | Builds on | Effort | Go-live |
|---|---|---|---|---|---|
| V3-G1 | **Municipal dashboard.** Events, warnings and season statistics for one or more municipalities; shareable read-only link for the mayor's office. | Own data, MeteoAlarm, EFFIS | V2-G3 org accounts, V2-A5 | 32 h | V2-G3 |
| V3-G2 | **Cross-border picture.** A shared view for a BG–GR / BG–RO / BG–MK border region with both languages side by side; fits Interreg funding. | Own data | V2-H1 coverage, V2-H2 languages | 20 h | V2-H1 |
| V3-G3 | **Asset exposure screening (bulk).** Upload many assets (PV parks, towers, lines); get historical fire proximity and current exposure as a CSV/GeoJSON report. | Own data, EFFIS BA | V2-G3, V2-A5, D2 import | 24 h | V2-Q3 pricing |
| V3-G4 | **Org integrations.** Pre-built webhook payload templates for Teams, Slack and generic CAP-XML. CAP-XML is clearly marked as *not* an official warning. | — | G2 webhooks | 16 h | Founder decision on CAP (V3-Q4) |

### H. Trust and transparency

| ID | Feature | Data / licence | Builds on | Effort | Go-live |
|---|---|---|---|---|---|
| V3-H1 | **Public accuracy and latency page.** Rolling detection-to-alert latency, source availability and false-positive rate, from the monitors we already run. | Own data | QA report, J1, J2 parity/lag | 16 h | Founder sign-off on published numbers |
| V3-H2 | **"Why did / didn't I get an alert" self-service** combining C6 decision-log explanations with source coverage at that time (pass gaps, cloud). | Own data | V2-C6, F15, F17 | 12 h | V2-C6 |
| V3-H3 | **Data provenance per pixel.** Every detection links to its source granule and processing version. | Own data | source_ids, C1 ingest digest (025) | 8 h | none |

### I. Platform

| ID | Feature | Data / licence | Builds on | Effort | Go-live |
|---|---|---|---|---|---|
| V3-I1 | **Multi-region read path.** A second read region for snapshot and SSE, so a regional outage or a mega-fire spike does not take the map down. | — | T2 R2 mirror, E6 failover | 32 h | Second host |
| V3-I2 | **Partitioned detection history** (by month) with archive export, so the history features stay fast after several seasons. | — | Postgres, A1/A5 | 16 h | none |
| V3-I3 | **Per-tenant rate limits and usage metering** for the API, embed and MCP surfaces. | — | rate limiter, V2-G6 billing hooks | 16 h | V2-G6 |

## 4. Excluded and why

| Candidate | Reason |
|---|---|
| Community photo and smoke reports | Needs a moderation desk and liability handling (human operations). Revisit only with a staffed moderation plan. |
| Fire spread or arrival-time forecast | Non-goal. V3-B1 is observed direction only. |
| Official evacuation guidance, routing around fires | Needs official sources; routing implies a safety promise we cannot keep. |
| Native apps | PWA first (V3-C3). Native only if iOS PWA push proves insufficient in the beta. |
| Drone or aircraft integration | Hardware or ops; conflicts with "no own sensors" and "no dispatch tooling". |
| Agricultural-burn auto-labelling | A label that hides a real fire is a safety risk. Kept as founder decision V3-Q3, not as a feature. |
| Training our own detection model on imagery | Becomes a detection model with its own validation burden; out of scope until FireSat data shows a gap the sources do not cover. |

## 5. Recommended v3.0 cut

0. **Wave 0, finish what v3 stands on:** the v1 PWA, I2 polygons, sign-up UI and launch track;
   the open v2 founder decisions; unbuilt v2 waves 2–4 (C1–C3, C6, D2, A3, A5, A6, B2, B4, G1,
   G3, G4, E1).
1. **Wave 1, descriptive depth on own data (~70 h, no accounts):** A6, B1, B2, B3, B4 (templated),
   E3, H3.
2. **Wave 2, next-gen sources (~70 h):** A2 (CDSE), A1 (FireSat, fixtures first so it is ready on
   access day), A3.
3. **Wave 3, personal product (~70 h, needs the PWA and polygons):** C1, C2, C3, C4.
4. **Wave 4, developer and B2B (~130 h, needs G1/G3):** D1, D2, D3, D4, G3, G4, I3.
5. **Wave 5, public sector and scale (~110 h):** G1, G2, H1, H2, I1, I2.
6. **Later or on demand:** A4, A5, C5, D5, E1, E2, F1, F2.

How to build these waves in parallel branches without conflicts (claim table, file ownership,
shared-file rules, reserved migration numbers) is in [`V3-WORKPLAN.md`](V3-WORKPLAN.md).

The strongest differentiators:

- **A1 + A6:** first Balkan service with FireSat detections and a cross-source agreement score.
- **B1–B3:** honest observed behaviour without a prediction model.
- **D1 + D3:** native GIS and AI-assistant access, with attribution enforced.
- **H1:** published accuracy and latency. No competitor reviewed (Watch Duty, ISKRA, EFFIS, FIRMS)
  publishes these.

## 6. Founder decisions this analysis raises

- **V3-Q1:** Whether to show an observed growth direction at all, and its label (B1). It is close to
  the V2-Q1 spread-estimate line.
- **V3-Q2:** Templated event briefs only, or an optional LLM rewrite. The LLM option adds liability
  and a review path (L15).
- **V3-Q3:** Whether an "often agricultural burning here" hint is ever shown. Proposed: never on
  alerts, only as historical context on the event page.
- **V3-Q4:** Whether CAP-XML output is offered at all, given the "not an official warning" rule.
- **V3-Q5:** Which partner to approach for FireSat early access, and under what redistribution
  terms.
- **V3-Q6:** Which accuracy and latency numbers to publish (H1), and the threshold below which the
  page says so plainly.
- **V3-Q7:** Embed and API pricing (D4, G3), as part of the V2-Q3 free/paid line.

## 7. Implementation status

*2026-10-28 — proposal only, nothing built. Items move to `TASKS.md` as a Track V3 when the founder
ticks them.* Parallel-work plan: [`V3-WORKPLAN.md`](V3-WORKPLAN.md).

## Sources

- FireSat timeline: [Heliops — first EFA operational FireSats reach orbit](https://www.heliopsmag.com/airattack/news/first-efa-operational-firesats-reach-orbit/),
  [Let's Data Science — EFA launches operational FireSat satellites](https://letsdatascience.com/news/earth-fire-alliance-launches-operational-firesat-satellites-244abd23).
- Sentinel-3 SLSTR FRP: [ESA — new Sentinel-3 FRP products](https://sentinel.esa.int/web/sentinel/-/new-copernicus-sentinel-3-fire-radiative-power-products-released),
  [EUMETSAT product notice](https://www-cdn.eumetsat.int/files/2021-04/Sentinel-3%20Product%20Notice%20%E2%80%93%20SLSTR%20Level-2%20Near%20Real%20Time%20Fire%20Radiative%20Power_PB2.74_v1.pdf).
- EDO CDI: [JRC data catalogue](https://data.jrc.ec.europa.eu/dataset/afa8a5ee-5473-439a-b062-ffdaedc38b2d),
  [CDI factsheet](https://drought.emergency.copernicus.eu/data/factsheets/factsheet_combinedDroughtIndicator.pdf).
