import { describe, expect, it } from 'vitest';

import type { EventStatusTransition } from '../../core/ports/event-status-store.js';
import {
  UPDATE_EVENT_STATUS,
  createPgEventStatusStore,
  type PgEventStatusWritable,
} from './pg-event-status-store.js';

interface Query {
  readonly text: string;
  readonly values: readonly unknown[] | undefined;
}

interface FakeDb extends PgEventStatusWritable {
  readonly queries: Query[];
}

function fakeDb(rows: readonly unknown[] = []): FakeDb {
  const queries: Query[] = [];
  return {
    queries,
    query(text, values) {
      queries.push({ text, values });
      return Promise.resolve({ rows });
    },
  };
}

const TRANSITION: EventStatusTransition = {
  publicId: 'fw-2026-abc123',
  status: 'no_longer_detected',
  statusReason: 'no_detection_within_window',
  displayTier: 'feed',
  inactiveSinceMs: Date.parse('2026-07-14T10:00:00Z'),
  atMs: Date.parse('2026-07-14T10:00:00Z'),
};

describe('the transition statement', () => {
  it('writes the status, the projection and the next seq in one row update', () => {
    expect(UPDATE_EVENT_STATUS).toContain("seq = nextval('fire_events_seq_seq')");
    expect(UPDATE_EVENT_STATUS).toContain('display_tier = $5');
    expect(UPDATE_EVENT_STATUS).toContain('inactive_since = $6');
    expect(UPDATE_EVENT_STATUS).toContain('WHERE public_id = $1 AND merged_into IS NULL');
    expect(UPDATE_EVENT_STATUS).toContain('RETURNING seq::text');
  });

  it('binds the transition in statement order, instants as Dates', async () => {
    const db = fakeDb([{ seq: '1043' }]);
    const seq = await createPgEventStatusStore(db).applyTransition(TRANSITION);
    expect(seq).toBe(1043);
    expect(db.queries).toHaveLength(1);
    expect(db.queries[0]?.text).toBe(UPDATE_EVENT_STATUS);
    expect(db.queries[0]?.values).toEqual([
      'fw-2026-abc123',
      'no_longer_detected',
      'no_detection_within_window',
      new Date('2026-07-14T10:00:00Z'),
      'feed',
      new Date('2026-07-14T10:00:00Z'),
    ]);
  });

  it('binds a null inactivity anchor for a return to the map', async () => {
    const db = fakeDb([{ seq: '1044' }]);
    await createPgEventStatusStore(db).applyTransition({
      ...TRANSITION,
      status: 'active',
      displayTier: 'map',
      inactiveSinceMs: null,
    });
    expect(db.queries[0]?.values?.[5]).toBeNull();
  });

  it('resolves null when no live event has that id', async () => {
    expect(await createPgEventStatusStore(fakeDb([])).applyTransition(TRANSITION)).toBeNull();
  });

  it('refuses a returned seq it cannot represent exactly', async () => {
    const store = createPgEventStatusStore(fakeDb([{ seq: '9007199254740993' }]));
    await expect(store.applyTransition(TRANSITION)).rejects.toThrow(/usable seq/);
  });
});
