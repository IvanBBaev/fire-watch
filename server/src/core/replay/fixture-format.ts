/**
 * The on-disk shape of a golden-replay fixture (CI-1, CI-2; GATES §1.1).
 *
 * A fixture is a directory: one `manifest.json`, one JSON file per poll, and one
 * `expected.json` holding the *outcomes* the scenario asserts. Parsing lives here, in
 * the core, and reading files lives in an adapter, so the format is testable without a
 * filesystem and the core stays replayable.
 *
 * Every field below exists because omitting it produced a specific failure mode:
 *
 *   - `clockStart` — without a declared start instant the fixture's meaning depends on
 *     the day CI runs it, which is exactly what the virtual clock exists to prevent.
 *   - `configVersions` — parameters are versioned data (ADR-002 D5). A fixture that
 *     does not pin them silently changes what it asserts the next time someone tunes
 *     `eps`, and the change looks like a code regression.
 *   - `mode` / `allowRevive` — CI-6: an offline replay must emit zero alerts, and
 *     reviving an archived event on a replay requires saying so out loud (I4).
 *   - `required` — GATES §1.1 splits the register into pre-merge, pre-season and
 *     suite-owned scenarios. The gate reads this field; it is not documentation.
 */

import { detectionUidPreimage } from '@fire-watch/contracts';

import { CONFIG_VERSION_RE } from '../config/versioned-config.js';
import { epochMsFromIso, type EpochMs } from '../ports/clock.js';

/** When this fixture has to be green. Mirrors the "Required" column of GATES §1.1. */
export const FIXTURE_REQUIREMENTS = ['pre-merge', 'pre-season', 'suite'] as const;
export type FixtureRequirement = (typeof FIXTURE_REQUIREMENTS)[number];

/**
 * `live` is a forward replay of freshly polled data; `offline` is reprocessing or
 * backfill. The distinction is not cosmetic — it is the switch CI-6 asserts on.
 */
export const REPLAY_MODES = ['live', 'offline'] as const;
export type ReplayMode = (typeof REPLAY_MODES)[number];

export interface FixtureManifest {
  /** `S1`…`S16` for the register, or a local id for harness-only fixtures. */
  readonly id: string;
  readonly title: string;
  /** What the scenario asserts, in one line — copied into failure output. */
  readonly asserts: string;
  readonly required: FixtureRequirement;
  readonly owner: string;
  readonly clockStart: string;
  readonly mode: ReplayMode;
  readonly allowRevive: boolean;
  readonly configVersions: Readonly<Record<string, string>>;
  /** Poll files, in the order they were observed. Relative to the fixture directory. */
  readonly inputs: readonly string[];
  readonly expected: string;
}

/** A single poll: the instant we could first have seen these rows, and the rows. */
export interface ReplayBatchInput {
  readonly name: string;
  readonly availableAt: EpochMs;
  readonly detections: readonly ReplayDetectionInput[];
}

/**
 * The detection fields a replay needs. Deliberately narrower than the `detections`
 * table: a fixture asserts outcomes, and every extra column is another thing to keep
 * in sync for no assertion's benefit.
 */
export interface ReplayDetectionInput {
  readonly detectionUid: string;
  readonly source: string;
  readonly availableAt: EpochMs;
  readonly acqTsIso: string;
  /** Canonical 5 dp decimal text — the hash preimage, never a float (GLOSSARY §1b). */
  readonly latCanonical: string;
  readonly lonCanonical: string;
  readonly confidence: 'low' | 'nominal' | 'high';
  readonly frpMw: number | null;
  readonly dayNight: 'D' | 'N' | null;
}

const ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;
const CANONICAL_DEGREES_RE = /^-?\d{1,3}\.\d{5}$/;
const SHA256_HEX_RE = /^[0-9a-f]{64}$/;
const CONFIDENCE_VALUES = ['low', 'nominal', 'high'] as const;
const DAY_NIGHT_VALUES = ['D', 'N'] as const;

class FixtureFormatError extends Error {
  constructor(origin: string, detail: string) {
    super(`${origin}: ${detail}`);
    this.name = 'FixtureFormatError';
  }
}

function asRecord(raw: unknown, origin: string): Record<string, unknown> {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new FixtureFormatError(origin, 'expected a JSON object');
  }
  return raw as Record<string, unknown>;
}

function requireString(record: Record<string, unknown>, key: string, origin: string): string {
  const value = record[key];
  if (typeof value !== 'string' || value.length === 0) {
    throw new FixtureFormatError(origin, `"${key}" must be a non-empty string`);
  }
  return value;
}

function requireEnum<T extends string>(
  record: Record<string, unknown>,
  key: string,
  allowed: readonly T[],
  origin: string,
): T {
  const value = record[key];
  if (typeof value !== 'string' || !(allowed as readonly string[]).includes(value)) {
    throw new FixtureFormatError(origin, `"${key}" must be one of ${allowed.join(', ')}`);
  }
  return value as T;
}

function requireBoolean(record: Record<string, unknown>, key: string, origin: string): boolean {
  const value = record[key];
  if (typeof value !== 'boolean') {
    throw new FixtureFormatError(origin, `"${key}" must be a boolean`);
  }
  return value;
}

function requireMatch(
  record: Record<string, unknown>,
  key: string,
  pattern: RegExp,
  origin: string,
): string {
  const value = requireString(record, key, origin);
  if (!pattern.test(value)) {
    throw new FixtureFormatError(origin, `"${key}" does not match ${pattern.source}: ${value}`);
  }
  return value;
}

/**
 * A fixture file name may not escape its directory. The loader joins these onto a path,
 * and a fixture is checked-in data that a future contributor edits — a traversal here
 * would be a file-read primitive driven by a JSON string.
 */
function requireRelativeFile(value: string, key: string, origin: string): string {
  if (value.startsWith('/') || value.includes('..') || value.includes('\\')) {
    throw new FixtureFormatError(origin, `"${key}" must be a plain file name, got ${value}`);
  }
  return value;
}

export function parseFixtureManifest(raw: unknown, origin: string): FixtureManifest {
  const record = asRecord(raw, origin);

  const configVersionsRaw = record['configVersions'];
  const configVersionsRecord = asRecord(configVersionsRaw, `${origin} configVersions`);
  const configVersions: Record<string, string> = {};
  for (const [name, version] of Object.entries(configVersionsRecord)) {
    if (typeof version !== 'string' || !CONFIG_VERSION_RE.test(version)) {
      throw new FixtureFormatError(
        origin,
        `configVersions.${name} must look like clustering_params_v1, got ${JSON.stringify(version)}`,
      );
    }
    configVersions[name] = version;
  }
  if (Object.keys(configVersions).length === 0) {
    // Not pedantry: an unpinned fixture asserts against whatever the parameters happen
    // to be, so a parameter change shows up as a mysterious fixture failure elsewhere.
    throw new FixtureFormatError(origin, 'configVersions must pin at least one config');
  }

  const inputsRaw = record['inputs'];
  if (!Array.isArray(inputsRaw) || inputsRaw.length === 0) {
    throw new FixtureFormatError(origin, '"inputs" must be a non-empty array of file names');
  }
  const inputs = inputsRaw.map((entry, index) => {
    if (typeof entry !== 'string' || entry.length === 0) {
      throw new FixtureFormatError(origin, `inputs[${String(index)}] must be a file name`);
    }
    return requireRelativeFile(entry, `inputs[${String(index)}]`, origin);
  });

  const clockStart = requireString(record, 'clockStart', origin);
  epochMsFromIso(clockStart); // throws with the reason if it is not an explicit UTC instant

  return Object.freeze({
    id: requireMatch(record, 'id', ID_RE, origin),
    title: requireString(record, 'title', origin),
    asserts: requireString(record, 'asserts', origin),
    required: requireEnum(record, 'required', FIXTURE_REQUIREMENTS, origin),
    owner: requireString(record, 'owner', origin),
    clockStart,
    mode: requireEnum(record, 'mode', REPLAY_MODES, origin),
    allowRevive: requireBoolean(record, 'allowRevive', origin),
    configVersions: Object.freeze(configVersions),
    inputs: Object.freeze(inputs),
    expected: requireRelativeFile(requireString(record, 'expected', origin), 'expected', origin),
  });
}

export function parseReplayBatch(raw: unknown, name: string): ReplayBatchInput {
  const origin = `batch ${name}`;
  const record = asRecord(raw, origin);
  const availableAt = epochMsFromIso(requireString(record, 'availableAt', origin));

  const detectionsRaw = record['detections'];
  if (!Array.isArray(detectionsRaw)) {
    // An empty array is legal and meaningful: a poll that succeeds and returns nothing
    // is a healthy poll, and S8 depends on being able to express one.
    throw new FixtureFormatError(origin, '"detections" must be an array');
  }

  const detections = detectionsRaw.map((entry, index) =>
    parseReplayDetection(entry, `${origin}[${String(index)}]`, availableAt),
  );

  return Object.freeze({ name, availableAt, detections: Object.freeze(detections) });
}

function parseReplayDetection(
  raw: unknown,
  origin: string,
  batchAvailableAt: EpochMs,
): ReplayDetectionInput {
  const record = asRecord(raw, origin);

  const availableAtRaw = record['availableAt'];
  const availableAt =
    availableAtRaw === undefined
      ? batchAvailableAt
      : epochMsFromIso(requireString(record, 'availableAt', origin));
  if (availableAt > batchAvailableAt) {
    throw new FixtureFormatError(
      origin,
      'availableAt is later than the poll that returned it — a row cannot be handed over before it exists',
    );
  }

  const frpRaw = record['frpMw'];
  if (frpRaw !== null && typeof frpRaw !== 'number') {
    throw new FixtureFormatError(origin, '"frpMw" must be a number or null');
  }
  if (typeof frpRaw === 'number' && !Number.isFinite(frpRaw)) {
    throw new FixtureFormatError(origin, '"frpMw" must be finite');
  }

  const dayNightRaw = record['dayNight'];
  if (dayNightRaw !== null && !(DAY_NIGHT_VALUES as readonly unknown[]).includes(dayNightRaw)) {
    throw new FixtureFormatError(origin, '"dayNight" must be "D", "N" or null');
  }

  const detection = Object.freeze({
    detectionUid: requireMatch(record, 'detectionUid', SHA256_HEX_RE, origin),
    source: requireString(record, 'source', origin),
    availableAt,
    acqTsIso: requireString(record, 'acqTsIso', origin),
    latCanonical: requireMatch(record, 'latCanonical', CANONICAL_DEGREES_RE, origin),
    lonCanonical: requireMatch(record, 'lonCanonical', CANONICAL_DEGREES_RE, origin),
    confidence: requireEnum(record, 'confidence', CONFIDENCE_VALUES, origin),
    frpMw: frpRaw,
    dayNight: dayNightRaw as 'D' | 'N' | null,
  });

  // Rebuilding the pre-image is free validation of four fields at once: the source has
  // to be in the frozen §1a registry, `acqTsIso` has to be the 20-character minute form,
  // and the coordinates have to be in range. Verifying the digest itself needs a hash and
  // therefore happens in the loader, where a platform API is allowed.
  detectionUidPreimage({
    source: detection.source,
    acqTsIso: detection.acqTsIso,
    lat: detection.latCanonical,
    lon: detection.lonCanonical,
  });

  return detection;
}
