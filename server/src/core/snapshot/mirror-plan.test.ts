import { describe, expect, it } from 'vitest';

import { epochMsFromIso } from '../ports/clock.js';
import {
  DEFAULT_MIRROR_OBJECT_KEY,
  isValidMirrorKey,
  MIRROR_CACHE_CONTROL,
  MIRROR_CONTENT_TYPE,
  planMirrorObject,
} from './mirror-plan.js';
import { SNAPSHOT_SCHEMA_VERSION, buildSnapshot } from './snapshot-builder.js';

const GENERATED_AT = epochMsFromIso('2026-07-14T10:15:00Z');

function document(afterSeq = 0) {
  return buildSnapshot({
    read: {
      maxSeq: 1041,
      events: [
        {
          publicId: 'fw-2026-abc123',
          seq: 1040,
          status: 'active',
          score: 0.55,
          lon: 25.123456,
          lat: 42.654321,
          startedAt: epochMsFromIso('2026-07-13T09:00:00Z'),
          lastDetectionAt: epochMsFromIso('2026-07-14T09:40:00Z'),
          detectionCount: 7,
          nearestPlace: null,
        },
      ],
    },
    sources: [{ sourceId: 'firms-viirs-noaa20', lastObservedAt: null }],
    generatedAtMs: GENERATED_AT,
    afterSeq,
  });
}

describe('planMirrorObject', () => {
  it('is the API body, byte for byte, under the default key', () => {
    const doc = document();
    const object = planMirrorObject(doc, DEFAULT_MIRROR_OBJECT_KEY);
    expect(object.key).toBe('snapshot.json');
    // Fastify's `send(object)` is JSON.stringify; the web parser reads this shape.
    expect(object.body).toBe(JSON.stringify(doc));
    expect(JSON.parse(object.body)).toMatchObject({
      type: 'FeatureCollection',
      generated_at: '2026-07-14T10:15:00Z',
      max_seq: 1041,
      partial: false,
    });
    expect(object.contentType).toBe(MIRROR_CONTENT_TYPE);
  });

  it('stamps the body instant as metadata, never a second clock', () => {
    const object = planMirrorObject(document(), 'snapshot.json');
    expect(object.metadata).toEqual({
      'generated-at': '2026-07-14T10:15:00Z',
      'max-seq': '1041',
      'schema-version': String(SNAPSHOT_SCHEMA_VERSION),
    });
  });

  it('sets a short, honest Cache-Control with no stale-serving extensions', () => {
    const object = planMirrorObject(document(), 'snapshot.json');
    expect(object.cacheControl).toBe(MIRROR_CACHE_CONTROL);
    expect(object.cacheControl).toMatch(/max-age=0/);
    expect(object.cacheControl).not.toMatch(/stale-/);
    // Edge hold + 60 s cadence must stay inside the 5 min T2 bound with room for a slow push.
    const sMaxAge = Number(/s-maxage=(\d+)/.exec(object.cacheControl)?.[1]);
    expect(sMaxAge + 60).toBeLessThan(300 / 2);
  });

  it('is deterministic', () => {
    expect(planMirrorObject(document(), 'a/b.json')).toEqual(
      planMirrorObject(document(), 'a/b.json'),
    );
  });

  it('refuses a partial document, which would read as the whole set', () => {
    expect(() => planMirrorObject(document(5), 'snapshot.json')).toThrow(/partial/);
  });

  it.each(['', '/snapshot.json', 'a//b', 'a/../b', 'snap shot.json', 'x/', 'ü.json'])(
    'refuses the key %j',
    (key) => {
      expect(isValidMirrorKey(key)).toBe(false);
      expect(() => planMirrorObject(document(), key)).toThrow(/safe path/);
    },
  );

  it.each(['snapshot.json', 'v1/snapshot.json', 'a-b_c.d'])('accepts the key %j', (key) => {
    expect(isValidMirrorKey(key)).toBe(true);
  });
});
