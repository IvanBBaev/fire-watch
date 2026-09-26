/**
 * AWS Signature Version 4 for the S3 API, as Cloudflare R2 speaks it (TASKS E3).
 *
 * Hand-written against the S3 signing documentation ("Authenticating Requests: Using the
 * Authorization Header") with `node:crypto` only — the same reasoning as the SES signer in
 * `adapters/alerts/channels/email/sigv4.ts`: an SDK is megabytes of dependency tree to
 * hand a secret to, for four HMACs and a canonicalisation. It is a separate module rather
 * than a reuse of that one because S3 differs in exactly the places that one is narrow:
 *
 *   * any method (`PUT`, `HEAD`), and a binary-safe body — the payload is signed as a
 *     precomputed SHA-256, which S3 also requires as the `x-amz-content-sha256` header;
 *   * the canonical URI is the object key URI-encoded **once**, `/` kept, with no path
 *     normalisation: `a/../b` is a legal S3 key and must not be collapsed. The caller
 *     passes the raw (unencoded) path and uses {@link s3CanonicalUri} for the wire URL too,
 *     so what is signed and what is sent cannot drift apart.
 *
 * The algorithm:
 *
 *   1. canonical request = METHOD \n uri \n query \n headers \n\n signed-names \n payload-hash
 *   2. string to sign    = "AWS4-HMAC-SHA256" \n x-amz-date \n scope \n hex(sha256(1))
 *   3. signing key       = HMAC chain over date, region, service, "aws4_request"
 *   4. signature         = hex(HMAC(signing key, string to sign))
 *
 * The tests reproduce the S3 guide's worked examples byte for byte.
 */

import { createHash, createHmac } from 'node:crypto';

export interface S3Credentials {
  readonly accessKeyId: string;
  /** Never logged, never in an error, never in a returned header. */
  readonly secretAccessKey: string;
}

export interface S3SignableRequest {
  readonly method: string;
  /** e.g. `examplebucket.s3.amazonaws.com` or `<account>.r2.cloudflarestorage.com`. */
  readonly host: string;
  /** The raw path, not URI-encoded, starting with `/` (path-style: `/<bucket>/<key>`). */
  readonly path: string;
  /** Raw names and values; encoded and sorted here. */
  readonly query?: readonly (readonly [string, string])[];
  /** Headers to sign besides `host`, `x-amz-date` and `x-amz-content-sha256`. */
  readonly headers?: Readonly<Record<string, string>>;
  /** Lower-case hex SHA-256 of the body ({@link sha256Hex}), or `UNSIGNED-PAYLOAD`. */
  readonly payloadHash: string;
}

export interface S3SigningContext {
  readonly credentials: S3Credentials;
  /** `auto` for R2. */
  readonly region: string;
  /** Epoch milliseconds; becomes `x-amz-date`. */
  readonly now: number;
}

export interface S3SignedRequest {
  /** Every signed header plus `authorization`, names lower-cased, ready for `fetch`. */
  readonly headers: Readonly<Record<string, string>>;
  readonly canonicalRequest: string;
  readonly stringToSign: string;
  readonly signature: string;
}

const SERVICE = 's3';
export const EMPTY_PAYLOAD_SHA256 =
  'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';

export function signS3Request(
  request: S3SignableRequest,
  context: S3SigningContext,
): S3SignedRequest {
  const amzDate = amzDate8601(context.now);
  const dateStamp = amzDate.slice(0, 8);
  const headers = canonicalHeaderMap({
    ...(request.headers ?? {}),
    host: request.host,
    'x-amz-date': amzDate,
    'x-amz-content-sha256': request.payloadHash,
  });
  const signedNames = Object.keys(headers).sort();
  const canonicalRequest = [
    request.method.toUpperCase(),
    s3CanonicalUri(request.path),
    canonicalQueryString(request.query ?? []),
    signedNames.map((name) => `${name}:${headers[name] ?? ''}\n`).join(''),
    signedNames.join(';'),
    request.payloadHash,
  ].join('\n');

  const scope = `${dateStamp}/${context.region}/${SERVICE}/aws4_request`;
  const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256Hex(canonicalRequest)].join('\n');
  const kDate = hmac(`AWS4${context.credentials.secretAccessKey}`, dateStamp);
  const kRegion = hmac(kDate, context.region);
  const kService = hmac(kRegion, SERVICE);
  const kSigning = hmac(kService, 'aws4_request');
  const signature = hmac(kSigning, stringToSign).toString('hex');

  return {
    headers: {
      ...headers,
      authorization:
        `AWS4-HMAC-SHA256 Credential=${context.credentials.accessKeyId}/${scope},` +
        `SignedHeaders=${signedNames.join(';')},Signature=${signature}`,
    },
    canonicalRequest,
    stringToSign,
    signature,
  };
}

/** `YYYYMMDD'T'HHMMSS'Z'`, UTC, second precision. */
export function amzDate8601(epochMs: number): string {
  return new Date(epochMs)
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d{3}Z$/, 'Z');
}

/**
 * RFC 3986 unreserved characters (`A-Z a-z 0-9 - _ . ~`) pass; every other byte of the
 * UTF-8 encoding becomes `%XX` in upper-case hex. `/` passes only when `keepSlash`.
 */
export function s3UriEncode(text: string, keepSlash: boolean): string {
  let out = '';
  for (const byte of Buffer.from(text, 'utf8')) {
    const char = String.fromCharCode(byte);
    if (/[A-Za-z0-9\-_.~]/.test(char) || (keepSlash && char === '/')) out += char;
    else out += `%${byte.toString(16).toUpperCase().padStart(2, '0')}`;
  }
  return out;
}

/** The path as signed and as sent: encoded once, slashes kept, never normalised. */
export function s3CanonicalUri(rawPath: string): string {
  if (!rawPath.startsWith('/')) {
    throw new RangeError('an S3 request path starts with "/"');
  }
  return s3UriEncode(rawPath, true);
}

/** Encoded names and values, sorted by encoded name then value; `name=` for an empty value. */
export function canonicalQueryString(query: readonly (readonly [string, string])[]): string {
  return query
    .map(([name, value]) => [s3UriEncode(name, false), s3UriEncode(value, false)] as const)
    .sort(([a, av], [b, bv]) => (a < b ? -1 : a > b ? 1 : av < bv ? -1 : av > bv ? 1 : 0))
    .map(([name, value]) => `${name}=${value}`)
    .join('&');
}

/** Lower-cased names; values trimmed with internal whitespace runs collapsed to one space. */
export function canonicalHeaderMap(
  headers: Readonly<Record<string, string>>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    const key = name.trim().toLowerCase();
    if (key in out) throw new RangeError(`header ${key} is given twice`);
    out[key] = value.trim().replace(/\s+/g, ' ');
  }
  return out;
}

export function sha256Hex(body: string | Uint8Array): string {
  return createHash('sha256').update(body).digest('hex');
}

function hmac(key: string | Buffer, text: string): Buffer {
  return createHmac('sha256', key).update(text, 'utf8').digest();
}
