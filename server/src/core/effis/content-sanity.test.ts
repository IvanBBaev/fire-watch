import { describe, expect, it } from 'vitest';

import {
  NEAR_BLANK_TRANSPARENT_FRACTION,
  SANITY_RULES,
  checkContentSanity,
  type SanityExpectation,
  type SanityResponse,
  type SanityRule,
} from './content-sanity.js';
import { asciiBytes, encodePng, storedInflate, type PngSpec } from './png-testkit.js';

const W = 64;
const H = 40;

/** A land-and-sea raster: transparent "sea" on the left, graded colour on the right. */
const GOOD_SPEC: PngSpec = {
  width: W,
  height: H,
  colorType: 6,
  bitDepth: 8,
  pixel: (x, y) => (x < 20 ? [0, 0, 0, 0] : [x * 3, y * 5, 90, 255]),
};

const PNG_EXPECTATION: SanityExpectation = {
  acceptedMediaTypes: ['image/png'],
  byteFloorBytes: 1024,
  raster: { width: W, height: H },
};

const JSON_EXPECTATION: SanityExpectation = {
  acceptedMediaTypes: ['application/json', 'application/geo+json'],
  byteFloorBytes: 32,
  raster: null,
};

const SERVICE_EXCEPTION =
  '<?xml version="1.0" encoding="UTF-8"?>\n<ServiceExceptionReport version="1.3.0">' +
  '<ServiceException code="LayerNotDefined">msWMSLoadGetMapParams(): Invalid layer(s)</ServiceException>' +
  '</ServiceExceptionReport>';

const png = (spec: Partial<PngSpec> = {}): Uint8Array => encodePng({ ...GOOD_SPEC, ...spec });

const ok = (body: Uint8Array, contentType = 'image/png'): SanityResponse => ({
  status: 200,
  contentType,
  body,
});

const check = (response: SanityResponse, expectation = PNG_EXPECTATION) =>
  checkContentSanity(response, expectation, storedInflate);

describe('checkContentSanity — the rule table', () => {
  it('names every rule and gives each exactly one verdict', () => {
    expect(SANITY_RULES).toEqual({
      http_status_not_ok: 'reject',
      content_type_mismatch: 'reject',
      error_document_body: 'reject',
      png_signature_missing: 'reject',
      png_structure_invalid: 'reject',
      png_dimensions_mismatch: 'reject',
      png_fully_transparent: 'suspect',
      png_uniform_pixels: 'suspect',
      png_mostly_transparent: 'suspect',
      body_below_byte_floor: 'suspect',
    } satisfies Record<SanityRule, string>);
  });

  it('ships the near-blank threshold unarmed', () => {
    expect(NEAR_BLANK_TRANSPARENT_FRACTION).toBeNull();
  });
});

describe('checkContentSanity — good bodies', () => {
  it('passes a well-formed raster of the requested size, and reports its facts', () => {
    const result = check(ok(png()));
    expect(result).toMatchObject({
      verdict: 'good',
      rule: null,
      reason: null,
      mediaType: 'image/png',
    });
    expect(result.raster).toEqual({
      width: W,
      height: H,
      bitDepth: 8,
      colorType: 6,
      interlaced: false,
      uniform: false,
      transparentFraction: 20 / W,
    });
  });

  it('strips parameters and folds case before matching the media type', () => {
    expect(check(ok(png(), 'IMAGE/PNG; charset=binary')).verdict).toBe('good');
  });

  it('passes a GeoJSON body, with no raster facts', () => {
    const body = asciiBytes('{"type":"FeatureCollection","features":[]}');
    const result = check(ok(body, 'application/json;charset=UTF-8'), JSON_EXPECTATION);
    expect(result).toMatchObject({ verdict: 'good', raster: null });
  });

  it('passes a body exactly at the floor — the floor is a minimum, not a neighbourhood', () => {
    const body = asciiBytes(`{"type":"FeatureCollection","features":[${' '.repeat(32)}]}`);
    const result = check(ok(body, 'application/json'), {
      ...JSON_EXPECTATION,
      byteFloorBytes: body.byteLength,
    });
    expect(result.verdict).toBe('good');
  });
});

describe('checkContentSanity — reject rules', () => {
  it('http_status_not_ok: a non-200, and an unknown status', () => {
    expect(check({ ...ok(png()), status: 206 })).toMatchObject({
      verdict: 'reject',
      rule: 'http_status_not_ok',
    });
    expect(check({ ...ok(png()), status: null }).rule).toBe('http_status_not_ok');
  });

  it('content_type_mismatch: a 200 ServiceException labelled text/xml (A2.2 fixture 1)', () => {
    const result = check(ok(asciiBytes(SERVICE_EXCEPTION), 'text/xml;charset=UTF-8'));
    expect(result).toMatchObject({
      verdict: 'reject',
      rule: 'content_type_mismatch',
      mediaType: 'text/xml',
    });
    expect(result.reason).toMatch(/^content_type_mismatch: .*treated like a 5xx/);
  });

  it('content_type_mismatch: an HTML error page, and a missing or empty header', () => {
    const html = asciiBytes('<!DOCTYPE html><html><body>502 Bad Gateway</body></html>');
    expect(check(ok(html, 'text/html; charset=utf-8')).rule).toBe('content_type_mismatch');
    expect(check({ ...ok(png()), contentType: null })).toMatchObject({
      rule: 'content_type_mismatch',
      mediaType: null,
    });
    expect(check(ok(png(), '  ')).rule).toBe('content_type_mismatch');
  });

  it('error_document_body: a ServiceException mislabelled image/png', () => {
    const bom = Uint8Array.from([0xef, 0xbb, 0xbf]);
    const body = Uint8Array.from([...bom, ...asciiBytes(`  \n${SERVICE_EXCEPTION}`)]);
    const result = check(ok(body));
    expect(result).toMatchObject({ verdict: 'reject', rule: 'error_document_body' });
    expect(result.reason).toContain('<?xml');
  });

  it('error_document_body: an HTML page mislabelled application/json', () => {
    const body = asciiBytes('<html><head><title>Service Unavailable</title></head></html>');
    const result = check(ok(body, 'application/json'), JSON_EXPECTATION);
    expect(result).toMatchObject({ verdict: 'reject', rule: 'error_document_body' });
    expect(result.reason).toContain('<html');
  });

  it('png_signature_missing: image/png bytes that are not a PNG', () => {
    expect(check(ok(new Uint8Array(2048)))).toMatchObject({
      verdict: 'reject',
      rule: 'png_signature_missing',
    });
  });

  it('png_structure_invalid: a truncated PNG', () => {
    const good = png();
    expect(check(ok(good.subarray(0, good.byteLength - 40)))).toMatchObject({
      verdict: 'reject',
      rule: 'png_structure_invalid',
    });
  });

  it('png_structure_invalid: image data that does not match the header', () => {
    // Valid chunks and CRCs, but the image stream comes out one byte short of the IHDR.
    const inflateShort = checkContentSanity(ok(png()), PNG_EXPECTATION, (data, max) => {
      const out = storedInflate(data, max);
      return out === null ? null : out.subarray(0, out.byteLength - 1);
    });
    expect(inflateShort).toMatchObject({ verdict: 'reject', rule: 'png_structure_invalid' });
    expect(inflateShort.raster).toMatchObject({ width: W, height: H, uniform: null });
  });

  it('png_dimensions_mismatch: a raster of a size we did not request', () => {
    const result = check(ok(png({ width: 256, height: 256 })));
    expect(result).toMatchObject({ verdict: 'reject', rule: 'png_dimensions_mismatch' });
    expect(result.reason).toContain('256×256, requested 64×40');
    expect(result.raster).toMatchObject({ width: 256, height: 256, uniform: null });
  });

  it('checks dimensions before reading a single pixel', () => {
    let inflated = false;
    checkContentSanity(ok(png({ width: 10 })), PNG_EXPECTATION, (data, max) => {
      inflated = true;
      return storedInflate(data, max);
    });
    expect(inflated).toBe(false);
  });
});

describe('checkContentSanity — suspect rules', () => {
  it('png_fully_transparent: the blank EFFIS raster (A2.2 fixture 2)', () => {
    const result = check(ok(png({ pixel: () => [0, 0, 0, 0] })), {
      ...PNG_EXPECTATION,
      byteFloorBytes: 0,
    });
    expect(result).toMatchObject({ verdict: 'suspect', rule: 'png_fully_transparent' });
    expect(result.raster).toMatchObject({ uniform: true, transparentFraction: 1 });
  });

  it('png_fully_transparent: also when the pixels differ only under zero alpha', () => {
    const result = check(ok(png({ pixel: (x) => [x, x, x, 0] })));
    expect(result.rule).toBe('png_fully_transparent');
  });

  it('png_uniform_pixels: a flat opaque image', () => {
    const result = check(ok(png({ pixel: () => [255, 255, 255, 255] })));
    expect(result).toMatchObject({ verdict: 'suspect', rule: 'png_uniform_pixels' });
  });

  it('png_mostly_transparent: unarmed by default, fires once a threshold is given', () => {
    expect(check(ok(png())).verdict).toBe('good');
    const armed = check(ok(png()), { ...PNG_EXPECTATION, nearBlankTransparentFraction: 0.3 });
    expect(armed).toMatchObject({ verdict: 'suspect', rule: 'png_mostly_transparent' });
    expect(armed.reason).toContain('31.3% of pixels are transparent');
    const high = check(ok(png()), { ...PNG_EXPECTATION, nearBlankTransparentFraction: 0.99 });
    expect(high.verdict).toBe('good');
  });

  it('body_below_byte_floor: a right-typed, well-formed body under the floor', () => {
    const tiny = png({ width: 30, height: 2 });
    const result = check(ok(tiny), { ...PNG_EXPECTATION, raster: { width: 30, height: 2 } });
    expect(result).toMatchObject({ verdict: 'suspect', rule: 'body_below_byte_floor' });
    expect(result.reason).toMatch(
      /^body_below_byte_floor: body is \d+ bytes, below the 1024-byte floor/,
    );
  });

  it('body_below_byte_floor: an empty GeoJSON body', () => {
    const result = check(ok(new Uint8Array(0), 'application/json'), JSON_EXPECTATION);
    expect(result.rule).toBe('body_below_byte_floor');
  });

  it('a hard fail outranks a soft one: a tiny XML error is rejected, not suspect', () => {
    const result = check(ok(asciiBytes('<error/>'), 'text/xml'));
    expect(result.verdict).toBe('reject');
  });
});
