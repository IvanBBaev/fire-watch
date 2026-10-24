# EEA — Natura 2000 sites (protected-site layer and event note)

| Field | Value |
|---|---|
| Source | EEA Natura 2000 network dataset, release 2024 (end-2024 data, published 2025-01-25), read from the EEA map service `https://bio.discomap.eea.europa.eu/arcgis/rest/services/ProtectedSites/Natura2000Sites/MapServer` (layer 0, GeoJSON pages). The service description names the download page `https://www.eea.europa.eu/data-and-maps/data/natura-12`. |
| Canonical source id (A10) | none — a build-time asset, not a feed; nothing is fetched at runtime |
| Built by | `infra/geodata/natura2000.ts` + `natura2000-cli.ts` (`pnpm run geodata:natura2000`), output `web/src/assets/geodata/natura2000.json` (`docs/data/DATASETS.md` DS-8) |
| Licence identifier | CC BY 4.0 |
| Terms retrieved from | https://www.eea.europa.eu/en/legal-notice |
| Terms verified upstream | 2026-10-24 |
| Pinned into this file | 2026-10-24 |
| Commercial use | Yes, with acknowledgement |

## Governing terms (verbatim)

> Unless otherwise indicated, the European Environment Agency (EEA) is the owner of
> copyrights and database rights in this website and its contents, and EEA materials are
> published under the CC-BY license.

> Information, documents and material available on this website and for which the EEA
> holds the rights of use are public and may be re-used without prior permission, free of
> charge, for commercial or non-commercial purposes, provided that the EEA is always
> acknowledged as the original source of the material and that the original meaning or
> message of the content is not distorted. Such acknowledgment must be included in each
> copy of the material. The re-use of the content on the EEA website covers the
> reproduction, adaptation and/or distribution, irrespective of the means and/or the
> format used.

The map service's copyright text reads `EEA, Copenhagen, 2025`.

## Attribution we display

Required. Our chosen form (the EEA prescribes acknowledgement, not a sentence), on
`/credits` always and in the Layers panel's protected-sites row while the layer is on
(`credits.ts` id `eea-natura2000`, `docs/DATA-SOURCES.md` attribution row 27):

`Natura 2000 sites © European Environment Agency (EEA), CC BY 4.0`

hyperlinked to `https://www.eea.europa.eu/data-and-maps/data/natura-12`.

## Modification notice (CC BY 4.0 §3(a)(1)(B))

The asset is modified: clipped to the served box (W20 S39 E31 N46), simplified, quantised
to 1e-3°, reduced to code, name and type (SPA / SCI / both), with holes and small parts
dropped. `/credits` and the panel note say it is drawn from the EEA; the asset's header
records the transform.

## Open items

- Only EU member states are in Natura 2000: North Macedonia, Serbia and Turkey inside the
  served box have no sites, and the panel note says so.
- Site names are as the member state reported them (Latin script for Bulgaria too); there
  is no Bulgarian-script name in the dataset.
- The simplified outline is a context layer, not a legal boundary: a point near a border
  can fall on the wrong side by up to the simplification tolerance.
