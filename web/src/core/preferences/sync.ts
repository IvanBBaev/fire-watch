/**
 * The cross-device sync loop (TASKS V2-C5), with every effect injected: the server
 * client, this browser's preferences, the base this browser last agreed on, a timer.
 * The web glue (`ui/preferences-sync.ts`) wires it to storage and signals; the tests
 * drive it with fakes.
 *
 *   * **Start** — read the account's copy, merge it with this browser's under the rule
 *     in `merge.ts`, apply what changed here, and write the merge back when it differs
 *     from what the server holds.
 *   * **A local change** — debounced ({@link PREFERENCES_SYNC_DEBOUNCE_MS}): a reader
 *     flicking through themes sends one write, not five. The write is based on the last
 *     agreed revision.
 *   * **A conflict** (another device wrote first) — read again, merge again (this
 *     browser's change survives where it is newer, see `merge.ts`) and write again, at
 *     most {@link PREFERENCES_SYNC_ATTEMPTS} times in a row; then give up until the next
 *     change rather than loop against a busy account.
 *   * **Signed out, or no route** — stop for good (the glue clears the base and the
 *     account hint). **Any other failure** — stop this run quietly; the next change or
 *     the next page load tries again.
 *
 * Runs never overlap: a change that arrives during one is folded into the next.
 */

import type { AccountPreferenceField, AccountPreferences } from '@fire-watch/contracts';

import type { PreferencesClient, RemotePreferences } from './client.js';
import { changedFields, mergePreferences, samePreferences } from './merge.js';

export const PREFERENCES_SYNC_DEBOUNCE_MS = 1500;
export const PREFERENCES_SYNC_ATTEMPTS = 3;

/** The copy this browser last agreed with the server on, and its revision. */
export type SyncBase = RemotePreferences;

export type SyncEnd = 'signed-out' | 'unavailable';

export interface PreferencesSyncDeps {
  readonly client: PreferencesClient;
  /** This browser's remembered preferences; absent members were never chosen here. */
  readonly readLocal: () => AccountPreferences;
  /** Make the merged values this browser's own; `changed` names the fields that moved. */
  readonly applyLocal: (
    next: AccountPreferences,
    changed: readonly AccountPreferenceField[],
  ) => void;
  readonly loadBase: () => SyncBase | null;
  readonly saveBase: (base: SyncBase | null) => void;
  /** `setTimeout`, returning its cancel. */
  readonly schedule: (run: () => void, ms: number) => () => void;
  /** Called once when sync stops for good. */
  readonly onEnd: (reason: SyncEnd) => void;
  /** The first successful read: the session is live. */
  readonly onConnected?: () => void;
}

export interface PreferencesSync {
  /** The first sync. Resolves when it has finished, whatever happened. */
  start(): Promise<void>;
  /** A local preference changed: write it, debounced. */
  localChanged(): void;
  /** Stop: no further request. */
  stop(): void;
  /** Settles when no run is in flight or scheduled (tests). */
  idle(): Promise<void>;
}

type Step = 'done' | 'retry' | 'stop';

export function createPreferencesSync(deps: PreferencesSyncDeps): PreferencesSync {
  let stopped = false;
  let connected = false;
  let cancelTimer: (() => void) | null = null;
  let chain: Promise<void> = Promise.resolve();

  function end(reason: SyncEnd): Step {
    if (!stopped) {
      stopped = true;
      cancelTimer?.();
      deps.onEnd(reason);
    }
    return 'stop';
  }

  /** Merge with what the server holds now and write the merge if it differs. */
  async function reconcile(): Promise<Step> {
    const read = await deps.client.read();
    if (stopped) return 'stop';
    if (read.kind === 'signed-out' || read.kind === 'unavailable') return end(read.kind);
    if (read.kind === 'failed') return 'stop';
    if (!connected) {
      connected = true;
      deps.onConnected?.();
    }
    const remote = read.remote;
    const stored = deps.loadBase();
    // A base newer than the server's copy belongs to another account, or to a server
    // that lost its rows: it is no ancestor of this copy, so this is a first sync.
    const base = stored !== null && stored.revision <= remote.revision ? stored : null;
    const local = deps.readLocal();
    const merged = mergePreferences(local, remote.preferences, base?.preferences ?? null);
    const changed = changedFields(local, merged);
    if (changed.length > 0) deps.applyLocal(merged, changed);
    if (samePreferences(merged, remote.preferences)) {
      deps.saveBase({ revision: remote.revision, preferences: merged });
      return 'done';
    }
    return write(merged, remote.revision);
  }

  async function write(preferences: AccountPreferences, basedOn: number): Promise<Step> {
    const outcome = await deps.client.write(preferences, basedOn);
    if (stopped) return 'stop';
    switch (outcome.kind) {
      case 'written':
        deps.saveBase(outcome.remote);
        return 'done';
      case 'conflict':
        return 'retry';
      case 'signed-out':
      case 'unavailable':
        return end(outcome.kind);
      case 'failed':
        return 'stop';
    }
  }

  async function reconcileWithRetries(): Promise<void> {
    for (let attempt = 0; attempt < PREFERENCES_SYNC_ATTEMPTS; attempt += 1) {
      if (stopped || (await reconcile()) !== 'retry') return;
    }
  }

  /** A local change: write it from the agreed revision; on a conflict, reconcile. */
  async function push(): Promise<void> {
    if (stopped) return;
    const base = deps.loadBase();
    const local = deps.readLocal();
    if (base !== null && samePreferences(local, base.preferences)) return;
    const step = base === null ? 'retry' : await write(local, base.revision);
    if (step === 'retry') await reconcileWithRetries();
  }

  function enqueue(run: () => Promise<void>): Promise<void> {
    chain = chain.then(run, run);
    return chain;
  }

  return {
    start() {
      return enqueue(reconcileWithRetries);
    },
    localChanged() {
      if (stopped) return;
      cancelTimer?.();
      cancelTimer = deps.schedule(() => {
        cancelTimer = null;
        void enqueue(push);
      }, PREFERENCES_SYNC_DEBOUNCE_MS);
    },
    stop() {
      stopped = true;
      cancelTimer?.();
      cancelTimer = null;
    },
    async idle() {
      await chain;
    },
  };
}
