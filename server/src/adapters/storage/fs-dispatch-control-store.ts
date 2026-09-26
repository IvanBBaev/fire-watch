/**
 * D5's kill switch and breaker latch as two files under `<root>/alert-dispatch/`.
 *
 * **Presence is the state.** `kill-switch` existing means dispatch is stopped; so does
 * `breaker-latched`. The content of either is for the human reading it and is never
 * parsed, so no content — an empty file, a half-written one, a note an operator typed —
 * can make a switch read as open. That is D5's "one command" taken literally:
 *
 *     touch  "$FIRE_WATCH_STATE_DIR/alert-dispatch/kill-switch"   # stop all dispatch
 *     rm     "$FIRE_WATCH_STATE_DIR/alert-dispatch/kill-switch"   # a human resumes it
 *     rm     "$FIRE_WATCH_STATE_DIR/alert-dispatch/breaker-latched"  # close the breaker
 *
 * A file rather than a table because the switch must work when the thing it guards is the
 * problem: an operator stopping a storm should not need a database session to do it, and
 * the dispatch job reads the switch before it opens one.
 *
 * **Fail-closed on everything but absence.** `ENOENT` is the only "off". A permission
 * error, an I/O error, a root that is not a directory — each rejects, the dispatch cycle
 * fails before it claims, and the failure is in the cycle line. An unreadable switch is
 * not an open one.
 *
 * The latch is written with `wx`: exclusive create, so a latch that already exists keeps
 * its first instant and detail, and a crash half-way through the write still leaves a file
 * whose presence latches.
 */

import { mkdir, stat, writeFile } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';

import type { DispatchControlState } from '../../core/alerts/dispatch-breaker.js';
import { canonicalJson } from '../../core/determinism/canonical-json.js';
import type { DispatchControlStore } from '../../core/ports/dispatch-control-store.js';

export const DISPATCH_CONTROL_DIR = 'alert-dispatch';
export const KILL_SWITCH_FILE = 'kill-switch';
export const BREAKER_LATCH_FILE = 'breaker-latched';

export function createFsDispatchControlStore(rootDir: string): DispatchControlStore {
  if (!isAbsolute(rootDir)) {
    throw new RangeError(
      `dispatch control root must be an absolute path, got ${JSON.stringify(rootDir)}`,
    );
  }
  const dir = join(resolve(rootDir), DISPATCH_CONTROL_DIR);
  const killSwitch = join(dir, KILL_SWITCH_FILE);
  const latch = join(dir, BREAKER_LATCH_FILE);

  return {
    async read(): Promise<DispatchControlState> {
      return {
        killSwitch: await exists(killSwitch),
        breakerLatched: await exists(latch),
      };
    },

    async latchBreaker(at: number, detail: string): Promise<void> {
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
