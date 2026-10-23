import { describe, expect, it } from 'vitest';

import en from '../../core/i18n/en.js';
import type { FireEvent } from '../../core/types.js';
import { buildExportDocument } from './run-export.js';

const EVENT: FireEvent = {
  id: 'fw-2026-q7f3d',
  seq: 1,
  status: 'active',
  scoreBucket: 'unverified',
  mergedInto: null,
  lon: 25.9,
  lat: 41.9,
  firstObservedAt: '2026-08-09T08:02:00Z',
  lastObservedAt: '2026-08-09T11:14:00Z',
  detectionCount: 1,
  placeNameBg: 'Сакар',
  placeNameEn: 'Sakar',
  areaHa: null,
  nextPassWindow: null,
};

const CONTEXT = {
  messages: en,
  locale: 'en' as const,
  generatedAtMs: Date.UTC(2026, 7, 9, 12),
  credit: { year: 2026, productName: 'Fire Watch' },
};

describe('buildExportDocument', () => {
  it('exports the listed events without any request', async () => {
    const built = await buildExportDocument({ kind: 'events', events: [EVENT] }, CONTEXT, () =>
      Promise.reject(new Error('no fetch expected')),
    );
    expect(built.stem).toBe('events');
    expect(built.document.records.map((record) => record.id)).toEqual([EVENT.id]);
  });

  it("reads the event's detections file", async () => {
    const urls: string[] = [];
    const built = await buildExportDocument(
      { kind: 'detections', event: EVENT, url: '/detections/fw-2026-q7f3d.json' },
      CONTEXT,
      (url) => {
        urls.push(url);
        return Promise.resolve({
          type: 'FeatureCollection',
          features: [
            {
              type: 'Feature',
              geometry: { type: 'Point', coordinates: [25.9, 41.9] },
              properties: {
                uid: 'd1',
                observed_at: '2026-08-09T11:14:00Z',
                source_id: 'firms:viirs:noaa20',
              },
            },
          ],
        });
      },
    );
    expect(urls).toEqual(['/detections/fw-2026-q7f3d.json']);
    expect(built.stem).toBe('fw-2026-q7f3d-detections');
    expect(built.document.records.map((record) => record.id)).toEqual(['d1']);
  });

  it('fails rather than export an empty file when the detections cannot be read', async () => {
    await expect(
      buildExportDocument({ kind: 'detections', event: EVENT, url: null }, CONTEXT),
    ).rejects.toThrow();
    await expect(
      buildExportDocument({ kind: 'detections', event: EVENT, url: '/x' }, CONTEXT, () =>
        Promise.reject(new Error('404')),
      ),
    ).rejects.toThrow('404');
  });
});
