/**
 * The backup artifacts' R2 bucket over the S3 API (TASKS C6; OPERATIONS §6.2).
 *
 * Two sides with two credentials, deliberately:
 *
 *   * the **writer** (`PUT`) runs on the VM, whose token is write-only: a compromised VM
 *     can add artifacts but can neither read the personal set back nor delete history;
 *   * the **reader** (`GET`, `ListObjectsV2`) runs wherever the restore runs, with a read
 *     token the VM never holds.
 *
 * Retention is not enforced here: it is the bucket's lifecycle rules
 * (`core/backup/retention.ts` → `lifecycleRules`), which the write-only token cannot
 * change either. The restore re-checks the listing against the erasure horizon.
 *
 * Artifacts are streamed from and to disk — a dump is not held in memory. The upload is
 * signed with the SHA-256 the pipeline computed while writing the file, so R2 refuses a
 * body that does not hash to it: a file changed or truncated after the dump is never
 * stored. The download is hashed while it lands and compared by the restore against the
 * `sha256` metadata recorded at upload.
 *
 * Same error discipline as `adapters/storage/r2-object-store.ts`: status and S3 error
 * code only, never a provider body, never a credential.
 */

import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { unlink } from 'node:fs/promises';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { ReadableStream as WebReadableStream } from 'node:stream/web';

import type {
  BackupObjectReader,
  BackupObjectWriter,
  FetchedArtifact,
  StagedArtifact,
} from '../../core/backup/ports.js';
import type { ListedObject } from '../../core/backup/retention.js';
import type { Clock } from '../../core/ports/clock.js';
import {
  canonicalQueryString,
  EMPTY_PAYLOAD_SHA256,
  s3CanonicalUri,
  signS3Request,
  type S3Credentials,
} from '../storage/s3-sigv4.js';
import { R2_REGION } from '../storage/r2-object-store.js';

/** A night's artifact is minutes of transfer on a small VM, not seconds. */
export const BACKUP_TRANSFER_TIMEOUT_MS = 30 * 60_000;
export const BACKUP_LIST_TIMEOUT_MS = 30_000;
/** A runaway listing is a bug or a foreign bucket; the real one holds ~100 objects. */
export const MAX_LIST_PAGES = 50;

const META_PREFIX = 'x-amz-meta-';
const META_NAME_RE = /^[a-z0-9-]+$/;
const META_VALUE_RE = /^[\x20-\x7e]*$/;
const SHA256_RE = /^[0-9a-f]{64}$/;

export interface R2BackupStoreOptions {
  /** The S3 API endpoint origin, e.g. `https://<account>.eu.r2.cloudflarestorage.com`. */
  readonly endpoint: string;
  readonly bucket: string;
  readonly credentials: S3Credentials;
  readonly clock: Clock;
  readonly fetch?: typeof fetch;
  readonly transferTimeoutMs?: number;
  readonly listTimeoutMs?: number;
}

export type R2BackupStore = BackupObjectWriter & BackupObjectReader;

export function createR2BackupStore(options: R2BackupStoreOptions): R2BackupStore {
  const endpoint = new URL(options.endpoint);
  const doFetch = options.fetch ?? fetch;
  const transferTimeoutMs = options.transferTimeoutMs ?? BACKUP_TRANSFER_TIMEOUT_MS;
  const listTimeoutMs = options.listTimeoutMs ?? BACKUP_LIST_TIMEOUT_MS;

  async function send(input: {
    readonly method: 'PUT' | 'GET';
    readonly path: string;
    readonly what: string;
    readonly query?: readonly (readonly [string, string])[];
    readonly headers?: Record<string, string>;
    readonly payloadHash: string;
    readonly body?: Readable;
    readonly timeoutMs: number;
  }): Promise<Response> {
    const query = input.query ?? [];
    const signed = signS3Request(
      {
        method: input.method,
        host: endpoint.host,
        path: input.path,
        query,
        headers: input.headers ?? {},
        payloadHash: input.payloadHash,
      },
      { credentials: options.credentials, region: R2_REGION, now: options.clock.now() },
    );
    const { host: _host, ...wireHeaders } = signed.headers;
    // The wire query is the canonical one, so what is signed and what is sent cannot drift.
    const search = canonicalQueryString(query);
    const url = `${endpoint.origin}${s3CanonicalUri(input.path)}${search === '' ? '' : `?${search}`}`;
    try {
      return await doFetch(url, {
        method: input.method,
        headers: wireHeaders,
        ...(input.body === undefined
          ? {}
          : {
              body: input.body,
              duplex: 'half' as const,
            }),
        redirect: 'error',
        signal: AbortSignal.timeout(input.timeoutMs),
      });
    } catch (error) {
      throw new Error(`R2 ${input.method} ${input.what} failed: ${describeNetworkError(error)}`, {
        cause: error,
      });
    }
  }

  return {
    async upload(key: string, artifact: StagedArtifact, metadata) {
      const headers: Record<string, string> = {
        'content-type': 'application/octet-stream',
        'content-length': String(artifact.bytes),
      };
      for (const [name, value] of Object.entries(metadata)) {
        if (!META_NAME_RE.test(name) || !META_VALUE_RE.test(value)) {
          throw new RangeError(`metadata ${JSON.stringify(name)} is not a safe header`);
        }
        headers[`${META_PREFIX}${name}`] = value;
      }
      if (!SHA256_RE.test(artifact.sha256)) {
        throw new RangeError('the staged artifact carries no valid sha256');
      }
      const response = await send({
        method: 'PUT',
        path: `/${options.bucket}/${key}`,
        what: key,
        headers,
        payloadHash: artifact.sha256,
        body: createReadStream(artifact.path),
        timeoutMs: transferTimeoutMs,
      });
      if (!response.ok) {
        throw new Error(`R2 PUT ${key} failed: ${await describeFailure(response)}`);
      }
      await response.body?.cancel().catch(() => undefined);
      return { etag: response.headers.get('etag') };
    },

    async list(prefix: string): Promise<readonly ListedObject[]> {
      const out: ListedObject[] = [];
      let token: string | null = null;
      for (let page = 0; page < MAX_LIST_PAGES; page += 1) {
        const query: [string, string][] = [
          ['list-type', '2'],
          ['prefix', prefix],
        ];
        if (token !== null) query.push(['continuation-token', token]);
        const response = await send({
          method: 'GET',
          path: `/${options.bucket}`,
          what: `list ${prefix}`,
          query,
          payloadHash: EMPTY_PAYLOAD_SHA256,
          timeoutMs: listTimeoutMs,
        });
        if (!response.ok) {
          throw new Error(`R2 GET list ${prefix} failed: ${await describeFailure(response)}`);
        }
        const parsed = parseListObjectsV2(await response.text());
        out.push(...parsed.objects);
        if (!parsed.truncated || parsed.nextToken === null) return out;
        token = parsed.nextToken;
      }
      throw new Error(`R2 list ${prefix} exceeded ${String(MAX_LIST_PAGES)} pages`);
    },

    async download(key: string, destinationPath: string): Promise<FetchedArtifact | null> {
      const response = await send({
        method: 'GET',
        path: `/${options.bucket}/${key}`,
        what: key,
        payloadHash: EMPTY_PAYLOAD_SHA256,
        timeoutMs: transferTimeoutMs,
      });
      if (response.status === 404) {
        await response.body?.cancel().catch(() => undefined);
        return null;
      }
      if (!response.ok || response.body === null) {
        throw new Error(`R2 GET ${key} failed: ${await describeFailure(response)}`);
      }
      const recorded = response.headers.get(`${META_PREFIX}sha256`);
      const { bytes, sha256 } = await writeHashed(
        Readable.fromWeb(response.body as WebReadableStream<Uint8Array>),
        destinationPath,
      );
      return {
        key,
        path: destinationPath,
        bytes,
        sha256,
        recordedSha256: recorded !== null && SHA256_RE.test(recorded) ? recorded : null,
      };
    },
  };
}

/**
 * Streams into a new file (`wx`, 0600) while hashing; removes the partial file on
 * failure. Shared with the local-fs store.
 */
export async function writeHashed(
  source: Readable,
  destinationPath: string,
): Promise<{ readonly bytes: number; readonly sha256: string }> {
  const hash = createHash('sha256');
  let bytes = 0;
  try {
    await pipeline(
      source,
      new Transform({
        transform(chunk: Buffer, _encoding, callback) {
          hash.update(chunk);
          bytes += chunk.length;
          callback(null, chunk);
        },
      }),
      createWriteStream(destinationPath, { flags: 'wx', mode: 0o600 }),
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
      await unlink(destinationPath).catch(() => undefined);
    }
    const code = (error as NodeJS.ErrnoException).code;
    throw new Error(`writing ${destinationPath} failed: ${code ?? describeNetworkError(error)}`, {
      cause: error,
    });
  }
  return { bytes, sha256: hash.digest('hex') };
}

export interface ListPage {
  readonly objects: readonly ListedObject[];
  readonly truncated: boolean;
  readonly nextToken: string | null;
}

/** The fields of a `ListBucketResult` the retention audit reads; nothing else. */
export function parseListObjectsV2(xml: string): ListPage {
  const objects: ListedObject[] = [];
  for (const match of xml.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)) {
    const body = match[1] ?? '';
    const key = tag(body, 'Key');
    if (key === null) continue;
    const modified = tag(body, 'LastModified');
    const size = tag(body, 'Size');
    const modifiedMs = modified === null ? Number.NaN : Date.parse(modified);
    objects.push({
      key,
      lastModifiedMs: Number.isNaN(modifiedMs) ? null : modifiedMs,
      sizeBytes: size !== null && /^\d+$/.test(size) ? Number(size) : null,
    });
  }
  return {
    objects,
    truncated: tag(xml.replace(/<Contents>[\s\S]*?<\/Contents>/g, ''), 'IsTruncated') === 'true',
    nextToken: tag(xml, 'NextContinuationToken'),
  };
}

function tag(xml: string, name: string): string | null {
  const match = new RegExp(`<${name}>([\\s\\S]*?)</${name}>`).exec(xml);
  return match?.[1] === undefined ? null : decodeXml(match[1]);
}

function decodeXml(text: string): string {
  return text.replace(/&(amp|lt|gt|quot|apos|#\d+|#x[0-9a-fA-F]+);/g, (_all, entity: string) => {
    switch (entity) {
      case 'amp':
        return '&';
      case 'lt':
        return '<';
      case 'gt':
        return '>';
      case 'quot':
        return '"';
      case 'apos':
        return "'";
      default:
        return String.fromCodePoint(
          entity.startsWith('#x') ? parseInt(entity.slice(2), 16) : parseInt(entity.slice(1), 10),
        );
    }
  });
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
