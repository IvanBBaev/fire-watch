/**
 * The filesystem `SpArchiveReader` (TASKS C7) — read-only access to the same directory
 * layout `fs-archive-store` writes: chunk CSVs under their manifest-recorded relative
 * paths, the manifest at its fixed location. Same containment rule as the writer, for
 * the same reason: every path this adapter touches must resolve inside the archive
 * root, so a manifest edited by hand cannot walk the promotion out of the archive.
 */

import { readFile } from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';

import { MANIFEST_PATH } from '../../core/backfill/backfill-manifest.js';
import type { SpArchiveReader } from '../../core/ports/sp-archive-reader.js';

export function createFsSpArchiveReader(rootDir: string): SpArchiveReader {
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

  const read = async (relativePath: string): Promise<string | null> => {
    try {
      return await readFile(abs(relativePath), 'utf8');
    } catch (error) {
      if (isEnoent(error)) return null;
      throw error;
    }
  };

  return {
    readFile: read,
    readManifest: () => read(MANIFEST_PATH),
  };
}

function isEnoent(error: unknown): boolean {
  return (
    error instanceof Error && 'code' in error && (error as NodeJS.ErrnoException).code === 'ENOENT'
  );
}
