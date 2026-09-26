import { describe, expect, it } from 'vitest';

import { formatHex, parseColor } from '../core/color/color.js';
import type { FireClass, StyleLayerLike } from './style-colors.js';
import {
  StyleColorError,
  colorOutputs,
  cvdCollapses,
  evaluate,
  hueViolations,
  isFireHue,
  isFireOwnedLayerId,
  opaqueColors,
  paintedColors,
  patternOutputs,
} from './style-colors.js';

const hexes = (value: unknown): string[] => colorOutputs(value, 'test').map((c) => formatHex(c));

describe('classification', () => {
  it('owns fire by id prefix only', () => {
    expect(isFireOwnedLayerId('fire-dot')).toBe(true);
    expect(isFireOwnedLayerId('alert-zone')).toBe(true);
    expect(isFireOwnedLayerId('detection-dot')).toBe(false);
    expect(isFireOwnedLayerId('wildfire-dot')).toBe(false);
  });

  it.each([
    ['#d7301f', true], // h≈30
    ['#e8590c', true], // h≈42
    ['#ff0000', true], // h≈29
    ['#7db8d8', false], // link blue
  ])('isFireHue(%s)', (hex, expected) => {
    expect(isFireHue(parseColor(hex))).toBe(expected);
  });

  it('respects the chroma floor and the band edges', () => {
    expect(isFireHue(parseColor('#8b7d74'))).toBe(false); // warm gray, C < 0.09
    expect(isFireHue(parseColor('#b98a00'))).toBe(false); // amber, h≈84
    expect(isFireHue(parseColor('#1a5276'))).toBe(false); // blue
    expect(isFireHue(parseColor('#e0117f'))).toBe(true); // h≈357, inside [350, 360]
    expect(isFireHue(parseColor('#dc143c'))).toBe(true); // crimson, h≈20.09
  });

  it('follows 06 §5.4 literally, gap at [0°, 20°) included', () => {
    // The spec's bands skip 0°–20°, so a raspberry red like this one (h≈8.9, C≈0.23) is
    // not reserved. Pinned so that closing the gap is a visible decision, not a drift.
    expect(isFireHue(parseColor('#e0115f'))).toBe(false);
  });
});

describe('colorOutputs', () => {
  it('reads every output of match / case / interpolate / step / coalesce', () => {
    expect(
      hexes(['match', ['get', 's'], 'a', '#ff0000', ['b', 'c'], '#00ff00', '#0000ff']),
    ).toStrictEqual(['#ff0000', '#00ff00', '#0000ff']);
    expect(hexes(['case', ['==', ['get', 'x'], 1], '#111111', '#222222'])).toStrictEqual([
      '#111111',
      '#222222',
    ]);
    expect(
      hexes(['interpolate', ['linear'], ['zoom'], 0, 'rgba(0, 0, 0, 0)', 5, '#ffffff']),
    ).toStrictEqual(['#00000000', '#ffffff']);
    expect(hexes(['step', ['zoom'], '#111111', 5, '#222222'])).toStrictEqual([
      '#111111',
      '#222222',
    ]);
    expect(hexes(['coalesce', ['literal', '#333333'], ['rgb', 255, 0, 0]])).toStrictEqual([
      '#333333',
      '#ff0000',
    ]);
  });

  it.each([
    ['an unparseable colour', 'oklch(0.6 0.2 30)'],
    ['a colour read from the data', ['get', 'color']],
    ['an unknown operator', ['to-color', ['get', 'color']]],
    ['a legacy function', { stops: [[0, '#fff']] }],
  ])('throws on %s', (_name, value) => {
    expect(() => colorOutputs(value, 'layer x fill-color')).toThrow(StyleColorError);
  });

  it('refuses a pattern that is not a plain image id', () => {
    expect(patternOutputs(['match', ['get', 's'], 'a', 'fire-a', 'fire-b'], 't')).toStrictEqual([
      'fire-a',
      'fire-b',
    ]);
    expect(() => patternOutputs(['get', 'pattern'], 't')).toThrow(StyleColorError);
  });
});

describe('paintedColors and hueViolations', () => {
  const images = new Map([['hatch', [parseColor('#d7301f')]]]);

  it('flags fire hues on unprefixed layers, including through a pattern image', () => {
    const layers: StyleLayerLike[] = [
      { id: 'fire-dot', type: 'circle', paint: { 'circle-color': '#d7301f' } },
      { id: 'road', type: 'line', paint: { 'line-color': '#e8590c', 'line-width': 2 } },
      { id: 'park', type: 'fill', paint: { 'fill-pattern': 'hatch' } },
      { id: 'water', type: 'fill', paint: { 'fill-color': '#1a5276' } },
    ];
    expect(
      hueViolations(paintedColors(layers, images)).map((v) => `${v.layerId} ${v.property}`),
    ).toStrictEqual(['road line-color', 'park fill-pattern']);
  });

  it('throws on a pattern naming an unregistered image', () => {
    const layers: StyleLayerLike[] = [{ id: 'x', type: 'fill', paint: { 'fill-pattern': 'nope' } }];
    expect(() => paintedColors(layers, images)).toThrow(/unregistered image nope/u);
  });

  it('reads the opaque pixels of a pattern tile only', () => {
    const data = new Uint8Array([215, 48, 31, 255, 0, 0, 0, 0, 215, 48, 31, 255]);
    expect(opaqueColors(data).map((c) => formatHex(c))).toStrictEqual(['#d7301f']);
  });
});

describe('evaluate', () => {
  const context = { properties: { s: 'b', n: null }, zoom: 9, featureState: {} };

  it('evaluates the operators the fire registry uses', () => {
    expect(evaluate(['match', ['get', 's'], 'a', 1, ['b', 'c'], 2, 3], context, 't')).toBe(2);
    expect(evaluate(['case', ['==', ['get', 's'], 'b'], 1, 0], context, 't')).toBe(1);
    expect(evaluate(['coalesce', ['get', 'n'], 7], context, 't')).toBe(7);
    expect(
      evaluate(['interpolate', ['linear'], ['zoom'], 5, 10, 13, 20], context, 't'),
    ).toBeCloseTo(15);
    expect(evaluate(['*', 2, ['+', 1, 2]], context, 't')).toBe(6);
    expect(evaluate(['boolean', ['feature-state', 'selected'], false], context, 't')).toBe(false);
  });

  it('throws on an operator it does not implement', () => {
    expect(() => evaluate(['heatmap-density'], context, 't')).toThrow(StyleColorError);
  });
});

describe('cvdCollapses', () => {
  const classes: FireClass[] = [
    { name: 'confirmed', properties: { b: 'confirmed' } },
    { name: 'likely', properties: { b: 'likely' } },
  ];
  const color = ['match', ['get', 'b'], 'confirmed', '#d7301f', '#f16913'];

  it('reports a red/orange pair that collapses with no size channel', () => {
    const layers: StyleLayerLike[] = [
      { id: 'fire-x', type: 'fill', paint: { 'fill-color': color } },
    ];
    const [collapse, ...rest] = cvdCollapses(layers, classes, new Map());
    expect(rest).toStrictEqual([]);
    expect(collapse?.colors).toStrictEqual(['#d7301f', '#f16913']);
    expect(collapse?.failures.map(([kind]) => kind)).toStrictEqual(['deuteranopia', 'tritanopia']);
  });

  it('accepts the same pair when the radius differs by the size ratio', () => {
    const radius = ['match', ['get', 'b'], 'confirmed', 6, 5];
    const layers: StyleLayerLike[] = [
      { id: 'fire-x', type: 'circle', paint: { 'circle-color': color, 'circle-radius': radius } },
    ];
    expect(cvdCollapses(layers, classes, new Map())).toStrictEqual([]);
  });

  it('accepts a pair that stays apart under every simulation', () => {
    const apart = ['match', ['get', 'b'], 'confirmed', '#d7301f', '#1a5276'];
    const layers: StyleLayerLike[] = [
      { id: 'fire-x', type: 'fill', paint: { 'fill-color': apart } },
    ];
    expect(cvdCollapses(layers, classes, new Map())).toStrictEqual([]);
  });
});
