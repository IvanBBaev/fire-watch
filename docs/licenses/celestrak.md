# CelesTrak — GP orbital elements (satellite-pass predictions)

| Field | Value |
|---|---|
| Source | CelesTrak General Perturbations (GP) element sets, OMM as JSON: `https://celestrak.org/NORAD/elements/gp.php?CATNR=<norad>&FORMAT=JSON` |
| Canonical source id (A10) | none — an input to a derived product (pass times), not a detection feed |
| Used by | `server/src/core/passes/tle-refresh.ts` (fetch every 12 h), `server/src/adapters/celestrak/celestrak-http-client.ts`; derived output `/api/v1/passes/<cell>` (TASKS F15; `docs/DATA-SOURCES.md` §F15) |
| Licence identifier | **None published** — no licence or terms-of-use page was found (see Open items) |
| Usage policy retrieved from | https://celestrak.org/NORAD/documentation/gp-data-formats.php |
| Policy retrieved | 2026-09-30 |
| Pinned into this file | 2026-09-30 |
| Commercial use | Not addressed by any text found |

## Usage policy (paraphrased — see Open items)

The following points are recorded as read on the GP data documentation page on
2026-09-30. They were captured through a summarising fetch, **not copied verbatim**, and
must be re-checked against the page before being quoted anywhere:

- CelesTrak checks for new GP data once every 2 hours, so clients have no need to check
  more often.
- 50 HTTP errors (301, 403, 404) within 2 hours cause the client to be blocked by the
  firewall; there is also a bandwidth limit of roughly 100 MB per day.
- A 403 or 404 will not change by repeating the request.
- Automated processes should stop on errors and report to a human rather than retry.
- Citing CelesTrak as the source of the data is requested.

## How we comply

- **Cadence:** one request per platform every 12 hours (10 requests/day, a few kB each).
- **Stop on error:** any non-200 answer writes the halt latch `tle/celestrak/halt.json` and
  no further request is made — across restarts — until an operator reads the reason and
  deletes the file. Redirects are not followed, so a 301 also latches.
- **No redistribution:** raw elements never leave the server. The public document carries
  derived pass times, the element epoch and its age only.
- **Citation:** requested, not required; see below.

## Attribution we display

Our chosen form (CelesTrak prescribes no sentence), on `/credits` and in the Layers
panel's pass section (`credits.ts` id `celestrak`, `required: false`,
`docs/DATA-SOURCES.md` attribution row 25):

`Orbital elements: CelesTrak (celestrak.org)` — hyperlinked to `https://celestrak.org/`.

## Open items

- **No terms-of-use text found.** `webmaster.php` carries none and the linked columns page
  returned 404 on 2026-09-30. Before GATE-v1 the founder should either locate published
  terms or ask CelesTrak directly whether serving derived pass times commercially is fine.
- **Policy is paraphrased.** The points above must be replaced by verbatim quotations,
  with the retrieval date, the next time the page is read by hand.
- The underlying element sets originate with the US Space Force (18th/19th SDS via
  Space-Track); whether that origin carries its own terms for derived use is not checked.
