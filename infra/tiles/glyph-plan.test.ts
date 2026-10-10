import { readFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';

import { describe, expect, it } from 'vitest';

import {
  classifyMissing,
  encodeGlyphPbf,
  expectedGlyphFiles,
  glyphCombinations,
  type GlyphPlan,
  parseGlyphPbf,
  planGlyphs,
  rangeFileName,
  rangeOf,
  REQUIRED_BLOCKS,
  verifyGlyphs,
} from './glyph-plan.js';
import { CodepointCollector, labelStrings } from './mvt-names.js';
import { encodeMvt } from './test-support.js';

const contract = JSON.parse(readFileSync(new URL('./label-contract.json', import.meta.url), 'utf8')) as {
  fontstacks: string[];
  labelFields: string[];
};

/** A2.1 as amended by A17: the five minimum ranges. */
const A17_RANGES = ['0-255.pbf', '256-511.pbf', '512-767.pbf', '768-1023.pbf', '1024-1279.pbf'];

/** A glyph tree where every range file holds every codepoint of its range except `omit`. */
function fullTree(plan: GlyphPlan, omit: ReadonlySet<number> = new Set()) {
  const files = new Map<string, Uint8Array>();
  for (const stack of plan.fontstacks) {
    for (const range of plan.ranges) {
      const ids: number[] = [];
      for (let cp = range.start; cp <= range.end; cp += 1) if (!omit.has(cp)) ids.push(cp);
      files.set(`${stack}/${rangeFileName(range)}`, encodeGlyphPbf(stack, range, ids));
    }
  }
  return (path: string) => files.get(path) ?? null;
}

describe('glyph plan', () => {
  it('produces the A17 floor for every chosen fontstack, Greek and Latin Extended-A/B included', () => {
    const plan = planGlyphs(contract.fontstacks, []);
    expect(plan.ranges.map(rangeFileName)).toEqual(A17_RANGES);
    const greek = REQUIRED_BLOCKS.find((block) => block.name === 'Greek and Coptic');
    expect(greek).toMatchObject({ first: 0x0370, last: 0x03ff });
    expect(rangeFileName(rangeOf(0x0370))).toBe('768-1023.pbf');
    expect(rangeFileName(rangeOf(0x03ff))).toBe('768-1023.pbf');
    for (const [name, first, last] of [
      ['Latin Extended-A', 0x0100, 0x017f],
      ['Latin Extended-B', 0x0180, 0x024f],
    ] as const) {
      expect(REQUIRED_BLOCKS.find((block) => block.name === name)).toMatchObject({ first, last });
    }
    expect(expectedGlyphFiles(plan)).toHaveLength(contract.fontstacks.length * A17_RANGES.length);
    expect(expectedGlyphFiles(plan)).toContain('Noto Sans Regular/768-1023.pbf');
  });

  it('every sample letter lies inside its own block', () => {
    for (const block of REQUIRED_BLOCKS) {
      for (const char of block.samples) {
        const cp = char.codePointAt(0) ?? -1;
        expect(cp >= block.first && cp <= block.last, `${block.name}: ${char}`).toBe(true);
      }
    }
  });

  it('adds a range for an observed script outside the floor and reports astral codepoints', () => {
    const plan = planGlyphs(contract.fontstacks, [
      { codepoint: 0x10d0, firstSeen: 'Georgian' }, // ა
      { codepoint: 0x1f525, firstSeen: 'an emoji' },
      { codepoint: 0x0391, firstSeen: 'Greek' },
    ]);
    expect(plan.ranges.map(rangeFileName)).toEqual([...A17_RANGES, '4096-4351.pbf']);
    expect(plan.extraRanges).toEqual([{ range: { start: 4096, end: 4351 }, firstSeen: 'Georgian' }]);
    expect(plan.unrenderable).toEqual([{ codepoint: 0x1f525, firstSeen: 'an emoji' }]);
  });
});

describe('glyph verification ("no tofu" on bytes)', () => {
  it('passes a complete build', () => {
    const plan = planGlyphs(contract.fontstacks, []);
    expect(verifyGlyphs(plan, [], fullTree(plan))).toEqual([]);
  });

  it('fails a build that lacks a Greek letter with tonos', () => {
    const plan = planGlyphs(contract.fontstacks, []);
    const findings = verifyGlyphs(plan, [], fullTree(plan, new Set([0x038c]))); // Ό
    expect(findings).toHaveLength(contract.fontstacks.length);
    expect(findings[0]?.problem).toMatch(/U\+038C Ό.*Greek and Coptic sample/);
  });

  it('fails when a range file is missing, and on an observed codepoint without a glyph', () => {
    const observed = [{ codepoint: 0x021b, firstSeen: '12/2300/1500 places.name "Constanța"' }];
    const plan = planGlyphs(['Noto Sans Regular'], observed);
    const tree = fullTree(plan, new Set([0x021b]));
    expect(verifyGlyphs(plan, observed, tree).map((f) => f.problem)).toEqual([
      'no glyph for U+021B ț (Latin Extended-B sample)',
    ]);
    const missing = verifyGlyphs(plan, observed, (path) => (path.endsWith('768-1023.pbf') ? null : tree(path)));
    expect(missing.map((f) => f.problem)).toContain('missing range file');
  });

  it('fails tofu in a supported script but only warns for a script outside the fontstack', () => {
    // What a real Europe extract carries: Armenian and Arabic names in the Caucasus and
    // North Africa, a Hangul shop name in Bulgaria, an object-replacement junk character,
    // and a Greek Extended letter Noto Sans does have.
    const observed = [
      { codepoint: 0x0540, firstSeen: 'Armenian' }, // Հ
      { codepoint: 0x0627, firstSeen: 'Arabic' }, // ا
      { codepoint: 0xccad, firstSeen: 'Hangul' }, // 청
      { codepoint: 0xfffc, firstSeen: 'junk' },
      { codepoint: 0x1f00, firstSeen: 'Greek Extended' }, // ἀ
      { codepoint: 0x201e, firstSeen: 'punctuation' }, // „
    ];
    const plan = planGlyphs(['Noto Sans Regular'], observed);
    const empty = new Set(observed.map((entry) => entry.codepoint));
    const findings = verifyGlyphs(plan, observed, fullTree(plan, empty));
    const bySeverity = (severity: string): string[] =>
      findings.filter((f) => f.severity === severity).map((f) => f.problem.replace(/^no glyph for /, ''));
    expect(bySeverity('error')).toEqual([
      'U+1F00 ἀ (observed in Greek Extended): script the fontstack supports',
      'U+201E „ (observed in punctuation): script the fontstack supports',
    ]);
    expect(bySeverity('warning')).toEqual([
      'U+0540 Հ (observed in Armenian): script outside the fontstack',
      'U+0627 ا (observed in Arabic): script outside the fontstack',
      'U+CCAD 청 (observed in Hangul): script outside the fontstack',
      'U+FFFC ￼ (observed in junk): non-printing code point in the data',
    ]);
  });

  it('classifies an observed floor letter as an error even when it is not a sample', () => {
    expect(classifyMissing(0x04e9)).toEqual({ severity: 'error', reason: 'inside the A17 floor' }); // ө
    expect(classifyMissing(0x10d0).severity).toBe('warning'); // ა Georgian
    expect(classifyMissing(0x4e2d).severity).toBe('warning'); // 中
  });

  it('maps every fontstack to its font file for build_pbf_glyphs -c', () => {
    // The official Noto Sans release names its files by stem; the tool names output
    // directories by stem, the style asks for the family name.
    const files = ['NotoSans-Regular.ttf', 'NotoSans-Bold.ttf', 'NotoSans-Italic.ttf', 'OFL.txt'];
    expect(glyphCombinations(contract.fontstacks, files)).toEqual({
      'Noto Sans Regular': ['NotoSans-Regular'],
      'Noto Sans Bold': ['NotoSans-Bold'],
      'Noto Sans Italic': ['NotoSans-Italic'],
    });
    expect(() => glyphCombinations(contract.fontstacks, ['NotoSans-Regular.ttf'])).toThrow(/NotoSans-Bold/);
  });

  it('parses what it encodes', () => {
    const [stack] = parseGlyphPbf(encodeGlyphPbf('Noto Sans Bold', { start: 768, end: 1023 }, [0x0391, 0x03c9]));
    expect(stack?.name).toBe('Noto Sans Bold');
    expect(stack?.range).toBe('768-1023');
    expect([...(stack?.ids ?? [])]).toEqual([0x0391, 0x03c9]);
  });
});

describe('label scan', () => {
  const tile = encodeMvt([
    {
      name: 'places',
      features: [
        { kind: 'locality', 'name:bg': 'Славянка', name: 'Славянка', 'name:el': 'Σλαβιάνκα' },
        { kind: 'locality', name: 'Σιδηρόκαστρο' },
        { kind: 'locality', name: 'Constanța', 'name:ja': 'コンスタンツァ' },
      ],
    },
    { name: 'roads', features: [{ kind: 'highway', ref: 'E79' }] },
  ]);

  it('reads only the style’s label fields', () => {
    const labels = labelStrings(tile, contract.labelFields).map((label) => `${label.field}=${label.text}`);
    expect(labels).toEqual(['name:bg=Славянка', 'name=Σιδηρόκαστρο', 'name=Constanța']);
  });

  it('reads the fields as the style’s coalesce does: name:bg shadows name', () => {
    // The z0 tile of a real Protomaps build: every country carries its local `name`, but the
    // style draws `name:bg` — scanning both demanded CJK and Devanagari glyphs for nothing.
    const world = encodeMvt([
      {
        name: 'places',
        features: [
          { kind: 'country', 'name:bg': 'Китай', name: '中国' },
          { kind: 'country', name: 'भारत', 'name:bg': 'Индия' },
          { kind: 'country', name: 'Ελλάς' },
        ],
      },
    ]);
    expect(labelStrings(world, contract.labelFields).map((label) => label.text)).toEqual(['Китай', 'Индия', 'Ελλάς']);
    const collector = new CodepointCollector();
    collector.addTile(world, contract.labelFields, '0/0/0');
    const codepoints = collector.entries().map((entry) => entry.codepoint);
    expect(codepoints).not.toContain(0x4e2d); // 中
    expect(codepoints).not.toContain(0x092d); // भ
    expect(planGlyphs(contract.fontstacks, collector.entries()).ranges.map(rangeFileName)).toEqual(A17_RANGES);
  });

  it('collects Greek codepoints from a border tile, gzip or not', () => {
    const collector = new CodepointCollector();
    collector.addTile(new Uint8Array(gzipSync(tile)), contract.labelFields, '12/2310/1540');
    const codepoints = collector.entries().map((entry) => entry.codepoint);
    expect(codepoints).toContain(0x03a3); // Σ
    expect(codepoints).toContain(0x03cc); // ό
    expect(codepoints).toContain(0x021b); // ț
    expect(codepoints).not.toContain(0x30b3); // コ — name:ja is not a label field
    expect(codepoints).not.toContain(0x20); // whitespace needs no glyph
    const plan = planGlyphs(contract.fontstacks, collector.entries());
    expect(plan.ranges.map(rangeFileName)).toEqual(A17_RANGES);
  });
});
