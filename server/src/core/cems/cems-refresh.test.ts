import { describe, expect, it } from 'vitest';

import { VirtualClock, epochMsFromIso } from '../ports/clock.js';
import type { CemsClient, CemsFetch } from '../ports/cems-client.js';
import { MemoryFeedStatus } from '../passes/__fixtures__/memory-feed-status.js';
import { MemoryPayloads } from '../passes/__fixtures__/memory-payloads.js';
import {
  CEMS_DETAIL_EMSR822,
  CEMS_DETAIL_RESTRICTED_BODY,
  CEMS_LIST_PAGE_0,
  CEMS_LIST_PAGE_50,
} from './__fixtures__/cems-api.js';
import {
  CEMS_CURRENT_META_PATH,
  CEMS_CURRENT_PATH,
  CEMS_OUTSIDE_PATH,
  parseCemsDocument,
} from './cems-document.js';
import { CEMS_PAGE_LIMIT, cemsRefreshFailed, runCemsRefresh } from './cems-refresh.js';

const NOW = '2026-10-24T09:00:00Z';

type Answer = CemsFetch | Error;

const ok = (body: string): CemsFetch => ({
  body,
  status: 200,
  availableAt: epochMsFromIso(NOW),
  error: null,
});
const status = (code: number, body: string | null = null): CemsFetch => ({
  body: code === 200 ? body : null,
  status: code,
  availableAt: null,
  error: `HTTP ${String(code)}`,
});

/**
 * A synthetic, empty detail for every activation the recording did not cover: the refresh
 * reads the detail of each candidate, and only EMSR822's was recorded.
 */
function emptyDetail(code: string): string {
  return JSON.stringify({ results: [{ code, sensitive: false, aois: [] }] });
}

class ScriptedClient implements CemsClient {
  readonly listed: number[] = [];
  readonly detailed: string[] = [];
  constructor(
    readonly pages: Map<number, Answer>,
    readonly details: Map<string, Answer> = new Map(),
  ) {}

  listActivations(page: { offset: number; limit: number }): Promise<CemsFetch> {
    this.listed.push(page.offset);
    expect(page.limit).toBe(CEMS_PAGE_LIMIT);
    const answer = this.pages.get(page.offset);
    if (answer === undefined) throw new Error(`unscripted offset ${String(page.offset)}`);
    return answer instanceof Error ? Promise.reject(answer) : Promise.resolve(answer);
  }

  activationDetail(code: string): Promise<CemsFetch> {
    this.detailed.push(code);
    const answer = this.details.get(code) ?? ok(emptyDetail(code));
    return answer instanceof Error ? Promise.reject(answer) : Promise.resolve(answer);
  }
}

function recordedPages(): Map<number, Answer> {
  return new Map([
    [0, ok(CEMS_LIST_PAGE_0)],
    [50, ok(CEMS_LIST_PAGE_50)],
  ]);
}

function setup(client: ScriptedClient, payloads = new MemoryPayloads()) {
  const feedStatus = new MemoryFeedStatus();
  const clock = new VirtualClock(NOW);
  return {
    payloads,
    feedStatus,
    clock,
    run: () => runCemsRefresh({ client, payloads, clock, feedStatus }),
  };
}

function storedDocument(payloads: MemoryPayloads) {
  const text = payloads.text(CEMS_CURRENT_PATH);
  if (text === undefined || text === null) throw new Error('no document stored');
  const document = parseCemsDocument(text);
  if (document === null) throw new Error('stored document does not parse');
  return document;
}

describe('runCemsRefresh', () => {
  it('walks both recorded pages and keeps only activations in coverage', async () => {
    const client = new ScriptedClient(
      recordedPages(),
      new Map([['EMSR822', ok(CEMS_DETAIL_EMSR822)]]),
    );
    const { payloads, feedStatus, run } = setup(client);
    const report = await run();

    expect(client.listed).toEqual([0, 50]);
    expect(report).toMatchObject({ pages: 2, listError: null, skipped: 0, documentWritten: true });
    expect(cemsRefreshFailed(report)).toBe(false);

    const document = storedDocument(payloads);
    expect(document.available_at).toBe(NOW);
    const codes = document.activations.map((a) => a.code);
    // Spain, Croatia, Belgium and Slovenia are far outside; Bulgaria's EMSR822 is in.
    for (const far of ['EMSR932', 'EMSR931', 'EMSR920', 'EMSR924']) {
      expect(codes).not.toContain(far);
      expect(client.detailed).not.toContain(far);
    }
    expect(codes).toContain('EMSR822');
    expect(document.activations.find((a) => a.code === 'EMSR822')).toMatchObject({
      aois_status: 'public',
      aois: [
        [22.4428, 42.7605, 22.6219, 42.8822],
        [23.1987, 41.6323, 23.3816, 41.75],
        [26.0708, 41.8839, 26.6951, 42.148],
      ],
    });
    // A candidate read but not kept: its centroid and its (empty) AOIs are both outside.
    expect(report.candidates.find((c) => c.code === 'EMSR922')).toMatchObject({
      detail: 'read',
      kept: false,
    });

    const meta = JSON.parse(payloads.text(CEMS_CURRENT_META_PATH)!) as Record<string, unknown>;
    expect(meta).toMatchObject({
      provider: 'copernicus-ems',
      available_at: NOW,
      activations: document.activations.length,
      pages: 2,
    });
    expect(meta['sha256']).toMatch(/^[0-9a-f]{64}$/);
    const outside = JSON.parse(payloads.text(CEMS_OUTSIDE_PATH)!) as Record<string, string>;
    expect(outside['EMSR922']).toBe('2026-09-18T08:34:57.039Z');
    expect(outside['EMSR822']).toBeUndefined();

    expect(feedStatus.attempts).toEqual([
      {
        row: 'cems:activations',
        attemptAt: epochMsFromIso(NOW),
        succeeded: true,
        hadData: true,
        error: null,
      },
    ]);
  });

  it('reuses stored AOIs when lastUpdate is unchanged, and reads a changed one again', async () => {
    const payloads = new MemoryPayloads();
    const details = new Map<string, Answer>([['EMSR822', ok(CEMS_DETAIL_EMSR822)]]);
    await setup(new ScriptedClient(recordedPages(), details), payloads).run();

    const second = new ScriptedClient(recordedPages(), details);
    const report = await setup(second, payloads).run();
    expect(second.detailed).toEqual([]);
    expect(report.candidates.find((c) => c.code === 'EMSR822')?.detail).toBe('reused');
    expect(report.candidates.find((c) => c.code === 'EMSR922')).toMatchObject({
      detail: 'outside',
      kept: false,
    });
    expect(report.candidates.every((c) => c.detail === 'reused' || c.detail === 'outside')).toBe(
      true,
    );
    expect(
      storedDocument(payloads).activations.find((a) => a.code === 'EMSR822')?.aois,
    ).toHaveLength(3);

    const changed = new Map<number, Answer>([
      [0, ok(CEMS_LIST_PAGE_0)],
      [50, ok(CEMS_LIST_PAGE_50.replace('2025-08-05T15:29:32.927998', '2025-08-06T10:00:00'))],
    ]);
    const third = new ScriptedClient(changed, details);
    await setup(third, payloads).run();
    expect(third.detailed).toEqual(['EMSR822']);
  });

  it('treats a 403 detail as restricted, an answer rather than a failure', async () => {
    const client = new ScriptedClient(
      recordedPages(),
      new Map([['EMSR822', status(403, CEMS_DETAIL_RESTRICTED_BODY)]]),
    );
    const { payloads, run } = setup(client);
    const report = await run();
    expect(cemsRefreshFailed(report)).toBe(false);
    expect(storedDocument(payloads).activations.find((a) => a.code === 'EMSR822')).toMatchObject({
      aois: [],
      aois_status: 'restricted',
    });
  });

  it('keeps the prior AOIs when a changed detail fails, and degrades the row', async () => {
    const payloads = new MemoryPayloads();
    const good = new Map<string, Answer>([['EMSR822', ok(CEMS_DETAIL_EMSR822)]]);
    await setup(new ScriptedClient(recordedPages(), good), payloads).run();

    const changed = new Map<number, Answer>([
      [0, ok(CEMS_LIST_PAGE_0)],
      [50, ok(CEMS_LIST_PAGE_50.replace('2025-08-05T15:29:32.927998', '2025-08-06T10:00:00'))],
    ]);
    const failing = new ScriptedClient(changed, new Map([['EMSR822', status(500)]]));
    const { feedStatus, run } = setup(failing, payloads);
    const report = await run();

    expect(cemsRefreshFailed(report)).toBe(true);
    const emsr822 = storedDocument(payloads).activations.find((a) => a.code === 'EMSR822');
    expect(emsr822).toMatchObject({ aois_status: 'public', last_update: '2025-08-06T10:00:00Z' });
    expect(emsr822?.aois).toHaveLength(3);
    expect(feedStatus.attempts[0]).toMatchObject({
      succeeded: false,
      hadData: true,
      error: 'EMSR822: HTTP 500',
    });
  });

  it('marks an activation unavailable when its first detail fails', async () => {
    const client = new ScriptedClient(
      recordedPages(),
      new Map([['EMSR822', new Error('socket hang up')]]),
    );
    const { payloads, run } = setup(client);
    const report = await run();
    expect(report.candidates.find((c) => c.code === 'EMSR822')).toMatchObject({
      detail: 'failed',
      kept: true,
      error: 'socket hang up',
    });
    expect(storedDocument(payloads).activations.find((a) => a.code === 'EMSR822')).toMatchObject({
      aois: [],
      aois_status: 'unavailable',
    });
  });

  it('writes nothing when the list cannot be read, so the route turns stale', async () => {
    const payloads = new MemoryPayloads();
    await setup(new ScriptedClient(recordedPages()), payloads).run();
    const before = payloads.text(CEMS_CURRENT_PATH);

    const failing = new ScriptedClient(
      new Map<number, Answer>([
        [0, ok(CEMS_LIST_PAGE_0)],
        [50, status(502)],
      ]),
    );
    const { feedStatus, run } = setup(failing, payloads);
    const report = await run();
    expect(report).toMatchObject({ listError: 'HTTP 502', documentWritten: false, pages: 2 });
    expect(cemsRefreshFailed(report)).toBe(true);
    expect(payloads.text(CEMS_CURRENT_PATH)).toBe(before);
    expect(feedStatus.attempts[0]).toMatchObject({
      succeeded: false,
      hadData: false,
      error: 'list: HTTP 502',
    });
  });

  it('fails the cycle on a page that does not parse', async () => {
    const client = new ScriptedClient(new Map([[0, ok('<html>maintenance</html>')]]));
    const report = await setup(client).run();
    expect(report.listError).toBe('the activation list is not JSON');
  });

  it('stops the walk at the retention horizon', async () => {
    const client = new ScriptedClient(recordedPages());
    const feedStatus = new MemoryFeedStatus();
    // Two years after the newest recorded activation: every entry is past the horizon.
    const clock = new VirtualClock('2028-10-01T00:00:00Z');
    const payloads = new MemoryPayloads();
    const report = await runCemsRefresh({ client, payloads, clock, feedStatus });
    expect(client.listed).toEqual([0]);
    expect(report.kept).toBe(0);
    expect(storedDocument(payloads).activations).toEqual([]);
  });

  it('reports a feed-status or document store failure instead of throwing', async () => {
    const payloads = new MemoryPayloads();
    payloads.failWritesOn = /current\.json$/;
    const { feedStatus, run } = setup(new ScriptedClient(recordedPages()), payloads);
    feedStatus.throws = true;
    const report = await run();
    expect(report.documentWritten).toBe(false);
    expect(report.documentError).toMatch(/^document write failed: disk full/);
    expect(report.feedStatusError).toBe('feed status disk unwritable');
    expect(cemsRefreshFailed(report)).toBe(true);
  });

  it('continues past a stored document that does not validate', async () => {
    const payloads = new MemoryPayloads();
    await payloads.writeText(CEMS_CURRENT_PATH, '{"schema_version":9}');
    const report = await setup(new ScriptedClient(recordedPages()), payloads).run();
    expect(report.previousError).toBe('the stored document failed validation');
    expect(report.documentWritten).toBe(true);
  });
});
