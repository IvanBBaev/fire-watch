import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  IMAGERY_KILL_SWITCH_FILE,
  IMAGERY_STATE_DIR,
  IMAGERY_USAGE_FILE,
  createFsImageryMeterStore,
  imageryOverrideFile,
  imageryTripFile,
  parseImageryUsage,
} from './fs-imagery-meter-store.js';

const temporaries: string[] = [];

const freshRoot = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'fw-imagery-meter-'));
  temporaries.push(dir);
  return dir;
};

afterEach(() => {
  for (const dir of temporaries.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const T0 = 1_790_157_600_000;

describe('createFsImageryMeterStore', () => {
  it('refuses a relative root', () => {
    expect(() => createFsImageryMeterStore('var/state')).toThrow(/absolute/);
  });

  it('reads nothing on a fresh host, without creating anything', async () => {
    const root = freshRoot();
    expect(await createFsImageryMeterStore(root).read('2026-09')).toEqual({
      killSwitch: false,
      override: false,
      tripped: false,
      usage: null,
    });
  });

  it('reads switches from presence and scopes the override and latch to their period', async () => {
    const root = freshRoot();
    const dir = join(root, IMAGERY_STATE_DIR);
    mkdirSync(dir);
    writeFileSync(join(dir, IMAGERY_KILL_SWITCH_FILE), 'false\n');
    writeFileSync(join(dir, imageryOverrideFile('2026-09')), '');
    writeFileSync(join(dir, imageryTripFile('2026-09')), '');
    const store = createFsImageryMeterStore(root);

    expect(await store.read('2026-09')).toMatchObject({
      killSwitch: true,
      override: true,
      tripped: true,
    });
    expect(await store.read('2026-10')).toMatchObject({
      killSwitch: true,
      override: false,
      tripped: false,
    });
  });

  it('reads the usage file, which is how a quota exhaustion is simulated', async () => {
    const root = freshRoot();
    const dir = join(root, IMAGERY_STATE_DIR);
    mkdirSync(dir);
    writeFileSync(join(dir, IMAGERY_USAGE_FILE), '{"period":"2026-09","tiles":1999999}\n');
    expect((await createFsImageryMeterStore(root).read('2026-09')).usage).toEqual({
      period: '2026-09',
      tiles: 1_999_999,
    });
  });

  it('fails closed on a malformed usage file or an unreadable directory', async () => {
    const root = freshRoot();
    const dir = join(root, IMAGERY_STATE_DIR);
    mkdirSync(dir);
    writeFileSync(join(dir, IMAGERY_USAGE_FILE), '{"period":"2026-09"}');
    await expect(createFsImageryMeterStore(root).read('2026-09')).rejects.toThrow(/tiles/);

    const other = freshRoot();
    writeFileSync(join(other, IMAGERY_STATE_DIR), '');
    await expect(createFsImageryMeterStore(other).read('2026-09')).rejects.toThrow();
  });

  it('latches once per period and keeps the first instant', async () => {
    const root = freshRoot();
    const store = createFsImageryMeterStore(root);
    await store.latchTrip('2026-09', T0, 'usage 2 >= ceiling 1');
    await store.latchTrip('2026-09', T0 + 1, 'second');
    const latch = join(root, IMAGERY_STATE_DIR, imageryTripFile('2026-09'));
    expect(readFileSync(latch, 'utf8')).toBe(
      `{"at":${String(T0)},"detail":"usage 2 >= ceiling 1"}\n`,
    );
    expect((await store.read('2026-09')).tripped).toBe(true);
    expect((await store.read('2026-10')).tripped).toBe(false);
  });

  it('refuses a period that could escape its file name', async () => {
    const store = createFsImageryMeterStore(freshRoot());
    await expect(store.read('../x')).rejects.toThrow(RangeError);
    expect(() => imageryTripFile('2026-9')).toThrow(RangeError);
  });
});

describe('parseImageryUsage', () => {
  it('accepts exactly a period and a non-negative integer count', () => {
    expect(parseImageryUsage('{"period":"2026-09","tiles":0}')).toEqual({
      period: '2026-09',
      tiles: 0,
    });
    expect(() => parseImageryUsage('nope')).toThrow(/JSON/);
    expect(() => parseImageryUsage('[]')).toThrow(/object/);
    expect(() => parseImageryUsage('{"period":"2026-13","tiles":1}')).toThrow(/period/);
    expect(() => parseImageryUsage('{"period":"2026-09","tiles":-1}')).toThrow(/tiles/);
    expect(() => parseImageryUsage('{"period":"2026-09","tiles":"5"}')).toThrow(/tiles/);
  });
});
