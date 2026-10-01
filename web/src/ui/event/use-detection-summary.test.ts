import { describe, expect, it } from 'vitest';

import { detailStateOf, detectionsUrl } from './use-detection-summary.js';

describe('detectionsUrl', () => {
  it('fills the template with the encoded id, or answers null when detail is off', () => {
    expect(detectionsUrl('/fixtures/detections/{id}.json', 'fw-2026-k9s2r')).toBe(
      '/fixtures/detections/fw-2026-k9s2r.json',
    );
    expect(detectionsUrl('/d/{id}', 'a/b')).toBe('/d/a%2Fb');
    expect(detectionsUrl(null, 'fw-2026-k9s2r')).toBeNull();
  });
});

describe('detailStateOf', () => {
  it('is unavailable for a missing body, garbage or an empty collection', () => {
    expect(detailStateOf(null)).toEqual({ kind: 'unavailable' });
    expect(detailStateOf('nope')).toEqual({ kind: 'unavailable' });
    expect(detailStateOf({ features: [] })).toEqual({ kind: 'unavailable' });
  });

  it('is ready with a summary for parseable detections', () => {
    const state = detailStateOf({
      features: [
        {
          properties: {
            uid: 'a',
            observed_at: '2026-08-09T11:45:00Z',
            source_id: 'firms:modis',
            frp_mw: 12,
          },
        },
      ],
    });
    expect(state.kind).toBe('ready');
    if (state.kind === 'ready')
      expect(state.summary.sensors).toEqual([{ sourceId: 'firms:modis', detections: 1 }]);
  });
});
