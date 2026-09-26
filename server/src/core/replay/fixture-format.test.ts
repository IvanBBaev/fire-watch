import { describe, expect, it } from 'vitest';

import {
  EMPTY_OBSERVATIONS,
  assertObservationsResolve,
  parseFixtureManifest,
  parseObservationContext,
  parseReplayBatch,
} from './fixture-format.js';

const VALID_MANIFEST = {
  id: 'S1',
  title: 'Two satellites, one fire',
  asserts: 'a single event, not two',
  required: 'pre-merge',
  owner: 'WP2',
  engine: 'identity',
  clockStart: '2026-08-02T11:00:00Z',
  mode: 'live',
  allowRevive: false,
  configVersions: { clustering_params: 'clustering_params_v1' },
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
    expect(parsed.engine).toBe('identity');
    expect(parsed.allowRevive).toBe(false);
    expect(parsed.configVersions).toEqual({ clustering_params: 'clustering_params_v1' });
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

  it('rejects an engine the harness does not have', () => {
    // Declared, never inferred: `harness-smoke` has to keep running the placeholder even
    // after the identity engine exists, and a typo here must not silently re-point it.
    expect(() => parseFixtureManifest(manifest({ engine: 'clustering' }), 'manifest.json')).toThrow(
      /identity, alert, smoke/,
    );
    expect(() => parseFixtureManifest(manifest({ engine: undefined }), 'manifest.json')).toThrow(
      /"engine"/,
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
      expect(() => parseFixtureManifest(manifest({ observations: bad }), 'manifest.json')).toThrow(
        /must be a plain file name/,
      );
    }
  });

  it('reads a fixture that declares no observations as having none', () => {
    // Every fixture written before the field existed omits it, and omitting it is the
    // ordinary case — so it resolves to null rather than to a missing property.
    expect(parseFixtureManifest(VALID_MANIFEST, 'manifest.json').observations).toBeNull();
  });

  it('accepts an observations file name', () => {
    const parsed = parseFixtureManifest(
      manifest({ observations: 'observations.json' }),
      'manifest.json',
    );

    expect(parsed.observations).toBe('observations.json');
  });

  it('rejects an observations key that is not a file name', () => {
    expect(() => parseFixtureManifest(manifest({ observations: '' }), 'manifest.json')).toThrow(
      /"observations"/,
    );
    expect(() => parseFixtureManifest(manifest({ observations: 7 }), 'manifest.json')).toThrow(
      /"observations"/,
    );
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

const CLOUD_SPAN = { fromIso: '2026-08-03T11:00:00Z', toIso: '2026-08-03T14:00:00Z', percent: 85 };
const OUTAGE = {
  source: 'firms:viirs:noaa20',
  fromIso: '2026-08-03T00:00:00Z',
  toIso: null,
};
const DECLARATION = {
  detectionUid: UID_A,
  state: 'officially_extinguished',
  declaredAtIso: '2026-08-05T09:00:00Z',
  // Free text, and legitimately Bulgarian: it is the institution's own name, rendered to
  // the user exactly as the authority writes it.
  attribution: 'ГДПБЗН, РДПБЗН Хасково',
};

const span = (overrides: Record<string, unknown>): Record<string, unknown> => ({
  ...CLOUD_SPAN,
  ...overrides,
});

const outage = (overrides: Record<string, unknown>): Record<string, unknown> => ({
  ...OUTAGE,
  ...overrides,
});

const declaration = (overrides: Record<string, unknown>): Record<string, unknown> => ({
  ...DECLARATION,
  ...overrides,
});

const hour = (iso: string): number => Date.parse(iso);

const ZONE = {
  zoneId: 'zone-hasovo',
  accountId: 'acct-7',
  createdAtIso: '2026-08-01T00:00:00Z',
  minScore: 0.6,
  timezone: 'Europe/Sofia',
  quietHoursStart: '22:00',
  quietHoursEnd: '07:00',
  newFireOverridesQuietHours: true,
  distanceKm: 4.2,
};

const SCORE = {
  detectionUid: UID_A,
  fromIso: '2026-08-02T11:41:00Z',
  score: 0.72,
};

const zone = (overrides: Record<string, unknown>): Record<string, unknown> => ({
  ...ZONE,
  ...overrides,
});

const score = (overrides: Record<string, unknown>): Record<string, unknown> => ({
  ...SCORE,
  ...overrides,
});

describe('parseObservationContext', () => {
  it('reads a file with no arrays as a context that declares nothing', () => {
    const parsed = parseObservationContext({}, 'observations.json');

    expect(parsed.cloudCover).toEqual([]);
    expect(parsed.outages).toEqual([]);
    expect(parsed.declarations).toEqual([]);
  });

  it('reads the three arrays a scenario can declare', () => {
    const parsed = parseObservationContext(
      { cloudCover: [CLOUD_SPAN], outages: [OUTAGE], declarations: [DECLARATION] },
      'observations.json',
    );

    expect(parsed.cloudCover).toHaveLength(3);
    expect(parsed.outages).toEqual([
      { source: 'firms:viirs:noaa20', fromMs: hour('2026-08-03T00:00:00Z'), toMs: null },
    ]);
    expect(parsed.declarations).toEqual([
      {
        detectionUid: UID_A,
        state: 'officially_extinguished',
        declaredAtMs: hour('2026-08-05T09:00:00Z'),
        attribution: 'ГДПБЗН, РДПБЗН Хасково',
      },
    ]);
  });

  it('rejects anything that is not a JSON object', () => {
    expect(() => parseObservationContext([], 'observations.json')).toThrow(
      /expected a JSON object/,
    );
    expect(() => parseObservationContext(null, 'observations.json')).toThrow(
      /expected a JSON object/,
    );
  });

  it('names the file in every error', () => {
    expect(() => parseObservationContext({ clouds: [] }, 'S7/observations.json')).toThrow(
      /S7\/observations\.json/,
    );
  });

  it('rejects an unknown top-level key rather than reading it as silence', () => {
    // The departure from the manifest parser's tolerance: every array here is optional, so
    // a typo'd "clouds" would parse to "no cloud at all" and the fixture would stay green
    // while asserting the opposite of the sky its author wrote down.
    expect(() => parseObservationContext({ clouds: [CLOUD_SPAN] }, 'observations.json')).toThrow(
      /unknown key "clouds"/,
    );
    expect(() => parseObservationContext({ declaration: [] }, 'observations.json')).toThrow(
      /cloudCover, outages, declarations, zones, scores/,
    );
  });

  it('rejects a field that is present but is not an array', () => {
    for (const key of ['cloudCover', 'outages', 'declarations', 'zones', 'scores']) {
      expect(() => parseObservationContext({ [key]: {} }, 'observations.json')).toThrow(
        new RegExp(`"${key}" must be an array`),
      );
    }
  });

  it('points at the entry that is wrong', () => {
    expect(() =>
      parseObservationContext(
        { declarations: [DECLARATION, declaration({ attribution: '' })] },
        'observations.json',
      ),
    ).toThrow(/observations\.json declarations\[1\]/);
  });
});

describe('parseObservationContext — cloud spans', () => {
  it('expands a span into one sample per whole UTC hour, half-open', () => {
    // 11:00→14:00 is three hours: the closing bound belongs to the next span, not this one.
    const parsed = parseObservationContext({ cloudCover: [CLOUD_SPAN] }, 'observations.json');

    expect(parsed.cloudCover).toEqual([
      { hourStartMs: hour('2026-08-03T11:00:00Z'), percent: 85 },
      { hourStartMs: hour('2026-08-03T12:00:00Z'), percent: 85 },
      { hourStartMs: hour('2026-08-03T13:00:00Z'), percent: 85 },
    ]);
  });

  it('rejects a bound that is not an exact UTC hour boundary', () => {
    // The accumulator indexes cloud by the hour a sample starts and requires the alignment
    // rather than rounding to it, so a bound at 11:30 files every sample under an hour
    // nothing looks up and the fixture asserts a sky it never declared.
    for (const bad of [
      '2026-08-03T11:30:00Z',
      '2026-08-03T11:00:30Z',
      '2026-08-03T11:00:00.500Z',
    ]) {
      expect(() =>
        parseObservationContext({ cloudCover: [span({ fromIso: bad })] }, 'observations.json'),
      ).toThrow(/exact UTC hour boundary/);
      expect(() =>
        parseObservationContext(
          { cloudCover: [span({ toIso: '2026-08-04T11:00:00Z', fromIso: bad })] },
          'observations.json',
        ),
      ).toThrow(/exact UTC hour boundary/);
    }
  });

  it('rejects a bound that is not an explicit UTC instant', () => {
    expect(() =>
      parseObservationContext(
        { cloudCover: [span({ fromIso: '2026-08-03T11:00:00' })] },
        'observations.json',
      ),
    ).toThrow(/explicit UTC ISO string/);
  });

  it('rejects a span that ends where or before it starts', () => {
    for (const bad of ['2026-08-03T11:00:00Z', '2026-08-03T10:00:00Z']) {
      expect(() =>
        parseObservationContext({ cloudCover: [span({ toIso: bad })] }, 'observations.json'),
      ).toThrow(/must be strictly after/);
    }
  });

  it('requires a percentage between 0 and 100', () => {
    for (const bad of [-1, 100.5, 'high', null, undefined, Number.POSITIVE_INFINITY]) {
      expect(() =>
        parseObservationContext({ cloudCover: [span({ percent: bad })] }, 'observations.json'),
      ).toThrow(/"percent" must be a finite number between 0 and 100/);
    }
    for (const good of [0, 100, 49.5]) {
      expect(
        parseObservationContext({ cloudCover: [span({ percent: good })] }, 'observations.json')
          .cloudCover[0]?.percent,
      ).toBe(good);
    }
  });

  it('rejects overlapping spans and names both', () => {
    // A partition of the fixture's time means "which reading applies at 14:00" has one
    // answer that does not depend on the resolution rule buried in the accumulator.
    expect(() =>
      parseObservationContext(
        {
          cloudCover: [
            span({ fromIso: '2026-08-03T00:00:00Z', toIso: '2026-08-04T00:00:00Z' }),
            span({ fromIso: '2026-08-03T12:00:00Z', toIso: '2026-08-05T00:00:00Z' }),
          ],
        },
        'observations.json',
      ),
    ).toThrow(/cloudCover\[0\].*overlaps cloudCover\[1\]/);
  });

  it('accepts spans that meet exactly, and a gap between them', () => {
    // A gap is not clear sky: it is sky we know nothing about, which the accumulator reads
    // as no opportunity at all — and which a scenario may genuinely want to say.
    const parsed = parseObservationContext(
      {
        cloudCover: [
          span({ fromIso: '2026-08-03T00:00:00Z', toIso: '2026-08-03T02:00:00Z', percent: 10 }),
          span({ fromIso: '2026-08-03T02:00:00Z', toIso: '2026-08-03T03:00:00Z', percent: 90 }),
          span({ fromIso: '2026-08-03T05:00:00Z', toIso: '2026-08-03T06:00:00Z', percent: 20 }),
        ],
      },
      'observations.json',
    );

    expect(parsed.cloudCover.map((sample) => sample.hourStartMs)).toEqual([
      hour('2026-08-03T00:00:00Z'),
      hour('2026-08-03T01:00:00Z'),
      hour('2026-08-03T02:00:00Z'),
      hour('2026-08-03T05:00:00Z'),
    ]);
  });

  it('accepts a span exactly at the 40-day cap', () => {
    const parsed = parseObservationContext(
      {
        cloudCover: [
          span({ fromIso: '2026-08-01T00:00:00Z', toIso: '2026-09-10T00:00:00Z', percent: 10 }),
        ],
      },
      'observations.json',
    );

    expect(parsed.cloudCover).toHaveLength(960);
  });

  it('refuses to expand past the 40-day cap, naming the offending span', () => {
    // A mistyped year would otherwise expand to millions of samples and look like a hang.
    expect(() =>
      parseObservationContext(
        {
          cloudCover: [
            span({ fromIso: '2026-08-01T00:00:00Z', toIso: '2026-08-02T00:00:00Z' }),
            span({ fromIso: '2026-08-02T00:00:00Z', toIso: '2036-08-02T00:00:00Z' }),
          ],
        },
        'observations.json',
      ),
    ).toThrow(/cloudCover\[1\].*past 960 expanded hours/);
  });
});

describe('parseObservationContext — outages', () => {
  it('reads an open outage as one with no end', () => {
    const parsed = parseObservationContext({ outages: [OUTAGE] }, 'observations.json');

    expect(parsed.outages[0]?.toMs).toBeNull();
  });

  it('rejects a source outside the frozen §1a registry', () => {
    // An outage is scoped to one source; a typo'd id scopes it to nothing at all, so every
    // real source keeps accumulating and the scenario asserts the absence of its outage.
    expect(() =>
      parseObservationContext(
        { outages: [outage({ source: 'firms:viirs:noaa22' })] },
        'observations.json',
      ),
    ).toThrow(/firms:viirs:noaa22/);
  });

  it('accepts an outage that ends at the instant it starts', () => {
    const parsed = parseObservationContext(
      { outages: [outage({ toIso: '2026-08-03T00:00:00Z' })] },
      'observations.json',
    );

    expect(parsed.outages[0]?.toMs).toBe(hour('2026-08-03T00:00:00Z'));
  });

  it('rejects an outage that ends before it starts', () => {
    expect(() =>
      parseObservationContext(
        { outages: [outage({ toIso: '2026-08-02T00:00:00Z' })] },
        'observations.json',
      ),
    ).toThrow(/cannot end before it starts/);
  });

  it('requires toIso to be written, as an instant or an explicit null', () => {
    expect(() =>
      parseObservationContext({ outages: [outage({ toIso: undefined })] }, 'observations.json'),
    ).toThrow(/"toIso" must be a UTC instant, or null/);
    expect(() =>
      parseObservationContext({ outages: [outage({ toIso: 7 })] }, 'observations.json'),
    ).toThrow(/"toIso" must be a UTC instant, or null/);
  });

  it('rejects a bound that is not an explicit UTC instant', () => {
    expect(() =>
      parseObservationContext(
        { outages: [outage({ fromIso: '2026-08-03T00:00:00' })] },
        'observations.json',
      ),
    ).toThrow(/explicit UTC ISO string/);
  });
});

describe('parseObservationContext — declarations', () => {
  it('rejects a state that is not one an authority alone may set', () => {
    for (const bad of ['archived', 'no_longer_detected', 'out']) {
      expect(() =>
        parseObservationContext({ declarations: [declaration({ state: bad })] }, 'o.json'),
      ).toThrow(/officially_contained, officially_extinguished/);
    }
  });

  it('rejects a detection uid that is not a lowercase sha256', () => {
    for (const bad of [UID_A.toUpperCase(), 'S12-event-1', `${UID_A}00`]) {
      expect(() =>
        parseObservationContext({ declarations: [declaration({ detectionUid: bad })] }, 'o.json'),
      ).toThrow(/"detectionUid"/);
    }
  });

  it('rejects an unattributed statement', () => {
    // An official statement the product cannot attribute is exactly the thing it may never
    // render, so a fixture may not declare one either.
    for (const bad of ['', undefined, null]) {
      expect(() =>
        parseObservationContext({ declarations: [declaration({ attribution: bad })] }, 'o.json'),
      ).toThrow(/"attribution" must be a non-empty string/);
    }
  });

  it('keeps a non-ASCII attribution verbatim', () => {
    const parsed = parseObservationContext({ declarations: [DECLARATION] }, 'o.json');

    expect(parsed.declarations[0]?.attribution).toBe('ГДПБЗН, РДПБЗН Хасково');
  });

  it('rejects a declaredAtIso without an explicit Z', () => {
    expect(() =>
      parseObservationContext(
        { declarations: [declaration({ declaredAtIso: '2026-08-05T09:00:00' })] },
        'o.json',
      ),
    ).toThrow(/explicit UTC ISO string/);
  });
});

describe('parseObservationContext — zones', () => {
  it('reads a zone as the alert gate wants it, with its creation instant resolved', () => {
    // `createdAtIso` is stated as text and read as an instant, because the gate is not
    // evaluated for a zone before it was drawn and the first evaluation at or after that
    // instant is the seeding one (ADR-004 A1.8) — a comparison, never a string.
    const parsed = parseObservationContext({ zones: [ZONE] }, 'observations.json');

    expect(parsed.zones).toEqual([
      {
        zoneId: 'zone-hasovo',
        accountId: 'acct-7',
        createdAtMs: hour('2026-08-01T00:00:00Z'),
        minScore: 0.6,
        timezone: 'Europe/Sofia',
        quietHoursStart: '22:00',
        quietHoursEnd: '07:00',
        newFireOverridesQuietHours: true,
        distanceKm: 4.2,
      },
    ]);
    expect(typeof parsed.zones[0]?.createdAtMs).toBe('number');
  });

  it('rejects a zoneId or accountId that could not be an identifier', () => {
    // The zone id is the gate's state key and the account id is what scopes the
    // nearest-zone rule (ADR-004 A1.7); punctuation in either makes two fixtures that look
    // alike disagree about which state they are addressing.
    for (const bad of ['', '-zone', 'zone hasovo', 'zone/hasovo', 7]) {
      expect(() =>
        parseObservationContext({ zones: [zone({ zoneId: bad })] }, 'observations.json'),
      ).toThrow(/"zoneId"/);
      expect(() =>
        parseObservationContext({ zones: [zone({ accountId: bad })] }, 'observations.json'),
      ).toThrow(/"accountId"/);
    }
  });

  it('rejects a timezone that is not an IANA zone, rather than crashing the replay later', () => {
    // `isInQuietHours` throws RangeError on an unknown zone, which inside a replay surfaces
    // as a harness crash with no file name on it. A fixture naming "Europe/Sofa" is told so
    // by the parser, where the origin is still in hand.
    for (const bad of ['Europe/Sofa', 'Sofia', 'not a zone']) {
      expect(() =>
        parseObservationContext({ zones: [zone({ timezone: bad })] }, 'observations.json'),
      ).toThrow(/"timezone" is not an IANA zone/);
    }
    expect(() =>
      parseObservationContext({ zones: [zone({ timezone: '' })] }, 'observations.json'),
    ).toThrow(/"timezone" must be a non-empty string/);
  });

  it('rejects a minScore under the floor the product stands behind, or over certainty', () => {
    // The same floor `assertZoneFloor` enforces at decision time (ADR-004 A1.2): a zone
    // below 0.3 asks for alerts the product does not stand behind, and one above 1 is a
    // threshold no score can ever clear, so the zone silently never alerts.
    for (const bad of [0.29, 0, -1, 1.01]) {
      expect(() =>
        parseObservationContext({ zones: [zone({ minScore: bad })] }, 'observations.json'),
      ).toThrow(/"minScore" must be between 0.3 and 1/);
    }
    for (const good of [0.3, 0.75, 1]) {
      expect(
        parseObservationContext({ zones: [zone({ minScore: good })] }, 'observations.json').zones[0]
          ?.minScore,
      ).toBe(good);
    }
  });

  it('rejects a minScore that is not a finite number', () => {
    // The floor is compared against, never parsed: a string or a NaN loses every comparison
    // silently, so the zone would decline every alert and the fixture would still be green.
    for (const bad of ['0.6', null, undefined, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() =>
        parseObservationContext({ zones: [zone({ minScore: bad })] }, 'observations.json'),
      ).toThrow(/"minScore" must be a finite number/);
    }
  });

  it('rejects quiet hours that are not a 24-hour HH:MM wall clock', () => {
    // Quiet hours are the vocabulary `isInQuietHours` reads verbatim. '7:00' or '24:00' is
    // not a time it recognises, so the window would never open and the night the scenario
    // is about would be indistinguishable from the day.
    for (const bad of ['24:00', '7:00', '22:60', '2200', '22:00:00', '22:0', '', 22]) {
      expect(() =>
        parseObservationContext({ zones: [zone({ quietHoursStart: bad })] }, 'observations.json'),
      ).toThrow(/"quietHoursStart"/);
      expect(() =>
        parseObservationContext({ zones: [zone({ quietHoursEnd: bad })] }, 'observations.json'),
      ).toThrow(/"quietHoursEnd"/);
    }
    for (const good of ['00:00', '09:05', '23:59']) {
      expect(
        parseObservationContext({ zones: [zone({ quietHoursStart: good })] }, 'observations.json')
          .zones[0]?.quietHoursStart,
      ).toBe(good);
    }
  });

  it('rejects a non-boolean newFireOverridesQuietHours', () => {
    // It decides whether a first alert breaks silence. Any truthy string would read as
    // "yes" and any absent key as "no", so the override has to be written, not inferred.
    for (const bad of ['true', 'no', 1, null, undefined]) {
      expect(() =>
        parseObservationContext(
          { zones: [zone({ newFireOverridesQuietHours: bad })] },
          'observations.json',
        ),
      ).toThrow(/"newFireOverridesQuietHours" must be a boolean/);
    }
  });

  it('rejects a distanceKm that is negative or wider than the planet', () => {
    // Nothing in the replay computes zone geometry, so a fixture states the distance the
    // nearest-zone tie-break compares. An impossible one does not fail the tie-break, it
    // wins or loses it silently and the fixture asserts the wrong winner.
    for (const bad of [-0.1, -1, 20_001]) {
      expect(() =>
        parseObservationContext({ zones: [zone({ distanceKm: bad })] }, 'observations.json'),
      ).toThrow(/"distanceKm" must be between 0 and 20000/);
    }
    for (const bad of ['4.2', null, Number.NaN]) {
      expect(() =>
        parseObservationContext({ zones: [zone({ distanceKm: bad })] }, 'observations.json'),
      ).toThrow(/"distanceKm" must be a finite number/);
    }
    expect(
      parseObservationContext({ zones: [zone({ distanceKm: 0 })] }, 'observations.json').zones[0]
        ?.distanceKm,
    ).toBe(0);
  });
});

describe('parseObservationContext — scores', () => {
  it('reads a stated score as an effective-from entry, with its instant resolved', () => {
    // Scores are stated because no code computes one yet, and they are effective-from so a
    // single event's score can rise between polls and drive the escalation ladder.
    const parsed = parseObservationContext(
      { scores: [SCORE, score({ fromIso: '2026-08-02T23:41:00Z', score: 0.91 })] },
      'observations.json',
    );

    expect(parsed.scores).toEqual([
      { detectionUid: UID_A, fromMs: hour('2026-08-02T11:41:00Z'), score: 0.72 },
      { detectionUid: UID_A, fromMs: hour('2026-08-02T23:41:00Z'), score: 0.91 },
    ]);
    expect(typeof parsed.scores[0]?.fromMs).toBe('number');
  });

  it('rejects a detection uid that is not a lowercase sha256', () => {
    // A score names its event by a detection the event holds, because public ids are minted
    // during the replay. Anything but the digest form names an event that cannot exist.
    for (const bad of [UID_A.toUpperCase(), 'S13-event-1', `${UID_A}00`, '']) {
      expect(() =>
        parseObservationContext({ scores: [score({ detectionUid: bad })] }, 'observations.json'),
      ).toThrow(/"detectionUid"/);
    }
  });

  it('rejects a score outside the 0–1 scale the gate compares against', () => {
    // A stated score is an input to the gate, never an outcome. Outside the scale it clears
    // or fails every zone floor at once, which reads as a decision the scenario never made.
    for (const bad of [-0.01, 1.01, 2]) {
      expect(() =>
        parseObservationContext({ scores: [score({ score: bad })] }, 'observations.json'),
      ).toThrow(/"score" must be between 0 and 1/);
    }
    for (const good of [0, 0.5, 1]) {
      expect(
        parseObservationContext({ scores: [score({ score: good })] }, 'observations.json').scores[0]
          ?.score,
      ).toBe(good);
    }
  });

  it('rejects a score that is not a finite number', () => {
    for (const bad of ['0.72', null, undefined, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() =>
        parseObservationContext({ scores: [score({ score: bad })] }, 'observations.json'),
      ).toThrow(/"score" must be a finite number/);
    }
  });

  it('rejects a fromIso that is not an explicit UTC instant', () => {
    // The instant decides which polls the score is already in effect for; read in the
    // host's zone it would take effect hours early or late depending on where CI runs.
    for (const bad of ['2026-08-02T11:41:00', 'yesterday', '']) {
      expect(() =>
        parseObservationContext({ scores: [score({ fromIso: bad })] }, 'observations.json'),
      ).toThrow();
    }
    expect(() =>
      parseObservationContext(
        { scores: [score({ fromIso: '2026-08-02T11:41:00' })] },
        'observations.json',
      ),
    ).toThrow(/explicit UTC ISO string/);
  });
});

describe('EMPTY_OBSERVATIONS', () => {
  it('is an empty, frozen context', () => {
    expect(EMPTY_OBSERVATIONS).toEqual({
      cloudCover: [],
      outages: [],
      declarations: [],
      zones: [],
      scores: [],
    });
    expect(Object.isFrozen(EMPTY_OBSERVATIONS)).toBe(true);
    expect(Object.isFrozen(EMPTY_OBSERVATIONS.cloudCover)).toBe(true);
    expect(Object.isFrozen(EMPTY_OBSERVATIONS.zones)).toBe(true);
    expect(Object.isFrozen(EMPTY_OBSERVATIONS.scores)).toBe(true);
  });
});

describe('assertObservationsResolve', () => {
  const polls = [
    parseReplayBatch(batch([VALID_DETECTION]), 'poll-01.json'),
    parseReplayBatch(batch([detection({ detectionUid: UID_B, latCanonical: '41.86114' })]), 'p2'),
  ];

  it('accepts a declaration whose detection some poll delivers', () => {
    const observations = parseObservationContext(
      { declarations: [declaration({ detectionUid: UID_B })] },
      'observations.json',
    );

    expect(() => assertObservationsResolve(observations, polls)).not.toThrow();
  });

  it('rejects a declaration naming a detection no poll delivers', () => {
    // A declaration names its event by a detection because public ids are minted during
    // the replay. A mistyped uid names an event that never exists, so the declaration does
    // nothing at all — and S12 would report a re-detection after an extinguishment that was
    // never declared, and pass.
    const observations = parseObservationContext(
      { declarations: [declaration({ detectionUid: 'c'.repeat(64) })] },
      'observations.json',
    );

    expect(() => assertObservationsResolve(observations, polls)).toThrow(
      /declarations\[0\] names detection c{64}/,
    );
    expect(() => assertObservationsResolve(observations, polls)).toThrow(
      /would attach to no event at all/,
    );
  });

  it('needs no polls when the fixture declares nothing', () => {
    expect(() => assertObservationsResolve(EMPTY_OBSERVATIONS, [])).not.toThrow();
  });

  it('rejects two zones sharing a zoneId, because a zone id is its state key', () => {
    // Not a duplicate row: two different watch zones the gate folds into one state key, so
    // the second's decision overwrites the first's and the nearest-zone tie-break the
    // fixture exists to assert never runs at all.
    const observations = parseObservationContext(
      { zones: [ZONE, zone({ accountId: 'acct-9', distanceKm: 11 })] },
      'observations.json',
    );

    expect(() => assertObservationsResolve(observations, polls)).toThrow(
      /zones\[1\] repeats zoneId zone-hasovo/,
    );
  });

  it('checks zone ids even when the fixture states nothing else to resolve', () => {
    // The uid checks return early when there is nothing to resolve; uniqueness must not
    // ride along on that, or a zones-only fixture would never be checked.
    const observations = parseObservationContext(
      { zones: [ZONE, zone({ distanceKm: 11 })] },
      'observations.json',
    );

    expect(() => assertObservationsResolve(observations, [])).toThrow(/repeats zoneId/);
  });

  it('rejects a score naming a detection no poll delivers', () => {
    // A mistyped uid names an event that never exists, so the score attaches to nothing:
    // S13 would report no alert because the event it scored stayed unscored, and pass.
    const observations = parseObservationContext(
      { scores: [score({ detectionUid: 'c'.repeat(64) })] },
      'observations.json',
    );

    expect(() => assertObservationsResolve(observations, polls)).toThrow(
      /scores\[0\] names detection c{64}/,
    );
    expect(() => assertObservationsResolve(observations, polls)).toThrow(
      /which no poll in this fixture delivers/,
    );
  });

  it('accepts a fixture whose zones and scores all resolve', () => {
    const observations = parseObservationContext(
      {
        zones: [ZONE, zone({ zoneId: 'zone-svilengrad', distanceKm: 11 })],
        scores: [SCORE, score({ detectionUid: UID_B, score: 0.91 })],
      },
      'observations.json',
    );

    expect(() => assertObservationsResolve(observations, polls)).not.toThrow();
  });
});
