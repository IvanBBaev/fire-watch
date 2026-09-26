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
| What decides what is recorded (identity)                    | `source_registry_v1` (which products are polled) · `polling_bbox_v1` `91e946a7` · `weather_context_v1` `5f0fb76e` (`10u`, `10v`, `2t`, `2d`, `tp`, `tcc` at overpass, ECMWF Open Data) · `effis_layers_v1` `e1f02b2c` (`ecmwf007.fwi`, `EFFIS:BurntAreas7Days`) · `ingest_anomaly_v1` `8227a5c2` (what is quarantined instead of stored). A bump to any of these opens DS-2.1 dated with the bump. |
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

### DS-3 — EFFIS burnt-area labels, 2020–2025

The label set D7 fits against (GATES §2: "labeled against EFFIS burnt area"; TASKS D7). Not
the live `EFFIS:BurntAreas7Days` layer DS-2 records, but the season archive of Rapid Damage
Assessment perimeters (DATA-SOURCES §D1: ≥30 ha via MODIS, smaller via Sentinel-2 since 2018).

| Field                    | Value                                                                                                                                                                                                                    |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Plan                     | none in code. No adapter fetches historical perimeters; `effis_layers_v1` covers the live layers only.                                                                                                                   |
| Identity (to be pinned)  | EFFIS product and version, request extent (`polling_bbox_v1`), fetch date, file sha256 — a plan under `defineConfig` like DS-1's, so the labels a fit cites are as reproducible as the detections it scores against them. |
| Fetched                  | —                                                                                                                                                                                                                        |
| Consumers                | none yet. Expected: D7 fit report; L-13.                                                                                                                                                                                 |
| Retention floor          | forever, with DS-1 — a fit without its labels is not reproducible.                                                                                                                                                       |

**History**

- 2026-09-03 — entry opened (review 23 E1). Needs its own plan before D7 (23 §5.1).

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
