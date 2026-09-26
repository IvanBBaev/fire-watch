/**
 * Row and frame factories shared by the stream tests. Not shipped: nothing under
 * `src/` imports it except `*.test.ts`.
 */

import type { ChangeRow } from '../ports/change-reader.js';
import { epochMsFromIso } from '../ports/clock.js';
import type { ActiveEventRow } from '../ports/snapshot-reader.js';
import { eventFeature } from '../snapshot/snapshot-builder.js';
import type { EventFrame, ReplayableEventType } from './frames.js';

export const T0 = epochMsFromIso('2026-07-14T10:15:00Z');

export function activeRow(overrides: Partial<ActiveEventRow> = {}): ActiveEventRow {
  return {
    publicId: 'fw-2026-abc123',
    seq: 1040,
    status: 'active',
    score: 0.55,
    lon: 25.123456,
    lat: 42.654321,
    startedAt: epochMsFromIso('2026-07-13T09:00:00Z'),
    lastDetectionAt: epochMsFromIso('2026-07-14T09:40:00Z'),
    detectionCount: 7,
    nearestPlace: { name_bg: 'Карлово', name_en: 'Karlovo', lat: 42.64, lon: 24.8 },
    ...overrides,
  };
}

export function changeRow(overrides: Partial<ChangeRow> = {}): ChangeRow {
  return {
    ...activeRow(),
    mergedInto: null,
    displayTier: 'map',
    invalidated: false,
    ...overrides,
  };
}

export function frame(id: number, event: ReplayableEventType = 'event.updated'): EventFrame {
  return {
    id,
    event,
    data: {
      generated_at: '2026-07-14T10:15:00Z',
      feature: eventFeature(activeRow({ publicId: `fw-${String(id)}`, seq: id }), null),
    },
  };
}
