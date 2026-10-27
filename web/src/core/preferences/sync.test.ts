import type { AccountPreferences } from '@fire-watch/contracts';
import { describe, expect, it, vi } from 'vitest';

import type {
  PreferencesClient,
  ReadPreferencesOutcome,
  RemotePreferences,
  WritePreferencesOutcome,
} from './client.js';
import { samePreferences } from './merge.js';
import { createPreferencesSync, PREFERENCES_SYNC_ATTEMPTS, type SyncBase } from './sync.js';

/** An in-memory server with the route's revision check. */
function fakeServer(initial: RemotePreferences = { revision: 0, preferences: {} }) {
  let state = initial;
  const writes: { preferences: AccountPreferences; basedOn: number }[] = [];
  let reads = 0;
  let readOverride: (() => ReadPreferencesOutcome) | null = null;
  let writeOverride: (() => WritePreferencesOutcome) | null = null;
  const client: PreferencesClient = {
    read() {
      reads += 1;
      return Promise.resolve(readOverride?.() ?? { kind: 'read', remote: state });
    },
    write(preferences, basedOn) {
      writes.push({ preferences, basedOn });
      const forced = writeOverride?.();
      if (forced) return Promise.resolve(forced);
      if (basedOn !== state.revision) return Promise.resolve({ kind: 'conflict' });
      state = { revision: state.revision + 1, preferences };
      return Promise.resolve({ kind: 'written', remote: state });
    },
  };
  return {
    client,
    writes,
    get reads() {
      return reads;
    },
    get state() {
      return state;
    },
    /** Another device writes. */
    set(preferences: AccountPreferences) {
      state = { revision: state.revision + 1, preferences };
    },
    failReads(outcome: (() => ReadPreferencesOutcome) | null) {
      readOverride = outcome;
    },
    failWrites(outcome: (() => WritePreferencesOutcome) | null) {
      writeOverride = outcome;
    },
  };
}

function harness(server: ReturnType<typeof fakeServer>, local: AccountPreferences = {}) {
  let current = local;
  let base: SyncBase | null = null;
  let timer: (() => void) | null = null;
  const applied: string[][] = [];
  const ended: string[] = [];
  const connected = vi.fn();
  const sync = createPreferencesSync({
    client: server.client,
    readLocal: () => current,
    applyLocal: (next, changed) => {
      current = next;
      applied.push([...changed]);
    },
    loadBase: () => base,
    saveBase: (next) => {
      base = next;
    },
    schedule: (run) => {
      timer = run;
      return () => {
        timer = null;
      };
    },
    onEnd: (reason) => ended.push(reason),
    onConnected: connected,
  });
  return {
    sync,
    applied,
    ended,
    connected,
    get local() {
      return current;
    },
    set local(next: AccountPreferences) {
      current = next;
    },
    get base() {
      return base;
    },
    set base(next: SyncBase | null) {
      base = next;
    },
    get pending() {
      return timer !== null;
    },
    /** Fire the debounce timer and wait for the run. */
    async flush() {
      const run = timer;
      timer = null;
      run?.();
      await sync.idle();
    },
  };
}

describe('createPreferencesSync — start', () => {
  it('first sync: takes the account copy, fills what it lacks and writes the merge back', async () => {
    const server = fakeServer({ revision: 3, preferences: { theme: 'dark' } });
    const h = harness(server, { theme: 'light', age_window: '6h' });
    await h.sync.start();
    expect(h.local).toEqual({ theme: 'dark', age_window: '6h' });
    expect(h.applied).toEqual([['theme']]);
    expect(server.writes).toEqual([
      { preferences: { theme: 'dark', age_window: '6h' }, basedOn: 3 },
    ]);
    expect(h.base).toEqual({ revision: 4, preferences: { theme: 'dark', age_window: '6h' } });
    expect(h.connected).toHaveBeenCalledOnce();
  });

  it('writes nothing when the merge is what the server holds', async () => {
    const server = fakeServer({ revision: 2, preferences: { theme: 'dark' } });
    const h = harness(server, {});
    await h.sync.start();
    expect(server.writes).toEqual([]);
    expect(h.base).toEqual({ revision: 2, preferences: { theme: 'dark' } });
  });

  it('treats a base newer than the server copy as no base', async () => {
    const server = fakeServer({ revision: 1, preferences: { theme: 'dark' } });
    const h = harness(server, { theme: 'light' });
    h.base = { revision: 9, preferences: { theme: 'auto' } };
    await h.sync.start();
    // With the stale base, local ≠ base would have kept 'light'; as a first sync the account wins.
    expect(h.local).toEqual({ theme: 'dark' });
  });

  it('ends for good on signed-out and on a missing route', async () => {
    for (const kind of ['signed-out', 'unavailable'] as const) {
      const server = fakeServer();
      server.failReads(() => ({ kind }));
      const h = harness(server, { theme: 'dark' });
      await h.sync.start();
      expect(h.ended).toEqual([kind]);
      h.sync.localChanged();
      expect(h.pending).toBe(false);
    }
  });

  it('stops quietly on a failed read, and tries again on the next change', async () => {
    const server = fakeServer();
    server.failReads(() => ({ kind: 'failed' }));
    const h = harness(server, { theme: 'dark' });
    await h.sync.start();
    expect(h.ended).toEqual([]);
    expect(server.writes).toEqual([]);
    server.failReads(null);
    h.sync.localChanged();
    await h.flush();
    expect(server.state.preferences).toEqual({ theme: 'dark' });
  });
});

describe('createPreferencesSync — local changes', () => {
  it('debounces: several changes, one write from the agreed revision', async () => {
    const server = fakeServer();
    const h = harness(server, {});
    await h.sync.start();
    h.local = { theme: 'light' };
    h.sync.localChanged();
    h.local = { theme: 'dark' };
    h.sync.localChanged();
    await h.flush();
    expect(server.writes).toEqual([{ preferences: { theme: 'dark' }, basedOn: 0 }]);
    expect(h.base).toEqual({ revision: 1, preferences: { theme: 'dark' } });
  });

  it('a change back to the agreed copy sends nothing', async () => {
    const server = fakeServer({ revision: 1, preferences: { theme: 'dark' } });
    const h = harness(server, { theme: 'dark' });
    await h.sync.start();
    h.sync.localChanged();
    await h.flush();
    expect(server.writes).toEqual([]);
  });

  it('on a conflict, reads again and merges: both devices keep their own field', async () => {
    const server = fakeServer({ revision: 1, preferences: { theme: 'auto' } });
    const h = harness(server, { theme: 'auto' });
    await h.sync.start();
    server.set({ theme: 'auto', new_signal_sound: true }); // another device
    h.local = { theme: 'dark' };
    h.sync.localChanged();
    await h.flush();
    expect(server.state.preferences).toEqual({ theme: 'dark', new_signal_sound: true });
    expect(h.local).toEqual({ theme: 'dark', new_signal_sound: true });
    expect(samePreferences(h.base?.preferences ?? {}, server.state.preferences)).toBe(true);
  });

  it(`gives up after ${String(PREFERENCES_SYNC_ATTEMPTS)} conflicts in a row`, async () => {
    const server = fakeServer();
    server.failWrites(() => ({ kind: 'conflict' }));
    const h = harness(server, { theme: 'dark' });
    await h.sync.start();
    expect(server.writes).toHaveLength(PREFERENCES_SYNC_ATTEMPTS);
    expect(h.ended).toEqual([]);
  });

  it('a signed-out write ends sync', async () => {
    const server = fakeServer();
    server.failWrites(() => ({ kind: 'signed-out' }));
    const h = harness(server, { theme: 'dark' });
    await h.sync.start();
    expect(h.ended).toEqual(['signed-out']);
  });

  it('stop cancels a pending write and sends nothing more', async () => {
    const server = fakeServer();
    const h = harness(server, {});
    await h.sync.start();
    h.local = { theme: 'dark' };
    h.sync.localChanged();
    h.sync.stop();
    expect(h.pending).toBe(false);
    await h.flush();
    expect(server.writes).toEqual([]);
  });

  it('never runs two requests at once', async () => {
    let inFlight = 0;
    let most = 0;
    const server = fakeServer();
    const slow: PreferencesClient = {
      async read() {
        inFlight += 1;
        most = Math.max(most, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 5));
        inFlight -= 1;
        return server.client.read();
      },
      async write(preferences, basedOn) {
        inFlight += 1;
        most = Math.max(most, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 5));
        inFlight -= 1;
        return server.client.write(preferences, basedOn);
      },
    };
    let local: AccountPreferences = { theme: 'dark' };
    let base: SyncBase | null = null;
    const runs: (() => void)[] = [];
    const sync = createPreferencesSync({
      client: slow,
      readLocal: () => local,
      applyLocal: (next) => {
        local = next;
      },
      loadBase: () => base,
      saveBase: (next) => {
        base = next;
      },
      schedule: (run) => {
        runs.push(run);
        return () => undefined;
      },
      onEnd: () => undefined,
    });
    const started = sync.start();
    local = { theme: 'light' };
    sync.localChanged();
    runs.at(-1)?.();
    await started;
    await sync.idle();
    expect(most).toBe(1);
    expect(server.state.preferences).toEqual({ theme: 'light' });
  });
});
