import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { MANIFEST_PATH } from '../../core/backfill/backfill-manifest.js';
import { createFsSpArchiveReader } from './fs-sp-archive-reader.js';

describe('createFsSpArchiveReader', () => {
  let root = '';

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'fw-sp-archive-'));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('requires an absolute archive root', () => {
    expect(() => createFsSpArchiveReader('relative/dir')).toThrow(/absolute/);
  });

  it('reads a file under the root and answers null for a missing one', async () => {
    const relativePath = 'firms/VIIRS_SNPP_SP/2020/VIIRS_SNPP_SP_2020-07-01_10d.csv';
    await mkdir(dirname(join(root, relativePath)), { recursive: true });
    await writeFile(join(root, relativePath), 'header\n', 'utf8');

    const reader = createFsSpArchiveReader(root);
    await expect(reader.readFile(relativePath)).resolves.toBe('header\n');
    await expect(reader.readFile('firms/nope.csv')).resolves.toBeNull();
  });

  it('reads the backfill manifest and answers null when absent', async () => {
    const reader = createFsSpArchiveReader(root);
    await expect(reader.readManifest()).resolves.toBeNull();

    await mkdir(dirname(join(root, MANIFEST_PATH)), { recursive: true });
    await writeFile(join(root, MANIFEST_PATH), '{"schema":1}', 'utf8');
    await expect(reader.readManifest()).resolves.toBe('{"schema":1}');
  });

  it.each(['../outside.txt', '/etc/passwd', ''])(
    'refuses a path that escapes the root: %j',
    async (relativePath) => {
      const reader = createFsSpArchiveReader(root);
      await expect(reader.readFile(relativePath)).rejects.toThrow(RangeError);
    },
  );
});
