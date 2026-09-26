/**
 * The imagery reader of client-config (ADR-001 A1.3/A2.3, TASKS G6).
 *
 * The server owns the decision: the `imagery` block is present only while the Esri World
 * Imagery toggle is enabled, and absent once the quota tripwire has fired, while no key is
 * configured, or while an operator has switched it off. This reader therefore has two
 * answers only — handles, or `null` — and a block that is present but malformed is `null`
 * too: a toggle that would show broken tiles is worse than no toggle (A2.3, "the control is
 * missing, never broken").
 *
 * Kept apart from the transport reader in `feed/client-config.ts`, which is deliberately
 * blind to this block: the two fail differently. An unreachable document keeps the
 * transport's build-time values, but it never keeps imagery on — see `imagery-refresh.ts`.
 */

import { isClientImageryBlock } from '@fire-watch/contracts';

/** What the map needs to draw the imagery layer: the tile template and the metered key. */
export interface ImageryHandles {
  readonly tileUrlTemplate: string;
  readonly apiKey: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The imagery handles a client-config document carries, or `null` for "no toggle". */
export function parseImageryHandles(document: unknown): ImageryHandles | null {
  if (!isRecord(document)) return null;
  const block = document['imagery'];
  if (!isClientImageryBlock(block)) return null;
  return { tileUrlTemplate: block.tile_url_template, apiKey: block.api_key };
}

/**
 * The MapLibre raster tile URL: the template with the key as the `token` parameter. The
 * contract guarantees the template carries no `token` of its own and the key is URL-safe,
 * so appending is the whole job.
 */
export function imageryTileUrl(handles: ImageryHandles): string {
  const separator = handles.tileUrlTemplate.includes('?') ? '&' : '?';
  return `${handles.tileUrlTemplate}${separator}token=${handles.apiKey}`;
}

export function sameImageryHandles(a: ImageryHandles | null, b: ImageryHandles | null): boolean {
  if (a === null || b === null) return a === b;
  return a.tileUrlTemplate === b.tileUrlTemplate && a.apiKey === b.apiKey;
}
