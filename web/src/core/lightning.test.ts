/**
 * F18, the pure half: the body parser refuses what it cannot draw honestly, and the age
 * classes are decided against the reader's clock, not against the copy.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  LIGHTNING_MAX_AGE_MS,
  lightningAgeClass,
  lightningForDisplay,
  parseLightningOverlay,
  type LightningOverlayBody,
} from './lightning.js';

const MINUTE = 60_000;
const THROUGH = '2026-09-30T12:30:09Z';
const THROUGH_MS = Date.parse(THROUGH);

function body(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schema_version: 1,
    source: 'eumetsat:mtg-li:lfl',
    covered_from: '2026-09-30T06:30:09Z',
    covered_through: THROUGH,
    available_at: '2026-09-30T12:30:49Z',
    products: 36,
    retention_hours: 6,
    flashes: [
      { t: '2026-09-30T12:25:09.000Z', lat: 42.5, lon: 24.1 },
      { t: '2026-09-30T11:50:00.000Z', lat: 42.6, lon: 24.2 },
      { t: '2026-09-30T08:00:00.000Z', lat: 42.7, lon: 24.3 },
    ],
    attribution: [
      {
        id: 'eumetsat-meteosat',
        source: 'EUMETSAT',
        text: 'Contains modified EUMETSAT Meteosat data 2026',
      },
    ],
    ...overrides,
  };
}

describe('parseLightningOverlay', () => {
  it('accepts the served shape', () => {
    expect(parseLightningOverlay(body())).not.toBeNull();
    expect(parseLightningOverlay(body({ flashes: [] }))).not.toBeNull();
  });

  it.each([
    ['a non-object', null],
    ['another schema', body({ schema_version: 2 })],
    ['another source', body({ source: 'blitzortung' })],
    ['an unreadable covered_through', body({ covered_through: 'yesterday' })],
    ['a window running backwards', body({ covered_from: '2026-09-30T13:00:00Z' })],
    ['a fractional product count', body({ products: 1.5 })],
    ['a zero retention', body({ retention_hours: 0 })],
    ['a flash with no time', body({ flashes: [{ lat: 42, lon: 24 }] })],
    ['a flash off the globe', body({ flashes: [{ t: THROUGH, lat: 95, lon: 24 }] })],
    ['a non-numeric longitude', body({ flashes: [{ t: THROUGH, lat: 42, lon: '24' }] })],
    ['a malformed attribution', body({ attribution: [{ id: 'x' }] })],
  ])('refuses %s', (_label, value) => {
    expect(parseLightningOverlay(value)).toBeNull();
  });
});

describe('lightningAgeClass', () => {
  it('classes by < 15 min, < 1 h and < 6 h, and drops older flashes', () => {
    expect(lightningAgeClass(0)).toBe(0);
    expect(lightningAgeClass(15 * MINUTE - 1)).toBe(0);
    expect(lightningAgeClass(15 * MINUTE)).toBe(1);
    expect(lightningAgeClass(60 * MINUTE - 1)).toBe(1);
    expect(lightningAgeClass(60 * MINUTE)).toBe(2);
    expect(lightningAgeClass(LIGHTNING_MAX_AGE_MS - 1)).toBe(2);
    expect(lightningAgeClass(LIGHTNING_MAX_AGE_MS)).toBeNull();
  });

  it('treats a flash stamped slightly ahead of the clock as the newest class', () => {
    expect(lightningAgeClass(-30_000)).toBe(0);
  });
});

describe('lightningForDisplay', () => {
  const parsed = parseLightningOverlay(body()) as LightningOverlayBody;

  it('classes every flash against now and paints the newest on top', () => {
    const display = lightningForDisplay(parsed, THROUGH_MS);
    expect(display.counts).toEqual([1, 1, 1]);
    expect(display.collection.features.map((f) => f.properties.ageClass)).toEqual([2, 1, 0]);
    expect(display.collection.features[2]?.geometry.coordinates).toEqual([24.1, 42.5]);
    expect(display.coveredThrough).toBe(THROUGH);
  });

  it('ages a held copy on screen instead of keeping its newest flashes new', () => {
    const later = lightningForDisplay(parsed, THROUGH_MS + 45 * MINUTE);
    expect(later.counts).toEqual([0, 1, 2]);
    const muchLater = lightningForDisplay(parsed, THROUGH_MS + 7 * 60 * MINUTE);
    expect(muchLater.counts).toEqual([0, 0, 0]);
    expect(muchLater.collection.features).toEqual([]);
  });
});

describe('the committed fixture (web/public/fixtures/lightning/recent.json)', () => {
  const raw: unknown = JSON.parse(
    readFileSync(
      fileURLToPath(new URL('../../public/fixtures/lightning/recent.json', import.meta.url)),
      'utf8',
    ),
  );

  it('parses, credits EUMETSAT and draws all three age classes at its own moment', () => {
    const fixture = parseLightningOverlay(raw);
    expect(fixture).not.toBeNull();
    const parsed = fixture as LightningOverlayBody;
    expect(parsed.attribution.map((entry) => entry.id)).toEqual(['eumetsat-meteosat']);
    const display = lightningForDisplay(parsed, Date.parse(parsed.covered_through));
    expect(display.counts.every((count) => count > 0)).toBe(true);
    expect(display.collection.features).toHaveLength(parsed.flashes.length);
  });
});
