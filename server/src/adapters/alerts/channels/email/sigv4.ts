/**
 * AWS Signature Version 4, the subset one JSON `POST` to SES needs — written against the
 * signing-process documentation rather than pulled in as the SDK, because the SDK is a
 * few megabytes of dependency for what is four HMACs and a canonicalisation, and the
 * secret access key is a secret we would rather not hand to a dependency tree.
 *
 * The algorithm, for the reader checking this against the docs:
 *
 *   1. canonical request  = METHOD \n path \n query \n headers \n\n signed-header-names
 *                           \n hex(sha256(body))
 *   2. string to sign     = "AWS4-HMAC-SHA256" \n x-amz-date \n scope \n hex(sha256(1))
 *      where scope        = YYYYMMDD/region/service/aws4_request
 *   3. signing key        = HMAC(HMAC(HMAC(HMAC("AWS4" + secret, date), region), service),
 *                           "aws4_request")
 *   4. signature          = hex(HMAC(signing key, string to sign))
 *
 * The test reproduces two of AWS's own worked examples byte for byte; if either ever
 * fails, SES will answer 403 `SignatureDoesNotMatch` to every alert.
 */

import { createHash, createHmac } from 'node:crypto';

export interface AwsCredentials {
  readonly accessKeyId: string;
  /** Never logged, never in an error; the adapter scrubs it from provider bodies. */
  readonly secretAccessKey: string;
}

export interface SignableRequest {
  readonly method: 'GET' | 'POST';
  readonly url: URL;
  /** Headers beyond `host` and `x-amz-date`, which the signer adds. Names lower-cased here. */
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
}

export interface SigningContext {
  readonly credentials: AwsCredentials;
  readonly region: string;
  readonly service: string;
  /** Epoch milliseconds; becomes `x-amz-date`. */
  readonly now: number;
}

export interface SignedHeaders {
  readonly authorization: string;
  readonly 'x-amz-date': string;
  readonly host: string;
  readonly [name: string]: string;
}

/** The request's headers with `host`, `x-amz-date` and `authorization` filled in. */
export function signRequest(request: SignableRequest, context: SigningContext): SignedHeaders {
  const amzDate = amzDateOf(context.now);
  const dateStamp = amzDate.slice(0, 8);
  const headers: Record<string, string> = {
    ...lowerCaseKeys(request.headers),
    host: request.url.host,
    'x-amz-date': amzDate,
  };

  const signedHeaderNames = Object.keys(headers).sort();
  const canonicalHeaders = signedHeaderNames
    .map((name) => `${name}:${canonicalHeaderValue(headers[name] ?? '')}\n`)
    .join('');
  const canonicalRequest = [
    request.method,
    canonicalPath(request.url.pathname),
    canonicalQuery(request.url.searchParams),
    canonicalHeaders,
    signedHeaderNames.join(';'),
    sha256Hex(request.body),
  ].join('\n');

  const scope = `${dateStamp}/${context.region}/${context.service}/aws4_request`;
  const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256Hex(canonicalRequest)].join('\n');

  const kDate = hmac(`AWS4${context.credentials.secretAccessKey}`, dateStamp);
  const kRegion = hmac(kDate, context.region);
  const kService = hmac(kRegion, context.service);
  const kSigning = hmac(kService, 'aws4_request');
  const signature = hmac(kSigning, stringToSign).toString('hex');

  return {
    ...headers,
    host: request.url.host,
    'x-amz-date': amzDate,
    authorization:
      `AWS4-HMAC-SHA256 Credential=${context.credentials.accessKeyId}/${scope}, ` +
      `SignedHeaders=${signedHeaderNames.join(';')}, Signature=${signature}`,
  };
}

/** `YYYYMMDD'T'HHMMSS'Z'` — ISO 8601 basic format, the only shape `x-amz-date` accepts. */
export function amzDateOf(epochMs: number): string {
  return new Date(epochMs)
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d{3}Z$/, 'Z');
}

/**
 * RFC 3986 unreserved characters only: `encodeURIComponent` leaves `!'()*` alone and AWS
 * does not, so they are encoded by hand. `/` in a path is kept, in a query it is not.
 */
export function awsUriEncode(text: string, keepSlash: boolean): string {
  const encoded = encodeURIComponent(text).replace(
    /[!'()*]/g,
    (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return keepSlash ? encoded.replace(/%2F/g, '/') : encoded;
}

function canonicalPath(pathname: string): string {
  // Services other than S3 normalise the path first; each segment is then encoded once.
  // A `URL` has already normalised `.`/`..` for us and left a leading slash in place.
  return pathname
    .split('/')
    .map((segment) => awsUriEncode(decodeURIComponent(segment), false))
    .join('/');
}

function canonicalQuery(params: URLSearchParams): string {
  return [...params.entries()]
    .map(([name, value]) => [awsUriEncode(name, false), awsUriEncode(value, false)] as const)
    .sort(([a, av], [b, bv]) => (a < b ? -1 : a > b ? 1 : av < bv ? -1 : av > bv ? 1 : 0))
    .map(([name, value]) => `${name}=${value}`)
    .join('&');
}

function canonicalHeaderValue(value: string): string {
  return value.trim().replace(/\s+/g, ' ');
}

function lowerCaseKeys(headers: Readonly<Record<string, string>>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(headers).map(([name, value]) => [name.toLowerCase(), value]),
  );
}

function sha256Hex(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

function hmac(key: string | Buffer, text: string): Buffer {
  return createHmac('sha256', key).update(text, 'utf8').digest();
}
