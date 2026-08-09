import { describe, expect, it } from 'vitest';

import { defineConfig } from '../config/versioned-config.js';
import type { Clock } from '../ports/clock.js';
import type {
  AppendResult,
  DetectionRecord,
  DetectionStore,
  PollAttempt,
} from '../ports/detection-store.js';
import type {
  DetectionUidFn,
  FirmsAreaClient,
  FirmsAreaQuery,
  FirmsAreaResponse,
} from '../ports/firms-client.js';
import type {
  IngestBatchRecord,
  QuarantineEntry,
  QuarantineStore,
} from '../ports/quarantine-store.js';
import { cycleFailed, runIngestCycle, type IngestCycleDeps } from './ingest-cycle.js';

const HEADER =
  'country_id,latitude,longitude,bright_ti4,scan,track,acq_date,acq_time,satellite,' +
  'instrument,confidence,version,bright_ti5,frp,daynight\n';

function row(latitude: string, time = '1124'): string {
  return `BGR,${latitude},26.14003,330.5,0.39,0.36,2026-08-02,${time},N,VIIRS,n,2.0NRT,295.1,12.5,D\n`;
}

const AVAILABLE_AT = 1_785_670_170_000; // 2026-08-02T11:29:30Z
const NOW = 1_785_670_200_000; // 2026-08-02T11:30:00Z

/**
 * Not the real one — the cycle does not care what a uid looks like, only that equal rows
 * mint equal ones. The frozen recipe has its own tests in `@fire-watch/contracts`.
 */
const detectionUid: DetectionUidFn = (parts) =>
  `${parts.source}|${parts.acqTsIso}|${parts.lat}|${parts.lon}`;

function fixedClock(now = NOW): Clock {
  return { now: () => now };
}

interface StubClient extends FirmsAreaClient {
  readonly queries: FirmsAreaQuery[];
}

/** Answers every source with the same body, unless a per-product answer is given. */
function stubClient(answer: (query: FirmsAreaQuery) => string | Error): StubClient {
  const queries: FirmsAreaQuery[] = [];
  return {
    queries,
    fetchArea(query: FirmsAreaQuery): Promise<FirmsAreaResponse> {
      queries.push(query);
      const outcome = answer(query);
      return outcome instanceof Error
        ? Promise.reject(outcome)
        : Promise.resolve({ csv: outcome, availableAt: AVAILABLE_AT });
    },
  };
}

interface StubStore extends DetectionStore {
  readonly appended: DetectionRecord[][];
  readonly attempts: PollAttempt[];
}

interface StubStoreOptions {
  readonly appendThrows?: Error;
  readonly attemptThrows?: Error;
  /** How many of the batch were already there; the rest count as inserted. */
  readonly alreadyPresent?: number;
}

function stubStore(options: StubStoreOptions = {}): StubStore {
  const appended: DetectionRecord[][] = [];
  const attempts: PollAttempt[] = [];
  return {
    appended,
    attempts,
    appendDetections(records: readonly DetectionRecord[]): Promise<AppendResult> {
      if (options.appendThrows) return Promise.reject(options.appendThrows);
      appended.push([...records]);
      const alreadyPresent = Math.min(options.alreadyPresent ?? 0, records.length);
      return Promise.resolve({
        received: records.length,
        inserted: records.length - alreadyPresent,
        alreadyPresent,
      });
    },
    recordPollAttempt(attempt: PollAttempt): Promise<void> {
      if (options.attemptThrows) return Promise.reject(options.attemptThrows);
      attempts.push(attempt);
      return Promise.resolve();
    },
  };
}

interface StubQuarantineStore extends QuarantineStore {
  readonly batches: IngestBatchRecord[];
  readonly entries: QuarantineEntry[];
  /** What the breaker asked its own history for; the window size is a config claim. */
  readonly windows: { readonly limit: number }[];
}

interface StubQuarantineOptions {
  /** The trailing batch sizes, most recent first, as the store would return them. */
  readonly trailing?: readonly number[];
  readonly recentThrows?: Error;
  readonly quarantineThrows?: Error;
  readonly recordThrows?: Error;
}

function stubQuarantineStore(options: StubQuarantineOptions = {}): StubQuarantineStore {
  const batches: IngestBatchRecord[] = [];
  const entries: QuarantineEntry[] = [];
  const windows: { readonly limit: number }[] = [];
  const store: StubQuarantineStore = {
    batches,
    entries,
    windows,
    recordBatch(batch) {
      if (options.recordThrows) return Promise.reject(options.recordThrows);
      batches.push(batch);
      return Promise.resolve();
    },
    quarantine(next) {
      if (options.quarantineThrows) return Promise.reject(options.quarantineThrows);
      entries.push(...next);
      return Promise.resolve();
    },
    recentBatchSizes(_source, limit) {
      windows.push({ limit });
      if (options.recentThrows) return Promise.reject(options.recentThrows);
      return Promise.resolve((options.trailing ?? []).slice(0, limit));
    },
  };
  return store;
}

/**
 * Small enough to trip on three rows. The production floor is 500 rows over twelve
 * samples, and a fixture that reproduced it would be a 500-line CSV asserting nothing
 * about the cycle — which is exactly why the config is a dependency.
 */
const TEST_ANOMALY = defineConfig('ingest_anomaly', 'ingest_anomaly_test_v1', {
  ratio: 2,
  minBatchSize: 2,
  minSamples: 2,
  windowSize: 4,
});

function deps(overrides: Partial<IngestCycleDeps> = {}): IngestCycleDeps {
  return {
    client: stubClient(() => HEADER + row('41.85012')),
    detectionUid,
    store: stubStore(),
    quarantineStore: stubQuarantineStore(),
    clock: fixedClock(),
    sources: ['firms:viirs:snpp'],
    ...overrides,
  };
}

describe('runIngestCycle', () => {
  it('polls every live source when it is not told which', async () => {
    const client = stubClient(() => HEADER);

    // Built without `sources` rather than with an undefined one — the point of the test is
    // the key being absent, which is what the CLI does.
    const report = await runIngestCycle({
      client,
      detectionUid,
      store: stubStore(),
      quarantineStore: stubQuarantineStore(),
      clock: fixedClock(),
    });

    expect(report.sources.map((result) => result.source)).toEqual([
      'firms:viirs:snpp',
      'firms:viirs:noaa20',
      'firms:viirs:noaa21',
    ]);
    // The retired source is never queried live — it stays in the registry for backfill.
    expect(client.queries.map((query) => query.product)).not.toContain('MODIS_NRT');
  });

  it('appends what the poll produced and records the attempt', async () => {
    const store = stubStore();

    const report = await runIngestCycle(deps({ store }));

    expect(store.appended).toHaveLength(1);
    expect(store.appended[0]).toHaveLength(1);
    expect(store.attempts).toEqual([
      {
        source: 'firms:viirs:snpp',
        attemptAt: AVAILABLE_AT,
        succeeded: true,
        receivedRows: 1,
        error: null,
      },
    ]);
    expect(report.sources[0]).toMatchObject({
      outcome: 'stored',
      availableAt: AVAILABLE_AT,
      received: 1,
      inserted: 1,
      alreadyPresent: 0,
      error: null,
    });
  });

  it('reports the re-polled rows the overlap deliberately produces', async () => {
    // `day_range=2` re-sends yesterday's rows on purpose (pitfall 2); they land as no-ops
    // (pitfall 3) and the count is how we see the mechanism working rather than guess.
    const store = stubStore({ alreadyPresent: 2 });
    const client = stubClient(() => HEADER + row('41.85012') + row('41.85013') + row('41.85014'));

    const report = await runIngestCycle(deps({ client, store }));

    expect(report.sources[0]).toMatchObject({ received: 3, inserted: 1, alreadyPresent: 2 });
  });

  it('records a healthy empty poll as a success with no data', async () => {
    const store = stubStore();

    const report = await runIngestCycle(deps({ client: stubClient(() => HEADER), store }));

    expect(report.sources[0]).toMatchObject({ outcome: 'stored', received: 0, inserted: 0 });
    expect(store.attempts[0]).toMatchObject({ succeeded: true, receivedRows: 0 });
    // The batch is handed over empty rather than skipped: whether an empty batch is worth
    // a statement is the store's business, and it already answers no.
    expect(store.appended).toEqual([[]]);
  });

  it('records a failed poll instead of throwing, and appends nothing', async () => {
    const store = stubStore();
    const client = stubClient(() => new Error('FIRMS returned 503'));

    const report = await runIngestCycle(deps({ client, store }));

    expect(report.sources[0]).toMatchObject({
      outcome: 'poll_failed',
      availableAt: null,
      received: 0,
      inserted: 0,
      error: 'FIRMS returned 503',
    });
    expect(store.appended).toEqual([]);
    expect(store.attempts[0]).toMatchObject({
      succeeded: false,
      error: 'FIRMS returned 503',
      // Stamped from the clock: nothing became available, but the attempt still happened.
      attemptAt: NOW,
    });
  });

  it('lets one source fail without taking the others down', async () => {
    const store = stubStore();
    const client = stubClient((query) =>
      query.source === 'firms:viirs:noaa20' ? new Error('ETIMEDOUT') : HEADER + row('41.85012'),
    );

    const report = await runIngestCycle(
      deps({
        client,
        store,
        sources: ['firms:viirs:snpp', 'firms:viirs:noaa20', 'firms:viirs:noaa21'],
      }),
    );

    expect(report.sources.map((result) => result.outcome)).toEqual([
      'stored',
      'poll_failed',
      'stored',
    ]);
    expect(store.attempts).toHaveLength(3);
  });

  it('treats rows that could not be written as data we do not hold', async () => {
    // The HTTP call succeeded, so it is tempting to call the poll a success. It is not:
    // freshness answers "what is in the archive", and these rows are not in it.
    const store = stubStore({ appendThrows: new Error('deadlock detected') });

    const report = await runIngestCycle(deps({ store }));

    expect(report.sources[0]).toMatchObject({
      outcome: 'write_failed',
      received: 1,
      inserted: 0,
      error: 'deadlock detected',
    });
    expect(store.attempts[0]).toMatchObject({ succeeded: false, error: 'deadlock detected' });
  });

  it('surfaces a freshness write that failed, which nothing downstream could infer', async () => {
    const store = stubStore({ attemptThrows: new Error('connection terminated') });

    const report = await runIngestCycle(deps({ store }));

    expect(report.sources[0]).toMatchObject({
      outcome: 'status_write_failed',
      // The rows did land — the counts, not the outcome, are what say so.
      inserted: 1,
      error: 'connection terminated',
    });
  });

  it('keeps both reasons when a poll failed and its record could not be written', async () => {
    const store = stubStore({ attemptThrows: new Error('connection terminated') });
    const client = stubClient(() => new Error('FIRMS returned 503'));

    const report = await runIngestCycle(deps({ client, store }));

    expect(report.sources[0]?.outcome).toBe('status_write_failed');
    expect(report.sources[0]?.error).toBe('FIRMS returned 503; connection terminated');
  });

  it('counts rows the parser refused without letting them stop the batch', async () => {
    const client = stubClient(() => HEADER + row('41.85012') + row('not-a-latitude'));

    const report = await runIngestCycle(deps({ client }));

    expect(report.sources[0]).toMatchObject({ outcome: 'stored', received: 1, rejected: 1 });
  });

  it('counts a row the response repeated within one poll', async () => {
    const client = stubClient(() => HEADER + row('41.85012') + row('41.85012'));

    const report = await runIngestCycle(deps({ client }));

    expect(report.sources[0]).toMatchObject({ received: 1, duplicatesWithinBatch: 1 });
  });

  it('quarantines a row that parses and is then wrong, rather than landing it', async () => {
    // A fire in Poland, from a box that stops at 46°N. The parser is happy — every column
    // is a number — and that is precisely the failure validation exists for.
    const store = stubStore();
    const quarantineStore = stubQuarantineStore();
    const client = stubClient(() => HEADER + row('41.85012') + row('52.10000'));

    const report = await runIngestCycle(deps({ client, store, quarantineStore }));

    expect(report.sources[0]).toMatchObject({ received: 2, quarantined: 1, inserted: 1 });
    expect(store.appended[0]).toHaveLength(1);
    expect(quarantineStore.entries).toHaveLength(1);
    expect(quarantineStore.entries[0]).toMatchObject({
      scope: 'row',
      source: 'firms:viirs:snpp',
      availableAt: AVAILABLE_AT,
      rowIndex: 2,
    });
    expect(quarantineStore.entries[0]?.reason).toContain('outside_polling_bbox');
    // The bytes, so the diagnosis can be re-made from what arrived rather than from a
    // summary of what we thought had arrived.
    expect(quarantineStore.entries[0]?.raw).toContain('52.10000');
  });

  it('keeps the delivered bytes of a row the parser could not read', async () => {
    const quarantineStore = stubQuarantineStore();
    const client = stubClient(() => HEADER + row('41.85012') + row('not-a-latitude'));

    await runIngestCycle(deps({ client, quarantineStore }));

    expect(quarantineStore.entries).toHaveLength(1);
    expect(quarantineStore.entries[0]).toMatchObject({
      scope: 'row',
      rowIndex: 2,
      // The parser refused it, so it was never identified — there is no uid to record.
      detectionUid: null,
    });
    expect(quarantineStore.entries[0]?.raw).toContain('not-a-latitude');
  });

  it('records the counts and the verdict of a poll that was entirely healthy', async () => {
    const quarantineStore = stubQuarantineStore({ trailing: [1, 1, 1, 1] });

    await runIngestCycle(deps({ quarantineStore, anomalyConfig: TEST_ANOMALY }));

    // A batch row for every successful poll, anomalous or not: the baseline is built from
    // these, and a history with only the strange days in it is not a baseline.
    expect(quarantineStore.batches).toHaveLength(1);
    expect(quarantineStore.batches[0]).toMatchObject({
      source: 'firms:viirs:snpp',
      availableAt: AVAILABLE_AT,
      received: 1,
      inserted: 1,
      alreadyPresent: 0,
      rejected: 0,
      quarantined: 0,
      // Below the floor, not within the baseline: one row is not a flood at any ratio.
      anomalyVerdict: 'below_floor',
      anomalyTripped: false,
      baseline: 1,
      ingestConfigVersion: 'ingest_anomaly_test_v1',
      pollingBboxVersion: 'polling_bbox_v1',
    });
    expect(quarantineStore.entries).toEqual([]);
  });

  it('asks the history for exactly the window the config claims', async () => {
    const quarantineStore = stubQuarantineStore();

    await runIngestCycle(deps({ quarantineStore }));

    expect(quarantineStore.windows).toEqual([{ limit: 24 }]);
  });

  it('brackets the cycle with the clock so a slow cycle is visible as one', async () => {
    let tick = NOW;
    const clock: Clock = { now: () => (tick += 1000) };

    const report = await runIngestCycle(deps({ clock }));

    expect(report.finishedAt).toBeGreaterThan(report.startedAt);
  });
});

describe('the anomaly breaker leg', () => {
  const flood = () =>
    stubClient(() => HEADER + row('41.85012') + row('41.85013') + row('41.85014'));

  it('flags every row of a tripped batch and still lands them', async () => {
    // A false trip on the biggest fire day of the season must not become permanent data
    // loss: the season cannot be re-polled, so the rows land marked and a human clears them.
    const store = stubStore();
    const quarantineStore = stubQuarantineStore({ trailing: [1, 1, 1, 1] });

    const report = await runIngestCycle(
      deps({ client: flood(), store, quarantineStore, anomalyConfig: TEST_ANOMALY }),
    );

    expect(report.sources[0]).toMatchObject({ outcome: 'stored', received: 3, inserted: 3 });
    expect(report.sources[0]?.anomaly).toEqual({
      tripped: true,
      verdict: 'above_baseline',
      baseline: 1,
      ratio: 3,
      configVersion: 'ingest_anomaly_test_v1',
    });
    expect(store.appended[0]?.map((record) => record.quarantined)).toEqual([true, true, true]);
  });

  it('quarantines the verdict itself, once, for the batch as a whole', async () => {
    const quarantineStore = stubQuarantineStore({ trailing: [1, 1, 1, 1] });

    await runIngestCycle(deps({ client: flood(), quarantineStore, anomalyConfig: TEST_ANOMALY }));

    expect(quarantineStore.entries).toHaveLength(1);
    expect(quarantineStore.entries[0]).toMatchObject({
      scope: 'batch',
      // A batch-scope entry points at no row and carries no bytes; the batch is the subject.
      rowIndex: null,
      detectionUid: null,
      raw: null,
    });
    expect(quarantineStore.entries[0]?.reason).toContain('above_baseline');
    expect(quarantineStore.batches[0]).toMatchObject({ anomalyTripped: true, ratio: 3 });
  });

  it('does not arm itself against a source that has barely any history', async () => {
    const store = stubStore();
    const quarantineStore = stubQuarantineStore({ trailing: [1] });

    const report = await runIngestCycle(
      deps({ client: flood(), store, quarantineStore, anomalyConfig: TEST_ANOMALY }),
    );

    expect(report.sources[0]?.anomaly).toMatchObject({
      tripped: false,
      verdict: 'not_enough_history',
      baseline: null,
    });
    expect(store.appended[0]?.every((record) => !record.quarantined)).toBe(true);
  });

  it('fails open when it cannot read its own history', async () => {
    // A safety device over the archive that cannot read its history must not stop a season
    // being captured. The rows land unflagged and the read failure is what gets reported.
    const store = stubStore();
    const quarantineStore = stubQuarantineStore({
      trailing: [1, 1, 1, 1],
      recentThrows: new Error('relation "ingest_batches" does not exist'),
    });

    const report = await runIngestCycle(
      deps({ client: flood(), store, quarantineStore, anomalyConfig: TEST_ANOMALY }),
    );

    expect(report.sources[0]).toMatchObject({
      outcome: 'quarantine_write_failed',
      inserted: 3,
      error: 'relation "ingest_batches" does not exist',
    });
    expect(report.sources[0]?.anomaly).toMatchObject({ verdict: 'not_enough_history' });
    expect(store.appended[0]?.every((record) => !record.quarantined)).toBe(true);
  });

  it('still records the batch when the quarantine write failed, and the other way round', async () => {
    // The two answer different questions; losing one is no reason to lose the other.
    const quarantineStore = stubQuarantineStore({
      trailing: [1, 1, 1, 1],
      quarantineThrows: new Error('quarantine insert failed'),
    });

    const report = await runIngestCycle(
      deps({ client: flood(), quarantineStore, anomalyConfig: TEST_ANOMALY }),
    );

    expect(report.sources[0]).toMatchObject({
      outcome: 'quarantine_write_failed',
      // Ranked below the archive's own write on purpose: the rows are safe.
      inserted: 3,
      error: 'quarantine insert failed',
    });
    expect(quarantineStore.batches).toHaveLength(1);
  });

  it('keeps the freshness row honest when only the bookkeeping failed', async () => {
    // The rows did reach the archive, so freshness must not claim otherwise — what was
    // lost is the record of how they were judged, not the data.
    const store = stubStore();
    const quarantineStore = stubQuarantineStore({
      recordThrows: new Error('ingest_batches insert failed'),
    });

    await runIngestCycle(deps({ store, quarantineStore }));

    expect(store.attempts[0]).toMatchObject({ succeeded: true, error: null });
  });
});

describe('cycleFailed', () => {
  const result = {
    source: 'firms:viirs:snpp' as const,
    availableAt: AVAILABLE_AT,
    received: 1,
    inserted: 1,
    alreadyPresent: 0,
    rejected: 0,
    quarantined: 0,
    duplicatesWithinBatch: 0,
    anomaly: null,
    error: null,
  };

  it('is false when a single source is out — that is what the budgets are for', () => {
    expect(
      cycleFailed({
        startedAt: NOW,
        finishedAt: NOW,
        sources: [
          { ...result, outcome: 'stored' },
          { ...result, outcome: 'poll_failed' },
        ],
      }),
    ).toBe(false);
  });

  it('is true when nothing at all reached the archive', () => {
    expect(
      cycleFailed({
        startedAt: NOW,
        finishedAt: NOW,
        sources: [
          { ...result, outcome: 'poll_failed' },
          { ...result, outcome: 'write_failed' },
        ],
      }),
    ).toBe(true);
  });

  it('is true when the archive could not record what happened', () => {
    expect(
      cycleFailed({
        startedAt: NOW,
        finishedAt: NOW,
        sources: [
          { ...result, outcome: 'stored' },
          { ...result, outcome: 'status_write_failed' },
        ],
      }),
    ).toBe(true);
  });

  it('is true for a cycle that polled nothing, which is a wiring bug', () => {
    expect(cycleFailed({ startedAt: NOW, finishedAt: NOW, sources: [] })).toBe(true);
  });
});
