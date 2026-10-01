import { describe, expect, it } from 'vitest';

import { geolocationAlreadyGranted } from './location-permission.js';

const permissions = (state: string) => ({
  query: () => Promise.resolve({ state }),
});

describe('geolocationAlreadyGranted', () => {
  it('is true only for granted', async () => {
    await expect(geolocationAlreadyGranted(permissions('granted'))).resolves.toBe(true);
    await expect(geolocationAlreadyGranted(permissions('prompt'))).resolves.toBe(false);
    await expect(geolocationAlreadyGranted(permissions('denied'))).resolves.toBe(false);
  });

  it('answers false without the Permissions API or when the query throws', async () => {
    await expect(geolocationAlreadyGranted(undefined)).resolves.toBe(false);
    await expect(
      geolocationAlreadyGranted({ query: () => Promise.reject(new TypeError('unknown name')) }),
    ).resolves.toBe(false);
  });
});
