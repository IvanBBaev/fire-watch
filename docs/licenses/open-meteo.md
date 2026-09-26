# Open-Meteo — fence record (dev-only, not a source of record)

> This file exists to make a **prohibition** auditable. Open-Meteo has no adapter and must
> not acquire one that reaches a public surface. Everything below is the record of why.

| Field | Value |
|---|---|
| Source | Open-Meteo — plain-HTTPS JSON weather API (multi-model, incl. ICON-EU ~7 km) |
| Canonical source id (A10) | none — and none may be minted for a public path |
| Adapter | **none, deliberately.** Permitted uses are dev, recorded fixtures (`open-meteo/*.json`) and the shadow-season cloud proxy through CP1 |
| Licence identifier | **Data**: CC BY 4.0 with attribution. **Free *service* tier**: non-commercial |
| Terms retrieved from | **not established from a primary source — see Open items** |
| Terms verified upstream | not verified against Open-Meteo; the terms below are as recorded in `docs/DATA-SOURCES.md` §D3 and `docs/reviews/09-legal-licensing.md` §2.2.I (commercial-in-trajectory doctrine) |
| Pinned into this file | 2026-08-15 |
| Commercial use | **No** on the free service tier — see the decision below |
| Redistribution of derived events | Not applicable; the feed must not reach a product surface |

## The governing decision (verbatim, `docs/DATA-SOURCES.md` §D3)

> Data licence CC BY 4.0 with attribution; **the free *service* tier is non-commercial**,
> and under the commercial-in-trajectory doctrine (09 §2.2.I) a freemium product with paid
> tiers is commercial use *even during its free stage* — so "season 1 is free, therefore we
> qualify" does not hold.

> Permitted uses: local development and prototyping; recorded `open-meteo/*.json` fixtures
> (ADR-002 acceptance criteria §1); and the shadow-season `cloud_cover` proxy for
> E-accumulator gating **through CP1 only** (§E2, §D6). Not permitted: any public or beta
> surface, and any post-beta alert path. Reversing this needs a PR against this section,
> not a config change.

The $29/month Standard plan was considered and **is not budgeted**: it alone exceeds the
entire infrastructure line (€6–21/mo) and breaks the ≤ €25/mo fixed-cost ceiling (RISKS
R3), while ECMWF Open Data (`ecmwf-open-data.md`) covers the same needs at zero recurring
cost and with no service-tier condition.

## Attribution

Not applicable while the fence holds — nothing derived from Open-Meteo is rendered. If the
fence is ever lifted by a PR against DATA-SOURCES §D3, the CC BY attribution string must be
copied verbatim from the provider into the DATA-SOURCES table and into `credits.ts` **in
that same PR**, and this file rewritten as a normal licence file.

## Conditions that bind our code

- **The distinction that matters is data licence vs. service tier.** The *data* being
  CC BY 4.0 is not permission to call the *free tier* from a commercial product; the tier
  terms are a separate instrument, and they are the binding one.
- The `cloud_cover` proxy is time-boxed to CP1, not merely discouraged. If the FCI/SEVIRI
  CLM sidecar slips, the fallback is ECMWF `tcc` — **never** Open-Meteo on a public
  surface (RISKS watchlist, DATA-SOURCES §E2).

## Open items

- **The provider's terms page is not cited anywhere in this repository**, and no verbatim
  quote of Open-Meteo's own service terms is pinned — the decision above rests on the
  in-repo characterisation of the tier, not on transcribed provider text. That is
  sufficient for a prohibition (it can only be over-cautious), but it would **not** be
  sufficient to lift the fence. Any PR proposing to lift it must first pin the provider's
  actual terms here.
