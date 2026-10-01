/**
 * One orbital-element refresh: fetch each pass platform's GP elements from CelesTrak and
 * store them with provenance (TASKS F15; DATA-SOURCES §F15).
 *
 * ## CelesTrak's usage policy is enforced here, not remembered
 *
 * The policy (celestrak.org/NORAD/documentation/gp-data-formats.php → usage policy, read
 * 2026-09-30) asks three things of a machine client, and each has a mechanism:
 *
 *   * **Download each element set once per update, no more.** GP data is refreshed about
 *     every two hours; the worker runs this job every {@link TLE_REFRESH_INTERVAL_MS}
 *     (12 h), five small requests per cycle.
 *   * **Stop on any non-200 and tell a human.** A non-200 writes the halt latch
 *     ({@link TLE_HALT_PATH}) and ends the cycle; while the latch exists the job makes no
 *     request at all, every cycle, and reports itself degraded — so the stop is loud and
 *     it survives a restart. An operator clears it by deleting the file after reading why
 *     (OPERATIONS runbook, the reason and status are inside it). A transport failure — no
 *     response at all — is not an answer from CelesTrak and does not latch; the next cycle
 *     is the retry.
 *   * **Repeated 301/403/404 get the address blocked.** The HTTP client refuses redirects,
 *     so a 301 is a non-200 and latches on the first occurrence; a 403 or 404 likewise.
 *
 * ## Storage
 *
 * One payload and one sidecar per satellite, `tle/celestrak/<norad>.json` and
 * `<norad>.meta.json`, each written atomically. Per-satellite files mean a cycle that
 * stores three of five platforms leaves the other two at their previous elements rather
 * than losing them; the pass route labels each platform's element age separately. A body
 * is stored only when {@link parseOmmBody} accepts it for the catalogue number asked for.
 *
 * The raw elements are never served: the product publishes derived pass times and the
 * element epoch, nothing more (DATA-SOURCES §F15 — no redistribution terms are published).
 *
 * ## The `celestrak:elements` feed row
 *
 * Every cycle — a halted one included — records one attempt on the `celestrak:elements`
 * freshness row, as part of the work, like `weather:context`. It **succeeds** only when
 * every platform was stored with an epoch younger than {@link TLE_STALE_AFTER_MS}: a 200
 * carrying three-day-old elements (a platform CelesTrak has stopped updating) keeps the row
 * ageing exactly as a failed fetch would, because what the row watches is whether the
 * predictions rest on current elements. `hadData` is "anything stored this cycle". A halt
 * records a failure every cycle, so the status page shows the row going warn then critical
 * while the latch waits for a human — the halt is loud in two places, the log line and the
 * freshness surface. A store failure is reported as `feedStatusError` and degrades the
 * cycle; it never throws out of the job.
 */

import { canonicalJson } from '../determinism/canonical-json.js';
import type { Clock, EpochMs } from '../ports/clock.js';
import type { FeedStatusStore } from '../ports/feed-status-store.js';
import { isoFromEpochMs } from '../ports/clock.js';
import type { PayloadStore } from '../ports/payload-store.js';
import type { TleClient } from '../ports/tle-client.js';
import { parseOmmBody } from './omm.js';
import { PASS_PLATFORMS, type PassPlatform } from './pass-platforms.js';
import { TLE_STALE_AFTER_MS } from './passes-document.js';

export const TLE_REFRESH_INTERVAL_MS = 12 * 3_600_000;

export const TLE_DIR = 'tle/celestrak';
export const TLE_HALT_PATH = `${TLE_DIR}/halt.json`;
export const TLE_PROVIDER = 'celestrak';

export function tleElementsPath(noradId: number): string {
  return `${TLE_DIR}/${String(noradId)}.json`;
}

export function tleMetaPath(noradId: number): string {
  return `${TLE_DIR}/${String(noradId)}.meta.json`;
}

export interface TleRefreshDeps {
  readonly client: TleClient;
  readonly payloads: PayloadStore;
  readonly clock: Clock;
  /** Where the `celestrak:elements` attempt is recorded, every cycle. */
  readonly feedStatus: FeedStatusStore;
  /** Defaults to {@link PASS_PLATFORMS}; injectable for tests. */
  readonly platforms?: readonly PassPlatform[];
}

export type TleOutcome =
  | 'stored'
  /** No response at all (timeout, DNS, reset). Transient; the next cycle retries. */
  | 'fetch_failed'
  /** A non-200. The halt latch is written and the cycle ends. */
  | 'refused'
  /** A 200 whose body is not one valid OMM for this satellite. Nothing stored. */
  | 'invalid'
  | 'write_failed'
  /** Skipped because an earlier request in this cycle latched the halt. */
  | 'not_attempted';

export interface TlePlatformResult {
  readonly platform: string;
  readonly noradId: number;
  readonly outcome: TleOutcome;
  readonly status: number | null;
  /** The stored element epoch, for `stored`. */
  readonly epoch: string | null;
  readonly error: string | null;
}

export interface TleRefreshReport {
  readonly startedAt: EpochMs;
  readonly finishedAt: EpochMs;
  /** True when the latch was already set at the start: no request was made. */
  readonly halted: boolean;
  /** True when this cycle set the latch. */
  readonly haltedNow: boolean;
  readonly platforms: readonly TlePlatformResult[];
  /** A latch that could not be read or written — the one failure that is not per-platform. */
  readonly haltError: string | null;
  /** `null` when the `celestrak:elements` feed row was recorded. */
  readonly feedStatusError: string | null;
}

/** Degraded when halted, when the latch itself failed, or when nothing at all was stored. */
export function tleRefreshFailed(report: TleRefreshReport): boolean {
  return (
    report.halted ||
    report.haltedNow ||
    report.haltError !== null ||
    report.feedStatusError !== null ||
    !report.platforms.some((result) => result.outcome === 'stored')
  );
}

export async function runTleRefresh(deps: TleRefreshDeps): Promise<TleRefreshReport> {
  const platforms = deps.platforms ?? PASS_PLATFORMS;
  const startedAt = deps.clock.now();

  let halted: boolean;
  try {
    halted = await deps.payloads.exists(TLE_HALT_PATH);
  } catch (error: unknown) {
    // A latch we cannot read is treated as set: the policy's failure mode is "too quiet",
    // never "one more request".
    const haltError = `halt latch unreadable: ${describeError(error)}`;
    return {
      startedAt,
      finishedAt: deps.clock.now(),
      halted: true,
      haltedNow: false,
      platforms: [],
      haltError,
      feedStatusError: await recordFeed(deps, [], haltError),
    };
  }
  if (halted) {
    return {
      startedAt,
      finishedAt: deps.clock.now(),
      halted: true,
      haltedNow: false,
      platforms: [],
      haltError: null,
      feedStatusError: await recordFeed(deps, [], 'halted: the CelesTrak halt latch is set'),
    };
  }

  const results: TlePlatformResult[] = [];
  let haltedNow = false;
  let haltError: string | null = null;
  for (const platform of platforms) {
    if (haltedNow) {
      results.push(result(platform, 'not_attempted', null, null, 'halted earlier in this cycle'));
      continue;
    }
    const outcome = await refreshOne(platform, deps);
    results.push(outcome);
    if (outcome.outcome === 'refused') {
      haltedNow = true;
      haltError = await writeHalt(deps, platform, outcome);
    }
  }

  const feedStatusError = await recordFeed(deps, results, haltError);
  return {
    startedAt,
    finishedAt: deps.clock.now(),
    halted: false,
    haltedNow,
    platforms: results,
    haltError,
    feedStatusError,
  };
}

/**
 * Records this cycle on the `celestrak:elements` row (see the module note for what counts
 * as success). Returns the store's failure, or `null`.
 */
async function recordFeed(
  deps: TleRefreshDeps,
  results: readonly TlePlatformResult[],
  cycleError: string | null,
): Promise<string | null> {
  const attemptAt = deps.clock.now();
  const problems: string[] = cycleError === null ? [] : [cycleError];
  for (const entry of results) {
    if (entry.outcome !== 'stored') {
      problems.push(`${entry.platform}: ${entry.error ?? entry.outcome}`);
    } else if (entry.epoch !== null && attemptAt - Date.parse(entry.epoch) > TLE_STALE_AFTER_MS) {
      problems.push(`${entry.platform}: elements epoch ${entry.epoch} is older than 72 h`);
    }
  }
  try {
    await deps.feedStatus.recordAttempt({
      row: 'celestrak:elements',
      attemptAt,
      succeeded: results.length > 0 && problems.length === 0,
      hadData: results.some((entry) => entry.outcome === 'stored'),
      error: problems.length === 0 ? null : problems.join('; '),
    });
    return null;
  } catch (error: unknown) {
    return describeError(error);
  }
}

function result(
  platform: PassPlatform,
  outcome: TleOutcome,
  status: number | null,
  epoch: string | null,
  error: string | null,
): TlePlatformResult {
  return { platform: platform.id, noradId: platform.noradId, outcome, status, epoch, error };
}

async function refreshOne(
  platform: PassPlatform,
  deps: TleRefreshDeps,
): Promise<TlePlatformResult> {
  let fetched;
  try {
    fetched = await deps.client.fetchElements(platform.noradId);
  } catch (error: unknown) {
    fetched = { body: null, status: null, availableAt: null, error: describeError(error) };
  }
  if (fetched.status === null) {
    return result(platform, 'fetch_failed', null, null, fetched.error ?? 'no response');
  }
  if (fetched.status !== 200 || fetched.body === null) {
    return result(
      platform,
      'refused',
      fetched.status,
      null,
      fetched.error ?? `HTTP ${String(fetched.status)}`,
    );
  }

  const parsed = parseOmmBody(fetched.body, platform.noradId);
  if (!parsed.ok) return result(platform, 'invalid', 200, null, parsed.reason);

  const record = parsed.record;
  const epoch = isoFromEpochMs(record.epochMs);
  try {
    const written = await deps.payloads.writeText(tleElementsPath(platform.noradId), fetched.body);
    await deps.payloads.writeText(
      tleMetaPath(platform.noradId),
      `${canonicalJson({
        provider: TLE_PROVIDER,
        norad_id: platform.noradId,
        platform: platform.id,
        object_name: record.objectName,
        object_id: record.objectId,
        epoch,
        available_at: isoFromEpochMs(fetched.availableAt ?? deps.clock.now()),
        sha256: written.sha256,
        bytes: written.bytes,
      })}\n`,
    );
  } catch (error: unknown) {
    return result(platform, 'write_failed', 200, null, describeError(error));
  }
  return result(platform, 'stored', 200, epoch, null);
}

async function writeHalt(
  deps: TleRefreshDeps,
  platform: PassPlatform,
  refused: TlePlatformResult,
): Promise<string | null> {
  try {
    await deps.payloads.writeText(
      TLE_HALT_PATH,
      `${canonicalJson({
        provider: TLE_PROVIDER,
        at: isoFromEpochMs(deps.clock.now()),
        norad_id: platform.noradId,
        status: refused.status,
        reason: refused.error,
        clear: 'Read the reason, check the CelesTrak usage policy, then delete this file.',
      })}\n`,
    );
    return null;
  } catch (error: unknown) {
    return `halt latch not written: ${describeError(error)}`;
  }
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
