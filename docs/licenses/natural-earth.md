# Natural Earth — admin-1 boundaries (region filter)

| Field | Value |
|---|---|
| Source | Natural Earth 1:10m Cultural Vectors, Admin 1 – States, Provinces, v5.1.2 (`ne_10m_admin_1_states_provinces.geojson`, tag `v5.1.2` of `nvkelso/natural-earth-vector`, sha256 `22d0e3ad85eb3e27f17cabf8ba2d50e554fbc27a87796ff891d958185da62fb5`) |
| Canonical source id (A10) | none — a build-time asset, not a feed; nothing is fetched at runtime |
| Built by | `infra/geodata/cli.ts` (`pnpm run geodata`), output `web/src/assets/geodata/oblasts.json` (the 28 Bulgarian oblasts only) |
| Licence identifier | Public domain |
| Terms retrieved from | https://www.naturalearthdata.com/about/terms-of-use/ |
| Terms verified upstream | 2026-09-28 |
| Pinned into this file | 2026-09-28 |
| Commercial use | Yes |

## Governing terms (verbatim)

> All versions of Natural Earth raster + vector map data found on this website are in the
> public domain. You may use the maps in any manner, including modifying the content and
> design, electronic dissemination, and offset printing.

> No permission is needed to use Natural Earth. Crediting the authors is unnecessary.
> However, if you wish to cite the map data, simply use one of the following.
> Short text: Made with Natural Earth.

## Attribution we display

Not required. We give the requested short text on `/credits` (`credits.ts` id
`natural-earth`, `required: false`, `docs/DATA-SOURCES.md` attribution row 24):

`Made with Natural Earth.`

## Open items

- Boundaries are generalised (1:10m) and simplified to 1e-3°; the region filter files a
  point within ~1 km outside every polygon to the nearest oblast. It is a list filter, not
  an administrative determination.
