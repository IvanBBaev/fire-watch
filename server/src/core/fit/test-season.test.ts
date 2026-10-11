import { describe, expect, it } from 'vitest';

import {
  decideTestTouch,
  EMPTY_LEDGER,
  LEDGER_VERSION,
  parseLedger,
  recordTouch,
  testSeasonKey,
  type InputFile,
} from './test-season.js';

const A: InputFile = { path: 'firms/VIIRS_SNPP_SP/2025/b.csv', sha256: 'bb' };
const B: InputFile = { path: 'firms/MODIS_SP/2025/a.csv', sha256: 'aa' };
const DS3: InputFile[] = [{ path: 'effis/modis.ba.poly.2025.geojson', sha256: 'cc' }];

describe('test-season lock', () => {
  it('keys the touch on the identity of the DS-1 and DS-3 files, not their order', () => {
    const key = testSeasonKey([A, B], DS3);
    expect(testSeasonKey([B, A], DS3)).toBe(key);
    expect(testSeasonKey([{ ...A, sha256: 'bx' }, B], DS3)).not.toBe(key);
    expect(testSeasonKey([A, B], [])).not.toBe(key);
  });

  it('touches only when asked, and only once per key', () => {
    const key = testSeasonKey([A, B], DS3);
    expect(decideTestTouch(false, EMPTY_LEDGER, key)).toEqual({
      touch: false,
      reason: 'not_requested',
    });
    expect(decideTestTouch(true, EMPTY_LEDGER, key)).toEqual({ touch: true });
    const touch = {
      key,
      touchedAt: '2026-10-11T00:00:00.000Z',
      selectedCellId: 'modis_footprint/v1.25/t48',
      candidateDigest: 'sha256:00',
    };
    const ledger = recordTouch(EMPTY_LEDGER, touch);
    expect(decideTestTouch(true, ledger, key)).toEqual({
      touch: false,
      reason: 'already_touched',
      previous: touch,
    });
    // New data is a new touch (a refit trigger, 23 E1).
    expect(decideTestTouch(true, ledger, testSeasonKey([A], DS3)).touch).toBe(true);
    expect(parseLedger(JSON.parse(JSON.stringify(ledger)))).toEqual(ledger);
  });

  it('refuses a ledger it cannot read rather than treating it as empty', () => {
    expect(() => parseLedger({ version: 'other', touches: [] })).toThrow(TypeError);
    expect(() => parseLedger({ version: LEDGER_VERSION, touches: [{ key: 1 }] })).toThrow(
      TypeError,
    );
    expect(() => parseLedger(null)).toThrow(TypeError);
  });
});
