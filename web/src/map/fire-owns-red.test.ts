/**
 * CI-14 — fire owns red, and the fire palette survives colour-vision deficiency
 * (review 06 §5.4, 07 §5.3.5 / §5.8.1, 08 §5.6, ADR-005 D4).
 *
 * **What is walked.** Nothing here is a hand-kept file list:
 * - every `.css` file under `web/` (build output, dependencies and test code excluded);
 * - every quoted colour literal in every `.ts` / `.tsx` / `.html` file under the same walk;
 * - every `.json` file there shaped like a MapLibre style (`version: 8`, a `layers` array)
 *   — none exists today; the default basemap is an external URL (see below);
 * - the self-hosted outdoor basemap (G3), built by {@link buildOutdoorStyle} for both themes
 *   with the DEM hillshade — it is code, not JSON, so the gate builds it rather than finds it;
 * - the runtime fire style exactly as the map receives it: {@link applyFireLayers} and
 *   {@link applyFireImages} run against recording hosts, so the layers, expressions and
 *   pattern-image pixels checked are the ones MapLibre is handed, not a copy of them.
 * Reach is asserted, not trusted: every stylesheet the app imports was walked, every colour
 * the fire style paints was traced back to a literal in source, every registry layer was
 * read.
 *
 * **How it classifies.** A map layer is fire-owned by its id prefix (`fire-` / `alert-`,
 * 06 §5.4); a pattern image by the `fire-` prefix; a CSS declaration by the custom-property
 * namespace `--fire-*` / `--color-fire-*`. Everything else is not fire, and a non-fire CSS
 * declaration that *reads* a fire token (`var(--fire-…)`) is borrowing fire's colour just as
 * surely as one that writes the hex. A source literal is judged by the layer it paints when
 * the fire style paints it, and as UI chrome when nothing does.
 *
 * **What fails.** A non-fire colour in the reserved hue band (OKLCH h ∈ [20°, 55°] ∪
 * [350°, 360°], C > 0.09); two fire classes the style paints in different colours that fall
 * below ΔE00 15 under Machado 2009 protanopia, deuteranopia or tritanopia with no size
 * difference to tell them apart; and any colour, expression, or stylesheet the walk cannot
 * read. The first two are compared as an exact register below, so a new violation and a
 * silently fixed one both go red; the third throws.
 */

// The web tsconfig is browser-only (`types: ["vite/client"]`); this gate runs in the node
// vitest project and walks the package on disk. Scoped to the one file that needs it.
/// <reference types="node" />

import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { LIFECYCLE_STATES, SCORE_BUCKETS } from '@fire-watch/contracts';

import type { Rgba } from '../core/color/color.js';
import { formatHex, parseColor, toOklch } from '../core/color/color.js';
import { DEFAULT_CONFIG } from '../core/config.js';
import type { CssColorDeclaration } from '../core/color/css-colors.js';
import { extractCssColors } from '../core/color/css-colors.js';
import type { SourceColorLiteral } from '../core/color/source-literals.js';
import { extractSourceColors } from '../core/color/source-literals.js';
import type { PatternImage } from './hatch.js';
import { FIRE_LAYER_IDS, applyFireImages, applyFireLayers } from './layer-registry.js';
import type { OutdoorStyleInputs } from './outdoor-style.js';
import { buildOutdoorStyle } from './outdoor-style.js';
import type { FireClass, ImageColors, StyleLayerLike } from './style-colors.js';
import {
  cvdCollapses,
  hueViolations,
  isFireHue,
  isFireOwnedImageId,
  opaqueColors,
  paintedColors,
} from './style-colors.js';

const WEB_ROOT = fileURLToPath(new URL('../../', import.meta.url));
const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url));

/** Build output, dependencies and test code: none of it paints anything a user sees. */
const SKIPPED_DIRECTORIES = new Set(['node_modules', 'dist', 'dist-types', 'e2e']);
const TEST_FILE = /\.(?:test|spec|e2e)\.[cm]?tsx?$/u;

function walk(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return SKIPPED_DIRECTORIES.has(entry.name) ? [] : walk(path);
    return TEST_FILE.test(entry.name) ? [] : [path];
  });
}

const files = walk(WEB_ROOT).sort();
const repoPath = (path: string): string => relative(REPO_ROOT, path).split('\\').join('/');
const read = (path: string): string => readFileSync(path, 'utf8');

/** Re-throws with the file name — a parse error without a file is a riddle. */
function inFile<T>(path: string, run: () => T): T {
  try {
    return run();
  } catch (error) {
    throw new Error(
      `${repoPath(path)}: ${error instanceof Error ? error.message : String(error)}`,
      {
        cause: error,
      },
    );
  }
}

const cssFiles = files.filter((path) => path.endsWith('.css'));
const css = new Map<string, CssColorDeclaration[]>(
  cssFiles.map((path) => [repoPath(path), inFile(path, () => extractCssColors(read(path)))]),
);

const sourceFiles = files.filter((path) => /\.(?:tsx?|html)$/u.test(path));
const literals: Array<SourceColorLiteral & { readonly file: string }> = sourceFiles.flatMap(
  (path) =>
    inFile(path, () => extractSourceColors(read(path))).map((literal) => ({
      ...literal,
      file: repoPath(path),
    })),
);

/** Style JSON in the tree. A file that mentions `"layers"` but will not parse is an error. */
const styleFiles = files
  .filter((path) => path.endsWith('.json'))
  .flatMap((path) => {
    const text = read(path);
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (error) {
      if (!text.includes('"layers"')) return []; // JSONC config, not a style
      throw new Error(`${repoPath(path)}: unparseable JSON that may be a style: ${String(error)}`, {
        cause: error,
      });
    }
    const style = parsed as { version?: unknown; layers?: unknown };
    if (style.version !== 8 || !Array.isArray(style.layers)) return [];
    return [{ file: repoPath(path), layers: style.layers as StyleLayerLike[] }];
  });

// The runtime fire style, captured through the same seams the map calls.
const registryLayers: StyleLayerLike[] = [];
applyFireLayers({
  getSource: () => undefined,
  addSource: () => undefined,
  getLayer: () => undefined,
  addLayer: (layer) => registryLayers.push(layer),
});
const images = new Map<string, readonly Rgba[]>();
applyFireImages({
  hasImage: () => false,
  addImage: (id: string, image: PatternImage) => images.set(id, opaqueColors(image.data)),
});
const imageColors: ImageColors = images;

// The self-hosted outdoor basemap (G3) is built in code, not stored as JSON, so the gate
// builds both themes — with the DEM hillshade, the fullest variant — and reads them too.
const OUTDOOR_GATE_URLS: OutdoorStyleInputs = {
  tilesUrl: 'https://tiles.example.org/tiles/v/{z}/{x}/{y}.mvt',
  glyphsUrl: 'https://tiles.example.org/fonts/v/{fontstack}/{range}.pbf',
  demTilesUrl: 'https://tiles.example.org/dem/terrarium/{z}/{x}/{y}.png',
  maxzoom: 14,
};
const outdoorLayers = (['light', 'dark'] as const).flatMap(
  (theme) => buildOutdoorStyle(theme, OUTDOOR_GATE_URLS).layers as unknown as StyleLayerLike[],
);

const allLayers: StyleLayerLike[] = [
  ...registryLayers,
  ...styleFiles.flatMap((style) => style.layers),
  ...outdoorLayers,
];
const painted = paintedColors(allLayers, imageColors);

const hex = (color: Rgba): string => formatHex(color);
const where = (color: Rgba): string => {
  const at = literals.filter((literal) => hex(literal.color) === hex(color));
  return at.length === 0 ? '(no literal)' : at.map((l) => `${l.file}:${String(l.line)}`).join(', ');
};
const describeHue = (color: Rgba): string => {
  const { c, h } = toOklch(color);
  return `h=${h.toFixed(1)} C=${c.toFixed(3)}`;
};

/** Every fire kind the contract can emit; the class check runs over all of them. */
const FIRE_CLASSES: FireClass[] = LIFECYCLE_STATES.flatMap((status) =>
  SCORE_BUCKETS.map((bucket) => ({
    name: `${status}/${bucket}`,
    properties: { status, score_bucket: bucket, area_ha: null },
  })),
);

const FIRE_TOKEN = /^--(?:color-)?fire-/u;

interface Finding {
  readonly key: string;
  readonly at: string;
}

function findings(): Finding[] {
  const out: Finding[] = [];

  // 1. Map style: fire hues only on fire-owned layers.
  for (const entry of hueViolations(painted)) {
    const via = entry.imageId === undefined ? '' : ` via ${entry.imageId}`;
    out.push({
      key: `style ${entry.layerId} ${entry.property} ${hex(entry.color)}${via}`,
      at: `${where(entry.color)} (${describeHue(entry.color)})`,
    });
  }

  // 2. Pattern images outside the fire namespace may not carry fire hues either.
  for (const [id, colors] of images) {
    for (const color of colors) {
      if (!isFireOwnedImageId(id) && isFireHue(color)) {
        out.push({ key: `image ${id} ${hex(color)}`, at: where(color) });
      }
    }
  }

  // 3. Stylesheets: fire hues and fire tokens only inside the fire token namespace.
  for (const [file, declarations] of css) {
    for (const declaration of declarations) {
      if (FIRE_TOKEN.test(declaration.property)) continue;
      const rule = declaration.context.join(' > ');
      for (const token of declaration.colors) {
        if (!isFireHue(token.color)) continue;
        out.push({
          key: `css ${file} ${rule} ${declaration.property} ${hex(token.color)}`,
          at: `${file}:${String(declaration.line)} ${token.text} (${describeHue(token.color)})`,
        });
      }
      for (const reference of declaration.varReferences) {
        if (!FIRE_TOKEN.test(reference)) continue;
        out.push({
          key: `css ${file} ${rule} ${declaration.property} var(${reference})`,
          at: `${file}:${String(declaration.line)}`,
        });
      }
    }
  }

  // 4. Source literals the fire style does not paint are UI chrome.
  const paintedHex = new Set(painted.map((entry) => hex(entry.color)));
  for (const literal of literals) {
    if (paintedHex.has(hex(literal.color)) || !isFireHue(literal.color)) continue;
    out.push({
      key: `literal ${literal.file} ${hex(literal.color)}`,
      at: `${literal.file}:${String(literal.line)} ${literal.text} (${describeHue(literal.color)})`,
    });
  }

  // 5. CVD over the fire registry — the fire palette (06 §5.4, 07 §5.8.1).
  for (const collapse of cvdCollapses(registryLayers, FIRE_CLASSES, imageColors)) {
    const failures = collapse.failures
      .map(([kind, deltaE]) => `${kind}=${deltaE.toFixed(1)}`)
      .join(' ');
    out.push({
      key: `cvd ${collapse.layerId} ${collapse.property} ${collapse.colors.join('~')} ${failures}`,
      at: `${collapse.classes.join(' vs ')}; ${collapse.colors
        .map((color) => `${color} at ${where(parseColor(color))}`)
        .join('; ')}`,
    });
  }

  return out.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
}

/**
 * The violations on record, exactly. Recording is not accepting: each is a founder or
 * design decision (recolour, rename, or add a redundant channel), and until one is taken
 * the gate pins the current set so it can neither grow nor shrink unnoticed.
 */
const KNOWN_FINDINGS: readonly string[] = [
  // 1. Hue. `detection-dot` paints COLOR_DETECTION (red-orange, h≈42°, C≈0.19) under an id
  //    without the reserved prefix. The registry treats it as fire; 06 §5.4 classifies by
  //    prefix. Either the id moves under `fire-` or the colour leaves the band.
  'style detection-dot circle-color #e8590c',

  // 2. CVD, confirmed vs likely/unverified. Red and orange collapse for deuteranopes and
  //    tritanopes (protanopia clears at ≈15.8). On the dot, `unverified` is rescued by its
  //    0.75× radius but `likely` is not; fills and outlines have no size channel at all.
  'cvd fire-cell fill-pattern #d7301f~#f16913 deuteranopia=11.3 tritanopia=10.0',
  'cvd fire-cell-outline line-color #d7301f~#f16913 deuteranopia=11.3 tritanopia=10.0',
  'cvd fire-dot circle-color #d7301f~#f16913 deuteranopia=11.3 tritanopia=10.0',
  'cvd fire-hull fill-color #d7301f~#f16913 deuteranopia=11.3 tritanopia=10.0',
  'cvd fire-hull fill-outline-color #d7301f~#f16913 deuteranopia=11.3 tritanopia=10.0',

  // 3. CVD, no longer detected vs officially contained/extinguished. The gray and the
  //    gray-blue are ΔE00 ≈7.5 apart even for normal vision, and closer under every
  //    simulation; nothing but the label separates them.
  'cvd fire-cell fill-pattern #7d93ab~#8b9198 protanopia=7.2 deuteranopia=7.9 tritanopia=9.2',
  'cvd fire-cell-outline line-color #7d93ab~#8b9198 protanopia=7.2 deuteranopia=7.9 tritanopia=9.2',
  'cvd fire-dot circle-color #7d93ab~#8b9198 protanopia=7.2 deuteranopia=7.9 tritanopia=9.2',
  'cvd fire-hull fill-color #7d93ab~#8b9198 protanopia=7.2 deuteranopia=7.9 tritanopia=9.2',
  'cvd fire-hull fill-outline-color #7d93ab~#8b9198 protanopia=7.2 deuteranopia=7.9 tritanopia=9.2',
];

describe('CI-14 — fire owns red, and survives CVD', () => {
  it('finds exactly the violations on record', () => {
    const actual = findings();
    expect(
      actual.map((finding) => finding.key),
      actual.map((finding) => `${finding.key}\n    at ${finding.at}`).join('\n'),
    ).toStrictEqual([...KNOWN_FINDINGS].sort());
  });

  it('walked every stylesheet the app imports', () => {
    const imported = sourceFiles.flatMap((path) =>
      [...read(path).matchAll(/import\s+['"](\.{1,2}\/[^'"]+\.css)['"]/gu)].map((match) =>
        repoPath(join(path, '..', match[1] ?? '')),
      ),
    );
    expect(imported.length).toBeGreaterThan(0);
    expect([...new Set(imported)].filter((file) => !css.has(file))).toStrictEqual([]);
    for (const [file, declarations] of css) {
      expect(declarations.length, `${file} yielded no colours`).toBeGreaterThan(0);
    }
  });

  it('read every registry layer and traced every painted colour to a source literal', () => {
    expect(registryLayers.map((layer) => layer.id)).toStrictEqual([...FIRE_LAYER_IDS]);
    const untraced = painted
      .filter((entry) => !literals.some((literal) => hex(literal.color) === hex(entry.color)))
      .map((entry) => `${entry.layerId} ${entry.property} ${hex(entry.color)}`);
    expect(untraced).toStrictEqual([]);
    expect(images.size).toBeGreaterThan(0);
  });

  it('knows the basemap is external and not yet linted', () => {
    // 06 §5.4 lints the style JSON. Ours comes from a CDN (openfreemap), so there is no
    // local file to read; when a style is vendored into web/ the JSON walk above picks it
    // up with no change here. This pins the assumption, so a local style URL cannot slip
    // past a walk that never saw it.
    expect(
      Object.values(DEFAULT_CONFIG.basemapStyleUrl).every((url) => /^https:\/\//u.test(url)),
    ).toBe(true);
  });
});
