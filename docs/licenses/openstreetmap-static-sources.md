# OpenStreetMap — the static hot-source mask (TASKS F16)

| Field | Value |
|---|---|
| Source | OpenStreetMap data, extracted through the Overpass API (`https://overpass-api.de/api/interpreter`) |
| Canonical source id (A10) | none — a build-time asset, not a detection feed |
| Asset | `web/src/assets/geodata/static-sources.json` (format `fire-watch/static-sources@1`), built by `pnpm run geodata:static-sources` (`infra/geodata/static-sources*.ts`); register entry DS-5 in `docs/data/DATASETS.md` |
| Consumers | the server scorer (11 §3.6 override, `server/src/core/static-sources/`), the web event-detail caveat and the Layers-panel mask layer |
| Licence identifier | **ODbL 1.0** — the asset is a *derivative database* of OSM (a filtered, simplified extract), not a produced work |
| Terms retrieved from | `https://opendatacommons.org/licenses/odbl/1-0/` · `https://www.openstreetmap.org/copyright` · `https://osmfoundation.org/wiki/Licence/Attribution_Guidelines` · `https://osmfoundation.org/wiki/Licence/Community_Guidelines/Collective_Database_Guideline` |
| Terms verified upstream | 2026-07-22 (`docs/reviews/09-legal-licensing.md` §2.2.F — the same OSM terms as `openstreetmap-basemap.md`); not independently re-fetched for this file |
| Pinned into this file | 2026-09-30 |
| Commercial use | Yes |
| Share-alike reach | **The asset itself** (it is published to every browser). Not FireEvents, if the separation rules below hold |

## Governing terms

ODbL 1.0 is a long standard licence, named and linked above; the operative points for
this asset, paraphrased with the section they come from:

- **§4.2 / §4.3 Notice.** Anyone who publicly uses or redistributes a derivative database
  must keep the licence notice with it and make clear that it is available under ODbL.
  The asset carries `"licence": "ODbL-1.0"` and `"attribution": "© OpenStreetMap
  contributors"` in its own header, so a copy taken out of the bundle keeps both.
- **§4.4 Share-alike.** A derivative database that is *publicly used* must be offered
  under ODbL. The asset is served to every visitor as a static file, so it is offered
  under ODbL, as a whole, by being published with that notice — we claim no other terms
  over it.
- **§4.6 Access.** Publicly using a derivative database obliges us to offer the database
  itself, or the algorithm that produced it. Both are in this repository: the asset is
  the database, and `infra/geodata/static-sources.ts` plus the Overpass query it pins
  (hash in DS-5) are the algorithm.
- **Collective database** (OSMF Collective Database Guideline, quoted in
  `openstreetmap-basemap.md`): our fire database stays a *collective* database with this
  one — no share-alike leak into FireEvents — while content is "either all OSM or all
  non-OSM" per data type and the two "do not reference each other" by database keys.

## Attribution we must display

The same string and link as `docs/DATA-SOURCES.md` row 1 and the `osm` entry of
`packages/contracts/src/credits.ts`, which is owed **always** — the scorer uses the mask
whether or not a reader draws it, so the credit cannot be conditional on the layer:

```
© OpenStreetMap contributors
```

hyperlinked to `https://www.openstreetmap.org/copyright`. The Layers panel repeats it,
with the link, beside the mask toggle while the layer is on.

## Conditions that bind our code

- **No OSM element ids in the asset and none in event records.** The asset stores kind
  and geometry only; the scorer stores only the effect (`score_invalidated`), never which
  mask entry caused it. This is what keeps the fire database and the mask collective.
- **The asset is never mixed with non-OSM rows.** A curated or backfill-derived hot-source
  layer (03 §5.2.4) is a separate asset with its own licence line, not rows appended here.
- **The notice travels with the bytes.** A consumer that copies the file gets the licence
  and attribution fields; the parser rejects a file without them.

## Open items

- **Counsel item.** Whether publishing a simplified extract to browsers is "public use of
  a derivative database" (our reading, and the conservative one) or of a produced work.
  Nothing in the code depends on the answer; the conservative reading costs only this file.
- The OSM terms were verified upstream on 2026-07-22 for the basemap and are applied here
  without an independent re-fetch.
