# Extended Data-Source Analysis — the complete satellite inventory over Bulgaria

*Date: 2026-08-25 (third research pass). Status: reference analysis (no code implied).
Companion to `DATA-SOURCES.md`, which stays the catalog of record for everything waves 1–3
actually consume. Facts verified against primary sources in August 2026 unless marked
UNVERIFIED. Parts continue the base catalog's lettering: **H–N**.*

*The second pass closed seven open questions — the EUMETCast service tier (§I1.1), the
Fengyun access route and its published fire product (§H2.3–H2.4), the Copernicus EMS,
EFFIS and MeteoAlarm licences (§J7, §J9, §J11), the FIRMS source list (§I4.1) and the
launch calendar (§H9) — and opened two new ones: **GDACS states no reuse terms at all**
(§J10), and **no machine-readable Bulgarian fire dataset exists** (§J2).*

*The third pass went looking for sources rather than answers, and found one that matters:
**NOA FireHub** (§J12), a Greek operational service that already does over the Balkans what
§I1 and §I2 propose we build — 5-minute SEVIRI reception through its own antenna,
downscaled to 300–350 m. It also produced three clean rejects with dates (**FireBIRD** ended
in 2019/2020, §H8; **NOAA HMS** is North America only, §H8; **KOMPSAT-3A via ESA Third
Party Missions** is research-purposes-only, §H8), the mirrors question settled (§I5:
**CDSE carries FRP in NTC timeliness, not NRT** — the EUMETSAT Data Store is not
substitutable), and one genuinely new capability: **we can derive fire perimeters from
detections we already have** (§I6). The recurring blocker of this pass was not access and
not price — it was **silence**: FireHub, GDACS and NASA's own `fireatlas` repository all
publish freely and state no terms at all.*

The base catalog answers *"which satellite products does the pipeline consume?"* — a short
list, chosen for licence cleanliness and ease of integration. This document answers the
maximal question: **"what is every satellite that can see a fire in Bulgaria, and what
would it take to receive each one?"** — and only then the non-satellite sources that
validate them.

**The organising fact.** Bulgaria sits at 42–44° N under a crowded sky. Counting only
spacecraft with an operational fire or thermal capability and a usable view of the
Balkans, there are **roughly 20 of them today**, from five operators: NASA/NOAA,
EUMETSAT, ESA/Copernicus, CMA (China) and the commercial sector. The base catalog uses
**five**. The gap is not a shortage of satellites — it is a shortage of **reception
paths**, and that is a hardware problem with a known price.

Two disciplines run through everything below.

**1. Every source has a role.** Adding a signal that can *create* an event is a different
act from adding one that *raises confidence* in an existing event.

| Code | Role | May it create an event? |
|---|---|---|
| **D** | Detection — an independent observation of fire | Yes |
| **L** | Latency — the *same* detection, delivered sooner | Yes (D on a faster path) |
| **C** | Confirmation — raises/lowers confidence in an existing event | **Never** |
| **G** | Ground truth — offline validation and scoring | **Never** |
| **X** | Context — weather, fuel, terrain, smoke, exposure | **Never** |

**2. None of it counts until the pipeline runs.** The client still reads a static fixture;
`C1 — FIRMS Area API poller` is unticked, there is no database and no host. Every source
here multiplies a number that is currently zero. **C1 first, then this document.**

---

# Part H — The satellite inventory

## H0. The daily overpass budget over Bulgaria

This is the table that should drive every decision below. It answers: *at what local times
can we see a fire in Bulgaria, with what, and can we get the data?*

Times are equator-crossing local solar times (LTDN); over Bulgaria at 43° N the actual
pass is typically within ±40 min of these, and a wide-swath imager (2,200–3,000 km) sees
the country on **two consecutive orbits** per crossing, day and night.

| Local time | Satellite | Sensor | Fire-band res. | Operator | In FIRMS? | Reachable free? |
|---|---|---|---|---|---|---|
| ~01:30 | S-NPP, NOAA-20, NOAA-21 | VIIRS | 375 m | NOAA/NASA | **Yes** | Yes (1–3 h) |
| ~02:00 | FY-3D | MERSI-II | 1 km TIR / 250 m SWIR | CMA | No | **NSMC or own dish only** |
| ~05:40 | **FY-3E** | **MERSI-LL** (low-light) | 1 km | CMA | No | **NSMC or own dish only** |
| ~09:30 | Metop-B, Metop-C | AVHRR/3 | 1.1 km | EUMETSAT | No | Yes (Data Store / EARS) |
| ~09:30 | MetOp-SG-A1 | **METimage** | **500 m** | EUMETSAT | No | Yes — new 2025 asset |
| ~10:00 | Sentinel-3A, Sentinel-3B | SLSTR FRP | 1 km | Copernicus | No | Yes (CDSE, §A3) |
| ~10:00 | FY-3C, FY-3F | MERSI-II / MERSI-III | 1 km TIR / 250 m SWIR | CMA | No | **NSMC or own dish only** |
| ~10:00 | SDGSAT-1 | TIS thermal | **30 m** | CAS China | No | Yes, free — 11-day revisit |
| ~10:30 | Terra | MODIS | 1 km | NASA | Yes (EOL) | Yes |
| ~13:30 | S-NPP, NOAA-20, NOAA-21 | VIIRS | 375 m | NOAA/NASA | **Yes** | Yes (1–3 h) |
| ~13:30 | Aqua | MODIS | 1 km | NASA | Yes (EOL) | Yes |
| ~14:00 | FY-3D | MERSI-II | 1 km TIR / 250 m SWIR | CMA | No | **NSMC or own dish only** |
| ~21:30 | Metop-B/C, MetOp-SG-A1 | AVHRR / METimage | 1.1 km / 500 m | EUMETSAT | No | Yes |
| ~22:00 | Sentinel-3A/3B | SLSTR FRP | 1 km | Copernicus | No | Yes |
| **Continuous** | Meteosat (MSG) at 0° | SEVIRI FRP | 3 km | EUMETSAT | No | Yes — **every 15 min** |
| **Continuous** | **MTG-I1** at 0° | **FCI FRP** | **1 km, every 10 min** | EUMETSAT | No | Yes — **since 7 May 2026** |
| Every 2–5 d | Sentinel-2A/2B/2C | MSI SWIR | **20 m** | Copernicus | No | Yes (CDSE) |
| Every ~8 d | Landsat 8, Landsat 9 | OLI / TIRS | 30 m / 100 m | USGS/NASA | US-only in FIRMS | Yes (USGS) |

**Three conclusions fall straight out of this table.**

**(a) The geostationary row is the one that never sleeps.** MTG-I1's FCI delivers a 1 km
fire product **every 10 minutes, continuously, day and night**. No polar orbiter competes
with that cadence. It is coarser than VIIRS and will miss small fires — but a fire that
grows is seen within 10 minutes, not within the 3–6 hours until the next polar pass.
**This is the single most underused asset in the base catalog**, where §A4 files it as a
demonstration-grade extra.

**(b) The Chinese satellites fill slots nothing Western covers.** Four to five FY-3
spacecraft cross Bulgaria daily, and **FY-3E crosses at 05:40 local** — the world's first
operational early-morning-orbit meteorological satellite. That dawn slot is empty in the
Western constellation, which clusters at 09:30–10:30 and 13:30. A fire that ignites
overnight is invisible to us from the ~01:30 VIIRS pass until the ~09:30 Metop pass —
**an eight-hour hole that FY-3E sits squarely in the middle of**, right before the
morning wind picks up.

**(c) Nothing Chinese is in FIRMS.** FIRMS carries MODIS, VIIRS and Landsat only. The
entire Fengyun fire capability is reachable *only* through CMA's own portal or by
receiving the satellites directly. That is the strongest argument in this document for
building a receiving station rather than only consuming APIs (§I2).

---

## H1. Polar imagers with an operational fire capability

### H1.1 VIIRS — S-NPP, NOAA-20, NOAA-21 (role: **D**) — *already the core, §A1*

No change to the base catalog. Recorded here only to anchor the comparison: 375 m,
~4–6 usable passes/day combined, free, in FIRMS at 1–3 h. Everything else in Part H is
measured against this.

### H1.2 MODIS — Terra, Aqua (role: **D**, expiring) — *§A2*

No change. Both instruments are far beyond design life and the fire product's end is
already on the base catalog's watchlist. Their value now is the 20-year *historical*
record for scoring and baselines, not live detection.

### H1.3 AVHRR/3 — Metop-B, Metop-C (role: **D**) — **missing from the base catalog**

| Fact | Value |
|---|---|
| Instrument | AVHRR/3, 6 channels, including the **3.7 µm mid-IR fire channel** and 10.8/12.0 µm thermal |
| Resolution | 1.1 km at nadir |
| Crossing | ~09:30 descending — a slot VIIRS does not cover |
| Coverage BG | 2 satellites × day and night passes |
| Latency | **EARS-AVHRR regional service: ~10–30 min** via EUMETCast (§I1); global via the EUMETSAT Data Store at ~1–3 h |
| Fire product | No free operational EUMETSAT fire product from AVHRR — the 3.7 µm channel is there and the classic contextual algorithm is well-published, but **we would implement detection ourselves** |
| Licence / cost | EUMETSAT open (base-catalog attribution rows 7/8) / free |

**Verdict: role D, wave 3, behind MTG FCI.** 1.1 km is coarse and self-implemented
detection is real work. Its merit is the 09:30 slot and its availability at 10–30 min via
EARS.

### H1.4 METimage on MetOp-SG-A1 (role: **D**) — **the important new free asset**

MetOp-SG-A1, launched in 2025, carries METimage — Europe's VIIRS-class imager and the
successor to AVHRR.

| Fact | Value |
|---|---|
| Resolution | **500 m**, 20 spectral channels including mid-IR and thermal |
| Crossing | ~09:30 — VIIRS-class quality in a slot VIIRS does not serve |
| Status 8/2026 | Launched 2025; **commissioning / operational-data status UNVERIFIED — confirm with EUMETSAT before planning around it** |
| Access | EUMETSAT Data Store; a regional low-latency cut via EARS/EUMETCast is expected — **UNVERIFIED** |
| Licence / cost | EUMETSAT open / free |

Its resolution sits between VIIRS (375 m) and MODIS (1 km), and it doubles the number of
high-quality morning looks. **Action: confirm the data-availability date — one email, and
it changes the wave plan.**

### H1.5 SLSTR FRP — Sentinel-3A, Sentinel-3B, Sentinel-3C (role: **D**) — *§A3*

The base catalog covers 3A/3B. Addition: **Sentinel-3C** status is UNVERIFIED as of
8/2026 — if commissioned it adds a third 10:00/22:00 FRP pass at no cost, on a platform
(CDSE) already planned. Worth one check.

### H1.6 Fengyun MERSI

The largest un-tapped block in the whole table — treated on its own in §H2.

---

## H2. Chinese Fengyun — the largest untapped constellation

Four to five operational FY-3 spacecraft cross Bulgaria every day. They are polar
sun-synchronous at ~836 km with a **2,900 km swath**, so the country is comfortably inside
coverage on every relevant orbit. This block was under-treated in the first draft of this
analysis; it is corrected here.

### H2.1 FY-3 constellation status (WMO OSCAR / ESA eoPortal, verified 8/2026)

| Satellite | Launched | Crossing (LTDN) | Primary imager | Status |
|---|---|---|---|---|
| FY-3B | 2010-11-04 | 13:30 | MVISR | Listed operational by eoPortal — **age makes this UNVERIFIED for 2026** |
| FY-3C | 2013-09-23 | 10:00 | MVISR | Operational (ageing) |
| FY-3D | 2017-11-14 | **14:00** | **MERSI-II** | Operational |
| **FY-3E** | 2021-07-04 | **05:40 descending** | **MERSI-LL** (low-light) | Operational, EOL ≥ 2029 |
| FY-3F | 2023-08-03 | 10:00 | **MERSI-III** | Operational |
| FY-3G | 2023-04-16 | 50° inclined, 407 km | Precipitation radar | Operational — **not a fire asset**, but its 50° inclination does cover Bulgaria |
| FY-3H | TBD | Early morning | — | Planned |

Orbit for the sun-synchronous members: **836.4 km, 98.75°, ~101 min period**. FY-3A was
decommissioned in March 2018.

*Conflict noted:* eoPortal lists FY-3E's crossing as 10:00; **WMO OSCAR gives 05:40
descending**, and the early-morning orbit is FY-3E's entire reason for existing. OSCAR is
authoritative for orbital parameters, so 05:40 is what this document uses.

### H2.2 MERSI-II / MERSI-III (role: **D**)

| Fact | Value |
|---|---|
| Channels | **25 channels, 412 nm – 12 µm** |
| Resolution | **250 m** in VIS/NIR/**SWIR**; **1 km** thermal (10.8 µm and 12.0 µm, NEΔT 0.4 K @ 300 K) |
| Swath | **2,900 km** — Bulgaria on consecutive orbits |
| Coverage | Global daily in VIS/NIR/SWIR; **twice daily** in MWIR/TIR per spacecraft |
| Fire capability | CMA produces **rapid-response products including fires**. Algorithm detail and detection floor **UNVERIFIED** — must be characterised before the output is trusted |
| MERSI-III | On FY-3F; detailed specification **UNVERIFIED** |
| MERSI-LL (FY-3E) | Low-light imager, designed for **night** observation. Its fire sensitivity is **UNVERIFIED** and is the single most interesting open question in this document, because it occupies the 05:40 slot |

**The 250 m SWIR is worth pausing on.** VIIRS detects at 375 m in the mid-IR; MERSI's
250 m SWIR bands are *finer*, and SWIR is exactly the band Sentinel-2 uses for 20 m
active-fire work. Whether CMA's operational product exploits it — or whether we would
have to — is UNVERIFIED.

### H2.3 The FY-3 active fire product exists — and is peer-reviewed

The first version of this document treated the Chinese fire capability as inferred from the
sensor specification. It does not have to be inferred. There is a **named, validated,
published active fire product**, described in a peer-reviewed ESSD paper
(`doi:10.5194/essd-14-3489-2022`, Copernicus Publications, paper licensed **CC BY 4.0**).

| Fact | Value |
|---|---|
| Product | FY-3D global active fire product (MERSI-II) |
| Primary detection band | **Channel 20, mid-infrared 3.55–3.95 µm** |
| Saturation fallback | Channels 24 and 25 (10.3–11.3 and 11.5–12.5 µm) — the same trick MODIS/VIIRS use |
| Fire pixel resolution | **1.1 km**; a monthly aggregate is also published on a 0.25° grid |
| Smallest fire captured | The paper states fires below **~100 m²** cannot be captured at 1 km sampling |
| Validation vs MODIS (2019) | **84.4% consistency** |
| Validation, visual, five global regions | **> 94% overall accuracy** |
| Validation, China field campaign | **79.43%** overall; **88.50%** excluding omission errors |
| Coverage | Global, since FY-3D launch, November 2017 |
| Latency | **Not stated in the paper — UNVERIFIED**, and it is the figure that decides whether this is a **D** or a **G** source |

**How to read those numbers.** 84.4% agreement with MODIS is not a defect; it is roughly
the agreement any two independent 1 km fire algorithms reach, because each catches
marginal pixels the other misses. What matters for Fire Watch is the direction of the
disagreement — the fires FY-3D sees that VIIRS did not. Establishing that requires a
side-by-side run over the Bulgarian bbox, which is a wave-4 experiment, not a wave-1
integration.

### H2.4 Access — the obstacle, considerably reduced

The earlier survey failed to reach any NSMC data page. The reason was the **hostname**: the
public entry point is `data.nsmc.org.cn`, not `satellite.nsmc.org.cn` or `www.nsmc.org.cn`,
both of which serve news and a JavaScript shell.

| Path | What it gives | Assessment |
|---|---|---|
| **FengYun Satellite Data Service** — `data.nsmc.org.cn/DataPortal/en/home/index.html` | The real portal, English UI, "Operational Datasets" and "Thematic Datasets" | **Free of charge with a registered account.** The ESSD paper's data-availability sentence confirms the route verbatim: *"FY-3D fire products are now downloadable from our official website … using a registered account and password."* The satellite selector lists **FY-3H, FY-3G, FY-3F, FY-3E, FY-3D** and **FY-4C, FY-4B, FY-4A, FY-2H, FY-2G** — FY-3H and FY-4C are newer than this document's §H2.1 table records; **their operational status is UNVERIFIED** |
| **figshare mirror** | The same FY-3D fire product as a citable dataset, `doi:10.6084/m9.figshare.20102210` | Reachable without a Chinese account. **The figshare item's own licence is UNVERIFIED** — figshare items carry a per-item licence, and the CC BY 4.0 above belongs to the *paper*, not necessarily to the deposit |
| **WMO GTS / WIS** | NSMC has been a **DCPC** since June 2012; products are disseminated internationally through WIS | The institutional route. Bulgaria's access runs through НИМХ as the WMO Member, not through us directly |
| **FY Emergency Support Mechanism (FY ESM)**, since 2018 | On-request tasking and priority data for a Member hit by an extreme event — the trigger list **explicitly names "forest or grassland fire"** | **Eligibility is WMO Members only.** The Permanent Representative of Bulgaria with WMO submits a written application to the Permanent Representative of China and designates a focal point. **We cannot apply; НИМХ can.** This is the single most interesting institutional finding in this document |
| **CMACast / FengYunCast** broadcast | China's EUMETCast equivalent; ~2,700 users in 100+ countries | Carried on Asian satellites; **presumed not receivable from Bulgaria** — UNVERIFIED, presumption negative |
| **Direct X-band reception** | Real-time, ~1–3 min | **Confirmed available:** users with appropriate receiving equipment can directly receive transmission from each operational Fengyun satellite. **DPT 8025–8400 MHz**, **MPT 7784–7796 MHz**, real-time **18.2 Mbit/s** (playback 93 Mbit/s) |
| Third-party European redistributor | — | None identified |

**Licence: still the question that gates the block, but a narrower one.** CMA has provided
free access to Fengyun data and derived products to international users since FY-3A in 2008,
through the WMO GTS and CGMS mechanisms, aligned with WMO resolutions on satellite data
sharing. What is **still UNVERIFIED** is the precise term that matters to us: whether a
European service that may become **commercial at CP3** may redistribute Fengyun-derived
fire detections to the public. Given how many free-looking sources in this corpus turn out
to be non-commercial (EOX 2018+, Blitzortung, Open-Meteo's service tier, GEE, Planet E&R,
Maxar Open Data, FireSat, and OpenSky), Fengyun must not be assumed clean. But the question
is now answerable by **registering an account and reading the terms**, which is an
afternoon's work rather than an open research problem.

### H2.5 SDGSAT-1 (role: **C**) — 30 m thermal, free and open

| Fact | Value |
|---|---|
| Operator | Chinese Academy of Sciences (CAS); launched 2021-11-05 |
| Orbit | Sun-synchronous, 505 km, 97.5°, ~10:00 descending, **11-day repeat** |
| Thermal imager (TIS) | **30 m**, three bands (8.0–10.5, 10.3–11.3, 11.5–12.5 µm), **300 km swath**, NEΔT < 0.07 K @ 300 K |
| Also carries | A **Glimmer Imager** (night-time low-light) and a multispectral imager, operating day and night together |
| Access | **Free and open globally** via the SDGSAT data portal; Level-4 products since September 2022 |
| Licence | Open for SDG research — **commercial-use terms UNVERIFIED** |

**Verdict: role C, opportunistic.** An 11-day revisit cannot detect anything, but 30 m
thermal from a free source is finer than Landsat's 100 m TIRS, and a night-time glimmer
imager is an unusual capability worth understanding. Useful for post-event
characterisation and for validating our own FRP estimates. Low priority, high novelty.

### H2.6 FY-4 geostationary — **rejected, and here is the reason**

FY-4A is at **105° E** and FY-4B at **123.5° E**. The AGRI instrument is genuinely
fire-capable — 14 bands from 0.45 to 13.8 µm, 0.5–4 km resolution, full disc every 15 min,
rapid scan every 2.5 min, and **a dedicated 3.5–4.0 µm fire channel at 2 km** — which
makes it tempting. But Bulgaria at 25° E is 80–98° of longitude from either sub-satellite
point: eoPortal states plainly that European coverage including the Balkans at 25° E is
**not within their field of view**. Recorded so the capability is never mistaken for
availability. FY-2G/2H are geostationary over the same region and fail identically.

---

## H3. Geostationary — the continuous watch

### H3.1 MTG-I1 FCI Fire Radiative Power (LSA-509) — **status upgrade**

The base catalog files this under §A4 as a demonstration extra. The overpass budget in §H0
argues for promoting it.

| Fact | Value |
|---|---|
| Resolution | **1 km at nadir** (vs 3 km for MSG SEVIRI) |
| Cadence | **10 minutes**, continuous, day and night — no revisit gap at all |
| Availability | **Distributed on EUMETCast since 7 May 2026** |
| Status | **Demonstration** — operational availability not guaranteed, formal product review not yet performed |
| Access | EUMETCast (§I1), LSA SAF, or the EUMETSAT Data Store |
| Licence / cost | EUMETSAT open / free |

**Why it matters more than its label suggests.** Every polar source in §H0 gives
*snapshots*. FCI gives a *movie*. Fire growth rate, direction of spread and the moment of
ignition are all observable at 10-minute cadence and none of them are observable from four
passes a day. The cost is resolution: a 1 km footprint misses small fires that VIIRS
catches at 375 m. **They are complementary, not competing** — FCI finds the fires that
matter fast; VIIRS finds the small ones eventually.

**Verdict: promote to wave 1.** LSA-502 (3 km MSG FRP) is the fallback if the
demonstration status becomes a problem.

### H3.2 Meteosat Second Generation SEVIRI FRP (LSA-502) — *§A4, unchanged*

3 km, 15 min, operational rather than demonstration. The safe, boring version of §H3.1.

### H3.3 Meteosat IODC at 45.5° E (role: **C**)

An MSG-class spacecraft over the Indian Ocean at 45.5° E. Bulgaria at 25° E is ~20° off
its sub-satellite point — **well within the usable disc**, at a different viewing geometry
from the 0° satellite.

**Why a second geostationary view is worth something:** two simultaneous looks from
different angles help separate a genuine hot surface from sun-glint or a cloud-edge
artefact, and the parallax between them constrains the height of a smoke plume. **Access,
product availability and whether an FRP product exists for IODC are UNVERIFIED.** Low
priority — but it is free European data we currently ignore.

---

## H4. High-resolution and SWIR — the fire-front detail tier

| Source | Fire-relevant band | Res. | Revisit BG | Role | Access |
|---|---|---|---|---|---|
| **Sentinel-2A/2B/2C** MSI | SWIR B11/B12 | **20 m** | 2–5 d (three satellites) | C | CDSE, free |
| **Landsat 8/9** OLI + TIRS | SWIR + thermal | 30 m / 100 m | ~8 d combined | C | USGS, free |
| **SDGSAT-1** TIS | Thermal | **30 m** | 11 d | C | Free (§H2.5) |
| **ECOSTRESS** (ISS) | Thermal | ~70 m | Irregular — ISS orbit, **varying local time** | C | NASA, free — **2026 operating status UNVERIFIED** |
| **PRISMA** (ASI) | Hyperspectral + SWIR | 30 m | On tasking | X | Free registration, **commercial terms UNVERIFIED** |
| **EnMAP** (DLR) | Hyperspectral | 30 m | On tasking | X | Free registration, **terms UNVERIFIED** |

**Sentinel-2C** makes the constellation three spacecraft, which shortens revisit
meaningfully against the base catalog's two-satellite assumption in §B1 — worth
re-checking the effective figure over Bulgaria.

**ECOSTRESS** is unique among the free sources in sampling *different local times* on
successive passes, which makes it specifically useful for characterising the diurnal fire
cycle. Confirm it is still operating.

**Role for the whole tier: C, never D.** Revisit measured in days cannot detect. What it
gives is 20–30 m fire-front geometry on the occasions when a pass coincides with an active
event — a picture no 375 m sensor can produce.

### H4.1 Planned thermal missions — the tier as it will look after season 1

Neither of these flies in time for season 1. Both are recorded because they change what the
"high-resolution thermal" tier means within the plan horizon, and because both are free and
open — which is rare in this resolution class.

| Mission | Operator | Launch | Thermal bands | Res. | Revisit | Access |
|---|---|---|---|---|---|---|
| **TRISHNA** | **CNES + ISRO** | Approved April 2024; **2026 status UNVERIFIED**, PSLV | **Four TIR bands: 8.65, 9.0, 10.6, 11.6 µm** | **57 m at nadir**, degrading to 90 m | **3 days**; 8-day orbital cycle, 761 km SSO, **13:00 descending** | **"Free and open"** |
| **LSTM** (Copernicus expansion) | ESA / EU | **2028**, second satellite **2030** | **Five bands in 8–12.5 µm**, plus VNIR | **50 m** | **1–3 days** (two satellites) | Copernicus open |
| **SBG-TIR** | **NASA/JPL + ASI** (INGV, INAF) | **September 2029** — slipped from the 2028 readiness date in the 2023 project papers | **Eight-band TIR radiometer** | **< ~60 m at nadir** | **< 3 days** | NASA/ASI open, expected |
| **Landsat Next** | **NASA + USGS** | **Late 2030 / early 2031** | **26 bands total; TIR grows from 2 to 5 bands** | 10–20 m VNIR/SWIR, **60 m TIR** | **6 days** (three identical observatories, one launch) | USGS open |

**Why TRISHNA matters more than its revisit suggests.** Its mission documentation names
"detection of thermal anomalies", "peat or coal fires mapping" and "early detection of lava
hot spots" as explicit capabilities — this is not an agricultural sensor that happens to see
fire. A **1,026 km swath** at 57 m is an unusual combination: the swath is VIIRS-class while
the pixel is Landsat-class. At a 3-day revisit it still cannot detect, but it would be the
best free fire-front geometry available anywhere.

**LSTM is the one that eventually matters most**, because it is Copernicus: same platform,
same licence, same access path as everything already integrated, so its marginal
integration cost is close to zero. **Not a season-1 or season-2 item — a 2029 item.**

**SBG-TIR and Landsat Next are recorded to close the question, not to plan against.** Both
were checked in this pass precisely because "NASA is launching a thermal mission" is the
kind of claim that quietly justifies waiting. Neither justifies waiting: SBG-TIR has already
slipped a year to **September 2029**, and Landsat Next is **late 2030 at the earliest** — the
far side of CP3 and of every gate in `GATES.md`. Landsat Next is also the weaker of the two
for our purpose despite the bigger programme: it improves *thermal* revisit from 16 days to
6, which is still two orders of magnitude off detection cadence. **The whole planned-mission
tier changes fire-front geometry after season 2; none of it changes detection.**

---

## H5. SAR — seeing through smoke and cloud

| Source | Res. | Revisit BG | Access | Role |
|---|---|---|---|---|
| **Sentinel-1A + Sentinel-1C** | 5 × 20 m IW | ~6 d (1B failed; 1C restored the pair) | CDSE, free | C |
| ICEYE | < 1 m | Tasking, hours | Commercial | C |
| Capella Space, Umbra | < 1 m | Tasking | Commercial | C |

SAR does not see fire — it sees **structural change**, so it maps burned area through
smoke and cloud, at night, when every optical sensor is blind. Base catalog §B5 already
covers Sentinel-1; the addition here is **Sentinel-1C**, which restored the two-satellite
6-day revisit after 1B's failure. Commercial SAR is tasking-priced and out of scope for
season 1.

---

## H6. Atmospheric and smoke sensors (role: **C/X**)

Smoke is not fire, but a smoke plume is a large, unambiguous, cloud-independent signature
that a fire exists somewhere upwind.

| Source | What it measures | Cadence over BG | Status |
|---|---|---|---|
| **Sentinel-5P TROPOMI** | CO, NO₂, aerosol index, UVAI | Daily, ~13:30 | Operational — *§D5* |
| **Sentinel-4 UVN on MTG-S1** | Air quality from **geostationary** orbit over Europe | **Hourly during daylight** — confirmed | **Launched 1 July 2025** on Falcon 9. Cadence resolved; **first public data date still UNVERIFIED** |
| **Sentinel-5 on MetOp-SG-A1** | TROPOMI successor | Daily | Launched 2025; **status UNVERIFIED** |
| **CAMS** (ECMWF) | Assimilated smoke/aerosol forecast, incl. GFAS fire emissions | Daily | Operational — *§D5* |

**Sentinel-4 is the one to watch.** An hourly geostationary air-quality sounder dedicated
to Europe has no precedent. For fire it means plume evolution at a cadence comparable to
FCI's detection cadence — the two together would let us watch a fire *and* its plume in
near-real time. **Confirm its data-availability date.**

---

## H7. Commercial thermal constellations

| Operator | Constellation (8/2026) | Res. | Alert latency | Access | Verdict |
|---|---|---|---|---|---|
| **OroraTech** | Grown 2 → **14+ own**, network > 40 (19 owned/operated); ~400 km swath | Detects **4 m × 4 m** | **~3 min**, via **on-orbit AI** | Fire Clusters REST API, **paid subscription + key** | The benchmark. No free tier |
| **Hellenic Fire System** (FOREST-16/17/18/19) | **4 satellites launched May 2026** — Greek National SmallSat Programme with ESA, built by OroraTech | As above | As above | Greek state asset | **Directly over the Balkans.** Whether output is shared regionally (rescEU / EU Civil Protection Mechanism) is **UNVERIFIED — worth one enquiry** |
| **FireSat / Earth Fire Alliance / Muon Space** | **4 in orbit** — FireSat0 demo March 2025 + **three operational 7 July 2026**; **~50 planned**. ~600 km SSO, six bands (red, NIR, SWIR, 2 × MWIR, LWIR), ~1,500 km swath | **80 m average GSD**; detects fires down to **5 × 5 m** at **< 5 % false-positive rate** | **15–30 min**. Revisit 12 h at 3 satellites → 1 h at ~20 → **20 min at ~50** | Early Adopters **Q4 2026**; public "**from 2027**". **Non-commercial licence** for fire agencies, academia and NGOs; **commercial licence** for companies; **no free tier** | **Reject, on the licence — not on the capability** |
| **Satellite Vu / HotSat** | HotSat-1; follow-ons **UNVERIFIED** | ~3.5 m thermal | Tasking | Commercial | Post-event imagery, not detection |
| **constellr** | ESA-backed LSTM/HiVE thermal; count **UNVERIFIED** | ~30–50 m | Tasking | Commercial | Agriculture-focused; fire relevance secondary |
| **Hydrosat** | VanZyl-1 + follow-ons | Thermal | Tasking | Commercial | As above |

**The honest read.** OroraTech is genuinely ahead — on-orbit AI inference is the right
architecture and 3 minutes is a number no free source approaches. But there is **no free
path**, and README invariant 6 ("Season 1 is fully free; paid tiers are a CP3 decision")
rules it out for now. Record the capability, revisit at CP3.

**The Greek constellation is the strategically significant fact here.** A neighbouring EU
member state now operates a dedicated national wildfire constellation over our exact
region. That is either the strongest possible evidence that this product category matters,
or a future data partner, or both.

**FireSat is now fully characterised, and it remains a reject.** The earlier entry was
built on the 2025 protoflight; three operational satellites went up on **7 July 2026** and
the published performance is exceptional — 5 × 5 m detection with a claimed sub-5 %
false-positive rate at 15–30 minutes, on the way to a 20-minute global revisit at ~50
satellites. The obstacle is structural, not technical: **there is no free tier.** Access is
split into a non-commercial licence for "fire response agencies, academic and scientific
institutions, and NGOs supporting wildfire resilience", and a commercial licence for
everyone else. Fire Watch might well qualify under the NGO route today — and that is
precisely the trap, because **README invariant 6 keeps a paid tier open as a CP3 decision
in October 2027**, and taking a non-commercial licence now would either forfeit that option
or force a licence renegotiation on the worst possible schedule. Same pattern as EOX,
Blitzortung and OpenSky: usable right up until the moment the business model changes.
**Revisit at CP3, together with OroraTech, as one decision rather than two.**

---

## H8. Rejected satellites — with the reason recorded

| Rejected | Reason |
|---|---|
| FY-4A (105° E), FY-4B (123.5° E), FY-2G/2H | Fire-capable AGRI, but the Balkans at 25° E are **not within their field of view** |
| GOES-East / GOES-West (75.2° W / 137° W) | Western hemisphere |
| Himawari-9 (140.7° E), GK-2A (128.2° E) | East Asia |
| INSAT series (~74–93° E) | South Asia; Bulgaria on the extreme limb at best — UNVERIFIED, presumed unusable |
| FIRMS `LANDSAT_NRT` / Landsat LFTA | 30 m at 30–60 min — superb, but **US, southern Canada and northern Mexico only**, limited by the EROS direct-broadcast footprint |
| FIRMS **URT** (< 60 s) | **CONUS, Puerto Rico and Hawaii only.** §I1 is Europe's answer |
| Elektro-L, Arktika-M, Kanopus-V-IK (Russian) | Kanopus-V-IK carries a purpose-built IR fire sensor and Elektro-L at 76° E may see Bulgaria on the limb — but **data access, licence and the procurement position are all UNVERIFIED and presumed obstructive**. Not pursued |
| Jilin-1, Gaofen, Zhuhai-1 (Chinese commercial high-res) | Optical, tasking-based, no fire product; access terms opaque |
| **DLR FireBIRD** — TET-1, BIROS | **The mission is over.** TET-1 flew 22 July 2012 → **30 September 2019**; BIROS flew June 2016 → **end of life December 2020**. An archive at DLR, not a feed |
| **NOAA HMS** Fire and Smoke Product | Excellent product, wrong hemisphere: **North America only** since its 2002 inception, and fed by GOES-16/17, which cannot see the Balkans (§H8 row 2). Its *smoke* half is also **analyst-drawn**, which does not scale to a region NOAA does not staff |
| **KOMPSAT-3A MWIR** (KARI) via **ESA Third Party Missions** | 5.5 m MWIR (3–5 µm) is the finest thermal pixel in this document — but the swath is **12 km**, it is **tasking-based**, and ESA TPM makes such commercial data free **"for research purposes"** only. Fails on all three counts: coverage, cadence, licence |

**FireBIRD deserves a paragraph rather than a table row**, because it is the closest thing
to a proof of concept for everything §H7 now sells commercially. TET-1 and BIROS carried
MWIR/LWIR sensors at **320 m with extended dynamic range** — against 1 km on MODIS and
Sentinel-3 SLSTR — specifically so that hot pixels would not saturate, and the two
spacecraft could task each other for multi-angle imaging of the same fire. Data came down at
**DLR Neustrelitz** and is archived by **DFD**, made available "worldwide for scientific
purposes" — an archival, presumptively non-commercial route. **The value now is historical
and methodological:** it is the validation dataset for small-fire detection, and it is the
evidence that a dedicated small fire satellite works — which is why OroraTech, FireSat and
the Hellenic constellation all exist. It is not a source.

---

## H9. Launch calendar — what changes inside the plan horizon

Several of this document's UNVERIFIED items were not research questions at all; they were
*calendar* questions with hard answers. Recorded here so the plan is scheduled against
dates rather than against hope. **Season 1 opens May 2027**, so everything above that line
is available before launch.

| Date | Event | What it does for us |
|---|---|---|
| **1 July 2025** | **MTG-S1 / Sentinel-4** launched (Falcon 9) | Hourly geostationary air quality over Europe — §H6. Cadence confirmed; public-data date still open |
| **2025** | **Sentinel-5 on MetOp-SG-A1** launched | TROPOMI successor; status still UNVERIFIED |
| **7 May 2026** | **LSA-509 MTG FCI FRP** on EUMETCast | 1 km FRP every 10 minutes — the wave-1 headline (§H3.1) |
| **7 July 2026** | **Three operational FireSat satellites** | Best-in-class capability, no free tier (§H7) |
| **27 August 2026** | **MTG-I2** launches on Ariane 62 | The second MTG imager — redundancy for the source wave 1 depends on most |
| **15 September 2026** | **Sentinel-3C** launches on Vega C, taking over from Sentinel-3A | **Resolves the wave-1 Sentinel-3C question with a date.** A third free SLSTR FRP pass, on CDSE, which is already the planned platform |
| **6 October 2026** | **MetOp-SG-B1** launches on Ariane 62 | The **B** series carries the microwave and scatterometer payload, **not METimage** — no new fire channel. Recorded so it is not mistaken for a second METimage |
| *After season 1* | | |
| **2027** | **JPSS-3** (NOAA/NASA) launch readiness | A **fourth operational VIIRS**. The single most valuable line in this table after season 1: same sensor, same FIRMS path, same licence — the cheapest possible cadence improvement |
| **2028** | **LSTM-1** (Copernicus expansion) | 50 m thermal, 1–3 day revisit, Copernicus licence (§H4.1) |
| **2029** | **Sentinel-3D** | Keeps the SLSTR pair alive |
| **September 2029** | **SBG-TIR** (NASA/JPL + ASI) | 8-band TIR, < 60 m, < 3-day revisit (§H4.1) |
| **2030** | **LSTM-2** | Completes the 1–3 day revisit |
| **Late 2030 / early 2031** | **Landsat Next** — three observatories, one launch | 6-day revisit, 5 TIR bands at 60 m (§H4.1) |
| **2032** | **JPSS-4** | Keeps the VIIRS series alive into the 2040s |

**The scheduling consequence for wave 1.** Sentinel-3C launches in September 2026 but does
not produce operational FRP the same week — commissioning takes months. Planning the
integration for **spring 2027, immediately before season 1**, is the honest schedule; wiring
it in September and finding an uncommissioned instrument is the failure mode to avoid.
**MTG-I2 is not a new capability**, it is insurance: wave 1 stakes the highest-value source
on a single spacecraft, and a second one in orbit is what makes that acceptable.

**The shape of the calendar is worth naming.** Between now and season 1 there is exactly one
new fire-relevant asset (Sentinel-3C, and only after commissioning). Between season 1 and
CP3 there is **JPSS-3** — a fourth VIIRS on a path we will already have built. Everything
else in this table lands in 2029–2032. **The plan therefore cannot be improved by waiting**,
and the only lever that moves inside the horizon is the one §I1 already identifies: not more
satellites, but a faster path to the ones already flying.

---

# Part I — Reception: the same satellites, sooner

§H says what is up there. This part says how to get it, and it is where the hardware
question is actually decided.

## I0. The latency ladder for Bulgaria

| Path | Latency | What it gets you | Cost |
|---|---|---|---|
| FIRMS Area API (§A1) | **1–3 h** | VIIRS ×3, MODIS ×2 | €0 |
| EUMETSAT Data Store pull (§C2) | ~1–3 h | SLSTR FRP, LSA SAF FRP, Metop | €0 |
| **EUMETCast Europe dish** (§I1) | **10–30 min** (EARS); 10 min (FCI) | EARS-VIIRS, EARS-AVHRR, MTG FCI FRP, MSG FRP, SLSTR FRP, METimage | **~€100–400 one-off, €0/yr** |
| **Own X-band station** (§I2) | **~1–3 min** | All of the above **plus the entire Fengyun block**, which no free API carries | **~€15–40k + site** |
| NASA URT / LFTA | < 60 s | — | **US-only, unavailable** |
| OroraTech (§H7) | ~3 min | Their own constellation | Paid subscription |

## I1. EUMETCast Europe — the recommended purchase (role: **L**)

| Fact | Value |
|---|---|
| What it is | EUMETSAT's free one-way DVB-S2 broadcast of its data stream over commercial telecom satellites |
| Space segment | **EUTELSAT 10A** (Ku) for EUMETCast Europe; C-band relays on Eutelsat 5 West A and SES-6 serve other regions |
| Dish | **1.25 m or 1.8 m** for core coverage areas, **1.8 m recommended to minimise rain fade** (Dartcom, a EUMETCast station vendor, quoting the same figure for Basic *and* HVS1/HVS2). Fringe areas: 2.4 m or 3.7 m. Standard Universal satellite-TV LNB, quad output, **0.3 dB noise figure** |
| Receiver | A DVB-S2 card or IP receiver — **Novra S401 Pro** dual-tuner with IP output is the vendor default; one receiver covers Basic + HVS1/HVS2, and HVS3/HVS4 would need a second |
| Software | EUMETSAT TelliCast client + licence key, free on registration |
| Cost | **~€100–400** for a Basic-Service-class station (the tier the fire products actually ride on); €400–800 for HVS-capable |
| Recurring | **€0** — no subscription, no bandwidth bill, no quota, no rate limit |
| Licence | EUMETSAT Data Policy — base-catalog attribution rows 7/8 already cover it |
| Fire content | **EARS-VIIRS** (S-NPP + NOAA-20, target **10–30 min**); NOAA-20 VIIRS Active Fires on **Data Channel 12**; EARS-AVHRR; **LSA-502 MSG FRP**; **LSA-509 MTG FRP since 7 May 2026**; SLSTR FRP; MTG FCI; cloud masks; MTG Lightning Imager |

**What EARS is.** A network of European direct-broadcast ground stations that receive
polar satellites as they pass and re-broadcast the regional cut immediately — target
timeliness **10–30 minutes** against 1–3 h on the global FIRMS path. It is Europe's
functional answer to NASA's US-only URT, and it is the one thing a dish buys that no
internet API sells.

### I1.1 Basic Service or High Volume Service — **RESOLVED: Basic**

The first version of this document flagged this as the open question that decides €100
versus €800. It is answered.

| Fact | Value |
|---|---|
| Channel | **E1B-SAF-2** |
| Multicast address | **224.223.222.28** |
| **PID** | **500** |
| Transponder | **Transponder 1 — the Basic Service** |
| What rides on it | The LSA SAF product family, including the MSG SEVIRI FRP (LSA-502) and the **new MTG FCI FRP (LSA-509)** |
| Consequence for existing subscribers | Existing LSA SAF EUMETCast subscribers receive the new MTG FRP product **automatically**, with no new registration and no new hardware |

**The €800 High Volume Service purchase is not required for the fire products.** The cheap
station reaches the FRP stream. HVS remains relevant only if we later want full-disc FCI
imagery rather than the FRP product — which we do not, because we want detections, not
pictures.

**One source conflict, recorded rather than resolved.** On antenna size the public sources
disagree with each other: one EUMETSAT-derived description states "Ku-Band basic service
requires a 1.8 m antenna, HVS 1.25 m", another states "HVS requires antennas roughly 1.8×
larger than Basic" — those two cannot both be true. **Dartcom, the vendor actually selling
the stations, quotes 1.25 m or 1.8 m for Basic and HVS alike, with 1.8 m recommended
against rain fade.** The table above follows the vendor, because a vendor that ships the
hardware has to be right about it. The earlier "85 cm recommended" figure in this document
was wrong and has been corrected.

**Still to resolve before spending** — UNVERIFIED, but neither is now cost-deciding:

1. **Link budget at the site.** EUTELSAT 10A's Europe beam covers the Balkans, but the
   margin at Sofia (42.7° N, 23.3° E) sets whether 1.25 m suffices or 1.8 m is required.
   Ask EUMETSAT User Support, or buy 1.8 m and stop thinking about it — the price
   difference is smaller than the cost of being wrong.
2. **Unobstructed southern view** — trivial rurally, not always in a city.
3. **Redistribution.** Reception is unrestricted; republishing follows the EUMETSAT Data
   Policy, which the corpus already handles. Confirm there is no EUMETCast-specific clause.

**Verdict: buy it.** Lowest cost, zero recurring, no new licence category, no new
false-positive model to build, and it attacks the metric users actually feel.

## I2. Own X-band direct-readout station (role: **L**) — reconsidered

The first draft of this analysis dismissed this as "150× the cost of §I1 for 20 minutes".
**The Fengyun block changes that arithmetic, and the verdict is revised.**

| Fact | Value |
|---|---|
| What it receives | **NOAA/NASA:** S-NPP, NOAA-20, NOAA-21 VIIRS High Rate Data at 15 Mbps X-band. **EUMETSAT:** Metop AVHRR / MetOp-SG METimage. **CMA:** every operational Fengyun satellite — **DPT 8025–8400 MHz**, **MPT 7784–7796 MHz**, real-time **18.2 Mbit/s** |
| Antenna | **2.4–3.7 m** motorised auto-tracking, feed with LNA, downconverter, demodulator, ingest server |
| Processing | NASA DRL **IPOPP** and SSEC **CSPP** — free, and they produce VIIRS active-fire products locally. Fengyun processing software **UNVERIFIED** |
| Latency | **~1–3 min** from overpass |
| Cost | **~€15,000–40,000** capital (**UNVERIFIED — vendor quote required**; Dartcom, Orbital Systems, SeaSpace and Kongsberg are the usual suppliers), plus mast, power, network and maintenance |
| Licence | NASA/NOAA data open. **Fengyun redistribution terms UNVERIFIED and gating** (§H2.4) |

**The revised argument.** One tracking dish is not a 20-minute improvement over §I1 — it
is **the only way to obtain the Chinese constellation at all at low latency**, and that
constellation is 4–5 additional fire-capable spacecraft per day including the otherwise
empty **05:40 dawn slot**. Counting only fire-capable passes, a single X-band station
plausibly takes Bulgaria from ~6 usable looks/day (VIIRS alone) to **~12–14**, at 1–3
minutes instead of 1–3 hours, on one antenna.

**Verdict: not season 1, but no longer "rejected" — it is the defensible ceiling.** It
becomes justified when (a) the Fengyun licence question resolves favourably, (b) there is
a paying operational customer or a grant, and (c) someone owns the site and its
maintenance. Until then the honest sequence is §I1 first, because the €100 dish answers
most of the same need.

## I3. Cheap SDR reception — **honest rejection**

NOAA APT (137 MHz) and Meteor-M LRPT can be received with a **~€50 RTL-SDR and a simple
antenna**, and it is a genuinely enjoyable project. For fire it is useless: APT resolution
is ~4 km with no calibrated mid-IR fire channel. Recorded so the cheap option is priced
and dismissed on the merits rather than ignored.

## I4. Free API access paths — the reference list

| Platform | What it serves | Notes |
|---|---|---|
| **NASA FIRMS** Area API | VIIRS ×3, MODIS ×2, Landsat (US) | 5,000 transactions / 10 min; **day range 1–5**. Exactly **eight** sources — see §I4.1 |
| **CDSE** | Sentinel-1/2/3/5P — *§C1* | Already the planned platform |
| **EUMETSAT Data Store** | SLSTR FRP, Metop, MSG/MTG — *§C2* | Registration pending |
| **LSA SAF** (`landsaf.ipma.pt`) | LSA-502 MSG FRP, LSA-509 MTG FRP | The FRP source of record |
| **USGS EarthExplorer** | Landsat 8/9 Collection 2, real-time tier | Free |
| **NSMC** (`data.nsmc.org.cn/DataPortal/en/`) | Fengyun, incl. the FY-3D active fire product | **Free with registration**; redistribution terms and latency **UNVERIFIED** (§H2.4) |
| **figshare** `doi:10.6084/m9.figshare.20102210` | FY-3D global active fire product, archival copy | Reachable without a Chinese account; **per-item licence UNVERIFIED** |
| **SDGSAT portal** | SDGSAT-1 TIS 30 m thermal | Free and open globally |
| **NASA Earthdata / LAADS / GIBS** | MODIS/VIIRS L1/L2, imagery tiles — *§B2* | Free |
| **EFFIS / GWIS** | Active fires, burnt-area polygons, the full FWI suite — §J9 | **CC BY 4.0**; WMS + WFS, no key. Strictly downstream of FIRMS |
| **GDACS** | Global disaster alerts incl. `WF` — §J10 | GeoJSON + RSS + CAP, no key. **No licence stated at all** |
| **MeteoAlarm** | National weather warnings incl. forest fire, CAP 1.2 — §J11 | **CC BY 4.0**; Atom per country free, EDR API free, Hub API members-only |
| **Microsoft Planetary Computer** | `sentinel-3-slstr-frp-l2-netcdf` — SLSTR FRP, 8 Aug 2020 → ongoing | STAC API free and keyless; **assets need a signed URL** from the auth API. Collection declares `"license": "proprietary"` — see §I5 |
| **NOA FireHub** (`firehub.beyond-eocenter.eu`) | Greek 5-minute SEVIRI fire detections at 300–350 m over the Balkans — §J12 | Web interface only; **no documented API and no stated licence** |

### I4.1 The FIRMS Area API source list — verbatim, and the correction it forces

This document previously listed the FIRMS sources from memory and got one of them wrong.
The authoritative list, read off the API itself, is **eight** sources:

```
LANDSAT_NRT   MODIS_NRT   MODIS_SP
VIIRS_NOAA20_NRT   VIIRS_NOAA20_SP   VIIRS_NOAA21_NRT
VIIRS_SNPP_NRT     VIIRS_SNPP_SP
```

Three corrections follow, and one of them affects code:

1. **There is no `VIIRS_NOAA21_SP`.** NOAA-21 has an NRT source only. Any adapter that
   builds source names by templating `{sensor}_{NRT|SP}` across the three VIIRS platforms
   will construct a source that does not exist. **Enumerate; never template.**
2. **There is no GOES source, and no geostationary source of any kind.** Every
   geostationary FRP in this plan comes from EUMETSAT (§H3), never from FIRMS. This was
   already recorded and is now confirmed against the API.
3. **URT is not a separate source.** The NRT sources are documented as carrying "Near
   Real-Time, Real-Time and Ultra Real-Time" — URT is folded into the NRT source rather
   than exposed separately. The US-only limitation in §H8 is about *coverage*, not about a
   source name we could request.

Request templates: `/api/area/csv/[MAP_KEY]/[SOURCE]/[AREA_COORDINATES]/[DAY_RANGE]` and
the same with a trailing `/[DATE]` for a specific day.

## I5. Mirrors and alternative access platforms — what they do and do not replace

The third pass asked a narrow question: **is there a second way to the Sentinel-3 SLSTR FRP
product that is easier than the EUMETSAT Data Store?** Several platforms re-serve the same
ESA data, and the plan should know whether any of them is a substitute rather than a detour.
The answer is no, for two different reasons.

| Platform | What it carries | Why it is not a substitute |
|---|---|---|
| **Microsoft Planetary Computer** | Collection `sentinel-3-slstr-frp-l2-netcdf`, temporal extent **8 August 2020 → open-ended**, providers ESA (producer/processor/licensor) + Microsoft (host) | The STAC API is free and keyless, but **assets require a signed URL** from the Planetary Computer authentication API, and the collection declares **`"license": "proprietary"`** with no `sci:citation` field. A host that declares "proprietary" over data ESA gives away is not a licence we can build on |
| **Copernicus Data Space Ecosystem** (§I4) | Sentinel-3 SLSTR L2 via OData, STAC and S3; product type `SL_2_FRP___` | **Timeliness.** The STAC browser exposes `sentinel-3-sl-2-frp-**ntc**` and `sentinel-3-sl-2-lst-**nrt**`; the Sentinel-3 documentation lists NTC as "Mar 2016 – Present" and NRT as "last one month", **without stating which timeliness modes FRP is offered in** — UNVERIFIED, working conclusion: **FRP on CDSE is NTC, not NRT** |
| **WEkEO** (Copernicus DIAS) | Sentinel-3 SLSTR, harmonised with CAMS/ERA5 in one account | A mirror with a registration of its own. Inherits ESA's terms; adds nothing we do not already have from CDSE or the Data Store |
| **AWS Open Data / Earth Search** | Sentinel-2 and Landsat at scale, requester-pays for some buckets | Optical, not thermal. Relevant to the wave-3 Sentinel-2 SWIR item, irrelevant to FRP |

**The two findings that matter:**

1. **A mirror inherits ESA's terms; it does not grant its own.** Copernicus data is CC BY 4.0
   at the source (§N), and no host can narrow that — but a host *can* wrap it in an
   authentication scheme and a licence string of its own choosing, and Planetary Computer
   does exactly that. Reading a collection's declared licence is not the same as reading the
   licence: for Copernicus products we take the terms from Copernicus and use the mirror, if
   at all, purely as transport.
2. **The EUMETSAT Data Store is not substitutable for near-real-time FRP.** NTC arrives days
   after the observation, which is a ground-truth timeliness, not a detection timeliness. If
   the working conclusion above holds, every alternative platform is an *archive* path and
   the Data Store remains the only free NRT path to SLSTR FRP. This makes the EUMETSAT
   registration (§I1, wave 4) load-bearing rather than convenient — worth verifying before
   any schedule depends on it.

## I6. Products we can derive rather than receive

A theme that emerged only on the third pass: some of what this plan is missing is not a
*feed* we lack access to, but a *product* nobody serves for our region — and which our own
inputs are already sufficient to compute.

**The worked example: fire perimeters.** NASA's **Fire Event Data Suite (FEDS)**, produced by
the Earth Information System, tracks individual fire growth **every 12 hours** from **VIIRS
375 m** detections (S-NPP, NOAA-20, NOAA-21) using an **alpha-shape** algorithm, emitting per
time step a fire perimeter, the actively-burning segments of that perimeter, and bulk
statistics. It is served through the OpenVEDA OGC API Features endpoint, as Esri map-image
layers, and as the "VIIRS Modeled Fire Perimeters" layer on the Experimental tab of the FIRMS
US/Canada map.

Both obvious ways to use it fail:

- **As a feed — rejected.** FEDS is publicly available **only for CONUS, Canada and Alaska**.
  There is no Balkan coverage and no indication one is planned.
- **As code — rejected.** The implementation is public at
  `https://github.com/Earth-Information-System/fireatlas` (Python, actively maintained — last
  pushed **15 July 2026**), but **the repository contains no LICENSE file and GitHub's API
  reports `license: null`**. No licence means all rights reserved: we can read it, we cannot
  vendor it, fork it, or copy from it (§N).

**What survives both rejections is the important part.** The *method* — alpha shapes over a
time-windowed set of point detections — is published, unencumbered, and well within reach:
and we already hold the input, because VIIRS 375 m detections over `polling_bbox_v1` are the
core of the ingest path. An independent implementation would give Bulgaria a product class
this plan currently has **only post-hoc** (EFFIS burnt-area polygons, §J9) **or only on
activation** (Copernicus EMS, §J7): the shape and growth direction of an ongoing fire.

This is the same pattern as the wave-3 Sentinel-2 SWIR item (§M, wave 3) — a capability added
by writing code against data we already receive, rather than by acquiring a new source. Such
items are cheap in every currency this plan tracks: no registration, no key, no quota, no
licence, no hardware, no recurring cost. **They belong at the front of the queue, not the
back.** Two caveats before anything is promised on a map: a 12-hour cadence describes fire
*history*, not fire *position now*, and an alpha-shape hull over sparse detections is a
modelled boundary, not an observed one — under invariant 3 the honest clock and under
invariant 2 the wording ladder both apply to it, and it must never read as a surveyed fire
line.

---

# Part J — Bulgarian and regional ground truth

Satellites tell us what we detected. **Only these tell us what we missed** — which is the
question that started this analysis.

### J1. ГДПБЗН (МВР) daily operational bulletin (role: **G** — the recall metric)

| Fact | Value |
|---|---|
| What | The Fire Safety and Civil Protection Directorate publishes the national 24-hour operational situation **daily at ~06:00** — fires attended, rescues, casualties, causes |
| Where | `mvr.bg/gdpbzn` → Информационен център; mirrored by `pojarna.com` |
| Format | **HTML press text. No API, no JSON, no coordinates.** Location typically municipality-level, in prose |
| Licence | Bulgarian public-sector information (ЗДОИ). Reuse including commercial is the PSI default — **UNVERIFIED per page** |

If the bulletin reports 91 fires attended and Fire Watch showed 4 events, that gap is the
product's real quality number. Most of the 91 will be structural, vehicle or rubbish fires
correctly out of scope — which is exactly why this must be a *categorised, scored* recall
check rather than a raw count.

**Use as G, never D.** Prose without coordinates cannot place a pin, and geocoding "пожар в
землището на с. …" into a marker would manufacture false precision. **Shape: a weekly
offline scoring job, not an ingest adapter.**

### J2. data.egov.bg (role: **G/X**) — searched, nothing found yet

The national open-data portal — machine-readable, with explicit commercial and
non-commercial reuse rights.

| Fact | Value |
|---|---|
| **МВР publishing volume** | **118 datasets** — among the most active organisations on the portal |
| Licence 1 | "Terms for providing information without protected copyright" — effectively CC0-like |
| Format skew | Portal-wide the formats are overwhelmingly **CSV (187)** over **JSON (4)** — expect to parse CSV |
| API specification | `https://data.egov.bg/api-spetsifikatsiya?section=22` (the `/api/documentation` path in older notes is **404**) |
| Support | `opendata@e-gov.bg` |
| Search | The `data/search?q=` path is **404**; the portal search must be driven through its own UI |

**Result of the search: no machine-readable incident-level fire dataset was located.** МВР
publishes 118 datasets and none of the ones surfaced is a fire-incident feed. Separately,
ГДПБЗН is known to run an **internal** system, *"Произшествия – ПБЗН"*, which is the
database the daily bulletin (§J1) is written from — internal, not published.

**§J2 therefore stays UNVERIFIED, but the shape of the remaining work has changed:** this
is no longer "enumerate the portal", it is "**ask ГДПБЗН directly whether the Произшествия
system can be exposed**" — contact `nspab@mvr.bg`, or a ЗДОИ request. A structured incident
feed would upgrade the recall metric from prose parsing to real scoring, which is the
single largest quality improvement available anywhere in this document.

**Prior art worth knowing:** the Greek `fotiestora.gr` solves the same problem by not
solving it — it pulls NASA FIRMS and refreshes every 5 minutes, with no national-service
integration at all. Confirmation that the satellite-only path is the pragmatic one, and
that a working national ground-truth link would be a genuine differentiator rather than
table stakes.

### J3. Изпълнителна агенция по горите (role: **G**)

The Executive Forest Agency records **forest** fires specifically — the closest match to
Fire Watch's scope of any Bulgarian source — publishes annual analyses as PDF, and runs
joint inspections with ГДПБЗН. Access under ЗДОИ on request. **Seasonal, not operational:
the season-scoring source of record.**

### J4. БИПД / RESAC, `bsdi.asde-bg.org/fires.php` (role: **prior art**)

An existing Bulgarian public fire map serving **FIRMS-derived** hotspots. Not a new source
— it is downstream of the same feed. Its value is as evidence that the FIRMS-for-Bulgaria
path is established and unencumbered, and as a reference for local attribution practice.

### J5. НИМХ open data (role: **X**)

`info.meteo.bg/openData` — machine-readable primary observations: **precipitation from 166
stations**, snow cover, and runoff from 63 hydrometric stations, updated daily. Licence
**UNVERIFIED**.

Not a competing forecast source — §D2 keeps ECMWF as source of record and §D6 forbids a
second. This is **Bulgarian ground observation**: validating "did it actually rain on this
fire" against real gauges rather than a model grid.

### J6. Neighbouring national services (role: **G**, cross-border)

`polling_bbox_v1` covers Greece, North Macedonia, Serbia, southern Romania and parts of
Turkey and Albania — any recall metric built only on Bulgarian sources misjudges most of
the polled area. Greece (Πυροσβεστικό Σώμα, plus the Hellenic Fire System §H7), Turkey
(OGM), Romania (IGSU), Serbia / N. Macedonia (MUP / ЦУК). All **UNVERIFIED** for machine
access and licence.

### J7. Copernicus EMS Rapid Mapping (role: **C/G**)

| Fact | Value |
|---|---|
| List API | `https://rapidmapping.emergency.copernicus.eu/backend/dashboard-api/public-activations-info/` |
| Detail API | `.../public-activations/?code={CODE}` |
| Format | **JSON, paginated** — activations, AOIs, products, statistics; vectors as GeoJSON/geodatabase, rasters as GeoTIFF |
| Latency | Hours to days — activation is a formal request by a national authority |
| Coverage | Only the largest events |
| Licence | **RESOLVED: CC BY 4.0.** Free of charge to all users; reuse allowed with appropriate credit and an indication of changes; **commercial reuse permitted** |

**Disproportionate value per line of code:** a tiny poller flagging "the EU formally mapped
a fire here" is both a confidence boost on our events and an unambiguous ground-truth
marker for the season's biggest fires — the ones a recall metric must not miss.

**The licence question is closed, and it closes more than this section.** Copernicus
replaced the old "Licence to use Copernicus Products" with **CC BY 4.0 on 2 July 2025** —
which is why the API documentation states no licence of its own and why the corpus's older
notes read as ambiguous. This is a corpus-wide fact, not an EMS one: wherever this plan
says "Copernicus licence, terms to be pinned", the answer is now CC BY 4.0 with credit and
a changes indication.

### J8. АПИ road cameras — **documented dead end**

Camera output is officially **служебна тайна**, the cameras capture instant snapshots
rather than video, and those are converted to text for traffic counting. No public feed, no
legal path. Recorded so it is not re-proposed.

### J9. EFFIS / GWIS (role: **C/G** — and it is *slower* than we are)

The European Forest Fire Information System and its global sibling. The base catalog
already carries EFFIS; what follows is new and changes how it should be wired.

| Fact | Value |
|---|---|
| **Licence** | **RESOLVED: CC BY 4.0** — *"reuse is allowed, provided appropriate credit is given and changes are indicated"*. Commercial use and redistribution permitted. Caveats only for identifiable individuals and embedded third-party works |
| Licence page | `forest-fire.emergency.copernicus.eu/about-effis/data-license` |
| **Active-fire latency** | Sourced from **MODIS + VIIRS**, "normally updated **6 times daily** and made available in EFFIS **within 2–3 hours**" of acquisition |
| Burnt areas (WFS) | `maps.effis.emergency.copernicus.eu/effis?service=WFS&request=getfeature&typename=ms:modis.ba.poly&outputformat=SHAPEZIP` |
| Layers (WMS) | `maps.effis.emergency.copernicus.eu/gwis` — includes `wdpa.poly` (protected areas) and `effis_clc_2020` (CORINE land cover) |
| Fire-danger suite | **FWI, ISI, BUI, FFMC, DMC, DC**, plus Anomaly and Ranking, plus **KBDI, MARK-5, NFDRS** — computed from **ECMWF at 8 km** and Meteo France |

**The finding that decides the role.** EFFIS active fires are **MODIS and VIIRS, 6× daily,
2–3 hours behind acquisition** — the same detections our own C1 poller pulls straight from
FIRMS, arriving later. **EFFIS can therefore never be a D source for us: it is strictly
downstream of, and slower than, a path we already own.** Wiring it as a detection feed
would import our own data back at a delay and risk double-counting the same fire.

**What it is genuinely good for**, in order: (1) **burnt-area polygons** — a mapped
perimeter is a product no point-detection feed can produce, and it is the honest way to
answer "how big did it get"; (2) the **FWI suite**, which is a published, peer-reviewed,
comparable danger index rather than one we would have to invent; (3) **land cover and
protected areas** as event context. **The GATE-v2 question about redistributing EFFIS raw
rasters is resolved favourably** — CC BY 4.0 permits it with credit.

### J10. GDACS (role: **C/G**, licence problematic)

The Global Disaster Alert and Coordination System — JRC + UN-OCHA. Machine-readable in
three formats, no key, no registration.

| Fact | Value |
|---|---|
| GeoJSON | `https://www.gdacs.org/gdacsapi/api/events/geteventlist/EVENTS4APP` — a FeatureCollection |
| RSS | `https://www.gdacs.org/xml/rss.xml`, with a `gdacs:` namespace carrying `eventtype`, `eventid`, `episodeid`, `bbox`, `severity`, `population`, `vulnerability`, `alertlevel`, `iscurrent`, `country`, `iso3` |
| CAP per event | `https://www.gdacs.org/contentdata/resources/{TYPE}/{eventid}/cap_{eventid}.xml` |
| Fire event type | **`WF`** — alongside `EQ`, `TC`, `FL` |
| Alert levels | **Green / Orange / Red** |
| Severity for fires | Burnt area in **hectares** |
| **Licence** | **None stated.** The terms page carries no copyright, reuse, redistribution or attribution clause at all — only liability disclaimers |

A verbatim `WF` feature, to fix the shape:

```json
{"eventtype":"WF","eventid":1031040,"name":"Forest fires in Indonesia",
 "alertlevel":"Green","country":"Indonesia",
 "fromdate":"2026-08-10T00:00:00","todate":"2026-08-24T00:00:00",
 "severitydata":{"severity":5079.0,
   "severitytext":"Green impact for forestfire in 5079 ha","severityunit":"ha"}}
```

**The licence situation is unusual and must not be read as permissive.** GDACS states only
that *"THE GDACS STAKEHOLDERS AND ADVISORY BOARD (INCLUDING BUT NOT LIMITED TO THE EUROPEAN
COMMISSION, UN-OCHA AND UNOSAT) DO NOT ASSUME ANY RESPONSIBILITY OR LIABILITY WHATSOEVER
WITH REGARD TO THE INFORMATION PROVIDED BY GDACS"*, and that *"this information is purely
indicative and should not be used for any decision making without alternate sources of
information."* **Silence is not permission.** Per `reviews/09-legal-licensing.md` the row stays open
until someone at the JRC answers in writing.

**Role: C/G only.** GDACS covers the *largest* events, is itself downstream of MODIS/VIIRS,
and its own text disclaims decision-making use. It is a useful "was this fire globally
significant" flag on an event we already have, and a ground-truth marker for the season's
biggest fires. **It may never create an event** — and its own terms say so more clearly
than our invariants do.

### J11. MeteoAlarm (role: **X/G**)

EUMETNET's aggregator of official warnings from **38 European national meteorological
services**, including НИМХ for Bulgaria.

| Fact | Value |
|---|---|
| **Licence** | **CC BY 4.0** — "Data provided by EUMETNET members" |
| Bulgaria feed | `https://feeds.meteoalarm.org/feeds/meteoalarm-legacy-atom-bulgaria` |
| Format | Atom + **CAP 1.2** (`xmlns:cap="urn:oasis:names:tc:emergency:cap:1.2"`) |
| Geocoding | `<cap:geocode>` with `<valueName>NUTS3</valueName>` and a `<value>` such as `BG344` — plus `<cap:areaDesc>` |
| Fields | `<cap:event>`, `<cap:severity>`, `<cap:urgency>`, `<cap:certainty>` |
| APIs | **EDR `/edr/v1`** (GeoJSON) and **Metadata `/metadata/v1`** are free to the public; **Hub `/hub/v1`** (CAP 1.2) is **restricted to EUMETNET members** |
| Deprecated | The RSS twin of the Atom feed is **no longer updated** — use Atom |

**Two integration traps, both real.**

1. **The warning colour lives only in the title.** Entry titles follow
   `"Yellow [HazardType] Warning issued for Bulgaria - [Region]"` — the severity word is in
   free text, not in a dedicated element. Parsing `<cap:severity>` alone will not give the
   colour users recognise.
2. **There is no canonical forest-fire code.** The hazard vocabulary is **OET-nnn**, and it
   is *per country*: **OET-087 "Forest Fire"**, **OET-095 "Grass Fire"**, **OET-079
   "Fire"**, and **OET-220 "Forest Fire"** (the Danish *Naturbrand*). A cross-border feed
   consumer must map a set of codes per country, not match one constant.

At fetch time the Bulgarian feed carried thunderstorm, rain and high-temperature warnings
and **no forest-fire warning** — so the fire-code path is unexercised and its real-world
shape for Bulgaria is **UNVERIFIED until a fire warning is actually issued**.

**Role: X, context.** This is the *official Bulgarian state warning position*, in a
machine-readable form, under a clean licence — worth showing beside our own data precisely
because it is authoritative in a way we are not. **Never D:** a warning is a forecast of
danger, not an observation of a fire.

### J12. NOA FireHub / BEYOND Centre, Greece (role: **C**) — **the find of the third pass**

The single most important source discovered in three passes, and the one that most changes
how the rest of this document should be read. **FireHub is a Greek operational service that
already does, over the Balkans, what §I1 and §I2 propose we build.**

| Fact | Value |
|---|---|
| Operator | **BEYOND Centre of Excellence for EO-based Monitoring of Natural Disasters**, Institute for Astronomy, Astrophysics, Space Applications and Remote Sensing, **National Observatory of Athens** |
| Lead | Haris Kontoes |
| Primary input | **MSG SEVIRI Level 1.5, every 5 minutes**, received through **NOA/BEYOND's own in-house antenna** |
| Channels | IR **3.9 µm** and **10.8 µm** |
| Effective resolution | **300 m** (EGU 2026 abstract, March 2026 — from a native 3 km pixel) / **350 m** (the official `beyond-eocenter.eu/firehub.html` page — from a native 3.5 km pixel). Earlier documentation describes "subpixels of 500 × 500 m … improving the initial MSG/SEVIRI raw observation by about 50 times" |
| Other inputs | MODIS (Terra/Aqua), S-NPP, NOAA-20, and Sentinel-1/2/3 via the **Greek Sentinel Mirror Site**; Landsat, SPOT, IKONOS, FORMOSAT historically |
| Coverage | "Europe, North Africa, Middle East, and the Black Sea region"; elsewhere "the wider Mediterranean … the Balkans". **Bulgaria is inside it** |
| Standing | **Integrated into the UN Global Fire Monitoring Center since 2018** |
| Access | Web interfaces only — `beyond-eocenter.eu/firehub.html`, `firehub.beyond-eocenter.eu`, `riskmap.beyond-eocenter.eu`, `ffis.beyond-eocenter.eu`, `smoke.beyond-eocenter.eu` |
| Licence | **None stated.** "All FireHub services are fully open and accessible via the web interface" — no terms of use, no attribution requirement, no documented WMS/WFS/API. **UNVERIFIED** |

**The 300 m / 350 m discrepancy is recorded rather than resolved**, per house style: the same
~10× linear downscaling is quoted against two different native pixel sizes, which is what one
would expect from a sensor whose footprint grows off nadir — 3 km is the nadir figure, 3.5 km
is closer to what SEVIRI actually resolves at Greek and Bulgarian latitudes. Both numbers come
from the operator; neither is wrong; the plan should quote the range.

**The products**, beyond detection: (a) 24/7 near-real-time active fire detection with
**ignition point estimation and fire spread prediction per event**; (b) diachronic burned-scar
mapping **1984 to present**; (c) a daily fire-risk forecast at **500 m**, published around
**15:30 for the following day**, in five levels; (d) smoke dispersion forecasting; (e) the
Forest Fire Information System.

**Role: C, confirmation only — and not even that until the terms are answered.** Two separate
constraints, and both bind:

1. **Silence is not permission.** No stated licence puts FireHub in the same bucket as GDACS
   (§J10, §N): treat as closed until an operator answers. Scraping a web interface that
   documents no API is neither technically stable nor a thing we would want to explain.
2. **Never D.** Even with clean terms, a second party's detection cannot create a Fire Watch
   event — the same rule §J10 applies to GDACS. It can raise confidence in an event we
   already hold, and it can be shown as an official regional position.

**The strategic reading matters more than the feed.** This is the second Greek asset over the
Balkans after the Hellenic Fire System (§H7), and unlike that one it is a **direct-reception
SEVIRI operation**: a national observatory concluded that the way to get useful fire data over
this region is to put up an antenna and receive the geostationary stream itself, at 5-minute
cadence, and then work the resolution problem in software. That is precisely the §I1/§I2
thesis, validated by an operator with a decade of results. **A wave-4 email to BEYOND is worth
more than most of the wave-3 backlog** — worst case they say no and we have lost an email;
best case the largest latency and resolution problem in this document is answered by someone
who solved it in 2018.

### J13. International Charter "Space and Major Disasters" / UNOSAT (role: **C/G**, activation-only)

| Fact | Value |
|---|---|
| What it is | A standing agreement among space agencies to task and supply satellite data free of charge for major disasters |
| How it triggers | **Activation only**, requested by an **Authorized User** through a confidential 24/7 number — never a subscription and never a feed |
| Authorized Users | **94 in 83 countries**, 43 of them through the **Universal Access** mechanism (one per country, typically the national civil-protection authority) |
| On behalf of the UN | **UNOOSA** and **UNITAR/UNOSAT** may activate for UN organisations |
| Typical output | Rapid mapping products, usually up to about one month after the event |
| Bulgaria's candidate authority | **Fire Safety and Civil Protection Chief Directorate, Ministry of Interior (ГДПБЗН)** — §J1 |
| Whether ГДПБЗН is registered | **UNVERIFIED** — the Authorized-User roster is not publicly indexed per country. Enquiry: `ExecutiveSecretariat@disasterscharter.org` |

**Same class as Copernicus EMS (§J7): not a source, a fact about the environment.** We can
neither activate it nor rely on it, and a Charter activation over Bulgaria is a signal that a
fire has already outgrown anything this service was built to track. Recorded for two reasons:
the resulting maps are public and make excellent **offline ground truth** for scoring a season
in hindsight, and knowing *who* holds the trigger is part of knowing the institutional
landscape we operate beside.

### J14. Global Forest Watch / Resource Watch (role: **rejected** — redundant, with an obligation attached)

GFW's fire alerts are **daily VIIRS and MODIS** — that is, **NASA FIRMS re-served**, the exact
data §A1 already ingests directly and sooner. Nothing is added on the detection side.

Something *is* added on the licence side, in the wrong direction: the Resource Watch API terms
require the attribution "**powered by Resource Watch**" with a link to `resourcewatch.org`, no
CC BY is named for the API itself, and **each dataset carries its own separate licence** that
must be checked individually. The net effect of integrating GFW would be **a new attribution
obligation and a new licence-review burden in exchange for a detection we already hold**.

**Rejected.** Recorded so the question is not re-opened for a fourth time — GFW is a
well-known name, and its prominence is not evidence that it is upstream of anything.

---

# Part K — Indirect and proxy signals (confirmation only)

Every entry here shares two properties no satellite has: **they work at night and under
cloud** — the exact conditions where §E2's cloud gate silences the satellite feed. None may
create an event.

### K1. ADS-B tracking of firefighting aircraft (role: **C**, strongest in class)

A water bomber orbiting a point at low altitude is close to proof — a human decision made
with local knowledge, broadcast in the clear, at **seconds** of latency.

| Provider | Licence | Verdict |
|---|---|---|
| **adsb.lol** | **ODbL** — free API, drop-in ADSBExchange-compatible, free historical archive | **Recommended** |
| OpenSky Network | **Research / non-commercial only** | **Licence trap — added to the trap list** |
| ADS-B Exchange | Proprietary; acquired by JETNET | Paid |
| airplanes.live | Proprietary terms | Not usable without review |

**ODbL consequence:** the same rule the corpus already applies to OSM — share-alike on
derived databases, keep them separable. A design constraint, not a blocker.

**Gate before building:** measure ADS-B receiver coverage over Bulgarian terrain first.
Low-altitude aircraft in mountains may be below every receiver's horizon, and a signal with
20% coverage silently read as absence is worse than no signal. The discriminating work is
loiter-pattern detection (tight orbits < 3 km radius, low altitude, repeated), not data
access.

### K2. METAR/SPECI present weather `FU` (smoke) (role: **C/X**)

Hourly, human-observed aerodrome weather encodes **`FU` = smoke** explicitly, alongside
visibility and `HZ` haze. Free at `https://aviationweather.gov/api/data/metar`, 30 days of
history, no key observed; licence **UNVERIFIED**. Bulgarian aerodromes: LBSF, LBPD, LBBG,
LBWN, LBGO, LBSZ.

Night-capable, cloud-independent, and unambiguous about the *kind* of phenomenon.
Spatially very coarse — a corroborating vote, not a standalone signal.

### K3. Sensor.Community / AirBG.info PM sensors (role: **C**)

Hundreds of citizen SDS011 nodes across Bulgaria reporting **PM10/PM2.5 at 5-minute
resolution** through a public API (`bulgaria.maps.sensor.community`). Licence believed
**ODbL — UNVERIFIED, must be pinned**.

**The signal is the triple coincidence:** a *sharp*, *spatially coherent*,
*downwind-consistent* PM10 rise across neighbouring nodes. All three together are what
separate a plume from the confounders — domestic heating, traffic, Saharan dust,
agricultural burning. ECMWF wind (§D2) supplies the downwind test.

**Honest limits:** the network is urban-dense and forest-sparse, exactly inverted from
where wildfires start, and in winter domestic heating swamps everything. A summer,
downwind-of-population signal — never detection.

### K4. Human reports — in-app and social (role: **D, only through curation**)

The one proxy that can legitimately create an event, and the one with the highest abuse
potential. Three non-optional constraints, all already in the corpus:

1. **The curated lifecycle exists** — `CURATED_LIFECYCLE_STATES` is exactly the mechanism:
   a report enters as a report, not a detection, and stays visibly distinguished until
   corroborated.
2. **The privacy rule holds** — coordinates never leave the device. A report is an explicit
   per-report opt-in with a deliberately chosen location, coarsened to the same ~11 m cap,
   never a silent capture of where the user is standing.
3. **Contribute a flag, not reproduced content** — republishing third-party social text or
   images carries copyright and defamation exposure that satellite data does not.

**A product decision, not a data-source decision.** Defer past season 1: the moderation
burden arrives on the worst possible day.

### K5. NOTAM / temporary airspace restrictions (role: **C**)

Aerial firefighting generates temporary restricted areas, published by BULATSA AIS.
Machine-readable access and reuse terms **UNVERIFIED**; European NOTAM access is fragmented
and often licence-restricted. **Low priority** — §K1 delivers the same underlying signal on
a documented open path.

### K6. Lightning — no new source, but the numbers are now known

Blitzortung stays **rejected on its non-commercial clause**, and its own wording is the
citation: "Commercial use of the data is strongly prohibited, even by the users that send data
to their servers." The network is genuinely impressive — roughly **1,800 active VLF stations
in 83 countries**, sometimes better than 1 km location accuracy — which is exactly why the
clause matters: this is the source one would otherwise reach for. Under README invariant 6
(season 1 free, paid tiers a CP3 decision) a non-commercial licence is not "free for now", it
is a decision we would have to unwind later. Commercial alternatives (Vaisala GLD360, LINET)
are paid.

**The MTG Lightning Imager is better than the plan assumed.** LI has been **operational since
July 2024** — not a future capability — with four cameras covering Europe, Africa, the Middle
East and parts of South America at **1,000 images per second**. A 2026 validation study gives
flash detection efficiency of **70 % by day, 95 % by night, 87.4 % on average**.

The day/night asymmetry is the useful part and it points the right way: lightning-ignited
fires are disproportionately a **night and early-morning** phenomenon, and night is where LI is
strongest — 95 % — while every optical fire signal is at its weakest. The number also sets an
honest ceiling: at 70 % daytime efficiency, the absence of a recorded strike is **not** evidence
that a fire was human-caused. LI answers "was there a plausible natural ignition here in the
last N hours", never "there was not". **Role: X, context on an event we already hold.**

---

# Part L — Own hardware, the sense side

§I covered hardware that receives someone else's observation sooner. This covers hardware
that makes an observation nobody else is making — the more exciting option, and the weaker
one, because **a sensing device covers only the area you put it in, and Bulgaria has ~4.2
million hectares of forest.**

### L1. Dryad Silvanet — LoRaWAN gas sensors (role: **D**, within its polygon)

| Fact | Value |
|---|---|
| Detection | H₂, CO and other gases at **ppm level in the smouldering phase — within the first ~60 minutes**, before flame or smoke column exists. On-device AI for false-positive rejection |
| Radius | **80–100 m** per sensor; density **0.7–1.0 sensors/ha** |
| Power | Solar, **maintenance-free up to 15 years** |
| Gen-4-Pro (May 2026) | Adds CO + PM2.5 and **direct satellite connectivity** — removes the gateway dependency |
| Price | **€48/sensor, €371 mesh gateway, €549 border gateway** (published 2022 — **UNVERIFIED for 2026**) |
| Deployments | ~35,000 sensors in Turkey; ~10,000 in France |

**The arithmetic, before gateways, labour, mounting and site agreements:**

| Area | Sensors | Sensor cost alone |
|---|---|---|
| 100 ha (one small protected site) | ~100 | ~€4,800 |
| 1,000 ha | ~1,000 | ~€48,000 |
| 42,000 ha (**1%** of Bulgarian forest) | ~42,000 | **~€2.0 M** |

**Verdict: not a coverage play — a partnership play.** Regional coverage is financially
impossible for this project. A **single sponsored micro-deployment** — one municipality,
one protected area, one concession forest — gives a sub-hour, pre-flame ground-truth feed
inside a known polygon plus a reference site. That is a business-development conversation
(община, ПУДООС, EU civil-protection funding, corporate sponsor), not an engineering task.

Competing vendors argue that gas sensors under-perform optical detection at equal spend,
precisely because of the arithmetic above. Self-interested, but the arithmetic is not.

### L2. DIY LoRa / Meshtastic node (role: **D**, pilot only)

An ESP32 LoRa board (Heltec V3, RAK WisBlock), 18650 + solar + MPPT, a weatherproof case
(~$9), plus BME688 or MQ-series gas and PMS5003 particulate sensors: **~€40–80 per node**
(pre-built solar nodes run $33–143). Firmware is open source and mature.

**The hard part is not the sensor — it is the model.** Dryad's value is the trained
false-positive rejection built on years of labelled smouldering-fire data. A raw gas
reading over a forest fires on a barbecue, a passing diesel, an inversion, and a wet
sensor — and false alarms on a public fire map are worse than silence.

**Verdict: build 2–5 as a learning exercise, not a data source.** Worth it for what they
teach about siting, power budget, mesh range in real terrain and gateway placement — all
prerequisites for ever negotiating an §L1 deployment. Budget under €500.

### L3. Optical camera towers — **Pyronear** (role: **D**) — the best sense-side option

Cameras detect the **visible smoke column**, which appears within minutes — exactly the
15–60 minute gap between ignition and the first polar overpass that this whole document is
trying to close.

| Option | What | Available to us? |
|---|---|---|
| **Pyronear** | French non-profit, **fully open source**: `pyro-engine` (edge inference), `pyro-vision` (PyTorch/ONNX for Raspberry Pi), `pyro-api` (**FastAPI + PostgreSQL**), plus the open **PyroNear2025** benchmark dataset. Deployed on **15 towers in France, Spain and Chile, 51 cameras** | **Yes — open source, self-hostable** |
| Pano AI | Commercial ultra-HD towers; 10 US states, 5 Australian states, Canada | Commercial; **no European deployment found** |
| ALERTWildfire | University consortium, hundreds of cameras | US-only, not a product |

**Indicative cost per tower** (UNVERIFIED — needs a real build): Raspberry Pi 5 ~€120;
1–4 cameras ~€60–400; 4G modem + SIM ~€30 + ~€5/mo; solar, battery, enclosure and mount
~€200–350. **Total ~€400–900 per site**, plus site access.

**Why it fits here specifically:** the economics are the inverse of §L1 — **one camera sees
tens of kilometres, one gas sensor sees 100 metres** — and Bulgaria has an existing network
of legacy forest fire-watch towers (горски наблюдателни кули), many disused, plus telecom
masts at exactly the right elevations. Siting is usually the hardest and most expensive
part of a camera network, and much of it already exists and belongs to bodies (state forest
enterprises, ИАГ regional directorates) with an obvious interest in the output.

**Risks:** false positives from cloud, dust, industrial plumes and low sun; the models are
trained on French, Spanish and Chilean landscapes and need Bulgarian validation imagery;
each tower needs power, connectivity, physical security and a maintenance budget. **Verify
the licence of each Pyronear repository and of the dataset separately — UNVERIFIED, and
software and dataset licences frequently differ.**

### L4. Drones — out of scope

Detection-by-patrol does not scale, and EASA / ГД ГВА authorisation for BVLOS flight over
forest is a regulatory project in itself. Drones are a *response* tool used after an event
is known — a different product.

---

# Part M — Consolidated ranking

Ordered by value per unit of effort and risk, which is not the same as ordered by how
interesting each item is.

### Wave 0 — before anything else

**Build C1 (the FIRMS poller), the database and the host.** Every source below multiplies
zero until this exists.

### Wave 1 — free satellite additions, software only (season 1)

| # | Source | Role | Why now |
|---|---|---|---|
| 1 | **MTG-I1 FCI FRP (LSA-509)** — §H3.1 | D | **1 km every 10 minutes, continuously.** The only source that shows fire *growth* rather than snapshots. Free, on a platform already planned |
| 2 | **MSG SEVIRI FRP (LSA-502)** — §H3.2 | D | The operational (non-demonstration) fallback for #1 |
| 3 | **METimage / MetOp-SG-A1** — §H1.4 | D | 500 m in the 09:30 slot, free — **confirm the availability date first** |
| 4 | **Sentinel-3C** — §H1.5, §H9 | D | **Launches 15 September 2026.** A third free FRP pass, near-zero integration cost on CDSE — schedule the integration for **spring 2027**, after commissioning |
| 5 | **FIRMS source-list correction** — §I4.1 | — | Eight sources, enumerated not templated: **there is no `VIIRS_NOAA21_SP`**, and `LANDSAT_NRT` is US-only. A code-affecting correction |
| 6 | **Fire perimeters derived from our own VIIRS detections** — §I6 | — | The FEDS alpha-shape method over `polling_bbox_v1`. **No registration, no key, no quota, no licence, no hardware** — a new product class from data we already receive. The only wave-1 item that is pure software with no external dependency at all |

### Wave 2 — the hardware purchase (season 1, ~€100–400)

| # | Item | Why |
|---|---|---|
| 7 | **EUMETCast Europe receive station** — §I1 | 1–3 h → **10–30 min** on the same VIIRS detections, plus FCI at 10 min, plus EARS-AVHRR and METimage. One-off cost, zero recurring, no quota, no new licence category |
| 8 | *Prerequisite, now reduced:* **Basic Service is confirmed sufficient** (channel E1B-SAF-2, PID 500 — §I1.1). Only the EUTELSAT 10A link budget at the site remains open | Decides 1.25 m versus 1.8 m, not €100 versus €800 |

### Wave 3 — ground truth and proxies (season 1.5)

| # | Source | Role | Gate |
|---|---|---|---|
| 9 | **ГДПБЗН bulletin** as a weekly offline scoring job — §J1 | G | None — this is the recall metric |
| 10 | **EFFIS burnt-area polygons + FWI** — §J9 | C/G | **None — licence resolved CC BY 4.0.** The cheapest remaining win in this document: WMS/WFS, no key, and a fire *perimeter* is a product no point feed can produce |
| 11 | **MeteoAlarm** Bulgaria Atom — §J11 | X | **None — CC BY 4.0.** Map the OET codes per country; the colour is in the title |
| 12 | **Copernicus EMS Rapid Mapping** poller — §J7 | C/G | **None — licence resolved CC BY 4.0** |
| 13 | **ГДПБЗН enquiry** about the internal *Произшествия* system — §J2 | G | One email to `nspab@mvr.bg`. Replaces the portal enumeration, which found nothing |
| 14 | **adsb.lol** loiter detection — §K1 | C | Measure receiver coverage first; ODbL separability |
| 15 | **Sensor.Community** PM coherence — §K3 | C | Pin the licence; triple test, never a bare threshold |
| 16 | **METAR `FU`** — §K2 | C/X | None |
| 17 | **Sentinel-2 SWIR** 20 m active fire — §H4 | C | Self-implemented detection |
| 18 | **НИМХ** precipitation — §J5 | X | Only where §D6 has not assigned a source of record |
| 19 | **GDACS** `WF` events — §J10 | C/G | **Blocked on the licence** — no reuse terms are stated anywhere. Written enquiry to the JRC first |
| 20 | **NOA FireHub** 5-minute SEVIRI detections at 300–350 m — §J12 | C | **Blocked on the same problem as #19:** open access, no stated terms, no documented API. Gated on #27 |

### Wave 4 — the open questions worth one email each

| # | Question | What it unlocks |
|---|---|---|
| 21 | **Fengyun licence for a commercial European service** — §H2.4. Register at `data.nsmc.org.cn` and read the terms; no email needed | 4–5 additional fire-capable spacecraft/day, including the empty **05:40 dawn slot** |
| 22 | **Ask НИМХ to trigger the FY Emergency Support Mechanism** — §H2.4. We cannot apply; a WMO Member can, and "forest or grassland fire" is a named trigger | Priority Fengyun tasking and delivery during an actual major fire |
| 23 | **Hellenic Fire System regional sharing** (rescEU / EU Civil Protection Mechanism) — §H7 | A dedicated wildfire constellation over the Balkans |
| 24 | **Sentinel-4 on MTG-S1** first public data date — §H6 | Hourly geostationary smoke over Europe. *Cadence and launch date are now confirmed; only availability is open* |
| 25 | **Meteosat IODC** FRP availability — §H3.3 | A free second geostationary viewing angle |
| 26 | **GDACS reuse terms** — §J10 | A global significance flag on our own events |
| 27 | **NOA/BEYOND: FireHub terms of use and any machine-readable endpoint** — §J12 | The highest-value single email in this table. Answers both the licence and the API question for a 5-minute, 300–350 m regional fire feed — and opens a conversation with the only operator in the region that has already built what §I1/§I2 propose |
| 28 | **Is ГДПБЗН a registered Charter Authorized User?** — §J13, to `ExecutiveSecretariat@disasterscharter.org` | Nothing operational. It tells us who can pull tasked satellite capacity over Bulgaria in a disaster, which is worth knowing before we need to know it |

### Wave 5 — sense-side hardware (season 2)

| # | Item | Cost |
|---|---|---|
| 29 | **One Pyronear camera tower** on an existing lookout or mast — §L3 | ~€400–900 + site agreement |
| 30 | 2–5 **DIY LoRa nodes** as a learning exercise — §L2 | < €500 total |
| 31 | **Dryad micro-deployment**, only if externally sponsored — §L1 | €5k–50k, not from this budget |

### Wave 6 — the ceiling

| # | Item | Cost | Condition |
|---|---|---|---|
| 32 | **X-band direct-readout station** — §I2 | ~€15–40k + site | Only if #21 resolves favourably **and** there is a paying customer or a grant **and** someone owns the maintenance |

### Beyond the plan horizon — recorded, not scheduled

| # | Item | When |
|---|---|---|
| 33 | **JPSS-3** — a fourth operational VIIRS — §H9 | **Launch readiness 2027**, data after commissioning. Same sensor, same FIRMS path, same licence: **the cheapest cadence improvement available after season 1**, and it needs no decision from us today |
| 34 | **TRISHNA** (CNES/ISRO) 57 m thermal, free and open — §H4.1 | Launch status UNVERIFIED; integrate if and when it flies |
| 35 | **LSTM-1** (Copernicus expansion) 50 m thermal — §H4.1 | **2028**, on a platform already integrated; near-zero marginal cost |
| 36 | **SBG-TIR** (NASA/JPL + ASI) 8-band TIR, < 60 m, < 3-day revisit — §H4.1 | **September 2029** — already slipped once from 2028 |
| 37 | **Landsat Next** — three observatories, 6-day revisit, 5 TIR bands at 60 m — §H4.1 | **Late 2030 / early 2031** |
| 38 | **FireSat** at ~50 satellites, 20-minute global revisit — §H7 | Public "from 2027" — but **only** as part of the CP3 paid/licence decision, never before |

### Explicitly rejected, with the reason recorded

FY-4 / FY-2 / GOES / Himawari / GK-2A / INSAT (outside field of view, §H8) · **NOAA HMS**
(North America only, and its smoke half is analyst-drawn, §H8) · FIRMS URT and Landsat LFTA
(US-only) · **NASA FEDS as a feed** (CONUS/Canada/Alaska only) and **`fireatlas` as code**
(no LICENSE file → all rights reserved, §I6) · **DLR FireBIRD** (mission ended 2019/2020,
§H8) · **KOMPSAT-3A MWIR via ESA Third Party Missions** (12 km swath, tasking-based,
research-purposes-only, §H8) · **Global Forest Watch / Resource Watch** (re-served FIRMS, with
a "powered by Resource Watch" obligation attached, §J14) · Russian assets (access and licence
presumed obstructive) · cheap SDR APT/LRPT (4 km, no fire channel) · АПИ road cameras
(служебна тайна) · OpenSky (non-commercial) · Blitzortung (non-commercial) · drones (does not
scale) · social-media ingestion as detection (the moderation burden peaks during a major
fire).

---

# Part N — Licence additions (extends the base catalog's quick reference)

Standing rule: *every new source gets a licence check against `reviews/09-legal-licensing.md` before
integration.* Nothing below may be integrated until its row resolves and, where required,
the licence text is pinned into `docs/licenses/` with its retrieval date.

| Bucket | New entries | Terms |
|---|---|---|
| EUMETSAT open | **EUMETCast Europe** (§I1) — EARS-VIIRS, EARS-AVHRR, NOAA-20 VIIRS AF, LSA-509, METimage | Same Data Policy as the Data Store; attribution rows 7/8 cover the wording. **Verify there is no EUMETCast-specific redistribution clause** |
| Copernicus open — **CC BY 4.0 since 2 July 2025** | **Sentinel-1C, Sentinel-2C, Sentinel-3C, Sentinel-4, Sentinel-5**; **Copernicus EMS Rapid Mapping** (§J7); **EFFIS / GWIS** (§J9); **LSTM** when it flies (§H4.1) | **RESOLVED.** The old "Licence to use Copernicus Products" was replaced by **CC BY 4.0** on 2 July 2025 — credit required, changes must be indicated, **commercial reuse permitted**. This closes the former EMS row *and* the base catalog's GATE-v2 question on redistributing EFFIS raw rasters |
| **EUMETNET open** | **MeteoAlarm** (§J11) | **CC BY 4.0** — "Data provided by EUMETNET members". Public Atom feeds and the EDR/Metadata APIs only; the **Hub API is members-only** and is not a path available to us |
| **No licence stated at all — treat as closed** | **GDACS** (§J10); **NOA FireHub** (§J12); **NASA `fireatlas`** (§I6) | The bucket that grew most this pass. GDACS's terms page carries **only liability disclaimers**. FireHub states "fully open and accessible" and **nothing else** — no terms, no attribution clause, no API. `fireatlas` has **no LICENSE file and GitHub reports `license: null`**, which for software is not ambiguity but the default: **all rights reserved**. Silence is not permission in any of the three. GDACS and FireHub are blocked pending a written answer; `fireatlas` may be **read but never copied** — §I6 uses the published *method*, not the code |
| **Chinese — the gating question** | **Fengyun FY-3 / MERSI** (§H2), **SDGSAT-1** (§H2.5) | **Narrowed, still UNVERIFIED.** Free of charge with registration at `data.nsmc.org.cn` since 2008, aligned with WMO data-sharing resolutions — but whether a service that may become **commercial at CP3** may redistribute Fengyun-derived detections is unknown. SDGSAT-1 is "free and open globally" for SDG research — **commercial terms unconfirmed** |
| US government open | **Landsat 8/9** (USGS), **ECOSTRESS** (NASA), **aviationweather.gov METAR** (§K2), **NOAA HMS** (§H8) | Open; **METAR exact terms UNVERIFIED — pin.** Respect the stated request-rate courtesy. **NOAA HMS is listed only to close it:** the licence is fine, the coverage is North America and the fire half depends on GOES — rejected on geography, never on terms |
| **Re-served open data with an added obligation** | **Global Forest Watch / Resource Watch** (§J14) | The API terms require the attribution "**powered by Resource Watch**" linking to `resourcewatch.org`, **no CC BY is named for the API**, and each dataset carries a separate licence to be checked individually. For fire alerts this buys nothing — they are FIRMS, which we take directly. **Rejected: an obligation without a corresponding gain** |
| **Mirrors that declare their own terms** | **Microsoft Planetary Computer** (§I5) | Hosts Copernicus data ESA gives away under CC BY 4.0, yet the SLSTR FRP collection declares **`"license": "proprietary"`** and gates assets behind a signed URL. A mirror cannot narrow the upstream licence, but it can make its own terms unusable: **take the terms from Copernicus, use a mirror only as transport, and never cite a mirror's licence field as the licence** |
| **ODbL — share-alike, separability required** | **adsb.lol** (§K1); **Sensor.Community / AirBG** (§K3, UNVERIFIED) | Usable commercially, but the derived database must stay **separable** — the rule the corpus already applies to OSM |
| Bulgarian public-sector information | **ГДПБЗН** (§J1), **data.egov.bg** (§J2), **ИАГ** (§J3), **НИМХ** (§J5) | PSI / ЗДОИ — commercial reuse is the default, but **UNVERIFIED per dataset** |
| Open-source software (not data) | **Pyronear** `pyro-engine` / `pyro-vision` / `pyro-api` / PyroNear2025 (§L3) | **UNVERIFIED — check each repository and the dataset separately** |
| Italian / German agency | **PRISMA** (ASI), **EnMAP** (DLR) (§H4) | Free registration; **commercial terms UNVERIFIED** |
| **Non-commercial traps — additions** | **OpenSky Network** (§K1); **FireSat / Earth Fire Alliance** (§H7); **ESA Third Party Missions**, incl. KOMPSAT-3A MWIR (§H8) | Joins EOX 2018+, Blitzortung, the Open-Meteo service tier, GEE noncommercial, Planet E&R and Maxar Open Data. **ESA TPM** makes commercial EO data on climate-induced hazards available free **"for research purposes"** — the same shape of clause, and the same reason we cannot take it. **The FireSat row is now precise, and worse than the earlier note suggested: there is no free tier at all** — a non-commercial licence for fire agencies, academia and NGOs, a commercial licence for everyone else. Fire Watch may qualify as an NGO today, which is exactly why it is a trap: **README invariant 6 keeps a paid tier open at CP3 (October 2027)**, and that decision would break the licence |
| Commercial / paid only | **OroraTech** (§H7), Satellite Vu, constellr, Hydrosat, ICEYE, Capella, Umbra, ADS-B Exchange, airplanes.live, Pano AI, Vaisala GLD360 | Subscription or tasking; no free path |

**New attribution strings to be pinned at integration.** These are *not* in CI-13's
assertion set and must not enter `credits.ts` until copied verbatim from the provider in
the same PR as the adapter: LSA SAF (MTG FCI FRP), METimage / MetOp-SG, Sentinel-3C,
SDGSAT-1, NSMC/CMA Fengyun, Copernicus EMS Rapid Mapping, **EFFIS / GWIS**, **MeteoAlarm
("Data provided by EUMETNET members")**, adsb.lol, Sensor.Community, НИМХ, ГДПБЗН, ИАГ,
aviationweather.gov, USGS Landsat.

**A note on what CC BY 4.0 costs us.** Four of this document's new sources — EMS, EFFIS,
MeteoAlarm and the Copernicus estate generally — converge on the same licence, and it is
the easiest one in the corpus to satisfy: a credit line and a statement that we changed the
data. We already render credits and we already derive rather than mirror, so the marginal
compliance work is **one attribution row each**, not a new legal category. The genuinely
hard rows in this table remain the two where nobody will tell us the terms: **Fengyun** and
**GDACS**.

---

# Summary — ten sentences

1. **The sky over Bulgaria is not short of satellites** — roughly 20 fire-capable
   spacecraft have a usable view and the base catalog uses five; the shortage is reception
   paths, not sensors.
2. **The most underused free asset is geostationary:** MTG-I1 FCI gives a 1 km fire product
   **every 10 minutes, continuously** — the only source that shows fire *growth* rather
   than four snapshots a day.
3. **The Chinese constellation is real, has a published and peer-reviewed fire product, and
   is free to download** — 4–5 FY-3 spacecraft cross daily including **FY-3E at 05:40
   local**, the FY-3D active fire product agrees with MODIS at **84.4 %** and is
   downloadable from `data.nsmc.org.cn` with a registered account; what remains unknown is
   not *access* but whether a service that may go **commercial at CP3** may redistribute it.
4. **The one hardware purchase worth making now is a receive dish, not a sensor** —
   ~€100–400 of EUMETCast equipment turns 1–3 hour VIIRS latency into 10–30 minutes, and
   the fire products ride the **Basic Service** (channel E1B-SAF-2, PID 500), so the
   expensive High Volume Service is not needed.
5. **The largest gap is not detection but ground truth** — without ГДПБЗН, ИАГ and
   Copernicus EMS as a scoring layer, Fire Watch can report what it saw but can never state
   what it missed; and the second pass confirmed there is **no machine-readable Bulgarian
   fire dataset to buy our way out with**, only an internal ministry system to ask about.
6. **The European aggregators are cheap, clean and slower than we are** — EFFIS, EMS and
   MeteoAlarm are all **CC BY 4.0** with no key, but EFFIS active fires arrive **2–3 hours**
   behind acquisition from the same MODIS/VIIRS we already poll, so they are confirmation,
   context and burnt-area geometry — **never detection**.
7. **Licence, not capability, is what rules sources out** — FireSat now detects **5 × 5 m
   fires in 15–30 minutes** and is still a reject, because it has no free tier and its
   non-commercial route would forfeit the CP3 decision README invariant 6 deliberately
   keeps open.
8. **Somebody in the region already built the thing this document recommends** — Greece's
   **NOA FireHub** receives MSG SEVIRI through its own antenna **every 5 minutes** and
   downscales it to **300–350 m** over a footprint that includes Bulgaria, with ignition-point
   estimation and spread prediction per fire, integrated into the UN Global Fire Monitoring
   Center since 2018; the §I1/§I2 direct-reception thesis is not speculative, it is what a
   serious regional operator does.
9. **Not every gap needs a new source — some need code** — the FEDS **alpha-shape** perimeter
   method is published and unencumbered while its implementation is not licensed at all, and
   we already hold the input, so **fire perimeters and growth direction for Bulgaria are a
   software task, not an acquisition task** (§I6), which is why that item now sits in wave 1.
10. **The blocker of this pass was neither price nor access but silence** — FireHub, GDACS and
    NASA's own `fireatlas` repository all publish freely and state **no terms at all**, and
    the plan's answer has to be the same in all three cases: silence is not permission, so
    each is blocked behind one written question rather than one integration sprint.
