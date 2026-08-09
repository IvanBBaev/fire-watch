import { describe, expect, it } from 'vitest';

import { parseFixtureManifest, parseReplayBatch } from './fixture-format.js';

const VALID_MANIFEST = {
  id: 'S1',
  title: 'Two satellites, one fire',
  asserts: 'a single event, not two',
  required: 'pre-merge',
  owner: 'WP2',
  clockStart: '2026-08-02T11:00:00Z',
  mode: 'live',
  allowRevive: false,
  configVersions: { clustering: 'clustering_params_v1' },
  inputs: ['poll-01.json'],
  expected: 'expected.json',
};

const manifest = (overrides: Record<string, unknown>): Record<string, unknown> => ({
  ...VALID_MANIFEST,
  ...overrides,
});

// A well-formed digest that is not the digest of these fields. The format parser does not
// hash — that is the loader's job — so tests here stay free of a platform API.
const UID_A = 'a'.repeat(64);
const UID_B = 'b'.repeat(64);

const VALID_DETECTION = {
  detectionUid: UID_A,
  source: 'firms:viirs:snpp',
  acqTsIso: '2026-08-02T11:24:00Z',
  latCanonical: '41.85012',
  lonCanonical: '26.14003',
  confidence: 'nominal',
  frpMw: 12.5,
  dayNight: 'D',
};

const detection = (overrides: Record<string, unknown>): Record<string, unknown> => ({
  ...VALID_DETECTION,
  ...overrides,
});

const batch = (detections: readonly unknown[]): Record<string, unknown> => ({
  availableAt: '2026-08-02T11:41:00Z',
  detections,
});

describe('parseFixtureManifest', () => {
  it('accepts a well-formed manifest', () => {
    const parsed = parseFixtureManifest(VALID_MANIFEST, 'manifest.json');

    expect(parsed.id).toBe('S1');
    expect(parsed.required).toBe('pre-merge');
    expect(parsed.mode).toBe('live');
    expect(parsed.allowRevive).toBe(false);
    expect(parsed.configVersions).toEqual({ clustering: 'clustering_params_v1' });
    expect(parsed.inputs).toEqual(['poll-01.json']);
  });

  it('names the file in every error', () => {
    expect(() => parseFixtureManifest(manifest({ title: '' }), 'S1/manifest.json')).toThrow(
      /S1\/manifest\.json/,
    );
  });

  it('rejects anything that is not a JSON object', () => {
    expect(() => parseFixtureManifest([], 'manifest.json')).toThrow(/expected a JSON object/);
    expect(() => parseFixtureManifest(null, 'manifest.json')).toThrow(/expected a JSON object/);
    expect(() => parseFixtureManifest('S1', 'manifest.json')).toThrow(/expected a JSON object/);
  });

  it('rejects an id that could not be a directory name', () => {
    expect(() => parseFixtureManifest(manifest({ id: '../S1' }), 'manifest.json')).toThrow(/"id"/);
    expect(() => parseFixtureManifest(manifest({ id: '_S1' }), 'manifest.json')).toThrow(/"id"/);
  });

  it('rejects a requirement outside the GATES §1.1 register', () => {
    expect(() => parseFixtureManifest(manifest({ required: 'nightly' }), 'manifest.json')).toThrow(
      /pre-merge, pre-season, suite/,
    );
  });

  it('rejects a mode outside live/offline', () => {
    expect(() => parseFixtureManifest(manifest({ mode: 'backfill' }), 'manifest.json')).toThrow(
      /live, offline/,
    );
  });

  it('rejects a non-boolean allowRevive', () => {
    expect(() => parseFixtureManifest(manifest({ allowRevive: 'no' }), 'manifest.json')).toThrow(
      /"allowRevive" must be a boolean/,
    );
  });

  it('rejects a clockStart without an explicit Z', () => {
    // The whole point of the field: a naive timestamp would be read in the host's zone.
    expect(() =>
      parseFixtureManifest(manifest({ clockStart: '2026-08-02T11:00:00' }), 'manifest.json'),
    ).toThrow(/explicit UTC ISO string/);
  });

  it('refuses to run unpinned', () => {
    expect(() => parseFixtureManifest(manifest({ configVersions: {} }), 'manifest.json')).toThrow(
      /must pin at least one config/,
    );
  });

  it('rejects a config version that is not the versioned-config shape', () => {
    for (const bad of ['clustering_v', 'Clustering_params_v1', 'clustering-params-v1', 'v1', 3]) {
      expect(() =>
        parseFixtureManifest(manifest({ configVersions: { clustering: bad } }), 'manifest.json'),
      ).toThrow(/configVersions\.clustering/);
    }
  });

  it('rejects a fixture with no polls', () => {
    expect(() => parseFixtureManifest(manifest({ inputs: [] }), 'manifest.json')).toThrow(
      /non-empty array/,
    );
    expect(() =>
      parseFixtureManifest(manifest({ inputs: 'poll-01.json' }), 'manifest.json'),
    ).toThrow(/non-empty array/);
  });

  it('rejects file names that escape the fixture directory', () => {
    for (const bad of ['../../etc/passwd', '/etc/passwd', '..\\poll.json', 'a/../../b.json']) {
      expect(() => parseFixtureManifest(manifest({ inputs: [bad] }), 'manifest.json')).toThrow(
        /must be a plain file name/,
      );
      expect(() => parseFixtureManifest(manifest({ expected: bad }), 'manifest.json')).toThrow(
        /must be a plain file name/,
      );
    }
  });
});

describe('parseReplayBatch', () => {
  it('accepts a poll and resolves the batch instant', () => {
    const parsed = parseReplayBatch(batch([VALID_DETECTION]), 'poll-01.json');

    expect(parsed.name).toBe('poll-01.json');
    expect(parsed.availableAt).toBe(Date.parse('2026-08-02T11:41:00Z'));
    expect(parsed.detections).toHaveLength(1);
    expect(parsed.detections[0]?.availableAt).toBe(parsed.availableAt);
  });

  it('accepts a poll that returned nothing', () => {
    // A healthy poll with no fires is a real observation, and S8 depends on expressing it.
    expect(parseReplayBatch(batch([]), 'poll-01.json').detections).toEqual([]);
  });

  it('rejects a missing detections array', () => {
    expect(() => parseReplayBatch({ availableAt: '2026-08-02T11:41:00Z' }, 'poll-01.json')).toThrow(
      /"detections" must be an array/,
    );
  });

  it('lets a row declare an earlier availability than the poll that carried it', () => {
    const parsed = parseReplayBatch(
      batch([detection({ availableAt: '2026-08-02T11:30:00Z' })]),
      'poll-01.json',
    );

    expect(parsed.detections[0]?.availableAt).toBe(Date.parse('2026-08-02T11:30:00Z'));
  });

  it('rejects a row that was available after the poll that returned it', () => {
    expect(() =>
      parseReplayBatch(batch([detection({ availableAt: '2026-08-02T12:00:00Z' })]), 'poll-01.json'),
    ).toThrow(/cannot be handed over before it exists/);
  });

  it('points at the offending row', () => {
    expect(() =>
      parseReplayBatch(batch([VALID_DETECTION, detection({ confidence: 'medium' })]), 'p.json'),
    ).toThrow(/batch p\.json\[1\]/);
  });

  it('rejects a detection_uid that is not a lowercase sha256', () => {
    for (const bad of [UID_A.toUpperCase(), 'abc', `${UID_A}00`]) {
      expect(() => parseReplayBatch(batch([detection({ detectionUid: bad })]), 'p.json')).toThrow(
        /"detectionUid"/,
      );
    }
  });

  it('rejects coordinates that are not canonical 5 dp text', () => {
    for (const bad of ['41.8501', '41.850120', '41', 41.85012]) {
      expect(() => parseReplayBatch(batch([detection({ latCanonical: bad })]), 'p.json')).toThrow(
        /"latCanonical"/,
      );
    }
  });

  it('rejects a confidence outside the three-valued scale', () => {
    expect(() => parseReplayBatch(batch([detection({ confidence: 'medium' })]), 'p.json')).toThrow(
      /low, nominal, high/,
    );
  });

  it('requires frpMw to be present as a finite number or an explicit null', () => {
    expect(
      parseReplayBatch(batch([detection({ frpMw: null })]), 'p.json').detections[0]?.frpMw,
    ).toBe(null);
    expect(() => parseReplayBatch(batch([detection({ frpMw: 'high' })]), 'p.json')).toThrow(
      /"frpMw" must be a number or null/,
    );
    expect(() => parseReplayBatch(batch([detection({ frpMw: undefined })]), 'p.json')).toThrow(
      /"frpMw" must be a number or null/,
    );
  });

  it('rejects a dayNight outside D/N/null', () => {
    expect(
      parseReplayBatch(batch([detection({ dayNight: null })]), 'p.json').detections[0]?.dayNight,
    ).toBe(null);
    expect(() => parseReplayBatch(batch([detection({ dayNight: 'day' })]), 'p.json')).toThrow(
      /"dayNight" must be/,
    );
  });

  it('rejects a source outside the frozen §1a registry', () => {
    // Caught by rebuilding the pre-image, which is also what will hash it later.
    expect(() =>
      parseReplayBatch(batch([detection({ source: 'firms:viirs:noaa22' })]), 'p.json'),
    ).toThrow(/firms:viirs:noaa22/);
  });

  it('rejects an acquisition timestamp that is not the 20-character minute form', () => {
    expect(() =>
      parseReplayBatch(batch([detection({ acqTsIso: '2026-08-02T11:24:33Z' })]), 'p.json'),
    ).toThrow();
    expect(() =>
      parseReplayBatch(batch([detection({ acqTsIso: '2026-08-02T11:24:00.000Z' })]), 'p.json'),
    ).toThrow();
  });

  it('keeps two distinct rows distinct', () => {
    const parsed = parseReplayBatch(
      batch([VALID_DETECTION, detection({ detectionUid: UID_B, latCanonical: '41.86114' })]),
      'poll-01.json',
    );

    expect(parsed.detections.map((row) => row.detectionUid)).toEqual([UID_A, UID_B]);
  });
});
