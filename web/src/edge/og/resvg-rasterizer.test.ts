/**
 * TASKS V2-D4 — the real rasteriser: the fixture event's card, in both locales, comes out
 * as a 1200×630 PNG, byte-identical on every render (the ETag promises exactly that), and
 * its text is drawn with the bundled Noto subsets rather than left blank.
 */

import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { parseSnapshot } from '../../core/feed/parse-snapshot.js';
import { findSnapshotEvent, ogCardImage } from './og-card.js';
import { createResvgRasterizer } from './resvg-rasterizer.js';

const require = createRequire(import.meta.url);
const WASM = readFileSync(require.resolve('@resvg/resvg-wasm/index_bg.wasm'));
const FONTS = ['noto-sans-regular-subset.bin', 'noto-sans-bold-subset.bin'].map(
  (name) =>
    new Uint8Array(readFileSync(fileURLToPath(new URL(`./fonts/${name}`, import.meta.url)))),
);
const SNAPSHOT = parseSnapshot(
  JSON.parse(
    readFileSync(
      fileURLToPath(new URL('../../../public/fixtures/snapshot.json', import.meta.url)),
      'utf8',
    ),
  ),
);
const NOW = Date.parse(SNAPSHOT.generatedAt) + 60_000;

const rasterize = createResvgRasterizer({
  wasm: WASM,
  fonts: FONTS,
  defaultFontFamily: 'Noto Sans',
});

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

function pngSize(png: Uint8Array): { width: number; height: number } {
  const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
  return { width: view.getUint32(16), height: view.getUint32(20) };
}

function card(locale: 'bg' | 'en'): string {
  const event = findSnapshotEvent(SNAPSHOT, 'fw-2026-q7f3d');
  if (event === null) throw new Error('fixture event missing');
  return ogCardImage({
    snapshot: SNAPSHOT,
    event,
    locale,
    origin: 'https://firewatch.example',
    nowMs: NOW,
  }).svg;
}

describe('resvg-wasm rasteriser (TASKS V2-D4)', () => {
  it('renders the card as a 1200x630 PNG, identically every time', async () => {
    for (const locale of ['bg', 'en'] as const) {
      const svg = card(locale);
      const first = await rasterize(svg);
      const second = await rasterize(svg);
      expect([...first.slice(0, 8)]).toEqual(PNG_SIGNATURE);
      expect(pngSize(first)).toEqual({ width: 1200, height: 630 });
      expect(Buffer.from(second).equals(Buffer.from(first))).toBe(true);
    }
  });

  it('draws text with the bundled fonts, Cyrillic included', async () => {
    const svg = (text: string): string =>
      `<svg xmlns="http://www.w3.org/2000/svg" width="200" height="40"><text x="4" y="28" font-family="system-ui, 'Noto Sans', sans-serif" font-size="24">${text}</text></svg>`;
    const blank = await rasterize(svg(''));
    const latin = await rasterize(svg('Harmanli'));
    const cyrillic = await rasterize(svg('Харманли'));
    expect(Buffer.from(latin).equals(Buffer.from(blank))).toBe(false);
    expect(Buffer.from(cyrillic).equals(Buffer.from(blank))).toBe(false);
    expect(Buffer.from(cyrillic).equals(Buffer.from(latin))).toBe(false);
  });
});
