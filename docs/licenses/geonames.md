# GeoNames — settlement gazetteer (place search)

| Field | Value |
|---|---|
| Source | GeoNames country extract `BG.zip` + `alternatenames/BG.zip` (the dumps, not the rate-limited web API) |
| Canonical source id (A10) | none — a build-time asset, not a feed; nothing is fetched at runtime |
| Built by | `infra/geodata/cli.ts` (`pnpm run geodata`), output `web/src/assets/geodata/settlements.json` |
| Licence identifier | CC BY 4.0 — https://creativecommons.org/licenses/by/4.0/ |
| Terms retrieved from | https://download.geonames.org/export/dump/readme.txt |
| Terms verified upstream | 2026-09-28 |
| Pinned into this file | 2026-09-28 |
| Commercial use | Yes, with attribution |

## Governing terms (verbatim, export readme)

> This work is licensed under a Creative Commons Attribution 4.0 License,
> see https://creativecommons.org/licenses/by/4.0/
> The Data is provided "as is" without warranty or any representation of accuracy, timeliness or completeness.

## Attribution we display

GeoNames prescribes no sentence; CC BY 4.0 §3(a) asks for the licensor's name, a licence
reference and an indication of changes. Our chosen form (`credits.ts` id `geonames`,
`docs/DATA-SOURCES.md` attribution row 23), rendered on `/credits` and linked to
`https://www.geonames.org/`:

`Place names: GeoNames (geonames.org), CC BY 4.0`

CI-13 asserts the substring `GeoNames`. Changes (subset to populated places, coordinates
rounded to 1e-3°, Bulgarian names chosen, filed into oblasts) are indicated by the
derivation sentence (row 20).

## Open items

- The rendered line names the licence but does not link its URL; the `/credits` page links
  GeoNames only. Linking `https://creativecommons.org/licenses/by/4.0/` as well would be
  the fuller reading of CC BY §3(a)(1)(C).
