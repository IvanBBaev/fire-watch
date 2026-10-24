import { afterEach, describe, expect, it } from 'vitest';

import bg from '../core/i18n/bg.js';
import en from '../core/i18n/en.js';
import { layersPanelOpen, setLayersPanelOpen } from './layers.js';
import { lengthText, resultText } from './measure-panel.js';
import {
  measureOverlay,
  measurePanelOpen,
  resetMeasureForTest,
  setMeasurePanelOpen,
} from './measure-state.js';

const noPlaces = new Map<string, string>();

describe('measure panel wording (V2-D3)', () => {
  it('words short lengths in metres and longer ones in kilometres', () => {
    expect(lengthText(460, en, 'en')).toMatch(/460/);
    expect(lengthText(460, en, 'en')).toMatch(/m\b/);
    expect(lengthText(12_400, en, 'en')).toMatch(/km/);
    expect(lengthText(12_400, bg, 'bg')).toMatch(/км/);
  });

  it('asks for more points until the shape has an answer', () => {
    expect(resultText({ kind: 'needPoints', mode: 'area' }, noPlaces, en, 'en')).toBe(
      en.measure.hint.area,
    );
  });

  it('reads distance, area and the nearest fire', () => {
    expect(resultText({ kind: 'distance', meters: 1_500 }, noPlaces, en, 'en')).toMatch(
      /^Distance: /,
    );
    const area = resultText(
      { kind: 'area', hectares: 12, perimeterMeters: 1_400 },
      noPlaces,
      en,
      'en',
    );
    expect(area).toContain(en.areaBothUnits(12));
    expect(area).toContain('perimeter');
    const nearest = resultText(
      { kind: 'nearest', meters: 3_000, target: { id: 'e1', lon: 25, lat: 42 } },
      new Map([['e1', 'Haskovo']]),
      bg,
      'bg',
    );
    expect(nearest).toContain('Haskovo');
    expect(resultText({ kind: 'nearestNone' }, noPlaces, en, 'en')).toBe(en.measure.nearestNone);
  });
});

describe('measure panel state (V2-D3)', () => {
  afterEach(() => {
    resetMeasureForTest();
    setLayersPanelOpen(false);
  });

  it('opening measure closes Layers, and opening Layers closes measure', () => {
    setLayersPanelOpen(true);
    setMeasurePanelOpen(true);
    expect(layersPanelOpen.value).toBe(false);
    expect(measurePanelOpen.value).toBe(true);

    setLayersPanelOpen(true);
    expect(measurePanelOpen.value).toBe(false);
  });

  it('closing drops the drawing', () => {
    setMeasurePanelOpen(true);
    measureOverlay.value = {
      collection: { type: 'FeatureCollection', features: [] },
      onPick: () => undefined,
    };
    setMeasurePanelOpen(false);
    expect(measureOverlay.value).toBeNull();
  });
});
