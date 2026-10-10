#!/usr/bin/env node
/**
 * The basemap build tool (TASKS G1/G2). `build.sh` drives it; every subcommand is also
 * runnable by hand.
 *
 *   node infra/tiles/dist/cli.js plan [--tiers <json>] [--source <planet.pmtiles|url>]
 *   node infra/tiles/dist/cli.js explode --out <dir> --manifest <file> [--tiers <json>] <extract.pmtiles>…
 *   node infra/tiles/dist/cli.js glyph-plan --manifest <file>
 *   node infra/tiles/dist/cli.js glyph-combinations --fonts <flat dir of .ttf/.otf>
 *   node infra/tiles/dist/cli.js verify-glyphs --glyphs <dir> --manifest <file> [--strict]
 *   node infra/tiles/dist/cli.js upload-plan --tiles <dir> --tiles-version <v> --manifest <file>
 *        --remote <rclone-remote:bucket> [--glyphs <dir> --glyphs-version <v>] [--public-base <https-url>]
 *   node infra/tiles/dist/cli.js dem-mirror --work <dir> [--tiers <json>] [--maxzoom 12] [--rate 8]
 *        [--concurrency 4] [--remote <rclone-remote:bucket>] [--apply]
 *   node infra/tiles/dist/cli.js dem-verify --work <dir>
 *
 * Nothing here touches the network except `dem-mirror --apply` (G3), which downloads the
 * public Terrarium tiles; without `--apply` it only prints the plan. `plan` and
 * `upload-plan` print the commands that do, and `build.sh` runs them only with `--apply`.
 *
 * Exit codes: 0 ok, 1 a check failed, 2 usage error.
 */

import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

import {
  DEM_MAXZOOM,
  DEM_SOURCE,
  type DemFetchResponse,
  demManifestPath,
  demSizeOnDisk,
  demTileFile,
  demTiers,
  demTileUrl,
  demUploadStep,
  emptyDemManifest,
  mirrorDem,
  planDemMirror,
  readDemManifest,
  summarizeDemManifest,
  verifyDemMirror,
} from './dem-mirror.js';
import { explode, type ExplodeManifest, fileSource, mergeManifests } from './explode.js';
import {
  codepointLabel,
  expectedGlyphFiles,
  glyphCombinations,
  planGlyphs,
  rangeFileName,
  verifyGlyphs,
} from './glyph-plan.js';
import {
  assertTier,
  clientUrlTemplates,
  countTiles,
  DEFAULT_EXTRACT_TIERS,
  enumerateTiles,
  type ExtractTier,
  isValidKey,
  planUpload,
  rcloneCommand,
  shellQuote,
  tileRange,
} from './tile-plan.js';

const HERE = dirname(fileURLToPath(import.meta.url));

interface LabelContract {
  readonly fontstacks: readonly string[];
  readonly labelFields: readonly string[];
}

/** `label-contract.json` sits beside the sources; the compiled CLI runs from `dist/`. */
function loadLabelContract(): LabelContract {
  const candidates = [join(HERE, 'label-contract.json'), join(HERE, '..', 'label-contract.json')];
  const path = candidates.find((candidate) => existsSync(candidate));
  if (path === undefined) throw new Error('label-contract.json not found beside the CLI');
  return JSON.parse(readFileSync(path, 'utf8')) as LabelContract;
}

class UsageError extends Error {}

function loadTiers(path: string | undefined): readonly ExtractTier[] {
  if (path === undefined) return DEFAULT_EXTRACT_TIERS;
  const tiers = JSON.parse(readFileSync(path, 'utf8')) as ExtractTier[];
  if (!Array.isArray(tiers) || tiers.length === 0) throw new UsageError(`${path}: expected a non-empty tier array`);
  tiers.forEach(assertTier);
  return tiers;
}

function loadManifest(path: string): ExplodeManifest {
  return JSON.parse(readFileSync(path, 'utf8')) as ExplodeManifest;
}

function required(value: string | undefined, flag: string): string {
  if (value === undefined || value === '') throw new UsageError(`${flag} is required`);
  return value;
}

function commandPlan(args: string[]): number {
  const { values } = parseArgs({
    args,
    options: { tiers: { type: 'string' }, source: { type: 'string' } },
    strict: true,
  });
  const tiers = loadTiers(values.tiers);
  const source = values.source ?? '<planet.pmtiles or https URL of a Protomaps daily build>';
  const estimate = countTiles(tiers);
  const out: string[] = ['# Extract tiers'];
  for (const tier of tiers) {
    const top = tileRange(tier.bbox, tier.maxzoom);
    out.push(
      `- ${tier.name}: bbox ${tier.bbox.west},${tier.bbox.south},${tier.bbox.east},${tier.bbox.north}` +
        ` z${tier.minzoom}–z${tier.maxzoom} (z${tier.maxzoom}: x ${top.minX}–${top.maxX}, y ${top.minY}–${top.maxY})`,
    );
  }
  out.push('', '# Distinct tiles (upper bound; = PUT requests on upload)');
  for (const row of estimate.byZoom) out.push(`  z${row.z}: ${row.tiles}`);
  out.push(`  total: ${estimate.total}`, '', '# pmtiles extract commands');
  for (const tier of tiers) {
    const { west, south, east, north } = tier.bbox;
    out.push(
      [
        'pmtiles extract',
        shellQuote(source),
        shellQuote(`extract-${tier.name}.pmtiles`),
        `--bbox=${west},${south},${east},${north}`,
        `--minzoom=${tier.minzoom}`,
        `--maxzoom=${tier.maxzoom}`,
      ].join(' '),
    );
  }
  process.stdout.write(`${out.join('\n')}\n`);
  return 0;
}

async function commandExplode(args: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args,
    options: { out: { type: 'string' }, manifest: { type: 'string' }, tiers: { type: 'string' } },
    strict: true,
    allowPositionals: true,
  });
  const outDir = resolve(required(values.out, '--out'));
  const manifestPath = resolve(required(values.manifest, '--manifest'));
  if (positionals.length === 0) throw new UsageError('at least one extract .pmtiles is required');
  if (manifestPath.startsWith(outDir + sep)) {
    // The tree is uploaded as a whole; a manifest inside it would be published too.
    throw new UsageError('--manifest must not sit inside --out');
  }
  const tiers = loadTiers(values.tiers);
  const { labelFields } = loadLabelContract();
  const seen = new Set<string>();
  const manifests: ExplodeManifest[] = [];
  for (const input of positionals) {
    const source = await fileSource(input);
    try {
      const manifest = await explode({ source, outDir, labelFields, tiers, seen });
      process.stdout.write(`${input}: ${manifest.tiles} new tiles, ${manifest.bytes} bytes\n`);
      manifests.push(manifest);
    } finally {
      await source.close();
    }
  }
  const merged = mergeManifests(manifests);
  writeFileSync(manifestPath, `${JSON.stringify(merged, null, 2)}\n`);
  process.stdout.write(
    `tree: ${merged.tiles} tiles, ${merged.bytes} bytes, ${merged.observedCodepoints.length} distinct label codepoints\n`,
  );
  if (merged.outsideTiers > 0) {
    process.stderr.write(`explode: ${merged.outsideTiers} tiles outside every tier — was the extract cut with another bbox?\n`);
    return 1;
  }
  return 0;
}

function commandGlyphPlan(args: string[]): number {
  const { values } = parseArgs({ args, options: { manifest: { type: 'string' } }, strict: true });
  const manifest = loadManifest(required(values.manifest, '--manifest'));
  const plan = planGlyphs(loadLabelContract().fontstacks, manifest.observedCodepoints);
  const out = [
    `fontstacks: ${plan.fontstacks.join(', ')}`,
    `ranges: ${plan.ranges.map(rangeFileName).join(' ')}`,
    ...plan.extraRanges.map(
      ({ range, firstSeen }) => `extra range ${rangeFileName(range)} (first seen: ${firstSeen})`,
    ),
    ...plan.unrenderable.map(
      ({ codepoint, firstSeen }) => `WARNING unrenderable ${codepointLabel(codepoint)} (in ${firstSeen})`,
    ),
    `files: ${expectedGlyphFiles(plan).length}`,
  ];
  process.stdout.write(`${out.join('\n')}\n`);
  return 0;
}

function commandGlyphCombinations(args: string[]): number {
  const { values } = parseArgs({ args, options: { fonts: { type: 'string' } }, strict: true });
  const fontsDir = resolve(required(values.fonts, '--fonts'));
  const combinations = glyphCombinations(loadLabelContract().fontstacks, readdirSync(fontsDir));
  process.stdout.write(`${JSON.stringify(combinations, null, 2)}\n`);
  return 0;
}

function commandVerifyGlyphs(args: string[]): number {
  const { values } = parseArgs({
    args,
    options: { glyphs: { type: 'string' }, manifest: { type: 'string' }, strict: { type: 'boolean' } },
    strict: true,
  });
  const glyphsDir = resolve(required(values.glyphs, '--glyphs'));
  const manifest = loadManifest(required(values.manifest, '--manifest'));
  const plan = planGlyphs(loadLabelContract().fontstacks, manifest.observedCodepoints);
  const findings = verifyGlyphs(plan, manifest.observedCodepoints, (file) => {
    const path = join(glyphsDir, file);
    return existsSync(path) ? new Uint8Array(readFileSync(path)) : null;
  });
  const errors = findings.filter((finding) => finding.severity === 'error');
  const warnings = findings.filter((finding) => finding.severity === 'warning');
  for (const finding of errors) process.stderr.write(`verify-glyphs: ${finding.file}: ${finding.problem}\n`);
  // One line per range file and fontstack would repeat each warning per fontstack; group
  // by range so the log names each uncovered script once, with a count and an example.
  const byRange = new Map<string, { count: number; first: string }>();
  for (const finding of warnings) {
    const range = finding.file.slice(finding.fontstack.length + 1);
    const entry = byRange.get(range);
    if (entry === undefined) byRange.set(range, { count: 1, first: finding.problem });
    else entry.count += 1;
  }
  for (const [range, { count, first }] of byRange) {
    process.stdout.write(`verify-glyphs: WARNING ${range}: ${count} finding(s) across fontstacks, e.g. ${first}\n`);
  }
  if (errors.length > 0 || (values.strict === true && warnings.length > 0)) return 1;
  process.stdout.write(
    `verify-glyphs: ${expectedGlyphFiles(plan).length} range files, every floor letter and every observed codepoint of a supported script has a glyph (${warnings.length} warning(s))\n`,
  );
  return 0;
}

function countFiles(dir: string, check: (key: string) => boolean): { files: number; badKeys: string[] } {
  let files = 0;
  const badKeys: string[] = [];
  const walk = (current: string): void => {
    for (const name of readdirSync(current)) {
      const path = join(current, name);
      if (statSync(path).isDirectory()) walk(path);
      else {
        files += 1;
        const key = relative(dir, path).split(sep).join('/');
        if (!check(key)) badKeys.push(key);
      }
    }
  };
  walk(dir);
  return { files, badKeys };
}

function commandUploadPlan(args: string[]): number {
  const { values } = parseArgs({
    args,
    options: {
      tiles: { type: 'string' },
      'tiles-version': { type: 'string' },
      manifest: { type: 'string' },
      glyphs: { type: 'string' },
      'glyphs-version': { type: 'string' },
      remote: { type: 'string' },
      'public-base': { type: 'string' },
    },
    strict: true,
  });
  const tilesDir = resolve(required(values.tiles, '--tiles'));
  const manifest = loadManifest(required(values.manifest, '--manifest'));
  const remote = required(values.remote, '--remote');
  const tilesVersion = required(values['tiles-version'], '--tiles-version');
  const glyphsDir = values.glyphs === undefined ? null : resolve(values.glyphs);
  const glyphsVersion = values['glyphs-version'] ?? null;

  const tiles = countFiles(tilesDir, (key) => /^\d+\/\d+\/\d+\.mvt$/u.test(key) && isValidKey(key));
  const glyphs = glyphsDir === null ? null : countFiles(glyphsDir, (key) => isValidKey(key, { allowSpaces: true }));
  const bad = [...tiles.badKeys, ...(glyphs?.badKeys ?? [])];
  if (bad.length > 0) {
    for (const key of bad.slice(0, 20)) process.stderr.write(`upload-plan: not a valid object key: ${key}\n`);
    return 1;
  }
  if (tiles.files !== manifest.tiles) {
    process.stderr.write(`upload-plan: tree holds ${tiles.files} tiles, manifest says ${manifest.tiles}\n`);
    return 1;
  }
  if (manifest.tileCompression !== 'gzip' && manifest.tileCompression !== 'none') {
    process.stderr.write(`upload-plan: tile compression ${manifest.tileCompression} cannot be served\n`);
    return 1;
  }
  const steps = planUpload({
    tilesDir,
    tilesVersion,
    tileCount: tiles.files,
    tileCompression: manifest.tileCompression,
    glyphsDir,
    glyphsVersion,
    glyphCount: glyphs?.files ?? null,
  });
  const out: string[] = ['# Upload plan — data first; switch the client config only after every step succeeded'];
  steps.forEach((step, index) => {
    out.push(`# ${index + 1}. ${step.label}: ${step.objects ?? '?'} objects → ${step.prefix}/`, rcloneCommand(step, remote));
  });
  if (values['public-base'] !== undefined) {
    const templates = clientUrlTemplates(values['public-base'], tilesVersion, glyphsVersion ?? tilesVersion);
    out.push(
      '',
      '# Then set ClientConfig.outdoorBasemap (web) to:',
      `#   tilesUrl:    ${templates.tilesUrl}`,
      `#   glyphsUrl:   ${templates.glyphsUrl}`,
      `#   demTilesUrl: ${templates.demTilesUrl}   (only once the DEM mirror exists; null keeps hillshade off)`,
    );
  }
  process.stdout.write(`${out.join('\n')}\n`);
  return 0;
}

const USER_AGENT = 'fire-watch-tiles/0.1 (+https://github.com/IvanBBaev/fire-watch)';

/** Used for the dry-run byte estimate only, until a run has measured the real average. */
/** The CLI is the clock boundary: `mirrorDem` and the manifest take `now` as input. */
function wallClock(): number {
  // eslint-disable-next-line no-restricted-syntax -- operator CLI pacing real requests
  return Date.now();
}

const NOMINAL_DEM_TILE_BYTES = 110_000;

function numberOption(value: string | undefined, flag: string, fallback: number, min: number, max: number): number {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < min || parsed > max) {
    throw new UsageError(`${flag} must be a number in [${min}, ${max}], got ${JSON.stringify(value)}`);
  }
  return parsed;
}

function megabytes(bytes: number): string {
  return `${(bytes / 1e6).toFixed(1)} MB`;
}

async function fetchDemTile(url: string): Promise<DemFetchResponse> {
  const response = await fetch(url, {
    headers: { 'User-Agent': USER_AGENT },
    signal: AbortSignal.timeout(30_000),
  });
  return {
    status: response.status,
    body: new Uint8Array(await response.arrayBuffer()),
    etag: response.headers.get('etag'),
    lastModified: response.headers.get('last-modified'),
  };
}

async function commandDemMirror(args: string[]): Promise<number> {
  const { values } = parseArgs({
    args,
    options: {
      work: { type: 'string' },
      tiers: { type: 'string' },
      maxzoom: { type: 'string' },
      rate: { type: 'string' },
      concurrency: { type: 'string' },
      remote: { type: 'string' },
      apply: { type: 'boolean' },
    },
    strict: true,
  });
  const workDir = resolve(required(values.work, '--work'));
  const maxzoom = numberOption(values.maxzoom, '--maxzoom', DEM_MAXZOOM, 0, DEM_SOURCE.upstreamMaxzoom);
  const rate = numberOption(values.rate, '--rate', 8, 0.1, 50);
  const concurrency = numberOption(values.concurrency, '--concurrency', 4, 1, 16);
  const tiers = demTiers(loadTiers(values.tiers), maxzoom);
  const estimate = countTiles(tiers);
  const manifest = readDemManifest(workDir) ?? emptyDemManifest(tiers, maxzoom, new Date(wallClock()));
  const plan = planDemMirror(enumerateTiles(tiers), manifest, demSizeOnDisk(workDir));
  const have = summarizeDemManifest(manifest);
  const average = have.tiles > 0 ? have.bytes / have.tiles : NOMINAL_DEM_TILE_BYTES;

  const out: string[] = [
    '# Terrarium DEM mirror (TASKS G3)',
    `source:  ${DEM_SOURCE.urlTemplate}`,
    `registry: ${DEM_SOURCE.registry}`,
    `licence: ${DEM_SOURCE.licence} (credits: packages/contracts/src/credits.ts, layer:terrain)`,
    `work:    ${workDir} → ${join(workDir, 'dem', 'terrarium')}, manifest ${demManifestPath(workDir)}`,
    '',
    `# Tiers, capped at z${maxzoom}`,
    ...tiers.map(
      (tier) =>
        `- ${tier.name}: bbox ${tier.bbox.west},${tier.bbox.south},${tier.bbox.east},${tier.bbox.north} z${tier.minzoom}–z${tier.maxzoom}`,
    ),
    '',
    '# Distinct tiles per zoom',
    ...estimate.byZoom.map((row) => `  z${row.z}: ${row.tiles}`),
    `  total: ${estimate.total}`,
    '',
    `present: ${plan.present} (manifest holds ${have.tiles}, ${megabytes(have.bytes)}; ${plan.outsidePlan} outside this plan, kept)`,
    `to fetch: ${plan.fetch.length} ≈ ${megabytes(plan.fetch.length * average)}` +
      ` (${have.tiles > 0 ? 'measured' : 'nominal'} ${Math.round(average / 1000)} kB/tile),` +
      ` ≥ ${Math.ceil(plan.fetch.length / rate / 60)} min at ${rate} req/s, ${concurrency} in flight`,
    ...plan.fetch.slice(0, 3).map((tile) => `  e.g. ${demTileUrl(tile)}`),
  ];
  if (values.remote !== undefined) {
    out.push('', '# Upload (after a clean dem-verify)', rcloneCommand(demUploadStep(workDir, estimate.total), values.remote));
  }
  process.stdout.write(`${out.join('\n')}\n`);

  if (values.apply !== true) {
    process.stdout.write('== dry run: nothing downloaded. Re-run with --apply.\n');
    return 0;
  }
  if (plan.fetch.length === 0) {
    process.stdout.write('dem-mirror: nothing to fetch\n');
    return 0;
  }
  const started = wallClock();
  const result = await mirrorDem({
    workDir,
    manifest: { ...manifest, tiers, maxzoom },
    tiles: plan.fetch,
    fetchTile: fetchDemTile,
    sleep: (ms) => new Promise((done) => setTimeout(done, ms)),
    now: wallClock,
    ratePerSecond: rate,
    concurrency,
    log: (line) => process.stdout.write(`dem-mirror: ${line}\n`),
  });
  const total = summarizeDemManifest(result.manifest);
  process.stdout.write(
    `dem-mirror: fetched ${result.fetched} tiles, ${megabytes(result.bytes)} in ${Math.round((wallClock() - started) / 1000)} s;` +
      ` manifest now ${total.tiles} tiles, ${megabytes(total.bytes)}\n`,
  );
  for (const finding of result.failed.slice(0, 20)) {
    process.stderr.write(`dem-mirror: ${finding.id}: ${finding.problem}\n`);
  }
  if (result.failed.length > 0) {
    process.stderr.write(`dem-mirror: ${result.failed.length} tile(s) failed — re-run to retry them\n`);
    return 1;
  }
  return 0;
}

function commandDemVerify(args: string[]): number {
  const { values } = parseArgs({ args, options: { work: { type: 'string' } }, strict: true });
  const workDir = resolve(required(values.work, '--work'));
  const manifest = readDemManifest(workDir);
  if (manifest === null) {
    process.stderr.write(`dem-verify: no manifest at ${demManifestPath(workDir)}\n`);
    return 1;
  }
  const findings = verifyDemMirror(enumerateTiles(manifest.tiers), manifest, (tile) => {
    const file = demTileFile(workDir, tile);
    return existsSync(file) ? new Uint8Array(readFileSync(file)) : null;
  });
  for (const finding of findings.slice(0, 20)) process.stderr.write(`dem-verify: ${finding.id}: ${finding.problem}\n`);
  if (findings.length > 0) {
    process.stderr.write(`dem-verify: ${findings.length} finding(s)\n`);
    return 1;
  }
  const summary = summarizeDemManifest(manifest);
  process.stdout.write(
    `dem-verify: ${summary.tiles} tiles z0–z${manifest.maxzoom}, ${megabytes(summary.bytes)}; every planned tile is on disk, matches its sha256 and is a 256 px Terrarium PNG\n`,
  );
  return 0;
}

async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;
  switch (command) {
    case 'plan':
      return commandPlan(rest);
    case 'explode':
      return commandExplode(rest);
    case 'glyph-plan':
      return commandGlyphPlan(rest);
    case 'glyph-combinations':
      return commandGlyphCombinations(rest);
    case 'verify-glyphs':
      return commandVerifyGlyphs(rest);
    case 'upload-plan':
      return commandUploadPlan(rest);
    case 'dem-mirror':
      return commandDemMirror(rest);
    case 'dem-verify':
      return commandDemVerify(rest);
    default:
      throw new UsageError(
        `unknown command ${JSON.stringify(command ?? '')} — plan | explode | glyph-plan | glyph-combinations | verify-glyphs | upload-plan | dem-mirror | dem-verify`,
      );
  }
}

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    const usage = error instanceof UsageError || (error instanceof Error && 'code' in error && String(error.code).startsWith('ERR_PARSE_ARGS'));
    process.stderr.write(`tiles: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = usage ? 2 : 1;
  },
);
