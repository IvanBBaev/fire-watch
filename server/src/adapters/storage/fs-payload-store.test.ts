import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { createFsPayloadStore } from './fs-payload-store.js';

const temporaries: string[] = [];

const freshRoot = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'fw-payload-store-'));
  temporaries.push(dir);
  return dir;
};

afterEach(() => {
  for (const dir of temporaries.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('createFsPayloadStore', () => {
  it('refuses a relative root', () => {
    expect(() => createFsPayloadStore('var/state')).toThrow(/absolute/);
  });

  it('round-trips bytes exactly and reports their true hash', async () => {
    const root = freshRoot();
    const store = createFsPayloadStore(root);
    const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff, 0x7f]);

    const written = await store.writePayload('overlays/effis/fwi/current.png', bytes);

    const onDisk = readFileSync(join(root, 'overlays/effis/fwi/current.png'));
    expect(new Uint8Array(onDisk)).toEqual(bytes);
    expect(written.bytes).toBe(7);
    expect(written.sha256).toBe(createHash('sha256').update(bytes).digest('hex'));
  });

  it('writes text as UTF-8', async () => {
    const root = freshRoot();
    const store = createFsPayloadStore(root);

    await store.writeText('overlays/effis/fwi/meta.json', '{"sanity":"good"}\n');

    expect(readFileSync(join(root, 'overlays/effis/fwi/meta.json'), 'utf8')).toBe(
      '{"sanity":"good"}\n',
    );
  });

  it('leaves no .partial residue behind a completed write', async () => {
    const root = freshRoot();
    const store = createFsPayloadStore(root);

    await store.writePayload('weather/field.grib2', new Uint8Array(16));

    expect(readdirSync(join(root, 'weather'))).toEqual(['field.grib2']);
  });

  it('answers exists only after the payload landed', async () => {
    const store = createFsPayloadStore(freshRoot());
    expect(await store.exists('weather/field.grib2')).toBe(false);
    await store.writePayload('weather/field.grib2', new Uint8Array(16));
    expect(await store.exists('weather/field.grib2')).toBe(true);
  });

  it('rejects paths that escape the root', async () => {
    const root = freshRoot();
    const store = createFsPayloadStore(root);

    await expect(store.writePayload('../outside.bin', new Uint8Array(1))).rejects.toThrow(
      /escapes the payload root/,
    );
    await expect(store.exists('..')).rejects.toThrow(/escapes the payload root/);
    expect(existsSync(join(root, '..', 'outside.bin'))).toBe(false);
  });
});
