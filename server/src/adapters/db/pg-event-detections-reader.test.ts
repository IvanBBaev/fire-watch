import { describe, expect, it } from 'vitest';

import {
  SELECT_EVENT_CHAIN,
  SELECT_EVENT_MEMBERS,
  createPgEventDetectionsReader,
  type PgEventDetectionsReadable,
} from './pg-event-detections-reader.js';

interface Query {
  readonly text: string;
  readonly values: readonly unknown[] | undefined;
}

/** Answers each statement with its own rows, and records what was asked. */
function fakeDb(chain: readonly unknown[], members: readonly unknown[] = []) {
  const queries: Query[] = [];
  const db: PgEventDetectionsReadable = {
    query(text, values) {
      queries.push({ text, values });
      return Promise.resolve({ rows: text === SELECT_EVENT_CHAIN ? chain : members });
    },
  };
  return { db, queries };
}

function link(publicId: string, id: string, seq: string, mergedInto: string | null, depth: number) {
  return { id, public_id: publicId, seq, merged_into: mergedInto, depth };
}

/** A member row exactly as `pg` hands it over: decimals as text, real as number. */
function member(n: number, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    detection_uid: n.toString(16).padStart(64, '0'),
    source: 'firms:viirs:snpp',
    acq_ts: new Date(Date.UTC(2026, 7, 5, 3, 10 - n)),
    lat: '41.86000',
    lon: '25.12345',
    confidence: 'nominal',
    scan_km: 0.39,
    track_km: 0.36,
    frp_mw: 4.5,
    ...overrides,
  };
}

describe('the pg event-detections reader', () => {
  it('reports an id with no row as unknown and runs no member query', async () => {
    const { db, queries } = fakeDb([]);
    const read = await createPgEventDetectionsReader(db).readEventDetections('fw-2026-aaaaa', 10);
    expect(read).toEqual({ kind: 'unknown' });
    expect(queries.map((q) => q.text)).toEqual([SELECT_EVENT_CHAIN]);
    expect(queries[0]?.values).toEqual(['fw-2026-aaaaa']);
  });

  it('resolves a tombstone to the final survivor of the chain, without reading members', async () => {
    const { db, queries } = fakeDb([
      link('fw-2026-aaaaa', '1', '10', '2', 0),
      link('fw-2026-bbbbb', '2', '20', '3', 1),
      link('fw-2026-ccccc', '3', '30', null, 2),
    ]);
    const read = await createPgEventDetectionsReader(db).readEventDetections('fw-2026-aaaaa', 10);
    expect(read).toEqual({
      kind: 'merged',
      seq: 10,
      survivorPublicId: 'fw-2026-ccccc',
      survivorSeq: 30,
    });
    expect(queries).toHaveLength(1);
  });

  it('refuses a chain that does not end — a cycle is a corrupt registry, not an answer', async () => {
    const { db } = fakeDb([
      link('fw-2026-aaaaa', '1', '10', '2', 0),
      link('fw-2026-bbbbb', '2', '20', '1', 1),
    ]);
    await expect(
      createPgEventDetectionsReader(db).readEventDetections('fw-2026-aaaaa', 10),
    ).rejects.toThrow(/merge chain/);
  });

  it('decodes members oldest first, keeps nulls as null, and asks for one past the limit', async () => {
    // The statement returns newest first.
    const { db, queries } = fakeDb(
      [link('fw-2026-aaaaa', '7', '1040', null, 0)],
      [member(1), member(2, { frp_mw: null, scan_km: null, track_km: null, confidence: 'high' })],
    );
    const read = await createPgEventDetectionsReader(db).readEventDetections('fw-2026-aaaaa', 5);
    expect(queries[1]).toEqual({ text: SELECT_EVENT_MEMBERS, values: ['7', '6'] });
    expect(read).toEqual({
      kind: 'event',
      seq: 1040,
      truncated: false,
      detections: [
        {
          uid: (2).toString(16).padStart(64, '0'),
          sourceId: 'firms:viirs:snpp',
          observedAt: Date.UTC(2026, 7, 5, 3, 8),
          lat: 41.86,
          lon: 25.12345,
          confidence: 'high',
          scanKm: null,
          trackKm: null,
          frpMw: null,
        },
        {
          uid: (1).toString(16).padStart(64, '0'),
          sourceId: 'firms:viirs:snpp',
          observedAt: Date.UTC(2026, 7, 5, 3, 9),
          lat: 41.86,
          lon: 25.12345,
          confidence: 'nominal',
          scanKm: 0.39,
          trackKm: 0.36,
          frpMw: 4.5,
        },
      ],
    });
  });

  it('keeps the newest `limit` and flags the rest as truncated', async () => {
    const { db } = fakeDb(
      [link('fw-2026-aaaaa', '7', '1040', null, 0)],
      [member(1), member(2), member(3)],
    );
    const read = await createPgEventDetectionsReader(db).readEventDetections('fw-2026-aaaaa', 2);
    expect(read.kind).toBe('event');
    if (read.kind !== 'event') return;
    expect(read.truncated).toBe(true);
    expect(read.detections.map((d) => d.observedAt)).toEqual([
      Date.UTC(2026, 7, 5, 3, 8),
      Date.UTC(2026, 7, 5, 3, 9),
    ]);
  });

  it('throws on a row it cannot decode rather than guessing', async () => {
    const { db } = fakeDb(
      [link('fw-2026-aaaaa', '7', '1040', null, 0)],
      [member(1, { confidence: 'maybe' })],
    );
    await expect(
      createPgEventDetectionsReader(db).readEventDetections('fw-2026-aaaaa', 5),
    ).rejects.toThrow(/confidence/);
  });

  it('refuses a limit that is not a positive integer', async () => {
    const { db } = fakeDb([]);
    await expect(
      createPgEventDetectionsReader(db).readEventDetections('fw-2026-aaaaa', 0),
    ).rejects.toThrow(RangeError);
  });
});
