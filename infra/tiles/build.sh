#!/usr/bin/env bash
# Builds the self-hosted basemap (TASKS G1 vector tiles + G2 glyphs) and, with --apply,
# uploads it to R2. Dry run by default: every command that downloads or uploads is printed,
# not run. See infra/tiles/README.md for the runbook and the manual visual check.
#
#   infra/tiles/build.sh --source <planet.pmtiles|https URL> --version 20260924 \
#       --fonts <dir of .ttf/.otf, one subdir per fontstack> \
#       --remote r2:fire-watch-tiles --public-base https://tiles.example.org [--apply]
#
# Needs: node 22, pnpm install done, `pmtiles` (go-pmtiles) and — for the glyph step —
# `build_pbf_glyphs` (github.com/stadiamaps/sdf_font_tools) on PATH; `rclone` for upload.
# Everything is written under ./tiles/ (git-ignored) unless --work says otherwise.

set -euo pipefail

usage() { sed -n '2,12p' "$0" | sed 's/^# \{0,1\}//'; exit 2; }

SOURCE="" VERSION="" FONTS="" REMOTE="" PUBLIC_BASE="" TIERS="" APPLY=0
REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
WORK="$REPO_ROOT/tiles"
GLYPH_TOOL="${GLYPH_TOOL:-build_pbf_glyphs}"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --source) SOURCE="$2"; shift 2 ;;
    --version) VERSION="$2"; shift 2 ;;
    --fonts) FONTS="$2"; shift 2 ;;
    --remote) REMOTE="$2"; shift 2 ;;
    --public-base) PUBLIC_BASE="$2"; shift 2 ;;
    --tiers) TIERS="$2"; shift 2 ;;
    --work) WORK="$2"; shift 2 ;;
    --apply) APPLY=1; shift ;;
    -h|--help) usage ;;
    *) echo "build.sh: unknown argument $1" >&2; usage ;;
  esac
done
[[ -n "$SOURCE" && -n "$VERSION" ]] || { echo "build.sh: --source and --version are required" >&2; usage; }

run() {
  # Prints every command; runs it only with --apply, except the local steps passed with
  # LOCAL=1 (building the CLI, exploding, verifying), which never touch the network.
  echo "+ $*"
  if [[ "$APPLY" == 1 || "${LOCAL:-0}" == 1 ]]; then "$@"; fi
}

CLI=(node "$REPO_ROOT/infra/tiles/dist/cli.js")
TIER_ARGS=()
[[ -n "$TIERS" ]] && TIER_ARGS=(--tiers "$TIERS")

mkdir -p "$WORK/extracts" "$WORK/tree/$VERSION" "$WORK/fonts/$VERSION"

echo "== 0. build the tool"
LOCAL=1 run pnpm exec tsc --build "$REPO_ROOT/infra/tiles"

echo "== 1. plan (tile counts, extract commands)"
LOCAL=1 run "${CLI[@]}" plan --source "$SOURCE" ${TIER_ARGS[@]+"${TIER_ARGS[@]}"}

echo "== 2. pmtiles extract per tier (downloads from --source: --apply only)"
# The plan prints one `pmtiles extract` line per tier; run exactly those.
while IFS= read -r line; do
  [[ "$line" == pmtiles\ extract* ]] || continue
  ( cd "$WORK/extracts" && echo "+ $line" && if [[ "$APPLY" == 1 ]]; then eval "$line"; fi )
done < <("${CLI[@]}" plan --source "$SOURCE" ${TIER_ARGS[@]+"${TIER_ARGS[@]}"})

shopt -s nullglob
EXTRACTS=("$WORK"/extracts/extract-*.pmtiles)
if [[ ${#EXTRACTS[@]} -eq 0 ]]; then
  echo "== no extracts on disk yet — rerun with --apply to cut them. Stopping after the plan."
  exit 0
fi

echo "== 3. explode into $WORK/tree/$VERSION"
LOCAL=1 run "${CLI[@]}" explode --out "$WORK/tree/$VERSION" --manifest "$WORK/manifest-$VERSION.json" \
  ${TIER_ARGS[@]+"${TIER_ARGS[@]}"} "${EXTRACTS[@]}"

echo "== 4. glyphs"
LOCAL=1 run "${CLI[@]}" glyph-plan --manifest "$WORK/manifest-$VERSION.json"
if [[ -n "$FONTS" ]]; then
  # One subdirectory per fontstack, named exactly as label-contract.json names it
  # (e.g. "$FONTS/Noto Sans Regular/NotoSans-Regular.ttf"). build_pbf_glyphs writes every
  # 256-codepoint range the font covers; verify-glyphs then proves the plan's ranges exist
  # and hold every required and observed letter.
  LOCAL=1 run "$GLYPH_TOOL" "$FONTS" "$WORK/fonts/$VERSION"
  LOCAL=1 run "${CLI[@]}" verify-glyphs --glyphs "$WORK/fonts/$VERSION" --manifest "$WORK/manifest-$VERSION.json"
  GLYPH_ARGS=(--glyphs "$WORK/fonts/$VERSION" --glyphs-version "$VERSION")
else
  echo "   (no --fonts: glyphs not built, the upload plan covers tiles only)"
  GLYPH_ARGS=()
fi

if [[ -z "$REMOTE" ]]; then
  echo "== no --remote: stopping before the upload plan."
  exit 0
fi

echo "== 5. upload (--apply only)"
PLAN_ARGS=(upload-plan --tiles "$WORK/tree/$VERSION" --tiles-version "$VERSION"
  --manifest "$WORK/manifest-$VERSION.json" --remote "$REMOTE" ${GLYPH_ARGS[@]+"${GLYPH_ARGS[@]}"})
[[ -n "$PUBLIC_BASE" ]] && PLAN_ARGS+=(--public-base "$PUBLIC_BASE")
"${CLI[@]}" "${PLAN_ARGS[@]}" | tee "$WORK/upload-plan-$VERSION.sh"
while IFS= read -r line; do
  [[ "$line" == rclone\ copy* ]] || continue
  if [[ "$APPLY" == 1 ]]; then eval "$line"; fi
done < "$WORK/upload-plan-$VERSION.sh"
[[ "$APPLY" == 1 ]] || echo "== dry run: nothing uploaded. Re-run with --apply."
