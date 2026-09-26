# infra/tiles — self-hosted basemap build (TASKS G1, G2)

Builds the outdoor basemap the web app's `outdoorBasemap` config points at (G3):
vector tiles as an **exploded `z/x/y` tree** on R2 (ADR-001 A1.1 — PMTiles is only the
build format, max **z14**), and **SDF glyph PBFs** for the fontstacks the style uses
(A2.1 as amended by A17). Nothing here runs in CI against the network; the planning core
is pure and unit-tested with tiny in-memory fixtures (`pnpm exec vitest run --project unit infra/tiles`).

| File | Role |
|---|---|
| `tile-plan.ts` | Pure core: bbox + zoom → tile ranges/counts, extract tiers, object-key layout, cache headers, upload plan, rclone command rendering, client URL templates. |
| `pmtiles.ts`, `protobuf.ts` | Minimal PMTiles v3 reader (header, gzip/none directories, leaves, Hilbert ids) and a test writer. |
| `mvt-names.ts` | Reads label strings (only the style's label fields) out of MVT tiles and collects their codepoints. |
| `explode.ts` | PMTiles extract → `<out>/z/x/y.mvt` (bytes as stored) + a build manifest with the observed label codepoints. |
| `glyph-plan.ts` | Glyph ranges required (A17 floor + observed scripts) and a byte-level "no tofu" verifier of a built glyph tree. |
| `label-contract.json` | Fontstacks and label fields — shared with the web style builder (`web/src/map/outdoor-style.ts`), which a web test holds to it. |
| `cli.ts` | `plan`, `explode`, `glyph-plan`, `verify-glyphs`, `upload-plan`. Exit 0 ok, 1 failed check, 2 usage. |
| `build.sh` | The whole flow, **dry run unless `--apply`**. |

## Prerequisites (founder machine, not CI)

- Node 22 + `pnpm install`.
- [`pmtiles`](https://github.com/protomaps/go-pmtiles) CLI for `extract`.
- [`build_pbf_glyphs`](https://github.com/stadiamaps/sdf_font_tools) (or set `GLYPH_TOOL`) for SDF glyphs.
- The Noto Sans TTFs (Regular, Bold, Italic — OFL), one directory per fontstack named exactly as
  `label-contract.json` names it (`fonts-src/Noto Sans Regular/NotoSans-Regular.ttf`, …).
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
   file is missing or any required sample letter (Greek with tonos and final ς, Latin
   Extended-A/B `ș ț ğ ı`, Cyrillic incl. `ѝ`) or any codepoint observed in a label has no glyph.
4. **Upload** — glyphs first, then tiles, all under **versioned** prefixes
   (`fonts/<version>/…`, `tiles/<version>/…`) with
   `Cache-Control: public, max-age=31536000, immutable`. There is no "latest" pointer object:
   a new build is a new prefix, and the switch is a client-config change made **last**.
5. **Switch** — set `ClientConfig.outdoorBasemap` (web) to the URL templates the upload plan
   prints. `demTilesUrl` stays `null` until a Terrarium DEM mirror exists under
   `dem/terrarium/{z}/{x}/{y}.png`; with it `null` the style simply has no hillshade.
   With `tilesUrl`/`glyphsUrl` unset the app keeps the current default basemap.

## Visual check — "no tofu" in Greek labels near the border (G2 done-when)

The byte-level verifier proves the glyphs exist; this proves MapLibre actually renders them.
Run it after step 5 against the deployed config, in **both light and dark** theme.

1. Open the app at the **S1 view** — Slavyanka / the Greek border
   (≈ 41.40 N, 23.60 E), zoom 9, then zoom 11 and 13.
2. Greek place labels south of the border render as letters, not boxes or blanks:
   **Σιδηρόκαστρο**, **Σέρρες**, **Δράμα**, **Προμαχώνας**, **Κάτω Νευροκόπι**.
   Look specifically at tonos letters (ό ά έ ί ώ) and the final sigma **ς**.
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
