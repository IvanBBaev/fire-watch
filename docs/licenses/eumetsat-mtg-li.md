# EUMETSAT — MTG Lightning Imager L2 Lightning Flashes (LI-2-LFL)

| Field | Value |
|---|---|
| Source | EUMETSAT Data Store collection `EO:EUM:DAT:0691` — MTG LI Level 2 Lightning Flashes, product type `MTILI2LFL`, platform MTI1 (Meteosat-12), full disc |
| Canonical source id (A10) | none — context layer, not a detection feed (no event is created from a flash) |
| Used by | `server/src/adapters/lightning/eumetsat-datastore-client.ts`, `server/src/adapters/sandbox/mtg-li-flash-decoder.ts`, `server/src/core/lightning/`; served at `/overlays/lightning/recent.json`; web Layers panel "Lightning" (TASKS F18; `docs/DATA-SOURCES.md` §F18) |
| Licence identifier | **CC BY 4.0** — EUMETSAT Data Policy, last amended **25 November 2025**, Art. 5.1; LI products are "Core" per the policy's categorisation table |
| Terms retrieved from | `https://www-cdn.eumetsat.int/files/2026-01/45173%20-%20Data_Policy.pdf` |
| Terms verified upstream | 2026-09-30 (PDF read directly) |
| Pinned into this file | 2026-10-01 |
| Commercial use | Yes (Core Data and Products, CC BY 4.0) |
| Redistribution of derived flashes | Yes (Art. 6.1). The "Recommended" tier covers LI **Level 1** data only; L2 flashes are a Derived Product |

## Governing terms (verbatim)

From the categorisation table ("Core" column, Meteosat-series):

> All SEVIRI, FCI, IRS and LI Derived Products

> **Art. 5.1** — Access to Core Data and Products is granted to all users world-wide on a
> Free and Unrestricted basis under a CC-BY-4.0 licence, regardless of when and how these
> are made available to the user.

> **Art. 6.1** — Users may redistribute all Core Data and Products.

> **Art. 6.3** — Users are required to include the following attribution to EUMETSAT in
> relation to EUMETSAT Data and Products, adapted as appropriate: "[Contains modified]
> EUMETSAT [Meteosat/Metop] [data/product] [Year of publication or distribution]".

The "Recommended" column lists "All Level 1 SEVIRI, FCI, IRS and LI data with a Latency
of less than 1 hour (may be subject to fees)" — Level 1 only; we never fetch LI Level 1.

## Attribution we display

`Contains modified EUMETSAT Meteosat data [YEAR]` — the existing `credits.ts` entry
`eumetsat-meteosat` (`docs/DATA-SOURCES.md` attribution row 7). "Modified" because we
clip, reduce and re-serialise the flashes. Shown in the Layers panel while the lightning
layer is on, on `/credits` (always), and in the route's `attribution` member.

## Open items

- **Account terms not read.** The Data Store asks each account to accept the licence at
  registration; that click-through text has not been seen (no account yet). It must be
  compared with the policy quoted above when the founder creates the account.
- **Data Store fair-use limits** (30 req/s, 10 connections, 5 TB/day per §C2) were not
  re-verified for this collection; our use is ~290 small requests/day.
