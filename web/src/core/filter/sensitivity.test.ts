import { describe, expect, it } from 'vitest';

import type { SensitivityCriteria } from './sensitivity.js';
import {
  DEFAULT_SENSITIVITY,
  matchesSensitivity,
  parseSensitivity,
  presetOf,
  SENSITIVITY_PRESET_IDS,
  SENSITIVITY_PRESETS,
  sensitivityHashValue,
  sensorCountOf,
  sensorsUnreportedFor,
} from './sensitivity.js';

const STRICT: SensitivityCriteria = { minBand: 'confirmed', minDetections: 3, minSensors: 2 };

describe('matchesSensitivity', () => {
  it('passes everything at the default', () => {
    for (const scoreBucket of ['unverified', 'likely', 'confirmed'] as const) {
      expect(
        matchesSensitivity(
          { scoreBucket, detectionCount: 1, sourceIds: ['a'] },
          DEFAULT_SENSITIVITY,
        ),
      ).toBe(true);
    }
  });

  it('requires every criterion: band, detections and distinct sensors', () => {
    const strong = { scoreBucket: 'confirmed', detectionCount: 3, sourceIds: ['a', 'b'] } as const;
    expect(matchesSensitivity(strong, STRICT)).toBe(true);
    expect(matchesSensitivity({ ...strong, scoreBucket: 'likely' }, STRICT)).toBe(false);
    expect(matchesSensitivity({ ...strong, detectionCount: 2 }, STRICT)).toBe(false);
    expect(matchesSensitivity({ ...strong, sourceIds: ['a'] }, STRICT)).toBe(false);
    // The same id twice is one sensor, not two.
    expect(matchesSensitivity({ ...strong, sourceIds: ['a', 'a'] }, STRICT)).toBe(false);
  });

  it('fails open per criterion on a field it cannot read', () => {
    expect(matchesSensitivity({}, STRICT)).toBe(true);
    expect(matchesSensitivity({ detectionCount: 3, sourceIds: ['a', 'b'] }, STRICT)).toBe(true);
    expect(
      matchesSensitivity(
        { scoreBucket: 'future-bucket' as never, detectionCount: 3, sourceIds: ['a', 'b'] },
        STRICT,
      ),
    ).toBe(true);
    expect(
      matchesSensitivity(
        { scoreBucket: 'confirmed', detectionCount: Number.NaN, sourceIds: ['a', 'b'] },
        STRICT,
      ),
    ).toBe(true);
    expect(
      matchesSensitivity({ scoreBucket: 'confirmed', detectionCount: 3, sourceIds: [] }, STRICT),
    ).toBe(true);
    // A readable field still hides even when another is missing.
    expect(matchesSensitivity({ scoreBucket: 'unverified' }, STRICT)).toBe(false);
  });

  it('orders the presets from loosest to strictest', () => {
    const events = [
      { scoreBucket: 'unverified', detectionCount: 1, sourceIds: ['a'] },
      { scoreBucket: 'likely', detectionCount: 1, sourceIds: ['a'] },
      { scoreBucket: 'likely', detectionCount: 2, sourceIds: ['a'] },
      { scoreBucket: 'confirmed', detectionCount: 4, sourceIds: ['a', 'b'] },
    ] as const;
    const shown = SENSITIVITY_PRESET_IDS.map(
      (id) => events.filter((e) => matchesSensitivity(e, SENSITIVITY_PRESETS[id])).length,
    );
    expect(shown).toEqual([4, 2, 1]);
  });
});

describe('sensor counting', () => {
  it('counts distinct sources, and says null when the feed did not report them', () => {
    expect(sensorCountOf({ sourceIds: ['a', 'b', 'a'] })).toBe(2);
    expect(sensorCountOf({ sourceIds: [] })).toBeNull();
    expect(sensorCountOf({})).toBeNull();
  });

  it('flags a blind pass only when more than one sensor is asked for', () => {
    expect(sensorsUnreportedFor({}, STRICT)).toBe(true);
    expect(sensorsUnreportedFor({}, SENSITIVITY_PRESETS.balanced)).toBe(false);
    expect(sensorsUnreportedFor({ sourceIds: ['a'] }, STRICT)).toBe(false);
  });
});

describe('presets and the fragment form', () => {
  it('names the preset a combination spells, or null for custom', () => {
    for (const id of SENSITIVITY_PRESET_IDS) expect(presetOf(SENSITIVITY_PRESETS[id])).toBe(id);
    expect(presetOf(STRICT)).toBeNull();
  });

  it('never writes the default, and round-trips presets and custom triples', () => {
    expect(sensitivityHashValue(DEFAULT_SENSITIVITY)).toBeNull();
    expect(sensitivityHashValue(SENSITIVITY_PRESETS.balanced)).toBe('bal');
    expect(sensitivityHashValue(SENSITIVITY_PRESETS.multi)).toBe('multi');
    expect(sensitivityHashValue(STRICT)).toBe('c.3.2');
    for (const criteria of [SENSITIVITY_PRESETS.balanced, SENSITIVITY_PRESETS.multi, STRICT]) {
      expect(parseSensitivity(sensitivityHashValue(criteria))).toStrictEqual(criteria);
    }
    expect(parseSensitivity('all')).toStrictEqual(DEFAULT_SENSITIVITY);
  });

  it('rejects malformed values instead of guessing', () => {
    for (const raw of [
      null,
      '',
      'x',
      'c.3',
      'c.3.2.1',
      'z.1.1',
      'l.0.1',
      'l.1.0',
      'l.01.1',
      'l.100.1',
      'l.-1.1',
    ]) {
      expect(parseSensitivity(raw)).toBeNull();
    }
  });
});
