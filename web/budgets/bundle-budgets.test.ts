import { describe, expect, it } from 'vitest';

import { BUDGETS, checkBuild, KIB } from './bundle-budgets.js';
import type { BuildDescription, Manifest } from './bundle-budgets.js';

/** The shape the real build has today: one HTML entry, two catalogs, one map root. */
const MANIFEST: Manifest = {
  'index.html': {
    file: 'assets/index.js',
    src: 'index.html',
    isEntry: true,
    dynamicImports: ['src/core/i18n/bg.ts', 'src/core/i18n/en.ts', 'src/map/index.ts'],
    css: ['assets/index.css'],
  },
  'src/core/i18n/bg.ts': {
    file: 'assets/bg.js',
    src: 'src/core/i18n/bg.ts',
    isDynamicEntry: true,
    imports: ['index.html'],
  },
  'src/core/i18n/en.ts': {
    file: 'assets/en.js',
    src: 'src/core/i18n/en.ts',
    isDynamicEntry: true,
    imports: ['index.html'],
  },
  'src/map/index.ts': {
    file: 'assets/map.js',
    src: 'src/map/index.ts',
    isDynamicEntry: true,
    imports: ['index.html'],
  },
};

const SIZES: Readonly<Record<string, number>> = {
  'assets/index.js': 30_000,
  'assets/bg.js': 4_000,
  'assets/en.js': 3_000,
  'assets/map.js': 250_000,
  'assets/index.css': 2_000,
};

const HTML =
  '<script type="module" crossorigin src="/assets/index.js"></script>' +
  '<link rel="stylesheet" crossorigin href="/assets/index.css">';

interface Overrides {
  readonly manifest?: Manifest;
  readonly extraFiles?: readonly string[];
  readonly publicFiles?: readonly string[];
  readonly sizes?: Readonly<Record<string, number>>;
  readonly texts?: Readonly<Record<string, string>>;
}

function build(overrides: Overrides = {}): BuildDescription {
  const manifest = overrides.manifest ?? MANIFEST;
  const sizes = { ...SIZES, ...overrides.sizes };
  const texts: Readonly<Record<string, string>> = {
    'index.html': HTML,
    'assets/index.css': 'body{font-family:system-ui,sans-serif}',
    ...overrides.texts,
  };
  const chunkFiles = Object.values(manifest).flatMap((chunk) => [
    chunk.file,
    `${chunk.file}.map`,
    ...(chunk.css ?? []),
  ]);
  const publicFiles = overrides.publicFiles ?? [];
  return {
    manifest,
    distFiles: [
      ...new Set([
        'index.html',
        '.vite/manifest.json',
        ...chunkFiles,
        ...publicFiles,
        ...(overrides.extraFiles ?? []),
      ]),
    ].sort(),
    publicFiles,
    gzipSize: (file) => sizes[file] ?? 0,
    text: (file) => texts[file] ?? '',
  };
}

function bytes(report: ReturnType<typeof checkBuild>): Record<string, number> {
  return Object.fromEntries(report.measurements.map((m) => [m.budget, m.bytes]));
}

describe('checkBuild — classification', () => {
  it('derives every budget from the chunk graph of a well-formed build', () => {
    const report = checkBuild(build());
    expect(report.errors).toStrictEqual([]);
    expect(bytes(report)).toStrictEqual({
      // Entry plus the heavier catalog, because the active locale is not known.
      entry: 30_000 + 4_000,
      map: 250_000,
      criticalPath: 30_000 + 4_000 + 250_000,
      css: 2_000,
    });
    expect(report.measurements.find((m) => m.budget === 'entry')?.files).toStrictEqual([
      'assets/bg.js',
      'assets/index.js',
    ]);
    expect(report.overBudget).toStrictEqual([]);
  });

  it('charges a chunk shared by entry and map to the entry only, and once on the path', () => {
    const manifest: Manifest = {
      ...MANIFEST,
      'index.html': { ...MANIFEST['index.html']!, imports: ['_shared.js'] },
      '_shared.js': { file: 'assets/shared.js' },
      'src/map/index.ts': {
        ...MANIFEST['src/map/index.ts']!,
        imports: ['index.html', '_shared.js', '_maplibre.js'],
      },
      '_maplibre.js': { file: 'assets/maplibre.js' },
    };
    const report = checkBuild(
      build({ manifest, sizes: { 'assets/shared.js': 1_000, 'assets/maplibre.js': 9_000 } }),
    );
    expect(report.errors).toStrictEqual([]);
    expect(bytes(report)).toStrictEqual({
      entry: 30_000 + 1_000 + 4_000,
      map: 250_000 + 9_000,
      criticalPath: 30_000 + 1_000 + 4_000 + 250_000 + 9_000,
      css: 2_000,
    });
  });

  it('fails on a lazy chunk no role claims', () => {
    const manifest: Manifest = {
      ...MANIFEST,
      'src/ui/pages/settings.tsx': {
        file: 'assets/settings.js',
        src: 'src/ui/pages/settings.tsx',
        isDynamicEntry: true,
        imports: ['index.html'],
      },
    };
    expect(checkBuild(build({ manifest })).errors).toStrictEqual([
      'lazy chunk "assets/settings.js" (from src/ui/pages/settings.tsx) has no role in ' +
        'LAZY_ROLES; decide which budget it belongs to before it can ship',
    ]);
  });

  it('keeps an on-demand page chunk, and what only it imports, out of every budget', () => {
    const manifest: Manifest = {
      ...MANIFEST,
      'src/ui/pages/sign-in.tsx': {
        file: 'assets/sign-in.js',
        src: 'src/ui/pages/sign-in.tsx',
        isDynamicEntry: true,
        imports: ['index.html', '_page-only.js'],
      },
      '_page-only.js': { file: 'assets/page-only.js' },
    };
    const report = checkBuild(
      build({ manifest, sizes: { 'assets/sign-in.js': 50_000, 'assets/page-only.js': 7_000 } }),
    );
    expect(report.errors).toStrictEqual([]);
    expect(bytes(report)).toStrictEqual({
      entry: 30_000 + 4_000,
      map: 250_000,
      criticalPath: 30_000 + 4_000 + 250_000,
      css: 2_000,
    });
  });

  it('fails on a second entry point and on a chunk reachable from nothing', () => {
    const manifest: Manifest = {
      ...MANIFEST,
      'sw.ts': { file: 'sw.js', src: 'sw.ts', isEntry: true },
      '_orphan.js': { file: 'assets/orphan.js' },
    };
    expect(checkBuild(build({ manifest })).errors).toStrictEqual([
      'entry "sw.ts" is not the HTML entry; CI-12 has no budget for a second entry point',
      'chunk "assets/orphan.js" (_orphan.js) is reachable from no budget',
      'chunk "sw.js" (sw.ts) is reachable from no budget',
    ]);
  });

  it('fails when the map root is missing, so the map budget cannot measure nothing', () => {
    const { 'src/map/index.ts': _map, ...manifest } = MANIFEST;
    expect(checkBuild(build({ manifest })).errors).toStrictEqual([
      'expected exactly one lazy map root, found 0',
    ]);
  });

  it('fails on a file in dist that neither the manifest nor web/public explains', () => {
    const report = checkBuild(build({ extraFiles: ['assets/worker.js', 'assets/loose.css'] }));
    expect(report.errors).toStrictEqual([
      'stylesheet "assets/loose.css" is in dist but attached to no chunk in the manifest',
      '"assets/loose.css" is in dist but no rule classifies it',
      '"assets/worker.js" is in dist but no rule classifies it',
    ]);
  });

  it('charges a worker script to the chunk that names it, and so to its budgets', () => {
    // `?worker&url` emits the worker with no manifest record; only its URL is in the chunk.
    const report = checkBuild(
      build({
        extraFiles: ['assets/maplibre-gl-worker-abc.js', 'assets/maplibre-gl-worker-abc.js.map'],
        sizes: { 'assets/maplibre-gl-worker-abc.js': 120_000 },
        texts: { 'assets/map.js': 'new URL("/assets/maplibre-gl-worker-abc.js",import.meta.url)' },
      }),
    );
    expect(report.errors).toStrictEqual([]);
    expect(bytes(report)).toStrictEqual({
      entry: 30_000 + 4_000,
      map: 250_000 + 120_000,
      criticalPath: 30_000 + 4_000 + 250_000 + 120_000,
      css: 2_000,
    });
    expect(report.measurements.find((m) => m.budget === 'map')?.files).toStrictEqual([
      'assets/map.js',
      'assets/maplibre-gl-worker-abc.js',
    ]);
  });

  it('follows a worker that starts another worker', () => {
    const report = checkBuild(
      build({
        extraFiles: ['assets/outer.js', 'assets/inner.js'],
        sizes: { 'assets/outer.js': 10_000, 'assets/inner.js': 1_000 },
        texts: { 'assets/map.js': '"assets/outer.js"', 'assets/outer.js': '"assets/inner.js"' },
      }),
    );
    expect(report.errors).toStrictEqual([]);
    expect(bytes(report)['map']).toBe(250_000 + 10_000 + 1_000);
  });

  it('accepts files copied from web/public and source maps of known files', () => {
    const report = checkBuild(build({ publicFiles: ['fixtures/snapshot.json'] }));
    expect(report.errors).toStrictEqual([]);
  });

  it('fails when index.html fetches anything outside the entry chunk', () => {
    const texts = { 'index.html': `${HTML}<link rel="modulepreload" href="/assets/map.js">` };
    expect(checkBuild(build({ texts })).errors).toStrictEqual([
      'index.html references "/assets/map.js", which is not a file of the entry chunk',
    ]);
  });
});

describe('checkBuild — UI fonts are the system stack', () => {
  it('fails on a webfont file anywhere in dist', () => {
    const report = checkBuild(
      build({ publicFiles: ['fonts/inter.woff2'], extraFiles: ['assets/x.ttf'] }),
    );
    expect(report.errors).toStrictEqual([
      '"assets/x.ttf" is in dist but no rule classifies it',
      '"assets/x.ttf" is a webfont; UI fonts are the system stack',
      '"fonts/inter.woff2" is a webfont; UI fonts are the system stack',
    ]);
  });

  it('fails on @font-face and on a surviving @import', () => {
    const texts = {
      'assets/index.css':
        '@import url(https://fonts.example/css);@font-face{font-family:X;src:local(X)}',
    };
    expect(checkBuild(build({ texts })).errors).toStrictEqual([
      '"assets/index.css" declares @font-face; UI fonts are the system stack',
      '"assets/index.css" keeps an @import the build did not inline',
    ]);
  });
});

describe('checkBuild — budgets', () => {
  it('uses the ADR-005 D3 numbers in KiB', () => {
    expect(BUDGETS).toStrictEqual({
      entry: 85 * 1024,
      map: 290 * 1024,
      criticalPath: 350 * 1024,
      css: 20 * 1024,
    });
  });

  it('is inclusive at the limit and over at one byte more', () => {
    const atLimit = { 'assets/index.css': BUDGETS.css };
    expect(checkBuild(build({ sizes: atLimit })).overBudget).toStrictEqual([]);
    const over = { 'assets/index.css': BUDGETS.css + 1 };
    expect(checkBuild(build({ sizes: over })).overBudget).toStrictEqual(['css']);
  });

  it('reports the critical path over even when entry and map each fit', () => {
    const sizes = { 'assets/index.js': 80 * KIB, 'assets/map.js': 280 * KIB };
    expect(checkBuild(build({ sizes })).overBudget).toStrictEqual(['criticalPath']);
  });
});
