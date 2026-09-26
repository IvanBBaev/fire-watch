import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { FEED_STATUS_DIR, createFsFeedStatusStore } from './fs-feed-status-store.js';

const temporaries: string[] = [];

const freshRoot = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'fw-feed-status-'));
  temporaries.push(dir);
  return dir;
};

afterEach(() => {
  for (const dir of temporaries.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const T0 = 1_765_620_900_000;
const T1 = T0 + 3_600_000;
const T2 = T0 + 7_200_000;

describe('createFsFeedStatusStore', () => {
  it('refuses a relative root', () => {
    expect(() => createFsFeedStatusStore('var/state')).toThrow(/absolute/);
  });

  it('maps a row id to a colon-free filename', async () => {
    const root = freshRoot();
    const store = createFsFeedStatusStore(root);

    await store.recordAttempt({
      row: 'effis:layers',
      attemptAt: T0,
      succeeded: true,
      hadData: true,
      error: null,
    });

    expect(readdirSync(join(root, FEED_STATUS_DIR))).toEqual(['effis-layers.json']);
  });

  it('tracks success and failure the way source_status does', async () => {
    const root = freshRoot();
    const store = createFsFeedStatusStore(root);

    await store.recordAttempt({
      row: 'weather:context',
      attemptAt: T0,
      succeeded: true,
      hadData: true,
      error: null,
    });
    await store.recordAttempt({
      row: 'weather:context',
      attemptAt: T1,
      succeeded: false,
      hadData: false,
      error: 'step 0: ECMWF returned 503',
    });
    await store.recordAttempt({
      row: 'weather:context',
      attemptAt: T2,
      succeeded: false,
      hadData: false,
      error: 'step 0: ECMWF returned 503',
    });

    const [observation] = await store.readObservations(['weather:context']);
    expect(observation).toEqual({
      row: 'weather:context',
      lastAttemptAt: T2,
      lastSuccessAt: T0, // preserved from the good attempt
      lastDataAt: T0,
      consecutiveFailures: 2,
    });
  });

  it('resets the failure streak on the next success without losing lastDataAt', async () => {
    const root = freshRoot();
    const store = createFsFeedStatusStore(root);

    await store.recordAttempt({
      row: 'effis:layers',
      attemptAt: T0,
      succeeded: true,
      hadData: true,
      error: null,
    });
    await store.recordAttempt({
      row: 'effis:layers',
      attemptAt: T1,
      succeeded: false,
      hadData: false,
      error: 'fwi: suspect size',
    });
    // Succeeded, but nothing new arrived — hadData false must not clobber lastDataAt.
    await store.recordAttempt({
      row: 'effis:layers',
      attemptAt: T2,
      succeeded: true,
      hadData: false,
      error: null,
    });

    const [observation] = await store.readObservations(['effis:layers']);
    expect(observation).toEqual({
      row: 'effis:layers',
      lastAttemptAt: T2,
      lastSuccessAt: T2,
      lastDataAt: T0,
      consecutiveFailures: 0,
    });
  });

  it('omits rows never recorded instead of inventing empty ones', async () => {
    const store = createFsFeedStatusStore(freshRoot());
    expect(await store.readObservations(['effis:layers', 'effis-refresh'])).toEqual([]);
  });

  it('never answers for registered source rows — those belong to Postgres', async () => {
    const root = freshRoot();
    // Even a file physically present under the store's directory must be ignored:
    // answering would double-report the row when combined with the Postgres reader.
    mkdirSync(join(root, FEED_STATUS_DIR), { recursive: true });
    writeFileSync(
      join(root, FEED_STATUS_DIR, 'firms-viirs-noaa20.json'),
      `${JSON.stringify({
        row: 'firms:viirs:noaa20',
        last_attempt_at: T0,
        last_success_at: T0,
        last_data_at: T0,
        consecutive_failures: 0,
        last_error: null,
      })}\n`,
    );
    const store = createFsFeedStatusStore(root);

    expect(await store.readObservations(['firms:viirs:noaa20'])).toEqual([]);
  });

  it('throws on a corrupt file when reading, naming the file', async () => {
    const root = freshRoot();
    mkdirSync(join(root, FEED_STATUS_DIR), { recursive: true });
    writeFileSync(join(root, FEED_STATUS_DIR, 'effis-layers.json'), '{"row": tru');
    const store = createFsFeedStatusStore(root);

    await expect(store.readObservations(['effis:layers'])).rejects.toThrow(
      /unparseable status in .*effis-layers\.json/,
    );
  });

  it('throws on a well-formed file with the wrong shape, naming the file', async () => {
    const root = freshRoot();
    mkdirSync(join(root, FEED_STATUS_DIR), { recursive: true });
    writeFileSync(
      join(root, FEED_STATUS_DIR, 'effis-layers.json'),
      '{"row":"effis:layers","last_attempt_at":"yesterday"}\n',
    );
    const store = createFsFeedStatusStore(root);

    await expect(store.readObservations(['effis:layers'])).rejects.toThrow(
      /malformed status in .*effis-layers\.json/,
    );
  });

  it('heals a corrupt file on the next recorded attempt', async () => {
    const root = freshRoot();
    mkdirSync(join(root, FEED_STATUS_DIR), { recursive: true });
    writeFileSync(join(root, FEED_STATUS_DIR, 'effis-layers.json'), 'not json');
    const store = createFsFeedStatusStore(root);

    await store.recordAttempt({
      row: 'effis:layers',
      attemptAt: T1,
      succeeded: false,
      hadData: false,
      error: 'fwi: EFFIS returned 503',
    });

    const [observation] = await store.readObservations(['effis:layers']);
    expect(observation).toEqual({
      row: 'effis:layers',
      lastAttemptAt: T1,
      lastSuccessAt: null, // history was lost to the corruption; not invented
      lastDataAt: null,
      consecutiveFailures: 1,
    });
  });

  it('leaves no .partial residue and writes canonical JSON with a trailing newline', async () => {
    const root = freshRoot();
    const store = createFsFeedStatusStore(root);

    await store.recordAttempt({
      row: 'effis-refresh',
      attemptAt: T0,
      succeeded: true,
      hadData: true,
      error: null,
    });

    expect(readdirSync(join(root, FEED_STATUS_DIR))).toEqual(['effis-refresh.json']);
    const raw = readFileSync(join(root, FEED_STATUS_DIR, 'effis-refresh.json'), 'utf8');
    expect(raw.endsWith('\n')).toBe(true);
    expect(JSON.parse(raw)).toEqual({
      row: 'effis-refresh',
      last_attempt_at: T0,
      last_success_at: T0,
      last_data_at: T0,
      consecutive_failures: 0,
      last_error: null,
    });
  });
});
