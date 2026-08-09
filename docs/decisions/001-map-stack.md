# ADR-001: Map stack — MapLibre GL JS + OpenFreeMap now, Protomaps PMTiles later

*Date: 2026-07-21. Status: accepted (pre-code). Amended 2026-07-30 ("Amendment A1")
and 2026-08-02 ("Amendment A2") — see below; where they conflict, the later
amendment wins.*

## Context

Fire Watch needs an interactive map as its core surface. Requirements, in priority order:

1. **Cost survives traffic spikes.** The reference product (Watch Duty) gained 600k users
   overnight during the LA fires. Per-map-load pricing (Google, Mapbox) explodes exactly when
   the product delivers the most value. Tile serving must be flat-cost or self-hosted.
2. **Terrain readability.** Bulgarian fires burn in mountains (Rila, Pirin, Sakar, Strandzha).
   Users must read relief and forest cover at a glance → hillshade + landcover emphasis, not a
   generic street map.
3. **Cyrillic-first labels** with Latin fallback — needs control over label fields (`name:bg`),
   which implies vector tiles, not baked raster.
4. **Data overlays:** thousands of hotspot points + fire-event polygons (GeoJSON, updating via
   SSE), EFFIS WMS raster overlays (fire danger, burnt areas), optional smoke/wind layers.
5. **Dark mode** (night use during fire events) → runtime restyling, again vector tiles.
6. **PWA / weak connectivity:** rural areas; a path to offline map packs is a plus.

## Decision

### Rendering library: **MapLibre GL JS**

- Vector tiles + WebGL: handles our point/polygon volumes trivially; data-driven styling
  (color by event age/intensity) straight from the style spec.
- **Native terrain + hillshade** from a DEM raster source — requirement 2 without plugins.
  Free DEM: AWS Terrain Tiles (Terrarium) open data.
- Full runtime style control → Cyrillic labels, dark mode variant of the same tiles.
- EFFIS **WMS works as a plain raster source** via the `{bbox-epsg-3857}` URL template — we
  don't need OpenLayers-grade WMS/WFS machinery for a handful of overlay layers.
- PMTiles support via official `addProtocol` plugin — enables the Phase-2 tile plan below.
- BSD-licensed, no keys/tokens, the de-facto standard fork of Mapbox GL v1 with strong
  momentum (Amazon/Meta/Microsoft-backed via the MapLibre organization).

**Rejected:**
- *Leaflet* — flat 2D raster world: no vector tiles, no terrain/hillshade, no runtime
  restyling; would cap requirements 2, 3, 5.
- *OpenLayers* — strongest native WMS/WFS/projections, but heavier API for our actually-simple
  GIS needs; its strengths target enterprise GIS clients, not consumer UX.
- *Mapbox GL JS / Google Maps* — per-load billing violates requirement 1; Mapbox v2+ is
  proprietary. MapLibre gives the same rendering model for free.

### Basemap tiles: **OpenFreeMap public instance now → self-hosted Protomaps PMTiles at scale**

- **Phase 1 (MVP):** [OpenFreeMap](https://openfreemap.org/) public instance — OSM-based
  OpenMapTiles schema, **no API key, no usage limits, no tracking**, MapLibre-ready styles.
  Zero cost, zero ops. Known trade-off: **no SLA** — acceptable pre-launch, not acceptable
  during a fire emergency once we have real users.
- **Phase 2 (before first fire season with real traffic):** self-host **Protomaps PMTiles**
  (single-file basemap extract) on Cloudflare R2 behind its CDN — **no bandwidth fees**,
  ~$11 per 10M tile requests; a Europe/Balkans extract keeps the file small. This removes the
  third-party availability risk and is spike-proof by construction. OpenFreeMap also supports
  full self-hosting as an alternative if we prefer its schema/styles.
- Both are OSM-derived vector tiles, so the custom style (below) ports with modest rework.

### Style: custom "outdoor" style, two variants (light/dark)

- Base: OpenFreeMap/OpenMapTiles or Protomaps basemap style as starting point.
- Add: hillshade layer (Terrarium DEM), emphasized landcover/forest, de-emphasized roads/POIs,
  `name:bg` → `name` fallback chain, muted palette so **fire data is the loudest thing on the
  map** (red/orange reserved exclusively for fire layers).
- Optional later: satellite imagery toggle (Esri World Imagery or Sentinel-2 cloudless per
  their attribution terms) for burned-area inspection.

## Consequences

- One rendering stack (MapLibre) from MVP through B2B embeds; no migration of map code, only
  of tile hosting (style JSON URL swap).
- We own a style asset that becomes part of the product identity.
- Terrain tiles and PMTiles introduce two small infra dependencies (S3 open data, R2 bucket) —
  both flat-cost and replaceable.
- Revisit this ADR only if we need true 3D flyovers (CesiumJS territory) — currently a non-goal.

## Amendment A1 (2026-07-30)

Outcome of the two review rounds (04 SRE, 05 security, 08 frontend, 09 legal). Four
changes to the original decision; everything not mentioned stands.

### A1.1 Self-hosted tiles move from Phase 2 to **Phase 1 (MVP)**

The original plan (OpenFreeMap public instance for MVP) put a no-SLA third party on
the critical path for exactly the emergency this product exists for. Self-hosting
before launch, not "at scale":

- **Format: exploded z/x/y tile tree on R2** (max z14, Europe/Balkans extract from the
  Protomaps build pipeline), *not* a single PMTiles file served via range requests.
  Range-request serving of one giant object defeats CDN caching granularity and R2
  request pricing favors small objects (the "PMTiles trap", 04). PMTiles remains the
  *build* format; a one-off script explodes it into the tree at deploy time.
- **Map glyphs self-hosted on R2** as Noto Sans PBF ranges (Cyrillic U+0400–U+04FF
  included) — no runtime dependency on third-party glyph servers (08 §5.3).
  *Glyph scope extended by A2.1 (2026-08-02): Cyrillic alone is not enough.*
- OpenFreeMap public instance remains the dev-time convenience and documented
  emergency fallback only.
- **Privacy upgrade** (05 §5.3.6): with third-party tiles, every pan/zoom leaks the
  user's area of interest — for our users, effectively their home location during an
  emergency — to an external host. Self-hosted tiles keep viewport-implied location
  data inside our origin; this is a GDPR-posture improvement, not only an
  availability one.

### A1.2 EFFIS WMS is **proxied, never client-direct**

All EFFIS/GWIS raster overlays go through our origin at `/overlays/effis/…` with a
**10–15 min edge-cache TTL and serve-stale-on-error** (04). Rationale: EFFIS has no
SLA and occasionally slows or errors mid-season; the proxy pins a cacheable URL shape,
absorbs their downtime (stale danger-index tiles are far better than a broken layer),
and stops client IPs/viewports leaking to a third party. The client treats EFFIS
layers as ordinary raster sources on our own domain.
*Extended by A2.2 (2026-08-02): what counts as a cacheable "good" response.*

### A1.3 Satellite-imagery toggle: constrained by licence

The original "optional later: Esri World Imagery or Sentinel-2 cloudless" is replaced
by (09 §2):

- **EOX Sentinel-2 cloudless 2018+ is dropped — CC-BY-NC-SA (non-commercial) is
  incompatible** with this product. Only the 2016/2017 CC-BY layers would be usable,
  and stale imagery misleads for burned-area inspection; prefer own CDSE-derived
  mosaics if we ever need a Sentinel-2 base layer.
- **Esri World Imagery only via ArcGIS Location Platform** (free tier 2M tiles/mo,
  metered, API key, MapLibre plugin handles attribution). Hard terms mirrored into
  implementation: **excluded from the SW tile cache and never proxied or pre-cached
  server-side** (E204 §3.2); usage metering alarmed before the free-tier cliff.
  *Extended by A2.3 (2026-08-02): the client-side behavior at the cliff.*

### A1.4 Attribution is config-in-git with a CI presence test

The attribution block defined in 09 §2.4 (OSM/OpenMapTiles or Protomaps, Terrarium
composite DEM credits incl. the EU-DEM sentence, EFFIS "Contains modified Copernicus
Service information", FIRMS courtesy line, Esri auto-attribution when active, closing
"errors and omissions are ours" sentence) is implemented as a single registry
(`credits.ts`), rendered in the map control, `/credits` page, and alert footers.
**CI asserts the block's presence** — a styling refactor cannot silently drop a
licence obligation [GATE-MVP].

## Amendment A2 (2026-08-02)

Outcome of the corner-case pass (14 §3, minors bundle). Three pins on A1 — no
decision is reversed; each item makes an already-accepted rule survive a case it
did not name. Everything not mentioned stands.

### A2.1 Glyph ranges must cover every script in the tile extract (amends A1.1)

A1.1 names only Cyrillic U+0400–U+04FF. The Europe/Balkans extract carries **Greek
and Turkish** toponyms along the southern border — fixture S1 (Slavyanka) sits
literally on the Greek border — and a fontstack missing those ranges renders those
labels as **tofu boxes** on exactly the views a border fire produces.

- **Minimum glyph build scope:** Basic Latin + Latin-1 Supplement, **Latin
  Extended-A/B** (U+0100–U+024F — Turkish `ı İ ş ğ`, Romanian `ș ț`,
  Serbo-Croatian `č ć đ ž`), **Greek U+0370–U+03FF**, Cyrillic U+0400–U+04FF. In
  PBF bucket terms (256 codepoints per range): `0-255`, `256-511`, `512-767`,
  `768-1023`, `1024-1279`.
- **Normative rule — the range set is derived from the extract, not hand-kept:**
  *every script present in the label fields of the shipped tile extract must have a
  generated glyph range.* Changing the extract's bbox or adding a country
  re-derives the set in the same build; a hand-maintained list is a defect.
- **Enforcement:** the tile build emits the set of Unicode blocks observed in the
  `name*` fields of the extract it produced; the glyph build fails if any observed
  block has no corresponding range. Header-cheap and deterministic — it runs on the
  same artifact that ships, so the check cannot drift from the tiles.
- Cost is unchanged in practice: ranges are static, content-hashed, cached for a
  year, and a session fetches only the ranges its viewport needs (08 §5.3.4).
- **Acceptance (G2):** a border view over S1 renders Greek labels as glyphs, not
  boxes.

### A2.2 EFFIS proxy: content sanity before caching a response as good (amends A1.2)

A1.2's serve-stale-on-error triggers on HTTP status only. A WMS answers a failed
GetMap with **HTTP 200 carrying a ServiceException XML or a blank image**; the
proxy would store that as a good tile and serve it as fresh for the full 10–15 min
TTL. Before a response may enter the cache as good it must pass two byte-cheap
checks — **headers and body length only, no image decoding in the proxy path**:

1. **Content-type match — hard fail.** The response `Content-Type` must match the
   requested WMS `FORMAT` (`image/png` for our GetMap calls). Anything else
   (`text/xml`, `application/vnd.ogc.se_xml`, `text/html`) is an upstream error
   wearing a 200 and is treated **exactly like an HTTP 5xx**: never cached as good,
   stale served in its place.
2. **Byte-size floor — soft fail.** A per-layer floor (default 1 KB, calibrated
   from known-good samples at build time). A 200 with the correct content-type but
   a body under the floor is *suspect*, not proven bad — a fully transparent tile
   is a legitimate answer where a layer has nothing to draw in view. Rule: never
   cached as good; stale served if a stale entry exists; otherwise passed through
   to the client with a short TTL (≤ 60 s) so a genuinely empty overlay still
   renders and self-heals on the next cycle.

- Every rejection increments `effis_proxy_reject_total{layer,reason}`; a sustained
  rejection rate across one TTL window trips the same alarm path as upstream HTTP
  errors, and the client shows the existing single degraded banner (08 §5.6) —
  serving stale is a *declared* state, never a silent one.
- **Acceptance (C4/G4):** fixtures of (a) 200 + ServiceException XML and (b) 200 +
  blank image must not poison the cache.

### A2.3 ArcGIS quota cliff degrades to "no toggle", server-decided (amends A1.3)

A1.3 requires the metering alarm before the 2M tiles/mo free-tier cliff but leaves
client behavior *at* the cliff undefined — and the cliff arrives mid-emergency, when
traffic spikes and no one is free to flip a switch.

- **The server owns the decision and ships it in `/api/client-config`** — the same
  fleet-control channel as the transport tiers (ADR-003 D1). The config carries an
  `imagery` block with its key/style handles **only while imagery is enabled**;
  otherwise the block is absent. The client renders the imagery toggle **only** when
  the block is present: no client-side quota logic, and with no block there is no
  key, so the client cannot request an Esri tile at all.
- **The flip is automatic, not manual.** Metered usage crossing a configured
  ceiling — set below the free-tier limit, with headroom for metering lag —
  disables the block. The alarm still fires, but availability must not depend on a
  human being awake.
- **Hysteresis:** re-enable at the next quota period or by explicit ops override,
  never on a usage dip. A toggle flapping through an emergency is worse than one
  that is simply absent.
- **User-visible degrade: the control is missing, never broken.** Clients refetch
  client-config on the existing cadence (tab wake / reconnect); a session with
  imagery already on falls back to the basemap at the next fetch. No error tiles, no
  toast, no "imagery unavailable" modal — imagery is an inspection aid that is never
  on the critical path; the basemap and every fire layer are complete without it.
- A1.3's licence terms are untouched: never proxied, never pre-cached server-side,
  excluded from the SW tile cache, Esri auto-attribution shown while the layer is
  active.
- **Acceptance (G6):** simulated quota exhaustion hides the toggle via
  client-config.
