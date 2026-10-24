import { describe, expect, it } from 'vitest';

import { escapeAttribute, injectOgMeta, OG_BEGIN, OG_END, renderMetaTags } from './inject-meta.js';

const SHELL = [
  '<!doctype html>',
  '<html lang="bg">',
  '  <head>',
  `    ${OG_BEGIN}`,
  '    <meta property="og:title" content="Fire Watch" />',
  `    ${OG_END}`,
  '  </head>',
  '  <body><div id="app"></div></body>',
  '</html>',
].join('\n');

describe('edge meta injection (TASKS V2-D4)', () => {
  it('escapes every character that can end or open markup', () => {
    expect(escapeAttribute(`a&b"c'd<e>f`)).toBe('a&amp;b&quot;c&#39;d&lt;e&gt;f');
  });

  it('renders property and name tags with escaped content', () => {
    expect(
      renderMetaTags([
        { attribute: 'property', key: 'og:title', content: 'A "fire"' },
        { attribute: 'name', key: 'twitter:card', content: 'summary_large_image' },
      ]),
    ).toBe(
      '<meta property="og:title" content="A &quot;fire&quot;" />\n    <meta name="twitter:card" content="summary_large_image" />',
    );
  });

  it('replaces only the og block and sets the document language', () => {
    const html = injectOgMeta(
      SHELL,
      [{ attribute: 'property', key: 'og:title', content: 'Near <Harmanli>' }],
      'en',
    );
    expect(html).toContain('<html lang="en">');
    expect(html).toContain('content="Near &lt;Harmanli&gt;"');
    expect(html).not.toContain('content="Fire Watch"');
    expect(html).toContain(OG_BEGIN);
    expect(html).toContain(OG_END);
    expect(html).toContain('<body><div id="app"></div></body>');
  });

  it('returns a shell without both markers unchanged', () => {
    const tags = [{ attribute: 'property', key: 'og:title', content: 'x' }] as const;
    const noEnd = SHELL.replace(OG_END, '');
    expect(injectOgMeta(noEnd, tags, 'en')).toBe(noEnd);
    const noBegin = SHELL.replace(OG_BEGIN, '');
    expect(injectOgMeta(noBegin, tags, 'en')).toBe(noBegin);
  });
});
