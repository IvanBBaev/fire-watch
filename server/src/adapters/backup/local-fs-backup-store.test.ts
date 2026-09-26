import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import { backupObjectKey } from '../../core/backup/backup-keys.js';
import { epochMsFromIso, VirtualClock } from '../../core/ports/clock.js';
import { createLocalFsBackupStore } from './local-fs-backup-store.js';

const DAY = 86_400_000;
const dir = mkdtempSync(join(tmpdir(), 'fw-local-backup-'));
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

let n = 0;
function staged(content: string) {
  n += 1;
  const path = join(dir, `staged-${String(n)}.age`);
  writeFileSync(path, content);
  return {
    path,
    bytes: content.length,
    sha256: createHash('sha256').update(content).digest('hex'),
  };
}

const NOW = '2026-09-24T02:30:00Z';
const TONIGHT = epochMsFromIso('2026-09-24T02:20:00Z');

describe('local-fs backup store', () => {
  it('round-trips an artifact with its recorded sha256, 0700 dirs and 0600 files', async () => {
    const root = join(dir, 'roundtrip');
    const store = createLocalFsBackupStore({ root, clock: new VirtualClock(NOW) });
    const key = backupObjectKey('main', 'daily', TONIGHT).key;
    const artifact = staged('main-bytes');
    await store.upload(key, artifact, { sha256: artifact.sha256, 'backup-set': 'main' });

    expect(await store.list('fw-main/')).toEqual([{ key, lastModifiedMs: null, sizeBytes: null }]);
    expect(await store.list('fw-personal/')).toEqual([]);
    expect(statSync(join(root, key)).mode & 0o777).toBe(0o600);
    expect(statSync(join(root, 'fw-main')).mode & 0o777).toBe(0o700);

    const dest = join(dir, 'restored.age');
    const fetched = await store.download(key, dest);
    expect(fetched).toEqual({
      key,
      path: dest,
      bytes: 10,
      sha256: artifact.sha256,
      recordedSha256: artifact.sha256,
    });
  });

  it('returns null for an absent object and an empty listing for an absent root', async () => {
    const store = createLocalFsBackupStore({
      root: join(dir, 'absent'),
      clock: new VirtualClock(NOW),
    });
    expect(await store.list('fw-main/')).toEqual([]);
    const key = backupObjectKey('main', 'daily', TONIGHT).key;
    expect(await store.download(key, join(dir, 'never.age'))).toBeNull();
  });

  it('refuses a key outside the backup layout (no path traversal)', async () => {
    const store = createLocalFsBackupStore({
      root: join(dir, 'safe'),
      clock: new VirtualClock(NOW),
    });
    await expect(store.upload('../../etc/passwd', staged('x'), {})).rejects.toThrow(RangeError);
    await expect(store.download('fw-main/../x', join(dir, 'x'))).rejects.toThrow(RangeError);
  });

  it('refuses bytes that do not hash to the staged sha256', async () => {
    const root = join(dir, 'mismatch');
    const store = createLocalFsBackupStore({ root, clock: new VirtualClock(NOW) });
    const key = backupObjectKey('main', 'daily', TONIGHT).key;
    await expect(
      store.upload(key, { ...staged('abc'), sha256: 'b'.repeat(64) }, {}),
    ).rejects.toThrow(/do not hash/);
    expect(existsSync(join(root, key))).toBe(false);
  });

  it('sweeps expired artifacts on upload, erasure-aware, and leaves foreign files alone', async () => {
    const root = join(dir, 'sweep');
    const swept: string[] = [];
    const store = createLocalFsBackupStore({
      root,
      clock: new VirtualClock(NOW),
      onSwept: (key) => swept.push(key),
    });
    const oldPersonal = backupObjectKey('personal', 'daily', TONIGHT - 28 * DAY).key;
    const youngPersonal = backupObjectKey('personal', 'daily', TONIGHT - 27 * DAY).key;
    const oldMain = backupObjectKey('main', 'daily', TONIGHT - 14 * DAY).key;
    const weeklyMain = backupObjectKey('main', 'weekly', TONIGHT - 14 * DAY).key;
    for (const key of [oldPersonal, youngPersonal, oldMain, weeklyMain]) {
      mkdirSync(join(root, key, '..'), { recursive: true });
      writeFileSync(join(root, key), 'x');
      writeFileSync(join(root, `${key}.meta.json`), '{}');
    }
    writeFileSync(join(root, 'README'), 'operator notes');

    await store.upload(backupObjectKey('main', 'daily', TONIGHT).key, staged('tonight'), {});

    expect(swept.sort()).toEqual([oldMain, oldPersonal].sort());
    expect(existsSync(join(root, oldPersonal))).toBe(false);
    expect(existsSync(join(root, `${oldPersonal}.meta.json`))).toBe(false);
    expect(existsSync(join(root, youngPersonal))).toBe(true);
    expect(existsSync(join(root, weeklyMain))).toBe(true);
    expect(existsSync(join(root, 'README'))).toBe(true);
  });
});
