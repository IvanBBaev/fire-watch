/**
 * The imagery toggle's state (TASKS G6): offered only while the server hands out handles,
 * off on every visit until the reader asks, and dropped — never resurrected — when the
 * server withdraws the handles.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ImageryHandles } from '../core/imagery/index.js';

import type * as ImageryModule from './imagery.js';

const HANDLES: ImageryHandles = {
  tileUrlTemplate: 'https://tiles.example/{z}/{x}/{y}.png',
  apiKey: 'k1',
};

let imagery: typeof ImageryModule;

beforeEach(async () => {
  // The signals are module state; each test starts from a fresh visit.
  vi.resetModules();
  imagery = await import('./imagery.js');
});

describe('imagery state', () => {
  it('offers nothing and draws nothing before the server has spoken', () => {
    expect(imagery.imageryOffered.value).toBe(false);
    expect(imagery.imageryOn.value).toBe(false);
    expect(imagery.imageryTilesUrl.value).toBeNull();
  });

  it('ignores a toggle while nothing is offered', () => {
    imagery.toggleImagery();
    imagery.setImageryHandles(HANDLES);
    expect(imagery.imageryOn.value).toBe(false);
  });

  it('offers the toggle switched off, and draws only once the reader turns it on', () => {
    imagery.setImageryHandles(HANDLES);
    expect(imagery.imageryOffered.value).toBe(true);
    expect(imagery.imageryOn.value).toBe(false);
    expect(imagery.imageryTilesUrl.value).toBeNull();

    imagery.toggleImagery();
    expect(imagery.imageryOn.value).toBe(true);
    expect(imagery.imageryTilesUrl.value).toBe('https://tiles.example/{z}/{x}/{y}.png?token=k1');

    imagery.toggleImagery();
    expect(imagery.imageryOn.value).toBe(false);
    expect(imagery.imageryTilesUrl.value).toBeNull();
  });

  it('drops the choice with withdrawn handles, so a re-offer comes back switched off', () => {
    imagery.setImageryHandles(HANDLES);
    imagery.toggleImagery();
    imagery.setImageryHandles(null);
    expect(imagery.imageryOffered.value).toBe(false);
    expect(imagery.imageryTilesUrl.value).toBeNull();

    imagery.setImageryHandles(HANDLES);
    expect(imagery.imageryOffered.value).toBe(true);
    expect(imagery.imageryOn.value).toBe(false);
  });

  it('keeps the choice across a refresh that hands out equal handles', () => {
    imagery.setImageryHandles(HANDLES);
    imagery.toggleImagery();
    imagery.setImageryHandles({ ...HANDLES });
    expect(imagery.imageryOn.value).toBe(true);
  });

  it('follows a rotated key without switching the layer off', () => {
    imagery.setImageryHandles(HANDLES);
    imagery.toggleImagery();
    imagery.setImageryHandles({ ...HANDLES, apiKey: 'k2' });
    expect(imagery.imageryOn.value).toBe(true);
    expect(imagery.imageryTilesUrl.value).toBe('https://tiles.example/{z}/{x}/{y}.png?token=k2');
  });
});
