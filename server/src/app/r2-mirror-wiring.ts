/**
 * Wiring for the T2 static mirror (TASKS E3; ADR-003 D1, A1.2): the push loop that PUTs the
 * snapshot to R2 every minute, and the age monitor that HEADs it over the public hostname.
 *
 * Kept out of `worker.ts` so the worker's hookup is a handful of lines and the parts worth
 * testing — which adapters each loop gets, when a loop is off and why — sit where a test
 * can reach them. Nothing here connects at wiring time: `createPgPool` opens a socket only
 * when a query asks for one.
 *
 * Off, with a reason the worker logs, when:
 *   * the FIRE_WATCH_R2_* group is unset — no push and no monitor (a monitor over an object
 *     nobody writes would only ever report "stale");
 *   * FIRE_WATCH_STATIC_SNAPSHOT_URL is unset — the push runs, the monitor does not, since
 *     there is no public hostname to ask.
 *
 * The cadences come from the `snapshot-push` budget row (OPERATIONS §1.3): push at the
 * nominal 60 s, check age at the same 60 s. With warn at 5 min that is five missed pushes
 * before a warn, and the monitor sees a stuck object within a minute of the warn line.
 */

import { systemClock } from '../adapters/clock/system-clock.js';
import { createPgPool } from '../adapters/db/pg-pool.js';
import { createPgSnapshotReader } from '../adapters/db/pg-snapshot-reader.js';
import { createFsFeedStatusStore } from '../adapters/storage/fs-feed-status-store.js';
import { createPublicObjectProbe } from '../adapters/storage/public-object-probe.js';
import { createR2ObjectStore } from '../adapters/storage/r2-object-store.js';
import { MONITORED_SOURCE_IDS } from '@fire-watch/contracts';
import { budgetFor, type FreshnessBudget } from '../core/config/freshness-budgets.js';
import type { Clock } from '../core/ports/clock.js';
import type { Heartbeat } from '../core/ports/heartbeat.js';
import type { PublicObjectProbe } from '../core/ports/object-store.js';
import type { Sleeper } from '../core/ports/sleeper.js';
import { runRepeatedly, type JobRun, type JobStats } from '../core/scheduler/repeating-job.js';
import { evaluateMirrorAge, type MirrorAgeVerdict } from '../core/snapshot/mirror-age.js';
import {
  runMirrorPush,
  type MirrorPushDeps,
  type MirrorPushReport,
} from '../core/snapshot/mirror-push.js';
import type { ServerConfig } from './config.js';
import type { LoopObserver } from './metrics-wiring.js';
import { reportMirrorAge, reportMirrorPush } from './r2-mirror-reporter.js';
import type { R2MirrorConfig } from './r2-mirror-config.js';

export const MIRROR_PUSH_INTERVAL_MS = 60_000;
export const MIRROR_AGE_INTERVAL_MS = 60_000;

/** One snapshot read a minute; the same statement bound the API's snapshot route uses. */
const MIRROR_POOL_MAX = 1;
const MIRROR_STATEMENT_TIMEOUT_MS = 2_000;

export type R2MirrorWiring =
  | { readonly kind: 'disabled'; readonly reason: string }
  | {
      readonly kind: 'enabled';
      readonly pushDeps: MirrorPushDeps;
      /** `null` with {@link monitorDisabledReason} when there is no public URL to probe. */
      readonly probe: PublicObjectProbe | null;
      readonly monitorDisabledReason: string | null;
      readonly budget: Pick<FreshnessBudget, 'warnSeconds' | 'criticalSeconds'>;
      /** Releases the pool. Always called from a `finally`. */
      close(): Promise<void>;
    };

export interface R2MirrorWiringOptions {
  readonly fetch?: typeof fetch;
  readonly clock?: Clock;
}

export function wireR2Mirror(
  config: ServerConfig,
  mirror: R2MirrorConfig | null,
  options: R2MirrorWiringOptions = {},
): R2MirrorWiring {
  if (mirror === null) {
    return { kind: 'disabled', reason: 'FIRE_WATCH_R2_* is not configured' };
  }
  const budget = budgetFor('snapshot-push');
  if (budget === undefined) {
    // The budgets table is versioned config; losing the row is a code change, not an env one.
    throw new Error('the freshness budgets have no snapshot-push row');
  }
  const clock = options.clock ?? systemClock;
  const pool = createPgPool({
    databaseUrl: config.databaseUrl,
    role: config.databaseRole,
    applicationName: `${config.applicationName}-r2-mirror`,
    max: MIRROR_POOL_MAX,
    statementTimeoutMs: MIRROR_STATEMENT_TIMEOUT_MS,
    connectionTimeoutMs: MIRROR_STATEMENT_TIMEOUT_MS,
  });
  const store = createR2ObjectStore({
    endpoint: mirror.endpoint,
    bucket: mirror.bucket,
    credentials: { accessKeyId: mirror.accessKeyId, secretAccessKey: mirror.secretAccessKey },
    clock,
    ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
  });
  const probe =
    mirror.publicUrl === null
      ? null
      : createPublicObjectProbe({
          url: mirror.publicUrl,
          ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
        });
  return {
    kind: 'enabled',
    pushDeps: {
      reader: createPgSnapshotReader(pool),
      store,
      clock,
      sources: MONITORED_SOURCE_IDS,
      objectKey: mirror.objectKey,
      // The health endpoint's `snapshot-push` row reads this; no state dir, no claim.
      feedStatus: config.stateDir === null ? null : createFsFeedStatusStore(config.stateDir),
    },
    probe,
    monitorDisabledReason: probe === null ? 'FIRE_WATCH_STATIC_SNAPSHOT_URL is not set' : null,
    budget,
    close: () => pool.end(),
  };
}

export interface R2MirrorLoopRuntime {
  readonly clock: Clock;
  readonly sleeper: Sleeper;
  readonly heartbeat: Heartbeat;
  writeLine(line: string): void;
  /**
   * Wraps each loop's reporter to record its runs under the loop's name (C5) — the worker
   * passes `loopObserver`. Absent, the reporters run bare.
   */
  readonly observe?: LoopObserver;
}

/** The loops to add to the worker's list: the push always, the age monitor when it has a URL. */
export function startR2MirrorLoops(
  wiring: Extract<R2MirrorWiring, { kind: 'enabled' }>,
  runtime: R2MirrorLoopRuntime,
  signal: AbortSignal,
): [name: string, stats: Promise<JobStats>][] {
  const observe: LoopObserver = runtime.observe ?? ((_loop, report) => report);
  const loops: [string, Promise<JobStats>][] = [
    [
      'r2_mirror_push',
      runRepeatedly({
        intervalMs: MIRROR_PUSH_INTERVAL_MS,
        clock: runtime.clock,
        sleeper: runtime.sleeper,
        signal,
        run: () => runMirrorPush(wiring.pushDeps),
        report: observe('r2_mirror_push', (run: JobRun<MirrorPushReport>) =>
          reportMirrorPush(run, runtime),
        ),
      }),
    ],
  ];
  const probe = wiring.probe;
  if (probe !== null) {
    loops.push([
      'r2_mirror_age',
      runRepeatedly({
        intervalMs: MIRROR_AGE_INTERVAL_MS,
        clock: runtime.clock,
        sleeper: runtime.sleeper,
        signal,
        run: async () => {
          const observation = await probe.head();
          return evaluateMirrorAge(observation, runtime.clock.now(), wiring.budget);
        },
        report: observe('r2_mirror_age', (run: JobRun<MirrorAgeVerdict>) => {
          reportMirrorAge(run, runtime);
        }),
      }),
    ]);
  }
  return loops;
}
