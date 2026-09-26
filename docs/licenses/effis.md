# EFFIS — fire danger (FWI) and burnt areas

| Field | Value |
|---|---|
| Source | European Forest Fire Information System (EFFIS), a Copernicus Emergency Management Service component operated by the JRC |
| Canonical source id (A10) | none — EFFIS is not a detection source; it is the feed id `effis:layers` (FWI WMS raster + burnt-area WFS), outside the frozen `source_registry_v1` |
| Adapter | `server/src/adapters/effis/effis-http-client.ts` (WMS `GetMap`, WFS `GetFeature`) |
| Licence identifier | **CC BY 4.0** for EU-owned content, per the EFFIS Data License page (EU reuse policy) |
| Terms retrieved from | `https://forest-fire.emergency.copernicus.eu/about-effis/data-license` (GWIS equivalent: `https://gwis.jrc.ec.europa.eu/about-gwis/data-license`) |
| Terms verified upstream | 2026-07-22 (`docs/reviews/09-legal-licensing.md` §2.2.E) |
| Pinned into this file | 2026-08-15 |
| Commercial use | Yes |
| Redistribution of derived events | Yes, with credit and an indication of changes |

## Governing terms

CC BY 4.0 is a long standard licence and is **not** reproduced here in full; it is named
above and published at `https://creativecommons.org/licenses/by/4.0/legalcode`. The
operative obligations for our use are: give appropriate credit, provide a link to the
licence, and indicate if changes were made — which our clustering, filtering and
re-rendering unambiguously are.

Governing terms as established from the EFFIS Data License page (review 09 §2.2.E):

- EU-owned content is released under **CC BY 4.0** — reuse, including commercial reuse,
  is allowed with credit and an indication of changes.
- Third-party content embedded in the EFFIS site can carry other rights. We consume only
  the EU-produced service outputs (the FWI fire-danger forecast layers and the burnt-area
  perimeters), which are EU-owned.
- Because EFFIS is a Copernicus service, the CC BY credit is paired with the Copernicus
  service notice (see below).

## Attribution we must display

Byte-identical to `docs/DATA-SOURCES.md` rows 11 and 12 and to `packages/contracts/src/credits.ts`
(`copernicus-service`, `effis`); `[YEAR]` is substituted at render time with the year of
publication or distribution of the data actually used:

```
Contains modified Copernicus Service information [YEAR]
```

```
© European Union, [YEAR], European Forest Fire Information System (EFFIS)
```

The second string is **our chosen form, not a provider-mandated one**: EFFIS publishes no
canonical attribution string, and CC BY 4.0 requires only "appropriate credit". That
choice is recorded here so it cannot later be mistaken for a quoted requirement.

## Conditions that bind our code

- **Indicate changes.** Satisfied product-wide by the derivation sentence (DATA-SOURCES
  row 20) plus per-layer labelling of proxied EFFIS rasters as EFFIS output rather than
  our own analysis.
- **No registration, no key** — the WMS/WFS endpoints are open, so this adapter has no
  secret to redact. It does carry an operational duty instead: the endpoints are services
  without an SLA, so the cached proxy and the refresh cadence in
  `server/src/app/refresh-wiring.ts` are usage etiquette, not just performance work.

## Open items

- **Redistributing the raw danger rasters via an API is not cleared.** The fire-danger
  layers are computed from ECMWF / Météo-France meteorological inputs whose underlying
  rights the EFFIS licence page does not address (09 §2.2.E, flagged ⚖). Display of the
  EU-published layer is EFFIS's problem, not ours; re-serving the rasters as a product
  feature needs a written question to EFFIS first. This is a GATE-v2 item.
- Verified upstream on 2026-07-22 and transcribed here on 2026-08-15; not independently
  re-fetched from the provider on the pinning date.
