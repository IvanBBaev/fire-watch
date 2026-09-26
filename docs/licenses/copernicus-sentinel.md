# Copernicus Sentinel data — Sentinel-3 SLSTR FRP (and any Sentinel-derived layer)

| Field | Value |
|---|---|
| Source | Copernicus Sentinel data — Sentinel-3 SLSTR Level-2 FRP (`SL_2_FRP___`), disseminated via the EUMETSAT Data Store / CDSE |
| Canonical source id (A10) | `eumetsat:slstr:frp` (registered, NRT tier) |
| Adapter | **none yet** — wave 2; no `server/src/adapters/**` code fetches this feed |
| Licence identifier | EU legal notice on Copernicus Sentinel Data and Service Information (Regulation (EU) No 377/2014; Commission Delegated Regulation (EU) No 1159/2013, Arts. 7–9) — free, full and open |
| Terms retrieved from | `https://sentinels.copernicus.eu/documents/247904/690755/Sentinel_Data_Legal_Notice` · `https://dataspace.copernicus.eu/terms-and-conditions` |
| Terms verified upstream | 2026-07-22 (`docs/reviews/09-legal-licensing.md` §2.2.D, quoted from the Commission PDF) |
| Pinned into this file | 2026-08-15 |
| Commercial use | Yes — no field-of-use limits |
| Redistribution of derived events | Yes — adaptation, modification and combination are expressly covered |

## Governing terms (verbatim)

This is a short EU legal notice rather than a standard public licence; its operative
clauses are quoted verbatim:

> free, full and open access to Copernicus Sentinel Data and Service Information without
> any express or implied warranty

covering

> (a) reproduction; (b) distribution; (c) communication to the public; (d) adaptation,
> modification and combination with other data and information; (e) any combination of
> points (a) to (d)

— in so far as lawful. Required notices, verbatim:

> unmodified: 'Copernicus Sentinel data [Year]'

> modified: 'Contains modified Copernicus Sentinel data [Year]'

> service outputs: 'Contains modified Copernicus Service information [Year]'

The notice carries a **reciprocal waiver**: by using the data we renounce damage claims
against the EU and the data providers. Upstream outages are therefore contractually our
problem, which is where the force-majeure clause in the ToS comes from (09 §3.4).

Dissemination-platform terms sit on top of, and do not narrow, the above: CDSE T&C add
operational quotas and prohibit reselling *portal content* as such; they do not restrict
reuse of the Sentinel data itself. Sentinel-3 obtained through the **EUMETSAT** Data Store
is additionally covered by the EUMETSAT Data Policy — see `eumetsat-lsa-saf.md`, which
pins Art. 5.1 / 6.1 / 6.2 / 6.3 and the "Recommended" tier caveat.

## Attribution we must display

Byte-identical to `docs/DATA-SOURCES.md` rows 9, 10 and 11 and to
`packages/contracts/src/credits.ts` (`sentinel-modified`, `sentinel-unmodified`,
`copernicus-service`). Our normal case is the modified form, because every Sentinel input
reaches the product through clustering or re-rendering:

```
Contains modified Copernicus Sentinel data [YEAR]
```

```
Copernicus Sentinel data [YEAR]
```

```
Contains modified Copernicus Service information [YEAR]
```

## Conditions that bind our code

- **Pick the right notice by what we did to the data**, not by habit: unmodified renders
  take the plain form, everything derived takes "Contains modified …". Service outputs
  (EFFIS) take the *Service information* form, not the *Sentinel data* form.
- **Data Store / CDSE credentials are secrets** — when the wave-2 adapter lands, they are
  registered with the redactor (`server/src/core/observability/redact.ts`) in the same PR.

## Open items

- **No adapter exists**, so nothing here is exercised yet; the file is pinned in advance
  because `eumetsat:slstr:frp` is already a frozen id in `source_registry_v1` and the
  attribution strings are already in CI-13's assertion set through the Sentinel rows.
- Verified upstream on 2026-07-22 and transcribed here on 2026-08-15; not independently
  re-fetched on the pinning date. Re-verify when the wave-2 adapter is written, together
  with the per-product Data Store licence text.
