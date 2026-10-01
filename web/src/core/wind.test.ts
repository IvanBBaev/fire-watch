/**
 * F14, the pure half: the wind body's validation, the speed classes and the arrows. The
 * committed fixture (`web/public/fixtures/wind/latest.json`) is the server route's real
 * output for the 2026-09-30 00z run, so parsing it is also a wire-compatibility check.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { parseColor } from './color/color.js';
import {
  WIND_SPEED_CLASSES,
  arrowBearingDeg,
  parseWindOverlay,
  windArrows,
  windSpeedClass,
} from './wind.js';

const FIXTURE: unknown = JSON.parse(
  readFileSync(
    fileURLToPath(new URL('../../public/fixtures/wind/latest.json', import.meta.url)),
    'utf8',
  ),
);

function withChange(patch: Record<string, unknown>): unknown {
  return { ...(FIXTURE as Record<string, unknown>), ...patch };
}

describe('parseWindOverlay', () => {
  it('accepts the route output the fixture records', () => {
    const body = parseWindOverlay(FIXTURE);
    expect(body).not.toBeNull();
    expect(body?.grid).toMatchObject({ cols: 23, rows: 15, resolution_deg: 0.5 });
    expect(body?.run_at).toBe('2026-09-30T00:00:00Z');
  });

  it('refuses what it cannot draw honestly', () => {
    const body = FIXTURE as { speed_ms: number[]; direction_from_deg: number[] };
    for (const bad of [
      null,
      'wind',
      withChange({ schema_version: 2 }),
      withChange({ provider: 'open-meteo' }),
      withChange({ valid_at: 'today' }),
      withChange({ run_at: undefined }),
      withChange({ speed_ms: body.speed_ms.slice(1) }),
      withChange({ speed_ms: [-1, ...body.speed_ms.slice(1)] }),
      withChange({ direction_from_deg: [360, ...body.direction_from_deg.slice(1)] }),
      withChange({ grid: { ...(FIXTURE as { grid: object }).grid, order: 'south_to_north' } }),
      withChange({ grid: { ...(FIXTURE as { grid: object }).grid, cols: 0 } }),
    ]) {
      expect(parseWindOverlay(bad)).toBeNull();
    }
  });
});

describe('speed classes', () => {
  it('bins on exclusive upper bounds', () => {
    expect([0, 1.99, 2, 4.99, 5, 8, 10.99, 11, 40].map(windSpeedClass)).toEqual([
      0, 0, 1, 1, 2, 3, 3, 4, 4,
    ]);
  });

  it('are all parseable colours, one per legend row', () => {
    expect(WIND_SPEED_CLASSES).toHaveLength(5);
    for (const entry of WIND_SPEED_CLASSES) expect(() => parseColor(entry.color)).not.toThrow();
  });
});

describe('arrows', () => {
  it('point downwind: a northerly (from 0°) points south', () => {
    expect(arrowBearingDeg(0)).toBe(180);
    expect(arrowBearingDeg(270)).toBe(90);
    expect(arrowBearingDeg(359.5)).toBe(179.5);
  });

  it('are one point per cell, row-major from the north-west corner', () => {
    const body = parseWindOverlay(FIXTURE);
    if (body === null) throw new Error('fixture must parse');
    const { features } = windArrows(body);
    expect(features).toHaveLength(23 * 15);
    expect(features[0]?.geometry.coordinates).toEqual([body.grid.west, body.grid.north]);
    expect(features[1]?.geometry.coordinates).toEqual([body.grid.west + 0.5, body.grid.north]);
    expect(features.at(-1)?.geometry.coordinates).toEqual([body.grid.east, body.grid.south]);
    const first = features[0]?.properties;
    expect(first?.speed).toBe(body.speed_ms[0]);
    expect(first?.bearing).toBe(arrowBearingDeg(body.direction_from_deg[0] ?? 0));
    expect(first?.speedClass).toBe(windSpeedClass(body.speed_ms[0] ?? 0));
  });
});
