# Dataset register — the corpora a result cites

_Status: register, opened 2026-09-03 on review 23 E1. One entry per corpus version. A fit
report, a calibration, a constellation replay or a checkpoint report cites an entry here by
its id (`DS-n`), never "the backfill". A new entry is the refit trigger for anything fitted
on the old one (GATES §2). D7 does not start until its inputs carry a `--check` date. Written
in the dated-notes convention of `DATA-SOURCES.md`: nothing is edited in place; a change is a
dated line under the entry's history._

## 0. How an entry works

1. **Identity is the tuple, not the disk.** For a downloaded corpus: plan id, plan digest,
   area, polling-bbox version, and the sha256 of the manifest at the last `--check`. For the
   live record: the version and digest of every config that decides _what is recorded_ — not
   how it is processed; processing digests belong to the result that cites the corpus. Host,
   path, operator and date are provenance: recorded, never identity.
2. **Opened when the plan exists in code, dated when the data exists on disk.** An entry whose
   "last `--check`" field is blank names a corpus that does not exist yet, and every consumer
   that would cite it is blocked whatever its task status says.
3. **Reprocessings are lines, not edits.** A promotion run (`sp_swap_sanity_v1`, C7), a
   re-download after a failed chunk, a widened plan under a new version: each is a dated line
   under **History** with its outcome. The table above the history never changes; a change of
   identity is a new entry (`DS-n.1`).
4. **Consumers are listed the day they cite.** The fit report, L-13, L-14 or CP1 report that
   cites `DS-n` is added to the entry's consumer list in the same change. Two fits a season
   apart are then comparable by their inputs, not by memory.
5. **Retention floors are rules, not schedules.** Where an entry carries a floor, it is the
   minimum below which the retention schedule (OPERATIONS §6.2 rule 11; owner pending, 23 E3)
   may not go.

## 1. Entries

### DS-1 — FIRMS 2020–2025 standard-processing archive

| Field                                                 | Value                                                                                                                                                                                                                                                                             |
| ----------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Plan                                                  | `firms_sp_backfill_2020_2025_v1` — `server/src/core/backfill/backfill-plan.ts` (TASKS B8)                                                                                                                                                                                         |
| Plan digest                                           | `52345198` — the 8-hex FNV-1a digest `defineConfig` computes over the canonical JSON of the plan's values. The manifest header pins the same value as `plan_digest`; a run refuses to resume under any other.                                                                       |
| Area                                                  | `20,39,31,46` (west,south,east,north) — `polling_bbox_v1`, digest `91e946a7`                                                                                                                                                                                                       |
| Sources · products · tier                             | `firms:modis` → `MODIS_SP`; `firms:viirs:snpp` → `VIIRS_SNPP_SP`; `firms:viirs:noaa20` → `VIIRS_NOAA20_SP`; every row `product_tier = sp` (reprocessed geolocation and confidence — DATA-SOURCES §A1.1)                                                                                |
| Window and chunking                                   | 2020-01-01 … 2025-12-31 inclusive; ≤10-day Area API chunks that never cross a calendar year — 37 per year, 222 per source, 666 in total                                                                                                                                            |
| Layout                                                | `$FIRE_WATCH_ARCHIVE_DIR/firms/<product>/<year>/<product>_<start>_<N>d.csv`; manifest `firms/sp-backfill-manifest.json`, atomic `.partial` writes (OPERATIONS §6.4)                                                                                                                 |
| Season split                                          | fit 2020–2023 · calibrate 2024 · test 2025, touch-once (GATES §2). A directory selection, because no chunk straddles a year.                                                                                                                                                       |
| Known gaps by design                                  | **NOAA-21**: FIRMS serves it NRT-only, so it is absent here and from everything derived from this entry; L-14's NOAA-21 rows exist only in DS-2. **GEO (MTG FRP-PIXEL, LSA SAF)**: not FIRMS, not in this plan — DS-4.                                                            |
| Fetched                                               | **Not yet.** Needs a FIRMS MAP_KEY and a host with the archive volume (TASKS B8; EXTERNAL-ACCOUNTS.md).                                                                                                                                                                            |
| Manifest sha256 at last `--check`                     | —                                                                                                                                                                                                                                                                                 |
| Last `--check` (`backfill-cli.js --check`, offline)   | —                                                                                                                                                                                                                                                                                 |
| Failed or skipped chunks                              | —                                                                                                                                                                                                                                                                                 |
| Reprocessings                                         | none. Promotion runs are listed per month with the sanity report's outcome and whether the swap ran or dry-ran.                                                                                                                                                                   |
| Consumers                                             | none yet. Expected: D7 fit report; L-13 (2024 calibration); CP1 report (GATES §4); L-14 (2027 constellation replay, with DS-2 for NOAA-21).                                                                                                                                        |
| Retention floor                                       | forever. It is the product's input, small, and re-fetchable only while FIRMS keeps SP and the key works (OPERATIONS §6.4).                                                                                                                                                         |

**History**

- 2026-08-13 — plan v1 defined in code; runner, manifest and `--check` green (WORKLOG). No archive exists.
- 2026-09-03 — entry opened (review 23 E1). Blocked on B8's externals; the backfill has not started.

### DS-2 — Season-1 live record (the 2026 shadow season)

The rows the poller records this season are a corpus in their own right and the only one
that cannot be re-fetched: NRT positions and confidence as they were at the time, the
`available_at` per detection (C9), the weather fields at overpass, the EFFIS layers, and the
NOAA-21 rows no SP product will ever contain.

| Field                                                       | Value                                                                                                                                                                                                                                                                                                                                                                                                                             |
| ----------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| What decides what is recorded (identity)                    | `source_registry_v1` (which products are polled) · `polling_bbox_v1` `91e946a7` · `weather_context_v1` `5f0fb76e` (`10u`, `10v`, `2t`, `2d`, `tp`, `tcc` at overpass, ECMWF Open Data) · `effis_layers_v2` `023fa090` (`mf010.fwi` at the refresh's UTC date, `modis.ba.poly.week`) · `ingest_anomaly_v1` `8227a5c2` (what is quarantined instead of stored). A bump to any of these opens DS-2.1 dated with the bump. |
| Not identity                                                | `pass_table_v0`, `freshness_budgets_v1`, `clustering_params_v1`, `alert_gating_v1`, `lifecycle_params_v1` — processing and observability, cited by results and replays, not by the record.                                                                                                                                                                                                                                       |
| Sources · tier                                              | every `SOURCE_REGISTRY` source the poller is configured for, `product_tier = nrt`; NOAA-21 VIIRS included                                                                                                                                                                                                                                                                                                                         |
| First recorded day                                          | — (no host; TASKS C1 open)                                                                                                                                                                                                                                                                                                                                                                                                        |
| Last recorded day                                           | —                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| Known gaps                                                  | every day between the plan's "early September 2026" and the first recorded day (21 §5.7, 23 §5.5)                                                                                                                                                                                                                                                                                                                                 |
| Reprocessings                                               | NRT→SP month swaps (C7) retire an NRT partition and keep it; the retired partition stays part of this entry (lineage rule requested of ADR-002, 23 E2 — pending)                                                                                                                                                                                                                                                                  |
| Consumers                                                   | none yet. Expected: CP1 report; C9 lag histograms; L-14 (NOAA-21 rows); the CLM sidecar comparison (DATA-SOURCES §E2).                                                                                                                                                                                                                                                                                                             |
| Retention floor (proposed 23 E5; decision 23 E3 pending)    | `available_at` per detection → CP1 + one season · `availability.json` responses → forever · raw CLM per overpass → CP1 + one season · six ECMWF fields at overpass → CP1 + one season · EFFIS FWI daily images → forever · poison evidence (T2) → forever · **NOAA-21 NRT rows → forever**                                                                                                                                       |

**History**

- 2026-09-03 — entry opened (review 23 E1, E5). No row recorded yet.
- 2026-09-28 — `effis_layers_v1` → `v2`: the v1 names are not routed by the live mapserver (`LayerNotDefined` / 502), so v1 never produced a servable copy. No row had been recorded under v1, so the bump opens no DS-2.1.

### DS-3 — EFFIS burnt-area labels, 2020–2025

The label set D7 fits against (GATES §2: "labeled against EFFIS burnt area"; TASKS D7). Not
the live `modis.ba.poly.week` layer DS-2 records, but the season archive of Rapid Damage
Assessment perimeters (DATA-SOURCES §D1: ≥30 ha via MODIS, smaller via Sentinel-2 since 2018).

| Field                    | Value                                                                                                                                                                                                                    |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Plan                     | none in code. No adapter fetches historical perimeters; `effis_layers_v2` covers the live layers only.                                                                                                                   |
| Identity (to be pinned)  | EFFIS product and version, request extent (`polling_bbox_v1`), fetch date, file sha256 — a plan under `defineConfig` like DS-1's, so the labels a fit cites are as reproducible as the detections it scores against them. |
| Fetched                  | —                                                                                                                                                                                                                        |
| Consumers                | none yet. Expected: D7 fit report; L-13.                                                                                                                                                                                 |
| Retention floor          | forever, with DS-1 — a fit without its labels is not reproducible.                                                                                                                                                       |

**History**

- 2026-09-03 — entry opened (review 23 E1). Needs its own plan before D7 (23 §5.1).
- 2026-10-10 — archive access verified (TASKS D5). The season perimeters are served as WFS layers `modis.ba.poly.2016` … `modis.ba.poly.2025` on the same endpoint as the live layers, as GeoJSON cut to `polling_bbox_v1`. 2020–2025 were fetched and hashed for fixture sourcing (DS-6). There is still no plan in code: D7's label plan is still open, and DS-6's six files are a possible input for it, not its identity.

### DS-4 — LSA SAF GEO back-processing, 2025 (eps_geo fit)

GATES §2's exemption: GEO attach parameters are fitted on 2025 only, because LSA SAF
back-processing starts January 2025 — the touch-once test season — so eps_geo carries no
touch-once guarantee and is re-fitted on the first full post-2025 season.

| Field                    | Value                                                                                       |
| ------------------------ | ------------------------------------------------------------------------------------------- |
| Plan                     | none in code.                                                                               |
| Identity (to be pinned)  | product ids and versions, extent, window, fetch date, manifest sha256 — the DS-1 shape.     |
| Fetched                  | —                                                                                           |
| Consumers                | none yet. Expected: D7 (eps_geo only, reported separately per GATES §2).                    |

**History**

- 2026-09-03 — entry opened (review 23 E1). No machinery exists; scheduled with D7's spec.

### DS-5 — OpenStreetMap static hot-source mask, osm-2026-09-30

The mask 11 §3.6 scores against and the web caveats and draws (TASKS F16): solar parks,
thermal power plants, heavy-industry sites and flares in Bulgaria and the served box. A
cited input, not a fitted one — but a replay that scores events cites it, because the same
detections score differently under a different mask.

| Field                   | Value                                                                                                                                                                                                                                                |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Plan                    | `pnpm run geodata:static-sources` — `infra/geodata/static-sources.ts` (pure transform, `OVERPASS_QUERY`, simplification tolerance 3 × 1e-4°) + `static-sources-cli.ts` (fetch, cache in `data/geodata-cache/`, write)                                 |
| Identity                | format `fire-watch/static-sources@1` · version `osm-2026-09-30` · OSM base `2026-09-30T13:19:30Z` · query sha256 `77b4ed0a…b0c6b7` · Overpass response sha256 `bce9a353…4afba` · asset sha256 `c50a9a78…83ef18`                                       |
| Area                    | bbox W20 S39 E31 N46 (the served box, which contains Bulgaria)                                                                                                                                                                                       |
| Contents                | 6366 sources: solar 6154, thermal_power 172, industrial 33, flare 7; dropped open ways 0, unclosed multipolygon outers 0. Inner rings are dropped (a hole in a site counts as the site). No OSM element ids.                                           |
| Asset                   | `web/src/assets/geodata/static-sources.json` — 238,695 B raw, 84,503 B gzip -9                                                                                                                                                                       |
| Licence                 | ODbL 1.0, derivative database (`docs/licenses/openstreetmap-static-sources.md`)                                                                                                                                                                      |
| Consumers               | `static_source_policy_v2` (server identity cycle: §3.6 override + §6.2 day-only quarantine, from boot; override `FIRE_WATCH_STATIC_SOURCES`) · replay fixtures S4/S10 (inline mask in `observations.staticSources`, version pinned as `static_source_mask`) · web event-detail and per-detection caveat (`static_source_caveat_v1`, 1 km) · Layers-panel mask layer (`ov=static`) |
| Refresh                 | quarterly proposed (owner pending — founder call). A refresh is a new version string and a new DS-5.n line; it takes a worker restart to load, after which the identity cycle re-evaluates every live event whose recorded mask or policy version differs (500 per tick) and releases or applies the verdict — rescoring on a mask change is automatic. |
| Retention floor         | every version recorded in `fire_events.static_source_mask_version` (migration 021, per event decision; ADR-002 D7) — replay of a decision needs that exact version. Git keeps them all. |

**History**

- 2026-09-30 — entry opened with `osm-2026-09-30` (TASKS F16).
- 2026-10-01 — consumer moved to `static_source_policy_v2`; mask version recorded per event (migration 021); mask refresh triggers re-evaluation of live events.

### DS-6 — EFFIS burnt-area fixture candidates, 2020–2025 (fetched 2026-10-10)

This is the A6 fixture-sourcing input (IMPLEMENTATION-PLAN "pin the S1–S6 fire dates
against it"; TASKS D5). It has two parts: the six season layers of EFFIS burnt-area
perimeters over the polling box, and the ranked per-scenario selection cut from them. It is
not a fit corpus. No fixture replays these perimeters. They choose the dates and places a
real-data fixture is cut from.

| Field     | Value |
| --------- | ----- |
| Plan      | `pnpm run geodata:effis-ba` — `infra/geodata/effis-ba-candidates.ts` (pure parse and selection rules, `RULES_VERSION` `effis_ba_candidates_v1`) + `effis-ba-candidates-cli.ts` (fetch, cache in `data/effis-ba-cache/`, write) |
| Identity  | format `fire-watch/effis-ba-candidates@1` · rules `effis_ba_candidates_v1` · the six source files below · outline `web/src/assets/geodata/oblasts.json` (built from Natural Earth 10m admin-1 v5.1.2, source sha256 `22d0e3ad…62fb5`) · asset sha256 `c9db2337…53041b` |
| Request   | `https://maps.effis.emergency.copernicus.eu/effis?SERVICE=WFS&VERSION=1.1.0&REQUEST=GetFeature&TYPENAME=modis.ba.poly.<YEAR>&OUTPUTFORMAT=geojson&BBOX=39,20,46,31,urn:ogc:def:crs:EPSG::4326` (WFS 1.1.0 axis order is lat,lon, so this is `polling_bbox_v1` W20 S39 E31 N46); fetched 2026-10-10 17:59Z |
| Area      | bbox W20 S39 E31 N46 (`polling_bbox_v1`) |
| Asset     | `server/fixtures/effis-ba-candidates.json` — 17,150 B. The raw layers stay in the git-ignored cache. |
| Licence   | CC BY 4.0 — "© European Union, 2020–2025, European Forest Fire Information System (EFFIS)" (DATA-SOURCES §D1, attribution row 12), carried in the asset |
| Consumers | none yet. Expected: the real-data recuts of S1/S2/S6 (D5), and S3 once D10 lands. D6 for S7–S16, if it sources from the archive. |
| Refresh   | none planned. EFFIS revises perimeters (`LASTUPDATE`), so a refetch is a new DS-6.n line with new hashes. The selection is regenerated only on purpose. |

| Layer                | Perimeters | Bytes      | sha256                                                             |
| -------------------- | ---------- | ---------- | ------------------------------------------------------------------ |
| `modis.ba.poly.2020` | 829        | 70,074,089 | `58c213f88d59c30fe744b4fad648037319bb7c8a442296e13c7e7f144885a265` |
| `modis.ba.poly.2021` | 748        | 2,204,641  | `cfe9947401921414586130a3635d2233923e76fa6c967b4108226d2eee9f2f23` |
| `modis.ba.poly.2022` | 1811       | 6,349,184  | `36fac8b72715701124503e8cf14337f6a12f95ab7b8d14d43cd59cbf5e30fbfe` |
| `modis.ba.poly.2023` | 649        | 3,110,893  | `25ebfe601a4c336e26b558fe68a77959b3f4f10f1b62df0933342c1eb4bc5a02` |
| `modis.ba.poly.2024` | 2448       | 10,853,133 | `bdbb5b4cd72bf7708d99ad5d24387bc9a2f35de9a7a6ce203a9d8a8d3491d936` |
| `modis.ba.poly.2025` | 2477       | 18,250,751 | `2885051223af3d91f77b87ac9e691170ea713d2fd2e71c1d98d9ba377ad3dab5` |

Contents: five ranked candidates each for S1, S2, S3 and S6.

- **S1** — border straddlers and cross-border pairs, nearest Slavyanka first. Top: 239071
  Sandanski 2024-08-19, then 236136 Achladochori/Serres 2024-07-19..21.
- **S2** — touching Haskovo/Yambol pairs with overlapping dates, e.g. 41712 Elhovo + 41713
  Topolovgrad, 2020-08-07..10.
- **S3** — AGRIAREAS ≥ 95 %. Top: 210963 Topolovgrad 2022-09-29, 327 ha.
- **S6** — ≥ 1000 ha mapped over ≥ 48 h. Top: 233724 Svilengrad 2024-07-13..16, 8124 ha.
  No S6 candidate has a reignition perimeter within 3 km / 14 d.

S4 and S5 are recorded as `no_fitting_fire`, because neither leaves a burnt area.
`availability.json` and S7–S16 are recorded as out of scope.

**History**

- 2026-10-10 — entry opened (TASKS D5). Six layers fetched and hashed, and the selection written. Which candidate to use for each scenario is still open (founder).
