import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  BREAKER_LATCH_FILE,
  DISPATCH_CONTROL_DIR,
  KILL_SWITCH_FILE,
  createFsDispatchControlStore,
} from './fs-dispatch-control-store.js';

const temporaries: string[] = [];

const freshRoot = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'fw-dispatch-control-'));
  temporaries.push(dir);
  return dir;
};

afterEach(() => {
  for (const dir of temporaries.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const T0 = 1_765_620_900_000;

describe('createFsDispatchControlStore', () => {
  it('refuses a relative root', () => {
    expect(() => createFsDispatchControlStore('var/state')).toThrow(/absolute/);
  });

  it('reads both switches open on a fresh host, without creating anything', async () => {
    const root = freshRoot();
    const store = createFsDispatchControlStore(root);
    expect(await store.read()).toEqual({ killSwitch: false, breakerLatched: false });
  });

  it('reads the kill switch from presence alone, whatever the file holds', async () => {
    // `touch` is the one command; an empty file and an operator's note both stop dispatch.
    const root = freshRoot();
    const dir = join(root, DISPATCH_CONTROL_DIR);
    mkdirSync(dir);
    const store = createFsDispatchControlStore(root);

    writeFileSync(join(dir, KILL_SWITCH_FILE), '');
    expect((await store.read()).killSwitch).toBe(true);
    writeFileSync(join(dir, KILL_SWITCH_FILE), 'false\n');
    expect((await store.read()).killSwitch).toBe(true);

    rmSync(join(dir, KILL_SWITCH_FILE));
    expect((await store.read()).killSwitch).toBe(false);
  });

  it('fails closed when the switch cannot be read, rather than reading it open', async () => {
    const root = freshRoot();
    // A file where the directory should be: ENOTDIR, which is not absence.
    writeFileSync(join(root, DISPATCH_CONTROL_DIR), '');
    await expect(createFsDispatchControlStore(root).read()).rejects.toThrow();
  });

  it('latches the breaker once and keeps the first instant', async () => {
    const root = freshRoot();
    const store = createFsDispatchControlStore(root);

    await store.latchBreaker(T0, 'sends 900 over threshold 500');
    await store.latchBreaker(T0 + 10_000, 'a later trip');

    expect(await store.read()).toEqual({ killSwitch: false, breakerLatched: true });
    const latch = readFileSync(join(root, DISPATCH_CONTROL_DIR, BREAKER_LATCH_FILE), 'utf8');
    expect(latch).toBe(`{"at":${String(T0)},"detail":"sends 900 over threshold 500"}\n`);
  });

  it('closes only when a human removes the latch', async () => {
    const root = freshRoot();
    const store = createFsDispatchControlStore(root);
    await store.latchBreaker(T0, 'trip');
    expect((await store.read()).breakerLatched).toBe(true);

    rmSync(join(root, DISPATCH_CONTROL_DIR, BREAKER_LATCH_FILE));
    expect((await store.read()).breakerLatched).toBe(false);
  });
});
