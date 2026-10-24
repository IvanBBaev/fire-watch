import { describe, expect, it } from 'vitest';

import { childElements, childText, decodeEntities, firstChild, parseXml, textOf } from './xml.js';

describe('parseXml', () => {
  it('reads elements, attributes, text and prefixed names as written', () => {
    const root = parseXml(
      '<?xml version="1.0"?>\n<feed a="1" b=\'two\'><cap:x>hi</cap:x><e/><e k="v">t</e></feed>',
    );
    expect(root?.name).toBe('feed');
    expect(root?.attributes).toEqual({ a: '1', b: 'two' });
    expect(childText(root!, 'cap:x')).toBe('hi');
    expect(childElements(root!, 'e')).toHaveLength(2);
    expect(firstChild(root!, 'e')?.children).toEqual([]);
  });

  it('decodes entities in text and attributes, keeps CDATA, skips comments and PIs', () => {
    const root = parseXml(
      '<r h="a?x=1&amp;y=2"><!-- note --><?pi x?><t>&lt;b&gt; &#65;&#x42;</t><c><![CDATA[<raw> & ]]></c></r>',
    );
    expect(root?.attributes['h']).toBe('a?x=1&y=2');
    expect(childText(root!, 't')).toBe('<b> AB');
    expect(textOf(firstChild(root!, 'c'))).toBe('<raw> &');
  });

  it('refuses a DOCTYPE outright', () => {
    expect(parseXml('<!DOCTYPE r [<!ENTITY x "boom">]><r>&x;</r>')).toBeNull();
  });

  it.each([
    ['unclosed', '<r><a></r>'],
    ['mismatched', '<r><a></b></r>'],
    ['two roots', '<r/><s/>'],
    ['unquoted attribute', '<r a=1/>'],
    ['unknown entity', '<r>&nbsp;</r>'],
    ['bare ampersand', '<r>a & b</r>'],
    ['empty', ''],
    ['text only', 'hello'],
  ])('is null for %s input', (_label, text) => {
    expect(parseXml(text)).toBeNull();
  });
});

describe('decodeEntities', () => {
  it('passes plain text through and refuses out-of-range references', () => {
    expect(decodeEntities('plain')).toBe('plain');
    expect(decodeEntities('&quot;&apos;')).toBe('"\'');
    expect(decodeEntities('&#xD800;')).toBeNull();
    expect(decodeEntities('&#0;')).toBeNull();
  });
});

describe('childText', () => {
  it('is null for an absent or empty child', () => {
    const root = parseXml('<r><e>  </e></r>')!;
    expect(childText(root, 'e')).toBeNull();
    expect(childText(root, 'missing')).toBeNull();
  });
});
