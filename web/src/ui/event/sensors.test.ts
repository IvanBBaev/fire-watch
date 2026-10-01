import { SOURCE_IDS, SOURCE_REGISTRY } from '@fire-watch/contracts';
import { describe, expect, it } from 'vitest';

import { SENSORS, isKnownSource, pixelSize, sensorOrder } from './sensors.js';

describe('SENSORS', () => {
  it('covers exactly the frozen source-id registry', () => {
    expect(Object.keys(SENSORS).toSorted()).toEqual([...SOURCE_IDS].toSorted());
  });

  it('marks the GEO product tier as geostationary and nothing else', () => {
    for (const id of SOURCE_IDS) {
      const geo = SOURCE_REGISTRY[id].productTier === 'GEO';
      expect(SENSORS[id].orbit === 'geostationary', id).toBe(geo);
    }
  });

  it('transcribes GLOSSARY §1a pixel sizes', () => {
    expect(pixelSize(SENSORS['firms:viirs:snpp'])).toEqual({
      unit: 'm',
      min: 375,
      max: 375,
      approximate: false,
    });
    expect(pixelSize(SENSORS['eumetsat:slstr:frp'])).toEqual({
      unit: 'km',
      min: 1,
      max: 1,
      approximate: false,
    });
    expect(pixelSize(SENSORS['lsasaf:seviri:frp-pixel'])).toEqual({
      unit: 'km',
      min: 4,
      max: 4,
      approximate: true,
    });
    expect(pixelSize(SENSORS['lsasaf:fci:frp-pixel'])).toEqual({
      unit: 'km',
      min: 3,
      max: 4.5,
      approximate: true,
    });
  });
});

describe('isKnownSource / sensorOrder', () => {
  it('recognises registry ids only', () => {
    expect(isKnownSource('firms:viirs:noaa21')).toBe(true);
    expect(isKnownSource('firms:goes')).toBe(false);
    expect(isKnownSource('toString')).toBe(false);
  });

  it('orders by registry position with unknown ids last', () => {
    expect(sensorOrder('firms:viirs:snpp')).toBeLessThan(sensorOrder('lsasaf:seviri:frp-pixel'));
    expect(sensorOrder('unknown')).toBe(Object.keys(SENSORS).length);
  });
});
