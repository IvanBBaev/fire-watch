# Copernicus EMS Rapid Mapping — wildfire activations (event-page badge)

| Field | Value |
|---|---|
| Source | Copernicus Emergency Management Service, Rapid Mapping: the activation list and per-activation AOI extents behind the public dashboard, `https://rapidmapping.emergency.copernicus.eu/backend/dashboard-api/public-activations/` |
| Canonical source id (A10) | none — context for an event, not a detection feed; freshness row `cems:activations` |
| Used by | `server/src/core/cems/cems-refresh.ts` (hourly), `server/src/adapters/cems/cems-http-client.ts`; served as `/overlays/cems/activations.json`; rendered by `web/src/ui/event/cems-badge.tsx` (TASKS V2-E3; `docs/DATA-SOURCES.md` §V2-E3) |
| Terms | Copernicus EMS Mapping Terms and Conditions, `https://mapping.emergency.copernicus.eu/terms-and-conditions/` |
| Citation | Copernicus EMS Citation Guidelines, `https://mapping.emergency.copernicus.eu/about/citation-guidelines/` |
| Legal basis | Regulation (EU) 2021/696 (Union Space Programme), Copernicus full, free and open data policy |
| Retrieved | 2026-10-24 |
| Commercial use | Allowed by the terms as read (reproduction and distribution, source to be cited) |

## Terms (paraphrased — see Open items)

Read on 2026-10-24 through a fetch of the pages, recorded as paraphrase:

- Reproduction and distribution of the mapping products and information are allowed.
- Recipients must be informed of the source, in the form the Citation Guidelines give.
- Data and products are provided "as is", without warranty.

## Citation form (as given by the guidelines)

Per activation: `Copernicus Emergency Management Service (© <activation year> European
Union), <activation id>` — the guidelines' example is `Copernicus Emergency Management
Service (© 2025 European Union), EMSR780`.

## How we comply

- **Cadence:** the list once an hour (one to a few pages of 50), detail reads only for
  candidates near coverage and only when `lastUpdate` changes; activations known to be
  outside coverage are remembered and not read again.
- **What we keep:** code, name, times, countries, centroid and AOI bounding boxes for
  in-coverage wildfire activations only. No map products are copied; the badge links to
  the activation's page on `mapping.emergency.copernicus.eu`.
- **Restricted activations:** a 403 detail is stored as `restricted` and no AOI is kept.
- **Citation:** each badge's link title carries the per-activation citation above;
  `/credits` carries `Copernicus Emergency Management Service (© [YEAR] European Union),
  Rapid Mapping activation list` (`credits.ts` id `copernicus-ems`, `required: true`,
  `docs/DATA-SOURCES.md` attribution row 28). The route's `attribution` carries the same
  credit with the year of the list read.

## Open items

- **The API is undocumented.** It is the JSON backend of the public dashboard; there is no
  published schema, rate limit or stability promise. If Copernicus publishes an official
  feed, move to it. The parser fails closed (an unparsable page fails the cycle and the
  route turns 503 after 6 h).
- **Terms are paraphrased.** Replace with verbatim quotations the next time the pages are
  read by hand.
- **Credit wording.** The guideline names one activation; the `/credits` line names the
  list, with words of ours after the guideline's prefix. Founder to confirm.
