# NASA GIBS — VIIRS true-colour daily imagery (event-page before/after comparison)

| Field | Value |
|---|---|
| Source | NASA Global Imagery Browse Services (GIBS), part of NASA's Earth Science Data and Information System (ESDIS / EOSDIS). WMTS REST, layer `VIIRS_SNPP_CorrectedReflectance_TrueColor`, tile matrix set `GoogleMapsCompatible_Level9`: `https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/VIIRS_SNPP_CorrectedReflectance_TrueColor/default/{YYYY-MM-DD}/GoogleMapsCompatible_Level9/{z}/{y}/{x}.jpg` |
| Canonical source id (A10) | none — imagery for context, not a detection feed; no freshness row (nothing is ingested) |
| Used by | `web/src/core/before-after.ts` (date rule, tile maths, URL), `web/src/ui/event/before-after.tsx` (the panel, lazy chunk), opened from `web/src/ui/event/event-details.tsx` (TASKS V2-E2; `docs/DATA-SOURCES.md` §B2) |
| Terms | NASA Earth science data and imagery policy (open, no use restriction); GIBS API documentation, citation section, `https://nasa-gibs.github.io/gibs-api-docs/` |
| Licence identifier | NASA open data — no licence instrument; acknowledgement requested |
| Terms verified upstream | August 2026 (`docs/DATA-SOURCES.md` attribution row 6, "GIBS citation guidance, verified 8/2026") |
| Pinned into this file | 2026-10-27 |
| Commercial use | Allowed (NASA imagery carries no use restriction; no implied NASA endorsement) |

## Terms (as recorded — see Open items)

- NASA Earth science imagery served through GIBS is open: no key, no fee, no restriction on
  use, including commercial use.
- GIBS asks users to acknowledge the service. The acknowledgement sentence pinned in
  `docs/DATA-SOURCES.md` row 6 and `credits.ts` id `gibs` is:
  `We acknowledge the use of imagery provided by services from NASA's Global Imagery Browse Services (GIBS), part of NASA's Earth Science Data and Information System (ESDIS).`
- The use of NASA imagery must not imply NASA's endorsement of the product.
- The service is best effort: no SLA, no documented rate limit.

## Attribution strings we display

- `/credits`, always (`credits.ts` id `gibs`, condition `always`): the acknowledgement
  sentence above, byte-identical to `docs/DATA-SOURCES.md` row 6.
- The comparison panel, only while it is open (`credits.ts` id `gibs-short`, surface
  `imagery-compare`, condition `layer:gibs`): `Imagery: NASA GIBS / EOSDIS`, hyperlinked to
  `https://nasa-gibs.github.io/gibs-api-docs/`; CI-13 asserts `NASA GIBS / EOSDIS`.
  `docs/DATA-SOURCES.md` row 29. The words `Imagery:` are ours.

## How we comply

- **Nothing is copied or stored.** The reader's browser fetches the tiles straight from
  `gibs.earthdata.nasa.gov`, only after they open the comparison; the page load never
  contacts NASA. Requests carry no referrer (`referrerpolicy="no-referrer"`).
- **Volume:** one panel draws six to nine 256 px tiles per day at zoom 9, for two days, cached by
  the browser. Stepping a date a day at a time loads that day's tiles.
- **Honest labels:** the panel names each day and says the imagery is a daily mosaic
  (~375 m) that cloud or smoke can hide, that nothing checks for cloud, and that it is not
  a burned-area map. It never calls an image cloud-free.

## Open items

- **Terms are recorded from the August 2026 verification, not re-read by hand on
  2026-10-27.** Replace the paraphrase above with verbatim quotations of the GIBS citation
  section and NASA's data-use statement the next time they are read.
- **Client-direct vs proxy.** DATA-SOURCES §B2 left "proxy or client-direct" to
  implementation. Client-direct means NASA sees the reader's IP address and, through the
  tile coordinates, the area they are looking at. A proxy (ADR-001 A1.2 pattern) would
  hide both at the cost of origin egress. Founder to decide.
- **Short-form wording.** `Imagery: NASA GIBS / EOSDIS` is our form; GIBS prescribes only
  the full sentence. Founder to confirm.
- **No CSP.** The repository ships no Content-Security-Policy; when one is added, `img-src`
  must allow `https://gibs.earthdata.nasa.gov`.
