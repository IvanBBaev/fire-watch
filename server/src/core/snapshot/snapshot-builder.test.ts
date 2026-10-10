import { describe, expect, it, vi } from 'vitest';

import { epochMsFromIso } from '../ports/clock.js';
import type { ActiveEventRow, ActiveSetRead } from '../ports/snapshot-reader.js';
import {
  PRODUCT_NAME,
  SNAPSHOT_SCHEMA_VERSION,
  attributionFor,
  buildSnapshot,
  snapshotEtag,
} from './snapshot-builder.js';

const GENERATED_AT = epochMsFromIso('2026-07-14T10:15:00Z');

function row(overrides: Partial<ActiveEventRow> = {}): ActiveEventRow {
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
    sourceIds: ['firms:viirs:noaa20', 'firms:viirs:snpp'],
    staticSourceVerdict: 'clear',
    ...overrides,
  };
}

function read(events: readonly ActiveEventRow[], maxSeq?: number): ActiveSetRead {
  return { maxSeq: maxSeq ?? Math.max(0, ...events.map((event) => event.seq)), events };
}

describe('buildSnapshot', () => {
  it('projects the active set into the wire shape the web parser guards', () => {
    const doc = buildSnapshot({
      read: read([row()]),
      sources: [
        { sourceId: 'firms-viirs-noaa20', lastObservedAt: epochMsFromIso('2026-07-14T09:40:00Z') },
        { sourceId: 'firms-modis', lastObservedAt: null },
      ],
      generatedAtMs: GENERATED_AT,
      afterSeq: 0,
    });

    expect(doc).toMatchObject({
      type: 'FeatureCollection',
      schema_version: SNAPSHOT_SCHEMA_VERSION,
      generated_at: '2026-07-14T10:15:00Z',
      max_seq: 1040,
      partial: false,
      sources: [
        { source_id: 'firms-viirs-noaa20', last_observed_at: '2026-07-14T09:40:00Z' },
        { source_id: 'firms-modis', last_observed_at: null },
      ],
    });
    expect(doc.features).toEqual([
      {
        type: 'Feature',
        id: 'fw-2026-abc123',
        geometry: { type: 'Point', coordinates: [25.123456, 42.654321] },
        properties: {
          id: 'fw-2026-abc123',
          seq: 1040,
          status: 'active',
          score_bucket: 'likely',
          merged_into: null,
          first_observed_at: '2026-07-13T09:00:00Z',
          last_observed_at: '2026-07-14T09:40:00Z',
          detection_count: 7,
          place_name_bg: 'Карлово',
          place_name_en: 'Karlovo',
          area_ha: null,
          next_pass_window: null,
          source_ids: ['firms:viirs:noaa20', 'firms:viirs:snpp'],
          static_source_verdict: 'clear',
        },
      },
    ]);
  });

  it('serves source ids deduplicated and in code-unit order, whatever the reader gave', () => {
    const doc = buildSnapshot({
      read: read([
        row({ sourceIds: ['lsasaf:seviri:frp-pixel', 'firms:viirs:snpp', 'firms:viirs:snpp'] }),
        row({
          publicId: 'b',
          seq: 1041,
          sourceIds: ['firms:viirs:snpp', 'lsasaf:seviri:frp-pixel'],
        }),
      ]),
      sources: [],
      generatedAtMs: GENERATED_AT,
      afterSeq: 0,
    });
    const ids = doc.features.map((f) => f.properties.source_ids);
    expect(ids[0]).toEqual(['firms:viirs:snpp', 'lsasaf:seviri:frp-pixel']);
    // Same set, different reader order: the same bytes on the wire.
    expect(JSON.stringify(ids[1])).toBe(JSON.stringify(ids[0]));
  });

  it('serves an unrecorded or empty source set as null, never as an empty list', () => {
    // `[]` would read as "no sensor saw this"; `null` is "not reported", which the web's
    // source filter fails open on.
    const doc = buildSnapshot({
      read: read([row({ sourceIds: null }), row({ publicId: 'b', seq: 1041, sourceIds: [] })]),
      sources: [],
      generatedAtMs: GENERATED_AT,
      afterSeq: 0,
    });
    expect(doc.features.map((f) => f.properties.source_ids)).toEqual([null, null]);
    expect(doc.features.every((f) => 'source_ids' in f.properties)).toBe(true);
  });

  it('serves the static-source verdict an active member can carry, and null for the rest', () => {
    // An invalidating verdict on an active row cannot happen (the projection removes the
    // event); if a row ever carries one, the wire says "not reported", never the claim.
    const verdicts = [
      'annotated',
      'clear',
      null,
      'static_source',
      'suspected_static_source',
    ] as const;
    const doc = buildSnapshot({
      read: read(
        verdicts.map((staticSourceVerdict, i) =>
          row({ publicId: `e${String(i)}`, seq: 1040 + i, staticSourceVerdict }),
        ),
      ),
      sources: [],
      generatedAtMs: GENERATED_AT,
      afterSeq: 0,
    });
    expect(doc.features.map((f) => f.properties.static_source_verdict)).toEqual([
      'annotated',
      'clear',
      null,
      null,
      null,
    ]);
    expect(doc.schema_version).toBe(2);
  });

  it('carries the public id once as the store key and never emits a uuid (schema v2)', () => {
    const doc = buildSnapshot({
      read: read([row()]),
      sources: [],
      generatedAtMs: GENERATED_AT,
      afterSeq: 0,
    });
    const feature = doc.features[0];
    expect(feature?.id).toBe('fw-2026-abc123');
    expect(feature?.properties.id).toBe(feature?.id);
    expect(Object.keys(feature?.properties ?? {})).not.toContain('uuid');
    expect(JSON.stringify(doc)).not.toContain('"uuid"');
    expect(SNAPSHOT_SCHEMA_VERSION).toBe(2);
  });

  it('never ships the raw score, only its bucket (ADR-003 D4)', () => {
    const doc = buildSnapshot({
      read: read([
        row({ score: 0.05 }),
        row({ publicId: 'fw-2026-def456', seq: 1041, score: 0.95 }),
      ]),
      sources: [],
      generatedAtMs: GENERATED_AT,
      afterSeq: 0,
    });
    expect(doc.features.map((f) => f.properties.score_bucket)).toEqual(['unverified', 'confirmed']);
    expect(JSON.stringify(doc)).not.toContain('"score"');
  });

  it('keeps the rows in the order the reader gave them, which is ascending seq', () => {
    const doc = buildSnapshot({
      read: read([
        row({ seq: 3 }),
        row({ publicId: 'b', seq: 8 }),
        row({ publicId: 'c', seq: 21 }),
      ]),
      sources: [],
      generatedAtMs: GENERATED_AT,
      afterSeq: 0,
    });
    expect(doc.features.map((f) => f.properties.seq)).toEqual([3, 8, 21]);
  });

  it('renders an empty place as empty strings, not as a missing member', () => {
    const doc = buildSnapshot({
      read: read([row({ nearestPlace: null })]),
      sources: [],
      generatedAtMs: GENERATED_AT,
      afterSeq: 0,
    });
    expect(doc.features[0]?.properties.place_name_bg).toBe('');
    expect(doc.features[0]?.properties.place_name_en).toBe('');
  });

  it('marks a cursor read partial and keeps the global max seq, not the batch max (A1.5)', () => {
    // The set moved to 1050 while only one row is above the cursor: the client must learn
    // the high-water mark from this response, yet must not treat its members as the set.
    const doc = buildSnapshot({
      read: read([row({ seq: 1047 })], 1050),
      sources: [],
      generatedAtMs: GENERATED_AT,
      afterSeq: 1042,
    });
    expect(doc.partial).toBe(true);
    expect(doc.max_seq).toBe(1050);
  });

  it('reports an empty registry as max_seq 0 with no features and is not partial', () => {
    const doc = buildSnapshot({
      read: { maxSeq: 0, events: [] },
      sources: [],
      generatedAtMs: GENERATED_AT,
      afterSeq: 0,
    });
    expect(doc.max_seq).toBe(0);
    expect(doc.features).toEqual([]);
    expect(doc.partial).toBe(false);
  });

  it('does not consult the wall clock: generated_at is the caller’s instant (A1.4 R1)', () => {
    const now = vi.spyOn(Date, 'now');
    try {
      const doc = buildSnapshot({
        read: read([row()]),
        sources: [],
        generatedAtMs: GENERATED_AT,
        afterSeq: 0,
      });
      expect(doc.generated_at).toBe('2026-07-14T10:15:00Z');
      expect(now).not.toHaveBeenCalled();
    } finally {
      now.mockRestore();
    }
  });

  it('carries the verbatim data credits under `attribution` (A1.3)', () => {
    const doc = buildSnapshot({
      read: read([]),
      sources: [],
      generatedAtMs: GENERATED_AT,
      afterSeq: 0,
    });
    const byId = new Map(doc.attribution.map((entry) => [entry.id, entry]));
    expect(byId.get('sentinel-modified')?.text).toBe(
      'Contains modified Copernicus Sentinel data 2026',
    );
    expect(byId.get('lance-tactical-disclaimer')?.text).toContain('not advised');
    expect(byId.get('derivation')?.text).toContain(`derived by ${PRODUCT_NAME} from`);
    expect(byId.has('openfreemap')).toBe(false);
    for (const entry of doc.attribution) {
      expect(entry.text, entry.id).not.toContain('[year]');
      expect(entry.text, entry.id).not.toContain('[Product]');
    }
  });

  it('resolves the attribution year from generated_at, not from the process clock', () => {
    const next = attributionFor(epochMsFromIso('2031-01-01T00:00:00Z'));
    expect(next.find((entry) => entry.id === 'eumetsat-meteosat')?.text).toBe(
      'Contains modified EUMETSAT Meteosat data 2031',
    );
  });
});

describe('snapshotEtag', () => {
  it('is a strong validator derived from the schema version and the max seq only', () => {
    expect(snapshotEtag(1042)).toBe(`"v${String(SNAPSHOT_SCHEMA_VERSION)}-1042"`);
    expect(snapshotEtag(0)).toBe(`"v${String(SNAPSHOT_SCHEMA_VERSION)}-0"`);
  });

  it('changes whenever the max seq changes and is stable when it does not', () => {
    expect(snapshotEtag(1042)).toBe(snapshotEtag(1042));
    expect(snapshotEtag(1042)).not.toBe(snapshotEtag(1043));
  });

  it('refuses a seq that is not a non-negative safe integer', () => {
    expect(() => snapshotEtag(-1)).toThrow(RangeError);
    expect(() => snapshotEtag(1.5)).toThrow(RangeError);
    expect(() => snapshotEtag(Number.NaN)).toThrow(RangeError);
    expect(() => snapshotEtag(2 ** 53)).toThrow(RangeError);
  });
});
