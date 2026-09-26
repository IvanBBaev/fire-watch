/**
 * Colour literals written in script and markup source — the third CI-14 colour source,
 * after stylesheets and the map style.
 *
 * Only *quoted* literals count: a colour in a comment paints nothing. A quoted string is a
 * colour candidate when it is `#` followed only by hex digits, or a colour function
 * (`rgb(…)`, `hsl(…)`, `oklch(…)`, …). A candidate that {@link parseColor} cannot read —
 * `'#12345'`, `'oklch(…)'` — throws: it is a colour nobody can check. Named colours and
 * `#fragment`-style strings (`'#app'`) are not candidates; distinguishing `'red'` the
 * colour from `'red'` a key would need types, and the map style walk reads the ones that
 * reach MapLibre anyway.
 */

import type { Rgba } from './color.js';
import { parseColor } from './color.js';

export interface SourceColorLiteral {
  /** 1-based line of the opening quote. */
  readonly line: number;
  readonly text: string;
  readonly color: Rgba;
}

export class SourceColorError extends Error {
  constructor(line: number, reason: string) {
    super(`line ${String(line)}: ${reason}`);
    this.name = 'SourceColorError';
  }
}

const QUOTED = /(['"`])((?:(?!\1)[^\\\n]|\\.)*)\1/gu;
const HEX_CANDIDATE = /^#[0-9a-f]+$/iu;
const FUNCTION_CANDIDATE =
  /^(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch|color|color-mix|light-dark)\(.*\)$/iu;

/** Every quoted colour literal in `source`. Throws on a candidate it cannot parse. */
export function extractSourceColors(source: string): SourceColorLiteral[] {
  // Blank comments first, keeping newlines, so a commented-out colour is not a finding
  // and line numbers survive. `//` inside a string (a URL) is protected by skipping
  // strings in the same pass.
  const text = source.replace(
    /(['"`])(?:(?!\1)[^\\\n]|\\.)*\1|\/\*[\s\S]*?\*\/|\/\/[^\n]*|<!--[\s\S]*?-->/gu,
    (match) => (/^['"`]/u.test(match) ? match : match.replace(/[^\n]/gu, ' ')),
  );
  const out: SourceColorLiteral[] = [];
  for (const match of text.matchAll(QUOTED)) {
    const body = (match[2] ?? '').trim();
    if (!HEX_CANDIDATE.test(body) && !FUNCTION_CANDIDATE.test(body)) continue;
    const line = text.slice(0, match.index).split('\n').length;
    try {
      out.push({ line, text: body, color: parseColor(body) });
    } catch (error) {
      throw new SourceColorError(line, error instanceof Error ? error.message : String(error));
    }
  }
  return out;
}
