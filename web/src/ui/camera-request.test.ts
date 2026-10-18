import { afterEach, describe, expect, it } from 'vitest';

import { cameraRequest, requestCamera } from './camera-request.js';

afterEach(() => {
  cameraRequest.value = null;
});

describe('requestCamera', () => {
  it('starts with no request', () => {
    expect(cameraRequest.value).toBeNull();
  });

  it('publishes the camera it was given', () => {
    requestCamera({ zoom: 9, lat: 42.7, lon: 23.3 });
    expect(cameraRequest.value).toEqual({ camera: { zoom: 9, lat: 42.7, lon: 23.3 } });
  });

  it('makes a new request object each time, so the same place flies twice', () => {
    const camera = { zoom: 9, lat: 42.7, lon: 23.3 };
    requestCamera(camera);
    const first = cameraRequest.value;
    requestCamera(camera);
    expect(cameraRequest.value).not.toBe(first);
    expect(cameraRequest.value).toEqual(first);
  });
});
