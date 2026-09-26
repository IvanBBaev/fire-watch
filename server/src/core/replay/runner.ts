/**
 * The golden-replay runner (ADR-002 D7; gates CI-1, CI-2, CI-6).
 *
 * This is the *harness*, not the engine. The clustering and identity engine is WP2 work
 * and arrives through the `ReplayEngine` port, so the harness can exist — and be gated
 * on — before there is anything real to plug into it.
 *
 * Everything the harness does is in service of one property: two runs of the same
 * fixture produce the same bytes. That means the clock is virtual and advances only
 * because a batch says so, the order within a batch is the fixed key from
 * `batch-order.ts`, and the report is canonical JSON. Anything an engine does that is
 * order- or time-dependent then shows up as a diff instead of as an intermittent
 * failure in October.
 *
 * The harness is also where CI-6 is enforced rather than trusted: an offline replay whose
 * gate decides to notify throws here, at the boundary, so no engine bug can turn a backfill
 * into a wall of 3 AM notifications. Seeding state during a backfill is not notifying, and
 * is what reprocessing is for, so those decisions pass through and are recorded.
 */

import {
  assertTotalOrder,
  orderBatch,
  type OrderableDetection,
} from '../determinism/batch-order.js';
import { canonicalJson } from '../determinism/canonical-json.js';
import { VirtualClock, isoFromEpochMs, type Clock, type EpochMs } from '../ports/clock.js';
import type {
  FixtureManifest,
  ObservationContext,
  ReplayBatchInput,
  ReplayDetectionInput,
} from './fixture-format.js';

/**
 * One loaded fixture: what the satellites delivered, what else was true while they did,
 * and what the scenario asserts.
 *
 * `observations` is always present — `EMPTY_OBSERVATIONS` when the manifest names no file
 * — so that a tick reads the same three arrays whether or not the fixture happens to care
 * about cloud, and no consumer has to branch on a null that means "nothing was going on".
 */
export interface ReplayFixture {
  readonly manifest: FixtureManifest;
  readonly batches: readonly ReplayBatchInput[];
  /** Cloud, source outages and official declarations — the tick's non-detection inputs. */
  readonly observations: ObservationContext;
  /** Whatever the fixture's `expected.json` holds; compared with `diffAgainstExpected`. */
  readonly expected: unknown;
}

/** A detection as the engine sees it: the orderable key plus the evidence fields. */
export type ReplayDetection = ReplayDetectionInput & OrderableDetection;

/**
 * What a fixture is allowed to assert about an event. Outcomes only — no cluster ids, no
 * internal counters (CI-1). A fixture that asserts internals stops being a regression
 * test and becomes a change-detector.
 */
export interface ReplayEvent {
  readonly publicId: string;
  /**
   * `null` where no implemented decision assigns the field yet — the lifecycle accumulator
   * for `status` (D4), the score for `bucket` (ADR-002 D6). A fixture then asserts `null`
   * and goes red the day that decision lands, which is the point: the alternative is
   * asserting a plausible constant that no function produced, and a suite full of those
   * proves the engine still agrees with a guess someone made once.
   */
  readonly status: string | null;
  /**
   * Where the event shows (A1.3) — `map`, `feed` or `archive`, and `null` on anything that
   * has no lifecycle to place it: the smoke engine, and a merge tombstone, which is a
   * pointer to the survivor rather than an event with a state of its own.
   *
   * Asserted next to `status` and never derived from it. The two answer different
   * questions — a `no_longer_detected` event stays on the map for 48 h — and a fixture that
   * asserted only the state would go green on a regression that dropped events off the map
   * the moment they stopped being detected.
   */
  readonly displayTier: string | null;
  readonly bucket: string | null;
  readonly detectionUids: readonly string[];
  readonly mergedInto: string | null;
  readonly relation: { readonly publicId: string; readonly kind: string } | null;
  readonly labels: readonly string[];
}

/**
 * One alert-gate decision, as a fixture asserts it. Every decision is recorded, not only
 * the sending ones: "this zone was seeded and stayed silent" is the outcome half of the
 * scenarios exist for, and a report that listed only sends could not tell it apart from a
 * gate that never ran.
 *
 * `alertType` and `alertSubkey` are `null` for every outcome but `send`, because that is
 * what the gate returns — a deferred alert has not chosen its subkey yet.
 */
export interface ReplayAlert {
  readonly zoneId: string;
  readonly publicId: string;
  /** `send`, `defer`, `seed` or `suppress` — the gate's four answers. */
  readonly outcome: string;
  /** Why, in the gate's own vocabulary. The half of a decision a fixture reads. */
  readonly reason: string;
  readonly alertType: string | null;
  readonly alertSubkey: string | null;
  readonly atIso: string;
}

/**
 * The outcomes that put a notification somewhere: `send` writes an outbox row, `defer`
 * holds one for the next digest. `seed` and `suppress` write neither, which is why an
 * offline replay may produce them — reprocessing is *required* to seed state (ADR-004
 * A1.8), and a gate that declines during a backfill has done nothing to be silent about.
 */
const NOTIFYING_OUTCOMES: readonly string[] = ['send', 'defer'];

export interface ReplayContext {
  /** Already positioned at the current batch's instant when `ingest` is called. */
  readonly clock: Clock;
  readonly configVersions: Readonly<Record<string, string>>;
  readonly mode: 'live' | 'offline';
  readonly allowRevive: boolean;
  /**
   * Everything the fixture declared that did not arrive as a detection: cloud, source
   * outages, official statements. An engine that drives the lifecycle needs all three —
   * without them every expected pass is recorded `cloud_blocked` and no miss evidence can
   * accrue at all.
   */
  readonly observations: ObservationContext;
  /** The only way out. Rejected outright in offline mode (CI-6 / I4). */
  readonly emitAlert: (alert: ReplayAlert) => void;
}

export interface ReplayEngine {
  /** One poll, already in canonical order. */
  ingest(batch: readonly ReplayDetection[]): void;
  /** The registry as the fixture asserts it. Called once, after the last batch. */
  events(): readonly ReplayEvent[];
}

export type ReplayEngineFactory = (context: ReplayContext) => ReplayEngine;

export interface ReplayReport {
  readonly fixtureId: string;
  readonly mode: 'live' | 'offline';
  readonly configVersions: Readonly<Record<string, string>>;
  readonly batches: readonly { readonly name: string; readonly detections: number }[];
  readonly events: readonly ReplayEvent[];
  readonly alerts: readonly ReplayAlert[];
}

export function runReplay(fixture: ReplayFixture, createEngine: ReplayEngineFactory): ReplayReport {
  const { manifest, batches } = fixture;
  const clock = new VirtualClock(manifest.clockStart);
  const alerts: ReplayAlert[] = [];

  const engine = createEngine({
    clock,
    configVersions: manifest.configVersions,
    mode: manifest.mode,
    allowRevive: manifest.allowRevive,
    observations: fixture.observations,
    emitAlert: (alert) => {
      if (manifest.mode === 'offline' && NOTIFYING_OUTCOMES.includes(alert.outcome)) {
        throw new Error(
          `${manifest.id}: an offline replay decided ${alert.outcome} (${alert.reason}) for ` +
            `${alert.publicId} — reprocessing and backfill must be silent (ADR-002 I4, gate CI-6)`,
        );
      }
      alerts.push(alert);
    },
  });

  let previousInstant: EpochMs = clock.now();
  const batchSummaries: { name: string; detections: number }[] = [];

  for (const batch of batches) {
    if (batch.availableAt < previousInstant) {
      // Polls are the unit of incremental clustering: seeing them out of order would
      // build a different — and unreproducible — event graph than production did.
      throw new Error(
        `${manifest.id}: batch ${batch.name} at ${isoFromEpochMs(batch.availableAt)} runs ` +
          `before ${isoFromEpochMs(previousInstant)}; fixture polls must be non-decreasing`,
      );
    }
    clock.set(batch.availableAt);
    previousInstant = batch.availableAt;

    const ordered = orderBatch(batch.detections);
    assertTotalOrder(ordered);
    engine.ingest(ordered);

    batchSummaries.push({ name: batch.name, detections: ordered.length });
  }

  return {
    fixtureId: manifest.id,
    mode: manifest.mode,
    configVersions: manifest.configVersions,
    batches: batchSummaries,
    events: sortEvents(engine.events()),
    // Alerts are deliberately *not* sorted: "which alert fired first" is an outcome
    // S13/S14 assert, so emission order is part of the answer.
    alerts: [...alerts],
  };
}

/**
 * The report is sorted before serialization so that an engine which happens to iterate a
 * map in insertion order cannot make the bytes depend on that order. The engine's own
 * determinism is still asserted — by CI-2 — but only for things the fixture asserts.
 */
function sortEvents(events: readonly ReplayEvent[]): readonly ReplayEvent[] {
  return [...events]
    .map((event) => ({ ...event, detectionUids: [...event.detectionUids].sort(compareAscii) }))
    .sort((a, b) => compareAscii(a.publicId, b.publicId));
}

function compareAscii(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** The exact bytes CI-2 compares. Trailing newline so the file is a well-formed text file. */
export function serializeReport(report: ReplayReport): string {
  return `${canonicalJson(report)}\n`;
}

/**
 * Outcome comparison for CI-1. Returns a list of human-readable differences rather than
 * a boolean, because "the fixture failed" is not a debuggable message at 3 AM and a
 * whole-document diff of canonical JSON is barely better.
 */
export function diffAgainstExpected(report: ReplayReport, expected: unknown): string[] {
  const differences: string[] = [];
  collectDifferences(JSON.parse(canonicalJson(report)) as unknown, expected, '$', differences);
  return differences;
}

function collectDifferences(actual: unknown, expected: unknown, path: string, out: string[]): void {
  if (out.length >= 50) return; // A hundred-line diff is noise; the first few say why.

  if (Array.isArray(expected) || Array.isArray(actual)) {
    if (!Array.isArray(expected) || !Array.isArray(actual)) {
      out.push(`${path}: expected ${describe(expected)}, got ${describe(actual)}`);
      return;
    }
    if (expected.length !== actual.length) {
      out.push(
        `${path}: expected ${String(expected.length)} entries, got ${String(actual.length)}`,
      );
    }
    for (let i = 0; i < Math.max(expected.length, actual.length); i += 1) {
      collectDifferences(actual[i], expected[i], `${path}[${String(i)}]`, out);
    }
    return;
  }

  if (isPlainObject(expected) && isPlainObject(actual)) {
    const keys = [...new Set([...Object.keys(expected), ...Object.keys(actual)])].sort(
      compareAscii,
    );
    for (const key of keys) {
      collectDifferences(actual[key], expected[key], `${path}.${key}`, out);
    }
    return;
  }

  if (describe(actual) !== describe(expected)) {
    out.push(`${path}: expected ${describe(expected)}, got ${describe(actual)}`);
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** A missing key and an explicit `null` are different answers and must read differently. */
function describe(value: unknown): string {
  return value === undefined ? '<absent>' : canonicalJson(value);
}
