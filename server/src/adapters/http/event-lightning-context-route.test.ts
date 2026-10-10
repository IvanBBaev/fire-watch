import { describe, expect, it } from 'vitest';

import { VirtualClock } from '../../core/ports/clock.js';
import type {
  LightningContextRead,
  LightningContextRow,
} from '../../core/ports/lightning-context-store.js';
import { createHealthServer } from './health-server.js';

// Synthetic rows only.
const NOW = Date.parse('2026-09-30T12:00:00Z');
const HOUR = 3_600_000;
const ID = 'fw-2026-aaaaa';
const url = (id: string): string => `/api/v1/events/${id}/lightning-context`;

function row(overrides: Partial<LightningContextRow> = {}): LightningContextRow {
  return {
    eventId: '1',
    status: 'complete',
    windowFrom: NOW - 5 * HOUR,
    windowTo: NOW - 2 * HOUR,
    radiusKm: 10,
    flashCount: 3,
    nearestKm: 4.2,
    paramsVersion: 'lightning_context_v1',
    filterVersion: 'lightning_filter_v1',
    computedAt: NOW - HOUR,
    ...overrides,
  };
}

function server(answer: LightningContextRead | Error) {
  return createHealthServer({
    reader: { readObservations: () => Promise.reject(new Error('unused')) },
    probe: { ping: () => Promise.reject(new Error('unused')) },
    clock: new VirtualClock(NOW),
    expected: [],
    eventLightningContext: {
      reader: {
        readLightningContext: () =>
          answer instanceof Error ? Promise.reject(answer) : Promise.resolve(answer),
      },
      clock: new VirtualClock(NOW),
    },
  });
}

describe('GET /api/v1/events/:publicId/lightning-context', () => {
  it('serves a complete count with the EUMETSAT credit', async () => {
    const response = await server({
      kind: 'event',
      firstDetectedAt: NOW - 2 * HOUR,
      row: row(),
    }).inject({ method: 'GET', url: url(ID) });
    expect(response.statusCode).toBe(200);
    const body = response.json<Record<string, unknown>>();
    expect(body).toMatchObject({
      event_id: ID,
      status: 'complete',
      flash_count: 3,
      nearest_km: 4.2,
      radius_km: 10,
      window_hours: 3,
      window_from: '2026-09-30T07:00:00Z',
      window_to: '2026-09-30T10:00:00Z',
    });
    expect(body['attribution']).toEqual([expect.objectContaining({ id: 'eumetsat-meteosat' })]);
    expect(response.headers['access-control-allow-origin']).toBe('*');
    expect(response.headers['etag']).toBeDefined();
  });

  it('serves zero flashes without a nearest distance', async () => {
    const response = await server({
      kind: 'event',
      firstDetectedAt: NOW - 2 * HOUR,
      row: row({ flashCount: 0, nearestKm: null }),
    }).inject({ method: 'GET', url: url(ID) });
    const body = response.json<Record<string, unknown>>();
    expect(body['flash_count']).toBe(0);
    expect(body).not.toHaveProperty('nearest_km');
  });

  it('never sends a count for an unavailable row', async () => {
    const response = await server({
      kind: 'event',
      firstDetectedAt: NOW - 2 * HOUR,
      row: row({ status: 'unavailable', flashCount: null, nearestKm: null }),
    }).inject({ method: 'GET', url: url(ID) });
    const body = response.json<Record<string, unknown>>();
    expect(body['status']).toBe('no_data');
    expect(body).not.toHaveProperty('flash_count');
    expect(body['attribution']).toEqual([]);
  });

  it('says pending while an unanswered window can still be covered, no_data after', async () => {
    const recent = await server({ kind: 'event', firstDetectedAt: NOW - HOUR, row: null }).inject({
      method: 'GET',
      url: url(ID),
    });
    expect(recent.json<Record<string, unknown>>()).toMatchObject({
      status: 'pending',
      window_from: '2026-09-30T08:00:00Z',
    });
    const old = await server({ kind: 'event', firstDetectedAt: NOW - 7 * HOUR, row: null }).inject({
      method: 'GET',
      url: url(ID),
    });
    expect(old.json<Record<string, unknown>>()['status']).toBe('no_data');
  });

  it('answers 304 for a matching tag', async () => {
    const s = server({ kind: 'event', firstDetectedAt: NOW - 2 * HOUR, row: row() });
    const first = await s.inject({ method: 'GET', url: url(ID) });
    const again = await s.inject({
      method: 'GET',
      url: url(ID),
      headers: { 'if-none-match': String(first.headers['etag']) },
    });
    expect(again.statusCode).toBe(304);
  });

  it('is a 404 for an unknown or malformed id, 400 for a query, 503 on a read failure', async () => {
    expect(
      (await server({ kind: 'unknown' }).inject({ method: 'GET', url: url(ID) })).statusCode,
    ).toBe(404);
    expect(
      (await server({ kind: 'unknown' }).inject({ method: 'GET', url: url('nope') })).statusCode,
    ).toBe(404);
    expect(
      (await server({ kind: 'unknown' }).inject({ method: 'GET', url: `${url(ID)}?x=1` }))
        .statusCode,
    ).toBe(400);
    expect(
      (await server(new Error('db down')).inject({ method: 'GET', url: url(ID) })).statusCode,
    ).toBe(503);
  });
});
