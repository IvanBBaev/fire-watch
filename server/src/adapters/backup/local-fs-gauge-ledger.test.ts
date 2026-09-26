import { mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { TableGaugeSnapshot } from '../../core/backup/table-gauges.js';
import { createLocalFsGaugeLedger, TABLE_GAUGE_LEDGER_FILE } from './local-fs-gauge-ledger.js';

const SNAPSHOT: TableGaugeSnapshot = {
  takenAt: '2026-09-24T02:20:00Z',
  gauges: [
    { relation: 'accounts', set: 'personal', rows: 2, bytes: 16_384 },
    { relation: 'detections', set: 'main', rows: 1500, bytes: 2_000_000 },
  ],
};

describe('createLocalFsGaugeLedger', () => {
  let dir: string;
  let file: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'fw-gauge-ledger-'));
    file = join(dir, 'staging', TABLE_GAUGE_LEDGER_FILE);
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('reads nothing before the first write', async () => {
    await expect(createLocalFsGaugeLedger(file).read()).resolves.toBeNull();
  });

  it('round-trips a snapshot, 0600, with no temporary file left behind', async () => {
    const ledger = createLocalFsGaugeLedger(file);
    await ledger.write(SNAPSHOT);
    await expect(ledger.read()).resolves.toEqual(SNAPSHOT);
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    expect(await readdir(join(dir, 'staging'))).toEqual([TABLE_GAUGE_LEDGER_FILE]);
    expect(await readFile(file, 'utf8')).toMatch(/\n$/);
  });

  it('replaces the previous night', async () => {
    const ledger = createLocalFsGaugeLedger(file);
    await ledger.write(SNAPSHOT);
    const next = { ...SNAPSHOT, takenAt: '2026-09-25T02:20:00Z' };
    await ledger.write(next);
    await expect(ledger.read()).resolves.toEqual(next);
  });

  it('reads a corrupt or foreign file as no previous night', async () => {
    const ledger = createLocalFsGaugeLedger(file);
    await ledger.write(SNAPSHOT);
    await writeFile(file, '{"takenAt":', 'utf8');
    await expect(ledger.read()).resolves.toBeNull();
    await writeFile(file, '{"takenAt":"yesterday","gauges":[]}', 'utf8');
    await expect(ledger.read()).resolves.toBeNull();
  });
});
