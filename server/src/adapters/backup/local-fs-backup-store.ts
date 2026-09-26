/**
 * A backup store on a local (or mounted) directory — the alternative to R2 for a
 * self-hosted second disk, a drill on a laptop, and the tests (TASKS C6).
 *
 * The layout is the bucket's: `<root>/<key>`, with the upload metadata in a
 * `<key>.meta.json` sidecar that `list` never returns. Directories are 0700, files 0600.
 *
 * A directory has no lifecycle rules, so this store enforces the retention policy itself:
 * every upload ends with a sweep that deletes what {@link planRetention} says has expired
 * (erasure-aware — a personal artifact never outlives its 28 days here either). The sweep
 * deletes only objects in our key layout; anything else in the directory is left alone.
 *
 * Keys are validated against the backup key layout before they touch a path, so a key
 * can never climb out of the root.
 */

import { createReadStream } from 'node:fs';
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, relative, sep } from 'node:path';

import { parseBackupObjectKey } from '../../core/backup/backup-keys.js';
import type {
  BackupObjectReader,
  BackupObjectWriter,
  FetchedArtifact,
  StagedArtifact,
} from '../../core/backup/ports.js';
import {
  BACKUP_RETENTION,
  planRetention,
  type BackupRetentionPolicy,
  type ListedObject,
} from '../../core/backup/retention.js';
import type { Clock } from '../../core/ports/clock.js';
import { writeHashed } from './r2-backup-store.js';

const META_SUFFIX = '.meta.json';
const SHA256_RE = /^[0-9a-f]{64}$/;

export interface LocalFsBackupStoreOptions {
  /** Absolute directory; created (0700) on first upload. */
  readonly root: string;
  readonly clock: Clock;
  readonly policy?: BackupRetentionPolicy;
  /** Reports each swept key; never a path outside the root. */
  readonly onSwept?: (key: string) => void;
}

export type LocalFsBackupStore = BackupObjectWriter &
  BackupObjectReader & {
    /** Deletes what the policy says has expired; returns the deleted keys. */
    sweep(): Promise<readonly string[]>;
  };

export function createLocalFsBackupStore(options: LocalFsBackupStoreOptions): LocalFsBackupStore {
  const policy = options.policy ?? BACKUP_RETENTION;

  function pathOf(key: string): string {
    if (parseBackupObjectKey(key) === null) {
      throw new RangeError(`${JSON.stringify(key)} is not a backup object key`);
    }
    return join(options.root, ...key.split('/'));
  }

  async function listAll(): Promise<ListedObject[]> {
    const out: ListedObject[] = [];
    let entries;
    try {
      entries = await readdir(options.root, { recursive: true, withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return out;
      throw error;
    }
    for (const entry of entries) {
      if (!entry.isFile() || entry.name.endsWith(META_SUFFIX)) continue;
      const key = relative(options.root, join(entry.parentPath, entry.name)).split(sep).join('/');
      out.push({ key, lastModifiedMs: null, sizeBytes: null });
    }
    return out;
  }

  async function sweep(): Promise<readonly string[]> {
    const plan = planRetention(await listAll(), options.clock.now(), policy);
    const swept: string[] = [];
    for (const verdict of plan.verdicts) {
      if (verdict.action !== 'expire') continue;
      const path = pathOf(verdict.key);
      await rm(path, { force: true });
      await rm(`${path}${META_SUFFIX}`, { force: true });
      swept.push(verdict.key);
      options.onSwept?.(verdict.key);
    }
    return swept;
  }

  return {
    async upload(key: string, artifact: StagedArtifact, metadata) {
      const path = pathOf(key);
      await mkdir(dirname(path), { recursive: true, mode: 0o700 });
      // An existing object is replaced, as a PUT would: remove it first, then write `wx`.
      await rm(path, { force: true });
      const written = await writeHashed(createReadStream(artifact.path), path);
      if (written.sha256 !== artifact.sha256) {
        await rm(path, { force: true });
        throw new Error(`${key}: the stored bytes do not hash to the staged sha256`);
      }
      await writeFile(`${path}${META_SUFFIX}`, `${JSON.stringify(metadata)}\n`, { mode: 0o600 });
      await sweep();
      return { etag: null };
    },

    async list(prefix: string): Promise<readonly ListedObject[]> {
      return (await listAll()).filter((o) => o.key.startsWith(prefix));
    },

    async download(key: string, destinationPath: string): Promise<FetchedArtifact | null> {
      const path = pathOf(key);
      let source: ReturnType<typeof createReadStream> | undefined;
      try {
        source = createReadStream(path);
        await new Promise<void>((resolve, reject) => {
          source?.once('open', () => resolve()).once('error', reject);
        });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
        throw error;
      }
      const { bytes, sha256 } = await writeHashed(source, destinationPath);
      return { key, path: destinationPath, bytes, sha256, recordedSha256: await recordedSha(path) };
    },

    sweep,
  };
}

async function recordedSha(path: string): Promise<string | null> {
  try {
    const meta = JSON.parse(await readFile(`${path}${META_SUFFIX}`, 'utf8')) as unknown;
    const value =
      typeof meta === 'object' && meta !== null
        ? (meta as Record<string, unknown>)['sha256']
        : null;
    return typeof value === 'string' && SHA256_RE.test(value) ? value : null;
  } catch {
    return null;
  }
}
