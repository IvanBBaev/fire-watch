/**
 * The "Download" action (TASKS V2-D1): build the file in the browser and hand it to the
 * browser's download flow.
 *
 * Loaded only when a reader presses a format button (`download-menu.tsx` imports it with
 * `import()`; CI-12 role `action`), so the serialisers never weigh on the first render or
 * the map. Everything comes from data the web already holds — the listed events, or the
 * event's detections file the event page reads — so no server endpoint is involved and the
 * file says no more than the screen did.
 */

import {
  detectionsDocument,
  eventsDocument,
  type ExportContext,
  exportFileName,
  parseExportDetections,
} from '../../core/export/records.js';
import {
  EXPORT_EXTENSION,
  EXPORT_MEDIA_TYPE,
  type ExportFormat,
  serialiseExport,
} from '../../core/export/serialise.js';
import type { ExportDocument } from '../../core/export/export-document.js';
import type { FireEvent } from '../../core/types.js';
import { downloadBlob } from '../share/share-image.js';

export type ExportRequest =
  /** The events the list shows, in list order. */
  | { readonly kind: 'events'; readonly events: readonly FireEvent[] }
  /** One event's detections, read from its detections file. */
  | { readonly kind: 'detections'; readonly event: FireEvent; readonly url: string | null };

export type FetchJson = (url: string) => Promise<unknown>;

const fetchJson: FetchJson = async (url) => {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`detections file answered ${response.status}`);
  return (await response.json()) as unknown;
};

/**
 * The document a request makes. Rejects when the detections file cannot be read: a
 * detections export with no detections because the file failed would look like an event
 * with nothing in it.
 */
export async function buildExportDocument(
  request: ExportRequest,
  context: ExportContext,
  load: FetchJson = fetchJson,
): Promise<{ readonly document: ExportDocument; readonly stem: string }> {
  if (request.kind === 'events') {
    return { document: eventsDocument(request.events, context), stem: 'events' };
  }
  if (request.url === null) throw new Error('no detections URL is configured');
  const detections = parseExportDetections(await load(request.url));
  return {
    document: detectionsDocument(request.event, detections, context),
    stem: `${request.event.id}-detections`,
  };
}

/** Builds, serialises and saves the file. */
export async function runExport(
  request: ExportRequest,
  format: ExportFormat,
  context: ExportContext,
): Promise<void> {
  const { document, stem } = await buildExportDocument(request, context);
  const text = serialiseExport(document, format);
  downloadBlob(
    new Blob([text], { type: EXPORT_MEDIA_TYPE[format] }),
    exportFileName(stem, context.generatedAtMs, EXPORT_EXTENSION[format]),
  );
}
