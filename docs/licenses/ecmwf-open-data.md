# ECMWF Open Data — IFS/AIFS real-time forecasts

| Field | Value |
|---|---|
| Source | ECMWF Open Data (real-time open dissemination of IFS/AIFS forecasts, 0.25°, GRIB2) |
| Canonical source id (A10) | none — not a detection source; feed id `weather:context`, outside the frozen `source_registry_v1` |
| Adapter | `server/src/adapters/weather/ecmwf-http-client.ts` (`.index` sidecar + GRIB2 byte-range GET against `https://data.ecmwf.int/forecasts`) |
| Licence identifier | **CC BY 4.0**, plus the **ECMWF Terms of Use for Open Data Products/Advanced Web Services**, which apply *in addition* to it |
| Terms retrieved from | `https://www.ecmwf.int/en/forecasts/datasets/open-data` and `https://apps.ecmwf.int/datasets/licences/general/` |
| Terms verified upstream | 2026-08-15 — both pages fetched and transcribed directly for this file |
| Pinned into this file | 2026-08-15 |
| Commercial use | Yes — stated on the dataset page (quoted below) |
| Redistribution of derived products | Yes, under CC BY 4.0 attribution + the ECMWF notices below |

## Governing terms

Two documents govern, and the second is the one that carries the obligations we have to
implement. CC BY 4.0 itself is a long standard licence, named here and published at
`https://creativecommons.org/licenses/by/4.0/` rather than pasted in full.

### From the dataset page — `https://www.ecmwf.int/en/forecasts/datasets/open-data`

> A subset of ECMWF real-time forecast data from the IFS and AIFS models is made
> available to the public free of charge. Their use is governed by the Creative Commons
> CC-BY-4.0 licence and the ECMWF Terms of Use. This means that the data may be
> redistributed and used commercially, subject to appropriate attribution.

That page links the licence as `https://creativecommons.org/licenses/by/4.0/deed.en` and
the Terms of Use as `https://apps.ecmwf.int/datasets/licences/general/`.

### From the Terms of Use — `https://apps.ecmwf.int/datasets/licences/general/`

Page heading, verbatim: *"Use of data accessed via this service"*, subtitle *"Terms of Use
for ECMWF Open Data Products/Advanced Web Services, applied in addition to the Creative
Commons CC-4.0-BY licence."*

> Access to this dataset is governed by the following Terms of Use in addition to the
> Creative Commons CC-4.0-BY licence:
>
> ECMWF retains all Intellectual Property Rights and copyright over its data.
>
> ECMWF must be acknowledged (attributed) as the source. Attribution must be displayed
> prominently and include ‘this document/data/output/Results is/are based on data and
> products of the European Centre for Medium-Range Weather Forecasts (ECMWF)’. Users must
> remove attribution if requested by ECMWF.
>
> ECMWF does not accept any liability whatsoever for any error or omission in the data,
> their availability, or for any loss or damage arising from their use.
>
> ECMWF makes no warranty as to the accuracy or completeness of its data products or the
> uninterrupted provision of such data products. All data products are provided on an "as
> is" basis. Any warranty implied by statute or otherwise is hereby excluded to the
> fullest extent permissible by law.
>
> ECMWF shall not be liable should ECMWF discontinue the provision of its data products at
> any time.
>
> In order to receive services related to the provision of this dataset, users are
> required to sign a service agreement with ECMWF in the format available here:
> https://www.ecmwf.int/sites/default/files/2026-01/ecmwf-service-agreement.pdf

And the CC BY 4.0 restatement, with the two wording blocks that follow it:

> This data product is published under a Creative Commons Attribution 4.0 International
> (CC BY 4.0). To view a copy of this licence, visit
> https://creativecommons.org/licenses/by/4.0/
>
> You are free to:
>
> Share — copy and redistribute the material in any medium or format
>
> Adapt — remix, transform, and build upon the material for any purpose, even
> commercially.
>
> Under the following terms:
>
> You must give appropriate credit (attribution) to ECMWF as outlined below, provide a
> link to the licence, and indicate if changes were made.
>
> No additional restrictions — You may not apply legal terms or technological measures
> that legally restrict others from doing anything the licence permits.

> The following wording shall be attached to the use of this ECMWF data product:
>
> Copyright statement: Copyright "© [year] European Centre for Medium-Range Weather
> Forecasts (ECMWF)".
>
> Source www.ecmwf.int
>
> Licence Statement: This data is published under a Creative Commons Attribution 4.0
> International (CC BY 4.0). https://creativecommons.org/licenses/by/4.0/
>
> Disclaimer: ECMWF does not accept any liability whatsoever for any error or omission in
> the data, their availability, or for any loss or damage arising from their use.
>
> Where applicable, an indication of whether the material has been modified and an
> indication of previous modifications.

> The following wording shall be attached to the services created with this ECMWF data
> product:
>
> Copyright statement: Copyright "This service is based on data and products of the
> European Centre for Medium-Range Weather Forecasts (ECMWF)".
>
> Source www.ecmwf.int
>
> Licence Statement: This ECMWF data is published under a Creative Commons Attribution 4.0
> International (CC BY 4.0). https://creativecommons.org/licenses/by/4.0/
>
> Disclaimer: ECMWF does not accept any liability whatsoever for any error or omission in
> the data, their availability, or for any loss or damage arising from their use.
>
> Where applicable, an indication if the material has been modified and an indication of
> previous modifications

## Attribution we must display

**Ours is the *service* case, not the direct-data case.** We do not republish ECMWF GRIB
fields; we compute from them (own-FWI inputs, wind/RH context, precipitation
corroboration, the `tcc` cloud stopgap) and publish a derived product. So the second
wording block above is the one that binds, and the first is recorded only so the
distinction is auditable.

The four components ECMWF dictates, verbatim, in the order the Terms give them:

```
This service is based on data and products of the European Centre for Medium-Range Weather Forecasts (ECMWF)
```

```
Source www.ecmwf.int
```

```
This ECMWF data is published under a Creative Commons Attribution 4.0 International (CC BY 4.0). https://creativecommons.org/licenses/by/4.0/
```

```
ECMWF does not accept any liability whatsoever for any error or omission in the data, their availability, or for any loss or damage arising from their use.
```

Plus, as a **mandatory fifth component for us**, an indication that the material has been
modified. It is *not* optional here: ECMWF qualifies it with "where applicable", CC BY 4.0
independently requires "indicate if changes were made", and everything we publish from
this feed is resampled, interpolated or fed into a derived index — so it applies, always.
ECMWF does not dictate the wording of that indication, only that it be present; the
following is therefore **our wording, not a provider-mandated string**, and it is the one
thing on this page a reviewer may re-word:

```
ECMWF data has been modified.
```

Three properties of the attribution are obligations, not styling:

1. **Prominent.** The Terms say "Attribution must be displayed prominently" — it belongs
   in the always-visible credits block on the map surface, not on a buried about page and
   not behind an expander that defaults to closed.
2. **Complete.** All five components travel together. The credit line alone, without the
   source, licence link and disclaimer, does not satisfy the Terms.
3. **Revocable.** "Users must remove attribution if requested by ECMWF" — a removal
   request is a code change, handled like any other licence event.

### Which surface must render it

Every surface that shows an ECMWF-derived value: the web map's credits block (the
attribution registry `packages/contracts/src/credits.ts`, rendered into the always-visible credits
line, asserted by CI-13 against `docs/DATA-SOURCES.md` § "Attribution strings — verbatim").

**Landed:** `credits.ts` carries the five components as five entries — `ecmwf-service`,
`ecmwf-source`, `ecmwf-licence`, `ecmwf-liability`, `ecmwf-modified` — sharing the
`derived:ecmwf` condition and the `credits-page` surface, plus `ecmwfComponents()`, which
returns them as one unit and throws if any is missing. The split is a registry constraint,
not a licence one: the registry's shape is one string per entry, and the obligation is five
strings that must appear together, so the unit lives in the function rather than in a row.
Only the first four are ECMWF's wording and immovable; `ecmwf-modified` is ours, mandatory
for us regardless of the Terms' "where applicable", because everything we publish from this
feed is resampled, interpolated or fed into a derived index.

**Still not enforceable in code:** the Terms require the attribution be displayed
*prominently*. `credits.ts` can say which surface owes it; it cannot say the surface renders
it above the fold rather than behind a collapsed expander. That remains a review obligation
on whoever builds the credits page.

## Conditions that bind our code

- **No registration, no key** — plain HTTPS, so this adapter has no secret to redact
  (C8's redactor still covers its error strings, which carry only a label, never the URL).
- **Attribution before exposure**: an ECMWF-derived value may be computed and stored
  without the credit line, but must not reach a user surface before the credits entry
  exists. The internal-computation clearance below is what the current wave runs on.
- **Range discipline is an etiquette obligation as much as a disk-space one**: the client
  refuses anything but a 206 with the exact requested byte count and cancels a 200 body
  rather than draining a multi-hundred-megabyte run file off a free public service.
- **No additional restrictions** (CC BY 4.0, restated in the Terms): our own API must not
  re-license ECMWF-derived output under terms stricter than CC BY 4.0 permits.

## Open items

1. **Service-agreement clause, interpretation not established.** "In order to receive
   services related to the provision of this dataset, users are required to sign a service
   agreement with ECMWF" — our reading is that this governs *services ECMWF provides to a
   user* (support, guaranteed dissemination), not anonymous public GETs against
   `data.ecmwf.int`, and that reading is consistent with the dataset page offering the data
   "to the public free of charge". **That reading is ours and is not stated on either
   page.** If we ever ask ECMWF for anything beyond anonymous access, this clause is the
   first thing to re-read.
2. **Wording of the modification indication is ours** (see above) — the obligation is
   established, the sentence is not quoted from ECMWF.
3. **No `credits.ts` entry and no rendered block yet** — the surface requirement above is
   recorded, not implemented; `web/` belongs to another session.
4. `docs/reviews/09-legal-licensing.md` predates the ECMWF decision (A19, TASKS line 240)
   and therefore contains **no** ECMWF section; the legal review has never examined this
   source. The terms are now pinned here from primary sources, but a licensing pass should
   still cover item 1.
5. Governing law is **England and Wales** with ICC arbitration in London, and ECMWF holds
   privileges and immunities as an international organisation — noted because it changes
   who a dispute would be with and where, not because it changes what we render.

With the terms pinned, ECMWF Open Data is cleared for **internal computation** and for
**publication of derived products**, on condition that the five-component attribution
above is rendered prominently on any surface that shows an ECMWF-derived value.
