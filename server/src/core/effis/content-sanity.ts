/**
 * The EFFIS content-sanity classifier — the gate between "EFFIS answered" and "this body
 * may become the copy the proxy serves" (TASKS G4; ADR-001 A2.2, which amends A1.2 and
 * is normative for C4/G4).
 *
 * Status, Content-Type and the bytes go in; one verdict and the *named rule* that decided
 * it come out. Every rule has a stable name because the name is what travels: into the
 * provenance sidecar, the feed-status `last_error`, the refresh log line and — once the
 * metrics pipe exists — the `effis_proxy_reject_total{layer,reason}` label A2.2 names.
 *
 * Three verdicts, because A2.2 assigns three behaviours:
 *
 *   * **good** — may replace the served copy.
 *   * **reject** — hard fail, treated exactly like an HTTP 5xx: never cached, the last
 *     good copy keeps serving. Everything that proves the body is not the picture we
 *     asked for (an XML ServiceException or HTML error page served as 200, a PNG that
 *     is not a PNG, a raster of a size we did not request).
 *   * **suspect** — soft fail: never cached *as good*; stale is served if it exists,
 *     else the body may be passed through with a TTL ≤ 60 s. Everything that merely
 *     *looks* wrong but can legitimately happen — A2.2 is explicit that a fully
 *     transparent FWI tile is possible, so blank is suspect, not proven bad.
 *
 * Where the decoding happens. A2.2 says "headers and body length only, no image
 * decoding in the proxy path". This classifier runs in the refresh job — the proxy
 * route serves a file the job already judged and decodes nothing — so the PNG rules
 * below are consistent with it: the expensive check runs once per six hours, never per
 * request. The PNG facts come from `png-structure.ts`; the inflate step is injected.
 *
 * Rules, in evaluation order (first match wins; the order goes from cheapest and most
 * certain to most expensive and most judgement-laden):
 *
 *   1. `http_status_not_ok`     reject   status is not 200
 *   2. `content_type_mismatch`  reject   media type absent or not an accepted one
 *   3. `error_document_body`    reject   body is markup although markup was not asked for
 *   4. `png_signature_missing`  reject   image/png body without the PNG signature
 *   5. `png_structure_invalid`  reject   bad chunk/CRC/IHDR, truncation, bad image data
 *   6. `png_dimensions_mismatch` reject  IHDR size ≠ the WIDTH/HEIGHT we requested
 *   7. `png_fully_transparent`  suspect  every pixel has alpha 0
 *   8. `png_uniform_pixels`     suspect  every pixel identical (one flat colour)
 *   9. `png_mostly_transparent` suspect  transparent share ≥ threshold — UNARMED (null)
 *  10. `body_below_byte_floor`  suspect  fewer bytes than the per-layer floor
 */

import type { Inflate } from '../ports/inflate.js';
import {
  analysePngPixels,
  readPngChunks,
  type PngColorType,
  type PngHeader,
} from './png-structure.js';

export type SanityVerdict = 'good' | 'reject' | 'suspect';

export type SanityRule =
  | 'http_status_not_ok'
  | 'content_type_mismatch'
  | 'error_document_body'
  | 'png_signature_missing'
  | 'png_structure_invalid'
  | 'png_dimensions_mismatch'
  | 'png_fully_transparent'
  | 'png_uniform_pixels'
  | 'png_mostly_transparent'
  | 'body_below_byte_floor';

/** Every rule and the verdict it hands down — the table the tests pin. */
export const SANITY_RULES: Readonly<Record<SanityRule, Exclude<SanityVerdict, 'good'>>> = {
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
};

/**
 * Share of fully transparent pixels at or above which a raster is "near-blank".
 *
 * UNARMED (`null`): neither A2.2 nor DATA-SOURCES gives a number, and it cannot be
 * guessed — FWI is land-only, so a legitimate raster over the polling bbox is already
 * mostly transparent sea. It is armed by calibrating against real good responses and
 * bumping this value in review, never by picking a round number here.
 */
export const NEAR_BLANK_TRANSPARENT_FRACTION: number | null = null;

export interface RasterFacts {
  readonly width: number;
  readonly height: number;
  readonly bitDepth: number;
  readonly colorType: PngColorType;
  readonly interlaced: boolean;
  /** `null` when the pixels were not (or could not be) read. */
  readonly uniform: boolean | null;
  readonly transparentFraction: number | null;
}

export interface SanityCheck {
  readonly verdict: SanityVerdict;
  /** The rule that decided a non-good verdict; `null` when good. */
  readonly rule: SanityRule | null;
  /** The media type with parameters stripped and case folded, or `null` when absent. */
  readonly mediaType: string | null;
  readonly byteLength: number;
  /** `<rule>: <why>`, for the provenance sidecar and the log line. `null` when good. */
  readonly reason: string | null;
  /** What the PNG header (and pixels, when read) said; `null` for non-PNG bodies. */
  readonly raster: RasterFacts | null;
}

export interface SanityResponse {
  /** The HTTP status, or `null` when the client could not say. */
  readonly status: number | null;
  /** The Content-Type header verbatim, parameters and all. */
  readonly contentType: string | null;
  readonly body: Uint8Array;
}

export interface SanityExpectation {
  /** Lowercased, parameter-free media types that count as the requested format. */
  readonly acceptedMediaTypes: readonly string[];
  readonly byteFloorBytes: number;
  /** The WIDTH/HEIGHT requested, for raster layers; `null` for vector layers. */
  readonly raster: { readonly width: number; readonly height: number } | null;
  /** Defaults to `NEAR_BLANK_TRANSPARENT_FRACTION`; `null` leaves the rule unarmed. */
  readonly nearBlankTransparentFraction?: number | null;
}

export function checkContentSanity(
  response: SanityResponse,
  expectation: SanityExpectation,
  inflate: Inflate,
): SanityCheck {
  const mediaType = parseMediaType(response.contentType);
  const byteLength = response.body.byteLength;
  let raster: RasterFacts | null = null;
  const fail = (rule: SanityRule, why: string): SanityCheck => ({
    verdict: SANITY_RULES[rule],
    rule,
    mediaType,
    byteLength,
    reason: `${rule}: ${why}`,
    raster,
  });

  if (response.status !== 200) {
    return fail(
      'http_status_not_ok',
      `status ${response.status === null ? 'unknown' : String(response.status)}, expected 200 — treated like a 5xx (A2.2)`,
    );
  }

  if (mediaType === null || !expectation.acceptedMediaTypes.includes(mediaType)) {
    return fail(
      'content_type_mismatch',
      `body is ${mediaType ?? 'missing a Content-Type'}, expected one of ` +
        `${expectation.acceptedMediaTypes.join(', ')} — treated like a 5xx (A2.2)`,
    );
  }

  // A correctly-labelled body can still be an error document: some mapserver setups
  // (and every proxy in between) happily label a ServiceException with the requested
  // type. None of the formats we request starts with '<', so a body that does is markup.
  if (!acceptsMarkup(expectation.acceptedMediaTypes) && startsWithMarkup(response.body)) {
    return fail(
      'error_document_body',
      `body labelled ${mediaType} starts with markup (${markupExcerpt(response.body)}) — an error document`,
    );
  }

  if (mediaType === 'image/png') {
    const chunks = readPngChunks(response.body);
    if (!chunks.ok) {
      return chunks.problem === 'signature'
        ? fail('png_signature_missing', chunks.detail)
        : fail('png_structure_invalid', chunks.detail);
    }
    const header = chunks.chunks.header;
    raster = rasterFacts(header, null, null);

    const wanted = expectation.raster;
    if (wanted !== null && (header.width !== wanted.width || header.height !== wanted.height)) {
      return fail(
        'png_dimensions_mismatch',
        `raster is ${String(header.width)}×${String(header.height)}, requested ` +
          `${String(wanted.width)}×${String(wanted.height)} — not the picture we asked for`,
      );
    }

    const pixels = analysePngPixels(chunks.chunks, inflate);
    if (!pixels.ok) return fail('png_structure_invalid', pixels.detail);
    const { uniform, transparentFraction } = pixels.facts;
    raster = rasterFacts(header, uniform, transparentFraction);

    if (transparentFraction === 1) {
      return fail(
        'png_fully_transparent',
        'every pixel is fully transparent — possible off-season, never cached as good (A2.2)',
      );
    }
    if (uniform) {
      return fail('png_uniform_pixels', 'every pixel carries the same colour — a flat image');
    }
    const threshold = expectation.nearBlankTransparentFraction ?? NEAR_BLANK_TRANSPARENT_FRACTION;
    if (threshold !== null && transparentFraction >= threshold) {
      return fail(
        'png_mostly_transparent',
        `${formatShare(transparentFraction)} of pixels are transparent, at or above the ` +
          `${formatShare(threshold)} near-blank threshold`,
      );
    }
  }

  if (byteLength < expectation.byteFloorBytes) {
    return fail(
      'body_below_byte_floor',
      `body is ${String(byteLength)} bytes, below the ` +
        `${String(expectation.byteFloorBytes)}-byte floor — never cached as good (A2.2)`,
    );
  }

  return { verdict: 'good', rule: null, mediaType, byteLength, reason: null, raster };
}

/** `text/xml;charset=UTF-8` → `text/xml`. Absent and empty both come out `null`. */
export function parseMediaType(contentType: string | null): string | null {
  if (contentType === null) return null;
  const bare = (contentType.split(';')[0] ?? '').trim().toLowerCase();
  return bare === '' ? null : bare;
}

function rasterFacts(
  header: PngHeader,
  uniform: boolean | null,
  transparentFraction: number | null,
): RasterFacts {
  return {
    width: header.width,
    height: header.height,
    bitDepth: header.bitDepth,
    colorType: header.colorType,
    interlaced: header.interlaced,
    uniform,
    transparentFraction,
  };
}

function acceptsMarkup(mediaTypes: readonly string[]): boolean {
  return mediaTypes.some((type) => type.includes('xml') || type.includes('html'));
}

/** First non-whitespace byte, after an optional UTF-8 BOM, is '<'. */
function startsWithMarkup(body: Uint8Array): boolean {
  return body[firstContentIndex(body)] === 0x3c;
}

function firstContentIndex(body: Uint8Array): number {
  let i = body[0] === 0xef && body[1] === 0xbb && body[2] === 0xbf ? 3 : 0;
  while (i < body.byteLength && isAsciiWhitespace(body[i] ?? 0)) i += 1;
  return i;
}

function isAsciiWhitespace(byte: number): boolean {
  return byte === 0x20 || byte === 0x09 || byte === 0x0a || byte === 0x0d;
}

/** The opening tag, printable ASCII only — enough to tell `<ServiceExceptionReport` from `<html`. */
function markupExcerpt(body: Uint8Array): string {
  const start = firstContentIndex(body);
  let text = '';
  for (let i = start; i < body.byteLength && text.length < 40; i += 1) {
    const byte = body[i] ?? 0;
    if (byte === 0x3e || isAsciiWhitespace(byte)) break;
    text += byte >= 0x20 && byte < 0x7f ? String.fromCharCode(byte) : '?';
  }
  return text;
}

function formatShare(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}
