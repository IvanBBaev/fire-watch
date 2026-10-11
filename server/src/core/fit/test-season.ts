/**
 * The 2025 test season is touch-once, and this makes "once" enforceable (TASKS D7;
 * GATES §2; review 11 §9.1).
 *
 * Two locks:
 *
 * 1. **An explicit flag.** Without `--touch-test-season` the fit never clusters a 2025 row
 *    for the gate: the fit seasons choose, the calibration season checks, and the test
 *    season is left unread. The ε_geo sweep is the one exception and is recorded as such.
 * 2. **A ledger.** Touching writes an entry keyed by the identity of the data touched —
 *    the digest over the DS-1 and DS-3 input file hashes. A second touch of the same data
 *    is refused whatever the flag says. A new DS-1 or DS-3 entry (a refit trigger, 23 E1)
 *    is new data and gets its own touch; that is the point of keying on identity rather
 *    than on a date.
 *
 * The ledger is a file the operator keeps next to the archive. Deleting it re-arms the
 * lock — the CLI cannot stop that, so every report carries the touch record and the
 * ledger key it was written under, and a reviewer can see two reports citing one key.
 */

import { configDigest } from '../config/versioned-config.js';

export const LEDGER_VERSION = 'fit_test_season_ledger_v1';

export interface InputFile {
  /** Path relative to the input directory, `/`-separated. */
  readonly path: string;
  readonly sha256: string;
}

export interface TestTouch {
  readonly key: string;
  readonly touchedAt: string;
  readonly selectedCellId: string;
  readonly candidateDigest: string;
}

export interface TestLedger {
  readonly version: typeof LEDGER_VERSION;
  readonly touches: readonly TestTouch[];
}

export const EMPTY_LEDGER: TestLedger = { version: LEDGER_VERSION, touches: [] };

/** The identity of the data a test touch reads: DS-1 and DS-3 files, sorted by path. */
export function testSeasonKey(ds1: readonly InputFile[], ds3: readonly InputFile[]): string {
  const sorted = (files: readonly InputFile[]): InputFile[] =>
    [...files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return configDigest({ ds1: sorted(ds1), ds3: sorted(ds3) });
}

export function parseLedger(raw: unknown): TestLedger {
  if (
    typeof raw !== 'object' ||
    raw === null ||
    (raw as { version?: unknown }).version !== LEDGER_VERSION ||
    !Array.isArray((raw as { touches?: unknown }).touches)
  ) {
    throw new TypeError(`test-season ledger is not a ${LEDGER_VERSION} document`);
  }
  const touches = (raw as { touches: unknown[] }).touches.map((t) => {
    const touch = t as Partial<Record<keyof TestTouch, unknown>>;
    if (
      typeof touch.key !== 'string' ||
      typeof touch.touchedAt !== 'string' ||
      typeof touch.selectedCellId !== 'string' ||
      typeof touch.candidateDigest !== 'string'
    ) {
      throw new TypeError('test-season ledger has a malformed touch');
    }
    return {
      key: touch.key,
      touchedAt: touch.touchedAt,
      selectedCellId: touch.selectedCellId,
      candidateDigest: touch.candidateDigest,
    };
  });
  return { version: LEDGER_VERSION, touches };
}

export type TouchDecision =
  | { readonly touch: false; readonly reason: 'not_requested' }
  | { readonly touch: false; readonly reason: 'already_touched'; readonly previous: TestTouch }
  | { readonly touch: true };

export function decideTestTouch(
  requested: boolean,
  ledger: TestLedger,
  key: string,
): TouchDecision {
  if (!requested) return { touch: false, reason: 'not_requested' };
  const previous = ledger.touches.find((t) => t.key === key);
  if (previous !== undefined) return { touch: false, reason: 'already_touched', previous };
  return { touch: true };
}

export function recordTouch(ledger: TestLedger, touch: TestTouch): TestLedger {
  return { version: LEDGER_VERSION, touches: [...ledger.touches, touch] };
}
