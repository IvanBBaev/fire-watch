/**
 * Reads the static hot-source mask asset from disk (TASKS F16).
 *
 * The default is the copy in the repo, `web/src/assets/geodata/static-sources.json` — the
 * same bytes the web app draws and captions — so the scorer's override and the map's
 * caveat can never be about two different snapshots of OpenStreetMap. The path resolves
 * from this module's location, which is the same depth under `server/src/` and
 * `server/dist/`, so it holds for `tsx` and compiled runs alike; a deployment whose image
 * does not carry `web/` sets `FIRE_WATCH_STATIC_SOURCES` instead.
 *
 * A missing or malformed file throws at boot. Silently falling back to "no mask" would
 * turn the §3.6 override off with nothing in any log to say so.
 *
 * ## Hot reload
 *
 * {@link createStaticSourceMaskReloader} lets the worker pick up a new mask without a
 * restart: an operator replaces the file (ideally by `rename(2)` over the old one, which is
 * atomic), and the next {@link StaticSourceMaskReloader.check} sees it. The check is a
 * `stat` per call; the bytes are read and hashed only when the file's size or mtime moved,
 * and the mask is swapped only when the hash moved too (a `touch` is not a new mask). After
 * boot a broken file never throws: a half-written copy, a typo'd JSON or a vanished path
 * keeps the mask that is loaded and reports `rejected`, because turning the override off
 * mid-season over a bad copy would be worse than running one version behind. Rejected for
 * the same reason: new bytes under an unchanged `version` — every verdict is stamped with
 * the version (D7), and two different masks under one name could never be replayed, nor
 * would the tick's version sweep ever rescore against the new one.
 */

import { createHash } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { parseStaticSourceMask, type StaticSourceMask } from '@fire-watch/contracts';

export const REPO_STATIC_SOURCES_PATH = fileURLToPath(
  new URL('../../../../web/src/assets/geodata/static-sources.json', import.meta.url),
);

export function loadStaticSourceMask(path: string | null): StaticSourceMask {
  return readMask(path ?? REPO_STATIC_SOURCES_PATH).mask;
}

/** The file-system calls the reloader makes, injectable so tests can drive them. */
export interface MaskFileSystem {
  /** Size and mtime, or a thrown error when the path cannot be stat'ed. */
  stat(path: string): { readonly size: number; readonly mtimeMs: number };
  readText(path: string): string;
}

const NODE_FILE_SYSTEM: MaskFileSystem = {
  stat: (path) => {
    const stats = statSync(path);
    return { size: stats.size, mtimeMs: stats.mtimeMs };
  },
  readText: (path) => readFileSync(path, 'utf8'),
};

/** What one {@link StaticSourceMaskReloader.check} did. */
export type MaskReloadOutcome =
  | { readonly kind: 'unchanged' }
  | { readonly kind: 'reloaded'; readonly from: string; readonly to: string }
  | { readonly kind: 'rejected'; readonly version: string; readonly reason: string };

export interface StaticSourceMaskReloader {
  readonly path: string;
  /** The mask in force: the boot mask until a check swaps in a newer one. */
  current(): StaticSourceMask;
  /** Looks at the file once; swaps the mask in (one reference assignment) when it is new. */
  check(): MaskReloadOutcome;
}

/**
 * Loads the mask now (throwing exactly like {@link loadStaticSourceMask} — boot still
 * fails loudly) and returns a reloader that watches the same path; see "Hot reload".
 */
export function createStaticSourceMaskReloader(
  path: string | null,
  fs: MaskFileSystem = NODE_FILE_SYSTEM,
): StaticSourceMaskReloader {
  const file = path ?? REPO_STATIC_SOURCES_PATH;
  // Stat before read: a replacement landing between the two is seen by the first check.
  // A stat failure here is left to the read, which throws the error boot should print.
  let fingerprint = '';
  try {
    fingerprint = fingerprintOf(fs, file);
  } catch {
    // fall through to readMask
  }
  let loaded = readMask(file, fs);
  return {
    path: file,
    current: () => loaded.mask,
    check(): MaskReloadOutcome {
      const version = loaded.mask.version;
      let next: string;
      try {
        next = fingerprintOf(fs, file);
      } catch (error) {
        return { kind: 'rejected', version, reason: messageOf(error) };
      }
      if (next === fingerprint) return { kind: 'unchanged' };
      let candidate: LoadedMask;
      try {
        candidate = readMask(file, fs);
      } catch (error) {
        // The fingerprint is not advanced: the next check retries the same (or a fixed) file.
        return { kind: 'rejected', version, reason: messageOf(error) };
      }
      if (candidate.sha256 === loaded.sha256) {
        fingerprint = next;
        return { kind: 'unchanged' };
      }
      if (candidate.mask.version === version) {
        return {
          kind: 'rejected',
          version,
          reason: `the file's bytes changed but its version is still ${version}`,
        };
      }
      fingerprint = next;
      loaded = candidate;
      return { kind: 'reloaded', from: version, to: candidate.mask.version };
    },
  };
}

interface LoadedMask {
  readonly mask: StaticSourceMask;
  readonly sha256: string;
}

function fingerprintOf(fs: MaskFileSystem, file: string): string {
  const { size, mtimeMs } = fs.stat(file);
  return `${String(size)}:${String(mtimeMs)}`;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function readMask(file: string, fs: MaskFileSystem = NODE_FILE_SYSTEM): LoadedMask {
  let text: string;
  try {
    text = fs.readText(file);
  } catch (error) {
    throw new Error(
      `static hot-source mask not readable at ${file} (set FIRE_WATCH_STATIC_SOURCES): ` +
        (error instanceof Error ? error.message : String(error)),
      { cause: error },
    );
  }
  return {
    mask: parseStaticSourceMask(JSON.parse(text) as unknown),
    sha256: createHash('sha256').update(text).digest('hex'),
  };
}
