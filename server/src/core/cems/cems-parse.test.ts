import { describe, expect, it } from 'vitest';

import { POLLING_BBOX } from '../config/polling-bbox.js';
import {
  CEMS_DETAIL_EMSR822,
  CEMS_DETAIL_RESTRICTED_BODY,
  CEMS_LIST_PAGE_0,
  CEMS_LIST_PAGE_50,
} from './__fixtures__/cems-api.js';
import {
  cemsInstant,
  isCemsCandidate,
  isCemsInCoverage,
  parseCemsDetail,
  parseCemsList,
  parseWktPoint,
  wktBox,
  type CemsListEntry,
} from './cems-parse.js';

const COVERAGE = POLLING_BBOX.values;

function listEntries(body: string): readonly CemsListEntry[] {
  const parsed = parseCemsList(body);
  if (!parsed.ok) throw new Error(parsed.reason);
  return parsed.entries;
}

describe('parseCemsList (recorded pages)', () => {
  it('reads every activation of the first page and sees the next link', () => {
    const parsed = parseCemsList(CEMS_LIST_PAGE_0);
    expect(parsed).toMatchObject({ ok: true, skipped: 0, otherCategory: 0, hasNext: true });
    const entries = listEntries(CEMS_LIST_PAGE_0);
    expect(entries).toHaveLength(15);
    expect(entries[0]).toEqual({
      code: 'EMSR932',
      name: 'Wildfire in Huelva Province, Spain',
      event_time: '2026-09-15T13:00:00Z',
      activation_time: '2026-09-15T16:58:00Z',
      last_update: '2026-09-17T12:50:19.784Z',
      closed: true,
      countries: ['Spain'],
      centroid: [-7.213497, 37.789542],
    });
  });

  it('ends the walk on the last page', () => {
    expect(parseCemsList(CEMS_LIST_PAGE_50)).toMatchObject({ ok: true, hasNext: false });
    const emsr822 = listEntries(CEMS_LIST_PAGE_50).find((e) => e.code === 'EMSR822');
    expect(emsr822).toMatchObject({
      event_time: '2025-07-26T08:00:00Z',
      last_update: '2025-08-05T15:29:32.927Z',
      centroid: [23.416672, 41.721618],
      countries: ['Bulgaria'],
    });
  });

  it('skips and counts an entry that does not parse, and drops other categories', () => {
    const body = JSON.stringify({
      next: null,
      results: [
        { code: 'EMSR1', category: 'Wildfire' },
        { code: 'EMSR900', category: 'Flood' },
        ...(JSON.parse(CEMS_LIST_PAGE_0) as { results: unknown[] }).results.slice(0, 1),
      ],
    });
    expect(parseCemsList(body)).toMatchObject({ ok: true, skipped: 1, otherCategory: 1 });
    expect(listEntries(body).map((e) => e.code)).toEqual(['EMSR932']);
  });

  it.each([
    ['not JSON', '<html>'],
    ['no results', '{"next":null}'],
    ['a malformed next', '{"next":1,"results":[]}'],
  ])('fails a page that is %s', (_label, body) => {
    expect(parseCemsList(body).ok).toBe(false);
  });
});

describe('parseCemsDetail (recorded EMSR822)', () => {
  it('keeps each AOI as its bounding box, rounded outward', () => {
    expect(parseCemsDetail(CEMS_DETAIL_EMSR822, 'EMSR822')).toEqual({
      ok: true,
      restricted: false,
      aois: [
        [22.4428, 42.7605, 22.6219, 42.8822],
        [23.1987, 41.6323, 23.3816, 41.75],
        [26.0708, 41.8839, 26.6951, 42.148],
      ],
    });
  });

  it('refuses a detail that describes another activation', () => {
    expect(parseCemsDetail(CEMS_DETAIL_EMSR822, 'EMSR823').ok).toBe(false);
  });

  it('refuses the restricted 403 body as a detail (the refresh reads the status instead)', () => {
    expect(parseCemsDetail(CEMS_DETAIL_RESTRICTED_BODY, 'EMSR700').ok).toBe(false);
  });

  it('marks a sensitive activation restricted and keeps none of its AOIs', () => {
    const body = JSON.stringify({
      results: [{ code: 'EMSR700', sensitive: true, aois: [{ extent: 'POINT (1 2)' }] }],
    });
    expect(parseCemsDetail(body, 'EMSR700')).toEqual({ ok: true, restricted: true, aois: [] });
  });

  it('fails the whole detail when one AOI extent does not parse', () => {
    const body = JSON.stringify({
      results: [
        {
          code: 'EMSR700',
          sensitive: false,
          aois: [{ extent: 'POLYGON ((1 1, 2 1, 2 2, 1 1))' }, { extent: 'LINESTRING (1 1, 2 2)' }],
        },
      ],
    });
    expect(parseCemsDetail(body, 'EMSR700').ok).toBe(false);
  });
});

describe('cemsInstant', () => {
  it.each([
    ['2026-09-15T13:00:00', '2026-09-15T13:00:00Z'],
    ['2026-09-17T12:50:19.784825', '2026-09-17T12:50:19.784Z'],
    ['2026-09-17T12:50:19.000000', '2026-09-17T12:50:19Z'],
    ['2026-09-17T12:50:19.5', '2026-09-17T12:50:19.500Z'],
    ['2026-09-17T12:50:19Z', '2026-09-17T12:50:19Z'],
    ['2026-09-17T12:50:19+00:00', '2026-09-17T12:50:19Z'],
  ])('reads %s as UTC', (raw, iso) => {
    expect(cemsInstant(raw)).toBe(iso);
  });

  it.each(['2026-09-17T12:50:19+02:00', '2026-09-17', '2026-13-40T99:00:00', 17, null])(
    'refuses %s',
    (raw) => {
      expect(cemsInstant(raw)).toBeNull();
    },
  );
});

describe('WKT', () => {
  it('reads a point in lon/lat order', () => {
    expect(parseWktPoint('POINT (23.416672 41.721618)')).toEqual([23.416672, 41.721618]);
    expect(parseWktPoint('POINT(1e1 -2.5)')).toEqual([10, -2.5]);
    expect(parseWktPoint('POINT (200 0)')).toBeNull();
    expect(parseWktPoint('POINT (1)')).toBeNull();
  });

  it('boxes a multipolygon over all its parts', () => {
    expect(wktBox('MULTIPOLYGON (((1 1, 2 1, 2 2, 1 1)), ((5 -3, 6 -3, 6 -2, 5 -3)))')).toEqual([
      1, -3, 6, 2,
    ]);
    expect(wktBox('POLYGON ((1 1 0, 2 1 0, 2 2 0, 1 1 0))')).toEqual([1, 1, 2, 2]);
    expect(wktBox('POLYGON EMPTY')).toBeNull();
    expect(wktBox('POLYGON ((1 x, 2 1))')).toBeNull();
  });
});

describe('coverage', () => {
  const entries = [...listEntries(CEMS_LIST_PAGE_0), ...listEntries(CEMS_LIST_PAGE_50)];
  const byCode = (code: string) => entries.find((e) => e.code === code)!;

  it('reads the detail of activations centred near coverage, not far from it', () => {
    expect(isCemsCandidate(byCode('EMSR822'), COVERAGE)).toBe(true);
    // Brač, Croatia: 16.5°E, three degrees west of the box.
    expect(isCemsCandidate(byCode('EMSR931'), COVERAGE)).toBe(false);
    // Montenegro, 18.9°E: outside the box, inside the 100 km buffer.
    expect(isCemsCandidate(byCode('EMSR922'), COVERAGE)).toBe(true);
    expect(isCemsCandidate(byCode('EMSR932'), COVERAGE)).toBe(false);
  });

  it('keeps an activation whose centroid is outside but an AOI reaches in', () => {
    const outside: readonly [number, number] = [19.5, 42.5];
    expect(isCemsInCoverage(outside, [], COVERAGE)).toBe(false);
    expect(isCemsInCoverage(outside, [[19.8, 42.4, 20.1, 42.6]], COVERAGE)).toBe(true);
    expect(isCemsInCoverage(outside, [[19.5, 42.4, 19.9, 42.6]], COVERAGE)).toBe(false);
    expect(isCemsInCoverage([23.416672, 41.721618], [], COVERAGE)).toBe(true);
  });
});
