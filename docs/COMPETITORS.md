# Competitor notes

*Status: living document, dated entries, newest last. Owner of the business reading:
[`reviews/10-business-gtm.md`](reviews/10-business-gtm.md) §6 and §8 (R6) and
[`reviews/32-legal-business.md`](reviews/32-legal-business.md) §5.5 / E-11. This file holds
the observations; the positioning that follows from them is R5-BIZ-11
(`docs/POSITIONING.md`, blocked-owner). Nothing here was verified against the competitor's
code or data: every item is what they published, read as a claim.*

The 2026-09-28 ISKRA review lived only in the untracked `WORKLOG.md` until this file was
opened (review 32 Appendix B lists it as the only evidence for R-12). The 2026-09-28 findings are
restated below from that entry so the register is complete in the tree.

## ISKRA (iskra.watch / bg.iskra.watch)

Bulgarian volunteer wildfire map, launched 29 July 2026. Donation-funded (they published
€1,155 in donations and €558.77 in donated equipment on 2026-11-06, plus free server space
and a free AI account). Their own footer: "early stage, does not replace 112".

### 2026-09-28 — first review (from the WORKLOG entry of that date)

Observed on the site: 13 satellites including own reception, 60 s polling, firefighter
operations tooling (claims, crew GPS, hydrants), crowd reports, solar fences, lightning,
cameras, wind, satellite passes, a rich popup and filters. The founder judged their map
"much better" than ours. Outcome: map roadmap F9–F18 opened in TASKS Track F
(F9–F14 and F17 ticked since; F15, F16, F18 built and unticked).

What we led on at that date and still do: FireEvent identity and permalinks, the
low-confidence gate, the honest freshness clock, never-send copy rules, the GDPR account
model, operations discipline (runbooks, drills, retrospectives).

### 2026-11-07 — their "100 days" post (29 July – 6 November 2026)

Source: a Facebook post seen 2026-11-07 (about 9 h old at reading; 17 reactions, 7 shares).
A dated timeline of roughly 40 shipped items, colour-coded by them as new satellite / own
algorithm / faster path / map & notifications. Transcribed in full so the register does not
depend on the post surviving:

| Date | Item (their wording, condensed) |
|---|---|
| 29.07 | Launch; archive; Telegram and Viber alerts |
| 05.08 | Sentinel-2 burnt-spot confirmation; first press |
| 10.08 | Forest fund boundaries on the map |
| 11.08 | Meteor-M2 raw records (volunteer receiver, Athens) |
| 15.08 | Fire department marks detections "real / false" |
| 20.08 | NIMH (national met institute) forwards EUMETCast data |
| 21.08 | VIIRS via EUMETSAT reception (Athens): ~5 h → 15–30 min |
| 22.08 | Landsat 30 m own detection |
| 04.09 | Own EUMETCast antenna (Panicheri) |
| 05.09 | FY-3D first product via own antenna |
| 09.09 | Meteosat every 5 min |
| 11.09 | MetOp-SG METimage 500 m |
| 12.09 | Recorded overpasses shown on a Europe map |
| 14.09 | GCOM-C 250 m |
| 15.09 | Fuel type on the map |
| 22.09 | "Photograph a fire" (location + direction); dark map, night light to hot spot |
| 28.09 | Fire-department vehicle profiles (water, places, equipment); solar parks found via "false" marks |
| 29.09 | Black roads for off-road navigation |
| 01.10 | Sentinel-2 20 m small fires |
| 04.10 | "One fire – one number" |
| 05.10 | Dobrich radio amateurs receive Meteor-M2 |
| 06.10 | Fire lifecycle: accepted · attacked · controlled · extinguished |
| 08.10 | Live drone video |
| 10.10 | Black Sea, earthquakes, cameras, people on site |
| 11.10 | Viber alert with map |
| 22.10 | Sentinel-3 from raw frame, ~1 h |
| 26.10 | "Pixel passport"; device consent |
| 27.10 | VIIRS from NOAA, all passes |
| 28.10 | Whole FY-3 group (via embassy); VIIRS from Norway, own detection, ~6 min |
| 31.10 | Nearest reservoir fill level |
| 05.11 | Ground smoke sensors |
| 06.11 | MODIS from Norway: 2 h 27 → ~10 min; 40 fuel types; crown-fire danger |

#### Reading against Fire Watch (as built on 2026-11-07)

| Dimension | ISKRA (claimed) | Fire Watch (built) | Reading |
|---|---|---|---|
| Detection latency | VIIRS ~6 min, MODIS ~10 min, Sentinel-3 ~1 h, Meteosat 5 min, from own EUMETCast reception and direct-broadcast partners | FIRMS NRT (1–3 h from overpass, DATA-SOURCES A1; keyless Europe CSVs), EFFIS daily | Lost. Our honest freshness clock, a strength in isolation, now displays a 10–30× gap to a free competitor |
| Source count | 13+ satellites incl. FY-3, GCOM-C, MetOp-SG, Landsat, Sentinel-2 20 m | VIIRS (SNPP, NOAA-20/21), MODIS; Sentinel-3 / LSA SAF / MSG AFM specified (DATA-SOURCES A3–A5), not ingested | Lost, and not worth chasing (review 32 §5.5) |
| Ground truth | Fire department marks "real / false" since 15.08; fire lifecycle from the department since 06.10 | None; CP1 was missed for lack of an evidence artifact; CP1′ reads a 2024 backfill replay | Structural. They are accumulating labelled Bulgarian data we cannot reproduce without the same partner |
| Event identity | "One fire – one number" since 04.10 | FireEvent identity + permalinks since round 1 (ADR-002) | Parity in the user's eyes; our permalink thesis is no longer a visible differentiator |
| Context layers | Fuel types (40), crown-fire danger, forest fund, reservoirs, roads, cameras, smoke sensors, drone video, earthquakes | EFFIS FWI + burnt areas, wind, cloud per pass, passes/swaths, static hot-source mask, lightning (synthetic only), WorldCover candidate | Lost on breadth |
| False positives | Solar parks found from "false" marks | OSM solar/industrial mask (F16, 6,366 sources, policy v2) | Comparable; ours is unsupervised, theirs is labelled |
| Alerts | Telegram, Viber with map | Pipeline built (digest, hysteresis, meta-alerts), no channel live, no users | Lost on reach; ours is stricter by design but unobservable to a user |
| Honesty / governance | Footer disclaimer; "pixel passport"; device consent | Never-send lint, freshness clock, fail-closed alerts, GDPR account model, erasure plan, editorial standard, retrospectives, runbooks, drills | Our lead, and invisible from the map |
| Funding | ~€1.7k donations + donated equipment, volunteers, embassy/NIMH/fire-department goodwill | Solo founder, no revenue, business paused since CP1 (2026-10-31) | Theirs is a community; ours is a product with no community yet |

#### Consequences for the register

- **R6 has moved from "happened" to "widening".** Review 32 §1.7 recorded the premise
  change on 2026-10-30; the 100-day post shows the gap growing roughly weekly, with
  institutional partners (NIMH, fire department, radio amateurs, an embassy) that are not
  replicable by a solo founder in the 2027 season.
- **The map and latency race is lost**, as review 32 §5.5 already concluded. Every F-row
  since F9 bought parity on a feature they had months earlier; none of them changes the
  reading above. No further ISKRA-driven map rows should be opened without a founder
  decision.
- **Our differentiators are governance, not features.** Fail-closed alerts, the freshness
  clock, GDPR posture, retention, editorial standard, retrospectives and operations are
  real and are not visible on a map. Positioning (R5-BIZ-11) has to make them legible or
  they do not count.
- **The partnership option (review 32 E-11, decision 6) is now the main line, not the
  alternative.** The thing ISKRA visibly lacks is exactly what we built: alert discipline,
  account and consent model, a published standard for what a message may say. A feed or
  link exchange, or Fire Watch as the alert and permalink layer over their detections, is
  the configuration with a surviving niche. New B2B audiences remain frozen by E-9 until CP2.
- **CP1′ is unaffected in mechanics**, but its meaning changes: a passed CP1′ proves the
  pipeline works on 2024 data, not that anyone will prefer it to a 6-minute live map.

#### Recommendation (for the founder; input to R5-BIZ-11)

1. Make one contact with ISKRA before any partner outreach, as review 32 decision 6
   already recommended, with a concrete proposal (alerts and permalinks over their
   detections, or a mutual link exchange), not an open question.
2. Keep engineering on Group ENG order (CI, security headers — landed 2026-11-07 as
   R5-SEC-2 —, deploy path). None of it
   depends on the competitive reading, and all of it is needed in either configuration.
3. Do not open new map rows. Finish or strike F15/F16/F18 on their own merits.
4. Write `docs/POSITIONING.md` (R5-BIZ-11) against this table: three differentiators that
   are verifiable in the product and absent from theirs.

Open founder decisions raised here: contact ISKRA or not; freeze Track F; whether the
honesty clock stays front-and-centre when the comparison it invites is unfavourable.
