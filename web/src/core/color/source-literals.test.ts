import { describe, expect, it } from 'vitest';

import { formatHex } from './color.js';
import { SourceColorError, extractSourceColors } from './source-literals.js';

const summary = (source: string): string[] =>
  extractSourceColors(source).map((l) => `${String(l.line)} ${l.text} ${formatHex(l.color)}`);

describe('extractSourceColors', () => {
  it('finds quoted hex and colour-function literals with their lines', () => {
    const source = [
      "export const A = '#d7301f';",
      'const B = "rgba(215, 48, 31, 0.45)";',
      'const C = `#fff`;',
    ].join('\n');
    expect(summary(source)).toStrictEqual([
      '1 #d7301f #d7301f',
      '2 rgba(215, 48, 31, 0.45) #d7301f73',
      '3 #fff #ffffff',
    ]);
  });

  it('skips comments, fragments and non-colour strings', () => {
    const source = [
      "// const OLD = '#ff0000';",
      "/* '#00ff00' */",
      "document.querySelector('#app');",
      "const url = 'https://x.test/#map=5/42/25';",
      "const word = 'red';",
      '<!-- "#0000ff" -->',
    ].join('\n');
    expect(summary(source)).toStrictEqual([]);
  });

  it.each([
    ["'#12345'", /line 1/u],
    ["\n'oklch(0.6 0.2 30)'", /line 2/u],
  ])('throws on an unreadable colour literal %s', (source, message) => {
    expect(() => extractSourceColors(source)).toThrow(SourceColorError);
    expect(() => extractSourceColors(source)).toThrow(message);
  });
});
