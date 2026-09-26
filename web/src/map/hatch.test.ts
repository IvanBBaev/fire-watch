import { describe, expect, it } from 'vitest';

import { createHatchImage, parseHexColor } from './hatch.js';

const TILE = 8;

function pixel(
  image: { width: number; data: Uint8Array },
  x: number,
  y: number,
): readonly [number, number, number, number] {
  const o = (y * image.width + x) * 4;
  return [
    image.data[o] ?? 0,
    image.data[o + 1] ?? 0,
    image.data[o + 2] ?? 0,
    image.data[o + 3] ?? 0,
  ];
}

describe('parseHexColor', () => {
  it('reads the six-digit form', () => {
    expect(parseHexColor('#d7301f')).toEqual([215, 48, 31]);
  });

  it('reads the shorthand form', () => {
    expect(parseHexColor('#f00')).toEqual([255, 0, 0]);
  });

  it('tolerates a missing hash', () => {
    expect(parseHexColor('8b9198')).toEqual([139, 145, 152]);
  });

  it.each(['#gggggg', '#12345', 'orange', ''])('rejects %s', (input) => {
    expect(() => parseHexColor(input)).toThrow();
  });
});

describe('createHatchImage', () => {
  const image = createHatchImage('#f16913');

  it('is a square RGBA tile', () => {
    expect(image.width).toBe(TILE);
    expect(image.height).toBe(TILE);
    expect(image.data).toHaveLength(TILE * TILE * 4);
  });

  it('paints stripes in the requested colour, fully opaque', () => {
    // (0 + 0) % 4 === 0 → on the stripe.
    expect(pixel(image, 0, 0)).toEqual([241, 105, 19, 255]);
  });

  it('leaves the gaps fully clear with zeroed RGB, so a premultiplying upload cannot fringe', () => {
    // (2 + 0) % 4 === 2 → in the gap.
    expect(pixel(image, 2, 0)).toEqual([0, 0, 0, 0]);
  });

  it('uses only the two safe alpha values', () => {
    for (let i = 3; i < image.data.length; i += 4) {
      expect([0, 255]).toContain(image.data[i]);
    }
  });

  it('tiles seamlessly: the diagonal continues across the seam in both axes', () => {
    const isOn = (x: number, y: number): boolean => pixel(image, x, y)[3] === 255;
    for (let i = 0; i < TILE; i += 1) {
      // Stepping off the right edge lands where stepping to x=0 of the next tile would.
      expect(isOn((i + TILE) % TILE, i)).toBe(isOn(i, i));
      // The diagonal wraps: a pixel and the one a full tile down-right agree.
      expect(isOn(i, (i + TILE) % TILE)).toBe(isOn(i, i));
    }
  });

  it('covers half the tile, so the fill reads as marked rather than solid', () => {
    let on = 0;
    for (let i = 3; i < image.data.length; i += 4) if (image.data[i] === 255) on += 1;
    expect(on).toBe((TILE * TILE) / 2);
  });

  it('gives every colour its own buffer', () => {
    const other = createHatchImage('#8b9198');
    expect(pixel(other, 0, 0)).toEqual([139, 145, 152, 255]);
    expect(pixel(image, 0, 0)).toEqual([241, 105, 19, 255]);
  });
});
