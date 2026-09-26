import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { MANIFEST_PATH } from '../../core/backfill/backfill-manifest.js';
import { createFsArchiveStore } from './fs-archive-store.js';

const CSV = 'latitude,longitude,acq_date\n42.10000,24.70000,2024-01-01\n';

const temporaries: string[] = [];

function scratchStore() {
  const root = mkdtempSync(join(tmpdir(), 'fw-archive-'));
  temporaries.push(root);
  return { root, store: createFsArchiveStore(root) };
}

afterEach(() => {
  for (const directory of temporaries.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('createFsArchiveStore', () => {
  it("refuses a relative archive root — it would depend on the operator's cwd", () => {
    expect(() => createFsArchiveStore('archive')).toThrow(/absolute/);
  });

  it('writes nested paths, reports real byte counts and real sha256', async () => {
    const { store } = scratchStore();
    const path = 'firms/VIIRS_SNPP_SP/2024/VIIRS_SNPP_SP_2024-01-01_10d.csv';

    const written = await store.writeFile(path, CSV);

    expect(written.bytes).toBe(Buffer.byteLength(CSV, 'utf8'));
    expect(written.sha256).toBe(createHash('sha256').update(CSV, 'utf8').digest('hex'));
    expect(await store.fileSize(path)).toBe(written.bytes);
    expect(await store.fileSha256(path)).toBe(written.sha256);
  });

  it('leaves no .partial behind — the temp name exists only mid-write', async () => {
    const { root, store } = scratchStore();
    const path = 'firms/MODIS_SP/2020/MODIS_SP_2020-01-01_10d.csv';

    await store.writeFile(path, CSV);

    const directory = join(root, 'firms/MODIS_SP/2020');
    expect(readdirSync(directory)).toEqual(['MODIS_SP_2020-01-01_10d.csv']);
    expect(existsSync(join(root, `${path}.partial`))).toBe(false);
  });

  it('answers null, not an error, for files that do not exist yet', async () => {
    const { store } = scratchStore();

    expect(await store.fileSize('firms/MODIS_SP/2020/absent.csv')).toBeNull();
    expect(await store.fileSha256('firms/MODIS_SP/2020/absent.csv')).toBeNull();
    expect(await store.readManifest()).toBeNull();
  });

  it('refuses paths that escape the archive root — the manifest is editable on disk', async () => {
    const { store } = scratchStore();

    await expect(store.fileSha256('../outside.csv')).rejects.toThrow(/escapes/);
    await expect(store.writeFile('/etc/hosts', CSV)).rejects.toThrow(/escapes/);
    await expect(store.fileSize('firms/../../outside.csv')).rejects.toThrow(/escapes/);
  });

  it('round-trips the manifest at its documented path', async () => {
    const { root, store } = scratchStore();
    const text = '{\n  "manifest_version": 1\n}\n';

    await store.writeManifest(text);

    expect(await store.readManifest()).toBe(text);
    expect(existsSync(join(root, MANIFEST_PATH))).toBe(true);
    expect(existsSync(join(root, `${MANIFEST_PATH}.partial`))).toBe(false);
  });

  it('overwrites atomically: a rewrite replaces the file, never appends or truncates', async () => {
    const { store } = scratchStore();
    const path = 'firms/MODIS_SP/2020/MODIS_SP_2020-01-01_10d.csv';
    await store.writeFile(path, 'latitude,longitude\nold\n');

    const written = await store.writeFile(path, CSV);

    expect(await store.fileSize(path)).toBe(written.bytes);
    expect(await store.fileSha256(path)).toBe(
      createHash('sha256').update(CSV, 'utf8').digest('hex'),
    );
  });
});
