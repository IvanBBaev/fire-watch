/**
 * The shared camera: the remembered frame outranks the default, the location offer is made
 * only when neither a `#map=` link nor a remembered frame has decided where to look, and a
 * settled frame reaches both the list (the signal) and the next visit (storage).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { CAMERA_STORAGE_KEY } from '../core/geo/camera.js';
import type { MapViewport } from '../core/geo/viewport.js';

import type * as MapCameraModule from './map-camera.js';

const VIEWPORT: MapViewport = {
  west: 22,
  south: 41,
  east: 24,
  north: 43,
  zoom: 7.26,
  lat: 42.123456,
  lon: 23.654321,
};

let data: Map<string, string>;
let camera: typeof MapCameraModule;

beforeEach(async () => {
  data = new Map();
  vi.stubGlobal('window', {
    localStorage: {
      getItem: (key: string) => data.get(key) ?? null,
      setItem: (key: string, value: string) => void data.set(key, value),
    },
  });
  vi.resetModules();
  camera = await import('./map-camera.js');
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('map camera', () => {
  it('starts the list unfiltered: no frame until the map reports one', () => {
    expect(camera.mapViewport.value).toBeNull();
  });

  it('opens on the home frame when nothing is remembered', () => {
    expect(camera.initialCamera()).toEqual(camera.HOME_CAMERA);
  });

  it('opens on the remembered frame', () => {
    data.set(CAMERA_STORAGE_KEY, JSON.stringify({ zoom: 9, lat: 43.2, lon: 27.9 }));
    expect(camera.initialCamera()).toEqual({ zoom: 9, lat: 43.2, lon: 27.9 });
  });

  it('falls back to the home frame over an unreadable remembered value', () => {
    data.set(CAMERA_STORAGE_KEY, '{"zoom":');
    expect(camera.initialCamera()).toEqual(camera.HOME_CAMERA);
  });

  it('publishes a settled frame to the list and remembers it, rounded, for the next visit', () => {
    camera.publishViewport(VIEWPORT);
    expect(camera.mapViewport.value).toBe(VIEWPORT);
    expect(camera.initialCamera()).toEqual({ zoom: 7.3, lat: 42.1235, lon: 23.6543 });
  });
});
