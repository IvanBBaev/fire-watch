/**
 * The {@link ObjectStore} port over Cloudflare R2's S3-compatible API (TASKS E3).
 *
 * Path-style requests (`https://<account>.r2.cloudflarestorage.com/<bucket>/<key>`, region
 * `auto`), signed per request with {@link signS3Request}, over node's `fetch`. The payload is
 * signed by its real SHA-256 — not `UNSIGNED-PAYLOAD` — so the store itself rejects a body
 * that was altered or truncated in flight: a half-sent snapshot is refused, never stored.
 *
 * **Errors carry the status and the S3 error code, nothing else.** A provider body is not
 * echoed: it is not ours to log, and the access key id is in the `Authorization` header an
 * error body may quote back. The secret is only ever an HMAC key inside the signer.
 */

import type { Clock } from '../../core/ports/clock.js';
import type {
  ObjectStore,
  ObjectToStore,
  StoredObjectHead,
} from '../../core/ports/object-store.js';
import { s3CanonicalUri, sha256Hex, signS3Request, type S3Credentials } from './s3-sigv4.js';

export const R2_REGION = 'auto';
export const R2_REQUEST_TIMEOUT_MS = 15_000;

const META_PREFIX = 'x-amz-meta-';
const META_NAME_RE = /^[a-z0-9-]+$/;
const META_VALUE_RE = /^[\x20-\x7e]*$/;

export interface R2ObjectStoreOptions {
  /** The S3 API endpoint origin, e.g. `https://<account>.eu.r2.cloudflarestorage.com`. */
  readonly endpoint: string;
  readonly bucket: string;
  readonly credentials: S3Credentials;
  readonly clock: Clock;
  readonly fetch?: typeof fetch;
  readonly timeoutMs?: number;
}

export function createR2ObjectStore(options: R2ObjectStoreOptions): ObjectStore {
  const endpoint = new URL(options.endpoint);
  const doFetch = options.fetch ?? fetch;
  const timeoutMs = options.timeoutMs ?? R2_REQUEST_TIMEOUT_MS;

  async function send(
    method: 'PUT' | 'HEAD',
    key: string,
    headers: Record<string, string>,
    body: Buffer | null,
  ): Promise<Response> {
    const path = `/${options.bucket}/${key}`;
    const signed = signS3Request(
      {
        method,
        host: endpoint.host,
        path,
        headers,
        payloadHash: sha256Hex(body ?? ''),
      },
      { credentials: options.credentials, region: R2_REGION, now: options.clock.now() },
    );
    // `host` is set by fetch from the URL, and is a forbidden header name to pass in.
    const { host: _host, ...wireHeaders } = signed.headers;
    const url = `${endpoint.origin}${s3CanonicalUri(path)}`;
    try {
      return await doFetch(url, {
        method,
        headers: wireHeaders,
        ...(body === null ? {} : { body }),
        redirect: 'error',
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      throw new Error(`R2 ${method} ${key} failed: ${describeNetworkError(error)}`, {
        cause: error,
      });
    }
  }

  return {
    async put(object: ObjectToStore) {
      const headers: Record<string, string> = {
        'content-type': object.contentType,
        'cache-control': object.cacheControl,
      };
      for (const [name, value] of Object.entries(object.metadata)) {
        if (!META_NAME_RE.test(name) || !META_VALUE_RE.test(value)) {
          throw new RangeError(`metadata ${JSON.stringify(name)} is not a safe header`);
        }
        headers[`${META_PREFIX}${name}`] = value;
      }
      const response = await send('PUT', object.key, headers, Buffer.from(object.body, 'utf8'));
      if (!response.ok) {
        throw new Error(`R2 PUT ${object.key} failed: ${await describeFailure(response)}`);
      }
      await response.body?.cancel();
      return { etag: response.headers.get('etag') };
    },

    async head(key: string): Promise<StoredObjectHead | null> {
      const response = await send('HEAD', key, {}, null);
      if (response.status === 404) return null;
      if (!response.ok) {
        throw new Error(`R2 HEAD ${key} failed: HTTP ${String(response.status)}`);
      }
      return readHead(response.headers);
    },
  };
}

export function readHead(headers: Headers): StoredObjectHead {
  const metadata: Record<string, string> = {};
  headers.forEach((value, name) => {
    const lower = name.toLowerCase();
    if (lower.startsWith(META_PREFIX)) metadata[lower.slice(META_PREFIX.length)] = value;
  });
  const length = headers.get('content-length');
  const lastModified = parseHttpDate(headers.get('last-modified'));
  return {
    etag: headers.get('etag'),
    contentLength: length === null || !/^\d+$/.test(length) ? null : Number(length),
    lastModifiedMs: lastModified,
    metadata,
  };
}

/** An IMF-fixdate (`Sun, 06 Nov 1994 08:49:37 GMT`); anything else is `null`, not a guess. */
export function parseHttpDate(value: string | null): number | null {
  if (value === null) return null;
  if (!/^[A-Z][a-z]{2}, \d{2} [A-Z][a-z]{2} \d{4} \d{2}:\d{2}:\d{2} GMT$/.test(value.trim())) {
    return null;
  }
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : ms;
}

async function describeFailure(response: Response): Promise<string> {
  let code: string | null = null;
  try {
    const text = (await response.text()).slice(0, 4096);
    code = /<Code>([A-Za-z0-9]{1,64})<\/Code>/.exec(text)?.[1] ?? null;
  } catch {
    // The status alone is still a useful line.
  }
  return code === null
    ? `HTTP ${String(response.status)}`
    : `HTTP ${String(response.status)} ${code}`;
}

function describeNetworkError(error: unknown): string {
  if (error instanceof Error) {
    return error.name === 'TimeoutError' ? 'timed out' : `${error.name}: ${error.message}`;
  }
  return String(error);
}
