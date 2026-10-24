import { describe, expect, it } from 'vitest';

import type { ExportDocument } from './export-document.js';
import { isoUtc, normaliseIso } from './export-document.js';
import { csvCell, escapeXml, serialiseExport, toCsv, toGeoJson, toKml } from './serialise.js';

const DOCUMENT: ExportDocument = {
  title: 'Events <&> "test"',
  notice: 'Satellite detections, not confirmed fires.',
  generatedAt: '2026-08-09T01:02:03Z',
  attribution: [
    {
      id: 'osm',
      text: '© OpenStreetMap contributors',
      href: 'https://www.openstreetmap.org/copyright',
    },
    { id: 'derivation', text: 'Derived by Fire Watch' },
  ],
  columns: ['record_type', 'place', 'count', 'missing'],
  records: [
    {
      id: 'ev-1',
      name: 'Fire near =HYPERLINK("x")',
      lon: -8.5,
      lat: 42.25,
      time: { begin: '2026-08-09T00:00:00Z', end: '2026-08-09T01:00:00Z' },
      properties: [
        ['record_type', 'satellite_detection_event'],
        ['place', 'Сливен, "център"'],
        ['count', 3],
        ['missing', null],
      ],
    },
    {
      id: 'ev-2',
      name: 'Instant',
      lon: 25,
      lat: 42.7,
      time: { begin: '2026-08-09T00:30:00Z', end: '2026-08-09T00:30:00Z' },
      properties: [
        ['record_type', 'satellite_detection_event'],
        ['place', '@cmd'],
        ['count', Number.NaN],
        ['missing', true],
      ],
    },
  ],
};

describe('isoUtc', () => {
  it('writes second-precision UTC with a Z', () => {
    expect(isoUtc(Date.UTC(2026, 7, 9, 1, 2, 3, 456))).toBe('2026-08-09T01:02:03Z');
  });

  it('normalises any offset to UTC and rejects garbage', () => {
    expect(normaliseIso('2026-08-09T04:02:03+03:00')).toBe('2026-08-09T01:02:03Z');
    expect(normaliseIso('not a date')).toBeNull();
  });
});

describe('csvCell', () => {
  it.each([
    ['=1+1', "'=1+1"],
    ['+1', "'+1"],
    ['-1', "'-1"],
    ['@SUM(A1)', "'@SUM(A1)"],
    ['  =1', "'  =1"],
    ['\t=1', "'\t=1"],
    ['\r=1', `"'\r=1"`],
    ['＝1', "'＝1"],
  ])('guards the formula trigger in %j', (input, expected) => {
    expect(csvCell(input)).toBe(expected);
  });

  it('quotes per RFC 4180', () => {
    expect(csvCell('a,b')).toBe('"a,b"');
    expect(csvCell('say "hi"')).toBe('"say ""hi"""');
    expect(csvCell('line\nbreak')).toBe('"line\nbreak"');
    expect(csvCell('=a,b')).toBe(`"'=a,b"`);
  });

  it('keeps numbers as numbers, so a western longitude is not text', () => {
    expect(csvCell(-8.5)).toBe('-8.5');
    expect(csvCell(Number.POSITIVE_INFINITY)).toBe('');
    expect(csvCell(null)).toBe('');
    expect(csvCell(false)).toBe('false');
    expect(csvCell('plain')).toBe('plain');
  });
});

describe('toCsv', () => {
  const csv = toCsv(DOCUMENT);
  const lines = csv.slice(1).split('\r\n');

  it('starts with a BOM and uses CRLF throughout', () => {
    expect(csv.startsWith('﻿')).toBe(true);
    expect(csv.endsWith('\r\n')).toBe(true);
    expect(csv.replaceAll('\r\n', '').includes('\n')).toBe(false);
  });

  it('carries the title, caveat, UTC generation time and every attribution line', () => {
    expect(lines[0]).toBe('"# Events <&> ""test"""');
    expect(lines[1]).toBe('"# Satellite detections, not confirmed fires."');
    expect(lines[2]).toBe('# generated_at: 2026-08-09T01:02:03Z (UTC)');
    expect(lines[3]).toBe(
      '# © OpenStreetMap contributors (https://www.openstreetmap.org/copyright)',
    );
    expect(lines[4]).toBe('# Derived by Fire Watch');
    expect(lines[5]).toBe('id,name,lon,lat,record_type,place,count,missing');
  });

  it('guards and quotes every data cell', () => {
    const second = DOCUMENT.records[1];
    if (second === undefined) throw new Error('fixture');
    expect(toCsv({ ...DOCUMENT, records: [{ ...second, name: '-2+3' }] })).toContain(
      "ev-2,'-2+3,25,42.7",
    );
    expect(lines[6]).toBe(
      `ev-1,"Fire near =HYPERLINK(""x"")",-8.5,42.25,satellite_detection_event,"Сливен, ""център""",3,`,
    );
    expect(lines[7]).toBe("ev-2,Instant,25,42.7,satellite_detection_event,'@cmd,,true");
  });

  it('writes a header even with no records', () => {
    expect(
      toCsv({ ...DOCUMENT, records: [] })
        .trimEnd()
        .split('\r\n')
        .at(-1),
    ).toBe('id,name,lon,lat,record_type,place,count,missing');
  });
});

describe('escapeXml', () => {
  it('escapes the five entities', () => {
    expect(escapeXml(`<a href="x">'&'</a>`)).toBe(
      '&lt;a href=&quot;x&quot;&gt;&apos;&amp;&apos;&lt;/a&gt;',
    );
  });

  it('drops code points XML 1.0 cannot carry and keeps the ones it can', () => {
    expect(escapeXml('a\u0000b\u0007c\u001Fd￾e￿')).toBe('abcde');
    expect(escapeXml('x\uD800y')).toBe('xy');
    expect(escapeXml('x\uDC00y')).toBe('xy');
    expect(escapeXml('tab\tlf\ncr\r🔥')).toBe('tab\tlf\ncr\r🔥');
  });
});

describe('toKml', () => {
  const kml = toKml(DOCUMENT);

  it('is a KML 2.2 document with an escaped title, and the caveat and credits in its description', () => {
    expect(kml.startsWith('<?xml version="1.0" encoding="UTF-8"?>\n')).toBe(true);
    expect(kml).toContain('<kml xmlns="http://www.opengis.net/kml/2.2">');
    expect(kml).toContain('<name>Events &lt;&amp;&gt; &quot;test&quot;</name>');
    expect(kml).toContain('Satellite detections, not confirmed fires.');
    expect(kml).toContain('© OpenStreetMap contributors (https://www.openstreetmap.org/copyright)');
    expect(kml).toContain('<Data name="generated_at"><value>2026-08-09T01:02:03Z</value></Data>');
  });

  it('writes a TimeSpan for a range, a TimeStamp for an instant, and lon,lat order', () => {
    expect(kml).toContain(
      '<TimeSpan><begin>2026-08-09T00:00:00Z</begin><end>2026-08-09T01:00:00Z</end></TimeSpan>',
    );
    expect(kml).toContain('<TimeStamp><when>2026-08-09T00:30:00Z</when></TimeStamp>');
    expect(kml).toContain('<Point><coordinates>-8.5,42.25</coordinates></Point>');
  });

  it('escapes every property value', () => {
    expect(kml).toContain('<name>Fire near =HYPERLINK(&quot;x&quot;)</name>');
    expect(kml).toContain('<Data name="place"><value>Сливен, &quot;център&quot;</value></Data>');
    expect(kml).toContain('<Data name="missing"><value></value></Data>');
    expect(kml).not.toMatch(/<value>[^<]*"[^<]*<\/value>/u);
  });
});

describe('toGeoJson', () => {
  const parsed = JSON.parse(toGeoJson(DOCUMENT)) as {
    type: string;
    notice: string;
    generated_at: string;
    time_zone: string;
    attribution: { id: string; href?: string }[];
    features: {
      id: string;
      geometry: { coordinates: number[] };
      properties: Record<string, unknown>;
    }[];
  };

  it('is a FeatureCollection carrying the caveat, time and attribution as foreign members', () => {
    expect(parsed.type).toBe('FeatureCollection');
    expect(parsed.notice).toBe(DOCUMENT.notice);
    expect(parsed.generated_at).toBe('2026-08-09T01:02:03Z');
    expect(parsed.time_zone).toBe('UTC');
    expect(parsed.attribution.map((line) => line.id)).toEqual(['osm', 'derivation']);
    expect(parsed.attribution[1]).not.toHaveProperty('href');
  });

  it('writes every column for every feature, null where absent', () => {
    expect(parsed.features[0]?.geometry.coordinates).toEqual([-8.5, 42.25]);
    expect(Object.keys(parsed.features[0]?.properties ?? {})).toEqual([
      'id',
      'name',
      'record_type',
      'place',
      'count',
      'missing',
    ]);
    expect(parsed.features[0]?.properties['missing']).toBeNull();
    expect(parsed.features[1]?.properties['count']).toBeNull();
  });
});

describe('serialiseExport', () => {
  it.each(['geojson', 'kml', 'csv'] as const)('is deterministic for %s', (format) => {
    expect(serialiseExport(DOCUMENT, format)).toBe(
      serialiseExport(structuredClone(DOCUMENT), format),
    );
  });
});
