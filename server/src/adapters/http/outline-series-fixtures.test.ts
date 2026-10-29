/**
 * The web's committed outline-series fixtures (V3-P3), drawn by the server's own code from
 * the committed detection fixtures, so fixture mode shows what live mode would for the same
 * pixels. Regenerate with
 * `pnpm exec vitest run --project unit -u server/src/adapters/http/outline-series-fixtures.test.ts`.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { FIRE_OUTLINE_PARAMS } from '../../core/config/fire-outline.js';
import { canonicalJson } from '../../core/determinism/canonical-json.js';
import { buildOutlineSeries, type SeriesDetection } from '../../core/outlines/series.js';
import { epochMsFromIso, type EpochMs } from '../../core/ports/clock.js';
import { outlineSeriesDocument } from './outline-series-route.js';

const FIXTURES = '../../../../web/public/fixtures';
const DETECTIONS_DIR = fileURLToPath(new URL(`${FIXTURES}/detections/`, import.meta.url));

interface DetectionFixture {
  readonly event_id: string;
  readonly merged_into?: string | null;
  readonly truncated?: boolean;
  readonly features: readonly {
    readonly geometry: { readonly coordinates: readonly [number, number] };
    readonly properties: {
      readonly uid: string;
      readonly observed_at: string;
      readonly source_id: string;
      readonly scan_km?: number;
      readonly track_km?: number;
    };
  }[];
}

function detections(fixture: DetectionFixture): SeriesDetection[] {
  return fixture.features.map(({ geometry, properties }) => ({
    uid: properties.uid,
    sourceId: properties.source_id,
    lon: geometry.coordinates[0],
    lat: geometry.coordinates[1],
    scanKm: properties.scan_km ?? null,
    trackKm: properties.track_km ?? null,
    observedAt: epochMsFromIso(properties.observed_at),
  }));
}

const files = readdirSync(DETECTIONS_DIR)
  .filter((name) => name.endsWith('.json'))
  .toSorted();

describe('web outline-series fixtures', () => {
  it('covers every detection fixture', () => {
    expect(files.length).toBeGreaterThan(0);
  });

  it.each(files)('%s is the series the route would serve', async (name) => {
    const fixture = JSON.parse(
      readFileSync(`${DETECTIONS_DIR}${name}`, 'utf8'),
    ) as DetectionFixture;
    const members = detections(fixture);
    // Dated by the newest member, so the file does not change with the day it was drawn.
    const generatedAt = members.reduce<EpochMs>(
      (latest, d) => (d.observedAt > latest ? d.observedAt : latest),
      epochMsFromIso('2026-01-01T00:00:00Z'),
    );
    const mergedInto = fixture.merged_into ?? null;
    const document = outlineSeriesDocument({
      eventId: fixture.event_id,
      mergedInto,
      paramsVersion: FIRE_OUTLINE_PARAMS.version,
      generatedAt,
      truncated: fixture.truncated ?? false,
      series:
        mergedInto === null
          ? buildOutlineSeries(members, FIRE_OUTLINE_PARAMS.values)
          : { points: [], thinned: false },
    });
    await expect(`${canonicalJson(document)}\n`).toMatchFileSnapshot(
      `${FIXTURES}/outline-series/${name}`,
    );
  });
});
