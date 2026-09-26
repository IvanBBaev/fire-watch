/**
 * The R2 static-mirror settings, read from the environment (TASKS E3; ADR-003 D1 tier T2).
 *
 * In its own module rather than in `app/config.ts` because only the worker pushes the
 * mirror: the API and every CLI must boot without the bucket's read-write token, and must
 * never be handed one (OPERATIONS §8.1: "R2 token — snapshot push: read-write,
 * separate token").
 *
 * Four variables, configured together or not at all:
 *
 *   * FIRE_WATCH_R2_ENDPOINT — the S3 API origin, `https://<account>.r2.cloudflarestorage.com`
 *     (or `<account>.eu.r2…` for the EU jurisdiction). Origin only: no path, query or userinfo.
 *   * FIRE_WATCH_R2_BUCKET — the bucket name (S3 naming rules).
 *   * FIRE_WATCH_R2_ACCESS_KEY_ID + FIRE_WATCH_R2_SECRET_ACCESS_KEY — an R2 API token's S3
 *     credentials, scoped to that bucket, read-write.
 *
 * Plus FIRE_WATCH_R2_OBJECT_KEY, optional (default `snapshot.json`), refused without the group.
 *
 * The public URL the age monitor HEADs is not a new variable: it is the existing
 * FIRE_WATCH_STATIC_SNAPSHOT_URL, the one clients are told in `client-config`. When both are
 * set its path must be exactly `/<object key>` — otherwise clients would flip to an object
 * this job never writes, and read it as stale forever.
 *
 * **No value ever reaches an error or a log line.** Every message names a variable, never
 * its content; {@link describeR2MirrorConfig} prints the endpoint host, bucket and key, and
 * says only whether credentials are set.
 */

import { DEFAULT_MIRROR_OBJECT_KEY, isValidMirrorKey } from '../core/snapshot/mirror-plan.js';
import type { Environment } from './config.js';
import { ConfigError } from './config.js';

export interface R2MirrorConfig {
  /** Origin of the S3 API endpoint, no trailing slash. */
  readonly endpoint: string;
  readonly bucket: string;
  readonly objectKey: string;
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  /** The public URL of the object (FIRE_WATCH_STATIC_SNAPSHOT_URL), or `null`: no age monitor. */
  readonly publicUrl: string | null;
}

const GROUP = [
  'FIRE_WATCH_R2_ENDPOINT',
  'FIRE_WATCH_R2_BUCKET',
  'FIRE_WATCH_R2_ACCESS_KEY_ID',
  'FIRE_WATCH_R2_SECRET_ACCESS_KEY',
] as const;
const OBJECT_KEY = 'FIRE_WATCH_R2_OBJECT_KEY';

/** S3 bucket naming: 3-63 of lower-case letters, digits and hyphens, alphanumeric at both ends. */
const BUCKET_RE = /^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/;
/** Shape only — R2 issues 32 hex / 64 hex, but S3-compatible stores vary. */
const ACCESS_KEY_ID_RE = /^[A-Za-z0-9]{16,128}$/;
const SECRET_RE = /^[A-Za-z0-9/+=]{20,128}$/;

export function loadR2MirrorConfig(
  env: Environment,
  staticSnapshotUrl: string | null,
): R2MirrorConfig | null {
  const group = readGroup(env, GROUP);
  const keyText = env[OBJECT_KEY]?.trim() ?? '';
  if (group === null) {
    if (keyText !== '') {
      throw new ConfigError(`${OBJECT_KEY} is set but FIRE_WATCH_R2_ENDPOINT is not`);
    }
    return null;
  }

  const endpoint = readEndpoint(group.FIRE_WATCH_R2_ENDPOINT);
  if (!BUCKET_RE.test(group.FIRE_WATCH_R2_BUCKET)) {
    throw new ConfigError('FIRE_WATCH_R2_BUCKET is not a valid bucket name');
  }
  if (!ACCESS_KEY_ID_RE.test(group.FIRE_WATCH_R2_ACCESS_KEY_ID)) {
    throw new ConfigError('FIRE_WATCH_R2_ACCESS_KEY_ID does not look like an access key id');
  }
  if (!SECRET_RE.test(group.FIRE_WATCH_R2_SECRET_ACCESS_KEY)) {
    throw new ConfigError('FIRE_WATCH_R2_SECRET_ACCESS_KEY does not look like a secret access key');
  }
  if (group.FIRE_WATCH_R2_SECRET_ACCESS_KEY === group.FIRE_WATCH_R2_ACCESS_KEY_ID) {
    throw new ConfigError('FIRE_WATCH_R2_SECRET_ACCESS_KEY repeats FIRE_WATCH_R2_ACCESS_KEY_ID');
  }

  const objectKey = keyText === '' ? DEFAULT_MIRROR_OBJECT_KEY : keyText;
  if (!isValidMirrorKey(objectKey)) {
    throw new ConfigError(
      `${OBJECT_KEY} must be '/'-separated segments of letters, digits, '.', '_', '-'`,
    );
  }
  if (staticSnapshotUrl !== null && new URL(staticSnapshotUrl).pathname !== `/${objectKey}`) {
    throw new ConfigError(
      `FIRE_WATCH_STATIC_SNAPSHOT_URL must end in /${objectKey}, the object this worker uploads`,
    );
  }

  return {
    endpoint,
    bucket: group.FIRE_WATCH_R2_BUCKET,
    objectKey,
    accessKeyId: group.FIRE_WATCH_R2_ACCESS_KEY_ID,
    secretAccessKey: group.FIRE_WATCH_R2_SECRET_ACCESS_KEY,
    publicUrl: staticSnapshotUrl,
  };
}

/** Safe to print: no credential, not even the access key id. */
export function describeR2MirrorConfig(config: R2MirrorConfig | null): Record<string, unknown> {
  if (config === null) return { r2_mirror: 'unset' };
  return {
    r2_endpoint_host: new URL(config.endpoint).host,
    r2_bucket: config.bucket,
    r2_object_key: config.objectKey,
    r2_credentials: 'set',
    r2_public_url: config.publicUrl ?? '<not configured>',
  };
}

function readEndpoint(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new ConfigError('FIRE_WATCH_R2_ENDPOINT is not a URL');
  }
  if (url.protocol !== 'https:') {
    throw new ConfigError('FIRE_WATCH_R2_ENDPOINT must be https');
  }
  if (url.username !== '' || url.password !== '') {
    throw new ConfigError('FIRE_WATCH_R2_ENDPOINT must not carry credentials');
  }
  if (url.pathname !== '/' || url.search !== '' || url.hash !== '') {
    // A bucket in the path would be signed twice; the bucket has its own variable.
    throw new ConfigError('FIRE_WATCH_R2_ENDPOINT must be an origin, with no path or query');
  }
  return url.origin;
}

// Local copy of app/config.ts's unexported helper (same rules as zones-config.ts): a group
// is all present or all absent, and a partial group names only the variables missing.
function readGroup<const Names extends readonly string[]>(
  env: Environment,
  names: Names,
): Readonly<Record<Names[number], string>> | null {
  const present: Partial<Record<Names[number], string>> = {};
  const missing: string[] = [];
  for (const name of names) {
    const value = env[name]?.trim();
    if (value === undefined || value === '') missing.push(name);
    else present[name as Names[number]] = value;
  }
  if (missing.length === names.length) return null;
  if (missing.length > 0) {
    throw new ConfigError(
      `${names.join(', ')} are configured together or not at all; missing: ${missing.join(', ')}`,
    );
  }
  return present as Readonly<Record<Names[number], string>>;
}
