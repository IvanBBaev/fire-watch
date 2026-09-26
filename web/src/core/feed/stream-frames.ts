/**
 * The wire boundary for the T0 stream (ADR-003 D1 T0, E2) — `parse-snapshot`'s twin for
 * frames. The browser hands over one named SSE frame at a time (`StreamFrameEnvelope`:
 * name, `id:` cursor, raw `data:` text); this is the single place that guards the frame
 * and maps it into the flat `StreamFrame` shape. Nothing past the transport ever sees
 * frame JSON.
 *
 * The shapes mirror the server's producer (`server/src/core/stream/frames.ts`) and are
 * declared again here on purpose: the web never imports from `server/`, so the two sides
 * meet only on the wire, as they will once the origin is a separate deployment.
 *
 *   * **Event frames** — `event.created | event.updated | event.status_changed |
 *     event.merged`. `id:` is the change seq; `data` is `{ generated_at, feature,
 *     previous_status? }` with `feature` the very same GeoJSON Feature `/snapshot.json`
 *     serves, so the store reconciles a delta and a snapshot member identically (D3
 *     rule 2). `seq` is the feature's own `seq`, and the envelope's `id:` (when present)
 *     must agree with it: the feed's cursor *is* that id, and a frame whose id and payload
 *     disagree would let the client resume from a point the server never emitted.
 *   * **Control frames** — `freshness` `{ generated_at, max_seq, sources }`, `reset`
 *     `{ reason }`, `degrade` `{ reason }`. No `id:`; they describe the stream, not an
 *     event. `reason` is kept as free text — the client keys nothing off it.
 *
 * Comment lines (the keepalive) and unnamed messages never reach the handlers, so a name
 * outside the list above is a defect, not a heartbeat. Granularity differs from the
 * snapshot guard: one bad frame is dropped by the feed and the stream goes on, because the
 * store's seq-gap detection already catches a missed change (D3 rule 3).
 */

import type { StreamFrameEnvelope } from '../ports.js';
import type { FireEvent, SnapshotSourceRow } from '../types.js';
import { ParseError, parseFeature } from './parse-snapshot.js';

/** The replayable frames: the ones that carry an `id:` and a feature. */
export const EVENT_FRAME_NAMES = [
  'event.created',
  'event.updated',
  'event.status_changed',
  'event.merged',
] as const;
export type EventFrameName = (typeof EVENT_FRAME_NAMES)[number];

/** The frames that describe the stream itself; never replayed, no `id:`. */
export const CONTROL_FRAME_NAMES = ['freshness', 'reset', 'degrade'] as const;
export type ControlFrameName = (typeof CONTROL_FRAME_NAMES)[number];

/**
 * Every frame name the client listens for. The `EventSource` adapter registers one
 * listener per entry — named frames do not reach `onmessage` — so this list is the one
 * place a new frame name has to be added for the browser to receive it at all.
 */
export const STREAM_FRAME_NAMES: readonly (EventFrameName | ControlFrameName)[] = [
  ...EVENT_FRAME_NAMES,
  ...CONTROL_FRAME_NAMES,
];

/** The change an event frame announces — the frame name without its `event.` prefix. */
export type StreamEventKind = 'created' | 'updated' | 'status_changed' | 'merged';

export type StreamFrame =
  | {
      readonly kind: 'event';
      readonly name: StreamEventKind;
      /** The change seq — the feature's `seq`, equal to the frame's `id:`. */
      readonly seq: number;
      readonly generatedAt: string;
      readonly feature: FireEvent;
      /** `event.status_changed` only: the status the event is moving away from. */
      readonly previousStatus?: string;
    }
  | {
      readonly kind: 'freshness';
      readonly generatedAt: string;
      /** The registry's seq high-water mark at `generatedAt` (may exceed every frame's). */
      readonly maxSeq: number;
      readonly sources: readonly SnapshotSourceRow[];
    }
  | { readonly kind: 'reset'; readonly reason: string }
  | { readonly kind: 'degrade'; readonly reason: string };

type WireRecord = Record<string, unknown>;

function isRecord(value: unknown): value is WireRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function fail(path: string, expected: string, got: unknown): never {
  throw new ParseError(`${path}: expected ${expected}, got ${JSON.stringify(got) ?? 'undefined'}`);
}

function requireString(obj: WireRecord, key: string, path: string): string {
  const value = obj[key];
  if (typeof value !== 'string') fail(`${path}.${key}`, 'string', value);
  return value;
}

function requireStringOrNull(obj: WireRecord, key: string, path: string): string | null {
  const value = obj[key];
  if (value !== null && typeof value !== 'string') fail(`${path}.${key}`, 'string | null', value);
  return value;
}

function requireNumber(obj: WireRecord, key: string, path: string): number {
  const value = obj[key];
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    fail(`${path}.${key}`, 'finite number', value);
  }
  return value;
}

function requireArray(obj: WireRecord, key: string, path: string): readonly unknown[] {
  const value = obj[key];
  if (!Array.isArray(value)) fail(`${path}.${key}`, 'array', value);
  return value;
}

function isEventFrameName(name: string): name is EventFrameName {
  return (EVENT_FRAME_NAMES as readonly string[]).includes(name);
}

/** Decodes the raw `data:` text; anything but a JSON object is a defect. */
function parseData(envelope: StreamFrameEnvelope, path: string): WireRecord {
  let value: unknown;
  try {
    value = JSON.parse(envelope.data);
  } catch {
    // The raw text is the useful diagnostic here, but a frame can be large.
    fail(path, 'JSON', envelope.data.slice(0, 80));
  }
  if (!isRecord(value)) fail(path, 'object', value);
  return value;
}

function parseSourceRow(value: unknown, path: string): SnapshotSourceRow {
  if (!isRecord(value)) fail(path, 'source row object', value);
  return {
    sourceId: requireString(value, 'source_id', path),
    lastObservedAt: requireStringOrNull(value, 'last_observed_at', path),
  };
}

/**
 * The envelope's `id:` must be the feature's `seq`, exactly. The server writes the seq
 * as a plain decimal, so the comparison is textual on purpose: `Number("1e2")` would
 * equate strings the server never emits.
 */
function checkCursor(envelope: StreamFrameEnvelope, seq: number, path: string): void {
  if (envelope.lastEventId === '') return;
  if (envelope.lastEventId !== String(seq)) {
    fail(`${path} id`, `the feature seq ${String(seq)}`, envelope.lastEventId);
  }
}

function parseEventFrame(
  name: EventFrameName,
  envelope: StreamFrameEnvelope,
  path: string,
): StreamFrame {
  const data = parseData(envelope, path);
  const feature = parseFeature(data['feature'], `${path}.feature`);
  checkCursor(envelope, feature.seq, name);
  const frame = {
    kind: 'event' as const,
    name: name.slice('event.'.length) as StreamEventKind,
    seq: feature.seq,
    generatedAt: requireString(data, 'generated_at', path),
    feature,
  };
  // `previous_status` is present on `event.status_changed` only; the key is added just
  // when it is there so the parsed frame has no `undefined` members.
  if (data['previous_status'] === undefined) return frame;
  return { ...frame, previousStatus: requireString(data, 'previous_status', path) };
}

/**
 * Parse and structurally guard one stream frame. Throws `ParseError` on any defect —
 * an unknown name, non-JSON data, a malformed feature, an `id:` that disagrees with the
 * feature's `seq` — and never returns a partially-valid frame.
 */
export function parseStreamFrame(envelope: StreamFrameEnvelope): StreamFrame {
  const { name } = envelope;
  const path = `${name}.data`;
  if (isEventFrameName(name)) return parseEventFrame(name, envelope, path);
  switch (name) {
    case 'freshness': {
      const data = parseData(envelope, path);
      return {
        kind: 'freshness',
        generatedAt: requireString(data, 'generated_at', path),
        maxSeq: requireNumber(data, 'max_seq', path),
        sources: requireArray(data, 'sources', path).map((row, i) =>
          parseSourceRow(row, `${path}.sources[${i}]`),
        ),
      };
    }
    case 'reset':
      return { kind: 'reset', reason: requireString(parseData(envelope, path), 'reason', path) };
    case 'degrade':
      return { kind: 'degrade', reason: requireString(parseData(envelope, path), 'reason', path) };
    default:
      return fail('event name', `one of ${STREAM_FRAME_NAMES.join(', ')}`, name);
  }
}
