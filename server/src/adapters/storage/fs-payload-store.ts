/**
 * The `PayloadStore` port on a real disk (TASKS C4).
 *
 * Deliberately the same construction as the backfill archive store — absolute root
 * required, escape-checked paths, `.partial` + rename so a name that exists always
 * holds a whole file — because the EFFIS proxy's serve-stale promise stands on that
 * rename: `current.png` flips from the old good copy to the new good copy in one atomic
 * step, and a reader mid-refresh never sees anything in between.
 *
 * Not merged with the archive store: that port speaks strings because CSV is text; this
 * one speaks bytes because a PNG or a GRIB2 message must never round-trip through one.
 */

import { createHash } from 'node:crypto';
import { mkdir, rename, stat, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve } from 'node:path';

import type { PayloadStore, PayloadWriteResult } from '../../core/ports/payload-store.js';

export function createFsPayloadStore(rootDir: string): PayloadStore {
  if (!isAbsolute(rootDir)) {
    throw new RangeError(`payload root must be an absolute path, got ${JSON.stringify(rootDir)}`);
  }
  const root = resolve(rootDir);

  const abs = (relativePath: string): string => {
    const target = resolve(root, relativePath);
    const within = relative(root, target);
    if (within === '' || within.startsWith('..') || isAbsolute(within)) {
      throw new RangeError(
        `payload path escapes the payload root: ${JSON.stringify(relativePath)}`,
      );
    }
    return target;
  };

  const writeAtomically = async (target: string, contents: Buffer): Promise<PayloadWriteResult> => {
    await mkdir(dirname(target), { recursive: true });
    const partial = `${target}.partial`;
    await writeFile(partial, contents);
    await rename(partial, target);
    // Hashed from the same buffer that was written: the provenance sidecar records what
    // this process stored, not what the disk happened to contain afterwards.
    return {
      bytes: contents.byteLength,
      sha256: createHash('sha256').update(contents).digest('hex'),
    };
  };

  return {
    async exists(relativePath: string): Promise<boolean> {
      try {
        const info = await stat(abs(relativePath));
        return info.isFile();
      } catch (error) {
        if (isEnoent(error)) return false;
        throw error;
      }
    },

    async writePayload(relativePath: string, bytes: Uint8Array): Promise<PayloadWriteResult> {
      return writeAtomically(abs(relativePath), Buffer.from(bytes));
    },

    async writeText(relativePath: string, text: string): Promise<PayloadWriteResult> {
      return writeAtomically(abs(relativePath), Buffer.from(text, 'utf8'));
    },
  };
}

function isEnoent(error: unknown): boolean {
  return (
    error instanceof Error && 'code' in error && (error as NodeJS.ErrnoException).code === 'ENOENT'
  );
}
