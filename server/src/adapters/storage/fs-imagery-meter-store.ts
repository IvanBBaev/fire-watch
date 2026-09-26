/**
 * The imagery tripwire's state as files under `<root>/imagery/` (ADR-001 A2.3).
 *
 * **Switches are presence.** As with `fs-dispatch-control-store.ts`, the switch files are
 * never parsed — existing is the state:
 *
 *     touch "$FIRE_WATCH_STATE_DIR/imagery/kill-switch"         # imagery off, now and until removed
 *     touch "$FIRE_WATCH_STATE_DIR/imagery/override-2026-09"    # ops re-enable for this period only
 *     rm    "$FIRE_WATCH_STATE_DIR/imagery/tripped-2026-09"     # clear a latch (the override is the gentler tool)
 *
 * The trip latch and the override are per period by name, so the next period starts clean
 * without anyone deleting anything — that is A2.3's "re-enable at the next quota period"
 * — and an override cannot outlive the period it was granted for.
 *
 * **The usage reading is the one parsed file.** `usage.json` holds
 * `{"period":"YYYY-MM","tiles":N}`: whatever measures ArcGIS consumption writes it, and
 * writing a count at or over the ceiling is how a quota exhaustion is simulated in
 * staging. Absent is "no reading" (which the meter treats as off); present but malformed
 * rejects, because a reading nobody can parse is not a low reading.
 *
 * **Fail-closed on everything but absence.** `ENOENT` is the only "no"; every other error
 * rejects and the meter reports `store_error`, which serves no imagery block.
 */

import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';

import { canonicalJson } from '../../core/determinism/canonical-json.js';
import { isQuotaPeriod } from '../../core/imagery/imagery-meter.js';
import type {
  ImageryMeterReading,
  ImageryMeterStore,
  ImageryUsage,
} from '../../core/ports/imagery-meter-store.js';

export const IMAGERY_STATE_DIR = 'imagery';
export const IMAGERY_KILL_SWITCH_FILE = 'kill-switch';
export const IMAGERY_USAGE_FILE = 'usage.json';

export function imageryOverrideFile(period: string): string {
  return `override-${assertPeriod(period)}`;
}

export function imageryTripFile(period: string): string {
  return `tripped-${assertPeriod(period)}`;
}

export function createFsImageryMeterStore(rootDir: string): ImageryMeterStore {
  if (!isAbsolute(rootDir)) {
    throw new RangeError(
      `imagery state root must be an absolute path, got ${JSON.stringify(rootDir)}`,
    );
  }
  const dir = join(resolve(rootDir), IMAGERY_STATE_DIR);

  return {
    async read(period: string): Promise<ImageryMeterReading> {
      return {
        killSwitch: await exists(join(dir, IMAGERY_KILL_SWITCH_FILE)),
        override: await exists(join(dir, imageryOverrideFile(period))),
        tripped: await exists(join(dir, imageryTripFile(period))),
        usage: await readUsage(join(dir, IMAGERY_USAGE_FILE)),
      };
    },

    async latchTrip(period: string, at: number, detail: string): Promise<void> {
      const latch = join(dir, imageryTripFile(period));
      await mkdir(dir, { recursive: true });
      try {
        await writeFile(latch, `${canonicalJson({ at, detail })}\n`, { flag: 'wx' });
      } catch (error) {
        if (hasCode(error, 'EEXIST')) return;
        throw error;
      }
    },
  };
}

/** Parse `usage.json`; exported for the test that pins the accepted shape. */
export function parseImageryUsage(text: string): ImageryUsage {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error(`${IMAGERY_USAGE_FILE} is not JSON`);
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${IMAGERY_USAGE_FILE} must be an object`);
  }
  const { period, tiles } = value as Record<string, unknown>;
  if (!isQuotaPeriod(period)) {
    throw new Error(`${IMAGERY_USAGE_FILE} period must be YYYY-MM, got ${JSON.stringify(period)}`);
  }
  if (typeof tiles !== 'number' || !Number.isSafeInteger(tiles) || tiles < 0) {
    throw new Error(
      `${IMAGERY_USAGE_FILE} tiles must be a non-negative integer, got ${JSON.stringify(tiles)}`,
    );
  }
  return { period, tiles };
}

async function readUsage(path: string): Promise<ImageryUsage | null> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (error) {
    if (hasCode(error, 'ENOENT')) return null;
    throw error;
  }
  return parseImageryUsage(text);
}

function assertPeriod(period: string): string {
  if (!isQuotaPeriod(period)) {
    throw new RangeError(`quota period must be YYYY-MM, got ${JSON.stringify(period)}`);
  }
  return period;
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if (hasCode(error, 'ENOENT')) return false;
    throw error;
  }
}

function hasCode(error: unknown, code: string): boolean {
  return (
    error instanceof Error && 'code' in error && (error as NodeJS.ErrnoException).code === code
  );
}
