# NASA FIRMS / LANCE — VIIRS and MODIS active fire

| Field | Value |
|---|---|
| Source | NASA Fire Information for Resource Management System (FIRMS), part of LANCE / ESDIS |
| Canonical source ids (A10) | `firms:viirs:snpp`, `firms:viirs:noaa20`, `firms:viirs:noaa21` (active); `firms:modis` (retired at the v1 freeze — archive, backfill and fixture replay only) |
| Adapter | `server/src/adapters/firms/firms-http-client.ts` (FIRMS Area API, CSV) |
| Licence identifier | **CC0 1.0** — NASA-led mission data, as published by NASA's data-use guidance; plus the LANCE redistribution disclaimer (a requested notice, not a licence restriction) |
| Terms retrieved from | `https://www.earthdata.nasa.gov/data/tools/firms` · `https://firms.modaps.eosdis.nasa.gov` · `https://www.earthdata.nasa.gov/data/tools/firms/faq` |
| Terms verified upstream | 2026-07-22 (`docs/reviews/09-legal-licensing.md` §2.2.A, quoted from the pages above) |
| Pinned into this file | 2026-08-15 |
| Commercial use | Yes — no restriction on commercial use or derived products |
| Redistribution of derived events | Yes |

## Governing terms (verbatim)

CC0 1.0 Universal is a long standard instrument and is **not** reproduced here in full;
it is named above and published at `https://creativecommons.org/publicdomain/zero/1.0/`.
The operative clauses that make it apply to this data, and the two conditions that ride
alongside it, are quoted verbatim:

> Unless the content is marked with a use restriction or license, data provided from a
> NASA-led mission are licensed as Creative Commons Zero (CC0).

> NASA material may not be used to suggest or imply endorsement by NASA.

LANCE near-real-time data, when provided onward to third parties (which our map and our
alerts do), carries a disclaimer NASA asks to be **replicated or linked**:

> [data] are provided "as is" and users bear all responsibility and liability for their
> use

> Due to the spatial resolution and other characteristics of these data, their use for
> tactical decision-making or informing about conditions at a local scale are not advised.

## Attribution we must display

Byte-identical to `docs/DATA-SOURCES.md` rows 4 and 5 and to `packages/contracts/src/credits.ts`
(`firms-acknowledgement`, `lance-tactical-disclaimer`, `lance-as-is`):

```
We acknowledge the use of data and/or imagery from NASA's Fire Information for Resource Management System (FIRMS), part of NASA's Land, Atmosphere Near real-time Capability for Earth observations (LANCE) and NASA's Earth Science Data and Information System (ESDIS).
```

```
Due to the spatial resolution and other characteristics of these data, their use for tactical decision-making or informing about conditions at a local scale are not advised.
```

```
are provided "as is" and users bear all responsibility and liability for their use
```

Surfaces: the acknowledgement and the tactical-decision disclaimer render on `/credits`
and About, and the disclaimer is linked from alert footers. The map corner carries the
short form `Fire data: NASA FIRMS · EUMETSAT LSA SAF` as part of the assembled line.

## Conditions that bind our code

- **The MAP_KEY is a quota credential, not a licence condition.** The key and the
  5,000-transactions-per-10-minute limit are technical rate control; they place no
  restriction on reuse of the data obtained. They do place a *security* obligation on us:
  the FIRMS Area API carries the key **as a URL path segment**
  (`…/api/area/csv/<MAP_KEY>/<PRODUCT>/…`), so every log line, error message and
  exception that can carry a FIRMS URL must pass through the redactor
  (`server/src/core/observability/redact.ts`, TASKS C8).
- **No NASA logos, no implied endorsement** — this constrains UI and marketing copy, not
  the ingest path.
- **The tactical-decision language is mirrored in our own disclaimer** (09 §3.4), which
  is also our liability posture, not merely a courtesy to NASA.

## Open items

- The wording above was verified against the provider on **2026-07-22** and transcribed
  here on 2026-08-15; it was **not** independently re-fetched from NASA on the pinning
  date. Re-verify at GATE-MVP before the first public map.
- NASA restructured its Earthdata pages during 2025–2026; if a URL above 404s at
  re-verification, resolve the current data-use page before editing the quotes, and
  record both URLs.
