#!/usr/bin/env node
/**
 * The basemap build tool (TASKS G1/G2). `build.sh` drives it; every subcommand is also
 * runnable by hand.
 *
 *   node infra/tiles/dist/cli.js plan [--tiers <json>] [--source <planet.pmtiles|url>]
 *   node infra/tiles/dist/cli.js explode --out <dir> --manifest <file> [--tiers <json>] <extract.pmtiles>…
 *   node infra/tiles/dist/cli.js glyph-plan --manifest <file>
 *   node infra/tiles/dist/cli.js verify-glyphs --glyphs <dir> --manifest <file>
 *   node infra/tiles/dist/cli.js upload-plan --tiles <dir> --tiles-version <v> --manifest <file>
 *        --remote <rclone-remote:bucket> [--glyphs <dir> --glyphs-version <v>] [--public-base <https-url>]
 *
 * Nothing here touches the network: `plan` and `upload-plan` print the commands that do,
 * and `build.sh` runs them only with `--apply`.
 *
 * Exit codes: 0 ok, 1 a check failed, 2 usage error.
 */

import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

import { explode, type ExplodeManifest, fileSource, mergeManifests } from './explode.js';
import { codepointLabel, expectedGlyphFiles, planGlyphs, rangeFileName, verifyGlyphs } from './glyph-plan.js';
import {
  assertTier,
  clientUrlTemplates,
  countTiles,
  DEFAULT_EXTRACT_TIERS,
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

function commandVerifyGlyphs(args: string[]): number {
  const { values } = parseArgs({
    args,
    options: { glyphs: { type: 'string' }, manifest: { type: 'string' } },
    strict: true,
  });
  const glyphsDir = resolve(required(values.glyphs, '--glyphs'));
  const manifest = loadManifest(required(values.manifest, '--manifest'));
  const plan = planGlyphs(loadLabelContract().fontstacks, manifest.observedCodepoints);
  const findings = verifyGlyphs(plan, manifest.observedCodepoints, (file) => {
    const path = join(glyphsDir, file);
    return existsSync(path) ? new Uint8Array(readFileSync(path)) : null;
  });
  for (const finding of findings) process.stderr.write(`verify-glyphs: ${finding.file}: ${finding.problem}\n`);
  if (findings.length > 0) return 1;
  process.stdout.write(
    `verify-glyphs: ${expectedGlyphFiles(plan).length} range files, every required and observed codepoint has a glyph\n`,
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

async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;
  switch (command) {
    case 'plan':
      return commandPlan(rest);
    case 'explode':
      return commandExplode(rest);
    case 'glyph-plan':
      return commandGlyphPlan(rest);
    case 'verify-glyphs':
      return commandVerifyGlyphs(rest);
    case 'upload-plan':
      return commandUploadPlan(rest);
    default:
      throw new UsageError(
        `unknown command ${JSON.stringify(command ?? '')} — plan | explode | glyph-plan | verify-glyphs | upload-plan`,
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
