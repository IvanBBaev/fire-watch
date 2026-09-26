import { describe, expect, it } from 'vitest';

import {
  CAMERA_HASH_MEMBER_PREFIX,
  CAMERA_STORAGE_KEY,
  hasCameraHash,
  isPlausibleCamera,
  parseCamera,
  roundCamera,
  serializeCamera,
} from './camera.js';

describe('isPlausibleCamera', () => {
  it('accepts a camera anywhere on the globe, coverage notwithstanding', () => {
    expect(isPlausibleCamera({ zoom: 7.2, lat: 42.7, lon: 25.3 })).toBe(true);
    expect(isPlausibleCamera({ zoom: 3, lat: -33.87, lon: 151.21 })).toBe(true);
  });

  it('accepts the exact edges of every range', () => {
    expect(isPlausibleCamera({ zoom: 0, lat: 90, lon: -180 })).toBe(true);
    expect(isPlausibleCamera({ zoom: 24, lat: -90, lon: 180 })).toBe(true);
  });

  it('rejects out-of-range values', () => {
    expect(isPlausibleCamera({ zoom: -0.1, lat: 42, lon: 25 })).toBe(false);
    expect(isPlausibleCamera({ zoom: 24.1, lat: 42, lon: 25 })).toBe(false);
    expect(isPlausibleCamera({ zoom: 7, lat: 90.1, lon: 25 })).toBe(false);
    expect(isPlausibleCamera({ zoom: 7, lat: -90.1, lon: 25 })).toBe(false);
    expect(isPlausibleCamera({ zoom: 7, lat: 42, lon: 180.1 })).toBe(false);
    expect(isPlausibleCamera({ zoom: 7, lat: 42, lon: -180.1 })).toBe(false);
  });

  it('rejects non-finite values, which no range check on its own would catch', () => {
    expect(isPlausibleCamera({ zoom: Number.NaN, lat: 42, lon: 25 })).toBe(false);
    expect(isPlausibleCamera({ zoom: 7, lat: Number.POSITIVE_INFINITY, lon: 25 })).toBe(false);
    expect(isPlausibleCamera({ zoom: 7, lat: 42, lon: Number.NaN })).toBe(false);
  });
});

describe('roundCamera', () => {
  it('caps the stored precision so a centre is a viewport, not a doorstep', () => {
    expect(roundCamera({ zoom: 11.4638, lat: 42.6977123, lon: 23.3218456 })).toEqual({
      zoom: 11.5,
      lat: 42.6977,
      lon: 23.3218,
    });
  });

  it('leaves an already-rounded camera untouched', () => {
    const camera = { zoom: 7.2, lat: 42.7, lon: 25.3 };
    expect(roundCamera(camera)).toEqual(camera);
  });
});

describe('hasCameraHash', () => {
  it('sees the member with or without the leading hash, and among others', () => {
    expect(hasCameraHash('#map=7.2/42.7/25.3')).toBe(true);
    expect(hasCameraHash('map=7.2/42.7/25.3')).toBe(true);
    expect(hasCameraHash('#foo=bar&map=7.2/42.7/25.3')).toBe(true);
  });

  it('is false for an empty or unrelated fragment', () => {
    expect(hasCameraHash('')).toBe(false);
    expect(hasCameraHash('#')).toBe(false);
    expect(hasCameraHash('#panel=open')).toBe(false);
  });

  it('does not mistake a member that merely contains the prefix', () => {
    expect(hasCameraHash('#sitemap=7.2/42.7/25.3')).toBe(false);
  });
});

describe('serializeCamera / parseCamera', () => {
  it('round-trips a camera at stored precision', () => {
    const camera = { zoom: 9, lat: 41.9285, lon: 25.897 };
    expect(parseCamera(serializeCamera(camera))).toEqual(camera);
  });

  it('rounds on the way out, so what is written is what comes back', () => {
    const parsed = parseCamera(serializeCamera({ zoom: 9.04, lat: 41.92849, lon: 25.897012 }));
    expect(parsed).toEqual({ zoom: 9, lat: 41.9285, lon: 25.897 });
  });

  it('answers null for a missing key rather than inventing a view', () => {
    expect(parseCamera(null)).toBeNull();
  });

  it('answers null for anything malformed, so a bad value never breaks boot', () => {
    expect(parseCamera('')).toBeNull();
    expect(parseCamera('not json')).toBeNull();
    expect(parseCamera('null')).toBeNull();
    expect(parseCamera('42')).toBeNull();
    expect(parseCamera('[7.2, 42.7, 25.3]')).toBeNull();
    expect(parseCamera('{"zoom":7.2,"lat":42.7}')).toBeNull();
    expect(parseCamera('{"zoom":"7.2","lat":42.7,"lon":25.3}')).toBeNull();
    expect(parseCamera('{"zoom":7.2,"lat":42.7,"lon":25.3')).toBeNull();
  });

  it('answers null for a value that parses but could not be a camera', () => {
    expect(parseCamera('{"zoom":99,"lat":42.7,"lon":25.3}')).toBeNull();
    expect(parseCamera('{"zoom":7.2,"lat":420,"lon":25.3}')).toBeNull();
  });
});

describe('shared literals', () => {
  it('keeps the hash member and storage key stable — both are user-visible state', () => {
    expect(CAMERA_HASH_MEMBER_PREFIX).toBe('map=');
    expect(CAMERA_STORAGE_KEY).toBe('fw.map-camera');
  });
});
