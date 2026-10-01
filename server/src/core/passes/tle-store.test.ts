import { describe, expect, it } from 'vitest';

import { VirtualClock } from '../ports/clock.js';
import type { TleClient } from '../ports/tle-client.js';
import { CELESTRAK_FETCHED_AT_MS, OMM_BY_NORAD, OMM_SNPP } from './__fixtures__/celestrak-omm.js';
import { MemoryFeedStatus } from './__fixtures__/memory-feed-status.js';
import { MemoryPayloads } from './__fixtures__/memory-payloads.js';
import { PASS_PLATFORMS } from './pass-platforms.js';
import { runTleRefresh, tleElementsPath, tleMetaPath } from './tle-refresh.js';
import { loadStoredElements } from './tle-store.js';

const client: TleClient = {
  fetchElements: (noradId) =>
    Promise.resolve({
      body: OMM_BY_NORAD[noradId]!,
      status: 200,
      availableAt: CELESTRAK_FETCHED_AT_MS,
      error: null,
    }),
};

async function refreshed(): Promise<MemoryPayloads> {
  const payloads = new MemoryPayloads();
  await runTleRefresh({
    client,
    payloads,
    clock: new VirtualClock(CELESTRAK_FETCHED_AT_MS),
    feedStatus: new MemoryFeedStatus(),
  });
  return payloads;
}

describe('loadStoredElements', () => {
  it('reads back what the refresh stored, verified, in platform order', async () => {
    const stored = await loadStoredElements(await refreshed());
    expect(stored.problems).toEqual([]);
    expect(stored.elements.map((e) => e.platform.id)).toEqual(PASS_PLATFORMS.map((p) => p.id));
    expect(stored.elements.every((e) => e.record !== null)).toBe(true);
    expect(stored.digest).not.toContain('-');
  });

  it('reports a never-refreshed store as missing elements, without complaint', async () => {
    const stored = await loadStoredElements(new MemoryPayloads());
    expect(stored.elements.every((e) => e.record === null)).toBe(true);
    expect(stored.problems).toEqual([]);
    expect(stored.digest).toBe('-,-,-,-,-');
  });

  it('refuses a payload whose bytes no longer match the sidecar', async () => {
    const payloads = await refreshed();
    await payloads.writeText(tleElementsPath(37849), OMM_SNPP.replace('SUOMI', 'SUOMl'));
    const stored = await loadStoredElements(payloads);
    const snpp = stored.elements.find((e) => e.platform.id === 'snpp');
    expect(snpp?.record).toBeNull();
    expect(stored.problems).toEqual(['snpp: payload does not match its sidecar sha256']);
  });

  it.each([
    [
      'a missing sidecar',
      (p: MemoryPayloads) => p.files.delete(tleMetaPath(43013)),
      /both present/,
    ],
    [
      'a malformed sidecar',
      (p: MemoryPayloads) => p.writeText(tleMetaPath(43013), 'nope'),
      /malformed/,
    ],
    [
      'a sidecar for another satellite',
      (p: MemoryPayloads) => p.writeText(tleMetaPath(43013), p.text(tleMetaPath(37849))!),
      /malformed/,
    ],
  ])('refuses %s', async (_name, damage, reason) => {
    const payloads = await refreshed();
    await damage(payloads);
    const stored = await loadStoredElements(payloads);
    expect(stored.elements[0]?.record).toBeNull();
    expect(stored.problems[0]).toMatch(reason);
    expect(stored.digest.startsWith('-,')).toBe(true);
  });

  it('changes its digest exactly when a platform’s elements change', async () => {
    const a = await loadStoredElements(await refreshed());
    const b = await loadStoredElements(await refreshed());
    expect(b.digest).toBe(a.digest);
    const payloads = await refreshed();
    payloads.files.delete(tleElementsPath(54234));
    payloads.files.delete(tleMetaPath(54234));
    expect((await loadStoredElements(payloads)).digest).not.toBe(a.digest);
  });
});
