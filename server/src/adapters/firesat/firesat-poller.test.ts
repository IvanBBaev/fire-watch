import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { detectionUid } from '@fire-watch/contracts/node';
import { describe, expect, it } from 'vitest';

import { POLLING_BBOX, firmsAreaArgument } from '../../core/config/polling-bbox.js';
import { detectionRecords } from '../../core/ingest/detection-records.js';
import { fixtureFiresatClient, type FiresatClient } from './firesat-client.js';
import { buildFiresatQuery, isFiresatLive, pollFiresat } from './firesat-poller.js';

const SAMPLE = readFileSync(
  join(import.meta.dirname, '__fixtures__/firesat-balkans-sample.json'),
  'utf8',
);
const AVAILABLE_AT = Date.parse('2026-08-02T21:40:00Z');

describe('FireSat poller', () => {
  it('stays dark while the source is reserved', () => {
    expect(isFiresatLive()).toBe(false);
  });

  it('queries the polled box over two UTC days', () => {
    expect(buildFiresatQuery()).toEqual({
      source: 'efa:firesat',
      product: 'FIRESAT_NRT',
      area: firmsAreaArgument(POLLING_BBOX.values),
      dayRange: 2,
    });
  });

  it('produces a poll run that maps into detection records', async () => {
    const run = await pollFiresat({
      client: fixtureFiresatClient(SAMPLE, AVAILABLE_AT),
      detectionUid,
    });
    expect(run).toMatchObject({
      source: 'efa:firesat',
      outcome: 'ok',
      availableAt: AVAILABLE_AT,
      pollingBboxVersion: POLLING_BBOX.version,
      duplicatesWithinBatch: 1,
    });
    expect(run.detections).toHaveLength(3);
    expect(run.rejections).toHaveLength(1);
    expect(run.rejections[0]!.rowIndex).toBe(5);

    const records = detectionRecords(run);
    expect(records).toHaveLength(3);
    for (const record of records) {
      expect(record).toMatchObject({
        source: 'efa:firesat',
        productTier: 'NRT',
        availableAt: AVAILABLE_AT,
        collectionVersion: '0.9.1',
        quarantined: false,
      });
      expect(record.detectionUid).toBe(
        detectionUid({
          source: 'efa:firesat',
          acqTsIso: record.acqTsIso,
          lat: record.lat,
          lon: record.lon,
        }),
      );
    }
  });

  it('is deterministic whatever the document order', async () => {
    const parsed = JSON.parse(SAMPLE) as { detections: unknown[] };
    const reversed = JSON.stringify({ ...parsed, detections: [...parsed.detections].reverse() });
    const a = await pollFiresat({
      client: fixtureFiresatClient(SAMPLE, AVAILABLE_AT),
      detectionUid,
    });
    const b = await pollFiresat({
      client: fixtureFiresatClient(reversed, AVAILABLE_AT),
      detectionUid,
    });
    expect(b.detections.map((d) => d.detectionUid)).toEqual(
      a.detections.map((d) => d.detectionUid),
    );
  });

  it('records a transport failure as a failed poll, never as no fires', async () => {
    const client: FiresatClient = {
      fetchDetections: () => Promise.reject(new Error('connect ETIMEDOUT')),
    };
    const run = await pollFiresat({ client, detectionUid });
    expect(run).toMatchObject({ outcome: 'failed', error: 'connect ETIMEDOUT', availableAt: null });
    expect(run.detections).toEqual([]);
  });

  it('records an unknown format as a failed poll', async () => {
    const run = await pollFiresat({
      client: fixtureFiresatClient('{"format":"other"}', AVAILABLE_AT),
      detectionUid,
    });
    expect(run).toMatchObject({ outcome: 'failed', availableAt: AVAILABLE_AT });
    expect(run.error).toMatch(/format/);
  });
});
