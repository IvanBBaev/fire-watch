# `docs/licenses/` — pinned licence texts

Attribution is the licence fee (09 §2.3). This directory is where that fee is made
auditable: one file per external data source, each carrying the governing terms **as
text in this repository**, so that a later question ("under what terms were we allowed
to redistribute this in August 2026?") is answered by `git log` rather than by a
provider page that has since been rewritten.

Required by TASKS A23 and review 09 §2.3 item 5 — *"Pin licence versions: copy each
licence/notice text + date into `docs/licenses/` at integration time."*

## The rule

**A new adapter that fetches or displays third-party data does not land without a file
in this directory.** The file is part of the adapter's PR, not a follow-up. Concretely,
a reviewer blocks the PR if any of the following is missing:

1. The **source name and its canonical source id** (A10, `packages/contracts/src/sources.ts`),
   or an explicit note that the feed carries no registered id.
2. The **licence identifier** — a named standard (`CC BY 4.0`, `CC0 1.0`, `ODbL 1.0`)
   or the provider's own instrument (e.g. "EUMETSAT Data Policy, amended 27 June 2024").
3. The **governing terms**: the full text for a short notice, or a **verbatim quote** of
   the operative clauses for a long standard licence — in which case the standard is
   named and linked instead of pasted in full.
4. The **attribution string we must display**, byte-identical to the row in
   `docs/DATA-SOURCES.md` § "Attribution strings — verbatim" and therefore to
   `packages/contracts/src/credits.ts` (CI-13 asserts the rendered block against that table).
5. The **URL the terms were taken from**, and the **date retrieved**.
6. **Open items** — anything that could not be established from a primary source, stated
   as an open item. A guessed licence term is worse than an admitted gap: the gap gets
   closed, the guess gets shipped.

Changing an upstream licence is a *code* event: update the file, update the attribution
table, update `credits.ts`, in one PR.

## Two dates, deliberately

Each file records both:

- **Terms verified upstream** — when the wording was last checked against the provider's
  own page or PDF. For most of this set that is `2026-07-22`, the verification date of
  `docs/reviews/09-legal-licensing.md`, which quoted the primary sources directly. The
  exception is ECMWF Open Data, whose two governing pages were fetched and transcribed
  directly on `2026-08-15` — review 09 never covered that source.
- **Pinned into this file** — when the text was transcribed here (`2026-08-15` for the
  initial set).

They are separate because only the first one carries legal weight. A file pinned today
from a quote verified three weeks ago is still a three-week-old check, and saying so is
the point of the field. Re-verification cadence: at each gate (GATE-MVP / GATE-v1 /
GATE-v2 in 09 §1) and whenever a provider announces a policy change.

## Inventory

| File | Source | Canonical id(s) | Licence | Status |
|---|---|---|---|---|
| [`nasa-firms.md`](./nasa-firms.md) | NASA FIRMS / LANCE — VIIRS + MODIS active fire | `firms:viirs:snpp`, `firms:viirs:noaa20`, `firms:viirs:noaa21`, `firms:modis` | CC0 1.0 + LANCE disclaimer | Adapter landed (C1) |
| [`effis.md`](./effis.md) | EFFIS — fire danger (FWI) + burnt areas | `effis:layers` | CC BY 4.0 | Adapter landed (C4) |
| [`ecmwf-open-data.md`](./ecmwf-open-data.md) | ECMWF Open Data — IFS/AIFS forecasts | `weather:context` | CC BY 4.0 + ECMWF Terms of Use (apply in addition) | Adapter landed (C4); terms pinned from primary sources 2026-08-15, `credits.ts` entry still owed |
| [`eumetsat-lsa-saf.md`](./eumetsat-lsa-saf.md) | EUMETSAT LSA SAF FRP-PIXEL; EUMETSAT Data Policy (also governs the CLM sidecar) | `lsasaf:seviri:frp-pixel`, `lsasaf:fci:frp-pixel`, `eumetsat:clm` | CC BY 4.0 (Core Data) | Decoder landed (C3); fetch adapter pending |
| [`copernicus-sentinel.md`](./copernicus-sentinel.md) | Copernicus Sentinel-3 SLSTR FRP (via EUMETSAT Data Store / CDSE) | `eumetsat:slstr:frp` | EU legal notice (Reg. 377/2014) | Wave 2 — no adapter yet |
| [`openstreetmap-basemap.md`](./openstreetmap-basemap.md) | OpenStreetMap data; OpenFreeMap / OpenMapTiles tiles | — (basemap, no feed id) | ODbL 1.0 (+ produced-work rules) | Rendered by the web map |
| [`open-meteo.md`](./open-meteo.md) | Open-Meteo — **fenced to dev use**, not a source of record | — (must not reach a public surface) | CC BY 4.0 data / non-commercial free *service* tier | Fence record, no adapter |

Sources listed in `docs/DATA-SOURCES.md` as later waves — GIBS, Copernicus DEM GLO-30,
Terrarium terrain, ESA WorldCover, CLC+/CORINE, GHSL, GeoNames, CLMS SWI/SSM, GPM IMERG,
CAMS, Landsat, Esri World Imagery — have **no file here yet, by design**: they get one in
the PR that integrates them. `docs/DATA-SOURCES.md` marks several of their attribution
strings UNVERIFIED for exactly this reason, and they stay out of CI-13's assertion set
until a file in this directory backs them.

## Not legal advice

These files are an engineering record of terms as published, transcribed for auditability.
They are not legal advice and do not replace the counsel items collected in
`docs/reviews/09-legal-licensing.md` §10.
