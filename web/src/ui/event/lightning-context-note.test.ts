/**
 * The F18 lightning context note: what it reads from the route's body, the sentence for
 * each answer, and that the fixtures (synthetic, not real LI data) cover every event the
 * fixture snapshot can open — a missing file would be a 404 in the console on that page.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { DEFAULT_CONFIG } from '../../core/config.js';
import bg from '../../core/i18n/bg.js';
import en from '../../core/i18n/en.js';
import {
  lightningContextText,
  lightningContextUrl,
  parseLightningContext,
} from './lightning-context-note.js';

const fixtures = fileURLToPath(new URL('../../../public/fixtures/', import.meta.url));

const complete = {
  schema_version: 1,
  status: 'complete',
  radius_km: 10,
  window_hours: 3,
  flash_count: 4,
  nearest_km: 5.6,
};

describe('parseLightningContext', () => {
  it('reads a count with its nearest distance', () => {
    expect(parseLightningContext(complete)).toEqual({
      status: 'complete',
      radiusKm: 10,
      windowHours: 3,
      flashCount: 4,
      nearestKm: 5.6,
    });
  });

  it('reads pending and no_data without a count', () => {
    expect(parseLightningContext({ schema_version: 1, status: 'pending' })).toEqual({
      status: 'pending',
    });
    expect(parseLightningContext({ schema_version: 1, status: 'no_data', flash_count: 0 })).toEqual(
      { status: 'no_data' },
    );
  });

  it('refuses what it cannot read rather than guessing a zero', () => {
    expect(parseLightningContext(null)).toBeNull();
    expect(parseLightningContext({ ...complete, schema_version: 2 })).toBeNull();
    expect(parseLightningContext({ ...complete, status: 'maybe' })).toBeNull();
    expect(parseLightningContext({ ...complete, flash_count: undefined })).toBeNull();
    expect(parseLightningContext({ ...complete, flash_count: -1 })).toBeNull();
    expect(parseLightningContext({ ...complete, nearest_km: undefined })).toBeNull();
    expect(parseLightningContext({ ...complete, radius_km: 0 })).toBeNull();
  });
});

describe('lightningContextText', () => {
  it('keeps "no data" apart from "no lightning"', () => {
    const none = lightningContextText(
      { status: 'complete', radiusKm: 10, windowHours: 3, flashCount: 0, nearestKm: null },
      en.eventDetail,
    );
    const noData = lightningContextText({ status: 'no_data' }, en.eventDetail);
    expect(none).toContain('no flashes were recorded');
    expect(none).toContain('does not rule lightning out');
    expect(noData).toBe(en.eventDetail.lightningContextNoData);
    expect(lightningContextText({ status: 'pending' }, en.eventDetail)).toBe(noData);
    expect(noData).not.toMatch(/\d/);
  });

  it('gives a count and a distance, and says it is not a cause, in both locales', () => {
    const context = {
      status: 'complete',
      radiusKm: 10,
      windowHours: 3,
      flashCount: 4,
      nearestKm: 5.6,
    } as const;
    expect(lightningContextText(context, en.eventDetail)).toBe(
      'Lightning context: 4 flashes were recorded within 10 km in the 3 hours before the first detection, the nearest 5.6 km away. Context only: it does not mean lightning started this fire.',
    );
    expect(lightningContextText(context, bg.eventDetail)).toContain('5,6 км');
    expect(lightningContextText(context, bg.eventDetail)).toContain('не означава');
    expect(lightningContextText({ ...context, flashCount: 1 }, en.eventDetail)).toContain(
      '1 flash was recorded',
    );
  });
});

describe('lightningContextUrl', () => {
  it('fills the template, and is null without one', () => {
    expect(lightningContextUrl(DEFAULT_CONFIG.lightningContextUrlTemplate, 'fw-2026-b2n5c')).toBe(
      '/fixtures/lightning-context/fw-2026-b2n5c.json',
    );
    expect(lightningContextUrl(undefined, 'fw-2026-b2n5c')).toBeNull();
  });
});

describe('the lightning context fixtures', () => {
  it('cover every event the fixture snapshot can open, and all parse', () => {
    const snapshot = JSON.parse(readFileSync(`${fixtures}snapshot.json`, 'utf8')) as {
      features: { properties: { id: string; merged_into: string | null } }[];
    };
    const open = snapshot.features
      .map((f) => f.properties)
      .filter((p) => p.merged_into === null)
      .map((p) => `${p.id}.json`)
      .sort();
    const files = readdirSync(`${fixtures}lightning-context`).sort();
    expect(files).toEqual(open);
    const statuses = new Set<string>();
    for (const file of files) {
      const body = JSON.parse(
        readFileSync(`${fixtures}lightning-context/${file}`, 'utf8'),
      ) as unknown;
      const parsed = parseLightningContext(body);
      expect(parsed, file).not.toBeNull();
      if (parsed !== null) statuses.add(parsed.status);
    }
    expect([...statuses].sort()).toEqual(['complete', 'no_data', 'pending']);
  });
});
