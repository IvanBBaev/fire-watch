import { describe, expect, it } from 'vitest';

import type { StreamFrameEnvelope } from '../ports.js';
import { ParseError } from './parse-snapshot.js';
import { EVENT_FRAME_NAMES, STREAM_FRAME_NAMES, parseStreamFrame } from './stream-frames.js';

/** A wire feature exactly as `/snapshot.json` serves one (the shape E2 frames carry). */
function wireFeature(seq = 42): Record<string, unknown> {
  return {
    type: 'Feature',
    id: 'fw-2026-q7f3d',
    geometry: { type: 'Point', coordinates: [25.9, 41.93] },
    properties: {
      id: 'fw-2026-q7f3d',
      seq,
      status: 'active',
      score_bucket: 'confirmed',
      merged_into: null,
      first_observed_at: '2026-08-07T11:14:00Z',
      last_observed_at: '2026-08-09T09:47:00Z',
      detection_count: 14,
      place_name_bg: 'Харманли',
      place_name_en: 'Harmanli',
      area_ha: 320,
      next_pass_window: null,
    },
  };
}

const GENERATED_AT = '2026-08-09T09:58:00Z';

/** The envelope the browser adapter builds from a named frame. */
function envelope(name: string, data: unknown, lastEventId = ''): StreamFrameEnvelope {
  return { name, lastEventId, data: typeof data === 'string' ? data : JSON.stringify(data) };
}

function eventEnvelope(
  name: string,
  overrides: Record<string, unknown> = {},
  lastEventId = '42',
): StreamFrameEnvelope {
  return envelope(
    name,
    { generated_at: GENERATED_AT, feature: wireFeature(), ...overrides },
    lastEventId,
  );
}

describe('parseStreamFrame', () => {
  describe('event frames', () => {
    it.each([
      ['event.created', 'created'],
      ['event.updated', 'updated'],
      ['event.status_changed', 'status_changed'],
      ['event.merged', 'merged'],
    ])('maps %s to an event frame named %s carrying the parsed feature', (wireName, name) => {
      const frame = parseStreamFrame(eventEnvelope(wireName));

      expect(frame).toEqual({
        kind: 'event',
        name,
        seq: 42,
        generatedAt: GENERATED_AT,
        feature: {
          id: 'fw-2026-q7f3d',
          seq: 42,
          status: 'active',
          scoreBucket: 'confirmed',
          mergedInto: null,
          lon: 25.9,
          lat: 41.93,
          firstObservedAt: '2026-08-07T11:14:00Z',
          lastObservedAt: '2026-08-09T09:47:00Z',
          detectionCount: 14,
          placeNameBg: 'Харманли',
          placeNameEn: 'Harmanli',
          areaHa: 320,
          nextPassWindow: null,
        },
      });
      expect(frame).not.toHaveProperty('previousStatus');
    });

    it('carries previous_status through on a status change', () => {
      const frame = parseStreamFrame(
        eventEnvelope('event.status_changed', { previous_status: 'new' }),
      );
      expect(frame).toMatchObject({ kind: 'event', name: 'status_changed', previousStatus: 'new' });
    });

    it('takes seq from the feature when the envelope carries no id', () => {
      const frame = parseStreamFrame(eventEnvelope('event.updated', {}, ''));
      expect(frame).toMatchObject({ kind: 'event', seq: 42 });
    });

    it('rejects an envelope id that disagrees with the feature seq (the cursor is the id)', () => {
      expect(() => parseStreamFrame(eventEnvelope('event.updated', {}, '41'))).toThrow(
        new ParseError('event.updated id: expected the feature seq 42, got "41"'),
      );
    });

    it('rejects a non-decimal envelope id even when numerically equal', () => {
      expect(() => parseStreamFrame(eventEnvelope('event.updated', {}, '4.2e1'))).toThrow(
        ParseError,
      );
      expect(() => parseStreamFrame(eventEnvelope('event.updated', {}, '042'))).toThrow(ParseError);
    });

    it('rejects a missing generated_at with the frame path', () => {
      expect(() =>
        parseStreamFrame(eventEnvelope('event.created', { generated_at: undefined })),
      ).toThrow(new ParseError('event.created.data.generated_at: expected string, got undefined'));
    });

    it('rejects a non-string previous_status', () => {
      expect(() =>
        parseStreamFrame(eventEnvelope('event.status_changed', { previous_status: 7 })),
      ).toThrow(
        new ParseError('event.status_changed.data.previous_status: expected string, got 7'),
      );
    });

    it('rejects a malformed feature with a path into it', () => {
      const feature = wireFeature();
      (feature['properties'] as Record<string, unknown>)['status'] = 'on-fire';
      expect(() => parseStreamFrame(eventEnvelope('event.updated', { feature }))).toThrow(
        new ParseError(
          'event.updated.data.feature.properties.status: expected a lifecycle state, got "on-fire"',
        ),
      );
    });

    it('rejects a missing feature', () => {
      expect(() => parseStreamFrame(eventEnvelope('event.merged', { feature: undefined }))).toThrow(
        new ParseError('event.merged.data.feature: expected Feature object, got undefined'),
      );
    });
  });

  describe('control frames', () => {
    it('maps freshness to the stream high-water mark and source rows', () => {
      const frame = parseStreamFrame(
        envelope('freshness', {
          generated_at: GENERATED_AT,
          max_seq: 1042,
          sources: [
            { source_id: 'firms:viirs:snpp', last_observed_at: '2026-08-09T00:52:00Z' },
            { source_id: 'lsasaf:fci:frp-pixel', last_observed_at: null },
          ],
        }),
      );

      expect(frame).toEqual({
        kind: 'freshness',
        generatedAt: GENERATED_AT,
        maxSeq: 1042,
        sources: [
          { sourceId: 'firms:viirs:snpp', lastObservedAt: '2026-08-09T00:52:00Z' },
          { sourceId: 'lsasaf:fci:frp-pixel', lastObservedAt: null },
        ],
      });
    });

    it('rejects a freshness frame with a non-numeric max_seq', () => {
      expect(() =>
        parseStreamFrame(
          envelope('freshness', { generated_at: GENERATED_AT, max_seq: '1042', sources: [] }),
        ),
      ).toThrow(new ParseError('freshness.data.max_seq: expected finite number, got "1042"'));
    });

    it('rejects a freshness frame with a malformed source row, by index', () => {
      expect(() =>
        parseStreamFrame(
          envelope('freshness', {
            generated_at: GENERATED_AT,
            max_seq: 1,
            sources: [{ source_id: 'a', last_observed_at: null }, { source_id: 3 }],
          }),
        ),
      ).toThrow(new ParseError('freshness.data.sources[1].source_id: expected string, got 3'));
    });

    it.each([['too_old'], ['unknown'], ['some-future-reason']])(
      'maps reset with reason %s (any string is accepted)',
      (reason) => {
        expect(parseStreamFrame(envelope('reset', { reason }))).toEqual({ kind: 'reset', reason });
      },
    );

    it('maps degrade with its reason', () => {
      expect(parseStreamFrame(envelope('degrade', { reason: 'capacity' }))).toEqual({
        kind: 'degrade',
        reason: 'capacity',
      });
    });

    it.each([['reset'], ['degrade']])('rejects a %s frame without a string reason', (name) => {
      expect(() => parseStreamFrame(envelope(name, {}))).toThrow(
        new ParseError(`${name}.data.reason: expected string, got undefined`),
      );
    });
  });

  describe('envelope defects', () => {
    it('rejects data that is not JSON, quoting its head', () => {
      expect(() => parseStreamFrame(envelope('reset', '{not json'))).toThrow(
        new ParseError('reset.data: expected JSON, got "{not json"'),
      );
    });

    it('rejects JSON data that is not an object', () => {
      expect(() => parseStreamFrame(envelope('freshness', '[1, 2]'))).toThrow(
        new ParseError('freshness.data: expected object, got [1,2]'),
      );
    });

    it.each([['message'], ['hb'], [''], ['event.deleted'], ['EVENT.CREATED']])(
      'rejects the unknown frame name %j',
      (name) => {
        expect(() => parseStreamFrame(envelope(name, { reason: 'x' }))).toThrow(ParseError);
        expect(() => parseStreamFrame(envelope(name, { reason: 'x' }))).toThrow(
          /^event name: expected one of event\.created, .*, degrade, got /,
        );
      },
    );
  });

  it('lists every name the adapter must register, event names first', () => {
    expect(STREAM_FRAME_NAMES).toEqual([...EVENT_FRAME_NAMES, 'freshness', 'reset', 'degrade']);
    expect(new Set(STREAM_FRAME_NAMES).size).toBe(STREAM_FRAME_NAMES.length);
  });
});
