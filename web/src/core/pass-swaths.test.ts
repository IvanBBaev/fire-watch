/**
 * F15, the pure half: the swath document's validation and the reader-clock re-decision of
 * "recent" and "next", against the committed fixture (real SGP4 output for one moment).
 */

import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { parseColor } from './color/color.js';
import {
  PASS_NEXT_COLOR,
  PASS_RECENT_COLOR,
  SWATH_RECENT_MS,
  kindAt,
  parsePassSwaths,
  platformShortName,
  swathsForDisplay,
  type PassSwathsDoc,
} from './pass-swaths.js';

const RAW: unknown = JSON.parse(
  readFileSync(new URL('../../public/fixtures/passes/swaths.json', import.meta.url), 'utf8'),
);
const MINUTE_MS = 60_000;
const HOUR_MS = 3_600_000;
const hhmm = (iso: string): string => iso.slice(11, 16);

function fixture(): PassSwathsDoc {
  const doc = parsePassSwaths(RAW);
  if (doc === null) throw new Error('the committed swath fixture no longer parses');
  return doc;
}

const clone = (): Record<string, unknown> =>
  JSON.parse(JSON.stringify(RAW)) as Record<string, unknown>;

describe('parsePassSwaths', () => {
  it('accepts the committed fixture, a prediction from CelesTrak elements', () => {
    const doc = fixture();
    expect(doc.predicted).toBe(true);
    expect(doc.elements_provider).toBe('celestrak');
    expect(doc.features.length).toBeGreaterThan(0);
    expect(new Set(doc.features.map((f) => f.properties.part))).toEqual(
      new Set(['swath', 'track', 'label']),
    );
  });

  it.each([
    ['a body that is not a prediction', (d: Record<string, unknown>) => (d['predicted'] = false)],
    ['another schema version', (d: Record<string, unknown>) => (d['schema_version'] = 2)],
    ['another elements provider', (d: Record<string, unknown>) => (d['elements_provider'] = 'x')],
    ['a window without an end', (d: Record<string, unknown>) => (d['window'] = { from: 'x' })],
    [
      'an unknown platform',
      (d: Record<string, unknown>) => {
        (d['features'] as { properties: { platform: string } }[])[0]!.properties.platform = 'goes';
      },
    ],
    [
      'a swath that is not a polygon',
      (d: Record<string, unknown>) => {
        const features = d['features'] as { properties: { part: string }; geometry: unknown }[];
        const swath = features.find((f) => f.properties.part === 'swath')!;
        swath.geometry = { type: 'Point', coordinates: [25, 42] };
      },
    ],
  ])('refuses %s', (_, spoil) => {
    const body = clone();
    spoil(body);
    expect(parsePassSwaths(body)).toBeNull();
  });

  it('refuses what is not a feature collection at all', () => {
    expect(parsePassSwaths(null)).toBeNull();
    expect(parsePassSwaths([])).toBeNull();
    expect(parsePassSwaths({ type: 'Feature' })).toBeNull();
  });
});

describe('kindAt', () => {
  const now = Date.parse('2026-09-30T12:00:00Z');
  it('is next while the mid-time is ahead (or now), recent for six hours, then nothing', () => {
    expect(kindAt('2026-09-30T12:00:00Z', now)).toBe('next');
    expect(kindAt('2026-09-30T18:00:00Z', now)).toBe('next');
    expect(kindAt('2026-09-30T11:59:00Z', now)).toBe('recent');
    expect(kindAt(new Date(now - SWATH_RECENT_MS).toISOString(), now)).toBe('recent');
    expect(kindAt(new Date(now - SWATH_RECENT_MS - MINUTE_MS).toISOString(), now)).toBeNull();
  });
});

describe('swathsForDisplay', () => {
  it('at the moment it was computed for, agrees with the server’s own tags', () => {
    const doc = fixture();
    const display = swathsForDisplay(doc, Date.parse(doc.computed_for), hhmm);
    expect(display.ended).toBe(false);
    expect(display.collection.features.map((f) => f.properties.kind)).toEqual(
      doc.features.map((f) => f.properties.kind),
    );
    expect(display.passes).toHaveLength(
      doc.features.filter((f) => f.properties.part === 'swath').length,
    );
    const label = display.collection.features[0]!.properties;
    expect(label.label).toBe(`${platformShortName(label.platform)} ${hhmm(label.mid)}`);
  });

  it('re-tags a pass that has flown as recent, never as next, on a later clock', () => {
    const doc = fixture();
    const later = Date.parse(doc.computed_for) + 8 * HOUR_MS;
    const display = swathsForDisplay(doc, later, hhmm);
    for (const pass of display.passes) {
      expect(pass.kind).toBe(Date.parse(pass.mid) >= later ? 'next' : 'recent');
      expect(later - Date.parse(pass.mid)).toBeLessThanOrEqual(SWATH_RECENT_MS);
    }
    // Server "recent" passes more than six hours back are gone altogether.
    const serverRecent = doc.features.filter(
      (f) => f.properties.part === 'swath' && f.properties.kind === 'recent',
    );
    expect(display.passes.length).toBeLessThan(
      doc.features.filter((f) => f.properties.part === 'swath').length,
    );
    expect(serverRecent.length).toBeGreaterThan(0);
  });

  it('draws nothing ahead, and says the window is over, once it is', () => {
    const doc = fixture();
    const after = Date.parse(doc.window.to) + 30 * MINUTE_MS;
    const display = swathsForDisplay(doc, after, hhmm);
    expect(display.ended).toBe(true);
    expect(display.passes.filter((pass) => pass.kind === 'next')).toEqual([]);
    // A day on, nothing at all: yesterday's sky is not drawn.
    const nextDay = swathsForDisplay(doc, after + 24 * HOUR_MS, hhmm);
    expect(nextDay.collection.features).toEqual([]);
  });
});

describe('the swath colours', () => {
  it('are opaque six-digit hex (the legend appends an alpha byte) and distinct', () => {
    for (const color of [PASS_NEXT_COLOR, PASS_RECENT_COLOR]) {
      expect(color).toMatch(/^#[0-9a-f]{6}$/u);
      expect(parseColor(color).a).toBe(1);
    }
    expect(PASS_NEXT_COLOR).not.toBe(PASS_RECENT_COLOR);
  });
});
