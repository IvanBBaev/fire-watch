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
 *   - `engine` — which engine the fixture drives. Declared rather than inferred, because
 *     `harness-smoke` must keep running the placeholder forever: it is the fixture that
 *     fails when the *harness* breaks rather than when the clustering does, and a rule
 *     that guessed from the pinned config versions would quietly re-point it the first
 *     time someone tidied that manifest.
 *   - `observations` — the non-detection inputs a lifecycle tick reads: cloud, source
 *     outages and official declarations. Without them a fixture can only say what the
 *     satellites delivered, and the scenarios that turn on what we could *not* see — S7's
 *     cloudy gap, S8's transient source outage, S12's re-detection after an official
 *     extinguishment — cannot be written down at all.
 */

import {
  CURATED_LIFECYCLE_STATES,
  assertSourceId,
  detectionUidPreimage,
  type CuratedLifecycleState,
} from '@fire-watch/contracts';

import { CONFIG_VERSION_RE } from '../config/versioned-config.js';
import type { CloudCoverSample, SourceOutage } from '../lifecycle/types.js';
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

/**
 * `identity` is the real clustering/merge/reignition path — what a register scenario
 * asserts. `alert` is that same path with the alert gate wired behind it, kept separate so
 * an identity fixture is never asked to pin a gating config it does not exercise. `smoke`
 * is the placeholder that only proves the harness is deterministic.
 */
export const REPLAY_ENGINES = ['identity', 'alert', 'smoke'] as const;
export type ReplayEngineId = (typeof REPLAY_ENGINES)[number];

export interface FixtureManifest {
  /** `S1`…`S16` for the register, or a local id for harness-only fixtures. */
  readonly id: string;
  readonly title: string;
  /** What the scenario asserts, in one line — copied into failure output. */
  readonly asserts: string;
  readonly required: FixtureRequirement;
  readonly owner: string;
  readonly engine: ReplayEngineId;
  readonly clockStart: string;
  readonly mode: ReplayMode;
  readonly allowRevive: boolean;
  readonly configVersions: Readonly<Record<string, string>>;
  /** Poll files, in the order they were observed. Relative to the fixture directory. */
  readonly inputs: readonly string[];
  readonly expected: string;
  /**
   * The observation-context file, or `null` where the scenario asserts nothing about
   * cloud, outages or official statements. Nullable-required rather than optional: having
   * no such file is a normal, complete fixture, not an under-specified one.
   */
  readonly observations: string | null;
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
/** Local wall-clock `HH:MM`, 24-hour — what quiet hours are written in. */
const CLOCK_TIME_RE = /^(?:[01]\d|2[0-3]):[0-5]\d$/;
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

/**
 * Bounds are part of the check, not decoration. Every number a fixture states here feeds a
 * comparison — a score against a floor, a distance against another zone's — and an out-of-
 * range value does not fail, it wins or loses every comparison silently.
 */
function requireNumberInRange(
  record: Record<string, unknown>,
  key: string,
  origin: string,
  min: number,
  max: number,
): number {
  const value = record[key];
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new FixtureFormatError(origin, `"${key}" must be a finite number`);
  }
  if (value < min || value > max) {
    throw new FixtureFormatError(
      origin,
      `"${key}" must be between ${String(min)} and ${String(max)}, got ${String(value)}`,
    );
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

  // Absent is the ordinary case — most scenarios assert nothing but detections — so it
  // resolves to `null` rather than to a missing property: a reader asks whether there is
  // a file, never whether someone wrote the key.
  const observations =
    record['observations'] === undefined
      ? null
      : requireRelativeFile(requireString(record, 'observations', origin), 'observations', origin);

  return Object.freeze({
    id: requireMatch(record, 'id', ID_RE, origin),
    title: requireString(record, 'title', origin),
    asserts: requireString(record, 'asserts', origin),
    required: requireEnum(record, 'required', FIXTURE_REQUIREMENTS, origin),
    owner: requireString(record, 'owner', origin),
    engine: requireEnum(record, 'engine', REPLAY_ENGINES, origin),
    clockStart,
    mode: requireEnum(record, 'mode', REPLAY_MODES, origin),
    allowRevive: requireBoolean(record, 'allowRevive', origin),
    configVersions: Object.freeze(configVersions),
    inputs: Object.freeze(inputs),
    expected: requireRelativeFile(requireString(record, 'expected', origin), 'expected', origin),
    observations,
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

/* ------------------------------------------------------------------------------------ *
 * Observation context — everything a lifecycle tick reads that is not a detection.
 * ------------------------------------------------------------------------------------ */

/** An official statement, as a fixture declares it. */
export interface FixtureDeclaration {
  /** Names the event by a detection it holds — public ids are minted at replay time. */
  readonly detectionUid: string;
  readonly state: CuratedLifecycleState;
  readonly declaredAtMs: EpochMs;
  readonly attribution: string;
}

/**
 * A watch zone the alert gate is evaluated against, joined to its account's notification
 * preferences — the shape `AlertZone` wants, as a fixture can state it.
 *
 * `distanceKm` is per zone rather than per (zone, event) because nothing in the replay
 * computes zone geometry: a fixture that wants to assert the nearest-zone tie-break states
 * the two distances directly. That is enough for the tie-break and not enough for anything
 * else, which is the honest boundary until zones carry real polygons (WP3).
 */
export interface FixtureZone {
  readonly zoneId: string;
  /** Zones are compared for the nearest-zone rule only within one account (ADR-004 A1.7). */
  readonly accountId: string;
  /**
   * When the zone was drawn. The gate is not evaluated for it before this instant, and the
   * first evaluation at or after it is the seeding one (A1.8) — which is the whole of S13.
   */
  readonly createdAtMs: EpochMs;
  readonly minScore: number;
  readonly timezone: string;
  /** Local wall-clock `HH:MM`, the vocabulary `isInQuietHours` reads. */
  readonly quietHoursStart: string;
  readonly quietHoursEnd: string;
  readonly newFireOverridesQuietHours: boolean;
  readonly distanceKm: number;
}

/**
 * A score a fixture *states*, because no code computes one: the WP2 scorer does not exist,
 * and `AlertableEvent.score` is required. A stated score is an input to the gate and never
 * an outcome a fixture may assert — `ReplayEvent.bucket` stays `null` for exactly that
 * reason, so no scenario can quietly start claiming the scorer works.
 *
 * Entries are effective-from, so one event's score can rise between polls and drive the
 * escalation ladder without a second scoring mechanism.
 */
export interface FixtureScore {
  /** Names the event by a detection it holds — public ids are minted at replay time. */
  readonly detectionUid: string;
  readonly fromMs: EpochMs;
  readonly score: number;
}

/** Everything a tick needs that did not arrive as a detection. */
export interface ObservationContext {
  readonly cloudCover: readonly CloudCoverSample[];
  readonly outages: readonly SourceOutage[];
  readonly declarations: readonly FixtureDeclaration[];
  readonly zones: readonly FixtureZone[];
  readonly scores: readonly FixtureScore[];
}

/** What a fixture that names no observations file has. Shared, so it is never rebuilt. */
export const EMPTY_OBSERVATIONS: ObservationContext = Object.freeze({
  cloudCover: Object.freeze([]),
  outages: Object.freeze([]),
  declarations: Object.freeze([]),
  zones: Object.freeze([]),
  scores: Object.freeze([]),
});

const OBSERVATION_KEYS = ['cloudCover', 'outages', 'declarations', 'zones', 'scores'] as const;

const HOUR_MS = 3_600_000;

/**
 * 40 days of hourly samples. The longest thing a scenario legitimately spans is the
 * 14-day unobservability fallback with room around it; a mistyped year in a span bound
 * expands to millions of samples, which looks like a hang rather than like a bad fixture.
 */
const MAX_CLOUD_HOURS = 960;

/**
 * One `cloudCover` entry before expansion: a half-open run of whole UTC hours that share
 * one reading. Internal on purpose — {@link ObservationContext} carries only the hourly
 * vocabulary the accumulator already speaks, so nothing downstream learns a second format.
 */
interface CloudSpan {
  readonly index: number;
  readonly fromIso: string;
  readonly toIso: string;
  readonly fromMs: EpochMs;
  readonly toMs: EpochMs;
  readonly percent: number;
}

/**
 * Parses an observations file: cloud, source outages and official declarations.
 *
 * Every rule below is here because breaking it produces a *green* fixture that asserts
 * something other than what its author wrote — the one failure mode a golden-replay suite
 * cannot absorb.
 */
export function parseObservationContext(raw: unknown, origin: string): ObservationContext {
  const record = asRecord(raw, origin);

  // Unknown keys are fatal here, unlike in the manifest, and the asymmetry is deliberate.
  // Every field the manifest reads is required, so a typo there surfaces loudly as the
  // missing field it displaced. Every array here is optional and defaults to empty, so a
  // typo'd "clouds" would parse to "no cloud at all" — the fixture stays green and now
  // asserts the opposite of the sky its author declared.
  for (const key of Object.keys(record)) {
    if (!(OBSERVATION_KEYS as readonly string[]).includes(key)) {
      throw new FixtureFormatError(
        origin,
        `unknown key "${key}"; expected one of ${OBSERVATION_KEYS.join(', ')}`,
      );
    }
  }

  const spans = mapOptionalArray(record, 'cloudCover', origin, parseCloudSpan);

  return Object.freeze({
    cloudCover: Object.freeze(expandCloudSpans(spans, origin)),
    outages: Object.freeze(mapOptionalArray(record, 'outages', origin, parseSourceOutage)),
    declarations: Object.freeze(
      mapOptionalArray(record, 'declarations', origin, parseFixtureDeclaration),
    ),
    zones: Object.freeze(mapOptionalArray(record, 'zones', origin, parseFixtureZone)),
    scores: Object.freeze(mapOptionalArray(record, 'scores', origin, parseFixtureScore)),
  });
}

/**
 * A declaration or a score names its event by a detection the event holds, because public
 * ids are minted during the replay and a fixture cannot know them in advance. A mistyped
 * uid then names an event that never exists, and the entry silently does nothing — S12
 * would report a re-detection after an extinguishment that was never declared, and pass;
 * S13 would report no alert because the event it scored stayed unscored, and pass.
 *
 * Kept here rather than in the loader so it is testable without a filesystem.
 */
export function assertObservationsResolve(
  observations: ObservationContext,
  batches: readonly ReplayBatchInput[],
): void {
  assertZoneIdsUnique(observations.zones);

  if (observations.declarations.length === 0 && observations.scores.length === 0) return;

  const delivered = new Set<string>();
  for (const batch of batches) {
    for (const detection of batch.detections) {
      delivered.add(detection.detectionUid);
    }
  }

  for (const [index, declaration] of observations.declarations.entries()) {
    if (!delivered.has(declaration.detectionUid)) {
      throw new FixtureFormatError(
        'observations',
        `declarations[${String(index)}] names detection ${declaration.detectionUid}, which no ` +
          'poll in this fixture delivers — the declaration would attach to no event at all',
      );
    }
  }

  for (const [index, score] of observations.scores.entries()) {
    if (!delivered.has(score.detectionUid)) {
      throw new FixtureFormatError(
        'observations',
        `scores[${String(index)}] names detection ${score.detectionUid}, which no poll in this ` +
          'fixture delivers — the event would stay unscored and every alert gate would decline',
      );
    }
  }
}

/**
 * Two zones sharing an id is not a duplicate row, it is two different watch zones the gate
 * would fold into one state key: the second's decision would overwrite the first's, and the
 * nearest-zone tie-break the fixture exists to assert would never run.
 */
function assertZoneIdsUnique(zones: readonly FixtureZone[]): void {
  const seen = new Set<string>();
  for (const [index, zone] of zones.entries()) {
    if (seen.has(zone.zoneId)) {
      throw new FixtureFormatError(
        'observations',
        `zones[${String(index)}] repeats zoneId ${zone.zoneId}; a zone id is its state key`,
      );
    }
    seen.add(zone.zoneId);
  }
}

/**
 * Reads an optional array field. Absent means empty: a scenario that says nothing about
 * outages is not the same as a malformed one, and requiring three empty arrays in every
 * file would make the interesting one harder to spot.
 */
function mapOptionalArray<T>(
  record: Record<string, unknown>,
  key: string,
  origin: string,
  parse: (entry: unknown, entryOrigin: string, index: number) => T,
): T[] {
  const value = record[key];
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    throw new FixtureFormatError(origin, `"${key}" must be an array`);
  }
  return value.map((entry: unknown, index: number) =>
    parse(entry, `${origin} ${key}[${String(index)}]`, index),
  );
}

function parseCloudSpan(raw: unknown, origin: string, index: number): CloudSpan {
  const record = asRecord(raw, origin);

  const fromIso = requireString(record, 'fromIso', origin);
  const toIso = requireString(record, 'toIso', origin);
  const fromMs = requireHourStart(fromIso, 'fromIso', origin);
  const toMs = requireHourStart(toIso, 'toIso', origin);

  if (toMs <= fromMs) {
    // A span that ends where it starts covers nothing, which is a way of writing "clear
    // sky here" that produces no sample at all — and an hour with no sample is not clear,
    // it is unknown, so the scenario would quietly assert the opposite.
    throw new FixtureFormatError(
      origin,
      `"toIso" (${toIso}) must be strictly after "fromIso" (${fromIso}) — a span covers ` +
        'the hours between them, half-open, and an empty one declares nothing',
    );
  }

  const percent = record['percent'];
  if (typeof percent !== 'number' || !Number.isFinite(percent) || percent < 0 || percent > 100) {
    throw new FixtureFormatError(
      origin,
      `"percent" must be a finite number between 0 and 100, got ${JSON.stringify(percent)}`,
    );
  }

  return Object.freeze({ index, fromIso, toIso, fromMs, toMs, percent });
}

/**
 * Turns the spans into the hourly samples the accumulator indexes, and refuses the two
 * ways a set of spans can be ambiguous or absurd.
 */
function expandCloudSpans(spans: readonly CloudSpan[], origin: string): CloudCoverSample[] {
  // Spans may not overlap, so the file reads as a partition of the fixture's time and
  // "which reading applies at 14:00" has one answer. The accumulator does resolve a
  // duplicated hour — to its highest reading — but that rule is buried in it, and a
  // fixture whose meaning depends on knowing it is a fixture nobody can review.
  const ordered = [...spans].sort((a, b) => a.fromMs - b.fromMs || a.index - b.index);
  for (let i = 1; i < ordered.length; i += 1) {
    const previous = ordered[i - 1];
    const current = ordered[i];
    if (previous === undefined || current === undefined) continue;
    if (current.fromMs < previous.toMs) {
      throw new FixtureFormatError(
        origin,
        `cloudCover[${String(previous.index)}] (${previous.fromIso}…${previous.toIso}) overlaps ` +
          `cloudCover[${String(current.index)}] (${current.fromIso}…${current.toIso}); spans must ` +
          'not overlap',
      );
    }
  }

  const samples: CloudCoverSample[] = [];
  for (const span of spans) {
    const hours = (span.toMs - span.fromMs) / HOUR_MS;
    if (samples.length + hours > MAX_CLOUD_HOURS) {
      throw new FixtureFormatError(
        origin,
        `cloudCover[${String(span.index)}] (${span.fromIso}…${span.toIso}) takes this file past ` +
          `${String(MAX_CLOUD_HOURS)} expanded hours (40 days); check the year on its bounds`,
      );
    }
    for (let at = span.fromMs; at < span.toMs; at += HOUR_MS) {
      samples.push(Object.freeze({ hourStartMs: at, percent: span.percent }));
    }
  }
  return samples;
}

/**
 * The accumulator indexes cloud by the hour a sample starts, and *requires* the alignment
 * rather than rounding to it. A bound at 11:30 would produce samples filed under an hour
 * nothing ever looks up, every pass would fall to the missing-sample branch, and the
 * fixture would assert a sky it never declared.
 */
function requireHourStart(iso: string, key: string, origin: string): EpochMs {
  const ms = epochMsFromIso(iso); // throws with its own reason if it is not a UTC instant
  if (ms % HOUR_MS !== 0) {
    throw new FixtureFormatError(origin, `"${key}" must be an exact UTC hour boundary, got ${iso}`);
  }
  return ms;
}

function parseSourceOutage(raw: unknown, origin: string): SourceOutage {
  const record = asRecord(raw, origin);

  // An outage is scoped to one source and nothing else (ADR-002 A2.3(1)). A source id
  // outside the frozen §1a registry scopes it to nothing, so every real source keeps
  // accumulating and the scenario asserts the absence of the outage it is named after.
  const source = assertSourceId(requireString(record, 'source', origin));
  const fromMs = epochMsFromIso(requireString(record, 'fromIso', origin));

  const toRaw = record['toIso'];
  if (toRaw !== null && typeof toRaw !== 'string') {
    throw new FixtureFormatError(
      origin,
      '"toIso" must be a UTC instant, or null for an outage that is still open',
    );
  }
  const toMs = toRaw === null ? null : epochMsFromIso(toRaw);
  if (toMs !== null && toMs < fromMs) {
    // Depending on how a reader compares the bounds, a backwards window is either empty
    // or unbounded. Neither is what anyone wrote, and both look like a passing fixture.
    throw new FixtureFormatError(
      origin,
      '"toIso" is earlier than "fromIso" — an outage cannot end before it starts',
    );
  }

  return Object.freeze({ source, fromMs, toMs });
}

function parseFixtureDeclaration(raw: unknown, origin: string): FixtureDeclaration {
  const record = asRecord(raw, origin);

  return Object.freeze({
    // Not a public id: those are minted during the replay, so a fixture names the event
    // by a detection it holds and the runner resolves it.
    detectionUid: requireMatch(record, 'detectionUid', SHA256_HEX_RE, origin),
    // Only the two curated states exist as declarations. A machine state here would let a
    // fixture claim the pipeline reached a conclusion an authority alone may state.
    state: requireEnum(record, 'state', CURATED_LIFECYCLE_STATES, origin),
    declaredAtMs: epochMsFromIso(requireString(record, 'declaredAtIso', origin)),
    // Non-empty, and enforced rather than trusted: an unattributed official statement is
    // exactly the thing the product may never render (GLOSSARY §3).
    attribution: requireString(record, 'attribution', origin),
  });
}

function parseFixtureZone(raw: unknown, origin: string): FixtureZone {
  const record = asRecord(raw, origin);

  const timezone = requireString(record, 'timezone', origin);
  // Resolved here rather than at decision time. `isInQuietHours` throws RangeError on an
  // unknown zone, which inside a replay would surface as a harness crash with no file name
  // on it; a fixture that names "Europe/Sofa" should be told so by the parser.
  try {
    new Intl.DateTimeFormat('en-GB', { timeZone: timezone });
  } catch {
    throw new FixtureFormatError(origin, `"timezone" is not an IANA zone: ${timezone}`);
  }

  return Object.freeze({
    zoneId: requireMatch(record, 'zoneId', ID_RE, origin),
    accountId: requireMatch(record, 'accountId', ID_RE, origin),
    createdAtMs: epochMsFromIso(requireString(record, 'createdAtIso', origin)),
    // The same floor `assertZoneFloor` enforces at decision time (ADR-004 A1.2): a zone
    // below 0.3 would ask for alerts the product does not stand behind.
    minScore: requireNumberInRange(record, 'minScore', origin, 0.3, 1),
    timezone,
    quietHoursStart: requireMatch(record, 'quietHoursStart', CLOCK_TIME_RE, origin),
    quietHoursEnd: requireMatch(record, 'quietHoursEnd', CLOCK_TIME_RE, origin),
    newFireOverridesQuietHours: requireBoolean(record, 'newFireOverridesQuietHours', origin),
    distanceKm: requireNumberInRange(record, 'distanceKm', origin, 0, 20_000),
  });
}

function parseFixtureScore(raw: unknown, origin: string): FixtureScore {
  const record = asRecord(raw, origin);

  return Object.freeze({
    detectionUid: requireMatch(record, 'detectionUid', SHA256_HEX_RE, origin),
    fromMs: epochMsFromIso(requireString(record, 'fromIso', origin)),
    score: requireNumberInRange(record, 'score', origin, 0, 1),
  });
}
