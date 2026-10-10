/**
 * The glyph build plan (TASKS G2; ADR-001 A2.1 as amended by A17).
 *
 * MapLibre fetches glyphs in fixed 256-codepoint ranges (`{start}-{end}.pbf`). The plan is
 * the set of ranges to build per fontstack: a normative floor — Latin, Latin-1, Latin
 * Extended-A/B, IPA/spacing modifiers + combining marks + **Greek and Coptic
 * (0370–03FF)**, Cyrillic — plus every range an observed label codepoint falls in. The
 * build fails when an observed codepoint has no glyph in the built range: that is the
 * "no tofu" guarantee, checked on bytes rather than on a screenshot. Only scripts the
 * fontstack supports are held to it: a real Europe extract carries Arabic, Armenian,
 * Georgian and Han names that Noto Sans (Latin/Greek/Cyrillic) has no glyphs for, and
 * those are warnings for a font decision (see `classifyMissing`).
 */

import { readFields, WIRE_LEN, WIRE_VARINT } from './protobuf.js';

export const RANGE_SIZE = 256;

/** A named Unicode block the plan must cover, with sample letters the check probes. */
export interface RequiredBlock {
  readonly name: string;
  readonly first: number;
  readonly last: number;
  /**
   * Letters a label near the border really uses. A font that has the range file but not
   * these glyphs (a subset build, a wrong font) is a tofu box; the check fails on it.
   */
  readonly samples: string;
}

/** A2.1/A17 floor. Every block is inside the five ranges 0–1279. */
export const REQUIRED_BLOCKS: readonly RequiredBlock[] = [
  { name: 'Basic Latin', first: 0x0000, last: 0x007f, samples: 'AZaz09' },
  { name: 'Latin-1 Supplement', first: 0x0080, last: 0x00ff, samples: 'éöüß°' },
  // Turkish, Romanian (ş/ţ legacy), Serbian/Croatian Latin, Albanian — all in the AOI.
  { name: 'Latin Extended-A', first: 0x0100, last: 0x017f, samples: 'ıİşŞğĞčćđžăĂ' },
  // Romanian comma-below letters — the correct forms since 2003.
  { name: 'Latin Extended-B', first: 0x0180, last: 0x024f, samples: 'șȘțȚ' },
  { name: 'IPA / spacing modifiers / combining marks', first: 0x0250, last: 0x036f, samples: '\u0301\u0300' },
  // The S1 border view: Greek names with tonos (Ά Έ Ή Ί Ό Ύ Ώ ά έ ή ί ό ύ ώ) and final sigma.
  {
    name: 'Greek and Coptic',
    first: 0x0370,
    last: 0x03ff,
    samples: 'ΑΒΓΔΕΖΗΘΙΚΛΜΝΞΟΠΡΣΤΥΦΧΨΩαβγδεζηθικλμνξοπρσςτυφχψωΆΈΉΊΌΎΏάέήίόύώϊϋΐΰ',
  },
  // Bulgarian (incl. ѝ), Serbian/Macedonian letters.
  { name: 'Cyrillic', first: 0x0400, last: 0x04ff, samples: 'АБВГДЕЖЗИЙКЛМНОПРСТУФХЦЧШЩЪЬЮЯабвгдежзийклмнопрстуфхцчшщъьюяѝЀЃЌЉЊЏђћјѓќљњџ' },
];

export interface GlyphRange {
  readonly start: number;
  readonly end: number;
}

export function rangeOf(codepoint: number): GlyphRange {
  if (!Number.isInteger(codepoint) || codepoint < 0 || codepoint > 0xffff) {
    // MapLibre's glyph protocol stops at the BMP; an astral codepoint (emoji) cannot render.
    throw new RangeError(`codepoint U+${codepoint.toString(16).toUpperCase()} is outside the BMP`);
  }
  const start = Math.floor(codepoint / RANGE_SIZE) * RANGE_SIZE;
  return { start, end: start + RANGE_SIZE - 1 };
}

export function rangeFileName(range: GlyphRange): string {
  return `${range.start}-${range.end}.pbf`;
}

export function codepointLabel(codepoint: number): string {
  return `U+${codepoint.toString(16).toUpperCase().padStart(4, '0')} ${String.fromCodePoint(codepoint)}`;
}

export interface GlyphPlan {
  readonly fontstacks: readonly string[];
  readonly ranges: readonly GlyphRange[];
  /** Observed codepoints that forced a range outside the floor, for the build log. */
  readonly extraRanges: ReadonlyArray<{ readonly range: GlyphRange; readonly firstSeen: string }>;
  /** Astral codepoints seen in labels: they cannot render and are reported, not built. */
  readonly unrenderable: ReadonlyArray<{ readonly codepoint: number; readonly firstSeen: string }>;
}

/** The floor ranges plus every range an observed codepoint lands in, sorted. */
export function planGlyphs(
  fontstacks: readonly string[],
  observed: ReadonlyArray<{ readonly codepoint: number; readonly firstSeen: string }>,
): GlyphPlan {
  if (fontstacks.length === 0) throw new RangeError('no fontstacks');
  const ranges = new Map<number, GlyphRange>();
  for (const block of REQUIRED_BLOCKS) {
    for (let codepoint = block.first; codepoint <= block.last; codepoint += RANGE_SIZE) {
      const range = rangeOf(codepoint);
      ranges.set(range.start, range);
    }
    const lastRange = rangeOf(block.last);
    ranges.set(lastRange.start, lastRange);
  }
  const extraRanges: Array<{ range: GlyphRange; firstSeen: string }> = [];
  const unrenderable: Array<{ codepoint: number; firstSeen: string }> = [];
  for (const { codepoint, firstSeen } of observed) {
    if (codepoint > 0xffff) {
      unrenderable.push({ codepoint, firstSeen });
      continue;
    }
    const range = rangeOf(codepoint);
    if (!ranges.has(range.start)) {
      ranges.set(range.start, range);
      extraRanges.push({ range, firstSeen });
    }
  }
  return {
    fontstacks: [...fontstacks],
    ranges: [...ranges.values()].sort((a, b) => a.start - b.start),
    extraRanges,
    unrenderable,
  };
}

/** Relative paths the glyph build must produce: `<fontstack>/<start>-<end>.pbf`. */
export function expectedGlyphFiles(plan: GlyphPlan): string[] {
  return plan.fontstacks.flatMap((stack) => plan.ranges.map((range) => `${stack}/${rangeFileName(range)}`));
}

// ---------------------------------------------------------------------------------------
// Reading a built range file (glyphs.proto: glyphs.stacks=1; fontstack.name=1, range=2,
// glyphs=3; glyph.id=1).

export interface GlyphRangeFile {
  readonly name: string;
  readonly range: string;
  readonly ids: ReadonlySet<number>;
}

export function parseGlyphPbf(bytes: Uint8Array): GlyphRangeFile[] {
  const stacks: GlyphRangeFile[] = [];
  for (const stackField of readFields(bytes)) {
    if (stackField.field !== 1 || stackField.wireType !== WIRE_LEN) continue;
    let name = '';
    let range = '';
    const ids = new Set<number>();
    for (const entry of readFields(stackField.bytes)) {
      if (entry.field === 1) name = new TextDecoder().decode(entry.bytes);
      else if (entry.field === 2) range = new TextDecoder().decode(entry.bytes);
      else if (entry.field === 3 && entry.wireType === WIRE_LEN) {
        const id = readFields(entry.bytes).find((glyph) => glyph.field === 1 && glyph.wireType === WIRE_VARINT);
        if (id !== undefined) ids.add(id.varint);
      }
    }
    stacks.push({ name, range, ids });
  }
  return stacks;
}

export interface GlyphFinding {
  readonly fontstack: string;
  readonly file: string;
  readonly problem: string;
  /**
   * `error` is tofu the build must not ship: a floor letter, or an observed letter of a
   * script the fontstack supports (Latin, Greek, Cyrillic, their common punctuation and
   * combining marks). `warning` is an observed letter of a script outside the fontstack
   * (Arabic, Armenian, Han...) or a non-printing code point (U+FFFC): choosing a font for
   * those is a product decision, not a build bug, so it is reported and does not fail.
   */
  readonly severity: 'error' | 'warning';
}

/** Scripts the A17 floor promises; tofu in these is a build failure wherever it lands. */
const SUPPORTED_SCRIPT = /^[\p{Script=Latin}\p{Script=Greek}\p{Script=Cyrillic}\p{Script=Common}\p{Script=Inherited}]$/u;
/** Control, format, private-use, unassigned, and the Specials block (U+FFF0–FFFF). */
const NON_PRINTING = /^[\p{Cc}\p{Cf}\p{Co}\p{Cn}\u{FFF0}-\u{FFFF}]$/u;

/** Why an observed codepoint without a glyph is, or is not, a build failure. */
export function classifyMissing(codepoint: number): { severity: 'error' | 'warning'; reason: string } {
  const char = String.fromCodePoint(codepoint);
  if (REQUIRED_BLOCKS.some((block) => codepoint >= block.first && codepoint <= block.last)) {
    return { severity: 'error', reason: 'inside the A17 floor' };
  }
  if (NON_PRINTING.test(char)) return { severity: 'warning', reason: 'non-printing code point in the data' };
  if (SUPPORTED_SCRIPT.test(char)) return { severity: 'error', reason: 'script the fontstack supports' };
  return { severity: 'warning', reason: 'script outside the fontstack' };
}

/**
 * Checks a built glyph tree against the plan: every planned file exists and parses, every
 * required sample letter has a glyph, and every observed codepoint has a glyph or is
 * classified a warning by `classifyMissing`. `readFile` returns `null` for a missing file.
 * No `error` finding is the pass.
 */
export function verifyGlyphs(
  plan: GlyphPlan,
  observed: ReadonlyArray<{ readonly codepoint: number; readonly firstSeen: string }>,
  readFile: (relativePath: string) => Uint8Array | null,
): GlyphFinding[] {
  const findings: GlyphFinding[] = [];
  const mustHave = new Map<number, { why: string; sample: boolean }>();
  for (const block of REQUIRED_BLOCKS) {
    for (const char of block.samples) {
      mustHave.set(char.codePointAt(0) ?? 0, { why: `${block.name} sample`, sample: true });
    }
  }
  for (const { codepoint, firstSeen } of observed) {
    if (codepoint <= 0xffff && !mustHave.has(codepoint)) {
      mustHave.set(codepoint, { why: `observed in ${firstSeen}`, sample: false });
    }
  }
  for (const fontstack of plan.fontstacks) {
    for (const range of plan.ranges) {
      const file = `${fontstack}/${rangeFileName(range)}`;
      const bytes = readFile(file);
      if (bytes === null) {
        findings.push({ fontstack, file, problem: 'missing range file', severity: 'error' });
        continue;
      }
      let ids: Set<number>;
      try {
        ids = new Set(parseGlyphPbf(bytes).flatMap((stack) => [...stack.ids]));
      } catch (error) {
        findings.push({ fontstack, file, problem: `unparseable: ${(error as Error).message}`, severity: 'error' });
        continue;
      }
      for (const [codepoint, { why, sample }] of mustHave) {
        if (codepoint < range.start || codepoint > range.end) continue;
        if (ids.has(codepoint)) continue;
        const problem = `no glyph for ${codepointLabel(codepoint)} (${why})`;
        if (sample) {
          findings.push({ fontstack, file, problem, severity: 'error' });
          continue;
        }
        const { severity, reason } = classifyMissing(codepoint);
        findings.push({ fontstack, file, problem: `${problem}: ${reason}`, severity });
      }
    }
  }
  return findings;
}

/**
 * The `-c` combinations file `build_pbf_glyphs` (sdf_font_tools v1.5) needs to write a
 * directory per fontstack. The tool scans one flat directory (no recursion) and names each
 * output directory after the font file's stem (`NotoSans-Regular`), not after the family
 * the style asks for (`Noto Sans Regular`); a combination maps one name to the other.
 * Fontstack "Family Words Style" pairs with the file stem "FamilyWords-Style". Throws
 * when a fontstack has no font file, so a missing weight fails the build, not the map.
 */
export function glyphCombinations(
  fontstacks: readonly string[],
  fontFiles: readonly string[],
): Record<string, [string]> {
  const fontFile = /\.(ttf|otf)$/i;
  const stems = new Set(fontFiles.filter((file) => fontFile.test(file)).map((file) => file.replace(fontFile, '')));
  const out: Record<string, [string]> = {};
  for (const stack of fontstacks) {
    const words = stack.trim().split(/\s+/);
    const style = words.pop();
    if (style === undefined || words.length === 0) throw new RangeError(`fontstack ${JSON.stringify(stack)} has no style`);
    const stem = `${words.join('')}-${style}`;
    if (!stems.has(stem)) throw new RangeError(`no font file ${stem}.ttf/.otf for fontstack ${JSON.stringify(stack)}`);
    out[stack] = [stem];
  }
  return out;
}

/** Encodes a glyph range file — test fixtures only (no bitmaps, ids and metrics only). */
export function encodeGlyphPbf(fontstack: string, range: GlyphRange, ids: Iterable<number>): Uint8Array {
  const enc = new TextEncoder();
  const bytes: number[] = [];
  const varint = (value: number, into: number[]): void => {
    let rest = value;
    while (rest >= 0x80) {
      into.push((rest % 0x80) | 0x80);
      rest = Math.floor(rest / 0x80);
    }
    into.push(rest);
  };
  const lenField = (field: number, payload: ArrayLike<number>, into: number[]): void => {
    varint(field * 8 + 2, into);
    varint(payload.length, into);
    for (let i = 0; i < payload.length; i += 1) into.push(payload[i] ?? 0);
  };
  const stack: number[] = [];
  lenField(1, enc.encode(fontstack), stack);
  lenField(2, enc.encode(`${range.start}-${range.end}`), stack);
  for (const id of ids) {
    const glyph: number[] = [];
    varint(1 * 8, glyph);
    varint(id, glyph);
    lenField(3, glyph, stack);
  }
  lenField(1, stack, bytes);
  return Uint8Array.from(bytes);
}
