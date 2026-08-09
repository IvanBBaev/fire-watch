# Review 09 — Legal & Licensing

*Role: senior technology lawyer / legal-regulatory analyst (EU digital law, open-data licensing,
Bulgarian law). Scope: legal & licensing review of `docs/ANALYSIS.md`, informed by
`docs/reviews/00-summary.md` and `docs/reviews/05-security.md` (privacy sections referenced, not
duplicated). Status: pre-code.*
*Date: 2026-07-22.*

> **This document is practical, engineering-facing guidance — it is NOT formal legal advice and
> does not create a lawyer–client relationship.** It is a structured map of the legal terrain with
> verified sources, written so that a real Bulgarian lawyer can review it efficiently before v1.
> Items that genuinely require counsel are collected in §10 and marked ⚖ throughout.

---

## 1. Summary verdict

**Conditional GO — nothing blocks the MVP (free map, no accounts).** The core data stack is
unusually clean: NASA, EUMETSAT (incl. LSA SAF), Copernicus/EFFIS/GWIS and the OSM tile chain are
all free for commercial use, redistribution and derived products, subject only to attribution —
verified against the current primary licence texts (§2). The analysis' claim that "the barrier to
entry is engineering, not data licensing" **holds**, with two exceptions:

1. **EOX Sentinel-2 cloudless is NOT usable**: the current layers are CC BY-NC-SA 4.0
   (non-commercial) and commercial use requires a paid EOX licence. Drop it or budget for it.
2. **Esri World Imagery is usable only through an ArcGIS Location Platform account** under Esri's
   terms (free tier exists, commercial use allowed, metered) — never via the bare legacy REST
   endpoint.

The real legal gates are staged, mirroring the security review's structure:

- **[GATE-MVP]** — ship the attribution block (§2.4) with the first public map; make the
  EOX/Esri imagery-toggle decision; clear the product name before investing in the brand (§7);
  publish a privacy policy + the layered disclaimer skeleton (free stage).
- **[GATE-v1]** (accounts, alerts, paid membership) — operate through an ЕООД; consumer-grade
  ToS with liability architecture (§3.4); GDPR delta items (§5) on top of security review §5.3;
  VAT posture decided (§6.3); withdrawal-right mechanics for paid digital services (§4.7).
- **[GATE-v2]** (B2B, API, webhooks) — SLA drafted as process-promises (§3.5); B2B contract
  liability caps; Data Act switching clauses check (§4.5); re-verify EUMETSAT terms for raw
  FCI-derived redistribution via API (they currently permit it — §2.2.B — but pin the version).
- **Crowdsourced reports** (whichever release ships them) — DSA hosting-service mechanics,
  content licence clause, moderation duties (§8) — this is a *legal* gate in addition to the
  security review's §5.2.5 gate.

Top three legal risks, ranked (full register in §9): (1) charging consumers without the
entity/ToS/consumer-law scaffolding in place; (2) liability exposure from a false or missed
alert where our *conduct* (not our disclaimer) is the deciding evidence; (3) shipping the EOX
NC-licensed imagery (or unlicensed Esri) inside a commercial product — the only genuine
copyright-infringement trap in the stack.

---

## 2. Data licensing matrix (core deliverable)

Question set per source: (a) can we **display**; (b) can we **redistribute derived FireEvents
commercially** (our clustered events via map, alerts, paid API); (c) required **attribution**;
(d) **risk**.

### 2.1 The matrix

| # | Source | Licence (verified) | (a) Display | (b) Derived FireEvents, commercial | (c) Attribution required | (d) Risk |
|---|--------|--------------------|-------------|-----------------------------------|--------------------------|----------|
| 1 | NASA FIRMS / LANCE (VIIRS, MODIS NRT) | **CC0** (NASA-led mission data) + no-NASA-endorsement rule; LANCE "as is" disclaimer requested on redistribution | Yes | **Yes** — no restriction on commercial use or derived products | FIRMS/LANCE acknowledgement + LANCE disclaimer replicated/linked (§2.2.A) | **Low** (verified) |
| 2 | EUMETSAT data — MTG FCI products | Data Policy (am. 27 Jun 2024): **Core Data = CC BY 4.0**, redistribution allowed (Art. 6.1); caution: L1 data with <1 h latency is "Recommended" tier, redistribution of its original numericals prohibited (Art. 6.2) | Yes | **Yes** for Core (incl. all SAF products, Art. 20) | Art. 6.3 pattern: "[Contains modified] EUMETSAT [data/product] [Year]" (§2.2.B) | **Low** (verified) — verify tier of any direct FCI L1/L2 feed |
| 3 | LSA SAF FRP-PIXEL (LSA-509) | **CC BY 4.0** by EUMETSAT (all SAF products = "Core"); free registration for data access; LSA-509 is **Demonstration status** (no continuity guarantee) | Yes | **Yes** | "EUMETSAT LSA SAF [product, id]" / "Data source: EUMETSAT LSA SAF, FRP-PIXEL (LSA-509)" (§2.2.C) | **Low** (verified); operational-continuity caveat, not legal |
| 4 | Copernicus Sentinel data (CDSE; Sentinel-2/3) | EU-law legal notice (Reg. 377/2014 + Del. Reg. 1159/2013): free, full, open — reproduction, distribution, communication to the public, adaptation, **any combination** | Yes | **Yes** — expressly incl. adaptation + redistribution; no field-of-use limits | "Contains modified Copernicus Sentinel data [Year]" (§2.2.D) | **Low** |
| 5 | EFFIS (fire danger WMS, burnt areas) | **CC BY 4.0** for EU-owned content (EFFIS Data License page) | Yes | **Yes** | "© European Union, Copernicus Emergency Management Service / EFFIS" + CC BY 4.0 conditions (§2.2.E) | **Low** |
| 6 | GWIS | **CC BY 4.0** (GWIS Data License page) | Yes | **Yes** | Same pattern as EFFIS | **Low** |
| 7 | OpenStreetMap data (any OSM-derived tiles; nearest-settlement geocoding) | **ODbL 1.0**; rendered tiles = "produced work"; OSMF Attribution + Geocoding guidelines | Yes | **Yes** — FireEvents are our data; OSM-derived labels are insubstantial extracts (§2.2.F) | "© OpenStreetMap contributors" → osm.org/copyright — **mandatory, visible on map** | **Low** (with attribution discipline) |
| 8 | OpenFreeMap (hosted vector tiles) | Free incl. commercial; no keys/limits; software MIT; data = OSM/OpenMapTiles | Yes | n/a (basemap only) | "OpenFreeMap © OpenMapTiles Data from OpenStreetMap" (OpenFreeMap part optional) | **Low** legal; availability risk is an SRE topic (no SLA) |
| 9 | Protomaps daily builds (self-hosted PMTiles) | Builds "free without restriction"; tileset = ODbL **produced work** of OSM; styles/code BSD/MIT-family | Yes | n/a (basemap only) | "© OpenStreetMap" visible; Protomaps credit *requested*, not required | **Low** |
| 10 | Terrarium DEM (Mapzen/Tilezen terrain tiles, AWS Open Data) | Mixed-source DEM; attribution per joerd `attribution.md` (EU-DEM, USGS, NOAA et al.) | Yes | n/a (terrain only) | Composite terrain credit; EU-DEM sentence for Europe (§2.2.G) | **Low-Med** (attribution hygiene only) |
| 11 | Esri World Imagery (optional toggle) | Esri Terms via ArcGIS Location Platform; free tier (metered) permits commercial apps; **not** an open licence | Yes, **only** via ALP account + basemap services | n/a (imagery only); no scraping/deriving from imagery | Esri auto-attribution ("© Esri, Maxar, Earthstar Geographics…") — do not remove | **Medium** (ToS + metering; contract, not licence) |
| 12 | Sentinel-2 cloudless by EOX (optional toggle) | 2016/2017 layers **CC BY 4.0**; all 2018+ layers **CC BY-NC-SA 4.0**; commercial use of 2018+ requires paid "EOX Commercial Attribution-RestrictedUse 1.2" licence | 2016/2017: yes; 2018+: non-commercial only | **No** for 2018+ (without paid licence) | "EOxCloudless https://cloudless.eox.at by EOX IT Services GmbH (Contains modified Copernicus Sentinel data [year])" | **High if 2018+ used** → avoid, use 2016/2017, or license |

**Bottom line for the product thesis:** every *fire-data* source (rows 1–6) permits commercial
derived products. Our FireEvents are original derived works we own; upstream licences require
only attribution (and, for NASA NRT, the as-is disclaimer). The only paywalls/traps are in the
optional *imagery* layer (rows 11–12), which is cosmetic, not core.

### 2.2 Per-source detail (verified sources)

#### A. NASA FIRMS / LANCE — Low risk

- Verified from NASA's data-use guidance (verbatim): *"Unless the content is marked with a use
  restriction or license, data provided from a NASA-led mission are licensed as Creative
  Commons Zero (CC0)."* — i.e., effectively public domain; the only standing condition is
  *"NASA material may not be used to suggest or imply endorsement by NASA."* The FIRMS MAP_KEY
  and rate limit (5,000 transactions per 10-minute interval) are technical quota, not a licence
  condition restricting reuse.
- **Requested citation (verbatim, from the official FIRMS page):** *"We acknowledge the use of
  data and/or imagery from NASA's Fire Information for Resource Management System (FIRMS), part
  of NASA's Land, Atmosphere Near real-time Capability for Earth observations (LANCE) and NASA's
  Earth Science Data and Information System (ESDIS)."*
- **Redistribution condition:** when providing FIRMS/LANCE data or imagery to third parties
  (which our map and alerts do), NASA asks that the LANCE **disclaimer be replicated or linked**
  — operative content (verbatim excerpts): data *"are provided 'as is' and users bear all
  responsibility and liability for their use"*, and — critically for us — *"Due to the spatial
  resolution and other characteristics of these data, their use for tactical decision-making or
  informing about conditions at a local scale are not advised."* Put it on the
  attribution/about page and link it from alert footers, and mirror the
  "not-for-tactical-decisions" language in our own ToS/disclaimer (§3.4). This dovetails with
  our honest-freshness UX; it is also *useful* to us as liability posture (§3).
- Do not use NASA logos or imply NASA endorsement of the product.
- Sources: https://www.earthdata.nasa.gov/data/tools/firms ·
  https://firms.modaps.eosdis.nasa.gov · https://www.earthdata.nasa.gov/data/tools/firms/faq

#### B. EUMETSAT data policy (MTG FCI) — Low risk, with one tier caveat

- The EUMETSAT Data Policy (last amended 27 June 2024; verified verbatim from the canonical
  PDF): Art. 5.1 — *"Access to Core Data and Products is granted to all users world-wide on a
  Free and Unrestricted basis under a CC-BY-4.0 licence"*; Art. 6.1 — *"Users may redistribute
  all Core Data and Products."* This resolves the ANALYSIS.md open flag ("re-verify EUMETSAT
  redistribution terms"): redistribution of FCI-derived events, including via a commercial API,
  is permitted under CC BY 4.0 attribution.
- **Tier caveat:** Art. 4 puts Level-1 data with latency **< 1 h** in the "Recommended" tier
  ("may be subject to fees"), and Art. 6.2 *prohibits* redistribution of "the original
  numerical data of Recommended Data". All SAF products, however, are expressly "Core"
  (Art. 20). Practical rule: ingest fire products via **LSA SAF (Core, CC BY)**, and if we ever
  ingest raw near-real-time FCI L1c directly, re-check its tier first. ⚖ Re-verify at
  [GATE-v2] and pin the policy version in the ADR.
- **Attribution pattern (Art. 6.3, verbatim):** *"[Contains modified] EUMETSAT
  [Meteosat/Metop] [data/product] [Year of publication or distribution]"*, adapted as
  appropriate.
- Sources: https://www.eumetsat.int/legal-framework/data-policy ·
  https://www-cdn.eumetsat.int/files/2024-07/45173%20-%20Data%20Policy(1419774%20V1).pdf

#### C. LSA SAF (FRP-PIXEL, LSA-509) — Low risk

- LSA SAF products are **licensed CC BY 4.0 by EUMETSAT** (verified from the LSA SAF
  data-access pages; reinforced by Data Policy Art. 20: *"All SAF products are categorised as
  'Core' products"* → redistributable per Art. 6.1). Access to the archive/data service
  requires free registration — an access mechanism, not a use restriction.
- **Current attribution formats (verified):** figures/maps: *"EUMETSAT LSA SAF [Product
  Acronym, Product Identifier]"*; text: *"Data source: EUMETSAT LSA SAF, [product],
  [acronym]"*. The older "…provided by the EUMETSAT Satellite Application Facility on Land
  Surface Analysis (LSA SAF; Trigo et al., 2011)" sentence appears to be legacy — keep the
  Trigo et al. 2011 reference (doi:10.1080/01431161003743199) only for scientific publications.
  The short UI credit "EUMETSAT LSA SAF" suffices on the map corner.
- **Product-status caveat (operational, not legal):** MTG "FRP-Pixel" LSA-509 is currently
  **Demonstration** status (no continuity/quality guarantee); the MSG-based LSA-502 is
  Operational. Alerts should not depend on LSA-509 alone — aligns with the geodata review.
- Sources: https://lsa-saf.eumetsat.int/en/data/data-access/ ·
  https://lsa-saf.eumetsat.int/en/data/products/fire-products/

#### D. Copernicus Sentinel data / CDSE — Low risk

- The legal notice (verbatim, verified from the Commission PDF): users have *"free, full and
  open access to Copernicus Sentinel Data and Service Information without any express or implied
  warranty"*, for *"(a) reproduction; (b) distribution; (c) communication to the public;
  (d) adaptation, modification and combination with other data and information; (e) any
  combination of points (a) to (d)"* — in so far as lawful. That is the entire field of use we
  need, commercial use included. Legal basis: Regulation (EU) No 377/2014 and Commission
  Delegated Regulation (EU) No 1159/2013 (Arts. 7–9).
- **Required notices (verbatim):** unmodified: *'Copernicus Sentinel data [Year]'*; modified
  (our case — clustering/derived events/rendered composites): *'Contains modified Copernicus
  Sentinel data [Year]'*; for service outputs (EFFIS layers): *'Contains modified Copernicus
  Service information [Year]'*.
- Note the notice's reciprocal waiver: by using the data we renounce damage claims against the
  EU/providers — i.e., upstream outages are *our* problem contractually (feeds the force-majeure
  clause, §3.4).
- CDSE platform T&C add operational quotas and prohibit reselling *portal content* as such —
  they do not restrict reuse of the Sentinel data itself, which the legal notice governs.
  Commercial-scale processing tiers exist if free quotas are outgrown.
- Sources: https://sentinels.copernicus.eu/documents/247904/690755/Sentinel_Data_Legal_Notice ·
  https://dataspace.copernicus.eu/terms-and-conditions

#### E. EFFIS & GWIS — Low risk

- Both publish an explicit **Data License page: EU-owned content under CC BY 4.0** — reuse
  (incl. commercial) allowed with credit and indication of changes. Third-party content embedded
  in the sites can carry other rights — we only consume the EU-produced layers (FWI danger
  forecast, burnt areas), which are EU-owned service outputs.
- **No canonical attribution string is published** — the requirement is generic CC BY
  "appropriate credit" to the EU. Recommended form (ours, not mandated): *"© European Union,
  [year], European Forest Fire Information System (EFFIS)"* (respectively GWIS).
- ⚖ Unresolved nuance flagged by research: the fire-danger forecast layers are computed from
  ECMWF/Météo-France meteorological inputs whose underlying rights the EFFIS licence page does
  not address. For *display* of the EU-published layer this is EFFIS's problem, not ours; if we
  ever redistribute the raw danger rasters via API, ask EFFIS in writing first.
- Because EFFIS is a Copernicus service, pair the CC BY credit with the Copernicus service
  notice: *"Contains modified Copernicus Service information [Year]"*.
- The WMS endpoints are operational services without SLA — usage etiquette (server-side cached
  proxy, per SRE review) is an operational courtesy; no separate legal registration exists.
- Sources: https://forest-fire.emergency.copernicus.eu/about-effis/data-license ·
  https://gwis.jrc.ec.europa.eu/about-gwis/data-license

#### F. OpenStreetMap (ODbL) — Low risk, two rules to respect

- **Rendered basemap tiles are a "produced work"** — publicly using them requires attribution
  but does **not** put share-alike on our FireEvents database. Our fire data never mixes with
  OSM geometry into one database; keep it that way (separate tables/provenance already in the
  architecture).
- **Attribution (OSMF Attribution Guidelines, verified):** text attribution to OpenStreetMap
  (canonical: **"© OpenStreetMap contributors"**), linked to
  https://www.openstreetmap.org/copyright, "typically… in a corner of the map"; it may collapse
  after ~5 s or on interaction **only if** the licence info stays reachable, e.g. via an "(i)"
  button. Same rules for the PWA.
- **Geocoding ("nearest settlement" enrichment):** per the OSMF Geocoding Guideline, individual
  geocoding results are insubstantial extracts; stored results *"may be stored and used together
  with other proprietary or third party data without having a share-alike impact"*, **unless**
  aggregation amounts to *"a systematic attempt to aggregate all or substantially all Primary
  Features of a given type within a geographic area city-sized or larger"* (reconstructing OSM).
  Storing one settlement name per FireEvent (10²–10³/day) is squarely on the safe side.
  Obligation that *does* apply: attribute OSM when the geocoder is publicly used → the
  settlement labels shown in UI/alerts are covered by the map's OSM attribution + About page.
- **Collective-database hygiene (engineering rule):** per the OSMF Collective Database
  Guideline, our fire DB and OSM stay a mere *collective* database (no share-alike leak onto
  FireEvents) if, per data type, content is "either all OSM or all non-OSM" and the datasets
  "do not reference each other" by database keys. Concretely: **never store OSM element IDs
  inside fire-event records** — store the settlement *name/coords* string only. Similarly, the
  Horizontal Map Layers Guideline confirms a fire overlay on an OSM basemap is not infected.
- Sources: https://osmfoundation.org/wiki/Licence/Attribution_Guidelines ·
  https://osmfoundation.org/wiki/Licence/Community_Guidelines/Geocoding_-_Guideline ·
  https://osmfoundation.org/wiki/Licence/Community_Guidelines/Collective_Database_Guideline_Guideline ·
  https://osmfoundation.org/wiki/Licence/Community_Guidelines/Horizontal_Map_Layers_-_Guideline ·
  https://opendatacommons.org/licenses/odbl/1-0/

#### G. OpenFreeMap, Protomaps, Terrarium — Low risk

- **OpenFreeMap** (verified from site): *"There's no registration, no user database, no API
  keys"*; no limits on map views; commercial use allowed; **"Attribution is required"** — the
  stated string is *"OpenFreeMap © OpenMapTiles Data from OpenStreetMap"* with the OpenFreeMap
  part optional. No SLA is offered — a business-continuity, not legal, concern (matches ADR-001's
  plan to self-host). Source: https://openfreemap.org
- **Protomaps**: the daily planet builds are *"free without restriction"*; the tileset is an
  **ODbL produced work of OSM**, so *"web maps and native apps that use this Produced Work must
  visibly attribute © OpenStreetMap"*; Protomaps project credit is requested, optional. (The
  hosted api.protomaps.com would require sponsorship for commercial use — we self-host, so
  n/a.) Sources: https://github.com/protomaps/basemaps/blob/main/LICENSE_DATA.md ·
  https://docs.protomaps.com/basemaps/downloads
- **Terrarium terrain tiles** (AWS Open Data, tilezen/joerd): the tiles mash up public DEMs;
  the project's `attribution.md` lists required credits per source. For our AOI the operative
  one is **EU-DEM**: *"Produced using Copernicus data and information funded by the European
  Union - EU-DEM layers"*; plus U.S. sources *"courtesy of the U.S. Geological Survey"* and NOAA
  ETOPO1. Practice: short "Terrain: Mapzen/Tilezen & sources" credit in the map corner linking
  to the full list on the attribution page. Sources:
  https://github.com/tilezen/joerd/blob/master/docs/attribution.md ·
  https://registry.opendata.aws/terrain-tiles/

#### H. Esri World Imagery — Medium risk (contract terms, not open licence)

- World Imagery is **not open data**. Lawful paths: (1) **ArcGIS Location Platform** account —
  the free tier is genuinely usable in commercial apps (Esri: unlimited commercial public apps;
  metered free allotments, e.g. ~2M basemap tiles/month) via the basemap services, incl. from
  MapLibre (Esri ships a MapLibre plugin that renders the **required Esri/data-provider
  attribution automatically**); (2) paid subscription beyond metering. **Not lawful:** pointing
  MapLibre at the legacy `World_Imagery/MapServer` tile endpoint without an ArcGIS
  account/agreement — widespread practice, still a ToS violation, and the imagery is
  third-party-licensed (Maxar et al.), so infringement exposure is real.
- **No caching/redistribution** (Master Agreement E204, verified): §3.2.a — Data may be used
  only "with the Products for which Esri has provided the Data" (no anonymous hotlinking);
  §3.2.c — offline use only via Esri Content Packages; *"Customer may not otherwise scrape,
  download, or store Data."* Engineering consequence: **exclude Esri imagery tiles from the
  PWA service-worker cache and never proxy/pre-cache them server-side.** Also §3.3.h: no AI/ML
  training on the Data. Attribution "Powered by Esri" + data-provider credits (currently
  "Esri, Vantor, Earthstar Geographics, and the GIS User Community") is contractually required;
  the MapLibre ArcGIS plugin injects it automatically.
- Metering reality-check: free tier = 2M basemap tiles/month, then $0.15/1,000 (or the
  session-based model at 1K free sessions). A popular free fire map in season can exceed this
  — a cost gate, not just a legal one.
- Verdict: usable at MVP as a toggle **iff** through ALP with keys + auto-attribution + cache
  exclusion; budget metering. Decide vs. simply not shipping a satellite toggle at MVP.
  **[GATE-MVP]** decision.
- Sources: https://www.esri.com/content/dam/esrisites/en-us/media/legal/ma-full/ma-full.pdf ·
  https://location.arcgis.com/faq/ · https://location.arcgis.com/pricing/ ·
  https://developers.arcgis.com/documentation/esri-and-data-attribution/ ·
  https://developers.arcgis.com/maplibre-gl-js/

#### I. Sentinel-2 cloudless by EOX — High risk if used; avoid or license

- Verified from EOX's licence page: non-commercial use (academia, education, NGOs, personal)
  under **CC BY-NC-SA 4.0**; **commercial use requires an "EOX Commercial
  Attribution-RestrictedUse 1.2 License"** obtained from EOX IT Services GmbH.
- A freemium product with paid memberships/B2B is commercial use — even the "free stage" is
  commercial in trajectory and would be an aggressive NC reading. **Do not ship** these layers
  without an EOX contract. If ever licensed, the required attribution (verbatim):
  *"EOxCloudless https://cloudless.eox.at by EOX IT Services GmbH (Contains modified Copernicus
  Sentinel data [year])"*, clearly visible wherever displayed; no implying EC/ESA endorsement.
- Alternative for a satellite look: Esri path (§2.2.H) or rendering our own Sentinel-2 mosaics
  from CDSE (licence-clean per §2.2.D, engineering cost).
- Source: https://cloudless.eox.at/documentation/license (via https://s2maps.eu redirect)

### 2.3 Rules of engagement (engineering-facing)

1. **Attribution is the licence fee.** One missed line is breach of CC BY/ODbL — cheap to fix,
   embarrassing to be caught. Treat the attribution block as config-in-git with a QA check
   (style-lint already gates colors; add an attribution presence test). **[GATE-MVP]**
2. **Keep provenance per detection** (already in the architecture) — it is also the licensing
   audit trail proving which source fed which event.
3. **"Indicate changes"** (CC BY 4.0 §3(a)(1)(B)) — our About page states that detections are
   clustered/filtered/derived by us; that sentence satisfies the modification-indication duty
   for CC-BY sources and doubles as liability hygiene ("we transform, we don't parrot").
4. **Never imply endorsement** by NASA, EUMETSAT, the EU/Copernicus, ESA, Esri or OSM — CC BY
   4.0 §2(a)(6) and the NASA/EOX terms all prohibit it; it is also the §7 naming rule.
5. **Pin licence versions**: copy each licence/notice text + date into `docs/licenses/` at
   integration time; re-check before [GATE-v2] (API exposes derived data downstream — our API
   ToS must pass through the upstream attribution duties to API consumers).

### 2.4 The attribution block the UI must show — [GATE-MVP]

**Map corner (compact, always reachable via "(i)" if collapsed):**

```
© OpenStreetMap contributors | © OpenMapTiles | Fire data: NASA FIRMS · EUMETSAT LSA SAF |
Contains modified Copernicus Sentinel data & Service information 2026 | Terrain: Tilezen/Mapzen
```

(With Esri toggle active, Esri's plugin-injected line is additionally shown:
`Powered by Esri | © Esri, Maxar, Earthstar Geographics, and the GIS User Community`.)

**Full attribution page (linked from the "(i)" control, footer, and alert footers):**

```
Basemap: © OpenStreetMap contributors (ODbL) — openstreetmap.org/copyright.
Tiles served by OpenFreeMap (© OpenMapTiles) / self-hosted Protomaps build.

Active fire detections: We acknowledge the use of data and/or imagery from NASA's Fire
Information for Resource Management System (FIRMS), part of NASA's Land, Atmosphere Near
real-time Capability for Earth observations (LANCE) and NASA's Earth Science Data and
Information System (ESDIS). NRT data are provided "as is"; see NASA LANCE disclaimer.

Geostationary fire data: Data source: EUMETSAT LSA SAF, FRP-PIXEL (LSA-509 / LSA-502).
Contains modified EUMETSAT data 2026. © EUMETSAT, CC BY 4.0.

Fire danger and burnt areas: © European Union, Copernicus Emergency Management Service —
EFFIS (CC BY 4.0). Contains modified Copernicus Service information 2026.
Contains modified Copernicus Sentinel data 2026.

Terrain: Terrarium tiles by Tilezen/Mapzen (AWS Open Data). DEM sources include EU-DEM
(produced using Copernicus data and information funded by the European Union), data courtesy
of the U.S. Geological Survey, and U.S. NOAA (ETOPO1).

Fire events shown on this map are derived by [Product] from the sources above (clustering,
filtering, enrichment). Errors and omissions are ours, not the data providers'.
```

The final sentence is deliberate: it satisfies "indicate changes", honestly assigns derivation
to us, and prevents any claim that we misattribute our output to NASA/EU as official product.

---

## 3. Liability for wrong, missed or late fire information

### 3.1 The applicable framework (there is no single "EU tort law")

Liability for bad information is governed by **national** law; for us that means Bulgarian law
plus EU consumer/product acquis layered on top:

- **Delict (free tier, non-users, bystanders):** ЗЗД чл. 45 — general tort: damage + unlawful
  conduct + causation + fault, with **fault presumed** ("вината се предполага до доказване на
  противното"); чл. 49 — the principal is liable for damage caused by persons it engaged
  ("при или по повод" the work) — strict vicarious liability that will attach to the ЕООД for
  anything the founder or contractors do. Source: https://lex.bg/laws/ldoc/2121934337
- **Contract (paid B2C/B2B):** non-performance under ЗЗД чл. 79 ff., and for consumers the
  digital-services conformity regime — **ЗПЦСЦУПС** (ДВ бр. 23/2021, transposing Directive
  (EU) 2019/770): applies to digital services supplied **for a price or for personal data**;
  чл. 3 voids terms detrimental to the consumer; чл. 10–11 impose subjective + objective
  conformity **including security updates and conformity throughout a continuous supply
  period**; чл. 17 gives the remedy ladder (bring into conformity → price reduction →
  termination); burden of proof sits on the trader for the whole continuous-supply period.
  A paid alert subscription that silently stops delivering alerts is a *conformity defect* —
  no disclaimer removes those statutory remedies.
- **Product liability:** see §3.2.

Key analytical point: for **pure information** provided free to the public, the weak link in a
чл. 45 claim is *unlawfulness* — publishing satellite-derived fire information in good faith,
with honest freshness/uncertainty labelling and clear "not an official warning" framing, is
not unlawful conduct. The calculus shifts when we **assume a duty**: "we monitor *your* zone
and *will* alert you" is an undertaking; failing it is measured against the professional-care
standard (ТЗ чл. 302 for merchants). That is why the staged model matters legally: the free
map is low-exposure; configured paid alerts are where the duty (and the drafting in §3.4)
lives.

### 3.2 The Winter v. Putnam question, EU edition

US doctrine (Winter v. G.P. Putnam's Sons, 9th Cir. 1991) refuses strict products liability
for the *informational content* of publications — with the famous aeronautical-chart
counter-line (Aetna v. Jeppesen; Brocklesby) where navigational charts were treated as
defective *products* because users stake their lives on their operational accuracy. The EU has
now codified essentially the same line in the **new Product Liability Directive (EU)
2024/2853** (verified):

- Software **is a product** (Art. 4(1)), explicitly including SaaS-style supply (Recital 13);
  **but** — verbatim from Recital 13 — *"Information is not, however, to be considered a
  product"*: source code, and by extension the informational content of a map or alert text,
  is outside.
- Applies to products placed on the market **after 9 December 2026** (Art. 2(1)); defectiveness
  is assessed *inter alia* against cybersecurity and update behaviour; non-commercial FOSS is
  excluded.
- Practical translation for us: a **pipeline/software defect** (e.g. a geofence-matching bug
  that provably caused personal injury or property damage) can ground strict-liability claims
  under the transposed PLD for versions shipped after Dec 2026 — no fault needed, no
  contractual cap effective. **Wrong upstream data faithfully processed** is bad *information*,
  not a defective product — the Winter side of the line. Our engineering QA (the alert
  correctness test-suite from the QA review) is therefore also a liability-defence artifact:
  keep the test evidence. Source:
  https://eur-lex.europa.eu/legal-content/EN/TXT/?uri=CELEX%3A32024L2853

The aeronautical-chart analogy is also the right *warning label* for product positioning: the
closer our UX inches toward "rely on this operationally" (the chart), the closer courts get to
treating failures harshly. "Complements official channels, never replaces 112/BG-ALERT, never
says all-clear" is not marketing modesty — it is the load-bearing wall of the liability
posture. It must appear in onboarding, alert footers, and the map UI, not only in the ToS.

### 3.3 Does charging money change the exposure? Yes — three ways

1. **Adds a contract channel**: a paying user need not prove delictual unlawfulness; they
   point to non-conformity (ЗПЦСЦУПС) or non-performance. Remedies are mostly refund-scale,
   but consequential-damage claims under general contract law remain possible.
2. **Triggers consumer-protection scrutiny of the ToS**: ToS are non-negotiated general terms;
   under ЗЗП чл. 143/146 unfair clauses are **void** (чл. 146(1)), with the trader bearing the
   burden of showing individual negotiation. Aggressive liability waivers don't just fail —
   they can poison adjacent clauses and attract КЗП attention.
3. **Raises the standard of care**: a merchant's care (грижа на добрия търговец) plus the
   implicit representation that a paid monitoring service is fit for its stated purpose.

What does **not** change: charging does not make us an emergency service, does not create a
guarantee of detection (physics: §2's satellite latencies are documented upstream limits), and
does not remove the effect of honest, prominent disclaimers on the *scope of the duty
undertaken* — courts read the deal as defined, including its stated limits, as long as the
limits are transparent, fair and mirrored in the UX rather than buried.

### 3.4 What disclaimers can and cannot do (drafting guidance) — [GATE-v1]

Hard limits (all verified against current texts):

- **ЗЗД чл. 94** (verbatim): *"Недействителни са уговорките, с които предварително се изключва
  или ограничава отговорността на длъжника за умисъл или за груба небрежност."* — No advance
  exclusion/limitation for intent or gross negligence. **Applies B2B too.**
- **ЗЗП чл. 143, ал. 2, т. 1–2**: clauses excluding/limiting liability for **death or personal
  injury**, or excluding statutory rights on non-performance, are per-se unfair → void
  (чл. 146(1)). A wildfire product must assume personal-injury claims can never be waived B2C.
- **ЗПЦСЦУПС чл. 3**: any term derogating from the consumer's statutory remedies is void.

What remains available — and is worth real drafting effort:

1. **Scope-of-service definition** (the strongest tool): the service *is* "best-effort
   informational monitoring based on public satellite data with inherent latency and detection
   limits"; it is *not* a life-safety, emergency-notification or all-clear service. Defining
   the duty narrowly is not an exclusion clause and is not caught by чл. 94/чл. 143.
2. **No-warranty / "as is" for data accuracy** — effective as expectation-setting; pair with
   the mirrored upstream language (NASA's "not advised for tactical decision-making", §2.2.A;
   EUMETSAT's no-warranty Art. 8.2; the Copernicus notice's own warranty disclaimer).
3. **Liability cap for ordinary negligence**: B2B — cap at fees paid in the last 12 months +
   exclusion of indirect/consequential damages (standard, enforceable within чл. 94 limits).
   B2C — a cap is defensible for *property/financial* damage if proportionate and transparent,
   but expect it to be tested; never applied to death/injury.
4. **Force majeure** naming the real upstream risks: satellite/instrument failure or
   data-service outage (NASA LANCE, EUMETSAT/LSA SAF, CDSE — note we have *renounced damage
   claims against the EU* under the Sentinel notice, §2.2.D, so we cannot pass those losses
   upstream), cloud/CDN outage, mobile-push platform failures (FCM/APNs), Telegram outages,
   and state emergency measures during declared disasters.
5. **Layered presentation** (adopting security review §5.7): short in-UX statements at the
   moment of reliance (map header line, alert footer, onboarding interstitial for alert
   setup) + full ToS. In unfair-terms litigation, the UX layer is what makes the ToS layer
   credible.

Anti-pattern to avoid: a blanket "we accept no liability whatsoever" clause — void, and its
voidness is evidence of bad faith in the чл. 143 balance test.

### 3.5 B2B SLA: promise the process, not the outcome — [GATE-v2]

Never promise detection ("we will detect every fire in your polygon") — physics forbids it and
a missed 0.5 ha smouldering fire under cloud cover becomes breach. Promise the *pipeline*:

- "Ingestion of each upstream source within N minutes of upstream publication (measured at our
  API boundary), M% monthly" — we control this; it is measurable and honest.
- "Alert dispatch within N seconds of a FireEvent matching a monitored polygon, M% monthly."
- Explicit carve-out: "Upstream data availability, latency and detection performance
  (NASA/EUMETSAT/Copernicus) are outside the SLA"; link the sources' own disclaimers.
- Service credits (not damages) as the exclusive SLA remedy; cap per §3.4(3); no death/injury
  or чл. 94 carve-outs needed in B2B *caps* beyond the statutory floor, but keep them anyway
  for hygiene.

### 3.6 Evidence beats drafting

The security review's audit-trail items double as the liability defence file: per-detection
provenance, ingestion timestamps, alert dispatch logs with delivery receipts, uptime metrics,
and the QA correctness suite. In a чл. 45/чл. 49 dispute, "here is the signed log showing we
ingested the upstream detection at T+4 min and dispatched at T+4.5 min; the satellite simply
saw the fire late" wins; the best-drafted disclaimer without logs loses. Retain these logs per
the retention table (security review §5.3) — long enough to cover the 5-year general
limitation period (ЗЗД чл. 110) for high-value B2B disputes. ⚖ Confirm retention-vs-GDPR
balance with counsel.

---

## 4. Regulatory scan

### 4.1 BG-ALERT and emergency-communications law — we are outside it (verified)

- BG-ALERT's legal basis: **ЗЕС чл. 242б** (mobile operators must transmit warnings "чрез
  Системата BG-ALERT"; ал. 2 delegates to a ministerial наредба) → **Наредба
  № 8121з-413/29.03.2024** (ДВ бр. 31/09.04.2024; МВР/ГДПБЗН; cell broadcast). The siren
  system: Закон за защита при бедствия чл. 62, ал. 2, т. 5. These regulate the *state system
  and the operators* — nothing in ЗЕС/ЗЗБ creates a licensing/permission regime for a private
  fire-information or subscription-alert service (negative finding, verified against the full
  ЗЗБ text). Sources: https://www.lex.bg/laws/ldoc/2135553187 ·
  https://www.lex.bg/laws/ldoc/2135540282
- Two conduct rules follow anyway:
  1. **Never imitate officialdom** — no state emblems, no "national"/"агенция" naming (§7), a
     standing "unofficial service — follow BG-ALERT/112 instructions" disclaimer. There is no
     explicit anti-imitation statute; the exposure runs through НК, ЗЗП unfair commercial
     practices, and trademark law.
  2. **НК чл. 326** (verified verbatim): transmitting **false** calls or misleading signals
     for help, accident or alarm → up to 2 years' imprisonment; ал. 2 — significant harmful
     consequences → up to 5 years + fine 10,000–50,000 лв. This binds *users who submit fake
     reports* (and us if we knowingly relayed falsehoods as alarm). Our design controls —
     crowdsourced evidence never auto-triggers alerts, satellite-first confirmation,
     unconfirmed-report labelling — are exactly the right mitigation; keep them as invariants.

### 4.2 DSA (Regulation (EU) 2022/2065) — dormant at MVP, wakes with crowdsourcing

- **MVP (map-only, no user content): not an intermediary service** — we publish our own
  derived information; the DSA does not apply.
- **The moment user reports/photos are publicly displayed**, we are a **hosting service**
  (Art. 3(g)(iii)) and, because dissemination to the public is the point of community reports,
  presumptively an **online platform** (Art. 3(i)) — the "minor and purely ancillary feature"
  carve-out is risky to rely on once reports are a headline feature.
- **Size-independent duties (apply from day one of hosting):** Art. 11–12 contact points;
  Art. 14 ToS must describe moderation policies/tools; Art. 16 notice-and-action mechanism;
  Art. 17 statement of reasons on removal/demotion. These are cheap to build if designed-in:
  a report-flag button, a removals log with reasons, a published moderation policy. **[gate:
  crowdsourcing release]**
- **Micro/small-enterprise relief (verified verbatim):** Art. 19(1) — *"This Section, with the
  exception of Article 24(3) thereof, shall not apply to providers of online platforms that
  qualify as micro or small enterprises"* → the heavy platform obligations (Arts. 20–28:
  internal complaints, out-of-court dispute bodies, trusted flaggers, ads transparency, minor
  protections) **do not apply** to us; Art. 15(2) likewise exempts micro/small from
  transparency reports. Residual duty: provide average-monthly-active-recipient numbers on
  request (Art. 24(3)). 12-month grace after outgrowing the status.
- Source: https://eur-lex.europa.eu/legal-content/EN/TXT/?uri=CELEX%3A32022R2065

### 4.3 European Accessibility Act (Directive 2019/882, in force 28 June 2025) — exempt, build it anyway

- Selling consumer subscriptions online is an "e-commerce service" in scope (Art. 2(2)(f) +
  Art. 3(30)). **But Art. 4(5) (verbatim):** *"Microenterprises providing services shall be
  exempt from complying with the accessibility requirements… and any obligations relating to
  the compliance with those requirements."* Microenterprise = <10 persons AND ≤ €2M
  turnover/balance (Art. 3(23)).
- **Bulgarian transposition (verified):** Закон за изискванията за достъпност на продукти и
  услуги (ДВ бр. 31/11.04.2025, in force 28.06.2025); e-commerce in чл. 2, ал. 2, т. 7; the
  microenterprise exemption in **чл. 46, ал. 3**; supervision by ДАМТН. Source:
  https://dv.parliament.bg/DVWeb/showMaterialDV.jsp?idMat=233836
- Recommendation: claim the exemption formally, but **treat WCAG 2.1 AA as product policy**
  anyway — the user base includes elderly rural residents, and accessibility of alerts is a
  mission property. Losing micro status later would make it law; retrofits are expensive.

### 4.4 NIS2 — out of scope (verified)

Directive 2022/2555 Art. 2(1) applies the size-cap: only **medium or larger** entities in the
Annex I/II sectors; the size-independent categories (TLD/DNS, trust services, public e-comms
networks, sole providers of critical services, public administration) do not describe a
wildfire-information PWA. Bulgaria's transposition — the new Закон за киберсигурност (adopted
05.02.2026, ДВ бр. 17/13.02.2026) — retains the size-cap. Re-check only if the company reaches
50+ staff / €10M+, or if a sectoral designation ever names the service critical (no such
mechanism targets us today). Sources:
https://eur-lex.europa.eu/legal-content/EN/TXT/?uri=CELEX%3A32022L2555 ·
https://www.dpc.bg/bg-insights/bulgaria-adopts-nis2-key-changes-businesses-need-to-know

### 4.5 EU Data Act & Data Governance Act — one drafting duty, no blockers

- **Data Act (Reg. 2023/2854), Chapter VI** (cloud switching) applies to "data processing
  services" from **12 September 2025 with no micro/SME exemption**. Definition (Art. 2(8)):
  on-demand access to "a shared pool of configurable, scalable and elastic computing
  resources" (IaaS/PaaS/SaaS per the recitals). Honest analysis: a fire-alert subscription/API
  is an *information service*, not the provision of computing resources — a defensible
  position that Chapter VI does not apply. But the cost of compliance is trivially low, so
  **draft B2B contracts switching-friendly anyway** [GATE-v2]: data-export right in a common
  format, max 2-month notice, ≤30-day transition, no exit fees (mandatory anyway from
  12.01.2027 for in-scope services; at-cost until then — Arts. 23, 25, 29).
- Interesting reverse angle: Data Act Arts. 14–15 let public bodies **demand data from
  businesses in a "public emergency"** — a major wildfire could qualify; a request from
  ГДПБЗН for our FireEvent history is one we should be architecturally able (and licensed —
  we are, §2) to answer. Treat as goodwill opportunity, not threat.
- **DGA (Reg. 2022/868): not applicable** — it governs re-use of protected public-sector
  data, data-intermediation services and data altruism; consuming open satellite data is
  governed by the sources' own licences and the Open Data Directive regime upstream.
- Source: https://eur-lex.europa.eu/legal-content/EN/TXT/?uri=CELEX%3A32023R2854

### 4.6 ePrivacy / cookies — the architecture already wins — [GATE-MVP: keep it]

- Art. 5(3) of Directive 2002/58: consent required for storing/accessing anything on the
  device **except** what is "strictly necessary… for an information society service explicitly
  requested by the user". Session/auth tokens, the push-subscription state, offline-cache
  (service worker) for the app itself, and a consent-choice cookie are all in the exemption →
  **no cookie banner needed** for the current architecture. Self-hosted cookieless analytics
  stores nothing on the device → outside Art. 5(3) entirely (GDPR still governs the IPs —
  covered by legitimate interest + truncation per the security review).
- **BG transposition quirk (verified):** implemented not in ЗЕС but in **Закона за
  електронната търговия, чл. 4а** — whose literal text is an *opt-out* ("възможност да
  откаже"). Post-*Planet49* (C-673/17) that literal standard is dead: any future
  non-essential cookies (marketing pixels, embedded third-party maps with tracking) need
  real opt-in consent. Rule: adding any third-party script to the PWA is a legal event, not
  just a performance event. Source: https://www.lex.bg/laws/ldoc/2135530547
- Push notifications themselves are not an Art. 5(3) problem (user explicitly subscribes);
  the *content* of marketing pushes would be direct marketing needing consent — alert pushes
  the user configured are the service itself (Art. 6(1)(b), §5.1).

### 4.7 Consumer distance-selling mechanics for the paid tier — [GATE-v1]

- Pre-contract information duties (ЗЗП, transposing Directive 2011/83): identity, price incl.
  VAT, duration/renewal terms, withdrawal rights, complaint handling. Auto-renewal needs
  clear disclosure at sign-up plus reminder practice.
- **14-day withdrawal right** applies to digital *services*: performance may start
  immediately with the consumer's express request; on withdrawal mid-period the consumer owes
  pro-rata. Build the flow: checkbox at checkout + pro-rata refund logic.
- The EU **ODR platform was discontinued in July 2025** — do not copy the old "ODR link"
  boilerplate from templates; the ADR information duty (which national ADR body is
  competent — КЗП lists) remains.
- Prices in **euro** (Bulgaria adopted the euro 01.01.2026; conversion at 1 EUR = 1.95583 лв.
  per Council Decision (EU) 2025/1407). A statutory BGN/EUR dual-display obligation applies
  during the transition window — ⚖ verify whether it still runs at paid-tier launch and
  display accordingly.

---

## 5. GDPR delta (extends security review §5.3 — read that first; no duplication here)

The security review already established: watch zones = de-facto registry of home coordinates
(ordinary personal data of a "highly personal nature", app-layer AES-256-GCM encryption +
coarse grid index mandated), Art. 6(1)(b) as the basis for configured alerts, DPIA before v1,
data inventory/retention table, processor list with DPAs, КЗЛД 72h breach path. This section
adds only what that review left open.

### 5.1 Legal basis per processing activity — [GATE-v1]

| Processing activity | Basis | Notes |
|---|---|---|
| Serving the public map; server logs, rate-limiting, abuse defence | Art. 6(1)(f) legitimate interest | LIA on file; IP truncation per security review |
| Self-hosted cookieless analytics | Art. 6(1)(f) | No device storage → no ePrivacy consent (§4.6) |
| Account creation & auth | Art. 6(1)(b) contract | |
| Watch-zone storage + alert generation/delivery (push, email, Telegram) | Art. 6(1)(b) | Confirmed: **not consent** — the alert *is* the requested service; avoids consent-withdrawal breaking a safety feature |
| Payment & invoicing | Art. 6(1)(b) + 6(1)(c) (accounting law retention) | ЗСч 10-year invoice retention overrides deletion requests for fiscal records |
| Marketing e-mails / non-service pushes | Art. 6(1)(a) consent | Separate toggle; never bundled with alert opt-in |
| Publishing crowdsourced reports/photos | Art. 6(1)(a) for the contributor's data; 6(1)(f) for moderation/anti-abuse | See §8 for third parties captured in photos |
| Retention of dispatch/audit logs for legal defence | Art. 6(1)(f) | §3.6; balance against minimization ⚖ |
| B2B contact/contract data | Art. 6(1)(b)/(f) | |

### 5.2 Could watch zones be special-category data by inference? Argued: no — but behave as if sensitive

CJEU **C-184/20** (OT, 1 Aug 2022) held that data *"liable indirectly to reveal"* a special
category (there: sexual orientation from a spouse's name) falls under Art. 9. Applied here: a
watch-zone center is a coordinate; coordinates near a mosque, monastery, or mono-ethnic
village could *in theory* support inferences about religion or ethnicity. The defensible
position (and our written one): Art. 9 is triggered where the processing, by its nature or
purpose, tends to reveal the sensitive attribute — we perform **no inference**, the
coordinate's purpose is exclusively geometric (geofence matching), and the theoretical
possibility of third-party inference from an encrypted, never-disclosed coordinate does not
convert every location datum into Art. 9 data (otherwise all location processing would be).
The EDPB reads C-184/20 broadly, so this is a position, not a certainty — which is precisely
why the *engineering posture must stay at Art. 9 grade anyway*: app-layer encryption, coarse
grid indexes, no analytics/segmentation on zone locations ever (make this a written product
invariant), no disclosure to third parties. With those controls, the classification debate
becomes academic. ⚖ Include the argument in the DPIA for КЗЛД-proofing.

### 5.3 Telegram is not our processor — design around it

Telegram Bot API offers no Art. 28 DPA; Telegram is an independent service the *user chooses*
to connect (like choosing a Gmail address for email alerts). Handle it as a
**user-directed transmission to a third-party controller**: (a) the linking flow is
user-initiated (user messages the bot first); (b) the privacy policy names Telegram, its
non-EU establishment, and states that message content transits Telegram's infrastructure
outside our control; (c) **data minimization in message content** — the alert text inherently
reveals to Telegram roughly where the user's zone is; send event location + distance band, not
the zone's address/name; never send account e-mail or payment info through the bot. (d) Do
not make Telegram the only channel for anything (Web Push/email are the controlled paths).
⚖ Have counsel bless the "user-directed disclosure, not our transfer" characterization —
it is the honest reading of Ch. V but not risk-free.

### 5.4 Web Push endpoints are personal data; the conduits are (barely) not processors

Push subscription endpoints + keys are online identifiers → personal data; store them
encrypted at rest like other channel identifiers. Payloads are end-to-end encrypted by RFC
8291, so Google FCM / Mozilla autopush / Apple relay only opaque ciphertext to an opaque
endpoint — the strong argument is they act as **mere-conduit communication networks**, not
our processors (we cannot sign a DPA with Mozilla for autopush anyway). Nevertheless: list
them in the privacy policy as recipients-in-transit, note Google/Apple US transfer coverage
under the **EU-US Data Privacy Framework** (both certified), and keep VAPID keys managed per
the security review.

### 5.5 International transfers — current map

- **Cloudflare**: DPF-certified and offers 2021 SCCs in its DPA (verified earlier in this
  review cycle) → covered either way. DB/compute stay in EU regions (Frankfurt per security
  review) — keep that as a written hosting policy.
- **Google (FCM), Apple (APNs)**: DPF-certified; ciphertext-only exposure (§5.4).
- **Telegram**: no DPF, no SCCs — handled via §5.3 (user-directed disclosure).
- Maintain a one-page transfer register (destination, mechanism, TIA-lite note) as an annex
  to the RoPA.

### 5.6 Records of processing (Art. 30) — required despite being tiny

The <250-employee derogation (Art. 30(5)) does not apply where processing is
**non-occasional** — a continuously running alert service processes continuously. Keep the
RoPA from day one of accounts: the security review's data-inventory table is 80% of it; add
purposes, bases (§5.1), recipients, transfer mechanisms (§5.5), retention. One markdown file
in the ops repo, versioned, suffices at our scale. **[GATE-v1]**

### 5.7 DPIA scope confirmation and the B2B role flip

- DPIA **before v1** (security review) — confirmed from the legal side; КЗЛД's Art. 35(4)
  blacklist includes large-scale location tracking; we are arguably not "large-scale", but
  systematic location-based monitoring + vulnerable users (elderly rural residents) satisfies
  two EDPB criteria → do the DPIA, document the C-184/20 analysis (§5.2), and only approach
  КЗЛД (Art. 36) if residual risk stays high (it should not, given the controls).
- Extend the DPIA when shipping: crowdsourced geotagged photos (§8), the Telegram channel
  (§5.3), and any B2B feature where a customer registers *other people's* contact details as
  alert recipients — in that configuration the **B2B customer is controller and we are
  processor**, so v2 needs an Art. 28 DPA template offered to B2B customers. **[GATE-v2]**

---

## 6. Corporate structure, tax and VAT

### 6.1 The structural choice

| Criterion | ЕООД | Сдружение (ЮЛНЦ) | Фондация (ЮЛНЦ) | Hybrid (ЮЛНЦ + ЕООД) |
|---|---|---|---|---|
| Formation (solo founder) | Trivial; €1 capital; full control | чл. 19 ЗЮЛНЦ: ≥3 founders; **public benefit: ≥7 individuals or ≥3 legal persons** — not solo-friendly | чл. 33 ЗЮЛНЦ: unilateral endowment act — solo-friendly | Both registrations + intercompany hygiene |
| Commercial activity (memberships, B2B) | Unrestricted | Only **ancillary**, related to the non-profit purpose, income used for the purpose, no profit distribution (чл. 3, ал. 3 и 6) | Same restriction | ЕООД carries all commerce |
| Tax | CIT 10%; dividend WHT 5% to individuals (verified current 2026 — the mooted 10% was **not** adopted) | 10% CIT only on the business-activity profit; genuine dues/donations untaxed | Same | ЕООД taxed normally; ⚖ dividends ЕООД→ЮЛНЦ likely bear 5% WHT (unverified — check чл. 194 ЗКПО) |
| Donations / donor deduction | No donor incentive | **Public-benefit status: donors deduct (ЗКПО чл. 31, up to 10% of profit)**; status is irrevocable; annual reporting to the ТРЮЛНЦ registry | Same | Donations land in ЮЛНЦ |
| EU funding | CASSINI ✔ (natural or legal persons), EIC Accelerator ✔ (for-profit SME only), Interreg: **partner but not lead** | Interreg **lead partner eligible** (private non-profit); EIC ✘ | Same | Widest coverage |
| Perception | Commercial | Civic trust (Watch Duty model) | Civic trust | Best of both, at overhead cost |

**Recommendation:** register an **ЕООД before v1** (first euro of revenue and first stored
watch zone should belong to a limited-liability entity, echoing the security review). Defer
the hybrid until there is a concrete grant (Interreg lead) or donation stream that justifies
it; a фондация (not сдружение) is the solo-compatible ЮЛНЦ vehicle if that day comes. Running
MVP as a physical person is legally possible but leaves personal assets exposed to §3
claims — cheap insurance is exactly what an ЕООД is. **[GATE-v1]**

### 6.2 Tax sketch (ЕООД, solo)

10% CIT on profit; 5% WHT on dividends to the founder; self-insurance (самоосигуряване) social
contributions for the managing owner; accounting outsourced (~€600–1,200/yr). Effective
combined burden on distributed profit ≈ 14.5% — among the lowest in the EU; no special
regimes needed at our scale.

### 6.3 VAT — verified 2026 state of play

- Bulgaria uses the **euro since 01.01.2026** (1 EUR = 1.95583 лв., Council Decision (EU)
  2025/1407).
- **Domestic registration threshold: €51,130** (exactly 100,000 лв.) per чл. 96, ал. 1 ЗДДС as
  amended ДВ бр. 115/30.12.2025 — *not* the older 166,000 лв. figure floating around;
  turnover now counted per **calendar year**, 7-day registration deadline. (A proposal exists
  to raise it to €85,000 from 2027 — proposal only.)
- **EU SME scheme (Ch. 21б ЗДДС, Directive 2020/285), from 01.01.2026**: sell to consumers in
  other Member States without foreign VAT registrations while BG turnover ≤ €51,130 **and**
  EU-wide turnover ≤ €100,000 (below each state's own threshold), using an "EX"-suffixed ID +
  quarterly reports.
- **OSS €10,000 threshold**: consumer memberships sold cross-border (Greece, Romania…) are
  electronically supplied services — below €10k total cross-border B2C, charge BG VAT; above,
  destination-country VAT via OSS (unless the SME scheme applies instead). Decide which
  regime at paid-tier launch.
- **B2B subscriptions cross-border**: reverse charge (Art. 44/196 VAT Directive; ЗДДС чл. 21,
  ал. 2) — invoice net + "reverse charge", VIES declaration.
- **The "membership" label is not a VAT shelter**: чл. 44, ал. 1, т. 3 ЗДДС exempts genuine
  member dues of non-profit organizations (and only where competition isn't distorted). A
  freemium subscription unlocking premium alerts is **consideration for a service → taxable**
  regardless of what it's called. Price accordingly (€15–25 is VAT-inclusive in B2C display).
- **Merchant of record**: Stripe is a PSP, *not* MoR — VAT/OSS compliance stays ours (Stripe
  Tax only computes). **Paddle is an MoR and supports Bulgarian sellers** (~5% + $0.50);
  Lemon Squeezy (Stripe-owned) likewise. Pragmatic call: use an MoR at v1 to outsource all
  consumer VAT/OSS mechanics; reconsider once revenue justifies in-house OSS. **[GATE-v1]**

### 6.4 EU funding eligibility (verified)

- **CASSINI Challenges (EUSPA)**: open to "economic operators (natural or legal persons)",
  individuals ≥18 eligible — can compete **before incorporating**; €100k prizes; requires
  TRL≥5 and use of EU space data (Copernicus — which we do, natively). The 2026 round closed
  26.03.2026; target the next edition. https://www.euspa.europa.eu/cassinichallenges
- **EIC Accelerator**: single applicant must be a **for-profit SME** (ЕООД qualifies;
  individuals may apply intending to incorporate).
- **Interreg Danube**: SMEs may be partners, **not lead**; lead = public bodies, non-profits,
  int'l organizations. **Interreg VI-A Greece–Bulgaria**: SMEs and NGOs eligible; BG scope =
  Благоевград, Смолян, Кърджали, Хасково — exactly the fire-prone border belt. A future ЮЛНЦ
  (hybrid) unlocks lead-partner roles.

---

## 7. Trademark & naming

### 7.1 Clearance methodology — do this before spending on the brand [GATE-MVP]

1. **EUIPO eSearch plus + TMview**: identical & similar-mark search in Nice classes **9**
   (software/apps), **38** (telecom/alerting), **42** (SaaS); include BG national marks (BPO
   database via TMview). Search word marks + obvious transliterations (Latin/Cyrillic).
2. **Company names**: BG Търговски регистър + a quick EU-wide web/app-store/domain sweep for
   unregistered prior use (passing-off style conflicts).
3. Screen against §7.3's absolute grounds *before* falling in love with a name.
4. If clear: file **EUTM** — €850 first class, +€50 second, +€150 each further; 10-year term,
   renewable; 3-month opposition window; ~4–6 months to grant. A BG-only national mark is
   cheaper but pointless for a Balkans-wide product. File at v1 (revenue) unless a conflict
   risk argues for earlier defensive filing.
   https://www.euipo.europa.eu/en/trade-marks/before-applying/fees-payments

### 7.2 The "official-sounding name" trap (BG law, verified)

- **ЗМГО чл. 11, ал. 1**: absolute refusal grounds include т. 7 — marks that **deceive** as to
  nature/quality/origin; т. 8 — state coats of arms, flags, symbols of states/international
  organizations (Paris Convention Art. 6ter); т. 9–10 — emblems/official signs of special
  public interest. A mark evoking BG-ALERT, the fire service (ГДПБЗН), or state authority
  fails here — and invites НК/ЗЗП trouble besides.
- **ТЗ чл. 7, ал. 2**: the firm name "трябва да отговаря на истината, да не въвежда в
  заблуждение и да не накърнява обществения ред и морала"; ал. 5 — must not be
  identical/similar to a protected mark. No explicit ban on "национален/държавен", but names
  implying official status are refused under the general clause — avoid them and any
  fire-service visual language (helmets, state-style crests, siren iconography that mimics
  BG-ALERT's).
- Positive guidance: a coined/neutral name + explicit "independent, unofficial service" strap
  line is both the trademark-safe and the liability-safe (§3.2, §4.1) choice.

### 7.3 Domains

Secure `.com` and `.eu` at naming time (cheap defensive step); `.bg` has registrant
eligibility rules tied to local presence/marks — ⚖ verify current Register.BG terms when the
ЕООД exists (an ЕООД satisfies them). Keep e-mail authentication (SPF/DKIM/DMARC) per the
security review — brand impersonation in a fire context is a phishing vector with physical
consequences, and consistent sender domains are part of the naming strategy.

---

## 8. Content & crowdsourcing (user reports and photos)

### 8.1 The licence clause (draft for ToS — English working text)

> "By submitting a report, photo or other content, you grant [Entity] a non-exclusive,
> worldwide, royalty-free, sublicensable and transferable licence to host, store, reproduce,
> adapt (including cropping, compressing, annotating and overlaying on maps), publicly
> display and distribute that content, for the purposes of operating, improving and promoting
> the service and of wildfire awareness and safety, including sharing with emergency
> authorities. You confirm you created the content or have the necessary rights, and that it
> does not infringe anyone's rights. You can delete your content at any time; already
> generated aggregate/derived data (e.g. confirmation counts) may be retained in
> non-identifying form."

Notes: (a) **BG moral rights (ЗАПСП) are inalienable** — do not attempt a "waiver"; instead
obtain express consent to modifications/anonymous display, which BG law permits; (b)
sublicensable/transferable keeps CDN, processors and a future entity migration clean; (c)
"sharing with emergency authorities" makes the civic-value path explicit and lawful.

### 8.2 Moderation duties

DSA mechanics per §4.2 (ToS-documented policy, notice-and-action, statements of reasons) +
НК чл. 326 hygiene per §4.1 (verify before amplifying; label unconfirmed; never auto-trigger
alerts from reports — existing design invariant). The 00-summary's "moderation capacity is a
launch precondition" is hereby seconded as a *legal* precondition: an unmoderated fire-report
feed is both a DSA Art. 16 failure and a false-alarm amplifier. **[gate: crowdsourcing
release]**

### 8.3 Minors

Bulgaria set the GDPR Art. 8 digital-consent age at **14** (ЗЗЛД чл. 25в). Under-14s need
parental consent we cannot verify at our scale → simplest compliant policy: **accounts and
content submission require 14+**, stated in ToS, with a neutral age attestation at signup.
The public map itself has no age gate (no personal data collected from viewers).

### 8.4 Geotagged photos and third parties

- **EXIF/GPS stripping server-side** (security review B8) is also the privacy-law control:
  publish only the coarse, reporter-confirmed location, never the raw capture coordinates.
- Photos capturing identifiable people, vehicle plates or home interiors: our re-publication
  is *our* processing (the household exemption covers the photographer, not us). Policy:
  reject/blur identifiable persons where feasible, offer a fast takedown channel (doubles as
  the DSA Art. 16 mechanism), and rely on Art. 6(1)(f) with a documented balance for
  incidental background appearances in newsworthy fire imagery.
- Buildings/landscapes: BG panorama freedom (ЗАПСП чл. 24) and the factual nature of fire
  photos keep copyright risk negligible.

---

## 9. Ranked legal-risk register (top 10)

| # | Risk | Likelihood | Impact | Mitigation | Gate |
|---|------|-----------|--------|------------|------|
| 1 | Charging consumers without the legal scaffolding (entity, conformant ToS, withdrawal flow, VAT posture) — void terms, КЗП exposure, personal liability | High if rushed | High | ЕООД + ToS per §3.4 + §4.7 mechanics + MoR/VAT decision (§6.3) before first paid user | **[GATE-v1]** |
| 2 | Missed/false alert causes harm; claim tests our duty of care | Low-Med | Very high | Scope-of-service drafting (§3.4), layered disclaimers in UX, provenance/dispatch logs as defence file (§3.6), never-all-clear invariant | **[GATE-v1]** |
| 3 | Shipping EOX 2018+ imagery (NC) or hotlinked Esri tiles in a commercial product — the one real infringement trap | Certain if done | Med-High | Don't ship; use 2016/17 CC BY layers, licensed Esri via ALP (no SW-cache), or own CDSE mosaics (§2.2.H–I) | **[GATE-MVP]** |
| 4 | Missing/incorrect attribution (OSM, Copernicus, NASA, EUMETSAT) — licence breach, community backlash | Med | Low-Med | §2.4 block shipped with the first map + CI presence check | **[GATE-MVP]** |
| 5 | Watch-zone data breach / DPIA gap — КЗЛД fines, user harm (mirrors security R2) | Low-Med | High | Security review controls + §5.2 posture + DPIA before v1 + RoPA | **[GATE-v1]** |
| 6 | Crowdsourced content without DSA mechanics, licence clause, moderation capacity; fake report amplification (НК 326) | Med | High | §8 package as release precondition for reports | gate: crowdsourcing |
| 7 | VAT misstep on "memberships" (treating them as exempt dues; missing OSS/SME-scheme election) | Med | Med | §6.3: taxable-service treatment, MoR or OSS decision at launch | **[GATE-v1]** |
| 8 | B2B SLA promising outcomes (detection) instead of process — breach by physics | Med | Med-High | §3.5 SLA pattern; upstream carve-outs; service credits as exclusive remedy | **[GATE-v2]** |
| 9 | Official-sounding name/brand — trademark refusal, ЗЗП unfair-practice exposure, BG-ALERT confusion | Low-Med | Med | §7 clearance + neutral naming + "unofficial" strap line before brand spend | **[GATE-MVP]** |
| 10 | New PLD (2024/2853): strict liability for software defects in versions shipped after 09.12.2026 | Low | High | QA correctness suite + update discipline as defect defence; revisit insurance at B2B stage | **[GATE-v2]** + watch date |

---

## 10. Open questions for a real lawyer (⚖)

1. **ToS + privacy policy review** before the first paid user — the §3.4 architecture drafted
   here needs a Bulgarian lawyer's pen, esp. the B2C property-damage cap. **[GATE-v1]**
2. **C-184/20 / Art. 9 position** on watch zones (§5.2) — bless the argument inside the DPIA.
3. **Telegram characterization** as user-directed disclosure vs. our restricted transfer
   (§5.3).
4. **EUMETSAT tier check** for any direct FCI L1/L2 ingestion, and written EFFIS position if
   we ever redistribute their raw danger rasters via API (§2.2.B/E). **[GATE-v2]**
5. **Log retention vs. minimization**: is retaining dispatch/provenance logs for the 5-year
   limitation period defensible for all users, or only after a dispute arises (§3.6)?
6. **Hybrid structure tax**: WHT on ЕООД→ЮЛНЦ dividends (чл. 194 ЗКПО) and the ancillary-
   activity boundary for a ЮЛНЦ running fire-information services (§6.1) — only if/when the
   hybrid is pursued.
7. **Euro dual-display window** status at paid-tier launch (§4.7).
8. **Register.BG eligibility** for the `.bg` domain once the ЕООД exists (§7.3).
9. **DSA classification memo** once crowdsourced reports are designed: hosting-only vs.
   online platform (the "minor and purely ancillary" question, §4.2).
10. **Professional-indemnity insurance** availability/pricing for an information service in
    BG at the B2B stage (extends security review's insurance item). **[GATE-v2]**
11. **Withdrawal-right edge case**: whether the alert service qualifies for the digital-
    content immediate-performance exception or the service pro-rata rule (§4.7) — affects
    refund copy.
12. **B2B Art. 28 DPA template** when customers register third-party recipients (§5.7).
    **[GATE-v2]**

---

## 11. Sources (primary, as verified for this review)

- NASA data-use guidance / FIRMS / LANCE: https://www.earthdata.nasa.gov/engage/open-data-services-software-policies/data-use-guidance · https://www.earthdata.nasa.gov/data/tools/firms · https://www.earthdata.nasa.gov/data/projects/lance
- EUMETSAT Data Policy (PDF, am. 27.06.2024): https://www-cdn.eumetsat.int/files/2024-07/45173%20-%20Data%20Policy(1419774%20V1).pdf
- LSA SAF data access & fire products: https://lsa-saf.eumetsat.int/en/data/data-access/ · https://lsa-saf.eumetsat.int/en/data/products/fire-products/
- Copernicus Sentinel legal notice: https://sentinels.copernicus.eu/documents/247904/690755/Sentinel_Data_Legal_Notice · Delegated Reg. 1159/2013: https://eur-lex.europa.eu/legal-content/EN/TXT/?uri=CELEX:32013R1159 · CDSE T&C: https://dataspace.copernicus.eu/terms-and-conditions
- EFFIS / GWIS data licence: https://forest-fire.emergency.copernicus.eu/about-effis/data-license · https://gwis.jrc.ec.europa.eu/about-gwis/data-license
- OSM/ODbL: https://opendatacommons.org/licenses/odbl/1-0/ · https://osmfoundation.org/wiki/Licence/Attribution_Guidelines · Geocoding, Collective Database, Horizontal Layers guidelines (osmfoundation.org/wiki/Licence/Community_Guidelines/…)
- OpenFreeMap: https://openfreemap.org · Protomaps: https://github.com/protomaps/basemaps/blob/main/LICENSE_DATA.md · Terrain tiles: https://github.com/tilezen/joerd/blob/master/docs/attribution.md
- Esri: https://www.esri.com/content/dam/esrisites/en-us/media/legal/ma-full/ma-full.pdf · https://location.arcgis.com/faq/ · https://location.arcgis.com/pricing/
- EOX cloudless: https://cloudless.eox.at/documentation/license · https://cloudless.eox.at/license-legal/
- DSA: https://eur-lex.europa.eu/legal-content/EN/TXT/?uri=CELEX%3A32022R2065 · EAA: Directive 2019/882 + ЗИДПУ ДВ бр. 31/2025 (https://dv.parliament.bg/DVWeb/showMaterialDV.jsp?idMat=233836) · NIS2: CELEX 32022L2555 · Data Act: CELEX 32023R2854 · PLD: CELEX 32024L2853 · ePrivacy BG: ЗЕТ чл. 4а (https://www.lex.bg/laws/ldoc/2135530547)
- BG-ALERT/ЗЕС: https://www.lex.bg/laws/ldoc/2135553187 · ЗЗБ: https://www.lex.bg/laws/ldoc/2135540282 · НК чл. 326 (justice.government.bg consolidated text)
- ЗЗД: https://lex.bg/laws/ldoc/2121934337 · ЗЗП: https://lex.bg/laws/ldoc/2135513678 · ЗПЦСЦУПС: ДВ бр. 23/2021 (https://dv.parliament.bg/DVWeb/showMaterialDV.jsp?idMat=156454) · ЗЮЛНЦ: https://lex.bg/laws/ldoc/2134942720 · ЗДДС: https://lex.bg/laws/ldoc/2135533201 · ЗМГО: ДВ бр. 98/2019
- Euro adoption: https://www.consilium.europa.eu/en/press/press-releases/2025/07/08/bulgaria-ready-to-use-the-euro-from-1-january-2026-council-takes-final-steps/ · VAT OSS: https://vat-one-stop-shop.ec.europa.eu/one-stop-shop_en
- EUIPO fees: https://www.euipo.europa.eu/en/trade-marks/before-applying/fees-payments · CASSINI: https://www.euspa.europa.eu/cassinichallenges · Interreg Danube FAQ: https://interreg-danube.eu/frequently-asked-questions · Paddle supported countries: https://www.paddle.com/help/start/intro-to-paddle/which-countries-are-supported-by-paddle
- CJEU C-184/20 (OT), 01.08.2022 — special categories by indirect inference.

*Verification convention: statements marked "verified"/"verbatim" were checked against the
primary sources above during this review cycle (July 2026); items marked ⚖ or "unverified"
require counsel or re-checking at the indicated gate.*
