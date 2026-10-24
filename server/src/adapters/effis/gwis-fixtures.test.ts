/**
 * The A2.2 sanity verdict over the real GWIS `ecmwf.fwi` rasters recorded for V2-B1: a
 * forecast day inside the horizon is cached as good, and the fully transparent answer
 * GWIS gives past it is suspect — never a "no danger" map.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { EFFIS_LAYERS } from '../../core/config/effis-layers.js';
import { checkContentSanity } from '../../core/effis/content-sanity.js';
import { zlibInflate } from './zlib-inflate.js';

const FIXTURES = join(import.meta.dirname, '__fixtures__/v2-b1');

const FORECAST_SPEC = EFFIS_LAYERS.values.layers.find((layer) => layer.id === 'fwi-d5');

function verdict(file: string): ReturnType<typeof checkContentSanity> {
  if (FORECAST_SPEC === undefined) throw new Error('fwi-d5 is not configured');
  return checkContentSanity(
    { status: 200, contentType: 'image/png', body: readFileSync(join(FIXTURES, file)) },
    {
      acceptedMediaTypes: FORECAST_SPEC.acceptedMediaTypes,
      byteFloorBytes: FORECAST_SPEC.byteFloorBytes,
      raster: { width: EFFIS_LAYERS.values.wmsWidth, height: EFFIS_LAYERS.values.wmsHeight },
    },
    zlibInflate,
  );
}

describe('GWIS ecmwf.fwi fixtures (V2-B1)', () => {
  it('a forecast day inside the horizon is good', () => {
    expect(verdict('gwis-fwi-forecast.png').verdict).toBe('good');
  });

  it('the blank past-horizon raster is suspect, not good', () => {
    const check = verdict('gwis-fwi-beyond-horizon.png');
    expect(check.verdict).toBe('suspect');
    expect(check.rule).toBe('png_fully_transparent');
  });
});
