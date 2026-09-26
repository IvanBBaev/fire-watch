import { describe, expect, it } from 'vitest';

import { EMPTY_OBSERVATIONS, parseFixtureManifest, parseReplayBatch } from './fixture-format.js';
import {
  diffAgainstExpected,
  runReplay,
  serializeReport,
  type ReplayAlert,
  type ReplayContext,
  type ReplayDetection,
  type ReplayEngine,
  type ReplayEvent,
  type ReplayFixture,
} from './runner.js';

const uid = (n: number): string => String(n).padStart(64, '0');

interface DetectionSpec {
  readonly n: number;
  readonly source?: string;
  readonly lat?: string;
  readonly lon?: string;
  readonly acqTsIso?: string;
}

const row = (spec: DetectionSpec): Record<string, unknown> => ({
  detectionUid: uid(spec.n),
  source: spec.source ?? 'firms:viirs:snpp',
  acqTsIso: spec.acqTsIso ?? '2026-08-02T11:24:00Z',
  latCanonical: spec.lat ?? '41.85012',
  lonCanonical: spec.lon ?? '26.14003',
  confidence: 'nominal',
  frpMw: 12.5,
  dayNight: 'D',
});

interface BatchSpec {
  readonly name: string;
  readonly availableAt: string;
  readonly detections: readonly DetectionSpec[];
}

function makeFixture(options: {
  readonly mode?: 'live' | 'offline';
  readonly clockStart?: string;
  readonly batches: readonly BatchSpec[];
  readonly expected?: unknown;
}): ReplayFixture {
  const manifest = parseFixtureManifest(
    {
      id: 'T1',
      title: 'runner unit fixture',
      asserts: 'nothing on its own',
      required: 'suite',
      owner: 'WP0',
      engine: 'smoke',
      clockStart: options.clockStart ?? '2026-08-02T11:00:00Z',
      mode: options.mode ?? 'live',
      allowRevive: false,
      configVersions: { clustering: 'clustering_params_v1' },
      inputs: options.batches.map((batch) => batch.name),
      expected: 'expected.json',
    },
    'T1/manifest.json',
  );

  return {
    manifest,
    batches: options.batches.map((batch) =>
      parseReplayBatch(
        { availableAt: batch.availableAt, detections: batch.detections.map(row) },
        batch.name,
      ),
    ),
    expected: options.expected ?? null,
    observations: EMPTY_OBSERVATIONS,
  };
}

/** Records exactly what the harness handed it, so ordering can be asserted directly. */
interface Recording {
  readonly ingests: { readonly clock: number; readonly uids: string[] }[];
  context: ReplayContext | null;
}

function recordingEngine(
  recording: Recording,
  events: readonly ReplayEvent[] = [],
): (context: ReplayContext) => ReplayEngine {
  return (context) => {
    recording.context = context;
    return {
      ingest(batch: readonly ReplayDetection[]): void {
        recording.ingests.push({
          clock: context.clock.now(),
          uids: batch.map((detection) => detection.detectionUid),
        });
      },
      events: () => events,
    };
  };
}

const emptyRecording = (): Recording => ({ ingests: [], context: null });

const event = (overrides: Partial<ReplayEvent> & { publicId: string }): ReplayEvent => ({
  status: 'active',
  displayTier: 'map',
  bucket: 'unverified',
  detectionUids: [],
  mergedInto: null,
  relation: null,
  labels: [],
  ...overrides,
});

const alert = (overrides: Partial<ReplayAlert> & { publicId: string }): ReplayAlert => ({
  zoneId: 'zone-1',
  outcome: 'send',
  reason: 'new_fire',
  alertType: 'new_fire',
  alertSubkey: 'once',
  atIso: '2026-08-02T11:41:00Z',
  ...overrides,
});

describe('runReplay ordering', () => {
  it('hands the engine the canonical batch order, not the file order', () => {
    const recording = emptyRecording();
    const fixture = makeFixture({
      batches: [
        {
          name: 'poll-01.json',
          availableAt: '2026-08-02T11:41:00Z',
          detections: [
            { n: 1, lat: '41.86114' },
            { n: 2, lat: '41.85012' },
            { n: 3, source: 'firms:viirs:noaa20' },
          ],
        },
      ],
    });

    runReplay(fixture, recordingEngine(recording));

    // (available_at, source, lat, lon): noaa20 sorts before snpp, then latitude ascends.
    expect(recording.ingests[0]?.uids).toEqual([uid(3), uid(2), uid(1)]);
  });

  it('breaks a coordinate tie on detection_uid so the order is total', () => {
    const recording = emptyRecording();
    const fixture = makeFixture({
      batches: [
        {
          name: 'poll-01.json',
          availableAt: '2026-08-02T11:41:00Z',
          detections: [
            { n: 9, acqTsIso: '2026-08-02T11:25:00Z' },
            { n: 4, acqTsIso: '2026-08-02T11:26:00Z' },
          ],
        },
      ],
    });

    runReplay(fixture, recordingEngine(recording));

    expect(recording.ingests[0]?.uids).toEqual([uid(4), uid(9)]);
  });

  it('refuses a batch whose rows are not distinguishable', () => {
    // Two rows with the same uid mean an identity bug upstream, not a sorting problem.
    const fixture = makeFixture({
      batches: [
        {
          name: 'poll-01.json',
          availableAt: '2026-08-02T11:41:00Z',
          detections: [{ n: 1 }, { n: 1 }],
        },
      ],
    });

    expect(() => runReplay(fixture, recordingEngine(emptyRecording()))).toThrow(
      /batch ordering is not total/,
    );
  });
});

describe('runReplay clock', () => {
  it('positions the virtual clock on the batch instant before ingest', () => {
    const recording = emptyRecording();
    const fixture = makeFixture({
      batches: [
        { name: 'a.json', availableAt: '2026-08-02T11:41:00Z', detections: [{ n: 1 }] },
        { name: 'b.json', availableAt: '2026-08-02T13:05:00Z', detections: [{ n: 2 }] },
      ],
    });

    runReplay(fixture, recordingEngine(recording));

    expect(recording.ingests.map((ingest) => ingest.clock)).toEqual([
      Date.parse('2026-08-02T11:41:00Z'),
      Date.parse('2026-08-02T13:05:00Z'),
    ]);
  });

  it('accepts two polls that landed in the same minute', () => {
    const recording = emptyRecording();
    const fixture = makeFixture({
      batches: [
        { name: 'a.json', availableAt: '2026-08-02T11:41:00Z', detections: [{ n: 1 }] },
        { name: 'b.json', availableAt: '2026-08-02T11:41:00Z', detections: [{ n: 2 }] },
      ],
    });

    expect(() => runReplay(fixture, recordingEngine(recording))).not.toThrow();
    expect(recording.ingests).toHaveLength(2);
  });

  it('refuses to run polls backwards', () => {
    const fixture = makeFixture({
      batches: [
        { name: 'a.json', availableAt: '2026-08-02T13:05:00Z', detections: [{ n: 1 }] },
        { name: 'b.json', availableAt: '2026-08-02T11:41:00Z', detections: [{ n: 2 }] },
      ],
    });

    expect(() => runReplay(fixture, recordingEngine(emptyRecording()))).toThrow(
      /must be non-decreasing/,
    );
  });

  it('refuses a first poll that precedes the declared clock start', () => {
    const fixture = makeFixture({
      clockStart: '2026-08-02T12:00:00Z',
      batches: [{ name: 'a.json', availableAt: '2026-08-02T11:41:00Z', detections: [{ n: 1 }] }],
    });

    expect(() => runReplay(fixture, recordingEngine(emptyRecording()))).toThrow(
      /must be non-decreasing/,
    );
  });
});

describe('runReplay alerts', () => {
  it('keeps live alerts in the order they were emitted', () => {
    // Which alert fired first is an outcome S13/S14 assert, so this is deliberately unsorted.
    const fixture = makeFixture({
      batches: [{ name: 'a.json', availableAt: '2026-08-02T11:41:00Z', detections: [{ n: 1 }] }],
    });

    const report = runReplay(fixture, (context) => ({
      ingest: () => {
        context.emitAlert(alert({ publicId: 'fw-2026-zzzzz' }));
        context.emitAlert(alert({ publicId: 'fw-2026-aaaaa' }));
      },
      events: () => [],
    }));

    expect(report.alerts.map((entry) => entry.publicId)).toEqual([
      'fw-2026-zzzzz',
      'fw-2026-aaaaa',
    ]);
  });

  it('throws when an offline replay tries to notify anyone', () => {
    const fixture = makeFixture({
      mode: 'offline',
      batches: [{ name: 'a.json', availableAt: '2026-08-02T11:41:00Z', detections: [{ n: 1 }] }],
    });

    expect(() =>
      runReplay(fixture, (context) => ({
        ingest: () => {
          context.emitAlert(alert({ publicId: 'fw-2026-aaaaa' }));
        },
        events: () => [],
      })),
    ).toThrow(/CI-6/);
  });

  it('lets an offline replay seed state, which is what reprocessing is for', () => {
    // The other half of CI-6. A backfill that refused to seed would leave every zone
    // believing each reprocessed event is new, and the first live poll after it would
    // notify about fires that had been burning for a week.
    const fixture = makeFixture({
      mode: 'offline',
      batches: [{ name: 'a.json', availableAt: '2026-08-02T11:41:00Z', detections: [{ n: 1 }] }],
    });

    const report = runReplay(fixture, (context) => ({
      ingest: () => {
        context.emitAlert(
          alert({ publicId: 'fw-2026-aaaaa', outcome: 'seed', reason: 'reprocessing' }),
        );
        context.emitAlert(
          alert({ publicId: 'fw-2026-bbbbb', outcome: 'suppress', reason: 'below_zone_floor' }),
        );
      },
      events: () => [],
    }));

    expect(report.alerts.map((entry) => entry.outcome)).toEqual(['seed', 'suppress']);
  });

  it('throws when an offline replay defers, because a deferral is a queued notification', () => {
    const fixture = makeFixture({
      mode: 'offline',
      batches: [{ name: 'a.json', availableAt: '2026-08-02T11:41:00Z', detections: [{ n: 1 }] }],
    });

    expect(() =>
      runReplay(fixture, (context) => ({
        ingest: () => {
          context.emitAlert(
            alert({ publicId: 'fw-2026-aaaaa', outcome: 'defer', reason: 'quiet_hours' }),
          );
        },
        events: () => [],
      })),
    ).toThrow(/CI-6/);
  });

  it('tells the engine which mode it is in', () => {
    const recording = emptyRecording();
    const fixture = makeFixture({
      mode: 'offline',
      batches: [{ name: 'a.json', availableAt: '2026-08-02T11:41:00Z', detections: [{ n: 1 }] }],
    });

    runReplay(fixture, recordingEngine(recording));

    expect(recording.context?.mode).toBe('offline');
    expect(recording.context?.allowRevive).toBe(false);
    expect(recording.context?.configVersions).toEqual({ clustering: 'clustering_params_v1' });
  });
});

describe('runReplay report', () => {
  it('sorts events and their detection ids so engine iteration order cannot leak in', () => {
    const fixture = makeFixture({
      batches: [{ name: 'a.json', availableAt: '2026-08-02T11:41:00Z', detections: [{ n: 1 }] }],
    });

    const report = runReplay(
      fixture,
      recordingEngine(emptyRecording(), [
        event({ publicId: 'fw-2026-bbbbb', detectionUids: [uid(9), uid(2)] }),
        event({ publicId: 'fw-2026-aaaaa' }),
      ]),
    );

    expect(report.events.map((entry) => entry.publicId)).toEqual([
      'fw-2026-aaaaa',
      'fw-2026-bbbbb',
    ]);
    expect(report.events[1]?.detectionUids).toEqual([uid(2), uid(9)]);
  });

  it('summarizes each batch by name and size', () => {
    const fixture = makeFixture({
      batches: [
        { name: 'a.json', availableAt: '2026-08-02T11:41:00Z', detections: [{ n: 1 }, { n: 2 }] },
        { name: 'b.json', availableAt: '2026-08-02T13:05:00Z', detections: [] },
      ],
    });

    const report = runReplay(fixture, recordingEngine(emptyRecording()));

    expect(report.batches).toEqual([
      { name: 'a.json', detections: 2 },
      { name: 'b.json', detections: 0 },
    ]);
  });
});

describe('serializeReport', () => {
  it('emits key-sorted JSON with a trailing newline', () => {
    const fixture = makeFixture({
      batches: [{ name: 'a.json', availableAt: '2026-08-02T11:41:00Z', detections: [{ n: 1 }] }],
    });

    const text = serializeReport(runReplay(fixture, recordingEngine(emptyRecording())));

    expect(text.endsWith('\n')).toBe(true);
    expect(text.indexOf('"alerts"')).toBeLessThan(text.indexOf('"batches"'));
    expect(text.indexOf('"configVersions"')).toBeLessThan(text.indexOf('"events"'));
  });
});

describe('diffAgainstExpected', () => {
  const fixture = makeFixture({
    batches: [{ name: 'a.json', availableAt: '2026-08-02T11:41:00Z', detections: [{ n: 1 }] }],
  });
  const report = runReplay(
    fixture,
    recordingEngine(emptyRecording(), [event({ publicId: 'fw-2026-aaaaa' })]),
  );
  const expected = JSON.parse(serializeReport(report)) as unknown;

  it('is empty when the outcomes match', () => {
    expect(diffAgainstExpected(report, expected)).toEqual([]);
  });

  it('points at the field that differs', () => {
    const wrong = { ...(expected as Record<string, unknown>), fixtureId: 'T2' };

    expect(diffAgainstExpected(report, wrong)).toEqual(['$.fixtureId: expected "T2", got "T1"']);
  });

  it('reports a length mismatch once, not per entry', () => {
    const wrong = { ...(expected as Record<string, unknown>), events: [] };

    expect(diffAgainstExpected(report, wrong)).toContain('$.events: expected 0 entries, got 1');
  });

  it('distinguishes an absent key from an explicit null', () => {
    const events = [{ publicId: 'fw-2026-aaaaa', status: 'active', bucket: 'unverified' }];
    const wrong = { ...(expected as Record<string, unknown>), events };

    const differences = diffAgainstExpected(report, wrong);

    expect(differences).toContain('$.events[0].mergedInto: expected <absent>, got null');
    expect(differences).toContain('$.events[0].labels: expected <absent>, got []');
  });

  it('does not confuse an array with an object', () => {
    const wrong = { ...(expected as Record<string, unknown>), alerts: {} };

    expect(diffAgainstExpected(report, wrong)).toEqual(['$.alerts: expected {}, got []']);
  });
});
