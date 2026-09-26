# OpenStreetMap data, and the hosted basemap tiles built from it

| Field | Value |
|---|---|
| Source | OpenStreetMap (map data, place names); OpenFreeMap / OpenMapTiles (hosted vector tiles); Protomaps daily builds (self-hosted PMTiles, if adopted) |
| Canonical source id (A10) | none — the basemap is not a detection feed and has no feed id |
| Consumer | the web map (`web/src/**`), not a server adapter |
| Licence identifier | **ODbL 1.0** for the OSM database; rendered/vector tiles are a "produced work" of that database. OpenFreeMap software is MIT, its data is OSM/OpenMapTiles. Protomaps builds are "free without restriction"; the tileset remains an ODbL produced work |
| Terms retrieved from | `https://osmfoundation.org/wiki/Licence/Attribution_Guidelines` · `https://osmfoundation.org/wiki/Licence/Community_Guidelines/Geocoding_-_Guideline` · `https://osmfoundation.org/wiki/Licence/Community_Guidelines/Collective_Database_Guideline` · `https://www.openstreetmap.org/copyright` |
| Terms verified upstream | 2026-07-22 (`docs/reviews/09-legal-licensing.md` §2.2.F and §2.2.G) |
| Pinned into this file | 2026-08-15 |
| Commercial use | Yes |
| Share-alike reach | **Does not touch our FireEvents** if the separation rules below hold |

## Governing terms

ODbL 1.0 is a long standard licence, named above and published at
`https://opendatacommons.org/licenses/odbl/1-0/`. The community guidelines that decide
how it applies to us are quoted verbatim where they are operative:

- **Produced work.** Rendered basemap tiles are a *produced work* of the OSM database.
  Using them publicly requires attribution, but does not impose share-alike on our
  FireEvents database.
- **Attribution** (OSMF Attribution Guidelines): text attribution to OpenStreetMap,
  canonical form `© OpenStreetMap contributors`, linked to
  `https://www.openstreetmap.org/copyright`, "typically… in a corner of the map"; it may
  collapse after ~5 s or on interaction **only if** the licence info stays reachable —
  e.g. behind an "(i)" control. The same rules apply to the PWA.
- **Geocoding** (OSMF Geocoding Guideline): individual geocoding results are insubstantial
  extracts; stored results

  > may be stored and used together with other proprietary or third party data without
  > having a share-alike impact

  unless the aggregation amounts to

  > a systematic attempt to aggregate all or substantially all Primary Features of a given
  > type within a geographic area city-sized or larger

  Storing one nearest-settlement name per FireEvent (10²–10³/day) is far on the safe side.
- **Collective database** (OSMF Collective Database Guideline): our fire database and OSM
  stay a *collective* database — no share-alike leak — if, per data type, content is
  "either all OSM or all non-OSM" and the datasets "do not reference each other" by
  database keys.

## Attribution we must display

Byte-identical to `docs/DATA-SOURCES.md` rows 1–3 and to `packages/contracts/src/credits.ts`
(`osm`, `openfreemap`, `protomaps`):

```
© OpenStreetMap contributors
```

```
OpenFreeMap © OpenMapTiles Data from OpenStreetMap
```

The OSM line is **mandatory and visible on the map**, hyperlinked to
`https://www.openstreetmap.org/copyright`. In the OpenFreeMap line the "OpenFreeMap" part
is optional; the rest is not. For a self-hosted Protomaps build the OSM line remains
mandatory and the `Protomaps` credit is requested, not required.

## Conditions that bind our code

- **Never store OSM element IDs inside fire-event records.** Store the settlement
  name and coordinates only. This is the single engineering rule that keeps the two
  databases *collective* rather than merged — i.e. that keeps ODbL share-alike away from
  FireEvents. It is a schema constraint, not a style preference.
- **The settlement labels shown in the UI and in alerts are covered by the map's OSM
  attribution plus the About page** — but only while that attribution is actually
  rendered, including on surfaces that show a label without showing a map.
- A collapsing attribution control is allowed; a *missing* one is not.

## Open items

- Verified upstream on 2026-07-22 and transcribed here on 2026-08-15; not independently
  re-fetched on the pinning date.
- The tile provider is not finally chosen (OpenFreeMap hosted vs. self-hosted Protomaps).
  Whichever ships, its row above renders while it is in use; switching providers is an
  attribution change, so it touches `credits.ts` and this file in the same PR.
- Nominatim or any other geocoder we might call has its **own usage policy** on top of
  the ODbL question; it is not pinned here because no geocoder adapter exists yet.
