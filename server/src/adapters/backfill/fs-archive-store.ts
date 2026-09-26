/**
 * The `ArchiveStore` port on a real disk (TASKS B8).
 *
 * Every write goes to `<name>.partial` first and is renamed into place only once every
 * byte is flushed — rename within one directory is atomic on POSIX, so a name that
 * exists always holds a whole file. That property is what the runner's resume logic
 * stands on; it is stated on the port and honoured here.
 *
 * Paths are resolved against the archive root and refused if they escape it. Chunk
 * paths come from our own plan today, but the manifest is an editable file on disk —
 * a `--check` over a doctored `"path": "../../etc/..."` must fail loudly, not read
 * outside the archive.
 */

import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve } from 'node:path';

import type { ArchiveStore, ArchiveWriteResult } from '../../core/ports/archive-store.js';
import { MANIFEST_PATH } from '../../core/backfill/backfill-manifest.js';

export function createFsArchiveStore(rootDir: string): ArchiveStore {
  if (!isAbsolute(rootDir)) {
    throw new RangeError(`archive root must be an absolute path, got ${JSON.stringify(rootDir)}`);
  }
  const root = resolve(rootDir);

  const abs = (relativePath: string): string => {
    const target = resolve(root, relativePath);
    const within = relative(root, target);
    if (within === '' || within.startsWith('..') || isAbsolute(within)) {
      throw new RangeError(
        `archive path escapes the archive root: ${JSON.stringify(relativePath)}`,
      );
    }
    return target;
  };

  const writeAtomically = async (target: string, contents: string): Promise<void> => {
    await mkdir(dirname(target), { recursive: true });
    const partial = `${target}.partial`;
    await writeFile(partial, contents, 'utf8');
    await rename(partial, target);
  };

  return {
    async fileSize(relativePath: string): Promise<number | null> {
      try {
        const info = await stat(abs(relativePath));
        return info.isFile() ? info.size : null;
      } catch (error) {
        if (isEnoent(error)) return null;
        throw error;
      }
    },

    async fileSha256(relativePath: string): Promise<string | null> {
      try {
        const bytes = await readFile(abs(relativePath));
        return createHash('sha256').update(bytes).digest('hex');
      } catch (error) {
        if (isEnoent(error)) return null;
        throw error;
      }
    },

    async writeFile(relativePath: string, contents: string): Promise<ArchiveWriteResult> {
      const bytes = Buffer.from(contents, 'utf8');
      await writeAtomically(abs(relativePath), contents);
      // Hashed from the same buffer that was written: the manifest records what this
      // process stored, and `--check` re-reads the disk to confirm it is still that.
      return { bytes: bytes.byteLength, sha256: createHash('sha256').update(bytes).digest('hex') };
    },

    async readManifest(): Promise<string | null> {
      try {
        return await readFile(abs(MANIFEST_PATH), 'utf8');
      } catch (error) {
        if (isEnoent(error)) return null;
        throw error;
      }
    },

    async writeManifest(text: string): Promise<void> {
      await writeAtomically(abs(MANIFEST_PATH), text);
    },
  };
}

function isEnoent(error: unknown): boolean {
  return (
    error instanceof Error && 'code' in error && (error as NodeJS.ErrnoException).code === 'ENOENT'
  );
}
