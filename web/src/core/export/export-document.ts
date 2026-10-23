/**
 * The format-neutral shape every export file is written from (TASKS V2-D1).
 *
 * One document, three serialisers (`serialise.ts`): GeoJSON, KML and CSV say the same
 * things in the same order, so a reader who opens the CSV and a GIS that opens the KML are
 * told the same facts, the same caveat and the same attribution. The document is built from
 * data the web already holds — the snapshot's events and an event's detections file — so
 * an export never claims more than the screen it was downloaded from.
 *
 * Pure: no DOM, no clock. Times arrive as epoch milliseconds or ISO strings and leave as
 * ISO 8601 UTC ({@link isoUtc}); the caller decides what "now" is.
 */

/** A cell value. Numbers stay numbers; `null` is an empty cell, never a zero. */
export type ExportValue = string | number | boolean | null;

/** One attribution or licence line owed for the data in the file. */
export interface ExportAttribution {
  /** The credits-registry id (`@fire-watch/contracts` `CREDITS`). */
  readonly id: string;
  readonly text: string;
  readonly href?: string;
}

/** One point in the file: an event centre or one satellite detection. */
export interface ExportRecord {
  readonly id: string;
  /** The placemark name in KML; a property like any other in GeoJSON and CSV. */
  readonly name: string;
  readonly lon: number;
  readonly lat: number;
  /** KML `<TimeSpan>` / `<TimeStamp>`: ISO UTC; `end` equals `begin` for an instant. */
  readonly time: { readonly begin: string; readonly end: string } | null;
  /** Column order is the order here, and every record of a document has the same keys. */
  readonly properties: readonly (readonly [string, ExportValue])[];
}

export interface ExportDocument {
  /** File title, in the reader's language. */
  readonly title: string;
  /** The honest-label caveat: satellite detections, not confirmed fires. */
  readonly notice: string;
  /** When the file was made, ISO UTC. */
  readonly generatedAt: string;
  readonly attribution: readonly ExportAttribution[];
  /** The column keys, in order — the CSV header even when there are no records. */
  readonly columns: readonly string[];
  readonly records: readonly ExportRecord[];
}

/**
 * Epoch milliseconds → ISO 8601 UTC, second precision (`2026-08-09T01:02:00Z`). Satellite
 * observation times are minute-precise at best, so a `.000` would be false precision.
 */
export function isoUtc(epochMs: number): string {
  return new Date(epochMs).toISOString().replace(/\.\d{3}Z$/u, 'Z');
}

/** An ISO timestamp in any offset → {@link isoUtc}; `null` when it does not parse. */
export function normaliseIso(value: string): string | null {
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? isoUtc(ms) : null;
}
