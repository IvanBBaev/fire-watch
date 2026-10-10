# infra/tiles — self-hosted basemap build (TASKS G1, G2, G3)

Builds the outdoor basemap the web app's `outdoorBasemap` config points at (G3):
vector tiles as an **exploded `z/x/y` tree** on R2 (ADR-001 A1.1 — PMTiles is only the
build format, max **z14**), and **SDF glyph PBFs** for the fontstacks the style uses
(A2.1 as amended by A17). Nothing here runs in CI against the network; the planning core
is pure and unit-tested with tiny in-memory fixtures (`pnpm exec vitest run --project unit infra/tiles`).

| File | Role |
|---|---|
| `tile-plan.ts` | Pure core: bbox + zoom → tile ranges/counts, extract tiers, object-key layout, cache headers, upload plan, rclone command rendering, client URL templates. |
| `pmtiles.ts`, `protobuf.ts` | Minimal PMTiles v3 reader (header, gzip/none directories, leaves, Hilbert ids) and a test writer. |
| `mvt-names.ts` | Reads label strings out of MVT tiles the way the style's `coalesce` does (per feature, the first present label field only) and collects their codepoints. |
| `explode.ts` | PMTiles extract → `<out>/z/x/y.mvt` (bytes as stored) + a build manifest with the observed label codepoints. |
| `glyph-plan.ts` | Glyph ranges required (A17 floor + observed scripts), the `build_pbf_glyphs -c` combinations, and a byte-level "no tofu" verifier of a built glyph tree. |
| `dev-serve.ts` | Serves a local build to the Vite dev/preview server behind `FIRE_WATCH_LOCAL_TILES_DIR` (G3, see below). |
| `label-contract.json` | Fontstacks and label fields — shared with the web style builder (`web/src/map/outdoor-style.ts`), which a web test holds to it. |
| `cli.ts` | `plan`, `explode`, `glyph-plan`, `glyph-combinations`, `verify-glyphs`, `upload-plan`. Exit 0 ok, 1 failed check, 2 usage. |
| `build.sh` | The whole flow, **dry run unless `--apply`**. |

## Prerequisites (founder machine, not CI)

- Node 22 + `pnpm install`.
- [`pmtiles`](https://github.com/protomaps/go-pmtiles) CLI for `extract` (`brew install pmtiles`;
  proven with 1.31.2).
- [`build_pbf_glyphs`](https://github.com/stadiamaps/sdf_font_tools) (or set `GLYPH_TOOL`) for SDF
  glyphs — the `cli-v1.5.1` release binary works; `cargo install build_pbf_glyphs` builds the same.
  It scans **one flat directory** (no recursion) and names each output directory after the font
  file's stem; `build.sh` therefore writes a `-c` combinations file (`glyph-combinations`) that
  maps each `label-contract.json` fontstack to its stem, and keeps only the fontstack directories.
- The Noto Sans TTFs (Regular, Bold, Italic — OFL) in **one flat directory** named by stem
  (`fonts-src/NotoSans-Regular.ttf`, `NotoSans-Bold.ttf`, `NotoSans-Italic.ttf`). Proven with the
  official [notofonts/latin-greek-cyrillic](https://github.com/notofonts/latin-greek-cyrillic/releases)
  release `NotoSans-v2.015`, `NotoSans/full/ttf/` (the `full` build, not the `hinted`/`googlefonts`
  subsets; ~3000 glyphs each, Latin/Greek/Cyrillic incl. Extended blocks).
- `rclone` with an R2 remote (S3 provider `Cloudflare`), write-scoped to the tiles bucket only.

## Runbook

```sh
# 1. Look at the plan: tiers, tile counts per zoom (= PUT requests), extract commands.
infra/tiles/build.sh --source https://build.protomaps.com/<YYYYMMDD>.pmtiles --version 20260924

# 2. Cut the extracts, explode, build + verify glyphs, print the upload plan (nothing uploaded).
infra/tiles/build.sh --source https://build.protomaps.com/<YYYYMMDD>.pmtiles --version 20260924 \
  --fonts ./fonts-src --remote r2:fire-watch-tiles --public-base https://tiles.<host> --apply
```

Without `--apply` the network steps (extract, rclone) are printed only; the local steps
(build the CLI, explode, glyph build, verify) run whenever their inputs exist. Everything
lands under `./tiles/` (git-ignored).

Order of operations, and why:

1. **Extract** per tier (`europe` z0–8 context, `balkans` z0–14 detail; override with
   `--tiers tiers.json`). The default plan is ~532k distinct tiles.
2. **Explode** — stored bytes are written unchanged (gzip MVT) and served with
   `Content-Encoding: gzip`. Brotli/zstd archives are refused (not servable as static objects).
   Tiles outside every tier fail the step (exit 1).
3. **Glyphs** — `glyph-plan` lists the ranges; `verify-glyphs` fails the build if any range
   file is missing, or any required sample letter (Greek with tonos and final ς, Latin
   Extended-A/B `ș ț ğ ı`, Cyrillic incl. `ѝ`), any observed codepoint inside the A17 floor, or
   any observed codepoint of a supported script (Latin, Greek, Cyrillic, Common, Inherited —
   e.g. Greek Extended, General Punctuation) has no glyph. An observed codepoint of a script
   outside the fontstack (Arabic, Armenian, Georgian, Tifinagh, Han, Hangul — all present in a
   real Europe extract) or a non-printing one is a grouped **warning**: which fonts to add for
   them is a founder decision, not a build bug. `--strict` fails on warnings too.
4. **Upload** — glyphs first, then tiles, all under **versioned** prefixes
   (`fonts/<version>/…`, `tiles/<version>/…`) with
   `Cache-Control: public, max-age=31536000, immutable`. There is no "latest" pointer object:
   a new build is a new prefix, and the switch is a client-config change made **last**.
5. **Switch** — set `ClientConfig.outdoorBasemap` (web) to the URL templates the upload plan
   prints. `demTilesUrl` stays `null` until a Terrarium DEM mirror exists under
   `dem/terrarium/{z}/{x}/{y}.png` (see [DEM mirror](#dem-mirror--terrarium-hillshade-g3));
   with it `null` the style simply has no hillshade.
   With `tilesUrl`/`glyphsUrl` unset the app keeps the current default basemap.

## Local serving — no bucket needed (G3)

```sh
FIRE_WATCH_LOCAL_TILES_DIR=./tiles pnpm --filter @fire-watch/web dev   # or: pnpm dev:live
```

`web/vite.config.ts` mounts `dev-serve.ts` under `/__local-tiles` (dev and `vite preview`) and
builds the client with `VITE_FIRE_WATCH_LOCAL_TILES`, so `outdoorBasemap` points at
`http://localhost:<port>/__local-tiles/{tiles,fonts}/…` — the newest `tree/<v>` and
`fonts/<v>`, or `FIRE_WATCH_LOCAL_TILES_VERSION`. Tiles go out with `Content-Encoding: gzip`
like the bucket; a tile outside the tiers is a 204 (drawn empty). The client takes the value
only on a loopback origin. Unset, nothing is mounted or defined and the default basemap is
unchanged — CI, e2e and every deploy run without it.

### Local proof, 2026-10-10

- Source: `https://build.protomaps.com/20261010.pmtiles` (basemap v4.15.2, OSM 2026-10-10T04:00Z).
- Reduced tiers (`--tiers`, ~315 MB of extracts): `europe` −25,34,45,72 z0–6 and `bg-border`
  22.3,40.4,28.7,44.3 z0–14 (Bulgaria + Thessaloniki/Serres/Drama). Exploded: **94,802** tiles,
  **330,139,563** bytes stored (gzip), 0 outside the tiers; the plan's per-zoom counts matched
  `pmtiles extract` exactly.
- Glyphs: Noto Sans v2.015 full TTFs, `build_pbf_glyphs` v1.5.1 → 256 range files per fontstack;
  `verify-glyphs` passes on the floor and every supported script, with warnings for Arabic,
  Armenian, Georgian, Tifinagh, Han (one Chinese city name on the Europe tier's east edge) and
  Hangul (a Korean shop POI in Bulgaria — the style never draws that POI kind).
- Real data exposed one bug: the label scan read `name` beside `name:bg`, so the z0–z2 world
  tiles demanded CJK/Devanagari glyphs for names the style never draws (`coalesce` stops at
  `name:bg`). Fixed in `mvt-names.ts` (560 → 416 observed codepoints).
- The first real render exposed a style bug: Protomaps v4 `water` carries river LineStrings,
  and a MapLibre `fill` layer closes a line into a polygon, so rivers drew as large blue
  wedges at z9–z13. Every outdoor fill layer now filters to `Polygon`/`MultiPolygon`.
- Visual check run with the local tiles in light and dark (S1 z9/z11/z12/z13/z14,
  Thessaloniki z10, Balkans z6, Sofia z12): every tile and glyph request 200 from the dev
  server, no third-party host, no tofu in Greek (tonos, ς), Cyrillic, Romanian ș ț, bold or
  italic labels.

## DEM mirror — Terrarium hillshade (G3)

Hillshade reads a `raster-dem` source in Terrarium encoding. The mirror copies those PNGs from
the AWS Open Data **Terrain Tiles** bucket, once, so the browser never asks AWS for them:

- Source: `https://elevation-tiles-prod.s3.amazonaws.com/terrarium/{z}/{x}/{y}.png`
  (registry `https://registry.opendata.aws/terrain-tiles/`, 256 px, upstream z0–z15). The EU
  replica `elevation-tiles-prod-eu` answered 403 on 2026-10-10, so the US bucket is the source.
- Licence / required attribution: `https://github.com/tilezen/joerd/blob/master/docs/attribution.md`
  (SRTM, GMTED, ETOPO1, EU-DEM, … per area). The credit lines live in
  `packages/contracts/src/credits.ts` (`layer:terrain`) and follow automatically: a non-null
  `demTilesUrl` makes the active basemap `terrain: true`.
- Zoom cap **z12** (`DEM_MAXZOOM`): at 42° N a z12 tile is ≈ 28 m/px, already the resolution
  of the ~30 m source data under Bulgaria; z13+ would only upsample. MapLibre overzooms the
  `raster-dem` source past its `maxzoom` for z13/z14 hillshade.
- Tiers: the same tier file as the vector build, each tier capped at z12 — `europe` stays
  z0–6, `bg-border` becomes z0–12. With `tiers-local.json` that is **6,402** tiles (z12: 4,514,
  z11: 1,178, z10: 304); the dry run prints the per-zoom table and a nominal size estimate.

```sh
pnpm exec tsc --build infra/tiles
# Dry run (default): tiers, per-zoom counts, nominal bytes and the minimum time at --rate.
node infra/tiles/dist/cli.js dem-mirror --work ./tiles-dem --tiers ./tiles/tiers-local.json
# Fetch: polite (--rate 8 req/s, --concurrency 4), resumable, sha256 manifest.
node infra/tiles/dist/cli.js dem-mirror --work ./tiles-dem --tiers ./tiles/tiers-local.json --apply
node infra/tiles/dist/cli.js dem-verify --work ./tiles-dem   # re-hash every tile against the manifest
# Upload plan (dry) for the bucket: dem/terrarium/… with the DEM cache headers.
node infra/tiles/dist/cli.js dem-mirror --work ./tiles-dem --tiers ./tiles/tiers-local.json --remote <rclone-remote:bucket>
```

- Layout: `<work>/dem/terrarium/{z}/{x}/{y}.png` + `<work>/dem/manifest.json`
  (`fire-watch/dem-mirror@1`: source URL, licence, and per tile `{ bytes, sha256 }`, keys
  sorted, written atomically and checkpointed during the fetch).
- Resume: a tile already in the manifest with the same size on disk is skipped; an interrupted
  run continues where it stopped. Every body is checked to be a 256×256 PNG before it is kept.
- Retries: network errors, 429 and 5xx back off 1 s·2ⁿ (≤ 30 s); 403/404 are failures, listed
  at the end, and the run exits non-zero.
- Only `dem-mirror --apply` touches the network; every other command is offline.

Local serving: put the mirror under the tiles work directory (`./tiles/dem/terrarium`), or
point `FIRE_WATCH_LOCAL_DEM_DIR` at its own work directory:

```sh
FIRE_WATCH_LOCAL_TILES_DIR=./tiles FIRE_WATCH_LOCAL_DEM_DIR=./tiles-dem pnpm --filter @fire-watch/web dev
```

The dev server then serves `/__local-tiles/dem/terrarium/{z}/{x}/{y}.png` and defines
`VITE_FIRE_WATCH_LOCAL_DEM`, and `readLocalTiles` sets `demTilesUrl` — loopback origins only,
like the tiles. A named `FIRE_WATCH_LOCAL_DEM_DIR` that does not exist fails the start. A DEM
tile outside the mirror is a **404**, not a 204: MapLibre turns an empty `raster-dem` body into
a 1 px tile and then throws "dem dimension mismatch" when it backfills a 256 px neighbour.

Known gap: the style's `outdoor-dem` source has no `bounds`, so at the mirror's edges (the
Balkans z6 view, any pan outside `bg-border`) MapLibre requests tiles the mirror does not have
and logs each 404. Either the source gets `bounds` from the tier plan or the mirror covers the
whole view range — a decision for the hosting step, recorded here, not made.

### DEM proof, 2026-10-10

- `dem-mirror --apply` with `tiers-local.json`: **6,402** tiles z0–z12, **628.1 MB**
  (measured ≈ 98 kB/tile, nominal estimate 704 MB) in 812 s at 8 req/s, 4 in flight; 0 failures,
  0 retries surfaced. `dem-verify` re-hashed all 6,402 against the manifest in ≈ 2 s: clean.
- Rendered with the local tiles + DEM in light and dark (S1 z9/z11/z12/z13/z14, Sofia z12,
  Balkans z6): hillshade drawn at every view; every tile, glyph and DEM request went to the
  loopback dev server only; the attribution showed "Terrain: Tilezen/Mapzen" at every view.
  DEM 404s: none at S1 or Sofia, 4 at the Balkans z6 edge (the gap above). The only other
  console errors were the `/api` proxy's 502s (no local API running).

## Visual check — "no tofu" in Greek labels near the border (G2 done-when)

The byte-level verifier proves the glyphs exist; this proves MapLibre actually renders them.
Run it after step 5 against the deployed config, in **both light and dark** theme.

1. Open the app at the **S1 view** — Slavyanka / the Greek border
   (≈ 41.40 N, 23.60 E), zoom 9, then zoom 11 and 13.
2. Greek place labels south of the border render as letters, not boxes or blanks:
   **Σιδηρόκαστρο**, **Σέρρες**, **Δράμα**, **Προμαχώνας**, **Κάτω Νευροκόπι**.
   Look specifically at tonos letters (ό ά έ ί ώ) and the final sigma **ς**.
   Note: labels coalesce `name:bg` first, so a Greek town that carries a Bulgarian name in
   OSM shows the exonym (Сяр, Драма, Солун, Каракьой); Greek script appears where `name:bg` is
   absent (the 2026-10-10 local run: Νέο Πετρίτσι, Ηράκλεια, Νέος Σκοπός, Ξηροπόταμος,
   Άγιος Βασίλειος, Πετρωτό). Use those for the tonos/ς check; whether the Greek side should
   show exonyms at all is a founder decision.
3. Bulgarian labels north of the border use `name:bg` (Славянка, Петрич, Гоце Делчев) and
   render **ѝ** where present; Romanian names to the north-east render **ș ț ă î â**.
4. Italic (water) and bold (country) labels show the same scripts — each fontstack has its own glyph tree.
5. DevTools → Network: every tile, glyph and DEM request goes to the self-hosted host.
   **No** request to openfreemap.org, protomaps.com, fonts.openmaptiles.org or AWS terrain
   (WP5 done-when: zero third-party runtime tile/glyph dependencies). Glyph requests return 200
   for `768-1023.pbf` (Greek) and `1024-1279.pbf` (Cyrillic); none returns 404.
6. Record the date, build version, and a screenshot of each theme in the WORKLOG.

## Not decided here (founder)

- Tile host / bucket name and the public base URL.
- Fontstacks (Noto Sans Regular/Bold/Italic proposed) and the label fields (`name:bg` → `name`);
  the codepoint scan reads only those fields, so adding `name:en` needs a rebuild.
- Tier bboxes and zooms (cost ↔ coverage).
- Attribution lines for Protomaps/OSM and the DEM source (G5 / CI-13, `credits.ts`).
- DEM host and mirror location (same bucket under `dem/terrarium/`, or elsewhere), its tier
  coverage, and whether the `outdoor-dem` source gets `bounds`.
- DEM credit wording: `terrarium-etopo1` is `verified: false` and does not match the source
  text; `terrarium-usgs` is only part of the required line; the joerd page requires "Mapzen"
  when the hosted tiles are used; ETOPO1 has its own formal NCEI citation; the map-corner
  "Terrain: Tilezen/Mapzen" vs `terrarium-short` mismatch is already a CI-13 finding.
