/**
 * GeoJSON, KML and CSV from one {@link ExportDocument} (TASKS V2-D1).
 *
 * Every format carries the same four things besides the points: the title, the honest
 * caveat (satellite detections, not confirmed fires), the time the file was made, and one
 * line per attribution or licence owed. Data travels; a credit that stays behind on the web
 * page is a credit the licence did not get.
 *
 * Two defences, each where its format needs it:
 *
 * - **KML is XML**, so every text node and attribute goes through {@link escapeXml}, and
 *   code points XML 1.0 forbids are dropped rather than escaped (they cannot be).
 * - **CSV is opened by spreadsheets**, which execute a cell that starts with `=`, `+`, `-`
 *   or `@` (OWASP "CSV injection"). A text cell that could be read as a formula is prefixed
 *   with `'`, which every major spreadsheet treats as "this is text". Numbers are typed
 *   values and are written as numbers, so a western longitude stays a number.
 *
 * Pure and deterministic: the same document gives the same bytes.
 */

import type { ExportDocument, ExportRecord, ExportValue } from './export-document.js';

export type ExportFormat = 'geojson' | 'kml' | 'csv';

export const EXPORT_FORMATS: readonly ExportFormat[] = ['geojson', 'kml', 'csv'];

/** What a browser needs to save the bytes. */
export const EXPORT_MEDIA_TYPE: Readonly<Record<ExportFormat, string>> = {
  geojson: 'application/geo+json',
  kml: 'application/vnd.google-earth.kml+xml',
  csv: 'text/csv;charset=utf-8',
};

export const EXPORT_EXTENSION: Readonly<Record<ExportFormat, string>> = {
  geojson: 'geojson',
  kml: 'kml',
  csv: 'csv',
};

/** The document in `format`. */
export function serialiseExport(document: ExportDocument, format: ExportFormat): string {
  switch (format) {
    case 'geojson':
      return toGeoJson(document);
    case 'kml':
      return toKml(document);
    case 'csv':
      return toCsv(document);
  }
}

/* -------------------------------------------------------------------------- */
/* GeoJSON                                                                    */
/* -------------------------------------------------------------------------- */

function propertiesOf(document: ExportDocument, record: ExportRecord): Record<string, ExportValue> {
  const values = new Map(record.properties);
  const properties: Record<string, ExportValue> = { id: record.id, name: record.name };
  for (const column of document.columns) properties[column] = values.get(column) ?? null;
  return properties;
}

/**
 * RFC 7946 FeatureCollection. The caveat, generation time and attribution ride as foreign
 * members of the collection (RFC 7946 §6.1), which every reader keeps or ignores safely.
 */
export function toGeoJson(document: ExportDocument): string {
  const collection = {
    type: 'FeatureCollection',
    title: document.title,
    notice: document.notice,
    generated_at: document.generatedAt,
    time_zone: 'UTC',
    attribution: document.attribution.map((line) => ({
      id: line.id,
      text: line.text,
      ...(line.href === undefined ? {} : { href: line.href }),
    })),
    features: document.records.map((record) => ({
      type: 'Feature',
      id: record.id,
      geometry: { type: 'Point', coordinates: [record.lon, record.lat] },
      properties: propertiesOf(document, record),
    })),
  };
  return `${JSON.stringify(collection, null, 2)}\n`;
}

/* -------------------------------------------------------------------------- */
/* KML                                                                        */
/* -------------------------------------------------------------------------- */

/**
 * Text → XML character data or attribute value. Escapes the five predefined entities and
 * drops what XML 1.0 cannot carry at all (C0 controls other than tab/LF/CR, lone
 * surrogates, U+FFFE/U+FFFF).
 */
export function escapeXml(text: string): string {
  return text
    .replace(
      // eslint-disable-next-line no-control-regex -- matching the forbidden controls is the point
      /[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/gu,
      '',
    )
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

function kmlValue(value: ExportValue): string {
  if (value === null) return '';
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : '';
  return escapeXml(String(value));
}

function kmlData(name: string, value: ExportValue): string {
  return `        <Data name="${escapeXml(name)}"><value>${kmlValue(value)}</value></Data>`;
}

function kmlTime(record: ExportRecord): string[] {
  if (record.time === null) return [];
  if (record.time.begin === record.time.end) {
    return [`      <TimeStamp><when>${escapeXml(record.time.begin)}</when></TimeStamp>`];
  }
  return [
    `      <TimeSpan><begin>${escapeXml(record.time.begin)}</begin>` +
      `<end>${escapeXml(record.time.end)}</end></TimeSpan>`,
  ];
}

function kmlDescription(document: ExportDocument): string {
  const lines = [
    document.notice,
    '',
    ...document.attribution.map((line) =>
      line.href === undefined ? line.text : `${line.text} (${line.href})`,
    ),
  ];
  return escapeXml(lines.join('\n'));
}

/** OGC KML 2.2: one Placemark per record, every property as ExtendedData. */
export function toKml(document: ExportDocument): string {
  const placemarks = document.records.flatMap((record) => {
    const values = new Map(record.properties);
    return [
      '    <Placemark>',
      `      <name>${escapeXml(record.name)}</name>`,
      ...kmlTime(record),
      '      <ExtendedData>',
      kmlData('id', record.id),
      ...document.columns.map((column) => kmlData(column, values.get(column) ?? null)),
      '      </ExtendedData>',
      `      <Point><coordinates>${kmlValue(record.lon)},${kmlValue(record.lat)}</coordinates></Point>`,
      '    </Placemark>',
    ];
  });
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<kml xmlns="http://www.opengis.net/kml/2.2">',
    '  <Document>',
    `    <name>${escapeXml(document.title)}</name>`,
    `    <description>${kmlDescription(document)}</description>`,
    '    <ExtendedData>',
    `      <Data name="generated_at"><value>${escapeXml(document.generatedAt)}</value></Data>`,
    '      <Data name="time_zone"><value>UTC</value></Data>',
    '    </ExtendedData>',
    ...placemarks,
    '  </Document>',
    '</kml>',
    '',
  ].join('\n');
}

/* -------------------------------------------------------------------------- */
/* CSV                                                                        */
/* -------------------------------------------------------------------------- */

/**
 * A text cell a spreadsheet could execute: a leading formula trigger, optionally after
 * whitespace (some importers trim), the full-width forms some locales map onto them, and a
 * leading tab or carriage return (OWASP lists both as cell separators an importer may eat).
 */
const FORMULA_TRIGGER = /^[\t\r]|^\s*[=+\-@\uFF1D\uFF0B\uFF0D\uFF20]/u;

/** RFC 4180 needs quotes for these; leading/trailing spaces are quoted so they survive. */
const NEEDS_QUOTES = /[",\r\n]|^\s|\s$/u;

/** One CSV cell, formula-guarded and quoted where RFC 4180 needs it. */
export function csvCell(value: ExportValue): string {
  if (value === null) return '';
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : '';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  const guarded = FORMULA_TRIGGER.test(value) ? `'${value}` : value;
  return NEEDS_QUOTES.test(guarded) ? `"${guarded.replaceAll('"', '""')}"` : guarded;
}

function csvRow(cells: readonly ExportValue[]): string {
  return cells.map(csvCell).join(',');
}

/**
 * RFC 4180 with CRLF, preceded by `#` comment rows for the title, caveat, generation time
 * and attribution, then a header row. The byte-order mark makes spreadsheets read the
 * Cyrillic place names as UTF-8 instead of guessing a code page.
 */
export function toCsv(document: ExportDocument): string {
  const comments = [
    `# ${document.title}`,
    `# ${document.notice}`,
    `# generated_at: ${document.generatedAt} (UTC)`,
    ...document.attribution.map((line) =>
      line.href === undefined ? `# ${line.text}` : `# ${line.text} (${line.href})`,
    ),
  ];
  const header = ['id', 'name', 'lon', 'lat', ...document.columns];
  const rows = document.records.map((record) => {
    const values = new Map(record.properties);
    return csvRow([
      record.id,
      record.name,
      record.lon,
      record.lat,
      ...document.columns.map((column) => values.get(column) ?? null),
    ]);
  });
  return `\uFEFF${[...comments.map((line) => csvCell(line)), csvRow(header), ...rows].join('\r\n')}\r\n`;
}
