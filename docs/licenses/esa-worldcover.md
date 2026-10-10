# ESA WorldCover 10 m 2021 v200 — land cover (DS-7)

| Field | Value |
|---|---|
| Source | ESA WorldCover 10 m 2021 v200, Map layer: 3°×3° Cloud-Optimised GeoTIFFs, EPSG:4326, 1/12000° per pixel, from the AWS Open Data bucket `esa-worldcover` (`https://esa-worldcover.s3.eu-central-1.amazonaws.com/v200/2021/map/`). Produced by the ESA WorldCover consortium led by VITO. doi:10.5281/zenodo.7254221 |
| Canonical source id (A10) | none. It is a build-time asset, not a feed, and nothing is fetched at runtime |
| Built by | `infra/geodata/worldcover-cli.ts` (`pnpm run geodata:worldcover`). The product is a 0.005° class-share grid in the git-ignored `data/worldcover-cache/`. The committed manifest is `server/fixtures/worldcover-landcover.json`, which carries every source sha256 and the product sha256 |
| Licence identifier | CC BY 4.0 |
| Terms retrieved from | Product User Manual V2.0, §5.1–5.2 (`https://esa-worldcover.s3.eu-central-1.amazonaws.com/v200/2021/docs/WorldCover_PUM_V2.0.pdf`, 4,102,952 B, sha256 `4301a3d95260d88bd4315f43ccf2a12ef74ad391109b9f36e22b6e51d8490107`). Corroborated by the Zenodo record `https://zenodo.org/records/7254221` (licence `cc-by-4.0`, published 2022-10-28) and the AWS Open Data registry entry `esa-worldcover-vito` (License: "CC-BY 4.0") |
| Terms verified upstream | 2026-10-10 |
| Pinned into this file | 2026-10-10 |
| Commercial use | Yes (CC BY 4.0; "without restriction of use") |

## Governing terms (verbatim)

From the Product User Manual V2.0, §5.1 "License":

> The WorldCover product is provided free of charge, without restriction of use. For the full
> license information see the Creative Commons Attribution 4.0 International License
>
> Publications, models and data products that make use of these datasets must include proper
> acknowledgement, including citing the datasets and the journal article as in the following
> citation.

The standard licence is not pasted here. It is
`https://creativecommons.org/licenses/by/4.0/legalcode`.

From §5.2 "Citation":

> If you are using the data as a layer in a published map, please include the following
> attribution text:
> '© ESA WorldCover project [year] / Contains modified Copernicus Sentinel data ([year])
> processed by ESA WorldCover consortium'
> With year either 2020 or 2021 for the WorldCover 2020 and 2021 map, respectively

> Zanaga, D., Van De Kerchove, R., Daems, D., De Keersmaecker, W., Brockmann, C., Kirches, G.,
> Wevers, J., Cartus, O., Santoro, M., Fritz, S., Lesiv, M., Herold, M., Tsendbazar, N.E., Xu, P.,
> Ramoino, F., Arino, O., 2022. ESA WorldCover 10 m 2021 v200. doi:10.5281/zenodo.7254221.

## Attribution we display

None yet. Nothing renders WorldCover data. The product only feeds the D5 S3 cross-check, and
no runtime consumer reads it. The string is pinned now so the PR that first shows a
WorldCover-derived value carries it (`docs/DATA-SOURCES.md` attribution row 26, not
rendered). That PR also adds a `credits.ts` entry and the CI-13 assertion:

`© ESA WorldCover project 2021 / Contains modified Copernicus Sentinel data (2021) processed by ESA WorldCover consortium`

The same string travels in the manifest's `attribution` field.

## Open items

- The PUM points to "the journal article" in its citation clause, but §5.2 says "A reference
  publication on the product is in preparation". We cite the dataset DOI only.
- The PUM prescribes the string for "a layer in a published map". If WorldCover only feeds a
  score and is never drawn, CC BY still requires credit for the derived product. We would use
  the same string on `/credits` (founder call when a consumer lands).
- The bucket is managed by VITO under the AWS Open Data Sponsorship Program. Availability
  there is not a contract. The sha256 values in the manifest are what a rebuild is checked
  against.
