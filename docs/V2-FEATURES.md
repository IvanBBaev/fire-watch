# Fire Watch v2.0 — software-only feature analysis

Status: proposal, 2026-10-24. Nothing here is committed scope until the founder ticks it into
`TASKS.md`. Wave 1 (§5) is built on `main`, unticked, pending founder decisions — see §7 and
`TASKS.md` Track V2.

## 1. Scope rule

v2.0 contains only features that can be **built entirely in code** in this repository. These are
excluded:

- hardware (cameras, LoRa nodes, an EUMETCast receive station)
- human operations (verified incident status, official evacuation zones, scanner feeds, an aircraft
  registry curated by hand)
- legal or editorial prerequisites that block *building* the feature

A free account or API key that a feature needs **to go live** does not exclude it. That need is
recorded in the "go-live" column, because the code can be built and tested against fixtures before
the account exists. The same is true of v1 today (FIRMS keyed, EUMETSAT, R2).

The non-goals in `ANALYSIS.md` §4 still apply:

- No fire prediction model. Forecasts are relayed from EFFIS or ECMWF and attributed.
- No dispatch or firefighter ops tooling.
- No own sensors.

The one item that is not a model is a **clearly labelled spread estimate**. It is listed below as a
founder decision (V2-Q), not as a planned feature.

## 2. Baseline v2 builds on

v1 already has these pieces, each live, gated or built:

- **Detection and events:** FIRMS ingest; incremental clustering, lifecycle and score v0.
- **Delivery:** snapshot (T1), SSE (T0) and the R2 mirror (T2).
- **Web:** the MapLibre web app (bg/en) with layers, filters, search, permalinks and share card.
- **Accounts and alerts:** magic-link accounts, and point+radius watch zones with encrypted
  centres. The alert engine has an outbox, a sole-sender gateway, a state machine, budgets and
  breaker, a decision log and a digest pass. Channels are email (SES), Telegram and web push.
- **Overlays:** EFFIS FWI and burnt areas, ECMWF wind and cloud, satellite passes and swaths, the
  hot-source mask, and MTG LI lightning (decoder only).
- **Staff:** staff auth, an editorial workflow with two-person approval, and an incident log.

Building blocks that make v2 cheap:

| Block | v2 leverage |
|---|---|
| Overlay route pattern (content ETag, 503-when-stale, `FeedStatus`) + web `LayerRegistry` | A new context layer is one adapter and one registry entry. CI-12/13/14/18 check it automatically. |
| Pure decoders (GRIB2/AEC, SGP4, MTG LI h5wasm, WorldCover COG) | More ECMWF and EUMETSAT products cost almost nothing extra. |
| Snapshot + change projector + stream hub | Base for the public API, webhooks and org feeds. |
| Alert gateway + channel adapters + token buckets | A webhook, SMS or Viber channel is one more adapter. |
| Zone geometry + coarse grid index + keyring | Extends to polygons and multi-polygon org monitoring. |
| Digest pass | Periodic and seasonal summaries. |
| Replay fixtures + `pnpm fit` + constellation replay | Golden scenarios for new sources, regions and detection logic. |
| Typed i18n catalogs + never-send lint + CI-10/11 | A new language is governed by gates that already exist. |
| Export + erasure pipeline | GDPR coverage for every new kind of per-user data. |
| QA report, shadow-diff, parity/lag monitors | The evidence an SLA-backed B2B tier needs. |

**Prerequisite:** v1 items that are not built yet ship before or with v2:

- the PWA / service worker (web push has no client)
- polygon zones and zone editing (I2)
- an alert sign-up UI

v2 features that depend on them say so in the "builds on" column.

## 3. Features by theme

Effort is engineering hours for code, tests and fixtures. It excludes founder copy review.
The go-live column names what has to exist before the feature is useful in production.

### A. Detection and timeline

| ID | Feature | Data / licence | Builds on | Effort | Go-live |
|---|---|---|---|---|---|
| V2-A1 | **Playback / time scrubber.** Replay detections and event growth over the last 24 h to 7 days, with age and FRP styling. | Own detection history (Postgres) | snapshot, `LayerRegistry`, replay format | 24 h | none |
| V2-A2 | **Sensitivity filter.** Hide low-confidence or single-detection points; three presets plus an advanced mode. | Own data | filters (F11), score v0 | 6 h | none |
| V2-A3 | **Geostationary 10-min growth.** Attach FCI FRP (LSA-509) and SEVIRI FRP (LSA-502) to existing events as a growth curve. Attach-only, so no event creation from GEO data (ADR-002). | EUMETSAT LSA SAF, free account | LSA-502 decoder, F10 sparkline | 20 h | EUMETSAT credentials |
| V2-A4 | **Fire perimeters from our own VIIRS detections.** Alpha-shape over the event's footprint, FEDS-style, labelled "estimated outline". | Own data | clustering identity, overlay route | 24 h | none |
| V2-A5 | **History and season statistics.** Map of past seasons; "this season vs the 2012–2025 average" per oblast. | FIRMS SP archive (MAP_KEY); EFFIS BA WFS `modis.ba.poly` (keyless) | DS-1 backfill, Natural Earth oblasts | 20 h | MAP_KEY for the backfill |
| V2-A6 | **Lightning-ignition candidate.** A badge on new events that had lightning nearby in the previous 48 h. | MTG LI, free account | migrations 022/024, F18 | 6 h | EUMETSAT credentials |

### B. Risk and forecast (relayed, never modelled)

| ID | Feature | Data / licence | Builds on | Effort | Go-live |
|---|---|---|---|---|---|
| V2-B1 | **FWI forecast for days 1–9 per zone.** "Danger tomorrow / at the weekend" on the zone card and in the digest. | EFFIS WMS `mf010.fwi` + `TIME` (keyless) | G4 EFFIS proxy, digest pass | 12 h | none |
| V2-B2 | **Fire-weather alert.** Our own threshold on ECMWF data, for example RH < 25 %, gust > 50 km/h and high FWI. It must be labelled as **our threshold**, never as an official warning. | ECMWF Open Data, already ingested | GRIB2 decoder, alert engine | 16 h | Founder copy for the label |
| V2-B3 | **MeteoAlarm panel and layer.** Official CAP warnings for fire-relevant codes (OET-087/095/079) per oblast. | MeteoAlarm Atom (keyless, CC BY 4.0) | overlay route, credits registry | 12 h | none |
| V2-B4 | **Smoke and air quality.** CAMS Europe smoke/PM2.5 forecast layer plus a per-zone smoke alert. | CAMS via ADS (free ECMWF account, CC BY). Open-Meteo AQ stays dev-only because of its commercial terms. | GRIB/netCDF decoders, alert engine | 24 h | ADS account |
| V2-B5 | **Seasonal outlook.** CEMS seasonal fire-danger anomaly as a static monthly layer. | CEMS via EWDS (ECMWF account) | overlay route | 8 h | EWDS account |
| V2-B6 | **"Rain reached the fire".** Accumulated precipitation over active events, as a lifecycle hint only. | GPM IMERG (NASA Earthdata, free) | lifecycle, F10 detail | 12 h | Earthdata account |

### C. Alerts, accounts and the personal product

| ID | Feature | Data / licence | Builds on | Effort | Go-live |
|---|---|---|---|---|---|
| V2-C1 | **Multi-zone, per-hazard alert rules.** Fire / weather / smoke per zone, with an FRP threshold and quiet hours. | — | alert engine, I2 polygons | 20 h | v1 polygon zones |
| V2-C2 | **Critical-alert discipline.** Cap "critical" alerts at about 4 per season per user; every other alert goes to the digest. The decision log explains each downgrade. | — | budgets/breaker, H7 decision log | 10 h | Founder cap value |
| V2-C3 | **Daily and weekly digest** across zones and hazards, using the routing that is currently `null`. | — | digest pass (018) | 10 h | Mailer |
| V2-C4 | **Family / group sharing.** One owner shares zones with up to N members; each member chooses their own channels and gives their own consent. | — | accounts, opt-in policy, erasure | 24 h | none |
| V2-C5 | **Cross-device sync** of zones, layers and preferences. Signed-in state replaces localStorage. | — | accounts, URL state | 8 h | none |
| V2-C6 | **"Explain this alert" route** for the user. Exposes the H7 decision log in plain language. | — | migration 014 | 8 h | Founder copy |
| V2-C7 | **Preparedness checklist.** A static, versioned checklist per zone type (house, village, forest edge) that the user can tick off. | Editorial content, written once | i18n catalogs | 8 h | Founder content |
| V2-C8 | **Viber and SMS channels.** | Viber Bot API; an SMS gateway | channel adapter pattern | 10 h each | Provider accounts (SMS is paid) |

### D. Map tools and data exchange

| ID | Feature | Data / licence | Builds on | Effort | Go-live |
|---|---|---|---|---|---|
| V2-D1 | **Export** of events, detections and perimeters as GeoJSON, KML and CSV, with attribution embedded. | — | snapshot, credits registry | 10 h | none |
| V2-D2 | **KML/GeoJSON import** of a property or plot as a polygon zone. | — | I2 polygons, zone validation | 10 h | v1 polygon zones |
| V2-D3 | **Measure distance and area**, including the distance from a selected place to the nearest active event. | — | MapLibre | 6 h | none |
| V2-D4 | **Server-rendered og:image** with the event footprint, so a shared link shows a preview. | — | share-card SVG (already marked "v2" in code) | 10 h | none |

### E. Post-fire

| ID | Feature | Data / licence | Builds on | Effort | Go-live |
|---|---|---|---|---|---|
| V2-E1 | **Burn severity (dNBR) job** over closed events or EFFIS perimeters. | Sentinel-2 L2A COGs via `sentinel-cogs` STAC (keyless) | COG reader (DS-7), digest | 32 h | none |
| V2-E2 | **Before/after slider** for a closed event. | NASA GIBS true colour (keyless); Sentinel-2 | overlay route | 12 h | none |
| V2-E3 | **Copernicus EMS Rapid Mapping badge** linking events to activations. | CEMS RM JSON (keyless) | F10 detail | 6 h | none |

### F. Exposure context

| ID | Feature | Data / licence | Builds on | Effort | Go-live |
|---|---|---|---|---|---|
| V2-F1 | **Natura 2000 layer** plus "event inside protected area" on the detail view. | EEA Natura 2000 (CC BY 4.0). **Not WDPA**, whose licence forbids commercial or interactive use without permission. | overlay route, static mask pattern | 10 h | none |
| V2-F2 | **Population exposure:** "about N people within 5 km". | GHSL (CC BY 4.0) | COG reader, grid index | 12 h | Founder wording |
| V2-F3 | **Power lines and main roads** as a context layer. | OSM (ODbL) | tile pipeline | 8 h | none |
| V2-F4 | **Land cover under the event** (forest, crop, shrub). The prepared WorldCover grid has no consumer yet. | ESA WorldCover (DS-7, CC BY 4.0) | DS-7 grid | 6 h | none |

### G. B2B surface (`ANALYSIS.md` §4)

| ID | Feature | Data / licence | Builds on | Effort | Go-live |
|---|---|---|---|---|---|
| V2-G1 | **Public REST API v1**, read-only (events, detections, perimeters), with API keys, quotas and a published OpenAPI document. | Own data, redistribution terms per source | snapshot, change projector, rate limiter, contracts | 32 h | Licence review per source |
| V2-G2 | **Webhooks** with signed (HMAC) payloads, retries with backoff and a delivery log. | — | alert gateway as one more channel | 20 h | none |
| V2-G3 | **Org accounts.** Members, roles, multi-polygon monitoring (forestry, PV/wind parks, power lines) and an audit log. | — | staff auth, zone index, audit log | 40 h | none |
| V2-G4 | **SLA alerting** with latency evidence for each org. | — | parity/lag monitors, QA report | 16 h | Founder SLA terms |
| V2-G5 | **Seasonal report** per org or municipality: burned area, dNBR and a timeline, as PDF and GeoJSON. | V2-E1, EFFIS BA | digest, export | 20 h | V2-E1 |
| V2-G6 | **Billing hooks** for paid tiers. Life-safety stays free. | Stripe or similar | accounts | 16 h | CP3 pricing decision |

### H. Regional expansion

| ID | Feature | Data / licence | Builds on | Effort | Go-live |
|---|---|---|---|---|---|
| V2-H1 | **Coverage for GR, MK, RS and RO.** Tiles beyond BG+100 km, gazetteer, boundaries, and `pnpm fit` parameters per region. | Protomaps, GeoNames, Natural Earth | tile pipeline, clustering params | 24 h | Tile hosting size |
| V2-H2 | **UI languages el, ro, sr and mk** (tr optional). | — | typed catalogs, CI-10/11 | 8 h per language for code | Native translator review |

## 4. Excluded and why

| Candidate | Reason |
|---|---|
| Official evacuation zones, verified incident status | Needs operations staff and official sources. BG-ALERT and ГДПБЗН have no machine-readable feed. |
| Scanner audio, fire cameras, Pyronear, LoRa nodes | Hardware or human monitoring; conflicts with the "own sensors" non-goal. |
| Aircraft tracker (ADS-B) | The code is easy, but the aircraft registry and its interpretation need ops. Revisit as a V2-A context layer later. |
| Fire spread model | Non-goal. A labelled heuristic is decision V2-Q below. |
| Native apps | PWA first. Native only if push reliability on iOS PWA proves insufficient. |
| Automatic event splits, GEO-created events | ADR-002 keeps these curated or attach-only until GATE-v2 has evidence. |
| GDACS, NOA FireHub, WDPA, Greek GSCP risk map | Licence-blocked or image-only. Link to them; do not ingest. |
| EUMETCast station | Hardware. |

## 5. Recommended v2.0 cut

Ordered by user value per hour. Waves 1 and 2 need no new accounts.

1. **Wave 1, keyless and personal value (~90 h):** A1, A2, A4, B1, B3, D1, D3, D4, E3, F1, F4.
2. **Wave 2, alerts depth (~80 h, needs the v1 polygon zones and sign-up UI):** C1, C2, C3, C5, C6,
   D2.
3. **Wave 3, accounts we would open anyway (~80 h):** A3, A6 (EUMETSAT), B4 (ADS), A5 (MAP_KEY),
   B2.
4. **Wave 4, B2B (~140 h):** G1, G2, G3, G4, then E1 and G5.
5. **Later or on demand:** B5, B6, C4, C7, C8, E2, F2, F3, G6, H1, H2.

The strongest differentiators against Watch Duty, ISKRA, EFFIS and FIRMS:

- **A3:** GEO 10-min growth on Balkan events.
- **A4:** our own perimeters.
- **B1 + B2:** honest, relayed "danger tomorrow".
- **C2:** alert discipline.

None of the competitors reviewed combine these for the Balkans.

## 6. Founder decisions this analysis raises

- **V2-Q1:** Whether to show a spread estimate at all, and with what label and liability wording.
- **V2-Q2:** The critical-alert cap per season (C2).
- **V2-Q3:** The free/paid line (CP3). Proposed: life-safety alerts, the map and basic zones stay
  free. More zones, groups, history, exports and API go into paid tiers. Watch Duty's reference
  prices are $24.99 and $99.99 per year.
- **V2-Q4:** API redistribution terms per source (FIRMS, EFFIS, CAMS and others), before G1 is
  published.
- **V2-Q5:** Which expansion country goes first (H1). Greece has the highest demand but also local
  competitors.

## 7. Implementation status

*2026-10-24 — wave 1 built on `main` (all gates green locally), every item unticked in `TASKS.md`
Track V2 until its founder decisions land.*

| ID | Merge | Built | Waiting on |
|---|---|---|---|
| D1 | 394544b | GeoJSON / KML / CSV export of the listed events and an event's detections | V2-Q3 (free or paid), copy keys |
| D4 | 394544b | Open Graph meta + rendered og:image card on event permalinks | Pages deploy + `FW_SNAPSHOT_URL`, wasm size, Noto licence note, copy keys |
| A4 | 3e985be | Estimated outlines from VIIRS/MODIS pixel footprints (migration 032), route, map layer, area | Hull parameters and limits, styling, 8 copy keys, V2-Q1 wording |
| F1 | a12902f | Natura 2000 proximity note on the event detail | 10 copy keys, grid, credit placement, refresh cadence, MK/RS/TR coverage |
| F4 | a12902f | ESA WorldCover land-cover note | Unbudgeted 165 kB on-demand asset, copy keys |
| A1 | 8315aa6 | Playback scrubber 24 h / 3 d / 7 d, `pb=` permalink, lazy replay layer | 21 copy keys; only FIRMS detections are replayed |
| B1 | 56c3dcc | Relayed FWI forecast | Model mix, GWIS credit wording, 120 lookups/h limit |
| B3 | 56c3dcc | MeteoAlarm forest-fire and heat warnings for BG + neighbours | Heat warnings in or out, colours, BG OET codes unverified, Turkey feed 404, 13 copy keys, staleness 15 min / 1 h; fixtures synthetic, cache in memory, no map drawing |
| A2 | 171cf4c | Sensitivity filter with presets | Preset values and copy |
| D3 | 171cf4c | Distance / area measure tool | 17 copy keys |
| E3 | 171cf4c | Copernicus EMS activation badge | `CEMS_MATCH` 5/15 km and −3/+14 days, 730-day retention, hourly poll, credit wording; EMSR fixture synthetic, CEMS API undocumented |

CI-12: the first-load `criticalPath` is 360,767 B against 358,400 B after wave 1 and is recorded in
`KNOWN_OVER_BUDGET` — closing it needs a founder call (trim credit provenance, split the bg
catalog's on-demand strings, or lazy-load the Layers panel body).

