# EUMETSAT — LSA SAF FRP-PIXEL, and the EUMETSAT Data Policy generally

| Field | Value |
|---|---|
| Source | EUMETSAT Land Surface Analysis SAF (LSA SAF) fire-radiative-power products; governed by the EUMETSAT Data Policy, which also governs the FCI/SEVIRI cloud-mask sidecar |
| Canonical source ids (A10) | `lsasaf:seviri:frp-pixel` (LSA-502, MSG/SEVIRI, Operational), `lsasaf:fci:frp-pixel` (LSA-509, MTG/FCI, Demonstration); plus the unregistered feed id `eumetsat:clm` |
| Adapter | decoder landed — `server/src/adapters/sandbox/child-process-decoder.ts` (HDF5→JSON in a sandboxed child, TASKS C3); **fetch adapter not yet landed** (needs Data Store credentials) |
| Licence identifier | **CC BY 4.0** — EUMETSAT Data Policy (last amended **27 June 2024**), Art. 5.1, applied to SAF products via Art. 20 ("Core") |
| Terms retrieved from | `https://www.eumetsat.int/legal-framework/data-policy` · `https://www-cdn.eumetsat.int/files/2024-07/45173%20-%20Data%20Policy(1419774%20V1).pdf` · `https://lsa-saf.eumetsat.int/en/data/data-access/` · `https://lsa-saf.eumetsat.int/en/data/products/fire-products/` |
| Terms verified upstream | 2026-07-22 (`docs/reviews/09-legal-licensing.md` §2.2.B and §2.2.C, quoted from the canonical PDF and the LSA SAF pages) |
| Pinned into this file | 2026-08-15 |
| Commercial use | Yes, for Core Data and Products (all SAF products are Core) |
| Redistribution of derived events | Yes for Core (Art. 6.1); **prohibited** for the original numerical data of "Recommended" tier products (Art. 6.2) |

## Governing terms (verbatim)

CC BY 4.0 itself is a long standard licence, named above and published at
`https://creativecommons.org/licenses/by/4.0/legalcode`. The clauses of the EUMETSAT
Data Policy that select it, and that fence the one tier we must not redistribute, are
quoted verbatim from the amended policy (27 June 2024):

> **Art. 5.1** — Access to Core Data and Products is granted to all users world-wide on
> a Free and Unrestricted basis under a CC-BY-4.0 licence

> **Art. 6.1** — Users may redistribute all Core Data and Products.

> **Art. 20** — All SAF products are categorised as 'Core' products

> **Art. 6.3** (attribution pattern) — [Contains modified] EUMETSAT [Meteosat/Metop]
> [data/product] [Year of publication or distribution]

Tier caveat, as established in review 09 §2.2.B: Art. 4 places Level-1 data with latency
**< 1 h** in the "Recommended" tier ("may be subject to fees"), and **Art. 6.2 prohibits
redistribution of "the original numerical data of Recommended Data"**. Access to the LSA
SAF archive/data service requires free registration — an access mechanism, not a use
restriction.

LSA SAF attribution formats, as verified from the LSA SAF data-access pages:

> figures/maps: EUMETSAT LSA SAF [Product Acronym, Product Identifier]

> text: Data source: EUMETSAT LSA SAF, [product], [acronym]

## Attribution we must display

Byte-identical to `docs/DATA-SOURCES.md` rows 7 and 8 and to `packages/contracts/src/credits.ts`
(`eumetsat-meteosat`, `lsa-saf-short`, `lsa-saf-long`):

```
Contains modified EUMETSAT Meteosat data [YEAR]
```

```
EUMETSAT LSA SAF
```

```
Data source: EUMETSAT LSA SAF, FRP-PIXEL (LSA-502 / LSA-509)
```

Surfaces: the short form in the map corner while an LSA SAF layer is in use, the long
form on `/credits`. The legacy "…provided by the EUMETSAT Satellite Application Facility
on Land Surface Analysis (LSA SAF; Trigo et al., 2011)" sentence is **not** the UI credit;
keep the Trigo et al. 2011 reference (doi:10.1080/01431161003743199) for scientific
publications only.

## Conditions that bind our code

- **Ingest fire products through LSA SAF (Core), not through raw near-real-time FCI L1c.**
  If a direct FCI L1/L2 feed is ever added, its tier must be checked *before* the adapter
  is written: a Recommended-tier feed would make redistribution of its original numericals
  a licence breach, not a config mistake. `eumetsat:clm` (the cloud-mask sidecar) rides on
  the same policy and needs the same check when its adapter lands.
- **Data Store credentials are secrets.** The fetch adapter is not written yet; when it
  is, its credentials go through `server/src/app/config.ts` and are registered with the
  redactor (`server/src/core/observability/redact.ts`) in the same PR, exactly as
  `FIRMS_MAP_KEY` is.
- **LSA-509 is Demonstration status** — no continuity or quality guarantee. Operational,
  not legal: alerts must not depend on LSA-509 alone.

## Open items

- **The FCI-derived redistribution question is re-verified at GATE-v2** (09 §1): raw
  FCI-derived redistribution via a paid API is permitted today under the pinned policy
  version, but the policy version — not just the URL — is what we are relying on. If
  EUMETSAT amends the policy again, this file's date is the evidence of what applied
  when.
- Verified upstream on 2026-07-22 and transcribed here on 2026-08-15; not independently
  re-fetched on the pinning date. The canonical PDF is versioned in its filename, so a
  changed URL is itself the signal that the policy was amended.
- The Data Store product-specific licence text accepted at registration has **not** been
  transcribed (no registration has been performed yet). It must be pinned into this file
  in the PR that lands the fetch adapter — `docs/DATA-SOURCES.md` flags exactly this
  ("licence accepted at registration — confirm per-product text").
