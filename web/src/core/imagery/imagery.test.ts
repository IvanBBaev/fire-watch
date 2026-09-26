import { describe, expect, it } from 'vitest';

import type { PageLifecycle } from '../ports.js';
import { imageryTileUrl, parseImageryHandles, sameImageryHandles } from './imagery-config.js';
import type { ImageryHandles } from './imagery-config.js';
import { createImageryRefresh } from './imagery-refresh.js';

const TEMPLATE = 'https://tiles.example.test/imagery/tile/{z}/{y}/{x}';
const BLOCK = { tile_url_template: TEMPLATE, api_key: 'AAPK-test' };
const HANDLES: ImageryHandles = { tileUrlTemplate: TEMPLATE, apiKey: 'AAPK-test' };
const TRANSPORT = { transport: 'poll', poll_interval_ms: 60_000, static_snapshot_url: null };

describe('parseImageryHandles', () => {
  it('reads a valid block and nothing else', () => {
    expect(parseImageryHandles({ ...TRANSPORT, imagery: BLOCK })).toEqual(HANDLES);
    expect(parseImageryHandles(TRANSPORT)).toBeNull();
    expect(parseImageryHandles(null)).toBeNull();
    expect(parseImageryHandles([])).toBeNull();
  });

  it('treats a malformed block as no toggle rather than a broken one', () => {
    for (const imagery of [
      null,
      {},
      { ...BLOCK, api_key: '' },
      { ...BLOCK, api_key: 'a&b' },
      { ...BLOCK, tile_url_template: 'http://tiles.example.test/{z}/{y}/{x}' },
      { ...BLOCK, tile_url_template: 'https://tiles.example.test/{z}/{y}' },
    ]) {
      expect(parseImageryHandles({ ...TRANSPORT, imagery })).toBeNull();
    }
  });
});

describe('imageryTileUrl', () => {
  it('appends the key as the token parameter', () => {
    expect(imageryTileUrl(HANDLES)).toBe(`${TEMPLATE}?token=AAPK-test`);
    expect(imageryTileUrl({ ...HANDLES, tileUrlTemplate: `${TEMPLATE}?f=jpg` })).toBe(
      `${TEMPLATE}?f=jpg&token=AAPK-test`,
    );
  });

  it('compares handles by value', () => {
    expect(sameImageryHandles(HANDLES, { ...HANDLES })).toBe(true);
    expect(sameImageryHandles(HANDLES, null)).toBe(false);
    expect(sameImageryHandles(null, null)).toBe(true);
  });
});

// ── The refresher ────────────────────────────────────────────────────────────

class FakeLifecycle implements PageLifecycle {
  wake: (() => void)[] = [];
  online: (() => void)[] = [];
  onWake(callback: () => void): () => void {
    this.wake.push(callback);
    return () => {
      this.wake = this.wake.filter((c) => c !== callback);
    };
  }
  onOnline(callback: () => void): () => void {
    this.online.push(callback);
    return () => {
      this.online = this.online.filter((c) => c !== callback);
    };
  }
}

/** A JSON body, or `'network'` for a rejected fetch, or `503` for a failed status. */
type Answer = unknown;

/** A fetch whose answers are queued by the test and released in any order. */
function scriptedFetch() {
  const pending: { resolve: (r: Response) => void; reject: (e: Error) => void }[] = [];
  const fetchFn = ((): Promise<Response> =>
    new Promise<Response>((resolve, reject) => {
      pending.push({ resolve, reject });
    })) as typeof fetch;
  const answer = async (index: number, value: Answer): Promise<void> => {
    const slot = pending[index];
    if (slot === undefined) throw new Error(`no request #${String(index)}`);
    if (value === 'network') slot.reject(new Error('offline'));
    else if (value === 503) slot.resolve(new Response('nope', { status: 503 }));
    else slot.resolve(new Response(JSON.stringify(value), { status: 200 }));
    // Let the refresher's awaits (fetch, then the body) run to completion.
    await new Promise((resolve) => setTimeout(resolve, 0));
  };
  return { fetchFn, pending, answer };
}

function setup() {
  const script = scriptedFetch();
  const lifecycle = new FakeLifecycle();
  const changes: (ImageryHandles | null)[] = [];
  const refresh = createImageryRefresh({
    fetchFn: script.fetchFn,
    url: '/api/v1/client-config',
    lifecycle,
    onChange: (handles) => changes.push(handles),
  });
  return { ...script, lifecycle, changes, refresh };
}

describe('createImageryRefresh', () => {
  it('fetches on start, wake and reconnect, and turns imagery off when the block goes', async () => {
    const { refresh, lifecycle, pending, answer, changes } = setup();
    refresh.start();
    expect(pending).toHaveLength(1);
    await answer(0, { ...TRANSPORT, imagery: BLOCK });
    expect(changes).toEqual([HANDLES]);

    for (const wake of lifecycle.wake) wake();
    await answer(1, { ...TRANSPORT, imagery: BLOCK });
    expect(changes).toEqual([HANDLES]);

    // Quota tripped server-side: the next answer simply has no block.
    for (const online of lifecycle.online) online();
    await answer(2, TRANSPORT);
    expect(changes).toEqual([HANDLES, null]);
    expect(refresh.current()).toBeNull();
  });

  it('keeps the current state when the document cannot be read', async () => {
    const { refresh, answer, changes } = setup();
    refresh.start();
    await answer(0, { ...TRANSPORT, imagery: BLOCK });
    void refresh.refresh();
    await answer(1, 'network');
    void refresh.refresh();
    await answer(2, 503);
    expect(changes).toEqual([HANDLES]);
    expect(refresh.current()).toEqual(HANDLES);
  });

  it('drops an answer that arrives after a newer one', async () => {
    const { refresh, answer, changes } = setup();
    refresh.start();
    void refresh.refresh();
    await answer(1, TRANSPORT);
    await answer(0, { ...TRANSPORT, imagery: BLOCK });
    expect(changes).toEqual([]);
    expect(refresh.current()).toBeNull();
  });

  it('stops listening on stop', () => {
    const { refresh, lifecycle } = setup();
    refresh.start();
    refresh.start();
    expect(lifecycle.wake).toHaveLength(1);
    refresh.stop();
    expect(lifecycle.wake).toHaveLength(0);
    expect(lifecycle.online).toHaveLength(0);
  });
});
