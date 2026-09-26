/**
 * The hatch pattern the detection-footprint fill uses — generated, not shipped as a PNG.
 *
 * **Why hatched and not solid.** A solid polygon on a fire map reads as a surveyed
 * perimeter: "this is the burnt area, these are its edges". We never have that. What we
 * have is a set of pixel cells in which an instrument measured heat, which is the weaker
 * and true claim "somewhere in here". Diagonal hatching is the long-standing cartographic
 * mark for exactly that — an area under a qualifier — and it also gives the fill a second,
 * non-hue channel, which is what review 19 asks of anything that carries meaning by colour.
 *
 * **Why a generated image.** `fill-pattern` needs a registered image, and a build-time PNG
 * would be a binary asset whose colours drift out of sync with the registry constants the
 * moment one of them is repinned. Generating the tile from the same hex string keeps the
 * hatch and the dot the same red by construction.
 *
 * **Why the alpha is only ever 0 or 255.** MapLibre uploads pattern images into the sprite
 * atlas, and whether it premultiplies alpha on the way in has changed across versions.
 * Partially transparent pixels are where that difference shows up, as dark fringing around
 * every stripe. Stripes are painted fully opaque and the gaps fully clear (RGB zeroed, so
 * even a premultiplying upload has nothing to smear), and the layer's `fill-opacity`
 * carries the transparency instead — one number, in the registry, where it is reviewable.
 */

/** An RGBA image in the shape `map.addImage()` accepts for a raw pixel buffer. */
export interface PatternImage {
  readonly width: number;
  readonly height: number;
  readonly data: Uint8Array;
}

/**
 * Tile size in pixels. Must be a multiple of {@link STRIPE_PERIOD} or the diagonal breaks
 * at every tile seam — `(x + y) % period` only lines up across the join when it does.
 */
const TILE_SIZE = 8;

/** Stripe repeat: {@link STRIPE_WIDTH} painted pixels out of every {@link STRIPE_PERIOD}. */
const STRIPE_PERIOD = 4;
const STRIPE_WIDTH = 2;

/** `#rgb` / `#rrggbb` → channel triple. Throws: a bad colour is a bug, not user input. */
export function parseHexColor(hex: string): readonly [number, number, number] {
  const body = hex.startsWith('#') ? hex.slice(1) : hex;
  const full =
    body.length === 3 ? [body[0], body[0], body[1], body[1], body[2], body[2]].join('') : body;
  if (!/^[0-9a-fA-F]{6}$/.test(full)) throw new Error(`not a hex colour: ${hex}`);
  return [
    Number.parseInt(full.slice(0, 2), 16),
    Number.parseInt(full.slice(2, 4), 16),
    Number.parseInt(full.slice(4, 6), 16),
  ];
}

/**
 * A tileable diagonal-stripe tile in the given colour.
 *
 * The stripes run north-west to south-east (`x + y` constant), which is the direction that
 * reads as a qualifier rather than as data: no satellite swath, road or ridge in this
 * region runs that way often enough for the hatch to be mistaken for one.
 */
export function createHatchImage(hex: string): PatternImage {
  const [r, g, b] = parseHexColor(hex);
  const data = new Uint8Array(TILE_SIZE * TILE_SIZE * 4);
  for (let y = 0; y < TILE_SIZE; y += 1) {
    for (let x = 0; x < TILE_SIZE; x += 1) {
      if ((x + y) % STRIPE_PERIOD >= STRIPE_WIDTH) continue; // gap: left zeroed
      const offset = (y * TILE_SIZE + x) * 4;
      data[offset] = r;
      data[offset + 1] = g;
      data[offset + 2] = b;
      data[offset + 3] = 255;
    }
  }
  return { width: TILE_SIZE, height: TILE_SIZE, data };
}
